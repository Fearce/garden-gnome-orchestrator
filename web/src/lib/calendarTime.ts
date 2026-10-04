// Civil dates and IANA zone conversion for the calendar view. The same rules as the server's
// calendar/zoned.ts (which this mirrors): dates are whole-day numbers so no DST rule leaks into date
// arithmetic, and a wall time is turned into an instant only at the edge, with a spring-forward gap
// moving forward and a repeated fall-back time taking its first instance.

export interface CivilDate {
  y: number;
  m: number; // 1-12
  d: number;
}

export interface WallTime extends CivilDate {
  hh: number;
  mi: number;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

export const daysInMonth = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();

export function parseDate(text: string): CivilDate | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return null;
  const date = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  return date.m >= 1 && date.m <= 12 && date.d >= 1 && date.d <= daysInMonth(date.y, date.m) ? date : null;
}

export function parseDateTime(text: string): WallTime | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(text);
  const date = m ? parseDate(m[1]!) : null;
  if (!m || !date) return null;
  const hh = Number(m[2]);
  const mi = Number(m[3]);
  return hh <= 23 && mi <= 59 ? { ...date, hh, mi } : null;
}

export const formatDate = (d: CivilDate): string => `${String(d.y).padStart(4, "0")}-${pad2(d.m)}-${pad2(d.d)}`;
export const formatClock = (minutes: number): string => `${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`;
export const formatDateTime = (w: WallTime): string => `${formatDate(w)}T${formatClock(w.hh * 60 + w.mi)}`;

export const dayNumber = (d: CivilDate): number => Math.floor(Date.UTC(d.y, d.m - 1, d.d) / 86_400_000);

