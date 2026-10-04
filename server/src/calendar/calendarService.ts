import type { Db } from "../db/db.js";
import type { EventHub } from "../events.js";
import { cronAtInstant, nextRun, shiftCron } from "../orchestrator/cron.js";
import { deliverReminder, REMINDER_RETRY_MS, type ReminderChannel } from "../orchestrator/reminderDelivery.js";
import type { Scheduler } from "../orchestrator/scheduler.js";
import { reminderDue, reminderText, remindAt } from "./eventReminders.js";
import { type EventInstance, instancesOverlapping, seriesTimesOn, startDateOf } from "./instances.js";
import { countBefore, isOccurrence, normalizeRecurrence } from "./recurrence.js";
import { scheduleOccurrences } from "./scheduleOccurrences.js";
import { CalendarStore } from "./store.js";
import type { CalendarEvent, CalendarEventInput, CalendarException, CalendarOccurrence, CalendarRange, CalendarRecurrence, CalendarScope } from "./types.js";
import { sanitizeEvent, TITLE_MAX, NOTES_MAX, validateSpan } from "./validate.js";
import { addDays, type CivilDate, dayNumber, epochToWall, formatDate, isValidTimeZone, parseDate, serverTimeZone, startOfDay, wallMinutes } from "./zoned.js";

const TICK_MS = 30_000;
/** The widest window one range request may ask for (a six-week month grid needs 42 days). */
export const MAX_RANGE_DAYS = 100;
/** How far ahead the reminder tick looks: the longest reminder lead plus a day. */
const REMINDER_HORIZON_MS = 29 * 86_400_000;
/** An all-day event can stay remindable for its whole span (up to a year) plus the reminder lead, so a
 *  sent record must outlive that or a long event would remind again. */
const LOG_RETENTION_MS = 400 * 86_400_000;

export interface CalendarResult {
  ok: boolean;
  error?: string;
  event?: CalendarEvent | null;
}

export type EventChanges = Partial<CalendarEventInput>;

/** The fields one occurrence may change on its own; the rest belong to the series. */
const OCCURRENCE_FIELDS = new Set(["title", "notes", "allDay", "start", "end"]);

/**
 * The owner's calendar: personal events (this service's own tables) shown beside the scheduler's
 * reminders and scheduled tasks. Events never dispatch work. Their only side effect is the reminder DM,
 * which this service derives from the event itself on every tick and sends through the same
 * `deliverReminder` path schedule reminders use, so moving or deleting an event can never leave a stale
 * notification behind.
 */
export class CalendarService {
  readonly store: CalendarStore;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastPrune = 0;

