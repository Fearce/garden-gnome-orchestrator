// Expanding an event series into the dates its occurrences start on. Pure civil-date arithmetic (no
// zone, no clock), so a weekly series lands on the same weekday whatever DST does; the caller attaches
// the wall-clock time and converts to an instant afterwards.

import type { CalendarRecurrence } from "./types.js";
import { addDays, type CivilDate, dayNumber, daysInMonth, fromDayNumber, parseDate, weekday } from "./zoned.js";

export const MAX_INTERVAL = 99;
export const MAX_COUNT = 999;
// A generated date stream is bounded twice: by the caller's horizon and by this, so a malformed
// series (or a daily one started decades ago) can never spin.
const MAX_STEPS = 40_000;

/** Weekdays in the order a week is walked: Monday first (RFC 5545's default WKST). */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

/** The weekday set a weekly series really uses: its own start weekday is always part of it, so the
 *  first occurrence is always the event's start date. */
export function effectiveWeekdays(rule: CalendarRecurrence, start: CivilDate): number[] {
  const set = new Set((rule.weekdays ?? []).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6));
  set.add(weekday(start));
  return WEEK_ORDER.filter((d) => set.has(d));
}

/** The nth (1-5) or last occurrence of a weekday in a month, or null when the month has no such day. */
function weekdayInMonth(y: number, m: number, dow: number, nth: number | "last"): CivilDate | null {
  if (nth === "last") {
    const lastDay = daysInMonth(y, m);
    const last = { y, m, d: lastDay };
    return { y, m, d: lastDay - ((weekday(last) - dow + 7) % 7) };
  }
  const first = { y, m, d: 1 };
  const d = 1 + ((dow - weekday(first) + 7) % 7) + (nth - 1) * 7;
  return d <= daysInMonth(y, m) ? { y, m, d } : null;
}

/** Calls `emit` with each date the series generates, in order, from its start, until `emit` returns
 *  false, the horizon (inclusive day number) passes, or the rule's own until/count ends it. */
function walk(rule: CalendarRecurrence, start: CivilDate, horizon: number, emit: (date: CivilDate) => boolean): void {
  const interval = Math.min(MAX_INTERVAL, Math.max(1, Math.floor(rule.interval || 1)));
  const until = rule.until ? parseDate(rule.until) : null;
  const last = Math.min(horizon, until ? dayNumber(until) : Infinity);
  const maxCount = rule.count ? Math.min(MAX_COUNT, rule.count) : Infinity;
  const startDay = dayNumber(start);
  let produced = 0;
  const take = (date: CivilDate): boolean => {
    const n = dayNumber(date);
    if (n < startDay) return true;
    if (n > last || produced >= maxCount) return false;
    produced++;
    return emit(date);
  };

  for (let step = 0; step < MAX_STEPS; step++) {
    switch (rule.freq) {
      case "daily": {
        if (!take(addDays(start, step * interval))) return;
        break;
      }
      case "weekly": {
        // Weeks are counted from the Monday of the start's week, so "every 2 weeks on Mon+Thu" keeps
        // both days in the same on-week.
        const monday = startDay - ((weekday(start) + 6) % 7) + step * 7 * interval;
        if (monday > last) return;
        for (const dow of effectiveWeekdays(rule, start)) {
          if (!take(fromDayNumber(monday + ((dow + 6) % 7)))) return;
        }
        break;
      }
      case "monthly": {
        const monthIndex = start.y * 12 + (start.m - 1) + step * interval;
        const y = Math.floor(monthIndex / 12);
        const m = (monthIndex % 12) + 1;
        if (dayNumber({ y, m, d: 1 }) > last) return;
        const by = rule.monthlyBy ?? "monthday";
        const date =
          by === "monthday"
            ? start.d <= daysInMonth(y, m)
              ? { y, m, d: start.d }
              : null
            : weekdayInMonth(y, m, weekday(start), by === "lastWeekday" ? "last" : Math.ceil(start.d / 7));
        // A month without the day (the 31st in April, a 5th Tuesday) is skipped, never moved.
        if (date && !take(date)) return;
        break;
      }
      case "yearly": {
        const y = start.y + step * interval;
        if (dayNumber({ y, m: 1, d: 1 }) > last) return;
        if (start.d <= daysInMonth(y, start.m) && !take({ y, m: start.m, d: start.d })) return;
        break;
      }
    }
  }
}

