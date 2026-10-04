// Does an open desktop window cost the server anything? Measures a running GGO's HTTP and WebSocket
// responsiveness with the desktop app closed, then open (signed in, idle on the board), then closed
// again, and the app's own startup time, memory and CPU while open. Read-only against the server: it
// signs in, reads `/api/me`, pings the socket and lets the window sit; it never clicks the console.
//
//   npm run probe:load --prefix desktop                          (http://127.0.0.1:4317)
//   npm run probe:load --prefix desktop -- --url http://127.0.0.1:4317 --out ../server/data/desktop-lab-shots
//
// Signs in with AUTH_PASSWORD from the environment or server/.env. The window runs on a throwaway
// profile (GGO_DESKTOP_USER_DATA): it leaves no settings behind, registers no ggo:// handler, and so
// never marks the machine as one where browsers should offer Open in desktop. It opens in background
// mode (GGO_DESKTOP_BACKGROUND): on a secondary monitor, without taking focus.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("../../server/node_modules/ws");
const harness = require("../../server/scripts/lab-harness.cjs");
const { loadPlaywright } = require("./loadPlaywright.cjs");
const { electronBinary } = require("./electronBinary.cjs");

const arg = (name, fallback) => {
  const at = process.argv.indexOf(name);
  return at > 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
};
const BASE = arg("--url", "http://127.0.0.1:4317").replace(/\/+$/, "");
const OUT = arg("--out", null);
const SAMPLES = Number(arg("--samples", "120"));
const IDLE_MS = 15_000;
const DESKTOP = path.resolve(__dirname, "..");
const ELECTRON = electronBinary();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const round = (n) => Math.round(n * 10) / 10;
  return { n: sorted.length, p50: round(at(0.5)), p95: round(at(0.95)), max: round(sorted.at(-1)) };
}