export function fromDayNumber(n: number): CivilDate {
  const t = new Date(n * 86_400_000);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

export const addDays = (d: CivilDate, days: number): CivilDate => fromDayNumber(dayNumber(d) + days);

/** 0 = Sunday … 6 = Saturday. */
export const weekday = (d: CivilDate): number => (((dayNumber(d) + 4) % 7) + 7) % 7;

export const wallMinutes = (w: WallTime): number => dayNumber(w) * 1440 + w.hh * 60 + w.mi;

export function fromWallMinutes(total: number): WallTime {
  const days = Math.floor(total / 1440);
  const rest = total - days * 1440;
  return { ...fromDayNumber(days), hh: Math.floor(rest / 60), mi: rest % 60 };
}

export function addMonths(d: CivilDate, months: number): CivilDate {
  const index = d.y * 12 + (d.m - 1) + months;
  const y = Math.floor(index / 12);
  const m = (index % 12) + 1;
  return { y, m, d: Math.min(d.d, daysInMonth(y, m)) };
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    formatters.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone) return false;
  try {
    partsFormatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

export function epochToWall(ms: number, timeZone: string): WallTime {
  const p: Record<string, number> = {};
  for (const part of partsFormatter(timeZone).formatToParts(new Date(ms))) if (part.type !== "literal") p[part.type] = Number(part.value);
  return { y: p.year!, m: p.month!, d: p.day!, hh: p.hour! % 24, mi: p.minute! };
}

function offsetMinutes(ms: number, timeZone: string): number {
  const w = epochToWall(ms, timeZone);
  return Math.round((Date.UTC(w.y, w.m - 1, w.d, w.hh, w.mi) - Math.floor(ms / 60_000) * 60_000) / 60_000);
}

export function wallToEpoch(w: WallTime, timeZone: string): number {
  const naive = Date.UTC(w.y, w.m - 1, w.d, w.hh, w.mi);
  const before = offsetMinutes(naive - 86_400_000, timeZone);
  const after = offsetMinutes(naive + 86_400_000, timeZone);
  const fits = [...new Set([before, after])]
    .map((off) => naive - off * 60_000)
    .filter((ms) => wallMinutes(epochToWall(ms, timeZone)) === wallMinutes(w))
    .sort((a, b) => a - b);
  return fits.length ? fits[0]! : naive - before * 60_000;
}

export const startOfDay = (d: CivilDate, timeZone: string): number => wallToEpoch({ ...d, hh: 0, mi: 0 }, timeZone);

export const dateOf = (ms: number, timeZone: string): CivilDate => {
  const w = epochToWall(ms, timeZone);
  return { y: w.y, m: w.m, d: w.d };
};

export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** Every IANA zone this browser knows, for the event form's zone field. */
export function knownTimeZones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  try {
    return intl.supportedValuesOf?.("timeZone") ?? [];
  } catch {
    return [];
  }
}

/** The first day of the week for this browser's locale (0 = Sunday, 1 = Monday), Monday when unknown. */
export function localeWeekStart(): number {
  try {
    const locale = new Intl.Locale(navigator.language) as Intl.Locale & { weekInfo?: { firstDay: number }; getWeekInfo?: () => { firstDay: number } };
    const first = locale.getWeekInfo?.().firstDay ?? locale.weekInfo?.firstDay;
    if (first) return first % 7;
  } catch {
    /* an engine without week info */
  }
  return 1;
}

export type CalendarViewMode = "month" | "week" | "day" | "agenda";

/** Agenda shows this many days from the anchor. */
export const AGENDA_DAYS = 30;

export const startOfWeek = (d: CivilDate, weekStart: number): CivilDate => addDays(d, -((weekday(d) - weekStart + 7) % 7));

/** The dates a view shows for an anchor date, inclusive. A month grid covers whole weeks. */
export function visibleDates(view: CalendarViewMode, anchor: CivilDate, weekStart: number): { from: CivilDate; to: CivilDate } {
  switch (view) {
    case "day":
      return { from: anchor, to: anchor };
    case "week": {
      const from = startOfWeek(anchor, weekStart);
      return { from, to: addDays(from, 6) };
    }
    case "agenda":
      return { from: anchor, to: addDays(anchor, AGENDA_DAYS - 1) };
    case "month": {
      const first = { ...anchor, d: 1 };
      const last = { ...anchor, d: daysInMonth(anchor.y, anchor.m) };
      const from = startOfWeek(first, weekStart);
      return { from, to: addDays(startOfWeek(last, weekStart), 6) };
    }
  }
}

/** The anchor one step back or forward in a view. */
export function stepAnchor(view: CalendarViewMode, anchor: CivilDate, direction: 1 | -1): CivilDate {
  switch (view) {
    case "day":
      return addDays(anchor, direction);
    case "week":
      return addDays(anchor, 7 * direction);
    case "agenda":
      return addDays(anchor, AGENDA_DAYS * direction);
    case "month":
      return addMonths({ ...anchor, d: 1 }, direction);
  }
}

export function rangeDates(from: CivilDate, to: CivilDate): CivilDate[] {
  const out: CivilDate[] = [];
  for (let n = dayNumber(from); n <= dayNumber(to); n++) out.push(fromDayNumber(n));
  return out;
}

/** "October 2026", "5 – 11 Oct 2026", "Monday 5 October 2026" — the toolbar's heading for a view. */
export function viewTitle(view: CalendarViewMode, anchor: CivilDate, weekStart: number): string {
  const fmt = (d: CivilDate, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(undefined, { ...o, timeZone: "UTC" }).format(Date.UTC(d.y, d.m - 1, d.d));
  if (view === "month") return fmt(anchor, { month: "long", year: "numeric" });
  if (view === "day") return fmt(anchor, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const { from, to } = visibleDates(view, anchor, weekStart);
  const sameYear = from.y === to.y;
  const sameMonth = sameYear && from.m === to.m;
  const start = fmt(from, sameMonth ? { day: "numeric" } : sameYear ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" });
  return `${start} – ${fmt(to, { day: "numeric", month: "short", year: "numeric" })}`;
}

/** A civil date in words, without any zone shifting it. */
export function formatCivil(d: CivilDate, o: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(undefined, { ...o, timeZone: "UTC" }).format(Date.UTC(d.y, d.m - 1, d.d));
}

export function formatTime(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", timeZone }).format(ms);
}

/** The zone's short name at an instant ("CEST", "GMT+2"), for labelling times. */
export function zoneAbbreviation(ms: number, timeZone: string): string {
  const part = new Intl.DateTimeFormat(undefined, { timeZone, timeZoneName: "short" }).formatToParts(ms).find((p) => p.type === "timeZoneName");
  return part?.value ?? timeZone;
}
