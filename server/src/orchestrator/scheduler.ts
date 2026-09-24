import { existsSync } from "node:fs";
import type { Db } from "../db/db.js";
import type { EventHub } from "../events.js";
import type { DispatchInput } from "./api.js";
import type { Effort, ImplementorProvider, ScheduledTask, ThreadState } from "../types.js";
import { isValidCron, nextRun } from "./cron.js";

/** States in which a schedule's previous fire still has an agent working, or one that will resume
 *  (a paused session, an open question, a plan awaiting approval). A new fire is skipped while its
 *  predecessor sits in one of these. `review` is deliberately absent: the work has stopped and waits on
 *  the owner's verdict, and blocking on it would silently halt a daily schedule until someone clicks.
 *
 *  Why this exists: a shutdown check scheduled every five minutes (2026-09-23) fired on that cadence while each fire took
 *  10-40 minutes, so up to nine full implementor+QA tasks ran at once in one repo, each re-verifying and
 *  re-committing the same helper scripts. One fire at a time is the bound the pipeline needs. */
const UNFINISHED_STATES: ReadonlySet<ThreadState> = new Set<ThreadState>([
  "intake",
  "enriching",
  "queued",
  "awaiting_user",
  "planning",
  "researching",
  "awaiting_approval",
  "implementing",
  "qa",
  "paused",
  "reviewing",
]);

/** The fields a create/update accepts; everything else (timestamps, lastThreadId) is scheduler-managed. */
export interface ScheduleInput {
  title: string;
  workspace: string;
  prompt: string;
  cron: string;
  enabled?: boolean;
  effort?: Effort | null;
  /** Exact model request retained as a strict pin for each dispatched run. */
  model?: string | null;
  /** The backend that model belongs to. Only meaningful beside `model`; see `sanitize`. */
  provider?: ImplementorProvider | null;
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
  /** Schedules whose dispatch is awaiting its thread id. `lastThreadId` is written only after dispatch
   *  resolves, so without this a fire started in that window would not see its own predecessor. */
  private readonly dispatching = new Set<string>();

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
      model: clean.model,
      provider: clean.provider,
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
      model: patch.model !== undefined ? patch.model : current.model,
      // Follow the model: clearing the pin must clear its provider, and an edit that only names the
      // model (an older client, or the Director bridge) must not inherit the previous backend.
      provider: patch.provider !== undefined ? patch.provider : patch.model !== undefined ? null : current.provider,
    });
    if (typeof merged === "string") return { ok: false, error: merged };
    const enabled = patch.enabled ?? current.enabled;
    const effort = patch.effort !== undefined ? patch.effort : current.effort;
    const schedule = this.db.updateScheduledTask(id, {
      ...merged,
      enabled,
      effort,
      model: merged.model,
      provider: merged.provider,
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
    const busy = this.previousRunBusy(s);
    if (busy) {
      const error = `The previous run is still ${busy}. Finish or cancel it before starting another.`;
      this.hub.log("warn", `Scheduled task "${s.title}" was not run: ${error}`);
      return { ok: false, error };
    }
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
      const busy = this.previousRunBusy(s);
      if (busy) {
        this.hub.log("info", `Scheduled task "${s.title}" skipped this fire: its previous run is still ${busy}.`);
        continue;
      }
      void this.dispatchRun(s);
    }
    if (due) this.broadcast();
  }

  /** Describes why the schedule's previous fire still counts as running (e.g. "dispatching", "qa (task
   *  1a2b3c4d)"), or null when a new fire may start. A missing thread (purged, deleted) never blocks. */
  private previousRunBusy(s: ScheduledTask): string | null {
    if (this.dispatching.has(s.id)) return "dispatching";
    if (!s.lastThreadId) return null;
    const state = this.db.getThread(s.lastThreadId)?.state;
    return state && UNFINISHED_STATES.has(state) ? `${state} (task ${s.lastThreadId.slice(0, 8)})` : null;
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
    this.dispatching.add(s.id);
    try {
      const threadId = await this.dispatch({
        title: s.title,
        workspace: s.workspace,
        brief: s.prompt,
        effort: s.effort ?? undefined,
        requestedModel: s.model ?? undefined,
        requestedProvider: s.provider ?? undefined,
      });
      this.db.updateScheduledTask(s.id, { lastRunAt: Date.now(), lastThreadId: threadId });
      this.hub.log("info", `Scheduled task "${s.title}" fired → task ${threadId.slice(0, 8)}`);
      this.broadcast();
    } catch (e) {
      this.hub.log("error", `Scheduled task "${s.title}" failed to dispatch: ${String(e)}`);
    } finally {
      this.dispatching.delete(s.id);
    }
  }

  private broadcast(): void {
    this.hub.publish({ type: "schedules", schedules: this.db.listScheduledTasks() });
  }

  /** Trim + validate the human-supplied fields; returns the cleaned values or an error string. */
  private sanitize(
    input: ScheduleInput,
  ): { title: string; workspace: string; prompt: string; cron: string; model: string | null; provider: ImplementorProvider | null } | string {
    const title = input.title.trim().slice(0, 200);
    const workspace = input.workspace.trim();
    const prompt = input.prompt.trim();
    const cron = input.cron.trim();
    const model = input.model?.trim().slice(0, 100) || null;
    // A provider without a model pins nothing this schedule could act on, and would read on the card as
    // a pin that is silently doing nothing. Drop it rather than store a half-pin.
    const provider = model ? (input.provider ?? null) : null;
    if (!title) return "Title is required.";
    if (!workspace) return "Workspace path is required.";
    if (!prompt) return "Prompt is required.";
    if (!isValidCron(cron)) return `Invalid cron expression: "${cron}".`;
    return { title, workspace, prompt, cron, model, provider };
  }
}
