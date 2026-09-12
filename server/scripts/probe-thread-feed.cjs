#!/usr/bin/env node
// Time each phase of the console's live feed round trip against a RUNNING instance — the
// "why does my task say 'warming up' forever / look stuck" question. Read-only: the only
// command it ever sends is thread.history, same as opening the task in the browser.
//
//   node scripts/probe-thread-feed.cjs                       # most-recently-updated thread
//   node scripts/probe-thread-feed.cjs --thread <uuid>
//   node scripts/probe-thread-feed.cjs --title "some text"   # case-insensitive substring, most recent match
//   node scripts/probe-thread-feed.cjs --url http://host:port
//   node scripts/probe-thread-feed.cjs --json
//
// Prints elapsed ms for: an unauthenticated HTTP baseline (/api/health), login, WS connect,
// the hello round trip, and the thread.history round trip — plus message/finding counts.
// Reuses inject-thread.cjs's login/cookie/socket-url helpers rather than re-deriving them.
//
// Reading the result: a FAST http baseline beside a SLOW ws-connect/hello/history leg means
// this box is contended in a way that specifically stalls this Node process's socket handling
// (see CLAUDE.md's "Local processes" triage — Get-ProcessChurn.ps1 / web-slow-triage.cjs), not
// a bug in message storage or the feed-mapping logic. A slow baseline too means look at the box
// itself first. This is exactly the diagnosis that took four hand-written throwaway WS probe
// scripts to reach on 2026-09-11 (all tasks reading "Planner and researcher are warming up"
// during 94-96% CPU load from unrelated processes) — this script is that diagnosis, reusable.

const WebSocket = require("ws");
const { login, socketUrl, passwordFromEnvOrDotenv } = require("./inject-thread.cjs");

const DEFAULT_URL = "http://127.0.0.1:4317";
const SLOW_MS = 3000; // observed 2026-09-11: a contended box took ~15s just to open the WS

function usage(error) {
  return [
    error ? `error: ${error}` : null,
    "usage: node scripts/probe-thread-feed.cjs [--thread <uuid> | --title <substring>] [--url http://host:port] [--json]",
    "",
    "Without --thread/--title, probes the most-recently-updated task on the instance.",
  ].filter(Boolean).join("\n");
}

