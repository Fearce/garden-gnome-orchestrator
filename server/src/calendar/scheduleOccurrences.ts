// A scheduled task or reminder (scheduled_tasks) as calendar occurrences. The slots come from the
// scheduler's own cron evaluator in the server's zone, so the grid shows exactly when a fire will
// happen. Nothing here writes: viewing a schedule can never create a job or fire one.

import { forEachRun, nextRun } from "../orchestrator/cron.js";
import type { ScheduledTask } from "../types.js";
import type { CalendarOccurrence } from "./types.js";
import { epochToWall, formatDate } from "./zoned.js";

/** More fires than this on one day collapse into a single "every N minutes" item for that day. */
export const DENSE_PER_DAY = 12;

interface Window {
  fromMs: number;
  toMs: number;
  now: number;
  /** The zone the viewer's days are counted in, for collapsing a dense day. */
  timeZone: string;
  /** Skipped slots, by schedule id. */
  skips: Map<string, Set<number>>;
}

function base(s: ScheduledTask): Pick<CalendarOccurrence, "kind" | "source" | "id" | "title" | "allDay" | "hasReminder" | "lastThreadId"> {
  return { kind: s.prompt ? "task" : "reminder", source: "schedule", id: s.id, title: s.title, allDay: false, hasReminder: !!s.reminder, lastThreadId: s.lastThreadId ?? null };
}

/** The slots still to come in the window. A disabled schedule's would-be slots are returned too, marked
 *  paused, so the owner can see what switching it back on would do. */
function futureSlots(s: ScheduledTask, w: Window): number[] {
  const from = Math.max(w.fromMs, w.now);
  if (s.runOnce) {
    // A run-once schedule fires at most once more: its armed slot, or (switched off before it ever
    // fired) the slot it would take if switched back on. One that already fired has none left.
    const slot = s.enabled ? (s.nextRunAt ?? null) : s.lastRunAt ? null : nextRun(s.cron, w.now);
    return slot != null && slot >= from && slot < w.toMs ? [slot] : [];
  }
  const slots: number[] = [];
  forEachRun(s.cron, from, w.toMs, (ms) => {
    slots.push(ms);
    return true;
  });
  return slots;
}

/** Collapse each day holding more than DENSE_PER_DAY slots into one item counting them. */
function collapseDense(s: ScheduledTask, slots: number[], w: Window): CalendarOccurrence[] {
  const byDay = new Map<string, number[]>();
  for (const ms of slots) {
    const day = formatDate(epochToWall(ms, w.timeZone));
    const list = byDay.get(day) ?? [];
    list.push(ms);
    byDay.set(day, list);
  }
  const skipped = w.skips.get(s.id);
  const out: CalendarOccurrence[] = [];
  for (const [day, list] of byDay) {
    if (list.length > DENSE_PER_DAY) {
      out.push({
        ...base(s),
        key: `s:${s.id}:day:${day}`,
        allDay: true,
        startAt: list[0]!,
        endAt: list[list.length - 1]!,
        startDate: day,
        endDate: day,
        recurring: true,
        status: s.enabled ? "upcoming" : "paused",
        count: list.length,
      });
      continue;
    }
    for (const ms of list) {
      out.push({
        ...base(s),
        key: `s:${s.id}:${ms}`,
        startAt: ms,
        endAt: ms,
        recurring: !s.runOnce,
        slotAt: ms,
        status: skipped?.has(ms) ? "skipped" : s.enabled ? "upcoming" : "paused",
      });
    }
  }
  return out;
}

export function scheduleOccurrences(s: ScheduledTask, w: Window): CalendarOccurrence[] {
  const out = collapseDense(s, futureSlots(s, w), w);
  // The last fire that actually happened, as history: past slots are not shown as if they ran, since a
  // fire can have been skipped (previous run still busy) or missed (server down).
  if (s.lastRunAt && s.lastRunAt >= w.fromMs && s.lastRunAt < w.toMs) {
    out.push({ ...base(s), key: `s:${s.id}:ran:${s.lastRunAt}`, startAt: s.lastRunAt, endAt: s.lastRunAt, recurring: !s.runOnce, status: "ran" });
  }
  return out;
}
