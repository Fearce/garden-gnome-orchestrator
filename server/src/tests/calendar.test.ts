// Deterministic test for the calendar: time-zone math, recurrence, scoped edits, persistence, event
// reminders, schedules shown on the grid, and the HTTP API's auth. No network, no agents: a temp DB, a
// recording dispatch that must never be called by anything calendar-only, and a fake reminder channel.
// Every title and note is synthetic. Run: `npm run test:calendar`.

process.env.TZ = "Europe/Copenhagen";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { Db } from "../db/db.js";
import { EventHub } from "../events.js";
import { Scheduler } from "../orchestrator/scheduler.js";
import { forEachRun, nextRun, shiftCron } from "../orchestrator/cron.js";
import type { ReminderChannel } from "../orchestrator/reminderDelivery.js";
import type { DispatchInput } from "../orchestrator/api.js";
import { CalendarService } from "../calendar/calendarService.js";
import { registerCalendarRoutes } from "../calendar/routes.js";
import { occurrenceDates } from "../calendar/recurrence.js";
import type { CalendarOccurrence, CalendarRange } from "../calendar/types.js";
import { epochToWall, formatDate, formatDateTime, parseDate, wallToEpoch, dayNumber, addDays } from "../calendar/zoned.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

const CPH = "Europe/Copenhagen";
const NY = "America/New_York";
const dates = (list: { y: number; m: number; d: number }[]) => list.map(formatDate);
const at = (iso: string) => Date.parse(iso);

const dir = mkdtempSync(join(tmpdir(), "calendar-test-"));
const dbPath = join(dir, "t.sqlite");
let db = new Db(dbPath);
const hub = new EventHub();
const dispatched: DispatchInput[] = [];
const dispatch = async (input: DispatchInput): Promise<string> => {
  dispatched.push(input);
  return `thread-${dispatched.length}`;
};
const sent: { title: string; text: string }[] = [];
const reminders: ReminderChannel = {
  ready: () => true,
  send: async (title, text) => {
    sent.push({ title, text });
    return { ok: true };
  },
  fallback: () => {},
};
let clock = at("2026-10-05T08:00:00+02:00");
let scheduler = new Scheduler(db, hub, dispatch, reminders);
let calendar = new CalendarService(db, hub, scheduler, reminders, { now: () => clock, retryMs: [] });
let changedEvents = 0;
hub.subscribe((e) => {
  if (e.type === "calendar.changed") changedEvents++;
});

const settle = () => new Promise((r) => setTimeout(r, 10));

function range(from: string, to: string, tz = CPH): CalendarRange {
  const r = calendar.range(from, to, tz);
  if (typeof r === "string") throw new Error(r);
  return r;
}
const eventsIn = (r: CalendarRange) => r.occurrences.filter((o) => o.kind === "event");
const wallOf = (o: CalendarOccurrence, tz = CPH) => formatDateTime(epochToWall(o.startAt, tz));

function zones(): void {
  console.log("zoned: DST edges");
  // Spring forward in Copenhagen: 2026-03-29 02:00 → 03:00. 02:30 does not exist and moves to 03:30.
  const gap = wallToEpoch({ y: 2026, m: 3, d: 29, hh: 2, mi: 30 }, CPH);
  check("a time in the spring-forward gap moves forward by the gap", formatDateTime(epochToWall(gap, CPH)) === "2026-03-29T03:30", formatDateTime(epochToWall(gap, CPH)));
  // Fall back: 2026-10-25 03:00 → 02:00, so 02:30 happens twice; the first (summer time, UTC+2) wins.
  const twice = wallToEpoch({ y: 2026, m: 10, d: 25, hh: 2, mi: 30 }, CPH);
  check("a repeated fall-back time resolves to its first instance", twice === at("2026-10-25T00:30:00Z"), new Date(twice).toISOString());
  check("an ordinary wall time round-trips", formatDateTime(epochToWall(wallToEpoch({ y: 2026, m: 7, d: 1, hh: 9, mi: 15 }, NY), NY)) === "2026-07-01T09:15");
  check("New York midnight is 04:00 UTC in summer", wallToEpoch({ y: 2026, m: 7, d: 1, hh: 0, mi: 0 }, NY) === at("2026-07-01T04:00:00Z"));
}

function recurrence(): void {
  console.log("recurrence: date generation");
  const mon = parseDate("2026-10-05")!; // a Monday
  const through = (d: string) => dayNumber(parseDate(d)!);
  check(
    "weekly on Mon+Thu every 2 weeks keeps both days in the on-week",
    dates(occurrenceDates({ freq: "weekly", interval: 2, weekdays: [4] }, mon, through("2026-10-31"))).join() === "2026-10-05,2026-10-08,2026-10-19,2026-10-22",
  );
  const jan31 = parseDate("2026-01-31")!;
  check(
    "monthly on the 31st skips the months without one",
    dates(occurrenceDates({ freq: "monthly", interval: 1 }, jan31, through("2026-06-30"))).join() === "2026-01-31,2026-03-31,2026-05-31",
  );
  const secondTue = parseDate("2026-10-13")!;
  check(
    "monthly on the 2nd Tuesday",
    dates(occurrenceDates({ freq: "monthly", interval: 1, monthlyBy: "nthWeekday" }, secondTue, through("2026-12-31"))).join() === "2026-10-13,2026-11-10,2026-12-08",
  );
  const lastFri = parseDate("2026-10-30")!;
  check(
    "monthly on the last Friday",
    dates(occurrenceDates({ freq: "monthly", interval: 1, monthlyBy: "lastWeekday" }, lastFri, through("2027-01-31"))).join() === "2026-10-30,2026-11-27,2026-12-25,2027-01-29",
  );
  const leap = parseDate("2024-02-29")!;
  check("yearly on 29 February only lands in leap years", dates(occurrenceDates({ freq: "yearly", interval: 1 }, leap, through("2032-12-31"))).join() === "2024-02-29,2028-02-29,2032-02-29");
  check("count bounds a series", occurrenceDates({ freq: "daily", interval: 1, count: 3 }, mon, through("2027-01-01")).length === 3);
  check("until is inclusive", dates(occurrenceDates({ freq: "daily", interval: 3, until: "2026-10-11" }, mon, through("2027-01-01"))).join() === "2026-10-05,2026-10-08,2026-10-11");
}

