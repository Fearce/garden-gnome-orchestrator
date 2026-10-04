// An event series turned into concrete instances: the generated dates, minus cancelled occurrences,
// with each moved occurrence at its own time, every one carrying both its wall-clock text and the
// instants it spans in the event's zone.

import { isOccurrence, occurrenceDates } from "./recurrence.js";
import type { CalendarEvent, CalendarException } from "./types.js";
import {
  addDays,
  type CivilDate,
  dayNumber,
  formatDate,
  formatDateTime,
  fromWallMinutes,
  parseDate,
  parseDateTime,
  startOfDay,
  wallMinutes,
  wallToEpoch,
} from "./zoned.js";

export interface EventInstance {
  event: CalendarEvent;
  /** The series date this instance was generated for (the exception key). */
  date: string;
  allDay: boolean;
  /** Effective wall-clock text, as `CalendarEvent.start`/`end` would hold it. */
  start: string;
  end: string;
  title: string;
  notes: string | null;
  /** Instants in the event's zone. All-day: 00:00 of the first day to 00:00 after the last. */
  startAt: number;
  endAt: number;
  edited: boolean;
  /** When the owner last saved this occurrence: the series, or the occurrence on its own if later. */
  savedAt: number;
}

/** The start date of an event's wall-clock start text. */
export function startDateOf(start: string): CivilDate | null {
  return parseDate(start.slice(0, 10));
}

/** An instance's span in its zone, from wall-clock text. Null when the text is malformed. */
export function spanOf(allDay: boolean, start: string, end: string, timeZone: string): { startAt: number; endAt: number } | null {
  if (allDay) {
    const s = parseDate(start);
    const e = parseDate(end);
    return s && e ? { startAt: startOfDay(s, timeZone), endAt: startOfDay(addDays(e, 1), timeZone) } : null;
  }
  const s = parseDateTime(start);
  const e = parseDateTime(end);
  if (!s || !e) return null;
  const startAt = wallToEpoch(s, timeZone);
  // A start in the spring-forward gap moves forward an hour; the end must not fall before it.
  return { startAt, endAt: Math.max(wallToEpoch(e, timeZone), startAt + (wallMinutes(e) - wallMinutes(s)) * 60_000) };
}

/** The wall-clock start/end the series itself gives an occurrence on `date` (before any exception). */
export function seriesTimesOn(event: CalendarEvent, date: CivilDate): { start: string; end: string } {
  if (event.allDay) {
    const s = parseDate(event.start)!;
    const e = parseDate(event.end)!;
    return { start: formatDate(date), end: formatDate(addDays(date, dayNumber(e) - dayNumber(s))) };
  }
  const s = parseDateTime(event.start)!;
  const e = parseDateTime(event.end)!;
  const begin = { ...date, hh: s.hh, mi: s.mi };
  // The duration is kept in WALL minutes, so a 09:00–10:00 meeting is 09:00–10:00 on a DST day too.
  return { start: formatDateTime(begin), end: formatDateTime(fromWallMinutes(wallMinutes(begin) + wallMinutes(e) - wallMinutes(s))) };
}

function build(event: CalendarEvent, date: CivilDate, exception: CalendarException | undefined): EventInstance | null {
  if (exception?.cancelled) return null;
  const series = seriesTimesOn(event, date);
  const moved = !!exception && exception.start != null && exception.end != null;
  const allDay = moved ? (exception!.allDay ?? event.allDay) : event.allDay;
  const start = moved ? exception!.start! : series.start;
  const end = moved ? exception!.end! : series.end;
  const span = spanOf(allDay, start, end, event.timeZone);
  if (!span) return null;
  return {
    event,
    date: formatDate(date),
    allDay,
    start,
    end,
    title: exception?.title ?? event.title,
    notes: exception?.notes ?? event.notes,
    ...span,
    edited: !!exception,
    savedAt: Math.max(event.updatedAt, exception?.updatedAt ?? 0),
  };
}

/**
 * Every instance of an event that overlaps [fromMs, toMs). `fromDay`/`toDay` are the civil-day bounds
 * the caller's window covers in ANY zone (a day of slack either side is plenty), used only to bound the
 * date walk; the instant check decides. With `byDate` (the viewer's exact dates), an all-day instance
 * is matched by its dates instead: it belongs to its dates in every zone, as on a paper calendar.
 */
export function instancesOverlapping(event: CalendarEvent, fromMs: number, toMs: number, fromDay: number, toDay: number, byDate?: { from: number; to: number }): EventInstance[] {
  const start = startDateOf(event.start);
  if (!start) return [];
  const overlaps = (i: EventInstance) =>
    byDate && i.allDay ? dayNumber(parseDate(i.start)!) <= byDate.to && dayNumber(parseDate(i.end)!) >= byDate.from : i.startAt < toMs && i.endAt > fromMs;
  if (!event.recurrence) {
    const only = build(event, start, undefined);
    return only && overlaps(only) ? [only] : [];
  }
  const exceptions = new Map(event.exceptions.map((e) => [e.date, e]));
  const out: EventInstance[] = [];
  // A long event that started before the window still overlaps it: walk back by the series' length.
  const span = spanOf(event.allDay, event.start, event.end, event.timeZone);
  const lengthDays = span ? Math.ceil((span.endAt - span.startAt) / 86_400_000) + 1 : 1;
  for (const date of occurrenceDates(event.recurrence, start, toDay)) {
    if (dayNumber(date) < fromDay - lengthDays) continue;
    const instance = build(event, date, exceptions.get(formatDate(date)));
    if (instance && overlaps(instance)) out.push(instance);
  }
  // An occurrence moved INTO the window from a date the walk above never reached.
  for (const exception of event.exceptions) {
    const date = parseDate(exception.date);
    if (!date || exception.cancelled || exception.start == null) continue;
    const n = dayNumber(date);
    if (n <= toDay && n >= fromDay - lengthDays) continue;
    if (!isOccurrence(event.recurrence, start, date)) continue;
    const instance = build(event, date, exception);
    if (instance && overlaps(instance)) out.push(instance);
  }
  return out.sort((a, b) => a.startAt - b.startAt);
}