async function signIn() {
  const response = await fetch(`${BASE}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: harness.authPassword() }) });
  if (!response.ok) throw new Error(`sign-in failed: HTTP ${response.status}`);
  return response.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

async function httpLatency(cookie) {
  const times = [];
  for (let i = 0; i < SAMPLES; i++) {
    const started = performance.now();
    const response = await fetch(`${BASE}/api/me`, { headers: { cookie } });
    await response.arrayBuffer();
    times.push(performance.now() - started);
    await sleep(50);
  }
  return stats(times);
}

function openSocket(cookie) {
  const url = `${BASE.replace(/^http/, "ws")}/ws`;
  return new Promise((done, fail) => {
    const started = performance.now();
    const socket = new WebSocket(url, { headers: { cookie, origin: BASE } });
    socket.once("error", fail);
    socket.on("message", function first(data) {
      const message = JSON.parse(String(data));
      if (message.type !== "hello") return;
      socket.off("message", first);
      done({ socket, helloMs: performance.now() - started, hello: message });
    });
  });
}

async function wsLatency(cookie) {
  const hellos = [];
  let busy = null;
  for (let i = 0; i < 5; i++) {
    const { socket, helloMs, hello } = await openSocket(cookie);
    hellos.push(helloMs);
    busy ??= liveAgents(hello);
    socket.close();
    await sleep(200);
  }
  const { socket } = await openSocket(cookie);
  const rtts = [];
  for (let i = 0; i < SAMPLES; i++) {
    const started = performance.now();
    await new Promise((done) => {
      const onMessage = (data) => {
        if (JSON.parse(String(data)).type !== "pong") return;
        socket.off("message", onMessage);
        done();
      };
      socket.on("message", onMessage);
      socket.send(JSON.stringify({ type: "ping" }));
    });
    rtts.push(performance.now() - started);
    await sleep(50);
  }
  socket.close();
  return { hello: stats(hellos), pingRtt: stats(rtts), load: busy };
}

/** Tasks by state from the hello snapshot: the agent load the numbers were taken under. */
function liveAgents(hello) {
  const threads = Array.isArray(hello.threads) ? hello.threads : [];
  const byState = {};
  for (const t of threads) {
    const state = t.state ?? t.thread?.state ?? "unknown";
    byState[state] = (byState[state] ?? 0) + 1;
  }
  return byState;
}

async function measure(label, cookie) {
  const http = await httpLatency(cookie);
  const ws = await wsLatency(cookie);
  console.log(`${label}: /api/me p50 ${http.p50} ms p95 ${http.p95} ms · ws ping p50 ${ws.pingRtt.p50} ms p95 ${ws.pingRtt.p95} ms · hello p50 ${ws.hello.p50} ms`);
  return { http, ws };
}

async function openApp(profile) {
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, "desktop-settings.json"), JSON.stringify({ serverUrl: `${BASE}/` }));
  const started = Date.now();
  const app = await loadPlaywright()._electron.launch({ executablePath: ELECTRON, args: [DESKTOP], cwd: DESKTOP, env: { ...process.env, GGO_DESKTOP_USER_DATA: profile, GGO_DESKTOP_BACKGROUND: "1" } });
  const page = await app.firstWindow();
  await page.waitForFunction(() => location.protocol.startsWith("http") && !!document.querySelector('input[type="password"]'), null, { timeout: 60_000 });
  const toSignIn = Date.now() - started;
  await page.fill('input[type="password"]', harness.authPassword());
  const signedIn = Date.now();
  await page.click('button:text-is("Enter")');
  await page.waitForFunction(() => !!document.querySelector(".accounts .acct"), null, { timeout: 90_000 });
  return { app, startup: { launchToSignInMs: toSignIn, signInToLiveConsoleMs: Date.now() - signedIn } };
}

/** The app's processes over a window of `ms`: working set and CPU, sampled every 2 s. */
async function appUsage(app, ms) {
  const samples = [];
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    samples.push(
      await app.evaluate(({ app: electronApp }) => {
        const all = electronApp.getAppMetrics();
        return {
          processes: all.length,
          workingSetMb: Math.round(all.reduce((t, m) => t + m.memory.workingSetSize, 0) / 1024),
          cpuPercent: Math.round(all.reduce((t, m) => t + m.cpu.percentCPUUsage, 0) * 10) / 10,
        };
      }),
    );
    await sleep(2_000);
  }
  const cpu = samples.slice(1).map((s) => s.cpuPercent);
  return { processes: samples.at(-1).processes, workingSetMb: samples.at(-1).workingSetMb, cpuPercentAvg: Math.round((cpu.reduce((a, b) => a + b, 0) / cpu.length) * 10) / 10, cpuPercentMax: Math.max(...cpu) };
}

async function closeApp(app) {
  await Promise.race([app.close().catch(() => undefined), sleep(20_000)]);
}

(async () => {
  if (!(await fetch(`${BASE}/api/version`).then((r) => r.ok, () => false))) throw new Error(`nothing answers on ${BASE}`);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-load-probe-"));
  const report = { url: BASE, samples: SAMPLES, at: new Date().toISOString(), cpus: os.cpus().length };
  let app = null;
  try {
    const cookie = await signIn();
    report.closedBefore = await measure("app closed", cookie);
    const opened = await openApp(path.join(profile, "profile"));
    app = opened.app;
    report.startup = opened.startup;
    console.log(`startup: ${JSON.stringify(opened.startup)}`);
    report.appIdle = await appUsage(app, IDLE_MS);
    console.log(`app idle: ${JSON.stringify(report.appIdle)}`);
    report.open = await measure("app open", cookie);
    await closeApp(app);
    app = null;
    await sleep(3_000);
    report.closedAfter = await measure("app closed again", cookie);
    if (OUT) {
      fs.mkdirSync(OUT, { recursive: true });
      const file = path.join(OUT, "desktop-load-probe.json");
      fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
      console.log(`report: ${path.resolve(file)}`);
    }
  } finally {
    if (app) await closeApp(app);
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
