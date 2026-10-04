// Placing calendar occurrences on days and time grids, filtering them, and describing their repeat
// and reminder rules in words. Pure functions over the range the server returned.

import type { CalendarItemKind, CalendarOccurrence, CalendarRecurrence, CalendarReminder } from "./calendarApi.js";
import { type CivilDate, addDays, dayNumber, epochToWall, formatCivil, formatDate, parseDate, startOfDay, weekday } from "./calendarTime.js";

export type EnabledFilter = "all" | "active" | "inactive";

export interface CalendarFilters {
  kinds: Record<CalendarItemKind, boolean>;
  enabled: EnabledFilter;
  query: string;
}

export const DEFAULT_FILTERS: CalendarFilters = { kinds: { event: true, reminder: true, task: true }, enabled: "all", query: "" };

/** A paused schedule's slots and a skipped run are "inactive": they will not fire. */
export const isInactive = (o: CalendarOccurrence): boolean => o.status === "paused" || o.status === "skipped";

export function applyFilters(list: readonly CalendarOccurrence[], f: CalendarFilters): CalendarOccurrence[] {
  const q = f.query.trim().toLowerCase();
  return list.filter(
    (o) => f.kinds[o.kind] && (f.enabled === "all" || (f.enabled === "inactive") === isInactive(o)) && (!q || o.title.toLowerCase().includes(q)),
  );
}

/** Whether an occurrence touches a date in the viewer's zone. A zero-length schedule fire counts on
 *  the day it fires; an all-day item on each of its dates. */
export function onDate(o: CalendarOccurrence, date: CivilDate, timeZone: string): boolean {
  if (o.allDay && o.startDate && o.endDate) {
    const n = dayNumber(date);
    return n >= dayNumber(parseDate(o.startDate)!) && n <= dayNumber(parseDate(o.endDate)!);
  }
  const from = startOfDay(date, timeZone);
  const to = startOfDay(addDays(date, 1), timeZone);
  return o.endAt > o.startAt ? o.startAt < to && o.endAt > from : o.startAt >= from && o.startAt < to;
}

export function itemsOn(list: readonly CalendarOccurrence[], date: CivilDate, timeZone: string): { allDay: CalendarOccurrence[]; timed: CalendarOccurrence[] } {
  const allDay: CalendarOccurrence[] = [];
  const timed: CalendarOccurrence[] = [];
  for (const o of list) {
    if (!onDate(o, date, timeZone)) continue;
    (o.allDay ? allDay : timed).push(o);
  }
  return { allDay, timed };
}

/**
 * A month cell's items in the order it lists them: all-day items, then timed events and reminders,
 * then scheduled-task runs, each group in time order. A cell shows only a few items, and a dozen daily
 * automation runs must not fold the owner's own happenings into "+N more".
 */
export function monthCellItems(list: readonly CalendarOccurrence[], date: CivilDate, timeZone: string): CalendarOccurrence[] {
  const { allDay, timed } = itemsOn(list, date, timeZone);
  const rank = (o: CalendarOccurrence) => (o.allDay ? 0 : o.kind === "task" ? 2 : 1);
  return [...allDay, ...timed].sort((a, b) => rank(a) - rank(b) || a.startAt - b.startAt);
}

/** A schedule fire has no length; on a time grid it is drawn this tall so it can be read and grabbed. */
export const POINT_MINUTES = 30;
const DAY_MINUTES = 1440;

export interface PlacedItem {
  occurrence: CalendarOccurrence;
  /** Minutes after the day's midnight, clipped to the day. */
  top: number;
  height: number;
  column: number;
  columns: number;
  /** The item started before this day or runs past it. */
  continuesBefore: boolean;
  continuesAfter: boolean;
}

/**
 * Lay a day's timed items out side by side: each cluster of overlapping items shares the width, every
 * item taking the first column free at its start. Positions are WALL-clock minutes, as the hour labels
 * are, so on a DST day an item at 03:30 sits beside the 03:00 label like on any other day.
 */
