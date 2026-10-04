// The arithmetic behind editing from the grid: an occurrence's own times, what an edit made on one
// occurrence means for the whole series, where a drag lands, and the plain repeat choices a reminder
// form offers turned into (and read back from) the scheduler's cron.

import type { CalendarDefaults, CalendarEvent, CalendarEventInput, CalendarReminder } from "./calendarApi.js";
import {
  type CivilDate,
  type WallTime,
  addDays,
  dayNumber,
  epochToWall,
  formatDate,
  formatDateTime,
  fromWallMinutes,
  parseDate,
  parseDateTime,
  wallMinutes,
  wallToEpoch,
  weekday,
} from "./calendarTime.js";

export interface Span {
  allDay: boolean;
  start: string;
  end: string;
}

/** The span the series itself gives the occurrence on `date` (server: instances.seriesTimesOn). */
export function seriesSpanOn(event: CalendarEvent, date: CivilDate): Span {
  if (event.allDay) {
    const length = dayNumber(parseDate(event.end)!) - dayNumber(parseDate(event.start)!);
    return { allDay: true, start: formatDate(date), end: formatDate(addDays(date, length)) };
  }
  const s = parseDateTime(event.start)!;
  const e = parseDateTime(event.end)!;
  const begin: WallTime = { ...date, hh: s.hh, mi: s.mi };
  return { allDay: false, start: formatDateTime(begin), end: formatDateTime(fromWallMinutes(wallMinutes(begin) + wallMinutes(e) - wallMinutes(s))) };
}

/** An occurrence's current span: its own moved times when it was edited, else the series'. */
export function occurrenceSpan(event: CalendarEvent, occurrenceDate: string | undefined): Span {
  if (!event.recurrence || !occurrenceDate) return { allDay: event.allDay, start: event.start, end: event.end };
  const exception = event.exceptions.find((x) => x.date === occurrenceDate);
  if (exception?.start && exception.end) return { allDay: exception.allDay ?? event.allDay, start: exception.start, end: exception.end };
  return seriesSpanOn(event, parseDate(occurrenceDate)!);
}

const dateOfSpan = (text: string): CivilDate => parseDate(text.slice(0, 10))!;

/**
 * An edit made while looking at one occurrence, applied to the whole series: the series start moves by
 * the same number of days the occurrence moved, and takes the new time of day and length. So dragging
 * Wednesday's 09:00 standup to 10:00 with "all events" makes every standup 10:00, still on Wednesdays.
 */
export function seriesSpanFromOccurrenceEdit(event: CalendarEvent, before: Span, after: Span): Span {
  const dayShift = dayNumber(dateOfSpan(after.start)) - dayNumber(dateOfSpan(before.start));
  const seriesStart = addDays(dateOfSpan(event.start), dayShift);
  if (after.allDay) {
    const length = dayNumber(dateOfSpan(after.end)) - dayNumber(dateOfSpan(after.start));
    return { allDay: true, start: formatDate(seriesStart), end: formatDate(addDays(seriesStart, length)) };
  }
  const s = parseDateTime(after.start)!;
  const e = parseDateTime(after.end)!;
  const begin: WallTime = { ...seriesStart, hh: s.hh, mi: s.mi };
  return { allDay: false, start: formatDateTime(begin), end: formatDateTime(fromWallMinutes(wallMinutes(begin) + wallMinutes(e) - wallMinutes(s))) };
}

/**
 * Where a span lands when dragged. To a date (a month cell, the all-day row): same time of day, or the
 * same days for an all-day item, moved by the days between the cell it was shown on (`shownOn`, which
 * for a timed item seen from another zone is not its own date) and the drop cell. To an instant (a time
 * slot): starting then, in the event's own zone, keeping its length; an all-day item dropped on a time
 * becomes a one-hour timed one.
 */
export function movedSpan(span: Span, eventZone: string, target: { date: CivilDate } | { at: number }, shownOn?: CivilDate): Span {
  if ("date" in target) {
    const from = dateOfSpan(span.start);
    const shift = dayNumber(target.date) - dayNumber(shownOn ?? from);
    if (span.allDay) return { allDay: true, start: formatDate(addDays(from, shift)), end: formatDate(addDays(dateOfSpan(span.end), shift)) };
    const s = parseDateTime(span.start)!;
    const e = parseDateTime(span.end)!;
    return { allDay: false, start: formatDateTime(fromWallMinutes(wallMinutes(s) + shift * 1440)), end: formatDateTime(fromWallMinutes(wallMinutes(e) + shift * 1440)) };
  }
  const begin = epochToWall(target.at, eventZone);
  const length = span.allDay ? 60 : Math.max(15, wallMinutes(parseDateTime(span.end)!) - wallMinutes(parseDateTime(span.start)!));
  return { allDay: false, start: formatDateTime(begin), end: formatDateTime(fromWallMinutes(wallMinutes(begin) + length)) };
}

