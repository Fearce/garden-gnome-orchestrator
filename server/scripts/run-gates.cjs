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
const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { buildStamp, fingerprintFile } = require("./gates-provenance.cjs");

const SERVER_DIR = path.resolve(__dirname, "..");
const ROOT_DIR = path.resolve(SERVER_DIR, "..");

// Under server/data, which is gitignored — a run transcript is a working artifact, never a commit.
const TRANSCRIPT = path.join(SERVER_DIR, "data", "gates-last.log");
// Beside it: what that run COVERED, so a later reader can ask whether the green still holds
// (`npm run probe:gates`) instead of comparing a log mtime against `git log` by hand.
const STAMP = path.join(SERVER_DIR, "data", "gates-last.json");

const GATES = [
  "test:cron",
  "test:weekly-safety",
  "test:spread-usage",
  "test:capacity-routing",
  "test:ext-wake",
  "test:account-usage",
  "test:grok-runner",
  "test:grok-reasoning",
  "test:grok-usage",
  "test:codex-usage",
  "test:schedule-detect",
  "test:scheduler",
  "test:notes",
  "test:task-search",
  "test:search-index",
  "test:probe-text",
  "test:deploy-plan",
  "test:compiled-diff",
  "test:tree-owner",
  "test:api-errors",
  "test:injection",
  "test:auto-title",
  "test:voice-announce",
  "test:discord-notify",
  "test:director-supervisor",
  "test:supervisor-chat-probe",
  "test:concise-communication",
  "test:run-error",
  "test:run-classify",
  "test:cap-flag",
  "test:crashlog-scan",
  "test:task-timeline",
  "test:task-deadline-reading",
  "test:process-build",
  "test:background-startup",
  "test:usage-ping",
  "test:account-usage-health",
  "test:failover-ladder",
  "test:provider-serves-role",
  "test:provider-fallback",
  "test:park-classify",
  "test:recovery-features",
  "test:office-bridge",
  "test:office-gating",
  "test:office-health",
  "test:online-office",
  "test:relay-core",
  "test:relay-access",
  "test:zai-usage",
  "test:codex-pools",
  "test:active-deadlines",
  "test:timed-tasks",
  "test:shotgun",
  "test:task-modes",
  "test:zai-cap",
  "test:free-providers",
  "test:free-provider-routing",
  "test:console-probe",
  "test:structured",
  "test:effort",
  "test:reader",
  "test:route-selection",
  "test:route-pipeline",
  "test:token-freeze",
  "test:qa-budget",
  "test:qa-budget-scope",
  "test:inject-qa",
  "test:chat-steering",
  "test:auto-review",
  "test:model-select",
  "test:model-catalog",
  "test:model-catalog-health",
  "test:auto-model",
  "test:director-provider",
  "test:model-request",
  "test:model-request-ui",
  "test:livebench",
  "test:self-improve-restart",
  "test:restart-revival",
  "test:silent-resume",
  "test:cli-role-kickoff",
  "test:per-repo",
  "test:crashlog",
  "test:leak-bookkeeping",
  "test:attachment-dedupe",
  "test:image-limit",
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
  "test:gates-provenance",
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
    const child = spawn("npm", ["run", gate], { cwd: SERVER_DIR, stdio: ["ignore", "pipe", "pipe"], shell: win, windowsHide: true });
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

/** Git state, or nulls — the suite must still run in a tarball with no repo around it. */
function gitRead(args) {
  try {
    return execFileSync("git", args, { cwd: ROOT_DIR, encoding: "utf8", windowsHide: true }).trim();
  } catch {
    return null;
  }
}

/** Written only after every gate has run, so an interrupted suite leaves no stamp at all — the
 *  absence is how `probe:gates` tells "never finished" from "finished and passed". */
function writeStamp(results, startedAt) {
  const status = gitRead(["status", "--porcelain"]);
  const stamp = buildStamp({
    startedAt,
    endedAt: Date.now(),
    head: gitRead(["rev-parse", "HEAD"]),
    dirty: status ? status.split(/\r?\n/).filter(Boolean).map((l) => l.slice(3)) : [],
    runnerFingerprint: fingerprintFile(__filename),
    results,
  });
  try {
    fs.writeFileSync(STAMP, `${JSON.stringify(stamp, null, 2)}\n`);
  } catch {
    /* the transcript is the artifact that must not be lost; the stamp is a convenience */
  }
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
  const startedAt = Date.now();
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

  writeStamp(results, startedAt);
  const summary = summaryText(results);
  say(summary);
  log.write(summary);
  await closeTranscript(log);
  return results.some((r) => !r.ok) ? 1 : 0;
}

module.exports = { GATES, TRANSCRIPT, STAMP, guardBrokenPipe, summaryText, tail };

if (require.main === module) {
  guardBrokenPipe(process.stdout);
  main().then((code) => process.exit(code));
}