function cronHelpers(): void {
  console.log("cron: calendar helpers");
  const from = at("2026-10-05T00:00:00+02:00");
  const to = at("2026-10-12T00:00:00+02:00");
  const slots: number[] = [];
  forEachRun("30 9 * * 1-5", from, to, (ms) => (slots.push(ms), true));
  let agrees = slots.length === 5;
  let cursor = from - 60_000;
  for (const slot of slots) {
    agrees &&= nextRun("30 9 * * 1-5", cursor) === slot;
    cursor = slot;
  }
  check("forEachRun visits exactly the slots nextRun would fire", agrees, slots.map((s) => new Date(s).toISOString()));
  let dense = 0;
  forEachRun("* * * * *", from, to, () => (dense++, true));
  check("an every-minute schedule over a week is walked in full", dense === 7 * 1440, dense);
  // 02:10 in the repeated hour of the 25 October fall-back: stepping a local minute lands an hour back.
  const repeated = at("2026-10-25T02:10:00+01:00");
  const after = nextRun("30 2 * * *", repeated)!;
  check("nextRun never answers a time before its start at fall-back", after > repeated, new Date(after).toISOString());
  const early: number[] = [];
  forEachRun("*/5 2 * * *", repeated, repeated + 3 * 3_600_000, (ms) => (early.push(ms), true));
  check("forEachRun never visits a slot before its range at fall-back", early.every((ms) => ms >= repeated), early.map((s) => new Date(s).toISOString()));
  check("shifting a weekday cron across midnight carries the weekdays", shiftCron("30 23 * * 1,3", 60) === "30 0 * * 2,4");
  check("shifting a monthly cron across a day is refused", shiftCron("0 9 1 * *", -600) === null);
  check("shifting a stepped cron is refused", shiftCron("*/5 * * * *", 30) === null);
}

function eventsCrudAndPersistence(): string {
  console.log("calendar: create, read, persist");
  const created = calendar.createEvent({
    title: "Synthetic standup",
    notes: "Test notes",
    allDay: false,
    start: "2026-10-05T09:00",
    end: "2026-10-05T09:30",
    timeZone: CPH,
    recurrence: { freq: "weekly", interval: 1, weekdays: [1, 3] },
    reminders: [{ kind: "before", minutes: 10 }],
  });
  check("a valid event is created", created.ok && !!created.event, created.error);
  check("a create announces calendar.changed", changedEvents === 1);
  const id = created.event!.id;
  check("bad input is refused with a reason", calendar.createEvent({ title: " ", allDay: false, start: "2026-10-05T09:00", end: "2026-10-05T08:00", timeZone: CPH }).error === "A title is required.");
  check("an end before the start is refused", !calendar.createEvent({ title: "x", allDay: false, start: "2026-10-05T09:00", end: "2026-10-05T08:00", timeZone: CPH }).ok);
  const badZone = calendar.createEvent({ title: "x", allDay: true, start: "2026-10-05", end: "2026-10-05", timeZone: "Mars/Olympus" });
  check("an unknown time zone is refused without echoing it", !badZone.ok && !badZone.error!.includes("Olympus"), badZone.error);
  check("…on reads too", !String(calendar.range("2026-10-05", "2026-10-05", "Mars/Olympus")).includes("Olympus"));

  const week = range("2026-10-05", "2026-10-11");
  const standups = eventsIn(week).filter((o) => o.id === id);
  check("the weekly series shows Monday and Wednesday", standups.map((o) => o.occurrenceDate).join() === "2026-10-05,2026-10-07");
  check("occurrences sit at their local wall time", standups.every((o) => wallOf(o).endsWith("T09:00")));

  // Across the 25 October fall-back the meeting stays at 09:00 local, so its UTC instant moves by an hour.
  const after = eventsIn(range("2026-10-26", "2026-10-26")).find((o) => o.id === id)!;
  check("a weekly event keeps its wall time across DST", wallOf(after) === "2026-10-26T09:00" && new Date(after.startAt).toISOString() === "2026-10-26T08:00:00.000Z");

  // The same event seen from New York lands six hours earlier on the same day.
  const ny = eventsIn(range("2026-10-05", "2026-10-05", NY)).find((o) => o.id === id)!;
  check("viewing from another zone converts the time", wallOf(ny, NY) === "2026-10-05T03:00");

  const allDay = calendar.createEvent({ title: "Synthetic trip", allDay: true, start: "2026-10-09", end: "2026-10-11", timeZone: CPH });
  const trip = eventsIn(range("2026-10-10", "2026-10-10", NY)).find((o) => o.id === allDay.event!.id);
  check("an all-day span shows on its dates from any zone", trip?.startDate === "2026-10-09" && trip.endDate === "2026-10-11");

  console.log("calendar: unspecified end");
  const point = calendar.createEvent({ title: "Synthetic start-only event", allDay: false, start: "2027-03-15T00:00", end: "2027-03-15T00:00", timeZone: CPH, reminders: [], recurrence: { freq: "weekly", interval: 1 } });
  check("a start-only event is accepted", point.ok, point.error);
  const pointId = point.event!.id;
  const pointOn = (date: string, zone = CPH) => eventsIn(range(date, date, zone)).find((o) => o.id === pointId);
  const first = pointOn("2027-03-15");
  check("a midnight start-only event belongs to its starting day", !!first && first.endAt === first.startAt && !pointOn("2027-03-14"));
  check("a start-only event moves to the correct day in another zone", !!pointOn("2027-03-14", NY) && !pointOn("2027-03-15", NY));
  const next = pointOn("2027-03-29");
  check("start-only recurrence retains its wall time across DST", !!next && next.startAt === next.endAt && wallOf(next) === "2027-03-29T00:00");
  const movedPoint = calendar.updateEvent(pointId, "occurrence", "2027-03-29", { start: "2027-03-30T18:30", end: "2027-03-30T18:30" });
  check("a start-only occurrence can be moved without acquiring an end", movedPoint.ok && !pointOn("2027-03-29") && pointOn("2027-03-30")?.startAt === pointOn("2027-03-30")?.endAt);

  console.log("calendar: survives a restart");
  db.raw.close();
  db = new Db(dbPath);
  scheduler = new Scheduler(db, hub, dispatch, reminders);
  calendar = new CalendarService(db, hub, scheduler, reminders, { now: () => clock, retryMs: [] });
  check("the unspecified end survives reopening the database", calendar.getEvent(pointId)?.end === calendar.getEvent(pointId)?.start);
  const reread = calendar.getEvent(id);
  check("the event reads back after reopening the database", reread?.title === "Synthetic standup" && reread.recurrence?.freq === "weekly" && reread.reminders[0]?.kind === "before");
  calendar.deleteEvent(allDay.event!.id, "series");
  return id;
}

