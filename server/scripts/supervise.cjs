#!/usr/bin/env node
"use strict";
/*
 * Process supervisor for the orchestrator server (the `serve` path).
 *
 * WHY THIS EXISTS
 * ---------------
 * Prod runs the server as `tsx src/index.ts` under `concurrently`, which does NOT restart a command that
 * exits — so any crash left the server dead until a human re-ran `npm run serve`. Worse, the crashes that
 * bit hardest (an OOM: V8 prints "JavaScript heap out of memory" to STDERR and calls abort()) bypass the
 * in-process crash guards AND Windows Error Reporting, and `concurrently --raw` forwards that stderr only
 * to the terminal window — which then gets closed, so the process vanished with ZERO durable evidence.
 *
 * This supervisor fixes both:
 *   1. It tees the child's stdout/stderr to `data/server.log` (rotating), so an OOM/native-abort message is
 *      captured on disk even though the child never gets to run a JS handler.
 *   2. On any unexpected exit it appends a structured record to `data/crash.log` (exit code/signal, uptime,
 *      the tail of the child's stderr) and RESTARTS the child, with crash-loop backoff so a boot-time fault
 *      can't become a hot spawn loop.
 *   3. A supervised restart requested from inside the process (the Restart button / self-update) is a clean
 *      `process.exit(75)`; the supervisor respawns immediately on the fresh source without counting it as a
 *      crash — replacing the old detached self-re-exec, which would fight a supervisor.
 *
 * It intentionally uses no dependencies (plain CJS) so it can run before/independent of the TS build.
 */

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const serverDir = path.resolve(__dirname, "..");
// Mirror config.ts: the `serve` path is always the prod instance (data/), unless DATA_DIR overrides.
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(serverDir, "data");
const reportsDir = path.join(dataDir, "reports");
const serverLogPath = path.join(dataDir, "server.log");
const crashLogPath = path.join(dataDir, "crash.log");

// Kept in sync with SUPERVISED_RESTART_CODE in server/src/crashLog.ts.
const SUPERVISED_RESTART_CODE = 75;

// Timings are env-tunable ONLY so the integration test (supervise.itest.cjs) can run fast; prod uses the
// defaults below.
const num = (name, def) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : def;
};
const HEALTHY_MS = num("ORCH_SUPERVISE_HEALTHY_MS", 15_000); // an exit sooner than this counts as a fast-fail
const BACKOFF_BASE_MS = num("ORCH_SUPERVISE_BACKOFF_BASE_MS", 1_000);
const BACKOFF_MAX_MS = num("ORCH_SUPERVISE_BACKOFF_MAX_MS", 30_000);
const RESTART_SETTLE_MS = num("ORCH_SUPERVISE_SETTLE_MS", 300); // let the port + DB release before the successor boots
const SERVER_LOG_MAX_BYTES = 10 * 1024 * 1024;
const STDERR_TAIL_MAX = 8_000; // chars of the child's most recent stderr kept for the crash record

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(reportsDir, { recursive: true });

function rotateIfLarge(file) {
  try {
    if (fs.statSync(file).size > SERVER_LOG_MAX_BYTES) fs.renameSync(file, `${file}.1`);
  } catch {
    // no file yet, or a locked rotation target — fall through and append
  }
}

function appendCrash(text) {
  try {
    fs.appendFileSync(crashLogPath, text);
  } catch {
    // the log must never take the supervisor down
  }
}

// Diagnostic flags handed to the child so the NEXT fatal error is fully diagnosable:
//  - report-on-fatalerror / report-uncaught-exception → a node diagnostic-report JSON (incl. an OOM) in reports/
//  - heapsnapshot-near-heap-limit → up to 2 heap snapshots as the heap approaches the ceiling (leak post-mortem)
//  - max-old-space-size → headroom above the ~4.2GB default so a transient spike restarts cleanly, not aborts
function childNodeOptions() {
  const flags = [
    "--max-old-space-size=6144",
    "--report-on-fatalerror",
    "--report-uncaught-exception",
    `--report-directory=${reportsDir}`,
    "--heapsnapshot-near-heap-limit=2",
  ];
  return [process.env.NODE_OPTIONS, flags.join(" ")].filter(Boolean).join(" ");
}

