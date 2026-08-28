// Gate for the crash.log classifier (crashlog-scan.cjs), which the nightly health probe uses to tell a
// REAL fault from the benign lifecycle notes the process guards write to the same file. A
// misclassification is expensive in one direction only: filing a real crash as a lifecycle note hides
// it from the sweep (the exact "is the server crashing?" blind spot this classifier exists to close).
// Run: node scripts/crashlog-scan.test.cjs

const assert = require("node:assert/strict");
const { scanCrashLog, isFaultEntry, parseCrashLogEntries } = require("./crashlog-scan.cjs");

// isFaultEntry — the label-based path catches the two labels the guards write for real faults even
// with no stack; the stack-frame / Error-line paths future-proof against a new fault label.
assert.equal(isFaultEntry("unhandledRejection", "mem rss=1MB heapUsed=1MB"), true, "fault label alone");
assert.equal(isFaultEntry("uncaughtException", "mem rss=1MB"), true, "fault label alone (uncaught)");
assert.equal(isFaultEntry("someFutureLabel", "\n    at foo (x.ts:1:1)"), true, "stack frame signals a fault");
assert.equal(isFaultEntry("someFutureLabel", "\nTypeError: cannot read x of undefined"), true, "Error: line signals a fault");
assert.equal(isFaultEntry("memory high-water rss=200MB", "mem rss=200MB heapUsed=50MB"), false, "high-water is not a fault");
assert.equal(isFaultEntry("WARNING memory pressure — heapUsed at 90%", "mem rss=300MB"), false, "pressure warning is not a fault");
assert.equal(isFaultEntry("signal SIGTERM received — shutting down", "mem rss=135MB"), false, "signal is not a fault");
assert.equal(isFaultEntry("process exit code=0", "mem rss=100MB"), false, "exit record is not a fault");
assert.equal(isFaultEntry("boot", "mem rss=40MB heapUsed=12MB"), false, "a boot record is not a fault");
assert.equal(
  isFaultEntry("restart reconcile — runs=2 resumed=1 revived=1", "mem rss=41MB"),
  false,
  "the restart reconciliation summary is not a fault",
);
assert.equal(
  isFaultEntry("warning: MaxListenersExceededWarning: Possible EventEmitter memory leak", "mem rss=130MB"),
  false,
  "a Node warning that contains 'Warning' is not a fault (no stack, no Error: opener)",
);
// The two logCrash sites that log a STRING body (no stack) — genuine data-loss faults the secondary
// signals can't catch, so they must be matched by label. Without these the classifier hides a stalled
// stdin consumer / dropped codex output as a benign lifecycle note.
assert.equal(
  isFaultEntry("inputQueue.overflow", "mem rss=100MB\ndropping oldest of 5 buffered input messages (consumer stalled)"),
  true,
  "inputQueue.overflow is a data-loss fault despite a string body (no stack)",
);
assert.equal(
  isFaultEntry("codex.stdoutOverflow", "mem rss=100MB\ndropped 12345 bytes of newline-less stdout"),
  true,
  "codex.stdoutOverflow is a data-loss fault despite a string body (no stack)",
);

// Build a canned crash.log with one entry per case. Each entry opens with `[<iso>] <label>` on its own
// line, then a mem snapshot, then (faults only) the stack body — mirroring crashLog.ts's entry shape.
const entry = (iso, label, body = "") =>
  `\n[${iso}] ${label}\nmem rss=100MB heapUsed=30MB heapTotal=64MB ext=4MB uptime=60s pid=123${
    body ? `\n${body}` : ""
  }`;
const STACK = "Error: kaboom-marker\n    at foo (bar.ts:10:5)\n    at Object.<anonymous> (baz.ts:1:1)";

