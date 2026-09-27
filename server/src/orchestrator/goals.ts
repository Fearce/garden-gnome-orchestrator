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
  GOAL_AUTO_EFFORTS,
  GOAL_EFFORTS,
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
 *
 * The owner may pin a goal's effort and/or model; the director then plans steps within that pin. With no
 * effort pinned the director may only choose low or medium, because a goal spends capacity around the clock.
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

/** The owner's pin on a goal. `null` leaves that choice to the director; `undefined` leaves it unchanged. */
export interface GoalPinInput {
  effort?: Effort | null;
  provider?: ImplementorProvider | null;
  model?: string | null;
}

export interface GoalInput extends GoalPinInput {
  title: string;
  objective: string;
  workspace: string;
  maxSteps?: number;
}

export interface GoalPatch extends GoalPinInput {
  title?: string;
  objective?: string;
  maxSteps?: number;
}

type GoalPin = Pick<Goal, "effort" | "provider" | "model">;

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

/**
 * Validates an owner pin from any entry point (console, director tool, CLI bridge). A model travels only
 * with its provider: half a pin would read as pinned while routing automatically.
 */
export function validateGoalPin(pin: GoalPinInput): string | null {
  if (pin.effort != null && !GOAL_EFFORTS.includes(pin.effort)) return `Effort must be one of ${GOAL_EFFORTS.join(", ")}.`;
  if (pin.provider != null && !GOAL_PROVIDERS.includes(pin.provider)) return `Provider must be one of ${GOAL_PROVIDERS.join(", ")}.`;
  const halfPin = (pin.model === undefined) !== (pin.provider === undefined) || (pin.model == null) !== (pin.provider == null);
  return halfPin ? "A model needs its provider, and a provider needs its model." : null;
}

/** The efforts the director may choose for a step: the owner's, or low/medium when the owner set none. */
function allowedEfforts(goal: GoalPin): Effort[] {
  return goal.effort ? [goal.effort] : GOAL_AUTO_EFFORTS;
}

/** The JSON schema of the director's answer, narrowed to the owner's pin and to what can dispatch now. */
export function goalJudgeSchema(goal: GoalPin, roster: ModelCandidate[]): JsonSchemaLike {
  const pinned = goal.provider && goal.model ? { provider: goal.provider, model: goal.model } : null;
  const providers = pinned ? [pinned.provider] : GOAL_PROVIDERS.filter((p) => roster.some((c) => c.provider === p));
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
          model: pinned ? { type: "string", enum: [pinned.model] } : { type: "string" },
          effort: { type: "string", enum: allowedEfforts(goal) },
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
  const effort = lowerToOffered(pick.effort, found.efforts);
  const moved = found.provider !== pick.provider ? `${pick.model} runs on ${found.provider}, not ${pick.provider}. ` : "";
  const lowered = effort !== pick.effort ? `${found.model} does not offer ${pick.effort} effort; using ${effort}.` : "";
  return { provider: found.provider, model: found.model, effort, note: `${moved}${lowered}`.trim() || null };
}

/**
 * The pin a step runs with: the director's pick, bounded by the owner's goal pin. An owner model is
 * dispatched as an exact pin even when it has no capacity right now (the task waits for it, as a pinned
 * schedule does); the effort still drops to the nearest tier that model offers.
 */
export function goalStepPin(goal: GoalPin, pick: GoalJudgement["next"], roster: ModelCandidate[]): StepPin {
  const allowed = allowedEfforts(goal);
  const effort = allowed.includes(pick.effort) ? pick.effort : allowed.at(-1)!;
  const capped = !goal.effort && effort !== pick.effort ? `Capped at ${effort} effort: this goal has no effort set, so its steps run at low or medium.` : null;
  if (!goal.provider || !goal.model) {
    const pin = resolveStepPin({ ...pick, effort }, roster);
    return { ...pin, note: [capped, pin.note].filter(Boolean).join(" ") || null };
  }
  const found = roster.find((c) => c.provider === goal.provider && c.model.toLowerCase() === goal.model!.toLowerCase());
  const offered = found ? lowerToOffered(effort, found.efforts) : effort;
  const lowered = offered !== effort ? `${goal.model} does not offer ${effort} effort; using ${offered}.` : null;
  return { provider: goal.provider, model: goal.model, effort: offered, note: [capped, lowered].filter(Boolean).join(" ") || null };
}

/** The requested effort when offered, else the nearest lower tier, else the lowest one offered. */
function lowerToOffered(effort: Effort, offered: Effort[]): Effort | null {
  if (offered.includes(effort)) return effort;
  const idx = EFFORTS.indexOf(effort);
  return [...offered].filter((e) => EFFORTS.indexOf(e) <= idx).pop() ?? offered[0] ?? null;
}