/** Every occurrence start date from the series start up to and including `throughDay`. */
export function occurrenceDates(rule: CalendarRecurrence, start: CivilDate, throughDay: number): CivilDate[] {
  const out: CivilDate[] = [];
  walk(rule, start, throughDay, (d) => {
    out.push(d);
    return true;
  });
  return out;
}

/** Whether a date is one the series generates. */
export function isOccurrence(rule: CalendarRecurrence, start: CivilDate, date: CivilDate): boolean {
  const target = dayNumber(date);
  let found = false;
  walk(rule, start, target, (d) => {
    if (dayNumber(d) === target) found = true;
    return !found;
  });
  return found;
}

/** How many occurrences the series generates strictly before a date — what a split keeps. */
export function countBefore(rule: CalendarRecurrence, start: CivilDate, date: CivilDate): number {
  let n = 0;
  walk(rule, start, dayNumber(date) - 1, () => {
    n++;
    return true;
  });
  return n;
}

/** The last date the series generates, or null when it never ends. */
export function lastOccurrence(rule: CalendarRecurrence, start: CivilDate): CivilDate | null {
  if (!rule.until && !rule.count) return null;
  let last: CivilDate | null = null;
  const horizon = rule.until ? dayNumber(parseDate(rule.until) ?? start) : dayNumber(start) + 366 * 100;
  walk(rule, start, horizon, (d) => {
    last = d;
    return true;
  });
  return last;
}

/** Problems with a rule, for the API to reject before anything is stored. */
export function validateRecurrence(rule: CalendarRecurrence, start: CivilDate): string | null {
  if (!["daily", "weekly", "monthly", "yearly"].includes(rule.freq)) return "Unknown repeat frequency.";
  if (!Number.isInteger(rule.interval) || rule.interval < 1 || rule.interval > MAX_INTERVAL) return `Repeat interval must be 1-${MAX_INTERVAL}.`;
  if (rule.weekdays && rule.weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return "Weekdays must be 0-6.";
  if (rule.monthlyBy && !["monthday", "nthWeekday", "lastWeekday"].includes(rule.monthlyBy)) return "Unknown monthly pattern.";
  if (rule.freq === "monthly" && rule.monthlyBy === "lastWeekday" && start.d + 7 <= daysInMonth(start.y, start.m)) {
    return "The start date is not the last such weekday of its month.";
  }
  if (rule.count != null && (!Number.isInteger(rule.count) || rule.count < 1 || rule.count > MAX_COUNT)) return `Occurrence count must be 1-${MAX_COUNT}.`;
  if (rule.until != null) {
    const until = parseDate(rule.until);
    if (!until) return "The repeat end date is not a valid date.";
    if (dayNumber(until) < dayNumber(start)) return "The repeat end date is before the event starts.";
  }
  if (rule.until != null && rule.count != null) return "A series ends on a date or after a count, not both.";
  return null;
}

/** A rule as stored: defaults filled, irrelevant fields dropped, so equal rules compare equal. */
export function normalizeRecurrence(rule: CalendarRecurrence, start: CivilDate): CalendarRecurrence {
  return {
    freq: rule.freq,
    interval: rule.interval,
    weekdays: rule.freq === "weekly" ? effectiveWeekdays(rule, start) : null,
    monthlyBy: rule.freq === "monthly" ? (rule.monthlyBy ?? "monthday") : null,
    until: rule.until ?? null,
    count: rule.count ?? null,
  };
}

