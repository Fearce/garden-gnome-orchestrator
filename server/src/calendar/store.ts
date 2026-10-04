import { randomUUID } from "node:crypto";
import type { Db } from "../db/db.js";
import type { CalendarEvent, CalendarException, CalendarRecurrence, CalendarReminder } from "./types.js";

type Row = Record<string, unknown>;

function parseJson<T>(text: unknown): T | null {
  if (typeof text !== "string" || !text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function rowToException(r: Row): CalendarException {
  return {
    date: r.occurrence as string,
    cancelled: Boolean(r.cancelled),
    allDay: r.all_day == null ? null : Boolean(r.all_day),
    start: (r.start_at as string | null) ?? null,
    end: (r.end_at as string | null) ?? null,
    title: (r.title as string | null) ?? null,
    notes: (r.notes as string | null) ?? null,
    updatedAt: r.updated_at as number,
  };
}

export type StoredEventFields = Omit<CalendarEvent, "id" | "exceptions" | "createdAt" | "updatedAt">;

/** The calendar's tables (schema.ts). Rows hold the owner's personal entries and stay in the local DB. */
export class CalendarStore {
  constructor(private readonly db: Db) {}

  private get raw() {
    return this.db.raw;
  }

  create(fields: StoredEventFields, at = Date.now()): CalendarEvent {
    const id = randomUUID();
    this.raw
      .prepare(
        `INSERT INTO calendar_events(id, title, notes, all_day, start_at, end_at, time_zone, recurrence, reminder, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, fields.title, fields.notes, fields.allDay ? 1 : 0, fields.start, fields.end, fields.timeZone, json(fields.recurrence), json(fields.reminder), at, at);
    return this.get(id)!;
  }

  update(id: string, fields: StoredEventFields, at = Date.now()): CalendarEvent | null {
    const changed = this.raw
      .prepare(
        `UPDATE calendar_events SET title = ?, notes = ?, all_day = ?, start_at = ?, end_at = ?, time_zone = ?, recurrence = ?, reminder = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(fields.title, fields.notes, fields.allDay ? 1 : 0, fields.start, fields.end, fields.timeZone, json(fields.recurrence), json(fields.reminder), at, id).changes;
    return changed ? this.get(id) : null;
  }

  delete(id: string): boolean {
    return this.raw.prepare("DELETE FROM calendar_events WHERE id = ?").run(id).changes > 0;
  }

  get(id: string): CalendarEvent | null {
    const r = this.raw.prepare("SELECT * FROM calendar_events WHERE id = ?").get(id) as Row | undefined;
    return r ? this.hydrate(r, this.exceptionsOf(id)) : null;
  }

  list(): CalendarEvent[] {
    const exceptions = new Map<string, CalendarException[]>();
    for (const r of this.raw.prepare("SELECT * FROM calendar_event_exceptions ORDER BY occurrence").all() as Row[]) {
      const list = exceptions.get(r.event_id as string) ?? [];
      list.push(rowToException(r));
      exceptions.set(r.event_id as string, list);
    }
    return (this.raw.prepare("SELECT * FROM calendar_events ORDER BY start_at").all() as Row[]).map((r) => this.hydrate(r, exceptions.get(r.id as string) ?? []));
  }

  setException(eventId: string, exception: CalendarException, at = Date.now()): void {
    this.raw
      .prepare(
        `INSERT INTO calendar_event_exceptions(event_id, occurrence, cancelled, all_day, start_at, end_at, title, notes, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(event_id, occurrence) DO UPDATE SET cancelled = excluded.cancelled, all_day = excluded.all_day,
           start_at = excluded.start_at, end_at = excluded.end_at, title = excluded.title, notes = excluded.notes, updated_at = excluded.updated_at`,
      )
      .run(
        eventId,
        exception.date,
        exception.cancelled ? 1 : 0,
        exception.allDay == null ? null : exception.allDay ? 1 : 0,
        exception.start ?? null,
        exception.end ?? null,
        exception.title ?? null,
        exception.notes ?? null,
        at,
      );
  }

  /** Replace a series' exceptions wholesale (a series edit re-keys them; a split hands some over). */
  replaceExceptions(eventId: string, exceptions: CalendarException[], at = Date.now()): void {
    this.raw.prepare("DELETE FROM calendar_event_exceptions WHERE event_id = ?").run(eventId);
    for (const e of exceptions) this.setException(eventId, e, at);
  }

  /** Whether this occurrence's reminder (due at `remindAt`) was already sent; records it if not. One
   *  statement, so two ticks can never both claim the same reminder. */
  claimReminder(eventId: string, occurrence: string, remindAt: number, at = Date.now()): boolean {
    return (
      this.raw
        .prepare("INSERT OR IGNORE INTO calendar_reminder_log(event_id, occurrence, remind_at, sent_at) VALUES(?, ?, ?, ?)")
        .run(eventId, occurrence, remindAt, at).changes > 0
    );
  }

  /** Hand a split-off series the sent-reminder history of the occurrences it took over, so the split
   *  itself never re-sends a reminder the owner already got. */
  moveReminderLog(fromId: string, toId: string, fromDate: string, dayShift: (date: string) => string): void {
    const rows = this.raw.prepare("SELECT occurrence, remind_at, sent_at FROM calendar_reminder_log WHERE event_id = ? AND occurrence >= ?").all(fromId, fromDate) as Row[];
    const insert = this.raw.prepare("INSERT OR IGNORE INTO calendar_reminder_log(event_id, occurrence, remind_at, sent_at) VALUES(?, ?, ?, ?)");
    for (const r of rows) insert.run(toId, dayShift(r.occurrence as string), r.remind_at, r.sent_at);
    this.raw.prepare("DELETE FROM calendar_reminder_log WHERE event_id = ? AND occurrence >= ?").run(fromId, fromDate);
  }

  pruneReminderLog(beforeMs: number): void {
    this.raw.prepare("DELETE FROM calendar_reminder_log WHERE remind_at < ?").run(beforeMs);
  }

  transaction<T>(fn: () => T): T {
    return this.raw.transaction(fn)();
  }

  private exceptionsOf(id: string): CalendarException[] {
    return (this.raw.prepare("SELECT * FROM calendar_event_exceptions WHERE event_id = ? ORDER BY occurrence").all(id) as Row[]).map(rowToException);
  }

  private hydrate(r: Row, exceptions: CalendarException[]): CalendarEvent {
    return {
      id: r.id as string,
      title: r.title as string,
      notes: (r.notes as string | null) ?? null,
      allDay: Boolean(r.all_day),
      start: r.start_at as string,
      end: r.end_at as string,
      timeZone: r.time_zone as string,
      recurrence: parseJson<CalendarRecurrence>(r.recurrence),
      reminder: parseJson<CalendarReminder>(r.reminder),
      exceptions,
      createdAt: r.created_at as number,
      updatedAt: r.updated_at as number,
    };
  }
}

function json(value: unknown): string | null {
  return value == null ? null : JSON.stringify(value);
}
