#!/usr/bin/env node
// Public HTTPS link to this GGO through Tailscale Funnel, locked to the owner's Google account.
//
//   npm run remote-access --prefix server            status: is the link open, and is it locked?
//   npm run remote-access --prefix server -- on      open it (refuses until Google sign-in is set up)
//   npm run remote-access --prefix server -- off     close it
//   npm run remote-access --prefix server -- on --when-live
//                                                    first wait (up to 24h) for the running GGO to
//                                                    have Google sign-in, i.e. a restart after .env
//
// The lock lives in the server (src/remoteAccess.ts): a tunnelled request gets Google sign-in only and
// every API route behind the session. This script only opens the tunnel when that lock can hold, then
// proves it from outside: an unauthenticated probe of the public URL must be refused. If it is not
// (an old server build, Google sign-in missing), `on` closes the link again before reporting.
// Exit: 0 fine, 1 the link is or was unlocked / a command failed, 2 needs an owner step first.
// Setup walkthrough: docs/remote-access.md.

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const SERVER_DIR = path.resolve(__dirname, "..");
const DEFAULT_TAILSCALE = "C:\\Program Files\\Tailscale\\tailscale.exe";
const PLACEHOLDER_OWNER = "you@example.com";
const FUNNEL_OFF_ARGS = ["funnel", "--https=443", "off"];
const PROBE_TIMEOUT_MS = 10_000;
const WAIT_POLL_MS = 30_000;
const WAIT_DEADLINE_MS = 24 * 60 * 60 * 1000;

/** What must be configured in server/.env before the link may open (blockers) or should be (warnings). */
function readiness(env, publicUrl) {
  const blockers = [];
  const warnings = [];
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    blockers.push("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in server/.env (Google sign-in is the only way in remotely).");
  }
  if (env.REMOTE_ACCESS !== "1") {
    blockers.push("Set REMOTE_ACCESS=1 in server/.env (switches on the remote lock; off by default for every install).");
  }
  const owner = (env.ALLOWED_EMAIL || "").trim().toLowerCase();
  if (!owner || owner === PLACEHOLDER_OWNER) {
    blockers.push("Set ALLOWED_EMAIL in server/.env to the one Google address allowed in.");
  }
  if (publicUrl && (env.PUBLIC_ORIGIN || "").replace(/\/$/, "") !== publicUrl) {
    warnings.push(`Add PUBLIC_ORIGIN=${publicUrl} to server/.env so Google always returns to this link.`);
  }
  if (!env.SESSION_SECRET) {
    warnings.push("Add a random SESSION_SECRET to server/.env so sign-in cookies are not signed with a reused secret.");
  }
  return { ready: blockers.length === 0, blockers, warnings };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** `tailscale status --json` → login state and this machine's MagicDNS name. */
function parseTailscaleStatus(text) {
  const status = parseJson(text);
  if (!status || typeof status.BackendState !== "string") return { state: "Unknown", dnsName: null };
  const dnsName = String(status.Self?.DNSName || "").replace(/\.$/, "") || null;
  return { state: status.BackendState, dnsName };
}

/** `tailscale funnel status --json` → the public URL, when port 443 is funneled to this GGO's port. */
function parseFunnelStatus(text, port) {
  const config = parseJson(text) || {};
  for (const [hostPort, allowed] of Object.entries(config.AllowFunnel || {})) {
    if (!allowed || !hostPort.endsWith(":443")) continue;
    const proxy = config.Web?.[hostPort]?.Handlers?.["/"]?.Proxy || "";
    if (proxy.replace(/\/$/, "") === `http://127.0.0.1:${port}`) {
      return { public: true, url: `https://${hostPort.slice(0, -":443".length)}` };
    }
  }
  return { public: false, url: null };
}

