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
// One OS-backed lease owns that shared transcript and completion stamp. A concurrent invocation
// exits temporarily unavailable before touching either artifact; running two copies made git-heavy
// gates time out and let each process overwrite the other's evidence.
const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { buildStamp, fingerprintFile } = require("./gates-provenance.cjs");
const { acquireGateRunLease } = require("./gate-run-lease.cjs");

const SERVER_DIR = path.resolve(__dirname, "..");
const ROOT_DIR = path.resolve(SERVER_DIR, "..");

// Under server/data, which is gitignored — a run transcript is a working artifact, never a commit.
const TRANSCRIPT = path.join(SERVER_DIR, "data", "gates-last.log");
// Beside it: what that run COVERED, so a later reader can ask whether the green still holds
// (`npm run probe:gates`) instead of comparing a log mtime against `git log` by hand.
// The PREVIOUS run, kept for exactly one generation. The transcript is rewritten in full on every
// run, so starting a second suite to answer "was that red reproducible?" used to delete the first
// run failure output before it had been read, and recovering it meant running those gates again
// (2026-09-11). One rotation costs nothing and makes the compare-two-runs question answerable.
const PREVIOUS_TRANSCRIPT = path.join(SERVER_DIR, "data", "gates-prev.log");
const STAMP = path.join(SERVER_DIR, "data", "gates-last.json");
const BUSY_EXIT_CODE = 75;

const GATES = [
  "test:ide",
  "test:code-context",
  "test:cron",
  "test:weekly-safety",
  "test:spread-usage",
  "test:capacity-routing",
  "test:usage-windows",
  "test:ext-wake",
  "test:account-usage",
  "test:grok-runner",
  "test:incident-recovery",
  "test:grok-reasoning",
  "test:grok-usage",
  "test:codex-usage",
  "test:schedule-detect",
  "test:scheduler",
  "test:notes",
  "test:task-search",
  "test:performance-paths",
  "test:search-index",
  "test:probe-text",
  "test:deploy-plan",
  "test:restart-drain",
  "test:restart-health",
  "test:compiled-diff",
  "test:tree-owner",
  "test:api-errors",
  "test:runner-stop-drain",
  "test:injection",
  "test:auto-title",
  "test:voice-announce",
  "test:discord-notify",
  "test:director-supervisor",
  "test:auto-review-health",
  "test:supervisor-chat-probe",
  "test:inject-thread",
  "test:thread-feed-probe",
  "test:concise-communication",
  "test:run-error",
  "test:run-classify",
  "test:cap-flag",
  "test:crashlog-scan",
  "test:task-timeline",
  "test:task-deadline-reading",
  "test:process-build",
  "test:dist-vs-head",
  "test:listener-shape",
  "test:src-mtime",
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
  "test:mirror-drift",
  "test:doc-paths",
  "test:zai-usage",
  "test:usage-freshness",
  "test:hub-stop-reach",
  "test:codex-pools",
  "test:active-deadlines",
  "test:timed-tasks",
  "test:shotgun",
  "test:task-modes",
  "test:zai-cap",
  "test:free-providers",
  "test:free-provider-routing",
  "test:console-probe",
  "test:version-watch",
  "test:provider-toolchain",
  "test:structured",
  "test:effort",
  "test:reader",
  "test:route-selection",
  "test:route-pipeline",
  "test:routing-notes",
  "test:token-freeze",
  "test:qa-budget",
  "test:qa-budget-scope",
  "test:inject-qa",
  "test:standing-directives",
  "test:chat-steering",
  "test:cowork",
  "test:cowork-summary",
  "test:cowork-ui",
  "test:cowork-health",
  "test:auto-review",
  "test:manual-deployment",
  "test:manual-deployment-probe",
  "test:implementation-memos",
  "test:reveal-workspace",
  "test:model-select",
  "test:model-catalog",
  "test:model-catalog-health",
  "test:auto-model",
  "test:director-provider",
  "test:model-request",
  "test:model-request-ui",
  "test:token-conservation",
  "test:themes",
  "test:screensaver",
  "test:lab-contexts",
  "test:model-pin-probe",
  "test:livebench",
  "test:self-improve-restart",
  "test:restart-revival",
  "test:silent-resume",
  "test:implementor-handover",
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
  "test:readme-claims",
  "test:db-size",
  "test:hot-paths",
  "test:gate-registration",
  "test:lab-harness",
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
    child.on("close", (code) => resolve({ gate, ok: code === 0, code, ms: Date.now() - started, output }));
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

/** Porcelain's first two columns are data. In particular, an unstaged modification starts with a
 *  space; trimming the whole response before `slice(3)` silently drops the first path's first byte. */
function gitStatusPaths(run = execFileSync) {
  try {
    const raw = run("git", ["status", "--porcelain"], {
      cwd: ROOT_DIR,
      encoding: "utf8",
      windowsHide: true,
    }).trimEnd();
    return raw ? raw.split(/\r?\n/).filter(Boolean).map((line) => line.slice(3)) : [];
  } catch {
    return [];
  }
}

/** Written only after every gate has run, so an interrupted suite leaves no stamp at all — the
 *  absence is how `probe:gates` tells "never finished" from "finished and passed". */
function writeStamp(results, startedAt) {
  const stamp = buildStamp({
    startedAt,
    endedAt: Date.now(),
    head: gitRead(["rev-parse", "HEAD"]),
    dirty: gitStatusPaths(),
    runnerFingerprint: fingerprintFile(__filename),
    results,
  });
  try {
    fs.writeFileSync(STAMP, `${JSON.stringify(stamp, null, 2)}\n`);
  } catch {
    /* the transcript is the artifact that must not be lost; the stamp is a convenience */
  }
}

/** A completion stamp cannot describe the run now in progress. Remove it only after this process
 *  owns the suite lease, so a rejected duplicate cannot invalidate the real owner's result. */
function clearCompletedStamp(stampPath = STAMP) {
  try {
    fs.unlinkSync(stampPath);
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }
}

function tail(text, n) {
  const lines = text.trimEnd().split(/\r?\n/);
  return lines.slice(-n).join("\n");
}

// A red gate is three different events that demand different responses, and the summary used to
// render all three as "last output" plus a 12-line tail. That tail is the END of the run, so for a
// gate that DIED mid-run it is a stack with no assertion in sight, and for one that exited printing
// nothing it is twelve passing checks: the two shapes that are not "your diff broke an assertion"
// are exactly the two the tail describes worst. All three were hit in one evening (2026-09-11):
// test:account-usage reported failing checks, test:director-provider threw a TypeError with three
// assertions still unexecuted, and test:route-pipeline exited non-zero having printed only passes.
// The CI-level version of this distinction is ~/Claude/tools/gate-ran.sh; this is its local half.
const CRASH_RE = /^[A-Za-z_$][\w.]*Error(?::|\b)|^\s+at\s.+:\d+:\d+\)?\s*$|^Node\.js v/m;
const REPORTED_RE = /(^|\s)(✗|❌|✘)|\bFAIL\b|\d+ check\(s\) failed|\bnot ok\b|\d+ failed/m;