function scopedEdits(id: string): void {
  console.log("calendar: this occurrence / following / all");
  const moved = calendar.updateEvent(id, "occurrence", "2026-10-07", { start: "2026-10-08T14:00", end: "2026-10-08T15:00", title: "Moved standup" });
  check("one occurrence can move to another day", moved.ok, moved.error);
  const wk = eventsIn(range("2026-10-05", "2026-10-11")).filter((o) => o.id === id);
  check(
    "the moved occurrence shows on its new day and nowhere else",
    wk.length === 2 && wk[1]!.occurrenceDate === "2026-10-07" && wallOf(wk[1]!) === "2026-10-08T14:00" && wk[1]!.title === "Moved standup" && wk[1]!.edited === true,
  );
  check("an occurrence edit cannot change the series' repeat", !calendar.updateEvent(id, "occurrence", "2026-10-12", { recurrence: null }).ok);
  check("a date the series never generates is refused", !calendar.updateEvent(id, "occurrence", "2026-10-06", { title: "x" }).ok);

  const cancelled = calendar.deleteEvent(id, "occurrence", "2026-10-12");
  check("one occurrence can be cancelled", cancelled.ok && eventsIn(range("2026-10-12", "2026-10-12")).every((o) => o.id !== id));

  const split = calendar.updateEvent(id, "following", "2026-10-14", { start: "2026-10-14T10:00", end: "2026-10-14T10:30" });
  check("this-and-following makes a new series", split.ok && split.event!.id !== id, split.error);
  const tail = split.event!;
  const old = calendar.getEvent(id)!;
  check("the original series now ends the day before", old.recurrence?.until === "2026-10-13");
  check("the moved occurrence before the split stays with the original", old.exceptions.some((e) => e.date === "2026-10-07"));
  const later = eventsIn(range("2026-10-14", "2026-10-21"));
  check(
    "the new series runs at the new time, the old one stops",
    later.filter((o) => o.id === tail.id).every((o) => wallOf(o).endsWith("T10:00")) && later.every((o) => o.id !== id) && later.filter((o) => o.id === tail.id).length === 3,
  );

  // A count-limited series hands over what it had left.
  const counted = calendar.createEvent({ title: "Synthetic course", allDay: false, start: "2026-11-02T18:00", end: "2026-11-02T19:00", timeZone: CPH, recurrence: { freq: "weekly", interval: 1, count: 6 } });
  const second = calendar.updateEvent(counted.event!.id, "following", "2026-11-16", { title: "Synthetic course (room B)" });
  check("a split of a 6-count series leaves 2 + 4", second.ok && second.event!.recurrence?.count === 4 && calendar.getEvent(counted.event!.id)!.recurrence?.until === "2026-11-15");

  const whole = calendar.updateEvent(tail.id, "series", null, { start: "2026-10-15T10:00", end: "2026-10-15T10:30" });
  check("a whole-series edit moves every occurrence", whole.ok && eventsIn(range("2026-10-14", "2026-10-14")).every((o) => o.id !== tail.id), whole.error);

  check("deleting following from the first occurrence deletes the series", calendar.deleteEvent(counted.event!.id, "following", "2026-11-02").ok && !calendar.getEvent(counted.event!.id));
  calendar.deleteEvent(second.event!.id, "series");
  calendar.deleteEvent(tail.id, "series");
}