/** Ask the public URL, signed out, what it lets a stranger do. Locked = Google-only and no API. */
async function probeLock(fetchImpl, url) {
  const get = (route) => fetchImpl(`${url}${route}`, { redirect: "manual", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  try {
    const me = await get("/api/me");
    const offer = me.status === 200 ? await me.json() : null;
    const problems = [];
    if (!offer || offer.required !== true) problems.push("/api/me does not require sign-in");
    else if (offer.password) problems.push("the sign-in screen offers a password");
    else if (!offer.google) problems.push("Google sign-in is not offered");
    for (const route of ["/api/deploy/status", "/api/health"]) {
      const res = await get(route);
      if (res.status !== 401) problems.push(`${route} answered ${res.status} without sign-in`);
    }
    return { reachable: true, problems };
  } catch (error) {
    return { reachable: false, problems: [`could not reach ${url} (${error.message})`] };
  }
}

/** `on --when-live`: .env is read at startup, so wait until the RUNNING server reports Google sign-in
 *  (the staged restart has happened) before opening anything. Asked directly, never through the tunnel. */
async function waitForGoogleSignIn({ port, fetchImpl, log, sleep = defaultSleep, now = Date.now, waitDeadlineMs = WAIT_DEADLINE_MS }) {
  const deadline = now() + waitDeadlineMs;
  log(`Waiting for GGO on port ${port} to restart with Google sign-in before opening the link…`);
  for (;;) {
    try {
      const res = await fetchImpl(`http://127.0.0.1:${port}/api/me`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      if (res.status === 200 && (await res.json()).google === true) return true;
    } catch {
      /* restarting: not listening yet */
    }
    if (now() + WAIT_POLL_MS > deadline) return false;
    await sleep(WAIT_POLL_MS);
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tailscaleState(tailscale) {
  const res = tailscale(["status", "--json"]);
  return parseTailscaleStatus(res.stdout || "");
}

function funnelState(tailscale, port) {
  const res = tailscale(["funnel", "status", "--json"]);
  return parseFunnelStatus(res.stdout || "{}", port);
}

function reportLock(log, url, lock) {
  if (lock.problems.length === 0) {
    log(`Remote link is open and locked to Google sign-in: ${url}`);
    return true;
  }
  log(`Remote link ${url} is NOT locked:`);
  for (const problem of lock.problems) log(`  - ${problem}`);
  return false;
}

async function runCommand(command, deps) {
  const { env, port, tailscale, fetchImpl, log } = deps;
  if (!tailscale) {
    log("Tailscale is not installed. Install it with: winget install --id Tailscale.Tailscale -e");
    return 2;
  }

  if (command === "off") {
    const res = tailscale(FUNNEL_OFF_ARGS);
    if (res.status !== 0) {
      log(`tailscale ${FUNNEL_OFF_ARGS.join(" ")} failed: ${(res.stderr || res.stdout || "").trim()}`);
      return 1;
    }
    log("Remote link closed. GGO is local-only again.");
    return 0;
  }

  const ts = tailscaleState(tailscale);
  if (ts.state !== "Running" || !ts.dnsName) {
    log(`Tailscale is ${ts.state}. Sign in first: run "tailscale up" (or open the Tailscale tray app) and log in.`);
    return 2;
  }
  const publicUrl = `https://${ts.dnsName}`;
  const ready = readiness(env, publicUrl);

  if (command === "status") {
    const funnel = funnelState(tailscale, port);
    for (const warning of ready.warnings) log(`note: ${warning}`);
    if (!funnel.public) {
      log(`Remote link is off. Turn it on with: npm run remote-access --prefix server -- on (would be ${publicUrl})`);
      for (const blocker of ready.blockers) log(`needed first: ${blocker}`);
      return 0;
    }
    return reportLock(log, funnel.url, await probeLock(fetchImpl, funnel.url)) ? 0 : 1;
  }

  if (command !== "on") {
    log(`Unknown command "${command}". Use: status | on | off`);
    return 1;
  }
  if (!ready.ready) {
    log("Not opening the remote link yet:");
    for (const blocker of ready.blockers) log(`  - ${blocker}`);
    log("Then restart GGO (npm run deploy --prefix server) and run this again. Walkthrough: docs/remote-access.md");
    return 2;
  }
  for (const warning of ready.warnings) log(`note: ${warning}`);
  if (deps.whenLive && !(await waitForGoogleSignIn(deps))) {
    log("The running GGO never loaded Google sign-in, so the remote link stays closed. Restart GGO and retry.");
    return 1;
  }

  // Interactive: on a tailnet where Funnel is not yet allowed, the CLI prints an approval link and waits.
  const opened = tailscale(["funnel", "--bg", `http://127.0.0.1:${port}`], { interactive: true });
  if (opened.status !== 0) {
    log(`tailscale funnel failed: ${(opened.stderr || opened.stdout || "").trim()}`);
    return 1;
  }
  const lock = await probeLock(fetchImpl, publicUrl);
  if (reportLock(log, publicUrl, lock)) return 0;
  tailscale(FUNNEL_OFF_ARGS);
  log("Closed the link again. Deploy the current server build and check server/.env, then retry.");
  return 1;
}

function findTailscale() {
  const candidates = [process.env.TAILSCALE_EXE, DEFAULT_TAILSCALE].filter(Boolean);
  const exe = candidates.find((candidate) => fs.existsSync(candidate))
    ?? (spawnSync("tailscale", ["version"], { windowsHide: true }).status === 0 ? "tailscale" : null);
  if (!exe) return null;
  return (args, options = {}) => {
    const res = spawnSync(exe, args, {
      encoding: "utf8",
      windowsHide: true,
      stdio: options.interactive ? "inherit" : "pipe",
    });
    return { status: res.status ?? 1, stdout: res.stdout || "", stderr: res.stderr || (res.error ? res.error.message : "") };
  };
}

function loadServerEnv() {
  const envPath = path.join(SERVER_DIR, ".env");
  const fileEnv = fs.existsSync(envPath) ? require("dotenv").parse(fs.readFileSync(envPath)) : {};
  return { ...fileEnv, ...process.env };
}

if (require.main === module) {
  const env = loadServerEnv();
  runCommand(process.argv[2] || "status", {
    whenLive: process.argv.includes("--when-live"),
    env,
    port: Number(env.PORT || 4317),
    tailscale: findTailscale(),
    fetchImpl: fetch,
    log: (line) => console.log(line),
  }).then((code) => process.exit(code));
}

module.exports = { readiness, parseTailscaleStatus, parseFunnelStatus, probeLock, runCommand, FUNNEL_OFF_ARGS };
