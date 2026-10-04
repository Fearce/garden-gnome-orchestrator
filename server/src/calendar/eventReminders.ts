// When an event instance's reminder is due, whether it still should go out, and what it says.

import type { EventInstance } from "./instances.js";
import type { CalendarReminder } from "./types.js";
import { addDays, parseClock, parseDate, wallToEpoch } from "./zoned.js";

/** A reminder that comes due while the owner's server is down still goes out on the next tick, until
 *  this long after it was due or the event ends, whichever is later. */
export const LATE_GRACE_MS = 60 * 60_000;
/** Discord's message cap, minus room for the title line the DM adds. */
const TEXT_MAX = 1800;

/** The instant a reminder for this instance is due. */
export function remindAt(reminder: CalendarReminder, instance: EventInstance): number {
  if (reminder.kind === "before") return instance.startAt - reminder.minutes * 60_000;
  const day = addDays(parseDate(instance.start.slice(0, 10))!, -reminder.daysBefore);
  const minutes = parseClock(reminder.time) ?? 9 * 60;
  return wallToEpoch({ ...day, hh: Math.floor(minutes / 60), mi: minutes % 60 }, instance.event.timeZone);
}

/**
 * Whether the reminder should go out at `now`. It must be due, not hopelessly late, and not for an
 * occurrence the owner saved after it had both started and passed its reminder time: creating a
 * meeting that is already under way must not ping about it.
 */
export function reminderDue(dueAt: number, instance: EventInstance, now: number): boolean {
  if (dueAt > now) return false;
  if (now >= Math.max(instance.endAt, dueAt + LATE_GRACE_MS)) return false;
  return !(instance.startAt <= instance.savedAt && dueAt <= instance.savedAt);
}

const dateFmt = (timeZone: string) => new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "long", day: "numeric", month: "long" });
const timeFmt = (timeZone: string) => new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** The DM body: when it is, then the event's own notes. */
export function reminderText(instance: EventInstance): string {
  const tz = instance.event.timeZone;
  let when: string;
  if (instance.allDay) {
    const first = dateFmt("UTC").format(Date.parse(`${instance.start}T00:00:00Z`));
    const last = dateFmt("UTC").format(Date.parse(`${instance.end}T00:00:00Z`));
    when = instance.start === instance.end ? `All day ${first}.` : `All day, ${first} to ${last}.`;
  } else {
    const time = timeFmt(tz).format(instance.startAt);
    const end = instance.endAt === instance.startAt ? " (end not specified)" : `–${timeFmt(tz).format(instance.endAt)}`;
    when = `${time}${end} on ${dateFmt(tz).format(instance.startAt)} (${tz}).`;
  }
  const text = instance.notes ? `${when}\n\n${instance.notes}` : when;
  return text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX - 1)}…` : text;
}