function editEdgeCases(): void {
  console.log("calendar: edit edge cases");
  // The edit form sends every field back, the unchanged repeat rule included.
  const course = calendar.createEvent({ title: "Synthetic lesson", allDay: false, start: "2026-11-02T18:00", end: "2026-11-02T19:00", timeZone: CPH, recurrence: { freq: "weekly", interval: 1, count: 6 } });
  const rule = course.event!.recurrence;
  const rest = calendar.updateEvent(course.event!.id, "following", "2026-11-16", { title: "Synthetic lesson (moved)", recurrence: rule });
  check("a split given the unchanged rule still hands over only what was left", rest.ok && rest.event!.recurrence?.count === 4, rest.event?.recurrence);
  calendar.deleteEvent(course.event!.id, "series");
  if (rest.event) calendar.deleteEvent(rest.event.id, "series");

  // UTC+14 against UTC-11: the event's own day and the viewer's day share no instant at all.
  const far = calendar.createEvent({ title: "Synthetic far day", allDay: true, start: "2026-12-10", end: "2026-12-10", timeZone: "Pacific/Kiritimati" });
  const seen = eventsIn(range("2026-12-10", "2026-12-10", "Pacific/Pago_Pago")).some((o) => o.id === far.event!.id);
  check("an all-day event shows on its date from the opposite side of the date line", seen);
  check("…and not on the day before", !eventsIn(range("2026-12-09", "2026-12-09", "Pacific/Pago_Pago")).some((o) => o.id === far.event!.id));
  calendar.deleteEvent(far.event!.id, "series");

  const weekly = calendar.createEvent({ title: "Synthetic review", allDay: false, start: "2026-11-03T09:00", end: "2026-11-03T10:00", timeZone: CPH, recurrence: { freq: "weekly", interval: 1 } });
  const wid = weekly.event!.id;
  calendar.updateEvent(wid, "occurrence", "2026-11-10", { start: "2026-11-10T15:00", end: "2026-11-10T16:00" });
  calendar.updateEvent(wid, "series", null, { start: "2026-11-04T09:00", end: "2026-11-04T10:00" });
  const moved = calendar.getEvent(wid)!.exceptions.find((e) => e.date === "2026-11-11");
  check("moving a series by a day moves an edited occurrence's own time with it", moved?.start === "2026-11-11T15:00" && moved.end === "2026-11-11T16:00", calendar.getEvent(wid)!.exceptions);
  const onEleventh = eventsIn(range("2026-11-11", "2026-11-11")).find((o) => o.id === wid);
  check("…so it shows on its new date at its own time", !!onEleventh && wallOf(onEleventh) === "2026-11-11T15:00");
  check("…and nothing is left on the old date", !eventsIn(range("2026-11-10", "2026-11-10")).some((o) => o.id === wid));
  calendar.deleteEvent(wid, "series");

  // 02:30 does not exist in New York on 14 March 2027: the start moves to 03:30, the length stays.
  const night = calendar.createEvent({ title: "Synthetic night job", allDay: false, start: "2027-03-07T02:30", end: "2027-03-07T03:15", timeZone: NY, recurrence: { freq: "weekly", interval: 1 } });
  const gap = eventsIn(range("2027-03-14", "2027-03-14", NY)).find((o) => o.id === night.event!.id);
  check("an occurrence in the spring-forward gap keeps its length", !!gap && gap.endAt - gap.startAt === 45 * 60_000, gap && (gap.endAt - gap.startAt) / 60_000);
  calendar.deleteEvent(night.event!.id, "series");

  for (const [start, end, elapsedMinutes] of [
    ["2027-03-14T01:30", "2027-03-14T03:30", 60],
    ["2027-11-07T00:30", "2027-11-07T02:30", 180],
    ["2027-03-13T23:30", "2027-03-14T04:30", 240],
  ] as const) {
    const crossing = calendar.createEvent({ title: "Synthetic clock change", allDay: false, start, end, timeZone: NY });
    const occurrence = eventsIn(range(start.slice(0, 10), end.slice(0, 10), NY)).find((o) => o.id === crossing.event!.id)!;
    check(`a DST-spanning event keeps its requested end (${start})`, formatDateTime(epochToWall(occurrence.endAt, NY)) === end && occurrence.endAt - occurrence.startAt === elapsedMinutes * 60_000);
    calendar.deleteEvent(crossing.event!.id, "series");
  }

  // Dragging "this and following" inherits the weekly rule, shifted by the moved days.
  // Test both the drag payload (no rule) and the form payload (unchanged rule).
  for (const includeRule of [false, true]) {
    const series = calendar.createEvent({ title: "Synthetic shifted lesson", allDay: false, start: "2026-11-02T09:00", end: "2026-11-02T10:00", timeZone: CPH, recurrence: { freq: "weekly", interval: 1, weekdays: [1, 3], count: 8 } }).event!;
    calendar.deleteEvent(series.id, "occurrence", "2026-11-16");
    const tail = calendar.updateEvent(series.id, "following", "2026-11-09", { start: "2026-11-10T09:00", end: "2026-11-10T10:00", ...(includeRule ? { recurrence: series.recurrence } : {}) }).event!;
    const occurrences = eventsIn(range("2026-11-09", "2026-11-30")).filter((o) => o.id === tail.id);
    check(`moving following shifts only inherited weekdays (${includeRule ? "form" : "drag"})`, JSON.stringify(tail.recurrence?.weekdays) === "[2,4]", tail.recurrence);
    check("the split preserves its remaining count and shifted cancellation", tail.recurrence?.count === 6 && tail.exceptions.some((e) => e.date === "2026-11-17" && e.cancelled));
    check("the moved tail has no old-weekday or duplicate occurrences", occurrences.map((o) => wallOf(o).slice(0, 10)).join() === "2026-11-10,2026-11-12,2026-11-19,2026-11-24,2026-11-26", occurrences.map((o) => wallOf(o)));
    calendar.deleteEvent(series.id, "series");
    calendar.deleteEvent(tail.id, "series");
  }
}

async function eventReminders(id: string): Promise<void> {
  console.log("calendar: event reminders");
  sent.length = 0;
  // 08:49 on Monday 5 Oct: the 09:00 standup's 10-minute reminder is not due yet.
  clock = at("2026-10-05T08:49:00+02:00");
  check("nothing is sent before the reminder is due", calendar.tick() === 0);
  clock = at("2026-10-05T08:50:30+02:00");
  check("the reminder goes out once it is due", calendar.tick() === 1);
  await settle();
  check("…through the direct reminder channel, with the time in the text", sent.length === 1 && sent[0]!.title === "Synthetic standup" && sent[0]!.text.includes("09:00"), sent);
  check("a second tick does not repeat it", calendar.tick() === 0);

  // Move the next occurrence later: its reminder follows it, the old time never fires.
  calendar.updateEvent(id, "occurrence", "2026-10-07", { start: "2026-10-07T11:00", end: "2026-10-07T11:30" });
  clock = at("2026-10-07T08:51:00+02:00");
  check("no reminder at the moved occurrence's old time", calendar.tick() === 0);
  clock = at("2026-10-07T10:51:00+02:00");
  check("the reminder fires at the moved time", calendar.tick() === 1);

  // A deleted event leaves nothing behind.
  const gone = calendar.createEvent({ title: "Synthetic dentist", allDay: false, start: "2026-10-07T12:00", end: "2026-10-07T13:00", timeZone: CPH, reminders: [{ kind: "before", minutes: 30 }] });
  calendar.deleteEvent(gone.event!.id, "series");
  clock = at("2026-10-07T11:31:00+02:00");
  check("a deleted event's reminder never fires", calendar.tick() === 0);

  // Created while already under way: no ping about something that has started.
  clock = at("2026-10-07T12:10:00+02:00");
  calendar.createEvent({ title: "Synthetic running meeting", allDay: false, start: "2026-10-07T12:00", end: "2026-10-07T13:00", timeZone: CPH, reminders: [{ kind: "before", minutes: 15 }] });
  check("an event saved after it started does not remind", calendar.tick() === 0);

  // Starts in five minutes with a fifteen-minute lead: the reminder is late but useful, so it goes now.
  calendar.createEvent({ title: "Synthetic soon", allDay: false, start: "2026-10-07T12:15", end: "2026-10-07T12:45", timeZone: CPH, reminders: [{ kind: "before", minutes: 15 }] });
  check("an event saved inside its reminder lead reminds at once", calendar.tick() === 1);

  // An all-day event's "the day before at 18:00" reminder, in its own zone.
  calendar.createEvent({ title: "Synthetic birthday", allDay: true, start: "2026-10-09", end: "2026-10-09", timeZone: CPH, reminders: [{ kind: "day", daysBefore: 1, time: "18:00" }] });
  clock = at("2026-10-08T17:59:00+02:00");
  check("an all-day reminder waits for its clock time", calendar.tick() === 0);
  clock = at("2026-10-08T18:00:30+02:00");
  check("…and goes out at 18:00 the day before", calendar.tick() === 1);
  await settle();
  check("its text names the day", sent.at(-1)!.text.startsWith("All day Friday 9 October"), sent.at(-1));

  check("no calendar event ever dispatched a task", dispatched.length === 0);
  check("no event created a scheduled task", scheduler.list().length === 0);
}

