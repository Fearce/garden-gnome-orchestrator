import { randomUUID } from "node:crypto";
import type { Db } from "../db/db.js";
import type { EventHub } from "../events.js";
import { instancesOverlapping } from "./instances.js";
import { CalendarStore } from "./store.js";
import { dayNumber, parseDate } from "./zoned.js";

/** How a fired reminder's Discord DM went, including a send interrupted before delivery was confirmed. */
export type ReminderDelivery = "sending" | "sent" | "retrying" | "failed" | "withdrawn" | "interrupted";

/** A reminder that has gone off. Mirrored in web/src/lib/calendarApi.ts. */
export interface FiredReminder {
  id: string;
  source: "event" | "schedule";
  /** The calendar event or scheduled_tasks id; it may since have been deleted. */
  refId: string;
  /** Events: the series date of the occurrence it is about. */
  occurrence: string | null;
  /** When the thing it reminds about starts (an event occurrence, a schedule's slot). */
  startsAt: number | null;
  /** An all-day event's civil start date, which stays the same in every viewer's time zone. */
  startsOn: string | null;
  title: string;
  text: string;
  /** When it was due, and when it actually went off (later after downtime). */
  dueAt: number;
  firedAt: number;
  delivery: ReminderDelivery;
  /** Why the DM has not arrived, when it has not. */
  deliveryNote: string | null;
  /** When the owner acknowledged it; null keeps it in the Calendar tab's count. */
  seenAt: number | null;
}

export type FiredReminderInput = Pick<FiredReminder, "source" | "refId" | "occurrence" | "startsAt" | "title" | "text" | "dueAt"> & { startsOn?: string | null };

/** How many fired reminders the list keeps, and for how long. */
export const FIRED_KEEP = 200;
const FIRED_RETENTION_MS = 90 * 86_400_000;
const NOTE_MAX = 300;

type Row = Record<string, unknown>;

function rowToFired(r: Row): FiredReminder {
  return {
    id: r.id as string,
    source: r.source === "schedule" ? "schedule" : "event",
    refId: r.ref_id as string,
    occurrence: (r.occurrence as string | null) ?? null,
    startsAt: (r.starts_at as number | null) ?? null,
    startsOn: (r.starts_on as string | null) ?? null,
    title: r.title as string,
    text: r.text as string,
    dueAt: r.due_at as number,
    firedAt: r.fired_at as number,
    delivery: r.delivery as ReminderDelivery,
    deliveryNote: (r.delivery_note as string | null) ?? null,
    seenAt: (r.seen_at as number | null) ?? null,
  };
}

/**
 * Every reminder that has gone off, events and schedules alike. The Calendar tab's number is the count
 * of unseen ones, and its list says which reminder raised it and whether the DM arrived. The socket
 * carries only that count (`reminders.fired`); the content travels over the authenticated calendar
 * routes, like every other piece of calendar text.
 */
export class FiredReminders {
  constructor(
    private readonly db: Db,
    private readonly hub: EventHub,
    private readonly now: () => number = Date.now,
  ) {}

  private get raw() {
    return this.db.raw;
  }

  /** Reconcile the previous process's sends before new reminders start. Retries do not survive a
   *  restart. An interrupted first send may already have reached Discord, so never resend it: leave
   *  its delivery unconfirmed and put it on Notes instead. The status and fallback commit together. */
  recoverInterrupted(fallback: (title: string, text: string, why: string) => void): number {
    const recovered = this.raw.transaction(() => {
      const pending = this.raw.prepare("SELECT * FROM fired_reminders WHERE delivery IN ('sending', 'retrying')").all() as Row[];
      const update = this.raw.prepare("UPDATE fired_reminders SET delivery = ?, delivery_note = ? WHERE id = ?");
      for (const row of pending) {
        const reminder = rowToFired(row);
        const sending = reminder.delivery === "sending";
        const note = sending
          ? "Discord delivery was interrupted by a server restart and could not be confirmed. It is on the note list; check Discord before sending again."
          : "Discord retries stopped when the server restarted, and delivery could not be confirmed. It is on the note list; check Discord before sending again.";
        update.run("interrupted", note, reminder.id);
        // A retrying reminder already has its fallback from the first failure.
        if (sending) fallback(reminder.title, reminder.text, note);
      }
      return pending.length;
    })();
    if (recovered) this.changed();
    return recovered;
  }

