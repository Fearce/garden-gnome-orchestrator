import type { CodexUsageDTO } from "../agents/codexUsage.js";
import type { GrokUsageDTO } from "../agents/grokUsage.js";
import type { ZaiUsageDTO } from "../agents/zaiUsage.js";
import { dedicatedPools } from "../agents/codexPools.js";
import type { AccountDTO } from "../ws/protocol.js";

/**
 * "When does the next token shift happen?", i.e. the next moment a usage window rolls over and hands
 * capacity back. Answered from the readings the console already publishes to its account chips.
 *
 * Everything here is a pure function of a snapshot plus `now`: no clock, no DB, no provider call.
 * That is what makes the director's `next_token_shift` tool incapable of mutating anything, and what
 * makes both the arithmetic and the exact wording the owner reads back unit-testable.
 *
 * Three rules the report keeps, each of them a way of being wrong that a naive "soonest reset" answer
 * would hit:
 *  - A reset already in the PAST has rolled over. That is capacity you HAVE, never a pending shift.
 *  - A disabled subscription or backend is named under "not counted", not silently dropped: its window
 *    still rolls over on schedule, it just frees nothing routable, and the difference matters to the
 *    person asking.
 *  - A timestamp is rendered with weekday, date, IANA zone AND numeric offset. A bare clock time is
 *    the answer that gets misread a timezone later.
 */

/** How long the window that is about to roll over runs for. Null when the backend states none. */
const FIVE_HOUR = "5 hours";
const SEVEN_DAY = "7 days";

/** One usage window that will roll over at a known instant, normalized across every backend. */
export interface TokenShift {
  /** The metered pool, as the owner would name it: "Claude · default", "Codex (plus)", "z.ai (pro)". */
  pool: string;
  /** Which window of that pool: "5h session window", "weekly window", "usage cap latch". */
  window: string;
  /** The window's length, when the backend states one. */
  durationLabel: string | null;
  /** Used-percent 0-100 of that window at the time of the reading, or null when never read. */
  usedPct: number | null;
  resetAt: number; // epoch ms
  /** Server-local and explicit: "Thu 2026-09-10 18:50:00 Europe/Copenhagen (UTC+02:00)". */
  resetAtLocal: string;
  msUntil: number;
  /** "in 2h 14m" / "in 3d 4h" / "in under a minute". */
  inLabel: string;
  /** The reading behind this window is old, so the percentage should not be trusted. */
  stale: boolean;
  /** Anything that changes how the row should be read (idle window, estimated reset, model fallback). */
  note: string | null;
}

/** A pool/window deliberately left out of the answer, with the reason. Never a silent omission. */
export interface UncountedWindow {
  subject: string;
  reason: string;
}

export interface TokenShiftReport {
  now: number;
  nowLocal: string;
  /** The soonest counted shift, or null when nothing tracked has a future reset. */
  next: TokenShift | null;
  /** Every counted shift, soonest first. */
  shifts: TokenShift[];
  notCounted: UncountedWindow[];
}

/** The live readings the report is computed from: exactly what `buildHello` sends the account chips. */
export interface TokenShiftSnapshot {
  /** Every configured Claude subscription; each carries its own operator enable flag. */
  accounts: AccountDTO[];
  codex: { usage: CodexUsageDTO | null; enabled: boolean };
  grok: { usage: GrokUsageDTO | null; enabled: boolean };
  zai: { usage: ZaiUsageDTO | null; enabled: boolean };
  /**
   * IANA zone to render timestamps in. Omitted in production so the server's own zone is used, since
   * "server-local" is the whole point. Tests pin it so the expected wording is deterministic anywhere.
   */
  timeZone?: string;
}

/**
 * Server-local and unambiguous: weekday, ISO-style date, 24h clock, the IANA zone name and the numeric
 * UTC offset. The offset is what survives being quoted back in a chat message hours later.
 */
