import { existsSync } from "node:fs";
import type { Db } from "../db/db.js";
import type { EventHub } from "../events.js";
import type { JsonSchemaLike } from "../agents/structuredText.js";
import type { DispatchInput } from "./api.js";
import type { ModelCandidate } from "./modelSelector.js";
import { UNFINISHED_STATES } from "./scheduler.js";
import {
  DEFAULT_GOAL_MAX_STEPS,
  EFFORTS,
  MAX_GOAL_MAX_STEPS,
  type Effort,
  type Goal,
  type GoalStatus,
  type GoalStep,
  type GoalVerdict,
  type ImplementorProvider,
  type Thread,
} from "../types.js";

/**
 * GOAL-DIRECTED TASKS — a standing objective GGO keeps a task working on until it is done.
 *
 * Not a schedule (that fires the same prompt on a clock) and not a timed task (one task with a window).
 * A goal is a loop of ordinary tasks: whenever the goal has no step task in flight, the director reads
 * where the last step left things and either plans the next step — choosing its backend, model and
 * effort from what can dispatch right now — or declares the objective met.
 *
 * Ending takes TWO agreeing voices: the step's implementor must declare the whole objective complete
 * (`GOAL STATUS: COMPLETE` on its own line) AND the director, reading that report, must agree. A
 * director who thinks it is done without that claim dispatches a verification step instead; an agent
 * claim the director rejects just gets the next step. Neither side can end the loop alone.
 *
 * The loop is driven by durable state only (`goals` + `goal_steps`), re-read on every evaluation, so a
 * restart simply re-evaluates. Bounded three ways: `maxSteps`, a run of failed steps, and a cancelled
 * step (the owner intervened) each pause the goal with a reason instead of spending forever.
 */

export const GOAL_TICK_MS = 60_000;
/** How long to wait before retrying when the director could not be reached or nothing can dispatch. */
export const GOAL_RETRY_MS = 5 * 60_000;
/** Consecutive failed steps that pause a goal — the runaway guard for a step that can never succeed. */
export const GOAL_MAX_FAILED_STEPS = 3;
/** A dispatch that lost its thread id is searched for within this window after the step was recorded. */
const ORPHAN_WINDOW_MS = 5 * 60_000;
const REPORT_EXCERPT_CHARS = 6_000;
const QA_EXCERPT_CHARS = 2_500;
const HISTORY_SHOWN = 12;

export const GOAL_PROVIDERS: ImplementorProvider[] = ["claude", "codex", "grok", "zai"];

/** What the runner needs from the rest of GGO. ThreadManager provides all of it; tests fake it. */
export interface GoalHost {
  dispatch(input: DispatchInput): Promise<string>;
  /** One bounded no-tools director judgement; null when no director model could answer. */
  judge(prompt: string, schema: JsonSchemaLike): Promise<{ output: unknown; model: string; provider: ImplementorProvider } | null>;
  /** Every (provider, model) pair a task could be dispatched to right now, with its efforts. */
  roster(): ModelCandidate[];
  notify?(kind: "done" | "input", title: string, detail?: string, repo?: string): void;
}

export interface GoalInput {
  title: string;
  objective: string;
  workspace: string;
  maxSteps?: number;
}

export interface GoalPatch {
  title?: string;
  objective?: string;
  maxSteps?: number;
}

export interface GoalResult {
  ok: boolean;
  error?: string;
  goal?: Goal;
}

/** The director's structured answer for one evaluation. */
export interface GoalJudgement {
  verdict: "complete" | "continue";
  reason: string;
  progress: string;
  next: {
    title: string;
    brief: string;
    provider: ImplementorProvider;
    model: string;
    effort: Effort;
    rationale: string;
  };
}

/** The pin a step will actually run with, after checking the director's pick against the roster. */
export interface StepPin {
  provider: ImplementorProvider | null;
  model: string | null;
  effort: Effort | null;
  note: string | null;
}

// ---- pure helpers ----