const LOG = [
  entry("2026-07-24T11:16:55.310Z", "memory high-water rss=114MB", ""), // out of window
  entry("2026-07-24T13:00:00.000Z", "uncaughtException", "Error: old-fault\n    at old (old.ts:1:1)"), // fault, OUT of window
  entry("2026-07-25T03:00:00.000Z", "process exit code=0", ""),
  entry("2026-07-25T03:30:00.000Z", "uncaughtException", STACK), // fault, in window
  entry("2026-07-25T04:00:00.000Z", "WARNING memory pressure — heapUsed at 90% of the 4096MB ceiling; an OOM abort is imminent", ""),
  entry("2026-07-25T04:05:00.000Z", "warning: MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 11 listeners added.", ""),
  entry("2026-07-25T04:07:00.000Z", "signal SIGTERM received — shutting down", ""),
  // The restart pair: the boot that followed that shutdown, and what it did to the interrupted work.
  entry("2026-07-25T04:07:20.000Z", "boot", ""),
  entry("2026-07-25T04:07:21.000Z", "restart reconcile — runs=2 resumed=1 revived=1 handedBack=1", ""),
  entry("2026-07-25T04:08:00.000Z", "memory high-water rss=217MB", "active-work: 1 live agent run(s) across 1 thread(s)"),
  entry("2026-07-25T04:09:00.000Z", "someFutureGuardLabel", "Error: future-fault\n    at z (q.ts:1:1)"), // fault via stack frame, unknown label
  entry("2026-07-25T04:10:00.000Z", "inputQueue.overflow", "dropping oldest of 5 buffered input messages (consumer stalled)"), // string-bodied fault
  entry("2026-07-25T04:11:00.000Z", "codex.stdoutOverflow", "dropped 12345 bytes of newline-less stdout"), // string-bodied fault
].join("");

const parsed = parseCrashLogEntries(LOG);
assert.equal(parsed.length, 13, "the shared record parser returns every dated entry once");
assert.equal(parsed[0].label, "memory high-water rss=114MB", "the parser separates the opener label");
assert.equal(parsed[0].ts, Date.parse("2026-07-24T11:16:55.310Z"), "the parser preserves millisecond timestamps");
assert.match(parsed[1].body, /old-fault/, "the parser preserves the record body for fault classification");

const DAY0 = Date.parse("2026-07-25T00:00:00.000Z");
const scan = scanCrashLog(LOG, DAY0);

// Four in-window faults: the label-based uncaughtException, the unknown-label entry caught by the
// stack-frame signal, and the two string-bodied overflow labels. The out-of-window fault (07-24) must NOT appear.
assert.equal(scan.faults.length, 4, `expected 4 in-window faults, got ${scan.faults.length}`);
assert.ok(scan.faults.some((f) => f.label === "uncaughtException"), "label-based fault classified");
assert.ok(scan.faults.some((f) => f.label === "someFutureGuardLabel"), "stack-frame fault classified despite an unknown label");
assert.ok(scan.faults.some((f) => f.label === "inputQueue.overflow"), "string-bodied overflow fault classified");
assert.ok(scan.faults.some((f) => f.label === "codex.stdoutOverflow"), "string-bodied stdout-overflow fault classified");
assert.ok(!scan.faults.some((f) => f.label === "Error: old-fault"), "out-of-window fault excluded");
assert.equal(scan.faults.find((f) => f.label === "uncaughtException").ts, Date.parse("2026-07-25T03:30:00.000Z"), "fault carries its timestamp");

// Lifecycle notes are bucketed, never filed as faults — including no overflow leaking into 'other'.
assert.equal(scan.lifecycle["memory pressure"], 1, "memory-pressure warning counted once");
assert.equal(scan.lifecycle.warning, 1, "Node warning counted once");
assert.equal(scan.lifecycle.signal, 1, "signal counted once");
assert.equal(scan.lifecycle.exit, 1, "exit counted once");
assert.equal(scan.lifecycle["memory high-water"], 1, "only the in-window high-water counted (the 07-24 one excluded)");
assert.equal(scan.lifecycle.boot, 1, "the boot record is bucketed as a boot, not as 'other'");
assert.equal(scan.lifecycle["restart reconcile"], 1, "the reconciliation summary gets its own bucket");
assert.equal(scan.lifecycle.other, 0, "no 'other' bucket leakage");

// Windowing on faults: push sinceMs past the 03:30 fault; the three newer faults remain.
const scan2 = scanCrashLog(LOG, Date.parse("2026-07-25T04:08:30.000Z"));
assert.equal(scan2.faults.length, 3, "narrowing the window drops the oldest fault (03:30)");
assert.ok(!scan2.faults.some((f) => f.label === "uncaughtException"), "the 03:30 fault is outside the narrower window");
assert.ok(scan2.faults.some((f) => f.label === "someFutureGuardLabel"), "newer faults survive");

console.log("crashlogScan: all assertions passed");