  /** Record a reminder that just went off and return its id. */
  record(input: FiredReminderInput): string {
    const id = randomUUID();
    const at = this.now();
    this.raw
      .prepare(
        `INSERT INTO fired_reminders(id, source, ref_id, occurrence, starts_at, starts_on, title, text, due_at, fired_at, delivery, delivery_note, seen_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sending', NULL, NULL)`,
      )
      .run(id, input.source, input.refId, input.occurrence, input.startsAt, input.startsOn ?? null, input.title, input.text, input.dueAt, at);
    this.prune(at);
    this.changed();
    return id;
  }

  /** Update how its DM went. The title and text follow a retry that re-read an edited reminder. */
  setDelivery(id: string, delivery: ReminderDelivery, note: string | null = null, current?: { title: string; text: string }): void {
    const clipped = note ? note.slice(0, NOTE_MAX) : null;
    const changed = current
      ? this.raw.prepare("UPDATE fired_reminders SET delivery = ?, delivery_note = ?, title = ?, text = ? WHERE id = ?").run(delivery, clipped, current.title, current.text, id).changes
      : this.raw.prepare("UPDATE fired_reminders SET delivery = ?, delivery_note = ? WHERE id = ?").run(delivery, clipped, id).changes;
    if (changed) this.changed();
  }

  /** Newest first. */
  list(): FiredReminder[] {
    const reminders = (this.raw.prepare("SELECT * FROM fired_reminders ORDER BY fired_at DESC, rowid DESC LIMIT ?").all(FIRED_KEEP) as Row[]).map(rowToFired);
    const store = new CalendarStore(this.db);
    for (const reminder of reminders) {
      if (reminder.startsOn !== null || reminder.source !== "event" || !reminder.occurrence || reminder.startsAt === null) continue;
      const date = parseDate(reminder.occurrence);
      const event = date ? store.get(reminder.refId) : null;
      if (!date || !event) continue;
      const day = dayNumber(date);
      const instance = instancesOverlapping(event, -8.64e15, 8.64e15, day, day).find((i) => i.date === reminder.occurrence);
      // Legacy rows lack the all-day snapshot. Infer only from an unchanged occurrence whose exact
      // instant still matches; a later edit could have converted a midnight timed event to all-day.
      if (!instance?.allDay || instance.startAt !== reminder.startsAt || instance.savedAt > reminder.firedAt) continue;
      this.raw.prepare("UPDATE fired_reminders SET starts_on = ? WHERE id = ? AND starts_on IS NULL").run(instance.start, reminder.id);
      reminder.startsOn = instance.start;
    }
    return reminders;
  }

  unseen(): number {
    return (this.raw.prepare("SELECT COUNT(*) AS n FROM fired_reminders WHERE seen_at IS NULL").get() as { n: number }).n;
  }

  /** Acknowledge the given reminders, or every unseen one when `ids` is omitted. Returns how many changed. */
  markSeen(ids?: readonly string[]): number {
    const at = this.now();
    let changed = 0;
    if (!ids) {
      changed = this.raw.prepare("UPDATE fired_reminders SET seen_at = ? WHERE seen_at IS NULL").run(at).changes;
    } else {
      const stmt = this.raw.prepare("UPDATE fired_reminders SET seen_at = ? WHERE id = ? AND seen_at IS NULL");
      this.raw.transaction(() => {
        for (const id of ids) changed += stmt.run(at, id).changes;
      })();
    }
    if (changed) this.changed();
    return changed;
  }

  private prune(now: number): void {
    this.raw.prepare("DELETE FROM fired_reminders WHERE fired_at < ?").run(now - FIRED_RETENTION_MS);
    this.raw
      .prepare("DELETE FROM fired_reminders WHERE rowid NOT IN (SELECT rowid FROM fired_reminders ORDER BY fired_at DESC, rowid DESC LIMIT ?)")
      .run(FIRED_KEEP);
  }

  private changed(): void {
    this.hub.publish({ type: "reminders.fired", unseen: this.unseen(), at: this.now() });
  }
}