export function formatLocalInstant(epochMs: number, timeZone?: string): string {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    ...(timeZone ? { timeZone } : {}),
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  });
  const parts = new Map(fmt.formatToParts(new Date(epochMs)).map((p) => [p.type, p.value]));
  const zone = timeZone ?? fmt.resolvedOptions().timeZone;
  // "longOffset" renders as GMT+02:00, or a bare GMT exactly at UTC. Normalize both to UTC(+|-)HH:MM.
  const raw = parts.get("timeZoneName") ?? "GMT";
  const offset = raw === "GMT" ? "UTC+00:00" : raw.replace("GMT", "UTC");
  return `${parts.get("weekday")} ${parts.get("year")}-${parts.get("month")}-${parts.get("day")} ${parts.get("hour")}:${parts.get("minute")}:${parts.get("second")} ${zone} (${offset})`;
}

/** "in 2h 14m", at the resolution that is actually useful at that distance. */
export function formatDistance(ms: number): string {
  if (ms < 60_000) return "in under a minute";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    const rem = minutes % 60;
    return rem ? `in ${hours}h ${rem}m` : `in ${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const rem = hours % 24;
  return rem ? `in ${days}d ${rem}h` : `in ${days}d`;
}

interface Candidate {
  pool: string;
  window: string;
  durationLabel?: string | null;
  usedPct?: number | null;
  /** Optional as well as nullable: several DTO reset fields are themselves optional. */
  resetAt: number | null | undefined;
  stale?: boolean;
  note?: string | null;
}

/**
 * Collects the counted shifts and the reasons for everything left out. A candidate with no reset
 * timestamp is not evidence of anything, so it is dropped silently; only a window that HAS a
 * timestamp and is still excluded owes the caller a reason.
 */
class ShiftCollector {
  readonly shifts: TokenShift[] = [];
  readonly notCounted: UncountedWindow[] = [];

  constructor(private readonly now: number, private readonly timeZone?: string) {}

  add(c: Candidate): void {
    if (c.resetAt == null) return;
    const msUntil = c.resetAt - this.now;
    if (msUntil <= 0) {
      // Rolled over already: this is capacity in hand, and calling it a pending shift would be a lie.
      this.notCounted.push({
        subject: `${c.pool} · ${c.window}`,
        reason: `already rolled over at ${formatLocalInstant(c.resetAt, this.timeZone)}; that capacity is available now`,
      });
      return;
    }
    this.shifts.push({
      pool: c.pool,
      window: c.window,
      durationLabel: c.durationLabel ?? null,
      usedPct: c.usedPct ?? null,
      resetAt: c.resetAt,
      resetAtLocal: formatLocalInstant(c.resetAt, this.timeZone),
      msUntil,
      inLabel: formatDistance(msUntil),
      stale: c.stale === true,
      note: c.note ?? null,
    });
  }

  skip(subject: string, reason: string): void {
    this.notCounted.push({ subject, reason });
  }
}

function addClaudeAccount(collect: ShiftCollector, a: AccountDTO): void {
  const pool = `Claude · ${a.label}`;
  if (!a.enabled) {
    collect.skip(pool, "subscription disabled in Settings, so its windows still roll over but free nothing routable");
    return;
  }
  collect.add({
    pool,
    window: "5h session window",
    durationLabel: FIVE_HOUR,
    usedPct: a.fiveHour,
    resetAt: a.fiveHourReset,
    stale: a.stale,
  });
  // No live 5h window, but the stagger has already picked when the next one opens: a real future shift.
  if (a.fiveHourReset == null && a.holdUntil != null) {
    collect.add({
      pool,
      window: "5h session window",
      durationLabel: FIVE_HOUR,
      usedPct: a.fiveHour,
      resetAt: a.holdUntil,
      stale: a.stale,
      note: "window is idle, so this is the stagger slot the next one opens at rather than a reset",
    });
  }
  collect.add({
    pool,
    window: "weekly window",
    durationLabel: SEVEN_DAY,
    usedPct: a.sevenDay,
    resetAt: a.sevenDayReset,
    stale: a.stale,
  });
  if (a.rateLimited) {
    collect.add({
      pool,
      window: "usage cap latch",
      usedPct: null,
      resetAt: a.resetsAt ?? null,
      note: "a live run was rejected, so dispatch avoids this subscription until the latch clears",
    });
  }
  for (const limit of a.modelLimits ?? []) {
    collect.add({
      pool,
      window: `${limit.model} pool cap`,
      usedPct: null,
      resetAt: limit.resetsAt,
      note: `dispatch resolves ${limit.fallback} in its place until then; the normal windows are unaffected`,
    });
  }
}

function addCodex(collect: ShiftCollector, usage: CodexUsageDTO | null, enabled: boolean): void {
  if (!enabled) {
    collect.skip("Codex", "backend disabled in Settings");
    return;
  }
  if (!usage) {
    collect.skip("Codex", "enabled, but there is no usage reading yet, so no window to report");
    return;
  }
  const pool = usage.planType ? `Codex (${usage.planType})` : "Codex";
  collect.add({
    pool,
    window: "5h window (general pool)",
    durationLabel: FIVE_HOUR,
    usedPct: usage.fiveHour,
    resetAt: usage.fiveHourReset,
    note: usage.fiveHourResetEstimated ? "reset is ESTIMATED from the latest real turn, because Codex omitted the window" : null,
  });
  if (usage.fiveHourReset == null && usage.wakeAt != null) {
    collect.add({
      pool,
      window: "5h window (general pool)",
      durationLabel: FIVE_HOUR,
      usedPct: usage.fiveHour,
      resetAt: usage.wakeAt,
      note: "window is idle, so this is the stagger slot a wake turn opens the next one at",
    });
  }
  collect.add({
    pool,
    window: "weekly window (general pool)",
    durationLabel: SEVEN_DAY,
    usedPct: usage.sevenDay,
    resetAt: usage.sevenDayReset,
  });
  // A dedicated pool has its own windows, resets and caps. Reading the general pool as the whole plan
  // is exactly the mistake codexPools.ts exists to prevent, so report each one on its own.
  for (const dedicated of dedicatedPools(usage.pools ?? [])) {
    const name = dedicated.limitName ?? dedicated.modelSlug ?? dedicated.limitId;
    collect.add({ pool, window: `5h window (${name} pool)`, durationLabel: FIVE_HOUR, usedPct: dedicated.fiveHour, resetAt: dedicated.fiveHourReset });
    collect.add({ pool, window: `weekly window (${name} pool)`, durationLabel: SEVEN_DAY, usedPct: dedicated.sevenDay, resetAt: dedicated.sevenDayReset });
  }
}

function addGrok(collect: ShiftCollector, usage: GrokUsageDTO | null, enabled: boolean): void {
  if (!enabled) {
    collect.skip("Grok", "backend disabled in Settings");
    return;
  }
  if (!usage) {
    collect.skip("Grok", "enabled, but there is no usage reading yet, so no window to report");
    return;
  }
  const pool = usage.plan ? `Grok (${usage.plan})` : "Grok";
  collect.add({ pool, window: "weekly window", durationLabel: SEVEN_DAY, usedPct: usage.sevenDay, resetAt: usage.sevenDayReset, stale: usage.stale });
  collect.add({
    pool,
    window: "monthly credits",
    usedPct: usage.monthlyLimit ? Math.round((100 * (usage.monthlyUsed ?? 0)) / usage.monthlyLimit) : null,
    resetAt: usage.monthlyReset,
    stale: usage.stale,
    note: "routing refuses Grok on a dry credit pool even when the weekly window has room",
  });
  if (usage.capUntil != null) {
    collect.add({ pool, window: "usage cap latch", usedPct: null, resetAt: usage.capUntil, note: "a live run was rejected, so dispatch avoids Grok until the latch clears" });
  }
}

function addZai(collect: ShiftCollector, usage: ZaiUsageDTO | null, enabled: boolean): void {
  if (!enabled) {
    collect.skip("z.ai", "backend disabled in Settings");
    return;
  }
  if (!usage?.configured) {
    collect.skip("z.ai", "enabled, but there is no API key / usage reading yet, so no window to report");
    return;
  }
  const pool = usage.plan ? `z.ai (${usage.plan})` : "z.ai";
  collect.add({ pool, window: "5h window", durationLabel: FIVE_HOUR, usedPct: usage.fiveHour, resetAt: usage.fiveHourReset, stale: usage.stale });
  collect.add({ pool, window: "weekly window", durationLabel: SEVEN_DAY, usedPct: usage.sevenDay, resetAt: usage.sevenDayReset, stale: usage.stale });
  if (usage.capUntil != null) {
    collect.add({ pool, window: "usage cap latch", usedPct: null, resetAt: usage.capUntil, note: "a live run was rejected, so dispatch avoids z.ai until the latch clears" });
  }
}

/** The whole report, as a pure function of the snapshot and the instant it is asked about. */
export function tokenShiftReport(snapshot: TokenShiftSnapshot, now: number): TokenShiftReport {
  const collect = new ShiftCollector(now, snapshot.timeZone);
  for (const account of snapshot.accounts) addClaudeAccount(collect, account);
  addCodex(collect, snapshot.codex.usage, snapshot.codex.enabled);
  addGrok(collect, snapshot.grok.usage, snapshot.grok.enabled);
  addZai(collect, snapshot.zai.usage, snapshot.zai.enabled);
  // A stable sort keeps collection order for equal instants, which is Claude subs before the failover
  // backends: the order the owner reasons about capacity in.
  const shifts = [...collect.shifts].sort((a, b) => a.resetAt - b.resetAt);
  return {
    now,
    nowLocal: formatLocalInstant(now, snapshot.timeZone),
    next: shifts[0] ?? null,
    shifts,
    notCounted: collect.notCounted,
  };
}

/** How many upcoming shifts the compact answer lists after the headline one. */
const COMPACT_LIMIT = 4;

function shiftLine(s: TokenShift): string {
  const parts = [`${s.pool} · ${s.window}`];
  if (s.durationLabel) parts.push(`(${s.durationLabel})`);
  parts.push(`resets ${s.resetAtLocal}, ${s.inLabel}`);
  if (s.usedPct != null) parts.push(`· ${s.usedPct}% used${s.stale ? " (stale reading)" : ""}`);
  else if (s.stale) parts.push("· stale reading");
  if (s.note) parts.push(`· ${s.note}`);
  return `- ${parts.join(" ")}`;
}

/**
 * The text the director reads back. `all` switches from the headline plus the next few windows to
 * every tracked window and every reason something was left out.
 */
export function formatTokenShift(report: TokenShiftReport, all: boolean): string {
  const lines: string[] = [`Now: ${report.nowLocal}`];
  if (!report.next) {
    lines.push("No usage window has a known future reset, so there is no token shift to report.");
  } else {
    lines.push(`Next token shift ${report.next.inLabel}: ${report.next.pool} · ${report.next.window} resets ${report.next.resetAtLocal}.`);
    const rest = all ? report.shifts.slice(1) : report.shifts.slice(1, 1 + COMPACT_LIMIT);
    if (rest.length) {
      lines.push("", all ? "All tracked windows after it:" : "Then:");
      lines.push(...rest.map(shiftLine));
      const hidden = report.shifts.length - 1 - rest.length;
      if (hidden > 0) lines.push(`(${hidden} further window${hidden === 1 ? "" : "s"} tracked. Call again with all=true for the full list.)`);
    }
  }
  if (report.notCounted.length) {
    const shown = all ? report.notCounted : report.notCounted.slice(0, COMPACT_LIMIT);
    lines.push("", "Not counted:");
    lines.push(...shown.map((n) => `- ${n.subject}: ${n.reason}`));
    const hidden = report.notCounted.length - shown.length;
    if (hidden > 0) lines.push(`(${hidden} more. Call again with all=true.)`);
  }
  return lines.join("\n");
}
