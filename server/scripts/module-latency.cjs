#!/usr/bin/env node
// How responsive a GGO instance is while its local-service modules work: HTTP round-trips, WebSocket
// ping/pong, the owner-message echo (optional) and the server's own event-loop window. `modules-lab`
// samples a throwaway instance with every module idle and again under load; pointed at the live console
// it is the before/after comparison for a deploy.
//
//   npm run probe:module-latency --prefix server                 (live console, read-only)
//   npm run probe:module-latency --prefix server -- --json
//
// Owner messages are OFF unless `--owner-messages N` is given: each one is a real message to the
// Director, so only use it against a throwaway instance (the lab does).

const WebSocket = require("ws");
const { randomUUID } = require("node:crypto");
const { login, passwordFromEnvOrDotenv, socketUrl } = require("./inject-thread.cjs");

const DEFAULT_URL = "http://127.0.0.1:4317";

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null);
  const round = (v) => (v === null ? null : Math.round(v * 10) / 10);
  return { n: sorted.length, p50: round(at(0.5)), p95: round(at(0.95)), max: round(sorted.at(-1) ?? null) };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function httpSamples(base, cookie, count, spacingMs) {
  const times = [];
  for (let i = 0; i < count; i++) {
    const started = performance.now();
    const res = await fetch(`${base}/api/me`, { headers: { cookie } });
    await res.arrayBuffer();
    if (!res.ok) throw new Error(`/api/me answered ${res.status}`);
    times.push(performance.now() - started);
    await delay(spacingMs);
  }
  return times;
}

/** Open the console socket, wait for its hello, and hand back a small request/await helper. */
function openSocket(base, cookie, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(socketUrl(base), { headers: { Cookie: cookie } });
    const waiters = new Set();
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("no hello within the timeout"));
    }, timeoutMs);
    socket.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.type === "hello") {
        clearTimeout(timer);
        resolve({
          socket,
          waitFor(match, ms = 30_000) {
            return new Promise((done, fail) => {
              const waiter = { match, done, timer: setTimeout(() => (waiters.delete(waiter), fail(new Error("socket reply timed out"))), ms) };
              waiters.add(waiter);
            });
          },
          close: () => socket.close(),
        });
      }
      for (const waiter of waiters) {
        if (!waiter.match(msg)) continue;
        clearTimeout(waiter.timer);
        waiters.delete(waiter);
        waiter.done(msg);
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function wsSamples(conn, count, spacingMs) {
  const times = [];
  for (let i = 0; i < count; i++) {
    const started = performance.now();
    const pong = conn.waitFor((m) => m.type === "pong");
    conn.socket.send(JSON.stringify({ type: "ping" }));
    await pong;
    times.push(performance.now() - started);
    await delay(spacingMs);
  }
  return times;
}

/** Time from sending an owner message to the server's persisted echo of it, then stop the turn it began. */
async function ownerSamples(conn, count) {
  const times = [];
  for (let i = 0; i < count; i++) {
    const marker = `latency sample ${randomUUID()}`;
    const started = performance.now();
    const echo = conn.waitFor((m) => m.type === "director.message" && m.message?.role === "user" && m.message.content?.includes(marker), 60_000);
    conn.socket.send(JSON.stringify({ type: "prompt.new", text: marker, clientId: randomUUID() }));
    await echo;
    times.push(performance.now() - started);
    conn.socket.send(JSON.stringify({ type: "director.cancel" }));
    await delay(1_500);
  }
  return times;
}

async function eventLoop(base) {
  const res = await fetch(`${base}/api/health`);
  return res.ok ? (await res.json()).eventLoop ?? null : null;
}

/** One measurement pass. `cookie` is a session cookie for `base` (see inject-thread.cjs's `login`). */
async function sampleLatency({ base, cookie, count = 40, spacingMs = 250, ownerMessages = 0 }) {
  const conn = await openSocket(base, cookie);
  try {
    const [http, ws] = await Promise.all([httpSamples(base, cookie, count, spacingMs), wsSamples(conn, count, spacingMs)]);
    const owner = ownerMessages > 0 ? await ownerSamples(conn, ownerMessages) : [];
    return {
      http: summarize(http),
      ws: summarize(ws),
      ownerMessage: ownerMessages > 0 ? summarize(owner) : null,
      eventLoop: await eventLoop(base),
    };
  } finally {
    conn.close();
  }
}

function parseArgs(argv) {
  const options = { url: DEFAULT_URL, count: 40, ownerMessages: 0, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") options.json = true;
    else if (arg === "--url") options.url = argv[++i];
    else if (arg === "--count") options.count = Number(argv[++i]);
    else if (arg === "--owner-messages") options.ownerMessages = Number(argv[++i]);
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!options.url || !(options.count > 0) || !(options.ownerMessages >= 0)) throw new Error("usage: module-latency.cjs [--url URL] [--count N] [--owner-messages N] [--json]");
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const cookie = await login(options.url, passwordFromEnvOrDotenv());
  const services = await (await fetch(`${options.url}/api/modules/services`, { headers: { cookie } })).json().catch(() => null);
  const result = { at: new Date().toISOString(), url: options.url, ...(await sampleLatency({ base: options.url, cookie, count: options.count, ownerMessages: options.ownerMessages })), services };
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const line = (label, s) => (s ? `${label.padEnd(14)} p50 ${s.p50}ms  p95 ${s.p95}ms  max ${s.max}ms  (n=${s.n})` : `${label.padEnd(14)} not sampled`);
  console.log(line("HTTP /api/me", result.http));
  console.log(line("WS ping", result.ws));
  console.log(line("owner message", result.ownerMessage));
  const loop = result.eventLoop;
  if (loop) console.log(`event loop     worst stall ${loop.worstLagMs}ms, ${loop.blocks} block(s), ${loop.blockedMs}ms blocked in the last ${Math.round(loop.windowMs / 1000)}s${loop.worstBlame ? ` (worst: ${loop.worstBlame})` : ""}`);
  if (Array.isArray(services)) console.log(`modules        ${services.map((s) => `${s.module}=${s.state}`).join("  ")}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

module.exports = { sampleLatency, summarize };
