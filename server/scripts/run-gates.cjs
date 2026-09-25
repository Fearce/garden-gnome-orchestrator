#!/usr/bin/env node
// Runs every FREE test gate (pure unit + stubbed integration) in one shot and
// exits non-zero if any fails. The reader/structured/effort .itest gates are safe
// here: they use local config/parser assertions and a throwaway git repo, never a
// real agent run. Keep this list in sync with package.json test scripts when
// adding a new FREE gate.
//
// The terminal stays terse — one start and finish line per gate. The transcript records each
// completed gate's full output; while a gate runs its own file under data/gates-live grows live.
// This keeps concurrent gate output readable and still exposes a wedged gate's last message.
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
// A SUBSET run (`-- --failed`, or explicit gate names) writes here instead, and stamps nothing. Reading
// a red summary and re-running just those gates is the normal next move — it is what the quality sweep
// already offers as `npm run quality -- <steps>` — but a partial run is not a suite verdict, so it must
// not be able to overwrite the full run's evidence or leave a stamp `probe:gates` would read as a green.
const SUBSET_TRANSCRIPT = path.join(SERVER_DIR, "data", "gates-subset.log");
const LIVE_DIR = path.join(SERVER_DIR, "data", "gates-live");
const DEFAULT_JOBS = 3;
const BUSY_EXIT_CODE = 75;
const USAGE_EXIT_CODE = 2;

const GATES = [
  "test:ide",
  "test:code-context",
  "test:cron",
  "test:weekly-safety",
  "test:spread-usage",
  "test:capacity-routing",
  "test:capacity-stall",
  "test:usage-windows",
  "test:child-runner",
  "test:event-loop",
  "test:ext-wake",
  "test:account-usage",
  "test:grok-runner",
  "test:incident-recovery",
  "test:grok-reasoning",
  "test:grok-usage",
  "test:codex-usage",
  "test:codex-launcher",
  "test:schedule-detect",
  "test:scheduler",
  "test:scheduler-latency",
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
  "test:task-run-activity",
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
  "test:portal-link",
  "test:archive-thread",
  "test:restore-archived-deliverables",
  "test:deliverable-dedup",
  "test:dedupe-deliverable-findings",
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
  "test:title-ownership",
  "test:subtasks",
  "test:jev-client",
  "test:zai-cap",
  "test:free-providers",
  "test:free-provider-routing",
  "test:console-probe",
  "test:version-watch",
  "test:provider-toolchain",
  "test:structured",
  "test:effort",
  "test:reader",
  "test:vanilla-lane",
  "test:route-selection",
  "test:route-pipeline",
  "test:routing-notes",
  "test:routing-probe",
  "test:token-freeze",
  "test:qa-budget",
  "test:qa-budget-scope",
  "test:inject-qa",
  "test:standing-directives",
  "test:injection-pickup",
  "test:chat-steering",
  "test:cowork",
  "test:cowork-summary",
  "test:cowork-ui",
  "test:cowork-health",
  "test:auto-review",
  "test:manual-deployment",
  "test:manual-deployment-probe",
  "test:implementation-memos",
  "test:deliverables",
  "test:run-attribution",
  "test:collaborator-feed",
  "test:collapse-shotgun-task",
  "test:deliverables-probe",
  "test:elapsed-probe",
  "test:reveal-workspace",
  "test:model-select",
  "test:model-catalog",
  "test:model-catalog-health",
  "test:retired-model-id",
  "test:auto-model",
  "test:claude-opus-floor",
  "test:reset-credits",
  "test:review-model-floor",
  "test:director-provider",
  "test:director-directives",
  "test:model-request",
  "test:model-request-ui",
  "test:token-conservation",
  "test:usage-saving",
  "test:usage-saving-resume-drift",
  "test:themes",
  "test:fonts",
  "test:screensaver",
  "test:git-console-ui",
  "test:lazy-chunks-ui",
  "test:lab-contexts",
  "test:model-pin-probe",
  "test:livebench",
  "test:self-improve-restart",
  "test:restart-revival",
  "test:silent-resume",
  "test:continuation-progress",
  "test:implementor-handover",
  "test:cli-role-kickoff",
  "test:per-repo",
  "test:slots",
  "test:crashlog",
  "test:leak-bookkeeping",
  "test:attachment-dedupe",
  "test:image-limit",
  "test:stale-gnomes",
  "test:git",
  "test:git-progress",
  "test:repo-ops",
  "test:repo-console",
  "test:git-console-probe",
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
  "test:web-dist",
  "test:quality-sweep",
  "test:gates-driver",
  "test:gates-provenance",
];

