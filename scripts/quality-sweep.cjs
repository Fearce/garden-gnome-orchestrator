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

// Under server/data, which is gitignored — a sweep transcript is a working artifact, never a commit.
const TRANSCRIPT = path.join(SERVER, "data", "quality-sweep-last.log");

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
  return exitCodeFor(results);
}

module.exports = { STEPS, TRANSCRIPT, selected, summaryText, exitCodeFor, guardBrokenPipe };

if (require.main === module) {
  guardBrokenPipe(process.stdout);
  main().then((code) => process.exit(code));
}