/** A new event's starting values for a clicked date (all-day) or time slot (one hour), with the owner's
 *  default reminders. */
export function draftEvent(date: CivilDate, minutes: number | null, timeZone: string, defaults: CalendarDefaults): CalendarEventInput {
  if (minutes == null) {
    return { title: "", notes: null, allDay: true, start: formatDate(date), end: formatDate(date), timeZone, recurrence: null, reminders: defaultReminders(defaults, true) };
  }
  const begin: WallTime = { ...date, hh: Math.floor(minutes / 60), mi: minutes % 60 };
  const end = formatDateTime(fromWallMinutes(wallMinutes(begin) + 60));
  return { title: "", notes: null, allDay: false, start: formatDateTime(begin), end, timeZone, recurrence: null, reminders: defaultReminders(defaults, false) };
}

export const MAX_REMINDERS = 5;
export const MAX_REMINDER_DAYS = 28;

/** The reminders the defaults give an event: whole days before, at the default time, when all-day.
 *  Mirrors the server's defaultReminders. */
export function defaultReminders(d: CalendarDefaults, allDay: boolean): CalendarReminder[] {
  return tidyReminders(
    d.reminderLeads.map((minutes): CalendarReminder =>
      allDay ? { kind: "day", daysBefore: Math.min(MAX_REMINDER_DAYS, Math.floor(minutes / 1440)), time: d.allDayTime } : { kind: "before", minutes },
    ),
  );
}

/** The same reminders after the all-day switch flips: a lead becomes whole days before, and back. */
export function remindersForAllDay(list: CalendarReminder[], allDay: boolean, allDayTime: string): CalendarReminder[] {
  return tidyReminders(
    list.map((r): CalendarReminder => {
      if (allDay) return r.kind === "day" ? r : { kind: "day", daysBefore: Math.min(MAX_REMINDER_DAYS, Math.floor(r.minutes / 1440)), time: allDayTime };
      return r.kind === "before" ? r : { kind: "before", minutes: r.daysBefore * 1440 };
    }),
  );
}

/** Each reminder once, longest lead first, as the server stores them. */
export function tidyReminders(list: CalendarReminder[]): CalendarReminder[] {
  const unique = new Map(list.map((r) => [JSON.stringify(r), r]));
  return [...unique.values()].sort((a, b) => leadMinutes(b) - leadMinutes(a));
}

function leadMinutes(r: CalendarReminder): number {
  if (r.kind === "before") return r.minutes;
  const [hh, mi] = r.time.split(":").map(Number);
  return r.daysBefore * 1440 - ((hh ?? 0) * 60 + (mi ?? 0));
}

// ---- reminders (scheduler entries with no prompt) ----

export type ReminderRepeat = "none" | "daily" | "weekdays" | "weekly" | "monthly" | "yearly";

/** The cron that fires at `at` (seen on the server's clock) with the chosen repeat. */
export function reminderCron(repeat: ReminderRepeat, at: number, serverZone: string): string {
  const w = epochToWall(at, serverZone);
  const time = `${w.mi} ${w.hh}`;
  switch (repeat) {
    case "none":
    case "yearly":
      return `${time} ${w.d} ${w.m} *`;
    case "daily":
      return `${time} * * *`;
    case "weekdays":
      return `${time} * * 1-5`;
    case "weekly":
      return `${time} * * ${weekday(w)}`;
    case "monthly":
      return `${time} ${w.d} * *`;
  }
}

/** A reminder schedule read back into the plain form, or null when its cron is beyond the plain repeat
 *  choices (it then opens in the full schedule editor). */
export function reminderRepeatOf(cron: string, runOnce: boolean): ReminderRepeat | null {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5 || !/^\d+$/.test(f[0]!) || !/^\d+$/.test(f[1]!)) return null;
  const [, , dom, mon, dow] = f as [string, string, string, string, string];
  const n = (x: string) => /^\d+$/.test(x);
  if (n(dom) && n(mon) && dow === "*") return runOnce ? "none" : "yearly";
  if (runOnce) return null;
  if (dom === "*" && mon === "*" && dow === "*") return "daily";
  if (dom === "*" && mon === "*" && dow === "1-5") return "weekdays";
  if (dom === "*" && mon === "*" && /^[0-7]$/.test(dow)) return "weekly";
  if (n(dom) && mon === "*" && dow === "*") return "monthly";
  return null;
}

/** The instant a date + time in the viewer's zone names. */
export const instantOf = (date: string, time: string, timeZone: string): number | null => {
  const w = parseDateTime(`${date}T${time}`);
  return w ? wallToEpoch(w, timeZone) : null;
};
