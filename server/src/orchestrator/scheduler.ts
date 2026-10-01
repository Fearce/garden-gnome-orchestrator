import { existsSync } from "node:fs";
import type { Db } from "../db/db.js";
import type { EventHub } from "../events.js";
import type { DispatchInput } from "./api.js";
import type { Effort, ImplementorProvider, ScheduledTask, ThreadState } from "../types.js";
import { isValidCron, nextRun } from "./cron.js";
import type { SendResult } from "./discordNotify.js";

/** States in which a schedule's previous fire still has an agent working, or one that will resume
 *  (a paused session, an open question, a plan awaiting approval). A new fire is skipped while its
 *  predecessor sits in one of these. `review` is deliberately absent: the work has stopped and waits on
 *  the owner's verdict, and blocking on it would silently halt a daily schedule until someone clicks.
 *
 *  Why this exists: a shutdown check scheduled every five minutes (2026-09-23) fired on that cadence while each fire took
 *  10-40 minutes, so up to nine full implementor+QA tasks ran at once in one repo, each re-verifying and
 *  re-committing the same helper scripts. One fire at a time is the bound the pipeline needs. */
export const UNFINISHED_STATES: ReadonlySet<ThreadState> = new Set<ThreadState>([
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

/** Where a schedule's reminder goes: the owner's Discord DM, and the note list when that DM fails. */
export interface ReminderChannel {
  /** Whether a DM can go out right now (Phone notifications on, token and destination set). */
  ready(): boolean;
  send(title: string, text: string): Promise<SendResult>;
  /** Durable fallback when the DM did not go through. It survives the restarts a deploy causes, unlike
   *  the in-process retries. */
  fallback(title: string, text: string, why: string): void;
}

/** The fields a create/update accepts; everything else (timestamps, lastThreadId) is scheduler-managed. */
export interface ScheduleInput {
  title: string;
  /** May be empty only when `prompt` is empty too: a reminder on its own needs no repo. */
  workspace: string;
  /** The task each fire dispatches. Empty = a reminder only: the fire sends the DM and starts no agent. */
  prompt: string;
  /** Sent to the owner's Discord DM on every fire. null/empty = no reminder. */
  reminder?: string | null;
  cron: string;
  enabled?: boolean;
  effort?: Effort | null;
  /** Exact model request retained as a strict pin for each dispatched run. */
  model?: string | null;
  /** The backend that model belongs to. Only meaningful beside `model`; see `sanitize`. */
  provider?: ImplementorProvider | null;
  /** Fire once on the next matching slot, then disable. */
  runOnce?: boolean;
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
// A run-once schedule has no next slot to fall back on (a date cron's next match is a year away), so a
// failed dispatch re-arms it a few times rather than silently spending its only fire.
const ONCE_RETRY_MS = 5 * 60_000;
const ONCE_RETRIES = 3;
// Waits before each retry of a reminder DM that did not go through (Discord down, a transient 5xx).
const REMINDER_RETRY_MS = [60_000, 5 * 60_000, 15 * 60_000];
// Discord allows 2000 characters per message; the title and the alarm-clock lead share it with the text.
export const REMINDER_MAX_CHARS = 1800;

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
  /** Failed dispatch attempts per run-once schedule, bounded by ONCE_RETRIES. */
  private readonly onceFailures = new Map<string, number>();
  /** Run-once schedules already logged as waiting on a busy predecessor, so a long wait logs once. */
  private readonly onceWaitLogged = new Set<string>();

  constructor(
    private readonly db: Db,
    private readonly hub: EventHub,
    private readonly dispatch: (input: DispatchInput) => Promise<string>,
    private readonly reminders: ReminderChannel,
    private readonly reminderRetryMs: readonly number[] = REMINDER_RETRY_MS,
  ) {}

  /** Recompute every enabled schedule's next fire from NOW (so downtime skips missed slots rather than
   *  replaying them), broadcast the list, and start the tick. Idempotent. */
  start(): void {
    const now = Date.now();
    for (const s of this.db.listScheduledTasks()) {
      // A run-once slot missed during downtime stays due and fires late: rolling it forward would move a
      // date reminder a full year.
      const missedOnce = s.enabled && s.runOnce && s.nextRunAt != null && s.nextRunAt <= now;
      const next = !s.enabled ? null : missedOnce ? s.nextRunAt : nextRun(s.cron, now);
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

  /** Why a reminder would NOT reach Discord right now, or null when it would. Read by the Director so it
   *  can tell the owner at creation time instead of on the day. */
  reminderGap(): string | null {
    return this.reminders.ready()
      ? null
      : "Phone notifications (Settings) are off or missing a bot token / Discord user ID, so until that is set up the reminder will land on the note list instead of your DMs.";
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
      runOnce: input.runOnce ?? false,
      nextRunAt: enabled ? nextRun(clean.cron, Date.now()) : null,
    });
    this.broadcast();
    this.hub.log("info", schedule.prompt ? `Created scheduled task "${schedule.title}" (${schedule.cron}) in ${schedule.workspace}` : `Created scheduled reminder "${schedule.title}" (${schedule.cron})`);
    return { ok: true, schedule };
  }

  update(id: string, patch: SchedulePatch): ScheduleResult {
    const current = this.db.getScheduledTask(id);
    if (!current) return { ok: false, error: "No such scheduled task." };
    const merged = this.sanitize({
      title: patch.title ?? current.title,
      workspace: patch.workspace ?? current.workspace,
      prompt: patch.prompt ?? current.prompt,
      reminder: patch.reminder !== undefined ? patch.reminder : current.reminder,
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
      runOnce: patch.runOnce ?? current.runOnce ?? false,
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
    const busy = s.prompt ? this.previousRunBusy(s) : null;
    if (busy) {
      const error = `The previous run is still ${busy}. Finish or cancel it before starting another.`;
      this.hub.log("warn", `Scheduled task "${s.title}" was not run: ${error}`);
      return { ok: false, error };
    }
    await this.fire(s);
    return { ok: true, schedule: this.db.getScheduledTask(id) ?? undefined };
  }

  private tick(): void {
    const now = Date.now();
    let due = false;
    for (const s of this.db.listScheduledTasks()) {
      if (!s.enabled || s.nextRunAt == null || s.nextRunAt > now) continue;
      due = true;
      if (s.runOnce) {
        this.fireOnce(s);
        continue;
      }
      // Roll the next fire forward BEFORE dispatching (which awaits): if a dispatch is ever slow, the
      // following tick must see a future nextRunAt, never this same past slot — so a schedule can never
      // double-fire. Recompute from `now` so downtime skips missed slots instead of stacking a backlog.
      this.db.updateScheduledTask(s.id, { nextRunAt: nextRun(s.cron, now) });
      const busy = s.prompt ? this.previousRunBusy(s) : null;
      if (busy) {
        // The reminder is about the clock, so only the task waits for its predecessor.
        this.remind(s);
        this.hub.log("info", `Scheduled task "${s.title}" skipped this fire: its previous run is still ${busy}.`);
        continue;
      }
      void this.fire(s);
    }
    if (due) this.broadcast();
  }

  /** A due run-once schedule. A busy predecessor holds it due (it fires as soon as that run ends) rather
   *  than rolling it to the next cron match; otherwise it is disabled BEFORE the dispatch awaits, so no
   *  later tick can see it armed, and re-armed a bounded number of times if the dispatch fails. */
  private fireOnce(s: ScheduledTask): void {
    const busy = s.prompt ? this.previousRunBusy(s) : null;
    if (busy) {
      if (!this.onceWaitLogged.has(s.id)) {
        this.onceWaitLogged.add(s.id);
        this.hub.log("warn", `Run-once task "${s.title}" is due but waits: its previous run is still ${busy}. It fires when that run ends.`);
      }
      return;
    }
    this.onceWaitLogged.delete(s.id);
    this.db.updateScheduledTask(s.id, { enabled: false, nextRunAt: null });
    // A re-armed retry is the same fire again; its reminder already went out the first time.
    const retry = this.onceFailures.has(s.id);
    void this.fire(s, { remind: !retry }).then((ok) => {
      if (ok) {
        this.onceFailures.delete(s.id);
        return;
      }
      if (!this.db.getScheduledTask(s.id)) return;
      const attempt = (this.onceFailures.get(s.id) ?? 0) + 1;
      if (attempt > ONCE_RETRIES) {
        this.onceFailures.delete(s.id);
        this.hub.log("error", `Run-once task "${s.title}" failed to dispatch ${ONCE_RETRIES + 1} times and is now switched off without having run.`);
      } else {
        this.onceFailures.set(s.id, attempt);
        this.db.updateScheduledTask(s.id, { enabled: true, nextRunAt: Date.now() + ONCE_RETRY_MS });
        this.hub.log("warn", `Run-once task "${s.title}" did not start; retrying in ${ONCE_RETRY_MS / 60_000} minutes (retry ${attempt} of ${ONCE_RETRIES}).`);
      }
      this.broadcast();
    });
  }

  /** Describes why the schedule's previous fire still counts as running (e.g. "dispatching", "qa (task
   *  1a2b3c4d)"), or null when a new fire may start. A missing thread (purged, deleted) never blocks. */
  private previousRunBusy(s: ScheduledTask): string | null {
    if (this.dispatching.has(s.id)) return "dispatching";
    if (!s.lastThreadId) return null;
    const state = this.db.getThread(s.lastThreadId)?.state;
    return state && UNFINISHED_STATES.has(state) ? `${state} (task ${s.lastThreadId.slice(0, 8)})` : null;
  }

  /** One fire: send the reminder (unless told not to) and dispatch the prompt, if the schedule has them.
   *  Returns whether the fire did its job, which only the run-once retry reads. */
  private async fire(s: ScheduledTask, opts: { remind?: boolean } = {}): Promise<boolean> {
    if (opts.remind !== false) this.remind(s);
    if (s.prompt) return this.dispatchRun(s);
    this.db.updateScheduledTask(s.id, { lastRunAt: Date.now() });
    this.hub.log("info", `Scheduled reminder "${s.title}" fired.`);
    this.broadcast();
    return true;
  }

  /** Send the schedule's reminder in the background. Delivery retries on its own clock rather than the
   *  run-once retry's, since a reminder whose task dispatched fine must still get through. */
  private remind(s: ScheduledTask): void {
    if (s.reminder) void this.deliverReminder(s.title, s.reminder);
  }

  /** Send one reminder, retrying a failed DM a bounded number of times. The first failure also puts it on
   *  the note list, so a reminder still reaches the owner if every retry fails or a restart cuts them off. */
  private async deliverReminder(title: string, text: string): Promise<void> {
    let noted = false;
    for (let attempt = 0; ; attempt++) {
      const result = await this.reminders.send(title, text).catch((e: unknown): SendResult => ({ ok: false, message: String(e) }));
      if (result.ok) {
        this.hub.log("info", `Reminder "${title}" sent to the owner on Discord${attempt ? ` (attempt ${attempt + 1})` : ""}.`);
        return;
      }
      if (!noted) {
        noted = true;
        this.reminders.fallback(title, text, result.message);
      }
      const wait = this.reminderRetryMs[attempt];
      if (wait === undefined) {
        this.hub.log("error", `Reminder "${title}" could not be sent on Discord after ${attempt + 1} attempts: ${result.message} It is on the note list instead.`);
        return;
      }
      this.hub.log("warn", `Reminder "${title}" was not sent on Discord: ${result.message} It is on the note list; retrying in ${Math.round(wait / 1000)}s.`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  /** Dispatch one run of a schedule through the normal pipeline and record the last-run bookkeeping.
   *  Returns whether a task was dispatched, which only the run-once retry reads.
 *  Best-effort: a missing workspace or a dispatch error is logged and swallowed, so one bad fire never
   *  wedges the schedule. Does NOT touch nextRunAt — the cron cadence is advanced by the tick (or left
   *  alone for a manual runNow). */
  private async dispatchRun(s: ScheduledTask): Promise<boolean> {
    if (!existsSync(s.workspace)) {
      this.hub.log("warn", `Scheduled task "${s.title}" skipped — workspace ${s.workspace} does not exist.`);
      return false;
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
      return true;
    } catch (e) {
      this.hub.log("error", `Scheduled task "${s.title}" failed to dispatch: ${String(e)}`);
      return false;
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
  ): { title: string; workspace: string; prompt: string; reminder: string | null; cron: string; model: string | null; provider: ImplementorProvider | null } | string {
    const title = input.title.trim().slice(0, 200);
    const workspace = input.workspace.trim();
    const prompt = input.prompt.trim();
    const reminder = input.reminder?.trim().slice(0, REMINDER_MAX_CHARS) || null;
    const cron = input.cron.trim();
    const model = input.model?.trim().slice(0, 100) || null;
    // A provider without a model pins nothing this schedule could act on, and would read on the card as
    // a pin that is silently doing nothing. Drop it rather than store a half-pin.
    const provider = model ? (input.provider ?? null) : null;
    if (!title) return "Title is required.";
    if (!prompt && !reminder) return "A prompt or a reminder is required.";
    if (prompt && !workspace) return "Workspace path is required.";
    if (!isValidCron(cron)) return `Invalid cron expression: "${cron}".`;
    return { title, workspace, prompt, reminder, cron, model, provider };
  }
}
