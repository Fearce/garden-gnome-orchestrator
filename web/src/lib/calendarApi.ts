// The calendar's client: data shapes mirrored from server/src/calendar/types.ts, and the authenticated
// /api/calendar calls. Personal event content travels only over these same-origin requests; the
// WebSocket carries just a content-free "calendar.changed" ping.

import { apiUrl } from "./base.js";

export type CalendarFreq = "daily" | "weekly" | "monthly" | "yearly";
export type MonthlyBy = "monthday" | "nthWeekday" | "lastWeekday";

export interface CalendarRecurrence {
  freq: CalendarFreq;
  interval: number;
  weekdays?: number[] | null;
  monthlyBy?: MonthlyBy | null;
  until?: string | null;
  count?: number | null;
}

export type CalendarReminder = { kind: "before"; minutes: number } | { kind: "day"; daysBefore: number; time: string };

export interface CalendarException {
  date: string;
  cancelled: boolean;
  allDay?: boolean | null;
  start?: string | null;
  end?: string | null;
  title?: string | null;
  notes?: string | null;
}

export interface CalendarEvent {
  id: string;
  title: string;
  notes: string | null;
  allDay: boolean;
  start: string;
  end: string;
  timeZone: string;
  recurrence: CalendarRecurrence | null;
  /** Longest lead first; empty when the event sends nothing. */
  reminders: CalendarReminder[];
  exceptions: CalendarException[];
  createdAt: number;
  updatedAt: number;
}

export interface CalendarEventInput {
  title: string;
  notes: string | null;
  allDay: boolean;
  start: string;
  end: string;
  timeZone: string;
  recurrence: CalendarRecurrence | null;
  reminders: CalendarReminder[];
}

/** The owner's default reminders for new events: leads in minutes, and the clock time an all-day
 *  event's reminders use. Mirrors the server's CalendarDefaults. */
export interface CalendarDefaults {
  reminderLeads: number[];
  allDayTime: string;
}

export type CalendarScope = "occurrence" | "following" | "series";
export type CalendarItemKind = "event" | "reminder" | "task";
export type OccurrenceStatus = "upcoming" | "past" | "paused" | "skipped" | "ran";

export interface CalendarOccurrence {
  key: string;
  kind: CalendarItemKind;
  source: "event" | "schedule";
  id: string;
  title: string;
  allDay: boolean;
  startAt: number;
  endAt: number;
  startDate?: string;
  endDate?: string;
  recurring: boolean;
  occurrenceDate?: string;
  edited?: boolean;
  hasReminder: boolean;
  status: OccurrenceStatus;
  slotAt?: number;
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
  events: CalendarEvent[];
  defaults: CalendarDefaults;
}

export class CalendarApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(apiUrl(path), {
      cache: "no-store",
      ...init,
      headers: init?.body ? { "content-type": "application/json" } : undefined,
    });
  } catch {
    throw new CalendarApiError("The console could not reach the server.", 0);
  }
  const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) {
    const message = res.status === 401 ? "Your session has expired. Sign in again to see the calendar." : (body?.error ?? `The calendar request failed (${res.status}).`);
    throw new CalendarApiError(message, res.status);
  }
  return body as T;
}

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

export const fetchRange = (from: string, to: string, tz: string): Promise<CalendarRange> =>
  call(`/api/calendar/range?from=${from}&to=${to}&tz=${encodeURIComponent(tz)}`);

type EventReply = { ok: true; event: CalendarEvent | null };

export const createEvent = (input: CalendarEventInput): Promise<EventReply> => call("/api/calendar/events", json("POST", input));

export const saveDefaults = (defaults: CalendarDefaults): Promise<{ ok: true; defaults: CalendarDefaults }> => call("/api/calendar/settings", json("PUT", defaults));

export const updateEvent = (id: string, scope: CalendarScope, occurrenceDate: string | null, changes: Partial<CalendarEventInput>): Promise<EventReply> =>
  call(`/api/calendar/events/${encodeURIComponent(id)}`, json("PATCH", { scope, occurrenceDate, changes }));

export function deleteEvent(id: string, scope: CalendarScope, occurrenceDate: string | null): Promise<EventReply> {
  const q = new URLSearchParams({ scope });
  if (occurrenceDate) q.set("occurrenceDate", occurrenceDate);
  return call(`/api/calendar/events/${encodeURIComponent(id)}?${q}`, { method: "DELETE" });
}

export const remindNow = (id: string, occurrenceDate: string | null): Promise<EventReply> =>
  call(`/api/calendar/events/${encodeURIComponent(id)}/remind-now`, json("POST", { occurrenceDate }));

export const skipScheduleRun = (id: string, slotAt: number): Promise<EventReply> => call(`/api/calendar/schedules/${encodeURIComponent(id)}/skip`, json("POST", { slotAt }));

export const restoreScheduleRun = (id: string, slotAt: number): Promise<EventReply> =>
  call(`/api/calendar/schedules/${encodeURIComponent(id)}/restore`, json("POST", { slotAt }));

export const moveScheduleRun = (id: string, slotAt: number, toAt: number, scope: "occurrence" | "series"): Promise<EventReply> =>
  call(`/api/calendar/schedules/${encodeURIComponent(id)}/move`, json("POST", { slotAt, toAt, scope }));

/** How a fired reminder's Discord DM went. Mirrors server/src/calendar/firedReminders.ts. */
export type ReminderDelivery = "sending" | "sent" | "retrying" | "failed" | "interrupted" | "withdrawn";

/** A reminder that has gone off. Mirrors FiredReminder in server/src/calendar/firedReminders.ts. */
export interface FiredReminder {
  id: string;
  source: "event" | "schedule";
  refId: string;
  occurrence: string | null;
  startsAt: number | null;
  title: string;
  text: string;
  dueAt: number;
  firedAt: number;
  delivery: ReminderDelivery;
  deliveryNote: string | null;
  seenAt: number | null;
}

export const fetchFiredReminders = (): Promise<{ reminders: FiredReminder[]; unseen: number }> => call("/api/calendar/fired");

/** Acknowledge the given fired reminders, or every unseen one when `ids` is omitted. */
export const markRemindersSeen = (ids?: string[]): Promise<{ ok: true; changed: number; unseen: number }> =>
  call("/api/calendar/fired/seen", json("POST", ids ? { ids } : {}));

// The socket's "calendar.changed" ping, fanned out to whichever calendar view is open.
const listeners = new Set<() => void>();

export function onCalendarChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifyCalendarChanged(): void {
  for (const listener of listeners) listener();
}