const COMPLETE_LINE = /^[\s>*_`#-]*GOAL STATUS\s*:\s*[*_`]*\s*COMPLETE\s*[*_`.!]*\s*$/i;
const CONTINUE_LINE = /^[\s>*_`#-]*GOAL STATUS\s*:\s*[*_`]*\s*CONTINUE\b/i;

/**
 * Whether a step's final report declares the WHOLE objective complete. The last status line wins, and a
 * COMPLETE line must stand alone: the brief quotes the marker mid-sentence, so an agent echoing its
 * instructions ("`GOAL STATUS: COMPLETE` if …") can never end a goal by accident.
 */
export function detectGoalComplete(report: string | null | undefined): boolean {
  if (!report) return false;
  let claim = false;
  for (const line of report.split(/\r?\n/)) {
    if (COMPLETE_LINE.test(line)) claim = true;
    else if (CONTINUE_LINE.test(line)) claim = false;
  }
  return claim;
}

export function clampMaxSteps(value: number | undefined): number {
  if (value == null || !Number.isFinite(value)) return DEFAULT_GOAL_MAX_STEPS;
  return Math.min(MAX_GOAL_MAX_STEPS, Math.max(1, Math.round(value)));
}

/** The JSON schema of the director's answer, narrowed to what can dispatch right now. */
export function goalJudgeSchema(roster: ModelCandidate[]): JsonSchemaLike {
  const providers = GOAL_PROVIDERS.filter((p) => roster.some((c) => c.provider === p));
  const efforts = EFFORTS.filter((e) => roster.some((c) => c.efforts.includes(e)));
  return {
    type: "object",
    additionalProperties: false,
    required: ["verdict", "reason", "progress", "next"],
    properties: {
      verdict: { type: "string", enum: ["complete", "continue"] },
      reason: { type: "string" },
      progress: { type: "string" },
      next: {
        type: "object",
        additionalProperties: false,
        required: ["title", "brief", "provider", "model", "effort", "rationale"],
        properties: {
          title: { type: "string" },
          brief: { type: "string" },
          provider: { type: "string", enum: providers.length ? providers : GOAL_PROVIDERS },
          model: { type: "string" },
          effort: { type: "string", enum: efforts.length ? efforts : EFFORTS },
          rationale: { type: "string" },
        },
      },
    },
  };
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);
const tail = (s: string, n: number): string => (s.length > n ? `…${s.slice(-n)}` : s);

/** Validates the director's raw answer. Null means "unusable" — the caller retries later. */
export function parseGoalJudgement(raw: unknown): GoalJudgement | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const next = r.next as Record<string, unknown> | undefined;
  if (r.verdict !== "complete" && r.verdict !== "continue") return null;
  if (!next || typeof next !== "object") return null;
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const title = str(next.title);
  const brief = str(next.brief);
  if (!title || !brief) return null;
  const provider = GOAL_PROVIDERS.includes(next.provider as ImplementorProvider) ? (next.provider as ImplementorProvider) : "claude";
  const effort = EFFORTS.includes(next.effort as Effort) ? (next.effort as Effort) : "medium";
  return {
    verdict: r.verdict,
    reason: clip(str(r.reason) || "No reason given.", 1_500),
    progress: clip(str(r.progress), 3_000),
    next: {
      title: clip(title, 100),
      brief: clip(brief, 12_000),
      provider,
      model: str(next.model),
      effort,
      rationale: clip(str(next.rationale), 1_000),
    },
  };
}

/**
 * Checks the director's model/effort pick against what can dispatch right now. An exact pair keeps its
 * effort when that effort is offered, else the nearest lower one; a model named under the wrong backend
 * is moved to the backend that has it; anything else falls back to ordinary automatic routing with the
 * reason recorded, rather than pinning a task to a model that cannot run.
 */
export function resolveStepPin(pick: GoalJudgement["next"], roster: ModelCandidate[]): StepPin {
  const model = pick.model.toLowerCase();
  const found =
    roster.find((c) => c.provider === pick.provider && c.model.toLowerCase() === model) ??
    roster.find((c) => c.model.toLowerCase() === model);
  if (!found) {
    return {
      provider: null,
      model: null,
      effort: pick.effort,
      note: pick.model ? `${pick.model} is not dispatchable right now, so this step uses automatic model routing.` : null,
    };
  }
  const idx = EFFORTS.indexOf(pick.effort);
  const effort = found.efforts.includes(pick.effort)
    ? pick.effort
    : [...found.efforts].filter((e) => EFFORTS.indexOf(e) <= idx).pop() ?? found.efforts[0] ?? null;
  const moved = found.provider !== pick.provider ? `${pick.model} runs on ${found.provider}, not ${pick.provider}. ` : "";
  const lowered = effort !== pick.effort ? `${found.model} does not offer ${pick.effort} effort; using ${effort}.` : "";
  return { provider: found.provider, model: found.model, effort, note: `${moved}${lowered}`.trim() || null };
}