async function reminderFreshness(): Promise<void> {
  console.log("calendar: reminders stay fresh");
  const sentFor = (title: string) => sent.filter((s) => s.title === title).length;

  // Editing one occurrence must not change what the series' other occurrences remind about.
  const market = calendar.createEvent({ title: "Synthetic market", allDay: true, start: "2026-11-07", end: "2026-11-07", timeZone: CPH, recurrence: { freq: "weekly", interval: 1 }, reminders: [{ kind: "day", daysBefore: 0, time: "09:00" }] });
  clock = at("2026-11-07T09:00:10+01:00");
  calendar.updateEvent(market.event!.id, "occurrence", "2026-11-14", { title: "Synthetic market, late opening" });
  calendar.tick();
  await settle();
  check("editing next week's occurrence leaves today's due reminder alone", sentFor("Synthetic market") === 1, sent.slice(-2));
  clock = at("2026-11-14T09:00:10+01:00");
  calendar.updateEvent(market.event!.id, "occurrence", "2026-11-14", { notes: "Synthetic: bring a bag" });
  calendar.tick();
  await settle();
  check("…while the occurrence just edited under way does not ping", sentFor("Synthetic market, late opening") === 0);
  calendar.deleteEvent(market.event!.id, "series");

  // A long event stays remindable for its whole span, so its sent record must outlive the span.
  clock = at("2027-01-01T08:00:00+01:00");
  const leave = calendar.createEvent({ title: "Synthetic sabbatical", allDay: true, start: "2027-01-01", end: "2027-04-30", timeZone: CPH, reminders: [{ kind: "day", daysBefore: 0, time: "09:00" }] });
  clock = at("2027-01-01T09:00:30+01:00");
  calendar.tick();
  clock = at("2027-03-15T12:00:00+01:00");
  calendar.tick();
  calendar.tick();
  await settle();
  check("a long event reminds once, even after the daily log prune", sentFor("Synthetic sabbatical") === 1, sentFor("Synthetic sabbatical"));
  calendar.deleteEvent(leave.event!.id, "series");

  // A failed DM is retried, but a retry must deliver the event as it is now, or not at all.
  let refuse = 0;
  const attempts: string[] = [];
  const flaky: ReminderChannel = {
    ready: () => true,
    send: async (title) => {
      attempts.push(title);
      return refuse-- > 0 ? { ok: false, message: "HTTP 500" } : { ok: true };
    },
    fallback: () => {},
  };
  const retrying = new CalendarService(db, hub, scheduler, flaky, { now: () => clock, retryMs: [50] });
  const afterRetry = () => new Promise((r) => setTimeout(r, 120));
  const failOnce = async (title: string, startHour: number): Promise<string> => {
    clock = at(`2027-05-03T08:00:00+02:00`);
    const hh = String(startHour).padStart(2, "0");
    const id = retrying.createEvent({ title, allDay: false, start: `2027-05-03T${hh}:00`, end: `2027-05-03T${hh}:30`, timeZone: CPH, reminders: [{ kind: "before", minutes: 30 }] }).event!.id;
    clock = at(`2027-05-03T${String(startHour - 1).padStart(2, "0")}:30:10+02:00`);
    refuse = 1;
    attempts.length = 0;
    retrying.tick();
    await settle();
    return id;
  };
  const deleted = await failOnce("Synthetic cancelled call", 10);
  retrying.deleteEvent(deleted, "series");
  await afterRetry();
  check("a deleted event's failed reminder is not retried", attempts.join() === "Synthetic cancelled call", attempts);
  const renamed = await failOnce("Synthetic old name", 12);
  retrying.updateEvent(renamed, "series", null, { title: "Synthetic new name" });
  await afterRetry();
  check("a retry carries the event's current title", attempts.join() === "Synthetic old name,Synthetic new name", attempts);
  retrying.deleteEvent(renamed, "series");
  const moved = await failOnce("Synthetic moved call", 14);
  retrying.updateEvent(moved, "series", null, { start: "2027-05-03T17:00", end: "2027-05-03T17:30" });
  await afterRetry();
  check("a moved event's retry is dropped (its new time is a new reminder)", attempts.join() === "Synthetic moved call", attempts);
  retrying.deleteEvent(moved, "series");
}

