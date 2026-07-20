import { existsSync } from "node:fs";
import type { Db } from "../db/db.js";
import type { EventHub } from "../events.js";
import type { DispatchInput } from "./api.js";
import type { Effort, ScheduledTask } from "../types.js";
import { isValidCron, nextRun } from "./cron.js";

/** The fields a create/update accepts; everything else (timestamps, lastThreadId) is scheduler-managed. */
export interface ScheduleInput {
  title: string;
  workspace: string;
  prompt: string;
  cron: string;
  enabled?: boolean;
  effort?: Effort | null;
}
export type SchedulePatch = Partial<ScheduleInput>;

export interface ScheduleResult {
  ok: boolean;
  error?: string;
  schedule?: ScheduledTask;
}

// The cron tick. 30s keeps a one-minute-granularity schedule punctual (a fire lands within 30s of its
// slot) without busy-waking. A missed tick (server asleep) simply fires on the next wake — nextRunAt is
// recomputed from `now`, so a downtime never stacks up a backlog of catch-up runs.
const TICK_MS = 30_000;

/**
 * Fires recurring dispatches on their cron schedules. Deliberately standalone — it depends only on a
 * `dispatch` callback (ThreadManager.dispatch), the DB, and the hub — so a scheduled run flows through
 * the exact same pipeline (and provider/model routing) as any hand-dispatched task, and the scheduler
 * itself stays decoupled from the manager's internals.
 */
export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly db: Db,
    private readonly hub: EventHub,
    private readonly dispatch: (input: DispatchInput) => Promise<string>,
  ) {}

  /** Recompute every enabled schedule's next fire from NOW (so downtime skips missed slots rather than
   *  replaying them), broadcast the list, and start the tick. Idempotent. */
  start(): void {
    const now = Date.now();
    for (const s of this.db.listScheduledTasks()) {
      const next = s.enabled ? nextRun(s.cron, now) : null;
      if (next !== s.nextRunAt) this.db.updateScheduledTask(s.id, { nextRunAt: next });
    }
    this.broadcast();
    if (!this.timer) {
      this.timer = setInterval(() => this.tick(), TICK_MS);
      this.timer.unref?.();
    }
  }

  list(): ScheduledTask[] {
    return this.db.listScheduledTasks();
  }

  create(input: ScheduleInput): ScheduleResult {
    const clean = this.sanitize(input);
    if (typeof clean === "string") return { ok: false, error: clean };
    const enabled = input.enabled ?? true;
    const schedule = this.db.createScheduledTask({
      ...clean,
      enabled,
      effort: input.effort ?? null,
      nextRunAt: enabled ? nextRun(clean.cron, Date.now()) : null,
    });
    this.broadcast();
    this.hub.log("info", `Created scheduled task "${schedule.title}" (${schedule.cron}) in ${schedule.workspace}`);
    return { ok: true, schedule };
  }

  update(id: string, patch: SchedulePatch): ScheduleResult {
    const current = this.db.getScheduledTask(id);
    if (!current) return { ok: false, error: "No such scheduled task." };
    const merged = this.sanitize({
      title: patch.title ?? current.title,
      workspace: patch.workspace ?? current.workspace,
      prompt: patch.prompt ?? current.prompt,
      cron: patch.cron ?? current.cron,
    });
    if (typeof merged === "string") return { ok: false, error: merged };
    const enabled = patch.enabled ?? current.enabled;
    const effort = patch.effort !== undefined ? patch.effort : current.effort;
    const schedule = this.db.updateScheduledTask(id, {
      ...merged,
      enabled,
      effort,
      // Re-anchor the next fire on any change to the cadence or the enabled flag; a pure metadata edit
      // (prompt/title) keeps the existing slot so it doesn't drift.
      nextRunAt: enabled ? (patch.cron || patch.enabled !== undefined ? nextRun(merged.cron, Date.now()) : current.nextRunAt) : null,
    });
    this.broadcast();
    return { ok: true, schedule: schedule ?? undefined };
  }

  remove(id: string): ScheduleResult {
    const existed = this.db.deleteScheduledTask(id);
    if (existed) this.broadcast();
    return { ok: existed, error: existed ? undefined : "No such scheduled task." };
  }

  /** Fire a schedule immediately (a "Run now" action), without disturbing its cron cadence. */
  async runNow(id: string): Promise<ScheduleResult> {
    const s = this.db.getScheduledTask(id);
    if (!s) return { ok: false, error: "No such scheduled task." };
    await this.dispatchRun(s);
    return { ok: true, schedule: this.db.getScheduledTask(id) ?? undefined };
  }

  private tick(): void {
    const now = Date.now();
    let due = false;
    for (const s of this.db.listScheduledTasks()) {
      if (!s.enabled || s.nextRunAt == null || s.nextRunAt > now) continue;
      due = true;
      // Roll the next fire forward BEFORE dispatching (which awaits): if a dispatch is ever slow, the
      // following tick must see a future nextRunAt, never this same past slot — so a schedule can never
      // double-fire. Recompute from `now` so downtime skips missed slots instead of stacking a backlog.
      this.db.updateScheduledTask(s.id, { nextRunAt: nextRun(s.cron, now) });
      void this.dispatchRun(s);
    }
    if (due) this.broadcast();
  }

  /** Dispatch one run of a schedule through the normal pipeline and record the last-run bookkeeping.
   *  Best-effort: a missing workspace or a dispatch error is logged and swallowed, so one bad fire never
   *  wedges the schedule. Does NOT touch nextRunAt — the cron cadence is advanced by the tick (or left
   *  alone for a manual runNow). */
  private async dispatchRun(s: ScheduledTask): Promise<void> {
    if (!existsSync(s.workspace)) {
      this.hub.log("warn", `Scheduled task "${s.title}" skipped — workspace ${s.workspace} does not exist.`);
      return;
    }
    try {
      const threadId = await this.dispatch({
        title: s.title,
        workspace: s.workspace,
        brief: s.prompt,
        effort: s.effort ?? undefined,
      });
      this.db.updateScheduledTask(s.id, { lastRunAt: Date.now(), lastThreadId: threadId });
      this.hub.log("info", `Scheduled task "${s.title}" fired → task ${threadId.slice(0, 8)}`);
      this.broadcast();
    } catch (e) {
      this.hub.log("error", `Scheduled task "${s.title}" failed to dispatch: ${String(e)}`);
    }
  }

  private broadcast(): void {
    this.hub.publish({ type: "schedules", schedules: this.db.listScheduledTasks() });
  }

  /** Trim + validate the human-supplied fields; returns the cleaned values or an error string. */
  private sanitize(input: ScheduleInput): { title: string; workspace: string; prompt: string; cron: string } | string {
    const title = input.title.trim().slice(0, 200);
    const workspace = input.workspace.trim();
    const prompt = input.prompt.trim();
    const cron = input.cron.trim();
    if (!title) return "Title is required.";
    if (!workspace) return "Workspace path is required.";
    if (!prompt) return "Prompt is required.";
    if (!isValidCron(cron)) return `Invalid cron expression: "${cron}".`;
    return { title, workspace, prompt, cron };
  }
}
