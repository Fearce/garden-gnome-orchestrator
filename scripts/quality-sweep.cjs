#!/usr/bin/env node
// The canonical nightly sweep: runs every step of .claude/rules/nightly-quality-sweep.md
// and prints one verdict at the end.
//
//   npm run quality              all steps
//   npm run quality -- --list    what it would run
//   npm run quality -- 2 7       only steps 2 and 7 (re-checking a failure)
//
// It deliberately does NOT stop at the first failure. The point of a sweep is the whole
// picture: an `&&` chain that dies on step 2 hides whether the parks, the ladder and the
// DB are healthy, and the next run has to be driven by hand step by step to find out.
// Every step is read-only, so continuing past a failure is safe.
//
// Everything it prints is also written to `server/data/quality-sweep-last.log`. The sweep emits
// ~1500 lines, which is more than one agent command can hold, so a reader who piped it through
// `tail` loses steps 1-6 — precisely the output steps 1/3/4/5 exist to make somebody READ — and
// re-runs those probes to get it back. The transcript is that re-run, already done.

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SERVER = path.join(ROOT, "server");

// One sweep at a time, on the same SQLite lease the gate suite uses — its own lock file, so a sweep
// never blocks the gates run it is about to spawn. SQLite is what makes this better than a pidfile:
// the OS releases its transaction even on a hard kill, so a crashed sweep leaves nothing to guess at.
//
// Two sweeps both open this transcript with `flags:"w"` and write it at independent offsets, so the
// log does not double — it INTERLEAVES. On 2026-09-11 an orphaned sweep from a resumed session
// overlapped a fresh one, and the summary that got read reported step 2 green while `test:zai-usage`
// had actually failed, with another step's output spliced through the gate list. A verdict you cannot
// trust costs more than no verdict, and nothing here could tell you it had happened.
const { acquireGateRunLease } = require(path.join(SERVER, "scripts", "gate-run-lease.cjs"));
/**
 * Where this run keeps its three artifacts. Under server/data, which is gitignored — a sweep
 * transcript is a working artifact, never a commit.
 *
 * GGO_SWEEP_SANDBOX relocates all three together, so `test:quality-sweep` can exercise the refusal
 * path against a lease nobody else holds. It has to: that gate runs INSIDE the sweep (step 2 spawns
 * the whole gate suite), so on the production lease it asserted "a free lease must be claimable"
 * while the sweep running it held exactly that lease — one gate red on every nightly run, for the
 * one reason that proves the guard works. The three move as a unit on purpose: relocating only the
 * lease would leave the gate truncating the live sweep's transcript to prove that it does not.
 */
function sweepArtifactPaths(sandboxDir) {
  const dir = sandboxDir ? path.resolve(sandboxDir) : path.join(SERVER, "data");
  return {
    transcript: path.join(dir, "quality-sweep-last.log"),
    lockDb: path.join(dir, "quality-sweep-run-lock.sqlite"),
    owner: path.join(dir, "quality-sweep-run-owner.json"),
  };
}
const ARTIFACTS = sweepArtifactPaths(process.env.GGO_SWEEP_SANDBOX);
const TRANSCRIPT = ARTIFACTS.transcript;
const SWEEP_LOCK_DB = ARTIFACTS.lockDb;
const SWEEP_OWNER = ARTIFACTS.owner;
const BUSY_EXIT_CODE = 75;

/** The refusal an operator reads: who holds it, why it matters, and both ways out. */
function sweepBusyText(owner) {
  const pid = Number.isInteger(owner?.pid) ? `PID ${owner.pid}` : "another process";
  const since = typeof owner?.startedAtIso === "string" ? ` since ${owner.startedAtIso}` : "";
  return [
    "",
    "=== a quality sweep is already running ===",
    `    owner: ${pid}${since}`,
    `    transcript: ${TRANSCRIPT}`,
    "    two sweeps interleave that one file, so the summary can belong to a different run than the",
    "    steps above it — this attempt did not touch it, and this is NOT a sweep result",
    `    wait for that run, or end it and rerun:  taskkill /PID ${owner?.pid ?? "<pid>"} /T /F`,
    "    override only if you know they write different files:  --force",
    "",
  ].join("\n");
}