async function severalAndDefaultReminders(): Promise<void> {
  console.log("calendar: several reminders and the owner's defaults");
  const sentFor = (title: string) => sent.filter((s) => s.title === title).length;
  clock = at("2027-06-01T08:00:00+02:00");
  const ferry = calendar.createEvent({ title: "Synthetic ferry", allDay: false, start: "2027-06-10T10:00", end: "2027-06-10T11:00", timeZone: CPH, reminders: [{ kind: "before", minutes: 1440 }, { kind: "before", minutes: 7 * 1440 }] });
  check("an event keeps several reminders, longest lead first", JSON.stringify(ferry.event?.reminders) === JSON.stringify([{ kind: "before", minutes: 7 * 1440 }, { kind: "before", minutes: 1440 }]), ferry.event?.reminders);
  clock = at("2027-06-03T10:00:30+02:00");
  calendar.tick();
  clock = at("2027-06-09T10:00:30+02:00");
  calendar.tick();
  calendar.tick();
  await settle();
  check("each reminder goes out once, at its own time", sentFor("Synthetic ferry") === 2, sentFor("Synthetic ferry"));
  calendar.deleteEvent(ferry.event!.id, "series");
  const six = [1, 2, 3, 4, 5, 6].map((minutes) => ({ kind: "before" as const, minutes }));
  check("at most five reminders per event", !calendar.createEvent({ title: "x", allDay: false, start: "2027-06-10T10:00", end: "2027-06-10T11:00", timeZone: CPH, reminders: six }).ok);

  const plain = { allDay: false, start: "2027-06-20T14:00", end: "2027-06-20T15:00", timeZone: CPH };
  const bare = calendar.createEvent({ title: "Synthetic before defaults", ...plain });
  check("with no defaults set, a new event gets no reminder", calendar.defaults().reminderLeads.length === 0 && bare.event!.reminders.length === 0);
  check("a negative lead is refused", !calendar.setDefaults({ reminderLeads: [-5], allDayTime: "09:00" }).ok);
  check("a malformed all-day time is refused", !calendar.setDefaults({ reminderLeads: [60], allDayTime: "9am" }).ok);
  check("more than five defaults are refused", !calendar.setDefaults({ reminderLeads: [1, 2, 3, 4, 5, 6], allDayTime: "09:00" }).ok);
  check("defaults can be set", calendar.setDefaults({ reminderLeads: [1440, 7 * 1440, 1440], allDayTime: "08:30" }).ok);
  const reopened = new CalendarService(db, hub, scheduler, reminders, { now: () => clock, retryMs: [] });
  check("…and persist, sorted and without duplicates", JSON.stringify(reopened.defaults()) === JSON.stringify({ reminderLeads: [7 * 1440, 1440], allDayTime: "08:30" }), reopened.defaults());
  const timed = calendar.createEvent({ title: "Synthetic check-up", ...plain });
  check("a timed event created without reminders gets the defaults", JSON.stringify(timed.event!.reminders) === JSON.stringify([{ kind: "before", minutes: 7 * 1440 }, { kind: "before", minutes: 1440 }]), timed.event!.reminders);
  const allDay = calendar.createEvent({ title: "Synthetic name day", allDay: true, start: "2027-06-21", end: "2027-06-21", timeZone: CPH });
  check(
    "an all-day event gets them as whole days before, at the default time",
    JSON.stringify(allDay.event!.reminders) === JSON.stringify([{ kind: "day", daysBefore: 7, time: "08:30" }, { kind: "day", daysBefore: 1, time: "08:30" }]),
    allDay.event!.reminders,
  );
  const none = calendar.createEvent({ title: "Synthetic no ping", ...plain, reminders: [] });
  check("an explicit empty list means no reminder", none.event!.reminders.length === 0);
  check("an edit never re-applies the defaults", calendar.updateEvent(none.event!.id, "series", null, { title: "Synthetic still no ping" }).event!.reminders.length === 0);
  const shown = range("2027-06-20", "2027-06-21");
  check("the range carries the defaults for the create form", shown.defaults.reminderLeads.length === 2 && shown.defaults.allDayTime === "08:30");
  for (const e of [bare, timed, allDay, none]) calendar.deleteEvent(e.event!.id, "series");
  calendar.setDefaults({ reminderLeads: [], allDayTime: "09:00" });
}

async function schedulesOnTheCalendar(): Promise<void> {
  console.log("calendar: schedules");
  // The scheduler runs on the real clock, so the calendar must too for its slots to line up.
  clock = Date.now();
  const ws = process.cwd();
  const daily = scheduler.create({ title: "Synthetic nightly", workspace: ws, prompt: "do work", cron: "0 3 * * *" });
  const remind = scheduler.create({ title: "Synthetic bin day", workspace: "", prompt: "", reminder: "Put the bins out", cron: "0 19 * * 2" });
  const paused = scheduler.create({ title: "Synthetic paused", workspace: ws, prompt: "x", cron: "0 4 * * *", enabled: false });
  const busy = scheduler.create({ title: "Synthetic every 5", workspace: ws, prompt: "x", cron: "*/5 * * * *" });
  const rowsBefore = scheduler.list().length;

  // Schedules are expanded from real now (the scheduler's own clock), so look at the coming week.
  const today = formatDate(epochToWall(Date.now(), CPH));
  const end = formatDate(epochToWall(Date.now() + 7 * 86_400_000, CPH));
  const r = range(today, end);
  const of = (id: string) => r.occurrences.filter((o) => o.id === id);
  check("a daily task shows each coming 03:00", of(daily.schedule!.id).length >= 6 && of(daily.schedule!.id).every((o) => o.kind === "task" && wallOf(o).endsWith("T03:00")));
  check("its first slot is the scheduler's own next run", of(daily.schedule!.id)[0]!.startAt === scheduler.list().find((s) => s.id === daily.schedule!.id)!.nextRunAt);
  check("a reminder-only schedule is a reminder", of(remind.schedule!.id).every((o) => o.kind === "reminder" && o.hasReminder));
  check("a disabled schedule's slots are marked paused", of(paused.schedule!.id).length > 0 && of(paused.schedule!.id).every((o) => o.status === "paused"));
  // After 23:00, today has too few remaining fires to qualify as dense. Use seven complete
  // future days so this assertion checks aggregation at every time of day, including near midnight.
  const todayDate = parseDate(today)!;
  const denseDays = range(formatDate(addDays(todayDate, 1)), formatDate(addDays(todayDate, 7))).occurrences.filter((o) => o.id === busy.schedule!.id);
  check("an every-5-minutes schedule collapses to one item a day", denseDays.length === 7 && denseDays.every((o) => o.count != null && o.allDay));
  check("viewing the calendar created no schedule and dispatched nothing", scheduler.list().length === rowsBefore && dispatched.length === 0);

  // Skip one fire: the tick must neither dispatch nor remind for that slot, then fire the next one.
  const target = of(daily.schedule!.id)[0]!;
  check("a run can be skipped", calendar.skipScheduleRun(daily.schedule!.id, target.slotAt!).ok);
  check("the skipped run shows as skipped", range(today, end).occurrences.find((o) => o.key === target.key)?.status === "skipped");
  const tick = () => (scheduler as unknown as { tick(): void }).tick();
  db.updateScheduledTask(daily.schedule!.id, { nextRunAt: target.slotAt! });
  // Pretend the slot is due by moving it into the past while keeping the skip keyed on it.
  db.unskipScheduleSlot(daily.schedule!.id, target.slotAt!);
  const due = Date.now() - 1000;
  db.updateScheduledTask(daily.schedule!.id, { nextRunAt: due });
  db.skipScheduleSlot(daily.schedule!.id, due);
  tick();
  await settle();
  check("a skipped slot does not dispatch", dispatched.length === 0);
  check("…and the schedule rolled on to its next slot", (db.getScheduledTask(daily.schedule!.id)!.nextRunAt ?? 0) > Date.now());
  db.updateScheduledTask(daily.schedule!.id, { nextRunAt: Date.now() - 1000 });
  tick();
  await settle();
  check("the following, unskipped slot dispatches as usual", dispatched.length === 1);

  // Move one run of the weekly reminder: skip + a run-once copy at the new time.
  const slot = of(remind.schedule!.id)[0]!;
  const moveTo = slot.slotAt! + 2 * 3_600_000;
  const moved = calendar.moveScheduleRun(remind.schedule!.id, slot.slotAt!, moveTo, "occurrence");
  check("one run of a recurring reminder can be moved", moved.ok, moved.error);
  const copy = scheduler.list().find((s) => s.runOnce && s.title === "Synthetic bin day");
  check("…as a run-once copy at the new time", copy?.nextRunAt === moveTo && copy.reminder === "Put the bins out" && copy.prompt === "");
  check("…with the original slot skipped", range(today, end).occurrences.find((o) => o.key === slot.key)?.status === "skipped");
  const series = calendar.moveScheduleRun(remind.schedule!.id, of(remind.schedule!.id)[1]?.slotAt ?? slot.slotAt!, slot.slotAt! + 3_600_000, "series");
  check("moving every run shifts the cron", series.ok && db.getScheduledTask(remind.schedule!.id)!.cron === "0 20 * * 2", db.getScheduledTask(remind.schedule!.id)!.cron);
  check("a stepped cron cannot be shifted", !calendar.moveScheduleRun(busy.schedule!.id, 0, 3_600_000, "series").ok);

  const pausedSlot = of(paused.schedule!.id)[0]!.slotAt!;
  check("one run of a paused schedule can move", calendar.moveScheduleRun(paused.schedule!.id, pausedSlot, pausedSlot + 3_600_000, "occurrence").ok);
  const pausedCopy = scheduler.list().find((s) => s.originId === paused.schedule!.id)!;
  check("moving a paused recurring run does not enable its copy", !pausedCopy.enabled && pausedCopy.nextRunAt == null);
  check("moving the paused one-off again keeps it paused", calendar.moveScheduleRun(pausedCopy.id, pausedSlot + 3_600_000, pausedSlot + 2 * 3_600_000, "occurrence").ok && !db.getScheduledTask(pausedCopy.id)!.enabled);

  // A run moved off a task schedule is still that schedule: it waits while the schedule's last run works.
  const working = db.createThread({ title: "Synthetic nightly", workspace: ws, brief: "do work", rawPrompt: "do work" });
  db.updateThread(working.id, { state: "implementing" });
  db.updateScheduledTask(daily.schedule!.id, { lastThreadId: working.id });
  const nightly = range(today, end).occurrences.filter((o) => o.id === daily.schedule!.id && o.status === "upcoming")[0]!;
  check("one run of a task can be moved", calendar.moveScheduleRun(daily.schedule!.id, nightly.slotAt!, nightly.slotAt! + 3_600_000, "occurrence").ok);
  const movedRun = scheduler.list().find((s) => s.runOnce && s.title === "Synthetic nightly")!;
  check("…and the moved run remembers its schedule", movedRun.originId === daily.schedule!.id);
  db.updateScheduledTask(movedRun.id, { nextRunAt: Date.now() - 1000 });
  const beforeMoved = dispatched.length;
  tick();
  await settle();
  check("a moved run waits while its schedule's previous run is still working", dispatched.length === beforeMoved && db.getScheduledTask(movedRun.id)!.enabled);
  db.updateThread(working.id, { state: "done" });
  tick();
  await settle();
  check("…and fires once that run has finished", dispatched.length === beforeMoved + 1);
  const copyThread = db.createThread({ title: "Synthetic nightly", workspace: ws, brief: "do work", rawPrompt: "do work" });
  db.updateThread(copyThread.id, { state: "qa" });
  db.updateScheduledTask(movedRun.id, { lastThreadId: copyThread.id });
  db.updateScheduledTask(daily.schedule!.id, { nextRunAt: Date.now() - 1000 });
  tick();
  await settle();
  check("the schedule in turn waits while its moved run is still working", dispatched.length === beforeMoved + 1);
  for (const s of scheduler.list()) scheduler.remove(s.id);
}