export interface GoalJudgeContext {
  goal: Goal;
  steps: GoalStep[];
  lastReport: string | null;
  lastQa: string | null;
  lastError: string | null;
  roster: ModelCandidate[];
  ownerName: string;
}

export function buildGoalJudgePrompt(ctx: GoalJudgeContext): string {
  const { goal, steps, roster } = ctx;
  const last = steps.at(-1);
  const history = steps.slice(-HISTORY_SHOWN).map((s) =>
    `- Step ${s.seq} "${s.title}" — ${[s.provider, s.model, s.effort].filter(Boolean).join(" / ") || "auto routing"} — ended ${s.outcome ?? "unknown"}${s.agentClaimedComplete ? ", agent claimed the objective complete" : ""}`,
  );
  const rosterLines = roster.map((c) =>
    `- provider "${c.provider}", model "${c.model}", efforts [${c.efforts.join(", ")}]${c.note ? ` — ${c.note}` : ""}${c.capacity ? ` Capacity: ${c.capacity}` : ""}`,
  );
  const lastBlock = last
    ? [
        `THE STEP THAT JUST ENDED (step ${last.seq}, "${last.title}") settled as: ${last.outcome ?? "unknown"}.`,
        `Its agent ${last.agentClaimedComplete ? "DECLARED the whole objective complete" : "did NOT declare the objective complete"}.`,
        ctx.lastError ? `Task error: ${clip(ctx.lastError, 800)}` : "",
        `Its final report:\n${ctx.lastReport ? tail(ctx.lastReport, REPORT_EXCERPT_CHARS) : "(no report was written)"}`,
        ctx.lastQa ? `QA's last word on it:\n${tail(ctx.lastQa, QA_EXCERPT_CHARS)}` : "",
      ].filter(Boolean).join("\n")
    : "No step has run yet. Plan the first one.";
  return [
    `You are GGO's director, steering a GOAL-DIRECTED TASK for ${ctx.ownerName}. GGO keeps one step task working on this goal around the clock until the step's agent AND you agree the objective is fully achieved. You decide each step, and the backend, model and effort it runs on.`,
    "",
    `GOAL: ${goal.title}`,
    `OBJECTIVE (${ctx.ownerName}'s words, the fixed yardstick):\n${goal.objective}`,
    `REPOSITORY: ${goal.workspace}`,
    `Steps used: ${goal.stepCount} of ${goal.maxSteps}.`,
    `Progress so far (your own earlier summary): ${goal.progress || "none yet"}`,
    history.length ? `Step history (oldest first):\n${history.join("\n")}` : "",
    "",
    lastBlock,
    "",
    "DECIDE:",
    `- verdict "complete" ONLY if the objective as ${ctx.ownerName} wrote it is fully met and the evidence shows it (not merely that a step finished). Otherwise "continue".`,
    "- The goal ends only when you say complete AND the last step's agent declared it complete. If you believe it is complete but the agent did not declare it, still return \"complete\" and make `next` a VERIFICATION step: independently check every part of the objective, fix any gap, and declare the result.",
    "- `progress`: a short running summary of what is done and what remains, replacing the earlier one.",
    "- `next`: the next step. Make it a concrete, self-contained brief an implementor can finish in one task — the most valuable next slice toward the objective, not the whole objective at once. Build on what earlier steps did; if a step failed or QA rejected it, address why. The brief goes to the implementor as-is, together with the objective.",
    "- Choose `provider`, `model` and `effort` for that step from the roster below. The goal runs 24/7, so spend capacity deliberately: a flagship model and higher effort for hard, risky or architectural steps; a cheaper model or lower effort for mechanical ones; prefer pools with headroom so the goal does not exhaust one subscription and stall. Say why in `rationale`.",
    "",
    rosterLines.length ? `DISPATCHABLE MODELS RIGHT NOW:\n${rosterLines.join("\n")}` : "No model reports headroom right now; pick the one you would want when capacity returns.",
  ].filter((line) => line !== "").join("\n");
}