// step = the numbered section in the rule; several sections take more than one command.
const STEPS = [
  { step: 1, name: "health", what: "server up, dist vs HEAD, parks/caps, crash log", script: "health", cwd: SERVER },
  { step: 2, name: "typecheck", what: "server + web", script: "typecheck", cwd: ROOT },
  { step: 2, name: "gates", what: "every FREE test gate (~9 min)", script: "test:gates", cwd: SERVER },
  { step: 3, name: "run-errors", what: "triage the non-done runs", script: "probe:run-errors", cwd: SERVER },
  { step: 4, name: "parks", what: "parked + abandoned tasks", script: "probe:parks", cwd: SERVER },
  { step: 5, name: "accounts", what: "backend headroom + failover ladder", script: "probe:accounts", cwd: SERVER },
  { step: 6, name: "console", what: "the console still mounts", script: "probe:console", cwd: ROOT },
  { step: 6, name: "chips", what: "account chips unclipped across desktop widths", script: "probe:chips", cwd: ROOT },
  { step: 7, name: "audit-deps", what: "prod dependency advisories + overrides", script: "audit:deps", cwd: SERVER },
  { step: 7, name: "audit-secrets", what: "secrets in tree or history", script: "audit:secrets", cwd: SERVER },
  { step: 8, name: "db-size", what: "what the DB is made of", script: "probe:db-size", cwd: SERVER },
  { step: 9, name: "office", what: "the online office is two-way, not echoing itself", script: "probe:office", cwd: SERVER },
  { step: 10, name: "model-catalog", what: "all provider models + exact effort tiers available to Auto-select", script: "probe:model-catalog", cwd: SERVER },
  { step: 11, name: "provider-toolchain", what: "Claude SDK/runtime + Codex/Grok CLI stable-version currency", script: "probe:provider-toolchain", cwd: SERVER },
  { step: 12, name: "auto-review", what: "auto-review ownership + whether unattended review stays inside both convergence fences", script: "probe:auto-review", cwd: SERVER },
];

// npm is a .cmd on Windows; Node refuses to spawn .cmd/.bat without a shell.
const win = process.platform === "win32";

/** Every line goes to BOTH the terminal (live, so a watcher sees the gates tick past) and the
 *  transcript. `spawn` + piped stdio rather than `stdio: "inherit"` is what makes the second half
 *  possible without giving up the first — a spawnSync/pipe would go silent for the gates' 8 minutes. */
function emit(log, text) {
  try {
    process.stdout.write(text);
  } catch {
    // stdout is gone (see guardBrokenPipe) — the transcript is the surviving copy, keep filling it.
  }
  if (log) log.write(text);
}

/** A reader who pipes the sweep into `head` closes stdout half way through it. Node raises EPIPE as an
 *  unhandled stream error, which kills the process and truncates the transcript — losing precisely the
 *  output the transcript exists to preserve. Swallow that one; every other stream error still throws. */
function guardBrokenPipe(stream) {
  stream.on("error", (err) => {
    if (err && err.code === "EPIPE") return;
    throw err;
  });
  return stream;
}

function run(entry, log) {
  return new Promise((resolve) => {
    const started = Date.now();
    const done = (ok) => resolve({ ...entry, ok, ms: Date.now() - started });
    const child = spawn("npm", ["run", entry.script], {
      cwd: entry.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: win,
      windowsHide: true,
    });
    child.stdout.on("data", (c) => emit(log, c.toString()));
    child.stderr.on("data", (c) => emit(log, c.toString()));
    child.on("error", (err) => {
      emit(log, `\n  ! could not start "npm run ${entry.script}": ${err.message}\n`);
      done(false);
    });
    child.on("close", (code) => done(code === 0));
  });
}