function resolveTsxEntry() {
  // Reproduce the observed prod launch: `node <tsx cli> src/index.ts`.
  const candidates = [
    path.join(serverDir, "node_modules", "tsx", "dist", "cli.mjs"),
    path.join(serverDir, "node_modules", "tsx", "dist", "cli.js"),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error(`tsx CLI not found under ${path.join(serverDir, "node_modules", "tsx")} — run \`npm install --prefix server\``);
}

// The args passed to `node` to launch the child. Prod runs the server via tsx; the integration test points
// ORCH_SUPERVISE_TEST_CHILD at a throwaway script so it can exercise the crash/respawn loop without booting
// a real server (the production branch is untouched).
function childArgs() {
  const testChild = process.env.ORCH_SUPERVISE_TEST_CHILD;
  return testChild ? [testChild] : [resolveTsxEntry(), "src/index.ts"];
}

let shuttingDown = false;
let fastFails = 0;
let child = null;
const spawnArgs = childArgs();

function log(line) {
  const stamped = `[supervisor ${new Date().toISOString()}] ${line}\n`;
  try {
    process.stdout.write(stamped);
  } catch {
    /* broken pipe */
  }
}

function start() {
  if (shuttingDown) return;
  rotateIfLarge(serverLogPath);
  const serverLog = fs.createWriteStream(serverLogPath, { flags: "a" });
  const startedAt = Date.now();
  let stderrTail = "";
  let handled = false; // latch so a child emitting both 'error' and 'exit' can't schedule two respawns

  child = spawn(process.execPath, spawnArgs, {
    cwd: serverDir,
    env: { ...process.env, ORCH_SUPERVISED: "1", NODE_OPTIONS: childNodeOptions() },
    stdio: ["inherit", "pipe", "pipe"],
    windowsHide: true,
  });

  log(`server started (pid ${child.pid}) — logging stdio to ${serverLogPath}`);

  // Tee both streams to our own stdio (so `concurrently --raw` still shows them live) AND to server.log
  // (so an OOM/native-abort message survives the terminal being closed).
  const tee = (chunk, out) => {
    try {
      out.write(chunk);
    } catch {
      /* broken pipe */
    }
    try {
      serverLog.write(chunk);
    } catch {
      /* log write failure is non-fatal */
    }
  };
  child.stdout.on("data", (c) => tee(c, process.stdout));
  child.stderr.on("data", (c) => {
    tee(c, process.stderr);
    stderrTail = (stderrTail + c.toString("utf8")).slice(-STDERR_TAIL_MAX);
  });

  child.on("error", (err) => {
    if (handled) return;
    handled = true;
    appendCrash(`\n[${new Date().toISOString()}] supervisor: failed to spawn server\n${err && err.stack ? err.stack : err}\n`);
    scheduleRestart(Date.now() - startedAt, true);
  });

  child.on("exit", (code, signal) => {
    try {
      serverLog.end();
    } catch {
      /* ignore */
    }
    child = null;
    if (handled) return;
    handled = true;
    const uptimeMs = Date.now() - startedAt;
    if (shuttingDown) {
      log(`server exited (code=${code} signal=${signal}) during shutdown — not restarting`);
      process.exit(typeof code === "number" ? code : 0);
      return;
    }
    if (code === SUPERVISED_RESTART_CODE) {
      // An in-process restart request (Restart button / self-update). Not a crash.
      fastFails = 0;
      log(`server requested restart (exit ${code}) after ${Math.round(uptimeMs / 1000)}s — respawning`);
      setTimeout(start, RESTART_SETTLE_MS);
      return;
    }
    // Any other exit is unexpected — the crash we're here to survive and record.
    const crashed = code !== 0 || signal !== null;
    appendCrash(
      `\n[${new Date().toISOString()}] supervisor: server exited unexpectedly` +
        ` — code=${code} signal=${signal} uptime=${Math.round(uptimeMs / 1000)}s` +
        (stderrTail.trim() ? `\n--- last stderr ---\n${stderrTail.trim()}\n--- end stderr ---\n` : "\n"),
    );
    scheduleRestart(uptimeMs, crashed);
  });
}

function scheduleRestart(uptimeMs, crashed) {
  if (shuttingDown) return;
  if (crashed && uptimeMs < HEALTHY_MS) fastFails += 1;
  else fastFails = 0;
  const delay = fastFails > 0 ? Math.min(BACKOFF_BASE_MS * 2 ** (fastFails - 1), BACKOFF_MAX_MS) : RESTART_SETTLE_MS;
  if (fastFails >= 5) {
    log(`server has crash-looped ${fastFails}× — still restarting (every ${Math.round(delay / 1000)}s). Check ${crashLogPath} and ${serverLogPath}.`);
  } else {
    log(`restarting server in ${Math.round(delay / 1000)}s (fast-fails: ${fastFails})`);
  }
  setTimeout(start, delay);
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`received ${signal} — stopping server`);
  if (child) {
    child.kill(signal); // forward so the child's own signal handler logs + exits cleanly
    // Hard backstop: if the child ignores the signal, force it and exit anyway.
    setTimeout(() => {
      if (child) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
      process.exit(0);
    }, 8_000).unref();
  } else {
    process.exit(0);
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

start();