function migration(): void {
  console.log("calendar: existing databases");
  // An install from before the calendar has scheduled_tasks but none of the calendar tables.
  const legacyPath = join(dir, "legacy.sqlite");
  const legacy = new Db(legacyPath);
  const kept = new Scheduler(legacy, hub, dispatch, reminders).create({ title: "Synthetic legacy reminder", workspace: "", prompt: "", reminder: "hi", cron: "0 9 1 1 *", runOnce: true });
  legacy.raw.exec("DROP TABLE calendar_reminder_log; DROP TABLE calendar_event_exceptions; DROP TABLE calendar_events; DROP TABLE schedule_skips;");
  legacy.raw.close();
  const upgraded = new Db(legacyPath);
  const tables = (upgraded.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'calendar%'").all() as { name: string }[]).map((t) => t.name).sort();
  check("opening an old database adds the calendar tables", tables.join() === "calendar_event_exceptions,calendar_events,calendar_reminder_log");
  const upgradedScheduler = new Scheduler(upgraded, hub, dispatch, reminders);
  check("existing schedules survive untouched", upgradedScheduler.list().length === 1 && upgradedScheduler.list()[0]!.id === kept.schedule!.id && upgradedScheduler.list()[0]!.reminder === "hi");
  const cal = new CalendarService(upgraded, hub, upgradedScheduler, reminders);
  const next = upgradedScheduler.list()[0]!.nextRunAt!;
  const day = formatDate(epochToWall(next, CPH));
  const shown = cal.range(day, day, CPH);
  check("an existing reminder appears on the calendar without being copied", typeof shown !== "string" && shown.occurrences.some((o) => o.id === kept.schedule!.id && o.kind === "reminder") && upgradedScheduler.list().length === 1);
  upgraded.raw.close();

  // A calendar from before events took several reminders: one `reminder` column holding one object.
  const singlePath = join(dir, "single.sqlite");
  const single = new Db(singlePath);
  single.raw.exec("DROP TABLE calendar_reminder_log; DROP TABLE calendar_event_exceptions; DROP TABLE calendar_events;");
  single.raw.exec(`CREATE TABLE calendar_events (id TEXT PRIMARY KEY, title TEXT NOT NULL, notes TEXT, all_day INTEGER NOT NULL DEFAULT 0,
    start_at TEXT NOT NULL, end_at TEXT NOT NULL, time_zone TEXT NOT NULL, recurrence TEXT, reminder TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
  single.raw
    .prepare("INSERT INTO calendar_events VALUES('old', 'Synthetic old event', NULL, 1, '2027-02-01', '2027-02-01', ?, NULL, ?, 1, 1)")
    .run(CPH, JSON.stringify({ kind: "day", daysBefore: 7, time: "09:00" }));
  single.raw.close();
  const reopenedSingle = new Db(singlePath);
  const old = new CalendarService(reopenedSingle, hub, new Scheduler(reopenedSingle, hub, dispatch, reminders), reminders).getEvent("old");
  check("an event saved with one reminder reads back as a list of one", JSON.stringify(old?.reminders) === JSON.stringify([{ kind: "day", daysBefore: 7, time: "09:00" }]), old?.reminders);
  reopenedSingle.raw.close();
}

async function api(): Promise<void> {
  console.log("calendar: HTTP API");
  const app = Fastify({ logger: false });
  registerCalendarRoutes(app, calendar, (cookie) => cookie === "session=ok");
  await app.ready();
  const authed = { cookie: "session=ok", host: "localhost" };
  const anon = await app.inject({ method: "GET", url: "/api/calendar/range?from=2026-10-05&to=2026-10-11&tz=Europe/Copenhagen" });
  check("an unauthenticated read is refused", anon.statusCode === 401);
  const cross = await app.inject({ method: "POST", url: "/api/calendar/events", headers: { ...authed, "sec-fetch-site": "cross-site" }, payload: {} });
  check("a cross-site write is refused", cross.statusCode === 403);
  const foreign = await app.inject({ method: "POST", url: "/api/calendar/events", headers: { ...authed, origin: "http://evil.example" }, payload: {} });
  check("a foreign origin is refused", foreign.statusCode === 403);
  const sameSite = await app.inject({ method: "POST", url: "/api/calendar/events", headers: { ...authed, "sec-fetch-site": "same-site" }, payload: {} });
  check("a same-site (other port or subdomain) write is refused", sameSite.statusCode === 403);
  // The deck's proxy rewrites Host to the loopback listener but forwards the browser's Origin untouched.
  const proxied = { cookie: "session=ok", host: "127.0.0.1:4317", origin: "https://deck.example.com:3940", "sec-fetch-site": "same-origin" };
  const viaProxy = await app.inject({ method: "POST", url: "/api/calendar/events", headers: proxied, payload: { title: "Synthetic proxied event", allDay: true, start: "2026-10-22", end: "2026-10-22", timeZone: CPH } });
  const proxiedId = viaProxy.statusCode === 200 ? (JSON.parse(viaProxy.body) as { event: { id: string } }).event.id : "";
  check("a same-origin create through the deck's proxy succeeds", viaProxy.statusCode === 200 && !!proxiedId, viaProxy.body);
  const proxiedDelete = await app.inject({ method: "DELETE", url: `/api/calendar/events/${proxiedId || "none"}?scope=series`, headers: proxied });
  check("a same-origin delete through the deck's proxy succeeds", proxiedDelete.statusCode === 200 && !!proxiedId && !calendar.getEvent(proxiedId), proxiedDelete.body);
  const secret = "Synthetic private note 12345";
  const bad = await app.inject({ method: "POST", url: "/api/calendar/events", headers: authed, payload: { title: "x", notes: secret, allDay: "yes", start: "2026-10-05", end: "2026-10-05", timeZone: CPH } });
  check("a malformed body is a 400 that does not echo its content", bad.statusCode === 400 && !bad.body.includes(secret), bad.body);
  const ok = await app.inject({ method: "POST", url: "/api/calendar/events", headers: authed, payload: { title: "Synthetic API event", allDay: true, start: "2026-10-20", end: "2026-10-20", timeZone: CPH } });
  const id = (JSON.parse(ok.body) as { event: { id: string } }).event.id;
  check("an authenticated create succeeds", ok.statusCode === 200 && !!id);
  const read = await app.inject({ method: "GET", url: "/api/calendar/range?from=2026-10-20&to=2026-10-20&tz=Europe/Copenhagen", headers: authed });
  check("the range returns it", read.statusCode === 200 && (JSON.parse(read.body) as CalendarRange).occurrences.some((o) => o.id === id));
  const patch = await app.inject({ method: "PATCH", url: `/api/calendar/events/${id}`, headers: authed, payload: { scope: "series", changes: { start: "2026-10-21", end: "2026-10-21" } } });
  check("an authenticated edit succeeds", patch.statusCode === 200);
  const wide = await app.inject({ method: "GET", url: "/api/calendar/range?from=2026-01-01&to=2026-12-31&tz=Europe/Copenhagen", headers: authed });
  check("an over-wide range is refused", wide.statusCode === 400);
  const del = await app.inject({ method: "DELETE", url: `/api/calendar/events/${id}?scope=series`, headers: authed });
  check("an authenticated delete succeeds", del.statusCode === 200 && !calendar.getEvent(id));
  const missing = await app.inject({ method: "DELETE", url: `/api/calendar/events/${id}`, headers: authed });
  check("deleting a missing event is a 404", missing.statusCode === 404);
  const anonSettings = await app.inject({ method: "PUT", url: "/api/calendar/settings", payload: { reminderLeads: [60], allDayTime: "09:00" } });
  check("unauthenticated settings writes are refused", anonSettings.statusCode === 401);
  const badSettings = await app.inject({ method: "PUT", url: "/api/calendar/settings", headers: authed, payload: { reminderLeads: [-1], allDayTime: "09:00" } });
  check("bad default reminders are a 400", badSettings.statusCode === 400);
  const setSettings = await app.inject({ method: "PUT", url: "/api/calendar/settings", headers: authed, payload: { reminderLeads: [10080, 1440], allDayTime: "09:00" } });
  check("default reminders can be saved over the API", setSettings.statusCode === 200 && calendar.defaults().reminderLeads.join() === "10080,1440", setSettings.body);
  calendar.setDefaults({ reminderLeads: [], allDayTime: "09:00" });
  await app.close();
}

async function main(): Promise<void> {
  zones();
  recurrence();
  cronHelpers();
  const id = eventsCrudAndPersistence();
  scopedEdits(id);
  editEdgeCases();
  await eventReminders(id);
  await reminderFreshness();
  await severalAndDefaultReminders();
  await schedulesOnTheCalendar();
  migration();
  await api();
  if (failures) {
    console.error(`\n${failures} calendar check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll calendar checks passed.");
  process.exit(0);
}

main().finally(() => {
  try {
    db.raw.close();
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* temp cleanup best-effort */
  }
});