function selected(argv) {
  const wanted = argv.filter((a) => /^\d+$/.test(a)).map(Number);
  if (!wanted.length) return STEPS;
  return STEPS.filter((s) => wanted.includes(s.step));
}

function pad(s, n) {
  return String(s).padEnd(n);
}

function exitCodeFor(results) {
  return results.some((r) => !r.ok) ? 1 : 0;
}

function summaryText(results) {
  const failed = results.filter((r) => !r.ok);
  const lines = ["", "", "=== sweep summary ===", ""];
  for (const r of results) {
    lines.push(`  ${r.ok ? "✓" : "✗"} step ${r.step}  ${pad(r.name, 15)} ${pad(`${(r.ms / 1000).toFixed(1)}s`, 8)} ${r.what}`);
  }
  lines.push("");
  if (!failed.length) {
    lines.push(`  ✓ all ${results.length} check(s) green.`);
    lines.push("    Green is not the whole job: read the ladder depth, the park counts and the DB growth");
    lines.push("    above — those are healthy-but-worth-watching, and no exit code carries them.");
  } else {
    lines.push(`  ✗ ${failed.length} of ${results.length} check(s) failed: ${failed.map((f) => f.name).join(", ")}`);
    lines.push(`    Re-run just those with: npm run quality -- ${[...new Set(failed.map((f) => f.step))].join(" ")}`);
  }
  lines.push("", `  full transcript: ${TRANSCRIPT}`, "");
  return lines.join("\n");
}

function openTranscript() {
  fs.mkdirSync(path.dirname(TRANSCRIPT), { recursive: true });
  return fs.createWriteStream(TRANSCRIPT, { flags: "w" });
}

/** Flush and close the transcript — `process.exit` truncates a stream with writes still queued. */
function closeTranscript(log) {
  return new Promise((resolve) => log.end(resolve));
}

async function main() {
  const argv = process.argv.slice(2);
  const steps = selected(argv);

  if (argv.includes("--list")) {
    for (const s of steps) console.log(`  step ${s.step}  ${pad(s.name, 15)} npm run ${s.script}`);
    return 0;
  }

  // Claimed BEFORE the transcript is opened: `flags:"w"` truncates, so a refusal that came after it
  // would already have destroyed the running sweep's log in order to say it was not going to run.
  const lease = argv.includes("--force")
    ? { acquired: true, release() {} }
    : acquireGateRunLease({ lockDbPath: SWEEP_LOCK_DB, ownerPath: SWEEP_OWNER });
  if (!lease.acquired) {
    console.log(sweepBusyText(lease.owner));
    return BUSY_EXIT_CODE;
  }

  const log = openTranscript();
  // Announced up front, not just in the summary: a sweep is usually backgrounded, and this is where
  // to watch it from while it runs.
  emit(log, `=== nightly quality sweep — ${steps.length} check(s) ===\n`);
  emit(log, "    every step runs even if an earlier one fails; the verdict is at the end.\n");
  emit(log, `    transcript: ${TRANSCRIPT}\n`);

  const results = [];
  for (const s of steps) {
    emit(log, `\n\n──────── step ${s.step}: ${s.name} — ${s.what} ────────\n`);
    results.push(await run(s, log));
  }

  emit(log, summaryText(results));
  await closeTranscript(log);
  lease.release();
  return exitCodeFor(results);
}

module.exports = {
  STEPS,
  TRANSCRIPT,
  SWEEP_LOCK_DB,
  SWEEP_OWNER,
  BUSY_EXIT_CODE,
  sweepArtifactPaths,
  selected,
  summaryText,
  exitCodeFor,
  guardBrokenPipe,
  sweepBusyText,
};

if (require.main === module) {
  guardBrokenPipe(process.stdout);
  main().then((code) => process.exit(code));
}
