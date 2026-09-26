#!/usr/bin/env node
// Remote-access lab: drive a THROWAWAY instance through a local proxy that behaves like Tailscale
// Funnel (loopback source, X-Forwarded-* naming a remote client, WebSocket upgrades relayed), and
// prove the console is Google-only and fully gated there while direct local use is unchanged.
//
// Uncommitted server work: `npx tsc -p tsconfig.json --outDir .remote-access-lab-dist`, then
// GGO_LAB_ENTRY=.remote-access-lab-dist/index.js. The unit halves are `npm run test:remote-access`.

const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { loadChromium, requireBuild, boot, killInstance, createChecks, shotDir } = require("./lab-harness.cjs");

const PORT = 4409;
const PROXY_PORT = 4413;
const PUBLIC_ORIGIN = "https://lab-pc.tail0000.ts.net";
const FORWARDED = { "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", "x-forwarded-host": "lab-pc.tail0000.ts.net" };

/** A minimal Funnel stand-in: relays HTTP and WebSocket upgrades to the instance, adding its headers. */
function startTunnel() {
  const server = http.createServer((req, res) => {
    const upstream = http.request(
      { host: "127.0.0.1", port: PORT, method: req.method, path: req.url, headers: { ...req.headers, ...FORWARDED } },
      (up) => {
        res.writeHead(up.statusCode, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", () => res.destroy());
    req.pipe(upstream);
  });
  server.on("upgrade", (req, socket, head) => {
    const upstream = net.connect(PORT, "127.0.0.1", () => {
      const headers = { ...req.headers, ...FORWARDED };
      const lines = Object.entries(headers).map(([k, v]) => `${k}: ${v}`);
      upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n`);
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });
  return new Promise((resolve) => server.listen(PROXY_PORT, "127.0.0.1", () => resolve(server)));
}

async function sessionCookie(base, password) {
  const res = await fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
  const setCookie = res.headers.get("set-cookie") || "";
  const match = setCookie.match(/orch_session=([^;]+)/);
  return { status: res.status, value: match ? match[1] : null, secure: /;\s*Secure/i.test(setCookie) };
}

(async () => {
  requireBuild();
  const check = createChecks();
  // The lab's own password: the owner's .env may have none, and this proves both login paths.
  const password = "remote-access-lab-password";
  const direct = `http://127.0.0.1:${PORT}`;
  const tunnel = `http://127.0.0.1:${PROXY_PORT}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-access-lab-"));
  killInstance(PORT);
  const child = await boot({
    dataDir,
    port: PORT,
    env: {
      GOOGLE_CLIENT_ID: "lab-client.apps.googleusercontent.com",
      GOOGLE_CLIENT_SECRET: "lab-client-secret",
      ALLOWED_EMAIL: "owner@example.test",
      PUBLIC_ORIGIN,
      SESSION_SECRET: "remote-access-lab-session-secret",
      AUTH_PASSWORD: password,
    },
  });
  const proxy = await startTunnel();
  let browser;
  try {
    console.log("tunnelled, signed out:");
    const me = await (await fetch(`${tunnel}/api/me`)).json();
    check("sign-in is required and Google-only", me.required === true && me.google === true && me.password === false, JSON.stringify(me));
    for (const route of ["/api/health", "/api/deploy/status", "/api/update/status", "/api/version"]) {
      const status = (await fetch(`${tunnel}${route}`)).status;
      check(`${route} refuses a stranger`, status === 401, `got ${status}`);
    }
    const guess = await fetch(`${tunnel}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
    check("the right password is still refused through the tunnel", guess.status === 401 || guess.status === 403, `got ${guess.status}`);
    const google = await fetch(`${tunnel}/api/auth/google`, { redirect: "manual" });
    const location = google.headers.get("location") || "";
    check("Google sign-in returns to the pinned public origin", location.includes(encodeURIComponent(`${PUBLIC_ORIGIN}/api/auth/callback`)), location);
    check("the sign-in state cookie is Secure over the tunnel", /;\s*Secure/i.test(google.headers.get("set-cookie") || ""));

    console.log("direct local:");
    const local = await sessionCookie(direct, password);
    check("password login still works locally", local.status === 200 && !!local.value, `status ${local.status}`);
    check("the local session cookie is not Secure (shared by :4317 and :4319)", !local.secure);
    check("the local deploy script still reaches /api/deploy/status", (await fetch(`${direct}/api/deploy/status`)).status === 200);
    const localGoogle = (await fetch(`${direct}/api/auth/google`, { redirect: "manual" })).headers.get("location") || "";
    check("local Google sign-in returns to the local address", localGoogle.includes(encodeURIComponent(`${direct}/api/auth/callback`)), localGoogle);

    const chromium = loadChromium();
    browser = await chromium.launch();
    const shots = shotDir(dataDir);

    console.log("browser through the tunnel:");
    const stranger = await browser.newContext();
    const page = await stranger.newPage();
    await page.goto(`${tunnel}/`, { timeout: 45_000 });
    await page.waitForSelector(".modal.login", { timeout: 20_000 });
    check("the sign-in screen offers Google", (await page.locator(".modal.login a.btn.google").count()) === 1);
    check("the sign-in screen offers no password field", (await page.locator('.modal.login input[type="password"]').count()) === 0);
    await page.screenshot({ path: path.join(shots, "remote-signin.png") });
    await stranger.close();

    const owner = await browser.newContext();
    await owner.addCookies([{ name: "orch_session", value: local.value, url: tunnel }]);
    const ownerPage = await owner.newPage();
    await ownerPage.goto(`${tunnel}/`, { timeout: 45_000 });
    await ownerPage.waitForSelector(".accounts .acct", { timeout: 30_000 });
    check("a signed-in owner gets the live console, WebSocket included", (await ownerPage.locator(".modal.login").count()) === 0);
    await ownerPage.screenshot({ path: path.join(shots, "remote-console.png") });
    await owner.close();
  } finally {
    if (browser) await browser.close();
    proxy.close();
    child.kill();
    killInstance(PORT);
  }
  process.exit(check.summary());
})().catch((error) => {
  console.error(error);
  killInstance(PORT);
  process.exit(1);
});
