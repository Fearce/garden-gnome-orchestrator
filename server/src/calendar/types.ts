// The calendar's data shapes. Mirrored in web/src/lib/calendarApi.ts.

export type CalendarFreq = "daily" | "weekly" | "monthly" | "yearly";

/** How a monthly series picks its day: the same day number (the 15th), the same nth weekday (the 2nd
 *  Tuesday), or the month's last such weekday (the last Friday). */
export type MonthlyBy = "monthday" | "nthWeekday" | "lastWeekday";

/** A deliberately small RRULE: what a person sets in a calendar's repeat dialog, nothing more. */
export interface CalendarRecurrence {
  freq: CalendarFreq;
  interval: number; // every N days/weeks/months/years, 1-99
  /** Weekly only: the weekdays it falls on, 0 = Sunday. Always includes the series' own start weekday. */
  weekdays?: number[] | null;
  /** Monthly only. Defaults to "monthday". */
  monthlyBy?: MonthlyBy | null;
  /** The last date an occurrence may START on, inclusive. */
  until?: string | null;
  /** How many occurrences the series generates in total (a cancelled one still counts, as in RFC 5545). */
  count?: number | null;
}

/** When an event's reminder goes out. `before` is relative to a timed start; `day` is a clock time some
 *  days before (0 = on the day), which is what an all-day event needs. */
export type CalendarReminder = { kind: "before"; minutes: number } | { kind: "day"; daysBefore: number; time: string };

/** One occurrence of a series changed on its own: cancelled, or moved/retitled. Keyed by the date the
 *  occurrence ORIGINALLY started on, so it survives the series being viewed in another zone. */
export interface CalendarException {
  date: string;
  cancelled: boolean;
  allDay?: boolean | null;
  start?: string | null;
  end?: string | null;
  title?: string | null;
  notes?: string | null;
  /** When this occurrence was last saved on its own. Set by the store; ignored on input. */
  updatedAt?: number;
}

/**
 * A personal calendar entry. Never starts an agent: its only side effect is the optional reminder DM.
 * `start`/`end` are wall-clock text in `timeZone` — "YYYY-MM-DD" when all-day (end inclusive), else
 * "YYYY-MM-DDTHH:MM" (end exclusive, after start). Stored in the local DB only; never in git.
 */
export interface CalendarEvent {
  id: string;
  title: string;
  notes: string | null;
  allDay: boolean;
  start: string;
  end: string;
  timeZone: string;
  recurrence: CalendarRecurrence | null;
  reminder: CalendarReminder | null;
  exceptions: CalendarException[];
  createdAt: number;
  updatedAt: number;
}

/** What a create accepts. */
export interface CalendarEventInput {
  title: string;
  notes?: string | null;
  allDay: boolean;
  start: string;
  end: string;
  timeZone: string;
  recurrence?: CalendarRecurrence | null;
  reminder?: CalendarReminder | null;
}

/** Which part of a recurring series an edit or delete applies to. */
export type CalendarScope = "occurrence" | "following" | "series";

export type CalendarItemKind = "event" | "reminder" | "task";

/**
 * One thing on the grid. Events and schedules both become these, so the views never branch on where
 * an item came from beyond its `kind`. Timed items carry epochs; all-day items carry their dates.
 */
export interface CalendarOccurrence {
  key: string;
  kind: CalendarItemKind;
  source: "event" | "schedule";
  /** The event or scheduled_tasks id. */
  id: string;
  title: string;
  allDay: boolean;
  startAt: number;
  endAt: number;
  /** All-day items: the first and last (inclusive) date. */
  startDate?: string;
  endDate?: string;
  recurring: boolean;
  /** Events: the series date this occurrence belongs to. */
  occurrenceDate?: string;
  /** This occurrence was moved or edited on its own. */
  edited?: boolean;
  hasReminder: boolean;
  /**
   * upcoming — will fire / happen; paused — a disabled schedule's would-be slot (it will NOT fire);
   * skipped — a schedule run removed from this one slot; ran — the schedule's last actual fire.
   */
  status: "upcoming" | "past" | "paused" | "skipped" | "ran";
  /** Schedules: the slot epoch this occurrence fires at (the skip key). */
  slotAt?: number;
  /** A collapsed run of a high-frequency schedule (every few minutes) on one day. */
  count?: number;
  lastThreadId?: string | null;
}

export interface CalendarRange {
  from: string;
  to: string;
  timeZone: string;
  serverTimeZone: string;
  now: number;
  occurrences: CalendarOccurrence[];
  /** Every event series with an occurrence in the range, for the details/edit panel. */
  events: CalendarEvent[];
}