function parseArgs(argv) {
  const out = { url: DEFAULT_URL };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--thread" || arg === "--title" || arg === "--url") {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} requires a value`);
      out[arg.slice(2)] = value;
    } else if (arg === "--json") {
      out.json = true;
    } else if (arg === "--help" || arg === "-h") {
      out.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (out.help) return out;
  if (out.thread && out.title) throw new Error("pass --thread or --title, not both");
  let parsed;
  try {
    parsed = new URL(out.url);
  } catch {
    throw new Error("--url must be an absolute http(s) URL");
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error("--url must use http or https");
  out.url = parsed.toString().replace(/\/$/, "");
  return out;
}

// Most-recently-updated match wins so "--title warming" against a repeated complaint picks the
// live task, not a months-old one that happens to share wording.
function resolveTarget(threads, { thread, title } = {}) {
  if (thread) {
    const hit = threads.find((t) => t.id === thread);
    if (!hit) throw new Error(`no task exists with id ${thread}`);
    return hit;
  }
  const pool = title
    ? threads.filter((t) => t.title?.toLowerCase().includes(title.toLowerCase()))
    : threads;
  if (title && !pool.length) throw new Error(`no task title contains "${title}"`);
  if (!pool.length) throw new Error("this instance has no tasks to probe");
  return [...pool].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
}

async function timedFetch(url) {
  const t0 = Date.now();
  try {
    const res = await fetch(url);
    return { ok: res.ok, status: res.status, ms: Date.now() - t0 };
  } catch (error) {
    return { ok: false, status: null, ms: Date.now() - t0, error: error.message };
  }
}

function timedHistory({ url, cookie, target, timeoutMs = 30_000 }) {
  return new Promise((resolve, reject) => {
    const wsStart = Date.now();
    const socket = new WebSocket(socketUrl(url), { headers: { Cookie: cookie } });
    const timings = {};
    const timeout = setTimeout(() => finish(new Error(`timed out after ${timeoutMs}ms waiting for thread.history`)), timeoutMs);
    const finish = (err, value) => {
      clearTimeout(timeout);
      try { socket.close(); } catch { /* already closed */ }
      err ? reject(err) : resolve(value);
    };
    socket.once("open", () => {
      timings.connectMs = Date.now() - wsStart;
    });
    socket.once("error", (err) => finish(new Error(`WebSocket connection failed: ${err.message}`)));
    socket.on("message", (raw) => {
      let event;
      try { event = JSON.parse(String(raw)); } catch { return; }
      if (event.type === "hello") {
        timings.helloMs = Date.now() - wsStart;
        let resolved;
        try {
          resolved = resolveTarget(event.threads ?? [], target);
        } catch (error) {
          return finish(error);
        }
        const historyStart = Date.now();
        socket.send(JSON.stringify({ type: "thread.history", threadId: resolved.id }));
        const onHistory = (raw2) => {
          let ev2;
          try { ev2 = JSON.parse(String(raw2)); } catch { return; }
          if (ev2.type === "thread.history" && ev2.threadId === resolved.id) {
            socket.off("message", onHistory);
            timings.historyMs = Date.now() - historyStart;
            finish(null, {
              target: { id: resolved.id, title: resolved.title, state: resolved.state, updatedAt: resolved.updatedAt },
              timings,
              messages: ev2.messages.length,
              findings: ev2.findings.length,
              hasMoreMessages: ev2.hasMoreMessages,
              briefLength: ev2.brief?.length ?? 0,
            });
            return;
          }
        };
        socket.on("message", onHistory);
      }
    });
  });
}

async function main(argv = process.argv.slice(2), env = process.env) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(usage(error.message));
    return 2;
  }
  if (args.help) {
    console.log(usage());
    return 0;
  }
  const password = passwordFromEnvOrDotenv(env);
  if (!password) {
    console.error("error: AUTH_PASSWORD is not set (and server/.env has no AUTH_PASSWORD line)");
    return 2;
  }

  const baseline = await timedFetch(`${args.url}/api/health`);

  const loginStart = Date.now();
  let cookie;
  try {
    cookie = await login(args.url, password);
  } catch (error) {
    console.error(`error: ${error.message}`);
    return 1;
  }
  const loginMs = Date.now() - loginStart;

  let result;
  try {
    result = await timedHistory({ url: args.url, cookie, target: args });
  } catch (error) {
    console.error(`error: ${error.message}`);
    return 1;
  }

  const totalMs = loginMs + (result.timings.connectMs ?? 0) + (result.timings.helloMs ?? 0) + (result.timings.historyMs ?? 0);
  const slowLegs = Object.entries(result.timings).filter(([, ms]) => ms >= SLOW_MS);

  if (args.json) {
    console.log(JSON.stringify({ ...result, httpBaselineMs: baseline.ms, loginMs, totalMs, slowLegs: slowLegs.map(([k]) => k) }, null, 2));
    return 0;
  }

  console.log(`target: ${result.target.title} (${result.target.id}) — state=${result.target.state}`);
  console.log(`http baseline (/api/health): ${baseline.ms}ms${baseline.ok ? "" : ` (status ${baseline.status ?? "error"})`}`);
  console.log(`login:                       ${loginMs}ms`);
  console.log(`ws connect:                  ${result.timings.connectMs}ms`);
  console.log(`hello round trip:            ${result.timings.helloMs}ms`);
  console.log(`thread.history round trip:   ${result.timings.historyMs}ms`);
  console.log(`messages=${result.messages} findings=${result.findings} hasMoreMessages=${result.hasMoreMessages} briefLength=${result.briefLength}`);
  console.log(`total (login+connect+hello+history): ${totalMs}ms`);
  if (slowLegs.length) {
    console.log("");
    console.log(`⚠ slow leg(s) ≥${SLOW_MS}ms: ${slowLegs.map(([k, ms]) => `${k}=${ms}ms`).join(", ")}`);
    if (baseline.ok && baseline.ms < SLOW_MS) {
      console.log("  the plain HTTP baseline was fast — this looks like box contention stalling this");
      console.log("  Node process specifically, not a code bug. Check the box (CLAUDE.md's 'Local");
      console.log(`  processes' section): node ~/.claude/scripts/web-slow-triage.cjs ${args.url}/`);
    } else {
      console.log("  the HTTP baseline was slow too — investigate the box itself before the app.");
    }
  }
  return 0;
}

module.exports = { parseArgs, resolveTarget, usage };

if (require.main === module) {
  main().then((code) => process.exit(code));
}
