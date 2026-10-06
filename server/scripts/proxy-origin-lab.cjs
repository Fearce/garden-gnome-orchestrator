#!/usr/bin/env node
// Ordinary prefix proxy: rewrites Host, preserves client metadata, omits X-Forwarded-Host.
// REMOTE_ACCESS stays off so both password sign-in and the explicit origin allowlist are exercised.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");
const { boot, loadChromium, requireBuild } = require("./lab-harness.cjs");

const PORT = 4451;
const PROXY_PORT = 4455;
const ORIGIN = `http://console.example.test:${PROXY_PORT}`;
const PASSWORD = "proxy-origin-lab-password";

function proxyHeaders(headers) {
  const out = { ...headers, host: `127.0.0.1:${PORT}`, "cf-connecting-ip": "192.0.2.12", "x-forwarded-proto": "http" };
  delete out["x-forwarded-host"];
  return out;
}

async function startProxy() {
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    if (!req.url.startsWith("/orchestrator/")) { res.writeHead(404); res.end(); return; }
    const upstream = http.request({ host: "127.0.0.1", port: PORT, method: req.method,
      path: req.url.slice("/orchestrator".length), headers: proxyHeaders(req.headers) }, (up) => {
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    });
    upstream.on("error", () => res.destroy());
    req.pipe(upstream);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.closeClients = () => { for (const socket of sockets) socket.destroy(); };
  server.on("upgrade", (req, socket, head) => {
    const upstream = net.connect(PORT, "127.0.0.1", () => {
      const lines = Object.entries(proxyHeaders(req.headers)).map(([key, value]) => `${key}: ${value}`);
      upstream.write(`GET ${req.url.slice("/orchestrator".length)} HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n`);
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    socket.on("close", () => upstream.destroy());
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(PROXY_PORT, "127.0.0.1", resolve); });
  return server;
}

function handshake(headers) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${PROXY_PORT}/orchestrator/ws`, { headers });
    const timer = setTimeout(() => { socket.terminate(); reject(new Error("upgrade timeout")); }, 10_000);
    const finish = (status) => { clearTimeout(timer); socket.terminate(); resolve(status); };
    socket.once("open", () => finish(101));
    socket.once("unexpected-response", (_req, res) => { res.resume(); finish(res.statusCode); });
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

function signedOutSocket() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${PROXY_PORT}/orchestrator/ws`, { headers: { origin: ORIGIN } });
    let receivedData = false;
    const timer = setTimeout(() => { socket.terminate(); reject(new Error("signed-out socket was not closed")); }, 10_000);
    socket.on("message", () => { receivedData = true; });
    socket.once("close", (code) => { clearTimeout(timer); resolve({ code, receivedData }); });
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

(async () => {
  requireBuild();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-origin-lab-"));
  let child, proxy, browser;
  try {
    child = await boot({ dataDir, port: PORT, env: { REMOTE_ACCESS: "0", PROXY_ORIGINS: ORIGIN,
      AUTH_PASSWORD: PASSWORD, SESSION_SECRET: "proxy-origin-lab-session-secret", ALLOWED_EMAIL: "owner@example.test", GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "" } });
    proxy = await startProxy();
    const base = `http://127.0.0.1:${PROXY_PORT}/orchestrator`;
    const me = await (await fetch(`${base}/api/me`)).json();
    assert.deepEqual(me, { authed: false, required: true, google: false, password: true });
    assert.equal((await fetch(`${base}/api/deploy/status`)).status, 401);
    const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify({ password: PASSWORD }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0];
    assert.equal(await handshake({ cookie, origin: ORIGIN }), 101);
    assert.equal(await handshake({ cookie, origin: "https://evil.example" }), 403);
    assert.deepEqual(await signedOutSocket(), { code: 4401, receivedData: false });
    console.log("PASS: proxy password sign-in, authenticated upgrade, foreign-origin and signed-out refusal");

    browser = await loadChromium().launch({ args: ["--host-resolver-rules=MAP console.example.test 127.0.0.1", "--no-proxy-server"] });
    for (const device of [{ name: "desktop", viewport: { width: 1440, height: 900 } },
      { name: "tablet", viewport: { width: 1024, height: 768 }, hasTouch: true, isMobile: true }]) {
      const { name, ...options } = device;
      const context = await browser.newContext(options);
      try {
        const page = await context.newPage();
        let hello = false;
        page.on("websocket", (socket) => {
          assert.equal(socket.url(), `${ORIGIN.replace("http:", "ws:")}/orchestrator/ws`);
          socket.on("framereceived", ({ payload }) => { try { if (JSON.parse(String(payload)).type === "hello") hello = true; } catch {} });
        });
        await page.goto(`${ORIGIN}/orchestrator/`, { waitUntil: "domcontentloaded", timeout: 45_000 });
        await page.locator('.modal.login input[type="password"]').waitFor();
        assert.equal(await page.locator(".modal.login a.btn.google").count(), 0);
        const response = await page.evaluate(async (password) => {
          const res = await fetch("api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
          return res.status;
        }, PASSWORD);
        assert.equal(response, 200);
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.locator(".accounts .acct").first().waitFor({ state: "attached", timeout: 30_000 });
        const deadline = Date.now() + 15_000;
        while (!hello && Date.now() < deadline) await page.waitForTimeout(100);
        assert.equal(hello, true, `${name}: received the live console snapshot through the prefixed socket`);
        assert.equal(await page.locator(".modal.login").count(), 0);
        console.log(`PASS: ${name} prefixed browser sign-in and live console`);
      } finally { await context.close(); }
    }
  } finally {
    if (browser) await browser.close();
    if (proxy) { proxy.closeClients(); await new Promise((resolve) => proxy.close(resolve)); }
    if (child) { child.kill(); await new Promise((resolve) => child.exitCode !== null ? resolve() : child.once("exit", resolve)); }
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