/** The judge prompt's instruction for the step's backend, model and effort, per the owner's pin. */
function pickInstruction(goal: GoalPin, ownerName: string): string {
  const model = goal.provider && goal.model
    ? `${ownerName} pinned every step to provider "${goal.provider}", model "${goal.model}": use exactly that.`
    : "Choose `provider` and `model` for that step from the roster below. The goal runs 24/7, so spend capacity deliberately: a flagship model for hard, risky or architectural steps, a cheaper one for mechanical steps, and prefer pools with headroom so the goal does not exhaust one subscription and stall.";
  const effort = goal.effort
    ? `${ownerName} set this goal's effort to ${goal.effort}: use exactly "${goal.effort}".`
    : `${ownerName} capped this goal at low or medium effort: choose "low" for mechanical steps and "medium" for everything else.`;
  return `- ${model} ${effort} Say why in \`rationale\`.`;
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
    "- `next`: the next step, as a concrete, self-contained brief. Make it one LONG-RUNNING task covering ALL the remaining work of the objective, ordered so the most valuable part comes first. Every step is a fresh agent session that re-reads the repository before it can work, plus another judgement from you, so many small steps waste tokens that one long step spends on the work itself. Split the remaining work only where a later part truly depends on your judging an earlier result, never just to keep a step small. Build on what earlier steps did; if a step failed or QA rejected it, address why. The brief goes to the implementor as-is, together with the objective.",
    pickInstruction(goal, ctx.ownerName),
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
    "This is a long-running task: finish this step completely, then keep going into the rest of the objective in this same task, committing at each coherent point. Stop only when the ENTIRE objective is achieved or you are blocked on something only the owner can resolve. Each new step starts a fresh session that must re-learn the repository, so one long task costs far fewer tokens than many short ones. Then report what you did.",
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
    const pin = trimPinModel({ effort: input.effort ?? null, provider: input.provider ?? null, model: input.model ?? null });
    const pinError = validateGoalPin(pin);
    if (pinError) return { ok: false, error: pinError };
    const goal = this.db.createGoal({
      title,
      objective,
      workspace,
      maxSteps: clampMaxSteps(input.maxSteps),
      effort: pin.effort ?? null,
      provider: pin.provider ?? null,
      model: pin.model ?? null,
    });
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
    const pin = trimPinModel({ effort: patch.effort, provider: patch.provider, model: patch.model });
    const pinError = validateGoalPin(pin);
    if (pinError) return { ok: false, error: pinError };
    const goal = this.db.updateGoal(id, {
      ...(title ? { title } : {}),
      ...(objective ? { objective } : {}),
      ...(patch.maxSteps !== undefined ? { maxSteps: clampMaxSteps(patch.maxSteps) } : {}),
      ...(pin.effort !== undefined ? { effort: pin.effort } : {}),
      ...(pin.model !== undefined ? { provider: pin.provider ?? null, model: pin.model } : {}),
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
    const answer = await this.host.judge(prompt, goalJudgeSchema(goal, roster)).catch(() => null);
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
    const pin = goalStepPin(goal, judgement.next, roster);
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

/** A blank model is no pin. Undefined fields stay undefined so a patch leaves them unchanged. */
function trimPinModel(pin: GoalPinInput): GoalPinInput {
  return pin.model === undefined ? pin : { ...pin, model: pin.model?.trim() || null };
}

/** The owner's pin as the director reads it, e.g. "codex / gpt-5.6, high effort". */
export function describeGoalPin(g: GoalPin): string {
  const model = g.provider && g.model ? `${g.provider} / ${g.model}` : "director's model";
  return `${model}, ${g.effort ? `${g.effort} effort` : "low–medium effort"}`;
}

/** One line per goal for the director's list tool and its CLI bridge. */
export function describeGoal(g: Goal): string {
  const current = g.currentThreadId ? `, current task ${g.currentThreadId.slice(0, 8)}` : "";
  const reason = g.statusReason ? ` (${g.statusReason})` : "";
  const progress = g.progress ? ` Progress: ${clip(g.progress, 300)}` : "";
  return `- ${g.id} [${g.status}]${reason} "${g.title}" @ ${g.workspace} — ${g.stepCount}/${g.maxSteps} steps, ${describeGoalPin(g)}${current}.${progress}`;
}

/** The director's update_goal, shared by the MCP tool and the CLI bridge. Returns the reply text; a
 *  failure starts with "Could not". */
export function applyGoalChange(
  goals: GoalRunner,
  change: { id: string; title?: string; objective?: string; maxSteps?: number; status?: GoalStatus } & GoalPinInput,
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
