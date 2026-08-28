// Pure timeline builder for probe-task-runs.cjs. It joins the persisted control-plane evidence that
// otherwise lives on four separate clocks: agent runs, findings, owner/supervisor system messages, and
// crash.log lifecycle records. Keep provider/role handling data-driven — a diagnostic that enumerates
// today's backends or roles will silently lose the next one.

const { isFaultEntry, parseCrashLogEntries } = require("./crashlog-scan.cjs");

const CONTROL_LIFECYCLE = /^(?:boot\b|restart reconcile\b|signal\b|process exit\b)/;
const CRASH_CORRELATION_MS = 90_000;

function timestamp(value) {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function compact(value, max = 280) {
  if (value == null) return null;
  const text = String(value).replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function utcStamp(value) {
  const at = timestamp(value);
  return at == null ? null : new Date(at).toISOString().replace("T", " ");
}

function localStamp(value, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const at = timestamp(value);
  const utc = utcStamp(at);
  if (at == null || !timeZone) return utc;
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      fractionalSecondDigits: 3,
      hourCycle: "h23",
    }).formatToParts(new Date(at));
    const part = (type) => parts.find((item) => item.type === type)?.value;
    const local = `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}:${part("second")}.${part("fractionalSecond")}`;
    return `${local} ${timeZone} (${utc})`;
  } catch {
    return utc;
  }
}

function runIdentity(run) {
  return [run.role, run.model, run.account].filter(Boolean).join(" · ");
}

function crashAnchors(thread, runs, findings, messages) {
  return [
    thread.created_at,
    ...runs.flatMap((run) => [run.started_at, run.ended_at]),
    ...findings.map((finding) => finding.created_at),
    ...messages.map((message) => message.created_at),
  ]
    .map(timestamp)
    .filter((value) => value != null);
}

function collectTaskTimeline({
  thread,
  runs = [],
  findings = [],
  messages = [],
  crashText = "",
}) {
  const events = [];
  let order = 0;
  const add = (at, kind, summary, detail = null) => {
    const parsed = timestamp(at);
    if (parsed == null) return;
    events.push({ at: parsed, kind, summary, detail: compact(detail), order: order++ });
  };

  add(thread.created_at, "thread", "thread created", thread.title ?? thread.id);

  for (const run of runs) {
    const identity = runIdentity(run);
    const startDetail = [run.effort && `effort ${run.effort}`, run.session_id && `session ${run.session_id}`]
      .filter(Boolean)
      .join(" · ");
    add(run.started_at, "run-start", `run start · ${identity}`, startDetail);
    if (run.ended_at != null) {
      const cap = run.cap_flagged === 1 ? " · CAP" : "";
      add(run.ended_at, "run-end", `run end · ${identity} · ${run.state}${cap}`, run.error);
    }
  }

  for (const finding of findings) {
    const source = finding.from_role || "unknown role";
    const findingKind = finding.kind && finding.kind !== "finding" ? ` ${finding.kind}` : "";
    add(
      finding.created_at,
      "finding",
      `${source}${findingKind} · ${compact(finding.summary, 220) ?? "(no summary)"}`,
      finding.detail,
    );
  }

  for (const message of messages) {
    if (message.kind !== "system" && message.role !== "user") continue;
    add(
      message.created_at,
      "message",
      `${message.role || "unknown role"} ${message.kind || "message"} · ${compact(message.content, 260) ?? "(empty)"}`,
    );
  }

  const anchors = crashAnchors(thread, runs, findings, messages);
  for (const entry of parseCrashLogEntries(crashText)) {
    if (entry.ts == null || !anchors.some((anchor) => Math.abs(entry.ts - anchor) <= CRASH_CORRELATION_MS)) continue;
    if (!CONTROL_LIFECYCLE.test(entry.label) && !isFaultEntry(entry.label, entry.body)) continue;
    const fault = isFaultEntry(entry.label, entry.body);
    const meaningfulBody = entry.body
      .split(/\r?\n/)
      .find((line) => line && !/^mem\s/.test(line) && !/^active-work:/.test(line));
    add(entry.ts, "server", `server ${fault ? "FAULT" : "lifecycle"} · ${entry.label}`, meaningfulBody);
  }

  return events
    .sort((a, b) => a.at - b.at || a.order - b.order)
    .map(({ order: _order, ...event }) => event);
}

function renderTaskTimeline(events, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const lines = [];
  for (const event of events) {
    lines.push(`${localStamp(event.at, timeZone)} · ${event.summary}`);
    if (event.detail) lines.push(`  ↳ ${event.detail}`);
  }
  return lines;
}

module.exports = {
  collectTaskTimeline,
  localStamp,
  renderTaskTimeline,
  utcStamp,
};
