// Classifier for server/data/crash.log. Lets the nightly health probe tell a REAL fault apart from the
// benign lifecycle notes the process guards write to this same file — so a sweep can answer "is the
// server crashing?" deterministically instead of a manual `tail` + eyeball each time (a green `health`
// said nothing about crash.log content until this existed).
//
// Entry shape (crashLog.ts): each record opens with `[<iso>] <label>` on its own line, then a
// `mem rss=…` snapshot, an optional context block (`active-work: …`), and — for FAULTS only — the error
// body (a stack trace). Lifecycle records (memory high-water, memory-pressure warnings, forwarded
// signals, the exit record, Node warnings) stop after the snapshot/context and carry no stack.
//
//   node -e "const {scanCrashLog}=require('./scripts/crashlog-scan.cjs'); const t=require('fs').readFileSync('server/data/crash.log','utf8'); console.log(scanCrashLog(t, Date.now()-864e5))"

// Labels the process guards write via logCrash for a real fault. The first two are process-fatal; the
// `inputQueue.overflow` / `codex.stdoutOverflow` pair log a STRING body (no stack frame, no `Error:`
// line) when the agent's stdin consumer stalls or codex emits newline-less stdout past the cap —
// genuine data-loss events the secondary signals below can't see, so they are listed explicitly.
// Every other logCrash site passes an Error object, so the stack-frame / Error-line signals below
// already catch those (and any future Error-bodied fault label) without being listed here.
const FAULT_LABEL = /^(unhandledRejection|uncaughtException|inputQueue\.overflow|codex\.stdoutOverflow)\b/;
// Secondary, label-agnostic fault signals so a future fault label still trips the classifier:
//   • an indented V8 stack frame (`    at foo (…)` — Node prints 4-space-indented frames)
//   • a `…Error:` opener on its own line (`TypeError:`, `Error:`, `RangeError:` …)
const STACK_FRAME = /\r?\n[ \t]{3,}at [\w$./]/;
const ERROR_LINE = /\r?\n[\w$][\w.$]*Error:/;

const LIFECYCLE_BUCKETS = [
  [/^memory high-water/, "memory high-water"],
  [/^WARNING memory pressure/, "memory pressure"],
  [/^signal /, "signal"],
  [/^process exit/, "exit"],
  // A process STARTING, and what that boot did to work the previous one left mid-flight. Every other
  // record says how a process went down, which is why "when did each boot happen?" used to be answerable
  // only by finding a memory high-water note and subtracting its `uptime=`.
  [/^boot\b/, "boot"],
  [/^restart reconcile/, "restart reconcile"],
  [/^warning:/, "warning"],
];

function isFaultEntry(label, body) {
  return FAULT_LABEL.test(label) || STACK_FRAME.test(body) || ERROR_LINE.test(body);
}

/** Parse every crash.log record once so health and per-task incident traces share the record boundary. */
function parseCrashLogEntries(text) {
  const entries = [];
  // Split before each `[<iso>]` opener; a non-empty preamble remains an undated record so callers that
  // scan for faults can continue to fail safe rather than silently dropping malformed evidence.
  const chunks = String(text).split(/(?=^\[\d{4}-\d{2}-\d{2}T)/m);
  for (const raw of chunks) {
    if (!raw.trim()) continue;
    const lines = raw.split(/\r?\n/);
    const firstLine = lines[0] || "";
    const tsMatch = firstLine.match(/\[(\d{4}-\d{2}-\d{2}T[^\]]+)\]/);
    const parsed = tsMatch ? Date.parse(tsMatch[1]) : NaN;
    entries.push({
      ts: Number.isFinite(parsed) ? parsed : null,
      label: firstLine.replace(/^\[[^\]]*\]\s*/, "").trim(),
      body: lines.slice(1).join("\n"),
    });
  }
  return entries;
}

/**
 * Parse crash.log into the faults and lifecycle notes that fall inside `[sinceMs, now]`. Entries are
 * split on a leading `[<iso>]` opener; an undated entry is treated as in-window (safer to surface than
 * to drop). Returns `{ faults: [{ts, label}], lifecycle: {bucket: count} }`. `ts` is null when the
 * opener had no parseable timestamp.
 */
function scanCrashLog(text, sinceMs) {
  const faults = [];
  const lifecycle = { "memory high-water": 0, "memory pressure": 0, signal: 0, exit: 0, boot: 0, "restart reconcile": 0, warning: 0, other: 0 };
  const inWindow = (ts) => !Number.isFinite(ts) || ts >= sinceMs;
  for (const entry of parseCrashLogEntries(text)) {
    const ts = entry.ts ?? NaN;
    const { label, body } = entry;
    if (!inWindow(ts)) continue;
    if (isFaultEntry(label, body)) {
      faults.push({ ts: Number.isFinite(ts) ? ts : null, label });
    } else {
      const bucket = (LIFECYCLE_BUCKETS.find(([re]) => re.test(label)) || [, "other"])[1];
      lifecycle[bucket] = (lifecycle[bucket] || 0) + 1;
    }
  }
  return { faults, lifecycle };
}

module.exports = { scanCrashLog, isFaultEntry, parseCrashLogEntries };