/** The brief a step task receives: the director's step brief, framed by the goal and its ending rule. */
export function goalStepBrief(goal: Goal, seq: number, judgement: GoalJudgement, verification: boolean): string {
  return [
    `GOAL-DIRECTED TASK — step ${seq} of the goal "${goal.title}".`,
    `The overall objective (the owner's words):\n${goal.objective}`,
    goal.progress ? `Progress before this step (the director's summary):\n${goal.progress}` : "",
    verification
      ? `THIS STEP IS A VERIFICATION: the director believes the objective is already met. Check every part of it against the repository and running behaviour, fix any gap you find, then report honestly.\n\n${judgement.next.brief}`
      : `THIS STEP:\n${judgement.next.brief}`,
    "Finish this step completely, commit it, and report what you did. GGO dispatches further steps until the objective is met, so do not stretch this step to cover everything.",
    "End your final report with one status line on its own. Write `GOAL STATUS: COMPLETE` only if the ENTIRE objective, not just this step, is now fully achieved and verified. Otherwise write `GOAL STATUS: CONTINUE — <what still remains>`. The director checks your claim against the evidence; claiming complete early only earns a verification step.",
  ].filter(Boolean).join("\n\n");
}

/** The outcomes that count against the failed-step guard. `review` is not one: QA was unsatisfied but
 *  the work exists, and the next step can address what QA found. */
function stepFailed(step: GoalStep): boolean {
  return step.outcome === "failed" || step.outcome == null;
}

// ---- the runner ----