// These integration gates bind fixed local ports. Let the pooled gates finish before running them,
// so each fixed-port gate has the suite's local resources to itself.
const SERIAL_GATES = new Set(["test:deploy-plan", "test:lab-harness"]);

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

/** Bound concurrency so independent throwaway-repo and database tests share the machine fairly.
 *  One worker preserves the old serial behavior for diagnosing timing-sensitive failures. */
function gateJobs(value = process.env.GGO_GATE_JOBS) {
  const jobs = value == null || value === "" ? DEFAULT_JOBS : Number(value);
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > 4) throw new Error("GGO_GATE_JOBS must be an integer from 1 to 4");
  return jobs;
}

/** Run one gate. Its own live file receives output immediately; the shared transcript gets the
 *  complete, contiguous output on completion so concurrent gates cannot interleave stack traces. */
function runGate(gate, livePath) {
  return new Promise((resolve) => {
    const started = Date.now();
    let output = "";
    const live = fs.createWriteStream(livePath, { flags: "w" });
    const child = spawn("npm", ["run", gate], { cwd: SERVER_DIR, stdio: ["ignore", "pipe", "pipe"], shell: win, windowsHide: true });
    const take = (chunk) => {
      const text = chunk.toString();
      output += text;
      live.write(text);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", (err) => {
      take(`\n! could not start "npm run ${gate}": ${err.message}\n`);
    });
    child.on("close", (code) => live.end(() => resolve({ gate, ok: code === 0, code, ms: Date.now() - started, output })));
  });
}

/** The live files are only useful for the run in progress. A previous run's leftovers (or a longer
 *  suite's higher-numbered files after a subset run) would pose as running gates, so start empty.
 *  Called under the lease, so no other runner is writing here. */
function clearLiveLogs(dir = LIVE_DIR) {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".log")) continue;
    try {
      fs.rmSync(path.join(dir, name), { force: true });
    } catch {
      /* a file held open by a viewer is harmless; its gate slot is rewritten in place */
    }
  }
}

/** Fixed worker pool, returning results in suite order even when gates finish out of order. */
async function runPool(gates, jobs, run) {
  const results = Array(gates.length);
  let next = 0;
  const workers = await Promise.allSettled(Array.from({ length: Math.min(jobs, gates.length) }, async () => {
    while (next < gates.length) {
      const index = next++;
      results[index] = await run(gates[index], index);
    }
  }));
  const failure = workers.find((worker) => worker.status === "rejected");
  if (failure) throw failure.reason;
  return results;
}

