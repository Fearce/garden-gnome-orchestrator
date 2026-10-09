import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { isCrossSiteRequest } from "../crossSite.js";
import type { CalendarResult, CalendarService } from "./calendarService.js";
import { FIRED_KEEP, type FiredReminders } from "./firedReminders.js";
import { MAX_COUNT, MAX_INTERVAL } from "./recurrence.js";
import { MAX_REMINDER_DAYS, MAX_REMINDER_MINUTES, MAX_REMINDERS, NOTES_MAX, TITLE_MAX } from "./validate.js";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const wall = z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/);

const recurrence = z
  .object({
    freq: z.enum(["daily", "weekly", "monthly", "yearly"]),
    interval: z.number().int().min(1).max(MAX_INTERVAL),
    weekdays: z.array(z.number().int().min(0).max(6)).max(7).nullish(),
    monthlyBy: z.enum(["monthday", "nthWeekday", "lastWeekday"]).nullish(),
    until: date.nullish(),
    count: z.number().int().min(1).max(MAX_COUNT).nullish(),
  })
  .strict();

const reminder = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("before"), minutes: z.number().int().min(0).max(MAX_REMINDER_MINUTES) }).strict(),
  z.object({ kind: z.literal("day"), daysBefore: z.number().int().min(0).max(MAX_REMINDER_DAYS), time: z.string().regex(/^\d{2}:\d{2}$/) }).strict(),
]);

const eventFields = {
  title: z.string().max(TITLE_MAX * 2),
  notes: z.string().max(NOTES_MAX * 2).nullish(),
  allDay: z.boolean(),
  start: wall,
  end: wall,
  timeZone: z.string().min(1).max(64),
  recurrence: recurrence.nullish(),
  reminders: z.array(reminder).max(MAX_REMINDERS).nullish(),
};

const createBody = z.object(eventFields).strict();
const scope = z.enum(["occurrence", "following", "series"]);
const updateBody = z.object({ scope, occurrenceDate: date.nullish(), changes: z.object(eventFields).partial().strict() }).strict();
const deleteQuery = z.object({ scope: scope.default("series"), occurrenceDate: date.optional() });
const rangeQuery = z.object({ from: date, to: date, tz: z.string().min(1).max(64) });
const idParams = z.object({ id: z.string().min(1).max(64) });
const settingsBody = z
  .object({ reminderLeads: z.array(z.number().int().min(0).max(MAX_REMINDER_MINUTES)).max(MAX_REMINDERS), allDayTime: z.string().regex(/^\d{2}:\d{2}$/) })
  .strict();
const slotBody = z.object({ slotAt: z.number().int().nonnegative() }).strict();
const seenBody = z.object({ ids: z.array(z.string().min(1).max(64)).max(FIRED_KEEP).optional() }).strict();
const moveBody = z.object({ slotAt: z.number().int().nonnegative(), toAt: z.number().int().nonnegative(), scope: z.enum(["occurrence", "series"]) }).strict();

class CalendarRequestError extends Error {}

function reply(res: FastifyReply, result: CalendarResult) {
  if (!result.ok) return res.code(result.error === "No such event." || result.error === "No such scheduled task." ? 404 : 400).send({ error: result.error });
  return { ok: true, event: result.event ?? null };
}

/**
 * The calendar's HTTP API, behind the console's owner login. Every request is same-origin only, and
 * failures return a short reason — never the submitted text, so personal content stays out of logs.
 */
export function registerCalendarRoutes(app: FastifyInstance, calendar: CalendarService, fired: FiredReminders, isAuthed: (cookie?: string) => boolean): void {
  void app.register(async (routes) => {
    routes.addHook("onRequest", async (req, res) => {
      res.header("cache-control", "no-store");
      if (!isAuthed(req.headers.cookie)) return res.code(401).send({ error: "unauthorized" });
      if (isCrossSiteRequest(req)) return res.code(403).send({ error: "Cross-site calendar requests are refused." });
    });
    routes.setErrorHandler((error, _req, res) => {
      if (error instanceof z.ZodError) return res.code(400).send({ error: `Invalid calendar request: ${error.issues.map((i) => i.path.join(".") || "body").join(", ")}.` });
      if (error instanceof CalendarRequestError) return res.code(400).send({ error: error.message });
      return res.code(500).send({ error: "The calendar request failed." });
    });

    routes.get("/api/calendar/range", (req) => {
      const q = rangeQuery.parse(req.query);
      const range = calendar.range(q.from, q.to, q.tz);
      if (typeof range === "string") throw new CalendarRequestError(range);
      return range;
    });
    routes.get("/api/calendar/events/:id", (req, res) => {
      const event = calendar.getEvent(idParams.parse(req.params).id);
      return event ?? res.code(404).send({ error: "No such event." });
    });
    routes.post("/api/calendar/events", (req, res) => {
      const b = createBody.parse(req.body);
      return reply(res, calendar.createEvent({ ...b, notes: b.notes ?? null, recurrence: b.recurrence ?? null, reminders: b.reminders === undefined ? undefined : (b.reminders ?? []) }));
    });
    routes.put("/api/calendar/settings", (req, res) => {
      const result = calendar.setDefaults(settingsBody.parse(req.body));
      return result.ok ? { ok: true, defaults: result.defaults } : res.code(400).send({ error: result.error });
    });
    routes.patch("/api/calendar/events/:id", (req, res) => {
      const { id } = idParams.parse(req.params);
      const b = updateBody.parse(req.body);
      return reply(res, calendar.updateEvent(id, b.scope, b.occurrenceDate, b.changes));
    });
    routes.delete("/api/calendar/events/:id", (req, res) => {
      const { id } = idParams.parse(req.params);
      const q = deleteQuery.parse(req.query);
      return reply(res, calendar.deleteEvent(id, q.scope, q.occurrenceDate));
    });
    routes.post("/api/calendar/events/:id/remind-now", (req, res) => {
      const { id } = idParams.parse(req.params);
      const b = z.object({ occurrenceDate: date.nullish() }).strict().parse(req.body ?? {});
      return reply(res, calendar.remindNow(id, b.occurrenceDate));
    });
    routes.post("/api/calendar/schedules/:id/skip", (req, res) => reply(res, calendar.skipScheduleRun(idParams.parse(req.params).id, slotBody.parse(req.body).slotAt)));
    routes.post("/api/calendar/schedules/:id/restore", (req, res) => reply(res, calendar.restoreScheduleRun(idParams.parse(req.params).id, slotBody.parse(req.body).slotAt)));
    routes.post("/api/calendar/schedules/:id/move", (req, res) => {
      const b = moveBody.parse(req.body);
      return reply(res, calendar.moveScheduleRun(idParams.parse(req.params).id, b.slotAt, b.toAt, b.scope));
    });
    routes.get("/api/calendar/fired", () => ({ reminders: fired.list(), unseen: fired.unseen() }));
    routes.post("/api/calendar/fired/seen", (req) => {
      const b = seenBody.parse(req.body ?? {});
      return { ok: true, changed: fired.markSeen(b.ids), unseen: fired.unseen() };
    });
  });
}
