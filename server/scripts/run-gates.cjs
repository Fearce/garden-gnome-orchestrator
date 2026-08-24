#!/usr/bin/env node
// Runs every FREE test gate (pure unit + stubbed integration) in one shot and
// exits non-zero if any fails. The reader/structured/effort .itest gates are safe
// here: they use local config/parser assertions and a throwaway git repo, never a
// real agent run. Keep this list in sync with package.json test scripts when
// adding a new FREE gate.
//
// The terminal stays terse — one line per gate — because that is what makes a 5-minute suite
// scannable. Everything each gate actually printed goes to `server/data/gates-last.log`, which is
// where you watch a run from: the suite is nearly always backgrounded, and a backgrounded command
// piped through `tail` writes NOTHING until it exits (tail must buffer to know which lines are
// last), so for its whole run you cannot tell a wedged gate from a slow one. That cost a full
// re-run on 2026-08-17. The transcript grows live, so `tail -20 server/data/gates-last.log`
// answers "which gate is it on, and what is it doing" at any moment.
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const SERVER_DIR = path.resolve(__dirname, "..");

// Under server/data, which is gitignored — a run transcript is a working artifact, never a commit.
const TRANSCRIPT = path.join(SERVER_DIR, "data", "gates-last.log");

const GATES = [
  "test:cron",
  "test:weekly-safety",
  "test:spread-usage",
  "test:ext-wake",
  "test:account-usage",
  "test:grok-runner",
  "test:grok-reasoning",
  "test:grok-usage",
  "test:schedule-detect",
  "test:scheduler",
  "test:notes",
  "test:deploy-plan",
  "test:tree-owner",
  "test:api-errors",
  "test:injection",
  "test:auto-title",
  "test:voice-announce",
  "test:run-error",
  "test:run-classify",
  "test:cap-flag",
  "test:crashlog-scan",
  "test:process-build",
  "test:failover-ladder",
  "test:provider-serves-role",
  "test:park-classify",
  "test:recovery-features",
  "test:office-bridge",
  "test:office-gating",
  "test:zai-usage",
  "test:zai-cap",
  "test:structured",
  "test:effort",
  "test:reader",
  "test:token-freeze",
  "test:qa-budget",
  "test:inject-qa",
  "test:chat-steering",
  "test:auto-review",
  "test:model-select",
  "test:auto-model",
  "test:self-improve-restart",
  "test:restart-revival",
  "test:silent-resume",
  "test:cli-role-kickoff",
  "test:per-repo",
  "test:crashlog",
  "test:leak-bookkeeping",
  "test:attachment-dedupe",
  "test:stale-gnomes",
  "test:git",
  "test:repo-ops",
  "test:supervisor",
  "test:audit-deps",
  "test:audit-overrides",
  "test:email-hygiene",
  "test:qa-loop-check",
  "test:ceiling-economics",
  "test:role-ceilings",
  "test:pdf-parse",
  "test:db-size",
  "test:gate-registration",
  "test:quality-sweep",
  "test:gates-driver",
];

// npm is a .cmd on Windows; Node blocks spawning .cmd/.bat without a shell, so
// run through the shell there. On POSIX a plain `npm` invocation is enough.
const win = process.platform === "win32";

/** A reader who pipes the suite into `head` closes stdout half way through it. Node raises EPIPE as an
 *  unhandled stream error, which kills the process and truncates the transcript — losing precisely the
 *  output it exists to preserve, while still exiting 0 and reading like a finished run. Swallow that one;
 *  every other stream error still throws. */
function guardBrokenPipe(stream) {
  stream.on("error", (err) => {
    if (err && err.code === "EPIPE") return;
    throw err;
  });
  return stream;
}

/** Terminal write that survives a closed pipe — the transcript is the copy that must not be lost. */
function say(text) {
  try {
    process.stdout.write(text);
  } catch {
    /* stdout is gone (see guardBrokenPipe); the transcript keeps filling */
  }
}

/** Run one gate, streaming its output into the transcript AS IT ARRIVES (never buffered to the end,
 *  which is what makes a live `tail` of the log useful) while the terminal gets one line per gate. */
function runGate(gate, log) {
  return new Promise((resolve) => {
    const started = Date.now();
    let output = "";
    const child = spawn("npm", ["run", gate], { cwd: SERVER_DIR, stdio: ["ignore", "pipe", "pipe"], shell: win });
    const take = (chunk) => {
      const text = chunk.toString();
      output += text;
      if (log) log.write(text);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", (err) => {
      take(`\n! could not start "npm run ${gate}": ${err.message}\n`);
      resolve({ gate, ok: false, ms: Date.now() - started, output });
    });
    child.on("close", (code) => resolve({ gate, ok: code === 0, ms: Date.now() - started, output }));
  });
}

function tail(text, n) {
  const lines = text.trimEnd().split(/\r?\n/);
  return lines.slice(-n).join("\n");
}

function summaryText(results) {
  const failed = results.filter((r) => !r.ok);
  const lines = ["", "=== summary ===", `  ${results.length - failed.length}/${results.length} gates passed`];
  for (const r of failed) {
    lines.push(`\n  ✗ ${r.gate} — last output:`);
    lines.push(
      tail(r.output, 12)
        .split("\n")
        .map((l) => `      ${l}`)
        .join("\n"),
    );
  }
  lines.push("", `  full transcript: ${TRANSCRIPT}`, "");
  return lines.join("\n");
}

function openTranscript() {
  fs.mkdirSync(path.dirname(TRANSCRIPT), { recursive: true });
  return fs.createWriteStream(TRANSCRIPT, { flags: "w" });
}

/** `process.exit` truncates a stream with writes still queued — flush before returning an exit code. */
function closeTranscript(log) {
  return new Promise((resolve) => log.end(resolve));
}

async function main() {
  const log = guardBrokenPipe(openTranscript());
  // The path goes out FIRST, not just in the summary: a backgrounded run is watched from the
  // transcript, and by the time the summary prints there is nothing left to watch.
  const header = `\n=== running ${GATES.length} free test gates ===\n    transcript: ${TRANSCRIPT}\n\n`;
  say(header);
  log.write(header);

  const results = [];
  for (const gate of GATES) {
    say(`  … ${gate} `);
    log.write(`\n──────── ${gate} ────────\n`);
    const r = await runGate(gate, log);
    results.push(r);
    const verdict = `${r.ok ? "✓" : "✗"} (${(r.ms / 1000).toFixed(1)}s)\n`;
    say(verdict);
    log.write(`──────── ${gate}: ${r.ok ? "passed" : "FAILED"} in ${(r.ms / 1000).toFixed(1)}s ────────\n`);
  }

  const summary = summaryText(results);
  say(summary);
  log.write(summary);
  await closeTranscript(log);
  return results.some((r) => !r.ok) ? 1 : 0;
}

module.exports = { GATES, TRANSCRIPT, guardBrokenPipe, summaryText, tail };

if (require.main === module) {
  guardBrokenPipe(process.stdout);
  main().then((code) => process.exit(code));
}