export function layoutDay(items: readonly CalendarOccurrence[], date: CivilDate, timeZone: string): PlacedItem[] {
  const dayStart = startOfDay(date, timeZone);
  const dayEnd = startOfDay(addDays(date, 1), timeZone);
  const clockOf = (ms: number) => {
    const w = epochToWall(ms, timeZone);
    return w.hh * 60 + w.mi;
  };
  const spans = items
    .map((occurrence) => {
      const continuesBefore = occurrence.startAt < dayStart;
      const continuesAfter = occurrence.endAt > dayEnd;
      const start = continuesBefore ? 0 : clockOf(occurrence.startAt);
      const rawEnd = occurrence.endAt <= occurrence.startAt ? start + POINT_MINUTES : occurrence.endAt >= dayEnd ? DAY_MINUTES : clockOf(occurrence.endAt);
      const end = Math.min(DAY_MINUTES, Math.max(rawEnd, start + 15));
      return { occurrence, start: Math.min(start, DAY_MINUTES - 15), end, continuesBefore, continuesAfter };
    })
    .sort((a, b) => a.start - b.start || b.end - a.end);

  const placed: PlacedItem[] = [];
  let cluster: { item: PlacedItem; end: number }[] = [];
  let clusterEnd = -1;
  const closeCluster = () => {
    const columns = Math.max(1, ...cluster.map((c) => c.item.column + 1));
    for (const c of cluster) c.item.columns = columns;
    cluster = [];
  };
  for (const s of spans) {
    if (s.start >= clusterEnd) closeCluster();
    const taken = new Set(cluster.filter((c) => c.end > s.start).map((c) => c.item.column));
    let column = 0;
    while (taken.has(column)) column++;
    const item: PlacedItem = { occurrence: s.occurrence, top: s.start, height: s.end - s.start, column, columns: 1, continuesBefore: s.continuesBefore, continuesAfter: s.continuesAfter };
    placed.push(item);
    cluster.push({ item, end: s.end });
    clusterEnd = Math.max(clusterEnd, s.end);
  }
  closeCluster();
  return placed;
}

export const KIND_LABEL: Record<CalendarItemKind, string> = { event: "Event", reminder: "Reminder", task: "Scheduled task" };

export const STATUS_LABEL: Record<CalendarOccurrence["status"], string> = {
  upcoming: "Upcoming",
  past: "Past",
  paused: "Paused — will not run",
  skipped: "Skipped — this run will not happen",
  ran: "Ran",
};

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const ORDINALS = ["first", "second", "third", "fourth", "fifth"];

/** "Every 2 weeks on Monday and Thursday, 6 times" — a rule in words, for the details panel and form. */
export function describeRecurrence(rule: CalendarRecurrence, start: CivilDate): string {
  const n = rule.interval;
  const unit = { daily: "day", weekly: "week", monthly: "month", yearly: "year" }[rule.freq];
  let text = n === 1 ? (rule.freq === "daily" ? "Every day" : `Every ${unit}`) : `Every ${n} ${unit}s`;
  if (rule.freq === "weekly") {
    const days = (rule.weekdays?.length ? rule.weekdays : [weekday(start)]).slice().sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
    const isWorkweek = days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d));
    text += isWorkweek ? " on weekdays" : ` on ${joinWords(days.map((d) => WEEKDAY_NAMES[d]!))}`;
  } else if (rule.freq === "monthly") {
    const by = rule.monthlyBy ?? "monthday";
    if (by === "monthday") text += ` on day ${start.d}`;
    else text += ` on the ${by === "lastWeekday" ? "last" : ORDINALS[Math.ceil(start.d / 7) - 1]} ${WEEKDAY_NAMES[weekday(start)]}`;
  } else if (rule.freq === "yearly") {
    text += ` on ${formatCivil(start, { day: "numeric", month: "long" })}`;
  }
  if (rule.until) text += `, until ${formatCivil(parseDate(rule.until)!, { day: "numeric", month: "short", year: "numeric" })}`;
  if (rule.count) text += `, ${rule.count} ${rule.count === 1 ? "time" : "times"}`;
  return text;
}

function joinWords(words: string[]): string {
  return words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

export function describeReminder(reminder: CalendarReminder): string {
  if (reminder.kind === "before") {
    const m = reminder.minutes;
    if (m === 0) return "At the start";
    if (m % 10080 === 0) return `${m / 10080} ${m === 10080 ? "week" : "weeks"} before`;
    if (m % 1440 === 0) return `${m / 1440} ${m === 1440 ? "day" : "days"} before`;
    if (m % 60 === 0) return `${m / 60} ${m === 60 ? "hour" : "hours"} before`;
    return `${m} minutes before`;
  }
  const days = reminder.daysBefore;
  const day = days === 0 ? "On the day" : days === 1 ? "The day before" : days % 7 === 0 ? `${days / 7} ${days === 7 ? "week" : "weeks"} before` : `${days} days before`;
  return `${day} at ${reminder.time}`;
}

/** The dates of a month grid, week by week. */
export function weeksOf(from: CivilDate, to: CivilDate): CivilDate[][] {
  const weeks: CivilDate[][] = [];
  for (let n = dayNumber(from); n <= dayNumber(to); n += 7) weeks.push(Array.from({ length: 7 }, (_, i) => addDays(from, n - dayNumber(from) + i)));
  return weeks;
}

export const sameDate = (a: CivilDate, b: CivilDate): boolean => a.y === b.y && a.m === b.m && a.d === b.d;

export const dateKey = formatDate;
