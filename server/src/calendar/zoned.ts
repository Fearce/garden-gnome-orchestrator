// Civil dates and IANA time-zone conversion for the calendar, with no dependency beyond Intl.
//
// A calendar event is stored as WALL-CLOCK text ("2026-10-04T09:00") plus the zone it was entered in,
// because that is what the owner means: a weekly 09:00 meeting stays at 09:00 across a DST change, and
// an all-day date is the same date wherever it is viewed. Only at the edges (a reminder's due instant,
// a range query, placing an occurrence on a grid) is it turned into an epoch, and that conversion is
// this file's job.

export interface CivilDate {
  y: number;
  m: number; // 1-12
  d: number; // 1-31
}

export interface WallTime extends CivilDate {
  hh: number; // 0-23
  mi: number; // 0-59
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const TIME_RE = /^(\d{2}):(\d{2})$/;

const pad2 = (n: number): string => String(n).padStart(2, "0");

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** "2026-10-04" → CivilDate, or null when the text is not a real calendar date. */
export function parseDate(text: string): CivilDate | null {
  const m = DATE_RE.exec(text);
  if (!m) return null;
  const date = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  return date.m >= 1 && date.m <= 12 && date.d >= 1 && date.d <= daysInMonth(date.y, date.m) ? date : null;
}

/** "2026-10-04T09:30" → WallTime, or null when malformed. */
export function parseDateTime(text: string): WallTime | null {
  const m = DATETIME_RE.exec(text);
  if (!m) return null;
  const date = parseDate(`${m[1]}-${m[2]}-${m[3]}`);
  const hh = Number(m[4]);
  const mi = Number(m[5]);
  if (!date || hh > 23 || mi > 59) return null;
  return { ...date, hh, mi };
}

/** "09:30" → minutes after midnight, or null. */
export function parseClock(text: string): number | null {
  const m = TIME_RE.exec(text);
  if (!m) return null;
  const hh = Number(m[1]);
  const mi = Number(m[2]);
  return hh <= 23 && mi <= 59 ? hh * 60 + mi : null;
}

export function formatDate(d: CivilDate): string {
  return `${String(d.y).padStart(4, "0")}-${pad2(d.m)}-${pad2(d.d)}`;
}

export function formatDateTime(w: WallTime): string {
  return `${formatDate(w)}T${pad2(w.hh)}:${pad2(w.mi)}`;
}

/** Whole days since 1970-01-01 for a civil date — the unit every date comparison and step uses, so no
 *  local-time or DST rule can leak into date arithmetic. */
export function dayNumber(d: CivilDate): number {
  return Math.floor(Date.UTC(d.y, d.m - 1, d.d) / 86_400_000);
}

export function fromDayNumber(n: number): CivilDate {
  const t = new Date(n * 86_400_000);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

export function addDays(d: CivilDate, days: number): CivilDate {
  return fromDayNumber(dayNumber(d) + days);
}

/** 0 = Sunday … 6 = Saturday, matching cron and JS. */
export function weekday(d: CivilDate): number {
  return (((dayNumber(d) + 4) % 7) + 7) % 7;
}

/** Minutes since the epoch's civil midnight, for ordering and differencing wall-clock times. */
export function wallMinutes(w: WallTime): number {
  return dayNumber(w) * 1440 + w.hh * 60 + w.mi;
}

export function fromWallMinutes(total: number): WallTime {
  const days = Math.floor(total / 1440);
  const rest = total - days * 1440;
  return { ...fromDayNumber(days), hh: Math.floor(rest / 60), mi: rest % 60 };
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Whether the runtime knows this IANA zone. */
export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone || timeZone.length > 64) return false;
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** The wall clock an instant shows in a zone, to the minute. */
export function epochToWall(ms: number, timeZone: string): WallTime {
  const parts: Record<string, number> = {};
  for (const p of formatterFor(timeZone).formatToParts(new Date(ms))) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  return { y: parts.year!, m: parts.month!, d: parts.day!, hh: parts.hour! % 24, mi: parts.minute! };
}

/** The zone's offset from UTC at an instant, in minutes (Copenhagen summer = +120). */
function offsetMinutes(ms: number, timeZone: string): number {
  const w = epochToWall(ms, timeZone);
  const asUtc = Date.UTC(w.y, w.m - 1, w.d, w.hh, w.mi);
  return Math.round((asUtc - Math.floor(ms / 60_000) * 60_000) / 60_000);
}

/**
 * The instant a wall-clock time names in a zone.
 *
 * Two DST edges have no single answer, and both are resolved the way calendar apps do: a time inside
 * the spring-forward gap (02:30 on the morning clocks jump 02:00→03:00) moves forward by the gap, to
 * 03:30; a time the fall-back repeats (02:30 twice) is the FIRST of the two.
 */
export function wallToEpoch(w: WallTime, timeZone: string): number {
  const naive = Date.UTC(w.y, w.m - 1, w.d, w.hh, w.mi);
  // Two candidate offsets: the zone's offset a day either side of the wall time brackets any DST edge.
  const before = offsetMinutes(naive - 86_400_000, timeZone);
  const after = offsetMinutes(naive + 86_400_000, timeZone);
  const candidates = [...new Set([before, after])]
    .map((off) => naive - off * 60_000)
    .filter((ms) => wallMinutes(epochToWall(ms, timeZone)) === wallMinutes(w))
    .sort((a, b) => a - b);
  if (candidates.length) return candidates[0]!;
  // In the gap: the earlier offset still describes the moment just before the jump, so applying it
  // lands the same number of minutes past the jump as the requested time was past its start.
  return naive - before * 60_000;
}

/** The epoch of 00:00 on a civil date in a zone (a DST jump at midnight resolves per `wallToEpoch`). */
export function startOfDay(d: CivilDate, timeZone: string): number {
  return wallToEpoch({ ...d, hh: 0, mi: 0 }, timeZone);
}

/** The server process's own zone — the one cron schedules fire in. */
export function serverTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}