/** Run gates with exclusive local resources after the bounded pool, keeping suite order in results. */
async function runGateGroups(gates, jobs, run, serialGates = SERIAL_GATES) {
  const results = Array(gates.length);
  const parallel = [];
  const serial = [];
  for (const [index, gate] of gates.entries()) {
    (serialGates.has(gate) ? serial : parallel).push({ gate, index });
  }

  const pooled = await runPool(parallel, jobs, async ({ gate, index }) => ({ index, result: await run(gate, index) }));
  for (const { index, result } of pooled) results[index] = result;
  for (const { gate, index } of serial) results[index] = await run(gate, index);
  return results;
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

/** Which gates a finished-or-interrupted run reported FAILED, read from the transcript's own per-gate
 *  verdict lines rather than from the completion stamp. The stamp is written only after the last gate,
 *  so the run most worth re-running — one that crashed, was killed, or died with the session that
 *  backgrounded it — has no stamp at all, while its transcript has every verdict up to the moment it
 *  stopped. Returned in suite order, so a re-run is ordered like the run it came from. */
function failedGatesFrom(transcriptText, gates = GATES) {
  const failed = new Set();
  for (const m of String(transcriptText ?? "").matchAll(/^─+ (\S+): FAILED\b/gm)) failed.add(m[1]);
  return gates.filter((g) => failed.has(g));
}

/** Turn argv into the gate list to run. No arguments is the whole suite; `--failed` re-runs what the
 *  last transcript reported red; anything else is taken as explicit gate names. An unknown name is a
 *  usage error rather than a silent no-op, because "it ran nothing and exited 0" reads as a pass. */
function parseSelection(argv, gates = GATES, readTranscript = () => fs.readFileSync(TRANSCRIPT, "utf8")) {
  const args = (argv ?? []).filter((a) => a !== "");
  if (args.length === 0) return { mode: "full", gates, error: null };
  if (args.length === 1 && (args[0] === "--failed" || args[0] === "-f")) {
    let text = "";
    try {
      text = readTranscript();
    } catch {
      return { mode: "failed", gates: [], error: `no transcript to read failures from (${TRANSCRIPT})` };
    }
    return { mode: "failed", gates: failedGatesFrom(text, gates), error: null };
  }
  const unknown = args.filter((a) => !gates.includes(a));
  if (unknown.length) {
    return { mode: "only", gates: [], error: `not a registered gate: ${unknown.join(", ")}` };
  }
  return { mode: "only", gates: gates.filter((g) => args.includes(g)), error: null };
}

function summaryText(results, transcript = TRANSCRIPT) {
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
  lines.push("", `  full transcript: ${transcript}`, "");
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

function openTranscript(target = TRANSCRIPT) {
  if (target === TRANSCRIPT) rotateTranscript();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  return fs.createWriteStream(target, { flags: "w" });
}

/** `process.exit` truncates a stream with writes still queued — flush before returning an exit code. */
function closeTranscript(log) {
  return new Promise((resolve) => log.end(resolve));
}

async function main(argv = process.argv.slice(2)) {
  let jobs;
  try {
    jobs = gateJobs();
  } catch (err) {
    say(`
=== cannot run ===
    ${err.message}

`);
    return USAGE_EXIT_CODE;
  }
  const selection = parseSelection(argv);
  if (selection.error) {
    say(`\n=== cannot run ===\n    ${selection.error}\n    usage: npm run test:gates [-- --failed | <gate> ...]\n\n`);
    return USAGE_EXIT_CODE;
  }
  const subset = selection.mode !== "full";
  if (subset && selection.gates.length === 0) {
    say(`\n=== nothing to run ===\n    the last transcript reports no failing gate (${TRANSCRIPT})\n    this is not a suite pass — run the full suite for that\n\n`);
    return 0;
  }

  const lease = acquireGateRunLease();
  if (!lease.acquired) {
    say(busyText(lease.owner));
    return BUSY_EXIT_CODE;
  }

  const transcript = subset ? SUBSET_TRANSCRIPT : TRANSCRIPT;
  const startedAt = Date.now();
  let log;
  try {
    // Only a full run may touch the stamp: it is the record of a whole suite at a commit, and a subset
    // neither proves nor disproves it.
    if (!subset) clearCompletedStamp();
    log = guardBrokenPipe(openTranscript(transcript));
    clearLiveLogs();
    // The path goes out FIRST, not just in the summary: a backgrounded run is watched from the
    // transcript, and by the time the summary prints there is nothing left to watch.
    const scope = subset
      ? `${selection.gates.length} of ${GATES.length} gates (${selection.mode === "failed" ? "last run's failures" : "selected"}) — a subset, NOT a suite pass`
      : `${GATES.length} free test gates`;
    const header = `\n=== running ${scope} (${jobs} concurrent) ===\n    transcript: ${transcript}\n\n`;
    say(header);
    log.write(header);

    const results = await runGateGroups(selection.gates, jobs, async (gate, index) => {
      const livePath = path.join(LIVE_DIR, `${String(index + 1).padStart(3, "0")}-${gate.replace(/[^a-z0-9-]/gi, "-")}.log`);
      say(`  … ${gate}\n`);
      log.write(`  … ${gate} (live: ${livePath})\n`);
      const r = await runGate(gate, livePath);
      say(`  ${r.ok ? "✓" : "✗"} ${gate} (${(r.ms / 1000).toFixed(1)}s)\n`);
      log.write(`\n──────── ${gate} ────────\n${r.output}`);
      if (!r.output.endsWith("\n")) log.write("\n");
      log.write(`──────── ${gate}: ${r.ok ? "passed" : "FAILED"} in ${(r.ms / 1000).toFixed(1)}s ────────\n`);
      return r;
    });

    const summary = summaryText(results, transcript);
    say(summary);
    log.write(summary);
    await closeTranscript(log);
    log = null;
    if (!subset) writeStamp(results, startedAt);
    return results.some((r) => !r.ok) ? 1 : 0;
  } finally {
    if (log) await closeTranscript(log);
    lease.release();
  }
}

module.exports = {
  BUSY_EXIT_CODE,
  USAGE_EXIT_CODE,
  GATES,
  STAMP,
  PREVIOUS_TRANSCRIPT,
  TRANSCRIPT,
  SUBSET_TRANSCRIPT,
  LIVE_DIR,
  SERIAL_GATES,
  clearLiveLogs,
  gateJobs,
  runPool,
  runGateGroups,
  busyText,
  failedGatesFrom,
  parseSelection,
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