  constructor(
    private readonly db: Db,
    private readonly hub: EventHub,
    private readonly scheduler: Scheduler,
    private readonly reminders: ReminderChannel,
    private readonly opts: { retryMs?: readonly number[]; now?: () => number } = {},
  ) {
    this.store = new CalendarStore(db);
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  start(): void {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ---- reading ----

  /** Everything on the calendar between two dates (inclusive) as seen from `timeZone`. */
  range(from: string, to: string, timeZone: string): CalendarRange | string {
    const fromDate = parseDate(from);
    const toDate = parseDate(to);
    if (!fromDate || !toDate) return "from and to must be YYYY-MM-DD dates.";
    if (!isValidTimeZone(timeZone)) return "Unknown time zone.";
    const days = dayNumber(toDate) - dayNumber(fromDate) + 1;
    if (days < 1 || days > MAX_RANGE_DAYS) return `A range covers 1 to ${MAX_RANGE_DAYS} days.`;
    const fromMs = startOfDay(fromDate, timeZone);
    const toMs = startOfDay(addDays(toDate, 1), timeZone);
    const now = this.now();
    const occurrences: CalendarOccurrence[] = [];
    const events: CalendarEvent[] = [];
    for (const event of this.store.list()) {
      const instances = instancesOverlapping(event, fromMs, toMs, dayNumber(fromDate) - 1, dayNumber(toDate) + 1, { from: dayNumber(fromDate), to: dayNumber(toDate) });
      if (!instances.length) continue;
      events.push(event);
      for (const i of instances) occurrences.push(eventOccurrence(i, now));
    }
    occurrences.push(...this.scheduleOccurrencesIn(fromMs, toMs, now, timeZone));
    occurrences.sort((a, b) => a.startAt - b.startAt || a.title.localeCompare(b.title));
    return { from, to, timeZone, serverTimeZone: serverTimeZone(), now, occurrences, events };
  }

  private scheduleOccurrencesIn(fromMs: number, toMs: number, now: number, timeZone: string): CalendarOccurrence[] {
    const skips = new Map<string, Set<number>>();
    for (const { scheduleId, slotAt } of this.db.listScheduleSkips(fromMs, toMs)) {
      const set = skips.get(scheduleId) ?? new Set<number>();
      set.add(slotAt);
      skips.set(scheduleId, set);
    }
    const out: CalendarOccurrence[] = [];
    for (const s of this.scheduler.list()) {
      try {
        out.push(...scheduleOccurrences(s, { fromMs, toMs, now, timeZone, skips }));
      } catch (e) {
        this.hub.log("warn", `Calendar could not expand schedule ${s.id.slice(0, 8)}: ${String(e)}`);
      }
    }
    return out;
  }

  getEvent(id: string): CalendarEvent | null {
    return this.store.get(id);
  }

  // ---- events ----

  createEvent(input: CalendarEventInput): CalendarResult {
    const fields = sanitizeEvent(input);
    if (typeof fields === "string") return { ok: false, error: fields };
    const event = this.store.create(fields, this.now());
    this.changed();
    return { ok: true, event };
  }

  updateEvent(id: string, scope: CalendarScope, occurrenceDate: string | null | undefined, changes: EventChanges): CalendarResult {
    const event = this.store.get(id);
    if (!event) return { ok: false, error: "No such event." };
    if (!event.recurrence || scope === "series") return this.updateSeries(event, changes);
    const date = this.occurrenceOf(event, occurrenceDate);
    if (typeof date === "string") return { ok: false, error: date };
    if (scope === "occurrence") return this.updateOccurrence(event, date, changes);
    // "This and following" from the very first occurrence is the whole series.
    return formatDate(date) === event.start.slice(0, 10) ? this.updateSeries(event, changes) : this.splitSeries(event, formatDate(date), changes);
  }

  deleteEvent(id: string, scope: CalendarScope, occurrenceDate?: string | null): CalendarResult {
    const event = this.store.get(id);
    if (!event) return { ok: false, error: "No such event." };
    if (!event.recurrence || scope === "series") return this.deleteWhole(event);
    const date = this.occurrenceOf(event, occurrenceDate);
    if (typeof date === "string") return { ok: false, error: date };
    const key = formatDate(date);
    if (scope === "occurrence") {
      this.store.transaction(() => {
        this.store.setException(event.id, { date: key, cancelled: true }, this.now());
      });
      this.changed();
      return { ok: true, event: this.store.get(event.id) };
    }
    if (key === event.start.slice(0, 10)) return this.deleteWhole(event);
    this.store.transaction(() => this.truncateBefore(event, key));
    this.changed();
    return { ok: true, event: this.store.get(event.id) };
  }

  /** Send an occurrence's reminder right now, without recording it — the details panel's "Send test
   *  reminder", so the owner can see what the DM will say. */
  remindNow(id: string, occurrenceDate?: string | null): CalendarResult {
    const event = this.store.get(id);
    if (!event) return { ok: false, error: "No such event." };
    const instance = this.instanceOn(event, occurrenceDate ?? event.start.slice(0, 10));
    if (!instance) return { ok: false, error: "That occurrence does not exist." };
    void deliverReminder(this.reminders, this.hub, { title: instance.title, text: reminderText(instance), label: `Calendar reminder test (event ${event.id.slice(0, 8)})` }, this.retryMs());
    return { ok: true, event };
  }

  private deleteWhole(event: CalendarEvent): CalendarResult {
    this.store.delete(event.id);
    this.changed();
    return { ok: true, event: null };
  }

  private updateSeries(event: CalendarEvent, changes: EventChanges): CalendarResult {
    const fields = sanitizeEvent(merge(event, changes));
    if (typeof fields === "string") return { ok: false, error: fields };
    const shift = dayNumber(parseDate(fields.start.slice(0, 10))!) - dayNumber(parseDate(event.start.slice(0, 10))!);
    // A weekly series moved by days moves its weekdays too, unless the edit chose new ones.
    if (event.recurrence && fields.recurrence?.weekdays && (changes.recurrence === undefined || sameRule(changes.recurrence, event.recurrence, startDateOf(event.start)!))) {
      const weekdays = rotateWeekdays(normalizeRecurrence(event.recurrence, startDateOf(event.start)!).weekdays ?? [], shift);
      fields.recurrence = normalizeRecurrence({ ...fields.recurrence, weekdays }, startDateOf(fields.start)!);
    }
    // Exceptions follow the series when it moves by whole days; a series that stops repeating has none.
    const exceptions = fields.recurrence ? event.exceptions.map((e) => shiftException(e, shift)) : [];
    const at = this.now();
    const updated = this.store.transaction(() => {
      const row = this.store.update(event.id, fields, at);
      this.store.replaceExceptions(event.id, exceptions, at);
      return row;
    });
    this.changed();
    return { ok: true, event: updated ? this.store.get(event.id) : null };
  }

  private updateOccurrence(event: CalendarEvent, date: CivilDate, changes: EventChanges): CalendarResult {
    const extra = Object.keys(changes).filter((k) => !OCCURRENCE_FIELDS.has(k) && changes[k as keyof EventChanges] !== undefined);
    if (extra.length) return { ok: false, error: `Only one occurrence is being edited, so ${extra.join(", ")} cannot change; edit the whole series instead.` };
    const key = formatDate(date);
    const current = this.instanceOn(event, key);
    if (!current) return { ok: false, error: "That occurrence was cancelled." };
    const allDay = changes.allDay ?? current.allDay;
    const start = changes.start ?? current.start;
    const end = changes.end ?? current.end;
    const spanError = validateSpan(allDay, start, end, event.timeZone);
    if (spanError) return { ok: false, error: spanError };
    const title = changes.title !== undefined ? changes.title.trim().slice(0, TITLE_MAX) : current.title;
    if (!title) return { ok: false, error: "A title is required." };
    const notes = changes.notes !== undefined ? (changes.notes?.trim() ? changes.notes.trim().slice(0, NOTES_MAX) : "") : current.notes;
    const exception: CalendarException = {
      date: key,
      cancelled: false,
      allDay,
      start,
      end,
      title: title === event.title ? null : title,
      notes: notes === event.notes ? null : notes,
    };
    this.store.setException(event.id, exception, this.now());
    this.changed();
    return { ok: true, event: this.store.get(event.id) };
  }

  /**
   * "This and following": the series ends the day before `from`, and a new series starts at that
   * occurrence carrying the changes. A count-limited series hands the new one the occurrences it had
   * left. Occurrences already cancelled in the handed-over part stay cancelled (moved with the new
   * start date); one-off edits there are superseded by the new series' values.
   */
  private splitSeries(event: CalendarEvent, from: string, changes: EventChanges): CalendarResult {
    const rule = event.recurrence!;
    const fromDate = parseDate(from)!;
    const atOccurrence = seriesTimesOn(event, fromDate);
    // The edit form sends the rule back unchanged; only a real change replaces the remaining count.
    const ruleChanged = changes.recurrence !== undefined && !sameRule(changes.recurrence, rule, startDateOf(event.start)!);
    const inherited = ruleChanged ? changes.recurrence! : { ...rule, count: rule.count ? rule.count - countBefore(rule, startDateOf(event.start)!, fromDate) : null };
    const fields = sanitizeEvent(merge({ ...event, start: atOccurrence.start, end: atOccurrence.end, recurrence: inherited }, { ...changes, recurrence: undefined }));
    if (typeof fields === "string") return { ok: false, error: fields };
    const shift = dayNumber(parseDate(fields.start.slice(0, 10))!) - dayNumber(fromDate);
    const handedOver = fields.recurrence
      ? event.exceptions.filter((e) => e.date >= from && e.cancelled).map((e) => ({ date: shiftDate(e.date, shift), cancelled: true }))
      : [];
    const at = this.now();
    const created = this.store.transaction(() => {
      const next = this.store.create(fields, at);
      this.store.replaceExceptions(next.id, handedOver, at);
      this.store.moveReminderLog(event.id, next.id, from, (d) => shiftDate(d, shift));
      this.truncateBefore(event, from);
      return next;
    });
    this.changed();
    return { ok: true, event: this.store.get(created.id) };
  }

  /** End a series the day before `from`, dropping the exceptions from there on. */
  private truncateBefore(event: CalendarEvent, from: string): void {
    const until = formatDate(addDays(parseDate(from)!, -1));
    const fields = { ...event, recurrence: { ...event.recurrence!, until, count: null } };
    this.store.update(event.id, fields, this.now());
    this.store.replaceExceptions(
      event.id,
      event.exceptions.filter((e) => e.date < from),
      this.now(),
    );
  }

  /** The occurrence date an edit names, checked against the series. */
  private occurrenceOf(event: CalendarEvent, occurrenceDate: string | null | undefined): CivilDate | string {
    const date = occurrenceDate ? parseDate(occurrenceDate) : null;
    if (!date) return "Which occurrence? occurrenceDate (YYYY-MM-DD) is required for a recurring event.";
    if (!isOccurrence(event.recurrence!, startDateOf(event.start)!, date)) return "That date is not an occurrence of this event.";
    return date;
  }

  private instanceOn(event: CalendarEvent, date: string): EventInstance | null {
    const day = parseDate(date);
    if (!day) return null;
    // Wide enough for any moved occurrence: the instance is matched by its series date, not its time.
    const all = instancesOverlapping(event, -8.64e15, 8.64e15, dayNumber(day), dayNumber(day));
    return all.find((i) => i.date === date) ?? null;
  }

  // ---- schedules on the calendar ----

  /** Skip one fire of a recurring schedule (it neither reminds nor dispatches), or switch a run-once
   *  schedule off — skipping its only fire. */
  skipScheduleRun(id: string, slotAt: number): CalendarResult {
    const s = this.db.getScheduledTask(id);
    if (!s) return { ok: false, error: "No such scheduled task." };
    if (s.runOnce) {
      const r = this.scheduler.update(id, { enabled: false });
      return { ok: r.ok, error: r.error };
    }
    if (!isSlotOf(s.cron, slotAt)) return { ok: false, error: "That time is not one of this schedule's runs." };
    this.db.skipScheduleSlot(id, slotAt);
    this.changed();
    return { ok: true };
  }

  restoreScheduleRun(id: string, slotAt: number): CalendarResult {
    const existed = this.db.unskipScheduleSlot(id, slotAt);
    if (existed) this.changed();
    return existed ? { ok: true } : { ok: false, error: "That run was not skipped." };
  }

  /**
   * Move one run, or every run, of a schedule. A run-once schedule simply gets a new date. For a
   * recurring one, "occurrence" skips the slot and adds a run-once copy at the new time (the copy is a
   * normal scheduled task the owner can see and edit); "series" shifts the cron itself, which only
   * works for a fixed time of day.
   */
  moveScheduleRun(id: string, slotAt: number, toAt: number, scope: "occurrence" | "series"): CalendarResult {
    const s = this.db.getScheduledTask(id);
    if (!s) return { ok: false, error: "No such scheduled task." };
    const now = this.now();
    if (s.runOnce || scope === "occurrence") {
      const cron = cronAtInstant(toAt);
      if (toAt <= now) return { ok: false, error: "A run can only be moved to a time in the future." };
      if (nextRun(cron, now) !== Math.floor(toAt / 60_000) * 60_000) return { ok: false, error: "A one-off run can be set up to a year ahead." };
      if (s.runOnce) {
        const r = this.scheduler.update(id, { cron, enabled: true });
        return { ok: r.ok, error: r.error };
      }
      if (!isSlotOf(s.cron, slotAt)) return { ok: false, error: "That time is not one of this schedule's runs." };
      const copy = this.scheduler.create({
        title: s.title,
        workspace: s.workspace,
        prompt: s.prompt,
        reminder: s.reminder ?? null,
        cron,
        enabled: true,
        effort: s.effort ?? null,
        model: s.model ?? null,
        provider: s.provider ?? null,
        runOnce: true,
      });
      if (!copy.ok) return { ok: false, error: copy.error };
      this.db.updateScheduledTask(copy.schedule!.id, { originId: s.originId ?? s.id });
      this.db.skipScheduleSlot(id, slotAt);
      this.changed();
      return { ok: true };
    }
    const tz = serverTimeZone();
    const delta = wallMinutes(epochToWall(toAt, tz)) - wallMinutes(epochToWall(slotAt, tz));
    const cron = shiftCron(s.cron, delta);
    if (!cron) return { ok: false, error: "This schedule's pattern cannot be shifted by dragging. Open it and edit the schedule instead." };
    const r = this.scheduler.update(id, { cron });
    return { ok: r.ok, error: r.error };
  }

  // ---- reminders ----

  /** Send every event reminder that has come due. Public for tests; the timer drives it in production. */
  tick(now = this.now()): number {
    let sent = 0;
    for (const event of this.store.list()) {
      if (!event.reminder) continue;
      const fromMs = now - 2 * 86_400_000;
      const toMs = now + REMINDER_HORIZON_MS;
      const fromDay = dayNumber(epochToWall(fromMs, "UTC")) - 1;
      const toDay = dayNumber(epochToWall(toMs, "UTC")) + 1;
      for (const instance of instancesOverlapping(event, fromMs, toMs, fromDay, toDay)) {
        const dueAt = remindAt(event.reminder, instance);
        if (!reminderDue(dueAt, instance, now)) continue;
        if (!this.store.claimReminder(event.id, instance.date, dueAt, now)) continue;
        sent++;
        void deliverReminder(
          this.reminders,
          this.hub,
          {
            title: instance.title,
            text: reminderText(instance),
            label: `Calendar reminder (event ${event.id.slice(0, 8)})`,
            current: () => this.stillDue(event.id, instance.date, dueAt),
          },
          this.retryMs(),
        );
      }
    }
    if (now - this.lastPrune > 86_400_000) {
      this.lastPrune = now;
      this.store.pruneReminderLog(now - LOG_RETENTION_MS);
      this.db.pruneScheduleSkips(now - 86_400_000);
    }
    return sent;
  }

  /** The reminder for one occurrence as it reads now, or null once the event, the occurrence or its
   *  reminder time has gone — a moved occurrence's new time is a reminder of its own. */
  private stillDue(eventId: string, date: string, dueAt: number): { title: string; text: string } | null {
    const event = this.store.get(eventId);
    const instance = event?.reminder ? this.instanceOn(event, date) : null;
    if (!event?.reminder || !instance || remindAt(event.reminder, instance) !== dueAt) return null;
    return { title: instance.title, text: reminderText(instance) };
  }

  private retryMs(): readonly number[] {
    return this.opts.retryMs ?? REMINDER_RETRY_MS;
  }

  private changed(): void {
    this.hub.publish({ type: "calendar.changed", at: this.now() });
  }
}

function eventOccurrence(i: EventInstance, now: number): CalendarOccurrence {
  return {
    key: `e:${i.event.id}:${i.date}`,
    kind: "event",
    source: "event",
    id: i.event.id,
    title: i.title,
    allDay: i.allDay,
    startAt: i.startAt,
    endAt: i.endAt,
    ...(i.allDay ? { startDate: i.start, endDate: i.end } : {}),
    recurring: !!i.event.recurrence,
    occurrenceDate: i.date,
    edited: i.edited,
    hasReminder: !!i.event.reminder,
    status: i.endAt <= now ? "past" : "upcoming",
  };
}

/** The event's fields with an edit applied, as a create would take them. */
function merge(event: Pick<CalendarEvent, "title" | "notes" | "allDay" | "start" | "end" | "timeZone" | "recurrence" | "reminder">, changes: EventChanges): CalendarEventInput {
  return {
    title: changes.title ?? event.title,
    notes: changes.notes !== undefined ? changes.notes : event.notes,
    allDay: changes.allDay ?? event.allDay,
    start: changes.start ?? event.start,
    end: changes.end ?? event.end,
    timeZone: changes.timeZone ?? event.timeZone,
    recurrence: changes.recurrence !== undefined ? changes.recurrence : event.recurrence,
    reminder: changes.reminder !== undefined ? changes.reminder : event.reminder,
  };
}

function shiftDate(date: string, days: number): string {
  return days ? formatDate(addDays(parseDate(date)!, days)) : date;
}

/** An exception carried along when its series moves by whole days: its key and its own times. */
function shiftException(e: CalendarException, days: number): CalendarException {
  const shift = (text: string | null | undefined) => (text ? shiftDate(text.slice(0, 10), days) + text.slice(10) : text);
  return { ...e, date: shiftDate(e.date, days), start: shift(e.start), end: shift(e.end) };
}

function rotateWeekdays(days: number[], shift: number): number[] {
  return [...new Set(days.map((d) => (((d + shift) % 7) + 7) % 7))];
}

function sameRule(a: CalendarRecurrence | null, b: CalendarRecurrence, start: CivilDate): boolean {
  return !!a && JSON.stringify(normalizeRecurrence(a, start)) === JSON.stringify(normalizeRecurrence(b, start));
}

/** Whether an instant is one of a cron's own slots. */
function isSlotOf(cron: string, slotAt: number): boolean {
  try {
    return nextRun(cron, slotAt - 60_000) === slotAt;
  } catch {
    return false;
  }
}
