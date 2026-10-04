// Input checks for calendar writes. Everything the API stores passes through `sanitizeEvent`, so a row
// in calendar_events is always well-formed and every reader can trust its text.

import { normalizeRecurrence, validateRecurrence } from "./recurrence.js";
import type { StoredEventFields } from "./store.js";
import type { CalendarDefaults, CalendarEventInput, CalendarReminder } from "./types.js";
import { dayNumber, isValidTimeZone, parseClock, parseDate, parseDateTime, wallMinutes, wallToEpoch } from "./zoned.js";

export const TITLE_MAX = 200;
export const NOTES_MAX = 4000;
const MAX_ALL_DAY_SPAN_DAYS = 366;
const MAX_TIMED_SPAN_MINUTES = 31 * 1440;
export const MAX_REMINDER_MINUTES = 4 * 7 * 1440;
export const MAX_REMINDER_DAYS = 28;
export const MAX_REMINDERS = 5;
export const NO_DEFAULTS: CalendarDefaults = { reminderLeads: [], allDayTime: "09:00" };

export function validateReminder(reminder: CalendarReminder): string | null {
  if (reminder.kind === "before") {
    return Number.isInteger(reminder.minutes) && reminder.minutes >= 0 && reminder.minutes <= MAX_REMINDER_MINUTES
      ? null
      : `A reminder can be 0 to ${MAX_REMINDER_MINUTES / 1440} days before the start.`;
  }
  if (reminder.kind === "day") {
    if (!Number.isInteger(reminder.daysBefore) || reminder.daysBefore < 0 || reminder.daysBefore > MAX_REMINDER_DAYS) {
      return `A reminder can be 0 to ${MAX_REMINDER_DAYS} days before the event.`;
    }
    return parseClock(reminder.time) == null ? "The reminder time must be HH:MM." : null;
  }
  return "Unknown reminder kind.";
}

/** Problems with an instance's start/end text, or null. Shared by series and single-occurrence edits. */
export function validateSpan(allDay: boolean, start: string, end: string, timeZone: string): string | null {
  if (allDay) {
    const s = parseDate(start);
    const e = parseDate(end);
    if (!s || !e) return "All-day dates must be YYYY-MM-DD.";
    if (dayNumber(e) < dayNumber(s)) return "The event ends before it starts.";
    if (dayNumber(e) - dayNumber(s) >= MAX_ALL_DAY_SPAN_DAYS) return "An event can span at most a year.";
    return null;
  }
  const s = parseDateTime(start);
  const e = parseDateTime(end);
  if (!s || !e) return "Start and end must be YYYY-MM-DDTHH:MM.";
  // Wall minutes, not instants: a start in a spring-forward gap is moved forward when it is read (spanOf).
  // Equal times represent a start-only event with an unspecified end.
  if (wallMinutes(e) < wallMinutes(s)) return "The event ends before it starts.";
  if (wallMinutes(e) - wallMinutes(s) > MAX_TIMED_SPAN_MINUTES) return "A timed event can last at most 31 days.";
  return null;
}

/** Trim and validate a full event; returns the fields to store, or the first problem found. */
export function sanitizeEvent(input: CalendarEventInput): StoredEventFields | string {
  const title = input.title.trim().slice(0, TITLE_MAX);
  if (!title) return "A title is required.";
  const notes = input.notes?.trim() ? input.notes.trim().slice(0, NOTES_MAX) : null;
  if (!isValidTimeZone(input.timeZone)) return "Unknown time zone.";
  const spanError = validateSpan(input.allDay, input.start, input.end, input.timeZone);
  if (spanError) return spanError;
  const startDate = parseDate(input.start.slice(0, 10))!;
  let recurrence = input.recurrence ?? null;
  if (recurrence) {
    const error = validateRecurrence(recurrence, startDate);
    if (error) return error;
    recurrence = normalizeRecurrence(recurrence, startDate);
  }
  const reminders = input.reminders ?? [];
  if (reminders.length > MAX_REMINDERS) return `An event can have at most ${MAX_REMINDERS} reminders.`;
  for (const reminder of reminders) {
    const error = validateReminder(reminder);
    if (error) return error;
  }
  return {
    title,
    notes,
    allDay: input.allDay,
    start: input.start,
    end: input.end,
    timeZone: input.timeZone,
    recurrence,
    reminders: tidyReminders(reminders),
  };
}

/** Problems with the owner's default reminders, or null. */
export function validateDefaults(d: CalendarDefaults): string | null {
  if (d.reminderLeads.length > MAX_REMINDERS) return `At most ${MAX_REMINDERS} default reminders.`;
  if (!d.reminderLeads.every((m) => Number.isInteger(m) && m >= 0 && m <= MAX_REMINDER_MINUTES)) {
    return `A default reminder can be 0 to ${MAX_REMINDER_MINUTES / 1440} days before.`;
  }
  return parseClock(d.allDayTime) == null ? "The all-day reminder time must be HH:MM." : null;
}

/** Defaults as stored: each lead once, longest first. */
export function normalizeDefaults(d: CalendarDefaults): CalendarDefaults {
  return { reminderLeads: [...new Set(d.reminderLeads)].sort((a, b) => b - a), allDayTime: d.allDayTime };
}

/** The reminders a new event starts with, from the defaults: whole days before for an all-day event. */
export function defaultReminders(d: CalendarDefaults, allDay: boolean): CalendarReminder[] {
  return tidyReminders(
    d.reminderLeads.map((minutes) => (allDay ? { kind: "day", daysBefore: Math.min(MAX_REMINDER_DAYS, Math.floor(minutes / 1440)), time: d.allDayTime } : { kind: "before", minutes })),
  );
}

/** Each reminder once, longest lead first. */
function tidyReminders(list: CalendarReminder[]): CalendarReminder[] {
  const unique = new Map(list.map((r) => [JSON.stringify(normalizeReminder(r)), normalizeReminder(r)]));
  return [...unique.values()].sort((a, b) => leadMinutes(b) - leadMinutes(a));
}

function leadMinutes(r: CalendarReminder): number {
  return r.kind === "before" ? r.minutes : r.daysBefore * 1440 - (parseClock(r.time) ?? 0);
}

function normalizeReminder(r: CalendarReminder): CalendarReminder {
  return r.kind === "before" ? { kind: "before", minutes: r.minutes } : { kind: "day", daysBefore: r.daysBefore, time: r.time };
}