export class GoalRunner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;
  /** Goals mid-evaluation. A second request while one runs sets the flag so it runs once more after. */
  private readonly running = new Map<string, boolean>();
  /** threadId → goalId for each goal's current step, so a task settling wakes its goal at once. */
  private currentThreads = new Map<string, string>();

  constructor(
    private readonly db: Db,
    private readonly hub: EventHub,
    private readonly host: GoalHost,
    private readonly options: { ownerName: string; now?: () => number; tickMs?: number; retryMs?: number },
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  start(): void {
    this.broadcast();
    if (!this.unsubscribe) {
      this.unsubscribe = this.hub.subscribe((e) => {
        if (e.type !== "thread.upsert") return;
        const goalId = this.currentThreads.get(e.thread.id);
        if (goalId && !UNFINISHED_STATES.has(e.thread.state)) this.evaluate(goalId);
      });
    }
    if (!this.timer) {
      this.timer = setInterval(() => this.evaluateAll(), this.options.tickMs ?? GOAL_TICK_MS);
      this.timer.unref?.();
    }
    this.evaluateAll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  list(): Goal[] {
    return this.db.listGoals();
  }

  create(input: GoalInput): GoalResult {
    const title = input.title.trim().slice(0, 200);
    const objective = input.objective.trim();
    const workspace = input.workspace.trim();
    if (!title) return { ok: false, error: "Title is required." };
    if (!objective) return { ok: false, error: "Objective is required." };
    if (!workspace) return { ok: false, error: "Workspace path is required." };
    if (!existsSync(workspace)) return { ok: false, error: `Workspace "${workspace}" does not exist.` };
    const goal = this.db.createGoal({ title, objective, workspace, maxSteps: clampMaxSteps(input.maxSteps) });
    this.hub.log("info", `Goal "${title}" created in ${workspace}.`);
    this.broadcast();
    this.evaluate(goal.id);
    return { ok: true, goal };
  }

  update(id: string, patch: GoalPatch): GoalResult {
    const current = this.db.getGoal(id);
    if (!current) return { ok: false, error: "No such goal." };
    const title = patch.title?.trim().slice(0, 200);
    const objective = patch.objective?.trim();
    if (patch.title !== undefined && !title) return { ok: false, error: "Title is required." };
    if (patch.objective !== undefined && !objective) return { ok: false, error: "Objective is required." };
    const goal = this.db.updateGoal(id, {
      ...(title ? { title } : {}),
      ...(objective ? { objective } : {}),
      ...(patch.maxSteps !== undefined ? { maxSteps: clampMaxSteps(patch.maxSteps) } : {}),
    });
    this.broadcast();
    return { ok: true, goal: goal ?? undefined };
  }

  /**
   * The owner's lifecycle controls. Pausing or ending never touches the step task in flight — it
   * finishes normally, and simply no further step follows. Resuming clears any backoff and evaluates
   * at once. `achieved` here is the owner's own override and needs no agent or director agreement.
   */
  setStatus(id: string, status: GoalStatus, reason?: string): GoalResult {
    const current = this.db.getGoal(id);
    if (!current) return { ok: false, error: "No such goal." };
    if (current.status === status) return { ok: true, goal: current };
    if (current.status === "achieved" || current.status === "abandoned") {
      if (status !== "active") return { ok: false, error: `The goal is already ${current.status}.` };
    }
    const terminal = status === "achieved" || status === "abandoned";
    const defaults: Record<GoalStatus, string | null> = {
      active: null,
      paused: "Paused by the owner.",
      achieved: "Marked achieved by the owner.",
      abandoned: "Abandoned by the owner.",
    };
    const goal = this.db.updateGoal(id, {
      status,
      statusReason: reason?.trim() || defaults[status],
      nextCheckAt: null,
      endedAt: terminal ? this.now() : null,
    });
    this.hub.log("info", `Goal "${current.title}" is now ${status}.`);
    this.broadcast();
    if (status === "active") this.evaluate(id);
    return { ok: true, goal: goal ?? undefined };
  }

  remove(id: string): GoalResult {
    const existed = this.db.deleteGoal(id);
    if (existed) this.broadcast();
    return { ok: existed, error: existed ? undefined : "No such goal." };
  }

  /** Every active goal, once. Cheap when a goal's step is still running: one row read, no model call. */
  evaluateAll(): void {
    for (const goal of this.db.listGoals()) if (goal.status === "active") this.evaluate(goal.id);
  }

  /** Serialised per goal; resolves once this goal has no evaluation pending. */
  evaluate(goalId: string): Promise<void> {
    if (this.running.has(goalId)) {
      this.running.set(goalId, true);
      return Promise.resolve();
    }
    this.running.set(goalId, false);
    const loop = async (): Promise<void> => {
      try {
        do {
          this.running.set(goalId, false);
          await this.advance(goalId).catch((e) => this.hub.log("error", `Goal ${goalId.slice(0, 8)} evaluation failed: ${String(e)}`));
        } while (this.running.get(goalId));
      } finally {
        this.running.delete(goalId);
      }
    };
    return loop();
  }

  /** Waits until no goal is mid-evaluation (tests, and a clean shutdown). */
  async idle(): Promise<void> {
    while (this.running.size) await new Promise((r) => setTimeout(r, 5));
  }

  private async advance(goalId: string): Promise<void> {
    const goal = this.db.getGoal(goalId);
    if (!goal || goal.status !== "active") return;
    if (goal.nextCheckAt && goal.nextCheckAt > this.now()) return;

    const last = this.adoptOrphan(goal, this.db.listGoalSteps(goalId, 1)[0]);
    if (last && !last.threadId && last.settledAt == null) return;
    const thread = last?.threadId ? this.db.getThread(last.threadId) : null;
    if (thread && UNFINISHED_STATES.has(thread.state)) return;
    if (last && last.settledAt == null && this.settleStep(goal, last, thread)) return;

    if (!existsSync(goal.workspace)) return this.pause(goal, `Workspace ${goal.workspace} no longer exists.`);
    if (goal.stepCount >= goal.maxSteps) {
      return this.pause(goal, `Reached its budget of ${goal.maxSteps} steps. Raise the step budget and resume to continue.`);
    }
    await this.judgeAndAct(goalId);
  }

  /**
   * A step recorded but never linked to its task: the process died between recording the step and the
   * dispatch returning. Adopt the task it created if one exists, else close the step as lost.
   */
  private adoptOrphan(goal: Goal, step: GoalStep | undefined): GoalStep | undefined {
    if (!step || step.threadId || step.settledAt != null) return step;
    const threadId = this.db.findGoalStepThread(goal.workspace, stepTitle(goal, step.seq, step.title), step.createdAt);
    if (threadId) {
      this.db.updateGoalStep(step.id, { threadId });
      this.db.updateGoal(goal.id, { currentThreadId: threadId });
      this.refreshCurrentThreads();
      return { ...step, threadId };
    }
    if (this.now() - step.createdAt < ORPHAN_WINDOW_MS) return step;
    this.db.updateGoalStep(step.id, { outcome: "failed", agentClaimedComplete: false, settledAt: this.now() });
    return { ...step, outcome: "failed", agentClaimedComplete: false, settledAt: this.now() };
  }

  /** Records how the step ended. Returns true when that ending paused the goal. */
  private settleStep(goal: Goal, step: GoalStep, thread: Thread | null): boolean {
    if (!step.threadId) return false;
    const report = thread ? this.db.lastMessageOf(thread.id, "implementor", "text")?.content ?? null : null;
    const claimed = detectGoalComplete(report);
    const outcome = thread?.state ?? null;
    this.db.updateGoalStep(step.id, { outcome, agentClaimedComplete: claimed, settledAt: this.now() });
    this.hub.log("info", `Goal "${goal.title}" step ${step.seq} ended ${outcome ?? "(task missing)"}${claimed ? " — agent declared the objective complete" : ""}.`);
    if (outcome === "cancelled") {
      this.pause(goal, `Step ${step.seq}'s task was cancelled. Resume the goal to keep going.`);
      return true;
    }
    const recent = this.db.listGoalSteps(goal.id, GOAL_MAX_FAILED_STEPS);
    if (recent.length >= GOAL_MAX_FAILED_STEPS && recent.every(stepFailed)) {
      this.pause(goal, `The last ${GOAL_MAX_FAILED_STEPS} steps failed. Check the latest step's task, then resume the goal.`);
      return true;
    }
    this.broadcast();
    return false;
  }

  private async judgeAndAct(goalId: string): Promise<void> {
    const goal = this.db.getGoal(goalId)!;
    const steps = this.db.listGoalSteps(goalId, HISTORY_SHOWN);
    const last = steps.at(-1);
    const roster = this.host.roster();
    if (!roster.length) return this.wait(goal, "Waiting for model capacity: no backend can take a task right now.");
    const lastThreadId = last?.threadId ?? null;
    const prompt = buildGoalJudgePrompt({
      goal,
      steps,
      lastReport: lastThreadId ? this.db.lastMessageOf(lastThreadId, "implementor", "text")?.content ?? null : null,
      lastQa: lastThreadId ? this.db.lastMessageOf(lastThreadId, "qa", "text")?.content ?? null : null,
      lastError: lastThreadId ? this.db.getThread(lastThreadId)?.error ?? null : null,
      roster,
      ownerName: this.options.ownerName,
    });
    const answer = await this.host.judge(prompt, goalJudgeSchema(roster)).catch(() => null);
    const judgement = answer ? parseGoalJudgement(answer.output) : null;
    // The owner may have paused, ended or deleted the goal while the director was thinking.
    const fresh = this.db.getGoal(goalId);
    if (!fresh || fresh.status !== "active") return;
    if (!judgement) return this.wait(fresh, "Waiting for the director: no director model returned a usable decision.");

    const agentClaimed = last?.agentClaimedComplete === true;
    const verdict: GoalVerdict = { verdict: judgement.verdict, reason: judgement.reason, agentClaimedComplete: agentClaimed, at: this.now() };
    this.db.updateGoal(goalId, { lastVerdict: verdict, progress: judgement.progress || fresh.progress, statusReason: null, nextCheckAt: null });

    if (judgement.verdict === "complete" && agentClaimed) return this.achieve(fresh, judgement.reason);
    await this.dispatchStep(this.db.getGoal(goalId)!, judgement, judgement.verdict === "complete", roster);
  }

  private async dispatchStep(goal: Goal, judgement: GoalJudgement, verification: boolean, roster: ModelCandidate[]): Promise<void> {
    const pin = resolveStepPin(judgement.next, roster);
    const rationale = [judgement.next.rationale, pin.note].filter(Boolean).join(" ");
    const step = this.db.createGoalStep({
      goalId: goal.id,
      title: judgement.next.title,
      provider: pin.provider,
      model: pin.model,
      effort: pin.effort,
      rationale,
    });
    try {
      const threadId = await this.host.dispatch({
        title: stepTitle(goal, step.seq, step.title),
        workspace: goal.workspace,
        brief: goalStepBrief(goal, step.seq, judgement, verification),
        effort: pin.effort ?? undefined,
        requestedModel: pin.model,
        requestedProvider: pin.provider,
        skipQa: true,
      });
      this.db.updateGoalStep(step.id, { threadId });
      this.db.updateGoal(goal.id, { currentThreadId: threadId });
      this.hub.log(
        "info",
        `Goal "${goal.title}" step ${step.seq} dispatched → task ${threadId.slice(0, 8)} (${[pin.provider, pin.model, pin.effort].filter(Boolean).join(" / ") || "auto routing"}).`,
      );
    } catch (e) {
      this.db.updateGoalStep(step.id, { outcome: "failed", agentClaimedComplete: false, settledAt: this.now() });
      this.hub.log("error", `Goal "${goal.title}" step ${step.seq} failed to dispatch: ${String(e)}`);
      this.db.updateGoal(goal.id, { nextCheckAt: this.now() + this.retryMs(), statusReason: `Step ${step.seq} failed to dispatch; retrying shortly.` });
    }
    this.broadcast();
  }

  private achieve(goal: Goal, reason: string): void {
    this.db.updateGoal(goal.id, { status: "achieved", statusReason: reason, endedAt: this.now(), nextCheckAt: null });
    this.hub.log("info", `Goal "${goal.title}" achieved after ${goal.stepCount} step(s): ${reason}`);
    this.host.notify?.("done", `Goal achieved: ${goal.title}`, reason, goal.workspace);
    this.broadcast();
  }

  private pause(goal: Goal, reason: string): void {
    this.db.updateGoal(goal.id, { status: "paused", statusReason: reason, nextCheckAt: null });
    this.hub.log("warn", `Goal "${goal.title}" paused: ${reason}`);
    this.host.notify?.("input", `Goal paused: ${goal.title}`, reason, goal.workspace);
    this.broadcast();
  }

  /** Stays active but backs off; the reason is shown on the goal so the wait is never silent. */
  private wait(goal: Goal, reason: string): void {
    this.db.updateGoal(goal.id, { statusReason: reason, nextCheckAt: this.now() + this.retryMs() });
    this.hub.log("info", `Goal "${goal.title}": ${reason} Retrying in ${Math.round(this.retryMs() / 60_000)} min.`);
    this.broadcast();
  }

  private retryMs(): number {
    return this.options.retryMs ?? GOAL_RETRY_MS;
  }

  private refreshCurrentThreads(goals: Goal[] = this.db.listGoals()): void {
    this.currentThreads = new Map(goals.filter((g) => g.currentThreadId).map((g) => [g.currentThreadId!, g.id]));
  }

  private broadcast(): void {
    const goals = this.db.listGoals();
    this.refreshCurrentThreads(goals);
    this.hub.publish({ type: "goals", goals });
  }
}

/** One line per goal for the director's list tool and its CLI bridge. */
export function describeGoal(g: Goal): string {
  const current = g.currentThreadId ? `, current task ${g.currentThreadId.slice(0, 8)}` : "";
  const reason = g.statusReason ? ` (${g.statusReason})` : "";
  const progress = g.progress ? ` Progress: ${clip(g.progress, 300)}` : "";
  return `- ${g.id} [${g.status}]${reason} "${g.title}" @ ${g.workspace} — ${g.stepCount}/${g.maxSteps} steps${current}.${progress}`;
}

/** The director's update_goal, shared by the MCP tool and the CLI bridge. Returns the reply text; a
 *  failure starts with "Could not". */
export function applyGoalChange(
  goals: GoalRunner,
  change: { id: string; title?: string; objective?: string; maxSteps?: number; status?: GoalStatus },
  statusReason: string,
): string {
  const { id, status, ...patch } = change;
  const edits = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as GoalPatch;
  if (Object.keys(edits).length) {
    const r = goals.update(id, edits);
    if (!r.ok) return `Could not update the goal: ${r.error}`;
  }
  if (status) {
    const r = goals.setStatus(id, status, status === "active" ? undefined : statusReason);
    if (!r.ok) return `Could not change the goal's status: ${r.error}`;
  }
  const goal = goals.list().find((g) => g.id === id);
  return goal ? `Updated. ${describeGoal(goal)}` : "Could not update the goal: no such goal.";
}

/** The board title of a step task. Also how an orphaned step finds its task again, so keep it stable. */
export function stepTitle(goal: Pick<Goal, "title">, seq: number, title: string): string {
  return `${clip(goal.title, 60)} · step ${seq}: ${title}`;
}