/** What a failing gate actually did: "reported" (it ran and scored), "crashed" (it died part way,
 *  so every assertion after that point never executed and the passes above are not coverage), or
 *  "silent" (a non-zero exit with no failure and no error anywhere in its output — nothing to read,
 *  and a tail of its last lines actively misleads). Exported so the driver gate can pin all three. */
function classifyFailure(output, code) {
  const text = String(output ?? "");
  if (CRASH_RE.test(text)) return { shape: "crashed", note: "died part way through; every assertion after the error never ran, so the passes above it are not coverage" };
  if (REPORTED_RE.test(text)) return { shape: "reported", note: "ran and scored: read the failing checks below" };
  const exited = Number.isInteger(code) ? `exited ${code}` : "exited non-zero";
  return { shape: "silent", note: `${exited} having printed no failure and no error; its last lines below are PASSING output, not the cause` };
}

function summaryText(results) {
  const failed = results.filter((r) => !r.ok);
  const lines = ["", "=== summary ===", `  ${results.length - failed.length}/${results.length} gates passed`];
  for (const r of failed) {
    const { shape, note } = classifyFailure(r.output, r.code);
    lines.push(`\n  ✗ ${r.gate} [${shape}] ${note}`);
    lines.push("    last output:");
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

function busyText(owner) {
  const pid = Number.isInteger(owner?.pid) ? `PID ${owner.pid}` : "another process";
  const since = typeof owner?.startedAtIso === "string" ? ` since ${owner.startedAtIso}` : "";
  return [
    "",
    "=== full gate suite already running ===",
    `    owner: ${pid}${since}`,
    `    transcript: ${TRANSCRIPT}`,
    "    this attempt did not touch the transcript or completion stamp",
    "    wait for that run to finish, then rerun for your current tree; this is not a gate pass",
    "",
  ].join("\n");
}

/** Keep the previous run's transcript for exactly one generation. A suite rewrites the log in full,
 *  so starting a second run to ask whether a red gate was reproducible used to destroy the first
 *  run's failure output before anyone had read it, and getting it back meant running those gates
 *  again (2026-09-11). Best effort: a failed rotation must never stop the suite from running. */
function rotateTranscript(from = TRANSCRIPT, to = PREVIOUS_TRANSCRIPT) {
  try {
    if (fs.existsSync(from)) fs.copyFileSync(from, to);
  } catch {
    /* a locked or unreadable previous log is not a reason to refuse to run the gates */
  }
}

function openTranscript() {
  rotateTranscript();
  fs.mkdirSync(path.dirname(TRANSCRIPT), { recursive: true });
  return fs.createWriteStream(TRANSCRIPT, { flags: "w" });
}

/** `process.exit` truncates a stream with writes still queued — flush before returning an exit code. */
function closeTranscript(log) {
  return new Promise((resolve) => log.end(resolve));
}

async function main() {
  const lease = acquireGateRunLease();
  if (!lease.acquired) {
    say(busyText(lease.owner));
    return BUSY_EXIT_CODE;
  }

  const startedAt = Date.now();
  let log;
  try {
    clearCompletedStamp();
    log = guardBrokenPipe(openTranscript());
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
    log = null;
    writeStamp(results, startedAt);
    return results.some((r) => !r.ok) ? 1 : 0;
  } finally {
    if (log) await closeTranscript(log);
    lease.release();
  }
}

module.exports = {
  BUSY_EXIT_CODE,
  GATES,
  STAMP,
  PREVIOUS_TRANSCRIPT,
  TRANSCRIPT,
  busyText,
  classifyFailure,
  clearCompletedStamp,
  gitStatusPaths,
  rotateTranscript,
  guardBrokenPipe,
  summaryText,
  tail,
};

if (require.main === module) {
  guardBrokenPipe(process.stdout);
  main().then((code) => process.exit(code));
}
