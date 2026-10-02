import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import type { Db } from "../db/db.js";
import type { EventHub } from "../events.js";
import type { JsonSchemaLike } from "../agents/structuredText.js";
import { latestFamilyModel } from "../agents/modelFamily.js";
import type { DispatchInput } from "./api.js";
import type { ModelCandidate } from "./modelSelector.js";
import { UNFINISHED_STATES } from "./scheduler.js";
import { formatUntil } from "./capacityRouting.js";
import { describeGoalUsage, providerOfRunAccount, UNMETERED_PROVIDER } from "./goalUsage.js";
import { actionKey, assessSessionProgress } from "./continuationProgress.js";
import {
  DEFAULT_GOAL_BURN_RATE_PCT,
  DEFAULT_GOAL_MAX_CONCURRENT,
  EFFORTS,
  GOAL_AUTO_EFFORTS,
  GOAL_EFFORTS,
  MAX_GOAL_BURN_RATE_PCT,
  MAX_GOAL_MAX_CONCURRENT,
  MAX_GOAL_TOKEN_BUDGET,
  MIN_GOAL_BURN_RATE_PCT,
  type Effort,
  type Goal,
  type GoalHold,
  type GoalOwnerStatus,
  type GoalStep,
  type GoalTurnActivity,
  type GoalVerdict,
  type ImplementorProvider,
  type Thread,
  type ThreadState,
} from "../types.js";

/**
 * GOAL-DIRECTED TASKS — a standing objective GGO keeps a task working on until it is done.
 *
 * Not a schedule (that fires the same prompt on a clock) and not a timed task (one task with a window).
 * A goal is a loop of ordinary tasks. The director plans the first step — choosing its backend, model and
 * effort from what can dispatch right now. A sequential goal (`persistentSession`, one step at a time)
 * then CONTINUES that task in its own session at each idle turn boundary, with a short continuation
 * instead of a fresh task and a director call: the session's context (and the provider's own compaction)
 * carries the work forward. The director is asked again only when there is something to judge: a
 * completion claim to audit, a changed objective or pin, or a turn that ended unclean. A parallel goal
 * asks the director at every step, as each step is a fresh task.
 *
 * Ending takes TWO agreeing voices: the step's implementor must declare the whole objective complete
 * (`GOAL STATUS: COMPLETE` on its own line) AND the director, reading that report, must agree. A
 * director who thinks it is done without that claim asks for a verification turn instead; an agent
 * claim the director rejects just gets more work. Neither side can end the loop alone.
 *
 * Automatic continuation stops itself rather than spin, judged from evidence a report cannot fake (tool
 * calls, findings, the git state): a second turn running with no tool call, a turn that did no new work and repeated the
 * report before it, three turns running that did no new work, or three turns blocked on the same impasse
 * with nothing changed move the goal to `blocked`; a spent token budget to `budget_limited`. The budget is
 * checked between turns from finished runs' recorded usage, so a running turn may exceed it, and director
 * judgements are outside it. Both stops wait for the owner, and an explicit resume starts a fresh audit. A turn that waits on a live job is deferred, not continued at once.
 *
 * The loop is driven by durable state only (`goals` + `goal_steps`), re-read on every evaluation, so a
 * restart simply re-evaluates. There is no step budget: a goal keeps going until it is done. A run
 * of failed steps or a cancelled step (the owner intervened) pauses it with a reason.
 *
 * The owner may pin a goal's effort and/or model; the director then plans steps within that pin. With no
 * effort pinned the director may only choose low or medium, because a goal spends capacity around the clock.
 *
 * A goal may run up to `maxConcurrent` step tasks at once; the director fills each free slot with work
 * that can proceed beside the running steps, or answers `wait` until one of them ends. With
 * `burnConservation` on (the default), no new step starts while every pool the goal could use has spent
 * more of its weekly window than `burnRatePct` of an even pace allows; the goal holds until the pace
 * catches up or the window resets. A running step is asked to wrap up at its next turn ceiling once its
 * pool is over pace or the goal is no longer active (`stepWrapUpReason`), so one long step cannot
 * outrun the guard.
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
/** At most this many reports of steps that ended since the last judgement go into one judge prompt. */
const SETTLED_SHOWN = 4;
const RUNNING_BRIEF_CHARS = 1_200;
const WEEK_MS = 7 * 24 * 60 * 60_000;
/** Percentage points a pool may run ahead of its pace, so a fresh weekly window is not held on its first step. */
export const GOAL_BURN_GRACE_PCT = 5;
/** A burn-rate hold re-checks at least this often: another pool may free up before the pace catches up. */
const BURN_RECHECK_MAX_MS = 30 * 60_000;
/** A step whose run is only tearing down is looked at again this soon. */
const SETTLING_RECHECK_MS = 3_000;

export const GOAL_PROVIDERS: ImplementorProvider[] = ["claude", "codex", "grok", "zai"];
const POOL_LABEL: Record<ImplementorProvider, string> = { claude: "Claude", codex: "Codex", grok: "Grok", zai: "z.ai" };

/** The director's raw answer, or the reason it could not give one, shown to the owner while the goal waits. */
export type GoalJudgeAnswer = { output: unknown; model: string; provider: ImplementorProvider } | { failure: string };

/** Why a step task that stopped must not count as ended yet, or why its next turn cannot start now. */
export interface GoalTaskHold {
  kind: GoalHold;
  reason: string;
  /** Only the run's teardown is left: look again in seconds instead of waiting for the next tick. */
  settling?: boolean;
}

/**
 * The answer to sending a goal's next turn into a step task's own session. `hold` means not now (the task
 * is busy, input is pending, capacity is short) and costs nothing; `fresh` means this task can never take
 * another turn (it is gone, closed, or has no session), so a fresh task is needed; `stop` means continuing
 * would override something only the owner can settle.
 */
export type GoalContinuation = { ok: true } | { ok: false; hold: GoalTaskHold } | { ok: false; fresh: string } | { ok: false; stop: string };

/** What the runner needs from the rest of GGO. ThreadManager provides all of it; tests fake it. */
export interface GoalHost {
  dispatch(input: DispatchInput): Promise<string>;
  /** One bounded no-tools director judgement, or why no director model gave one. */
  judge(prompt: string, schema: JsonSchemaLike): Promise<GoalJudgeAnswer>;
  /** Every (provider, model) pair a task could be dispatched to right now, with its efforts. */
  roster(): ModelCandidate[];
  notify?(kind: "done" | "input", title: string, detail?: string, repo?: string): void;
  /** Why a step task in a stopped state is still owed work by GGO itself (a cap park, a restart auto-resume, its
   *  run's teardown), so its step must keep its slot instead of settling. Absent: never. */
  taskHold?(threadId: string): GoalTaskHold | null;
  /** Sends a goal's next turn into a finished step task's own session. Absent: every step is a fresh task. */
  continueTask?(threadId: string, message: string): GoalContinuation;
  /** The git state of a step task's workspace; one piece of a turn's progress evidence. Absent or null: unknown. */
  workspaceFingerprint?(threadId: string): Promise<string | null>;
}

/** The owner's pin on a goal. `null` leaves that choice to the director; `undefined` leaves it unchanged. */
export interface GoalPinInput {
  effort?: Effort | null;
  provider?: ImplementorProvider | null;
  model?: string | null;
}

/** How hard a goal may run: parallel steps and the weekly burn-rate guard. `undefined` leaves a field unchanged. */
export interface GoalPaceInput {
  maxConcurrent?: number;
  burnConservation?: boolean;
  burnRatePct?: number;
  /** One-at-a-time goals carry their task's session from turn to turn (the default). */
  persistentSession?: boolean;
  /** Fresh input + output tokens the goal's step-task runs may spend, checked between turns (a running turn may
   *  exceed it); null removes the budget. */
  tokenBudget?: number | null;
}

export interface GoalInput extends GoalPinInput, GoalPaceInput {
  title: string;
  objective: string;
  workspace: string;
}

export interface GoalPatch extends GoalPinInput, GoalPaceInput {
  title?: string;
  objective?: string;
}

type GoalPin = Pick<Goal, "effort" | "provider" | "model">;
type GoalPace = Pick<Goal, "burnConservation" | "burnRatePct">;

export interface GoalResult {
  ok: boolean;
  error?: string;
  goal?: Goal;
}

/** The director's structured answer for one evaluation. `wait` is only offered while steps are running. */
export interface GoalJudgement {
  verdict: "complete" | "continue" | "wait";
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
const STATUS_LINE = /^[\s>*_`#-]*GOAL STATUS\s*:\s*[*_`]*\s*(COMPLETE|CONTINUE|BLOCKED|WAITING)\b(.*)$/i;

/** A turn's closing status: the whole objective done, more to do, a job still running, or an impasse. */
export interface GoalStatusLine {
  kind: "complete" | "continue" | "waiting" | "blocked";
  detail: string;
}

/**
 * The status line a step's report ends on. The last status line wins, and a COMPLETE line must stand
 * alone: the brief quotes the marker mid-sentence, so an agent echoing its instructions
 * ("`GOAL STATUS: COMPLETE` if …") can never end a goal by accident.
 */
export function readGoalStatusLine(report: string | null | undefined): GoalStatusLine | null {
  if (!report) return null;
  let found: GoalStatusLine | null = null;
  for (const line of report.split(/\r?\n/)) {
    const m = STATUS_LINE.exec(line);
    if (!m) continue;
    const kind = m[1]!.toLowerCase() as GoalStatusLine["kind"];
    if (kind === "complete" && !COMPLETE_LINE.test(line)) continue;
    found = { kind, detail: m[2]!.replace(/^[\s*_`.!]*[—–:-]?\s*/, "").replace(/[\s*_`]+$/, "").trim() };
  }
  return found;
}

/** Whether a step's final report declares the WHOLE objective complete. */
export function detectGoalComplete(report: string | null | undefined): boolean {
  return readGoalStatusLine(report)?.kind === "complete";
}

/** Consecutive goal turns BLOCKED on the same impasse that stop the goal; until then each turn tries again. */
export const GOAL_BLOCKED_TURNS = 3;
/** Consecutive goal turns that did no new work that stop automatic continuation. */
export const GOAL_IDLE_TURNS = 3;
/** Consecutive turns of one task that end unclean (`review`) before the goal stops continuing it. */
export const GOAL_UNCLEAN_TURNS = 2;
/** Consecutive turns of one task with no tool call that stop the goal; the first only asks the director. */
export const GOAL_SILENT_TURNS = 2;
/** The longest a goal waits between checks on a live job its turns keep reporting without new work. */
export const GOAL_WAIT_BACKOFF_MAX_MS = 60 * 60_000;
/** A turn's tool calls are compared with this many of the task's earlier ones to find what it tried anew. */
const EARLIER_ACTIONS_COMPARED = 500;

/** What a persistent goal's turn left behind that its prose cannot fake. */
interface TurnEvidence {
  /** The task's git state when the turn ended; the next turn's change is measured from it. */
  fingerprint: string | null;
  /** New work of any kind: new actions, a new finding, or a repository change. */
  progressed: boolean;
  /** The repository or the task's findings changed, so an impasse reported now is not the one before. */
  moved: boolean;
}

/** A token budget from any entry point: null (none) or a positive whole number of tokens. */
export function validateTokenBudget(budget: number | null | undefined): string | null {
  if (budget == null) return null;
  return Number.isInteger(budget) && budget > 0 && budget <= MAX_GOAL_TOKEN_BUDGET ? null : "A token budget must be a positive whole number of tokens.";
}

/** A budget counts tokens, and Grok reports none, so a budgeted goal never runs there. */
function budgetPinError(budget: number | null | undefined, provider: ImplementorProvider | null | undefined): string | null {
  return budget != null && provider === UNMETERED_PROVIDER
    ? "Grok reports no token usage, so a goal with a token budget cannot be pinned to it."
    : null;
}

/** The candidates a goal's steps may run on: all of them, except Grok for a goal with a token budget. */
export function meteredRoster(goal: Pick<Goal, "tokenBudget">, roster: ModelCandidate[]): ModelCandidate[] {
  return goal.tokenBudget == null ? roster : roster.filter((c) => c.provider !== UNMETERED_PROVIDER);
}

function noCapacityReason(goal: Pick<Goal, "tokenBudget">, roster: ModelCandidate[]): string {
  return goal.tokenBudget != null && roster.length
    ? "Waiting for model capacity: only Grok can take a task right now, and it reports no token usage for this goal's budget."
    : "Waiting for model capacity: no backend can take a task right now.";
}

/** The normalised fingerprint of a report, so two turns that ended on the same words are recognised. */
export function reportDigest(report: string): string {
  return createHash("sha256").update(report.replace(/\s+/g, " ").trim().toLowerCase()).digest("hex").slice(0, 32);
}

export function clampMaxConcurrent(value: number | undefined): number {
  return clampInt(value, 1, MAX_GOAL_MAX_CONCURRENT, DEFAULT_GOAL_MAX_CONCURRENT);
}

export function clampBurnRate(value: number | undefined): number {
  return clampInt(value, MIN_GOAL_BURN_RATE_PCT, MAX_GOAL_BURN_RATE_PCT, DEFAULT_GOAL_BURN_RATE_PCT);
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value == null || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

// ---- burn rate ----

/** One pool spending its weekly window faster than the goal's burn rate allows. */
export interface PoolOverPace {
  pool: string;
  usedPct: number;
  budgetPct: number;
  /** When the pace line catches up with what the pool has used, or its reset if that comes first. */
  clearsAt: number;
}

/**
 * The share of a weekly window a pool may have used by `now` at this burn rate: the even pace (the
 * fraction of the week gone) scaled by the rate, plus a small grace so a fresh window is not held at once.
 */
export function burnBudgetPct(resetAt: number, burnRatePct: number, now: number): number {
  const elapsed = Math.min(1, Math.max(0, 1 - (resetAt - now) / WEEK_MS));
  return Math.min(100, burnRatePct * elapsed + GOAL_BURN_GRACE_PCT);
}

/** Null when the candidate's pool is within the burn rate, has no fresh weekly reading to pace against, or
 *  is the sub the owner is preparing for its reset (Settings → "Burn this sub first"), which goals spend
 *  freely: its banked reset refills whatever pacing would have kept. Only hard availability holds it. */
export function poolOverPace(candidate: ModelCandidate, burnRatePct: number, now: number): PoolOverPace | null {
  const weekly = candidate.weekly;
  if (!weekly || weekly.resetAt <= now || candidate.resetBurn) return null;
  const budgetPct = burnBudgetPct(weekly.resetAt, burnRatePct, now);
  if (weekly.usedPct <= budgetPct) return null;
  const elapsedNeeded = Math.max(0, (weekly.usedPct - GOAL_BURN_GRACE_PCT) / burnRatePct);
  const clearsAt = elapsedNeeded >= 1 ? weekly.resetAt : weekly.resetAt - WEEK_MS * (1 - elapsedNeeded);
  return { pool: POOL_LABEL[candidate.provider], usedPct: weekly.usedPct, budgetPct, clearsAt };
}

export interface BurnCheck {
  /** The candidates the director may pick from: those within the burn rate. */
  roster: ModelCandidate[];
  /** The pools left out for spending too fast, one entry per pool. */
  over: PoolOverPace[];
  /** Set when no new step may start: why, and when to look again. */
  hold: { reason: string; until: number } | null;
}

/**
 * Applies a goal's burn-rate conservation to the dispatchable roster. An unpinned goal holds only when
 * EVERY pool is ahead of its pace (one with room left keeps it going); a goal pinned to one model holds
 * whenever that model's pool is. Off, it passes the roster through untouched.
 */
export function checkBurnRate(goal: GoalPin & GoalPace, roster: ModelCandidate[], now: number): BurnCheck {
  const pinned = goal.provider && goal.model ? { provider: goal.provider, model: goal.model.toLowerCase() } : null;
  if (!goal.burnConservation) return { roster: pinned ? roster : burnTargetFirst(roster), over: [], hold: null };
  const considered = pinned ? roster.filter((c) => c.provider === pinned.provider && c.model.toLowerCase() === pinned.model) : roster;
  const over = new Map<string, PoolOverPace>();
  const within = considered.filter((c) => {
    const pace = poolOverPace(c, goal.burnRatePct, now);
    if (pace) over.set(pace.pool, pace);
    return !pace;
  });
  const pools = [...over.values()];
  const held = pinned ? pools.length > 0 : pools.length > 0 && within.length === 0;
  return { roster: pinned ? roster : burnTargetFirst(within), over: pools, hold: held ? burnHold(goal.burnRatePct, pools, !pinned, now) : null };
}

/**
 * While a sub is being prepared for its reset, an unpinned goal's steps choose among its models only. The
 * host roster keeps every other pool (flagged or not) so a goal PINNED to one of them, or a step that
 * failed over onto one, is still paced against that pool's own weekly reading.
 */
function burnTargetFirst(roster: ModelCandidate[]): ModelCandidate[] {
  const target = roster.filter((c) => c.resetBurn);
  return target.length ? target : roster;
}

/**
 * Why a goal's running step should wrap up at its next turn ceiling instead of continuing, or null. A step
 * runs for hours across many turn ceilings, so checking the pace only before a step starts let one step
 * spend a whole night's quota; a paused or ended goal likewise wants no more work put into its step.
 * `provider` is the backend the step is running on now: a step dispatched on automatic routing records
 * no provider, and one that failed over mid-task runs on another pool than the one it was dispatched to.
 */
export function stepWrapUpReason(
  goal: Goal,
  step: GoalStep,
  roster: ModelCandidate[],
  now: number,
  provider: ImplementorProvider | null = step.provider,
): string | null {
  if (goal.status !== "active") {
    const why = goal.statusReason?.trim().replace(/\.+$/, "");
    return `the goal "${goal.title}" is ${goal.status}${why ? ` (${why})` : ""}`;
  }
  if (budgetSpent(goal)) return `the goal "${goal.title}" has spent its step-task token budget: ${describeGoalUsage(goal.usage, goal.tokenBudget)}`;
  if (!goal.burnConservation || !provider) return null;
  for (const candidate of roster.filter((c) => c.provider === provider)) {
    const pace = poolOverPace(candidate, goal.burnRatePct, now);
    if (pace) {
      return `the goal "${goal.title}" is spending faster than its burn rate: ${pace.pool} has used ${Math.round(pace.usedPct)}% of its weekly window, ${Math.round(pace.budgetPct)}% allowed by now at ${goal.burnRatePct}% pace`;
    }
  }
  return null;
}

/** Whether the goal's metered spend has reached its budget. Unmetered runs make the spend a lower bound,
 *  so a budget can be reached late, never early. */
export function budgetSpent(goal: Pick<Goal, "tokenBudget" | "usage">): boolean {
  return goal.tokenBudget != null && goal.usage.tokensUsed >= goal.tokenBudget;
}

function budgetStopReason(goal: Pick<Goal, "tokenBudget" | "usage">): string {
  return `Its step tasks used the token budget: ${describeGoalUsage(goal.usage, goal.tokenBudget)}. Raise or remove the budget, then resume the goal.`;
}

function burnHold(burnRatePct: number, pools: PoolOverPace[], anyPoolFrees: boolean, now: number): { reason: string; until: number } {
  const clearsAt = Math.min(...pools.map((p) => p.clearsAt));
  const detail = pools.map((p) => `${p.pool} has used ${Math.round(p.usedPct)}% of its weekly window, ${Math.round(p.budgetPct)}% allowed by now`).join("; ");
  const reason = `Paused for burn rate: ${detail} at ${burnRatePct}% pace. New steps resume ${formatUntil(clearsAt, now)} as the pace catches up${anyPoolFrees ? ", or sooner if another pool frees up" : ""}.`;
  return { reason, until: Math.min(clearsAt, now + BURN_RECHECK_MAX_MS) };
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

/** The JSON schema of the director's answer, narrowed to the owner's pin and to what can dispatch now.
 *  `wait` is on offer only while steps are running: with none, there is nothing to wait for. */
export function goalJudgeSchema(goal: GoalPin, roster: ModelCandidate[], running = 0): JsonSchemaLike {
  const pinned = goal.provider && goal.model ? { provider: goal.provider, model: goal.model } : null;
  const providers = pinned ? [pinned.provider] : GOAL_PROVIDERS.filter((p) => roster.some((c) => c.provider === p));
  return {
    type: "object",
    additionalProperties: false,
    required: ["verdict", "reason", "progress", "next"],
    properties: {
      verdict: { type: "string", enum: running > 0 ? ["complete", "continue", "wait"] : ["complete", "continue"] },
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

/** Why a judgement could not be used, as one sentence for the goal's waiting reason. */
function unusableAnswer(answer: GoalJudgeAnswer): string {
  const why = "failure" in answer ? answer.failure : `${answer.model} (${answer.provider}) returned a decision without a verdict, step title or brief.`;
  const text = clip(why.replace(/\s+/g, " ").trim(), 600);
  return /[.!?…]$/.test(text) ? text : `${text}.`;
}

/** Validates the director's raw answer. Null means "unusable" — the caller retries later. */
export function parseGoalJudgement(raw: unknown): GoalJudgement | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const next = r.next as Record<string, unknown> | undefined;
  if (r.verdict !== "complete" && r.verdict !== "continue" && r.verdict !== "wait") return null;
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
export function goalStepPin(goal: GoalPin, next: GoalJudgement["next"], roster: ModelCandidate[]): StepPin {
  // Both halves name a line, not a release: the step records and runs its line's newest member.
  const pick = { ...next, model: latestFamilyModel(next.model) };
  if (goal.model) goal = { ...goal, model: latestFamilyModel(goal.model) };
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

/** A step that ended since the director's last judgement, with what its task left behind. */
export interface SettledStepReport {
  step: GoalStep;
  report: string | null;
  qa: string | null;
  error: string | null;
}

/** A step still running, with the brief the director gave it. */
export interface RunningGoalStep {
  step: GoalStep;
  brief: string;
}

export interface GoalJudgeContext {
  goal: Goal;
  steps: GoalStep[];
  /** Steps that ended since the last judgement, oldest first; empty before the first step ends. */
  settled: SettledStepReport[];
  running: RunningGoalStep[];
  roster: ModelCandidate[];
  /** Pools left off the roster because they are spending faster than the goal's burn rate. */
  overPace?: PoolOverPace[];
  ownerName: string;
  /** The last step's task can take `next` as another turn in its own session. */
  continues?: boolean;
  /** Why a persistent goal asks the director now, rather than continuing on its own. */
  askedBecause?: string;
}

const pickLabel = (s: GoalStep): string => [s.provider, s.model, s.effort].filter(Boolean).join(" / ") || "auto routing";

function historyLine(s: GoalStep): string {
  const ending = s.settledAt == null ? "still running" : `ended ${s.outcome ?? "unknown"}`;
  return `- Step ${s.seq} "${s.title}" — ${pickLabel(s)} — ${ending}${s.agentClaimedComplete ? ", agent claimed the objective complete" : ""}`;
}

function settledBlock(settled: SettledStepReport[], anyStep: boolean, running: number): string {
  if (!settled.length) {
    if (!anyStep) return "No step has run yet. Plan the first one.";
    return running ? "No step has ended since your last decision." : "";
  }
  const reportChars = Math.max(1_500, Math.floor(REPORT_EXCERPT_CHARS / settled.length));
  const blocks = settled.map(({ step, report, qa, error }) =>
    [
      `THE STEP THAT JUST ENDED (step ${step.seq}, "${step.title}") settled as: ${step.outcome ?? "unknown"}.`,
      `Its agent ${step.agentClaimedComplete ? "DECLARED the whole objective complete" : "did NOT declare the objective complete"}.`,
      error ? `Task error: ${clip(error, 800)}` : "",
      `Its final report:\n${report ? tail(report, reportChars) : "(no report was written)"}`,
      qa ? `QA's last word on it:\n${tail(qa, QA_EXCERPT_CHARS)}` : "",
    ].filter(Boolean).join("\n"),
  );
  return settled.length === 1 ? blocks[0]! : `${settled.length} STEPS ENDED SINCE YOUR LAST DECISION (oldest first):\n\n${blocks.join("\n\n")}`;
}

function runningBlock(goal: Goal, running: RunningGoalStep[]): string {
  if (!running.length) return "";
  const lines = running.map(({ step, brief }) => `- Step ${step.seq} "${step.title}" — ${pickLabel(step)}${brief ? `\n  Its brief: ${clip(brief.replace(/\s+/g, " "), RUNNING_BRIEF_CHARS)}` : ""}`);
  return `STEPS STILL RUNNING (${running.length} of up to ${goal.maxConcurrent} at once), in this same repository:\n${lines.join("\n")}`;
}

/** The `next` instruction: one long step for a sequential goal, a disjoint long share for a parallel one. */
function nextInstruction(goal: Goal, continues: boolean): string {
  const tail = "Every step is a fresh agent session that re-reads the repository before it can work, plus another judgement from you, so many small steps waste tokens that one long step spends on the work itself. Build on what earlier steps did; if a step failed or QA rejected it, address why. The brief goes to the implementor as-is, together with the objective.";
  if (continues) {
    return "- `next`: what remains, as a concrete brief covering ALL the remaining work of the objective, most valuable part first. It goes into the SAME task and session that ran the last step, which keeps its context and its model, so do not re-explain what that agent already knows; name the gaps and the evidence that will close them. Your provider/model/effort pick is used only if that task cannot take another turn and a fresh task is needed.";
  }
  if (goal.maxConcurrent <= 1) {
    return `- \`next\`: the next step, as a concrete, self-contained brief. Make it one LONG-RUNNING task covering ALL the remaining work of the objective, ordered so the most valuable part comes first. Split the remaining work only where a later part truly depends on your judging an earlier result, never just to keep a step small. ${tail}`;
  }
  return `- \`next\`: the next step, as a concrete, self-contained brief. This goal runs up to ${goal.maxConcurrent} step tasks at once in the same repository, so make \`next\` a LONG-RUNNING task over a large share of the remaining work that can proceed IN PARALLEL with the running steps: different files and concerns, no dependency on their unfinished results. Still prefer a few long steps to many short ones. ${tail}`;
}

function verdictInstructions(ownerName: string, running: number): string[] {
  const lines = [
    `- verdict "complete" ONLY if the objective as ${ownerName} wrote it is fully met and the evidence shows it (not merely that a step finished). Audit each requirement of the objective against the report's evidence; a job still being polled is not a finished one. Otherwise "continue".`,
    "- The goal ends only when you say complete AND the last step's agent declared it complete. If you believe it is complete but the agent did not declare it, still return \"complete\" and make `next` a VERIFICATION step: independently check every part of the objective, fix any gap, and declare the result.",
  ];
  if (running) {
    lines.push(
      "- Steps are still running. Return \"wait\" when the next useful step depends on their results or would collide with their work; GGO then starts nothing more until one of them ends, and asks you again. While any step runs, \"complete\" is held the same way, and `next` is ignored on either.",
    );
  }
  return lines;
}

function rosterBlock(roster: ModelCandidate[], overPace: PoolOverPace[] | undefined): string {
  const lines = roster.map((c) =>
    `- provider "${c.provider}", model "${c.model}", efforts [${c.efforts.join(", ")}]${c.note ? ` — ${c.note}` : ""}${c.capacity ? ` Capacity: ${c.capacity}` : ""}`,
  );
  const held = overPace?.length
    ? `\nLeft out for spending faster than this goal's burn rate allows: ${overPace.map((p) => `${p.pool} (${Math.round(p.usedPct)}% of its weekly window used, ${Math.round(p.budgetPct)}% allowed by now)`).join(", ")}.`
    : "";
  return (lines.length ? `DISPATCHABLE MODELS RIGHT NOW:\n${lines.join("\n")}` : "No model reports headroom right now; pick the one you would want when capacity returns.") + held;
}

export function buildGoalJudgePrompt(ctx: GoalJudgeContext): string {
  const { goal, steps, running } = ctx;
  const history = steps.slice(-HISTORY_SHOWN).map(historyLine);
  const keeps = goal.maxConcurrent > 1 ? `up to ${goal.maxConcurrent} step tasks at once` : "one step task";
  return [
    `You are GGO's director, steering a GOAL-DIRECTED TASK for ${ctx.ownerName}. GGO keeps ${keeps} working on this goal around the clock until the step's agent AND you agree the objective is fully achieved. You decide each step, and the backend, model and effort it runs on.`,
    "",
    `GOAL: ${goal.title}`,
    `OBJECTIVE (${ctx.ownerName}'s words, the fixed yardstick):\n${goal.objective}`,
    `REPOSITORY: ${goal.workspace}`,
    `Steps so far: ${goal.stepCount}.`,
    `Progress so far (your own earlier summary): ${goal.progress || "none yet"}`,
    history.length ? `Step history (oldest first):\n${history.join("\n")}` : "",
    "",
    settledBlock(ctx.settled, steps.length > 0, running.length),
    "",
    runningBlock(goal, running),
    "",
    ctx.askedBecause ? `WHY YOU ARE ASKED: between your decisions the goal continues in its task's own session without you. You are asked now because ${ctx.askedBecause}.` : "",
    "DECIDE:",
    ...verdictInstructions(ctx.ownerName, running.length),
    "- `progress`: a short running summary of what is done and what remains, replacing the earlier one.",
    nextInstruction(goal, !!ctx.continues),
    pickInstruction(goal, ctx.ownerName),
    "",
    rosterBlock(ctx.roster, ctx.overPace),
  ].filter((line) => line !== "").join("\n");
}

/** How the step should pace itself: keep going through the objective alone, or stay in its lane beside
 *  the other steps a parallel goal runs. */
function scopeParagraph(goal: Goal, siblings: GoalStep[]): string {
  if (goal.maxConcurrent <= 1) {
    const carry = goal.persistentSession
      ? "When you end a turn, GGO continues the goal in this same session, so your context carries over; a fresh task that must re-learn the repository is only started when this one cannot go on."
      : "Each new step starts a fresh session that must re-learn the repository, so one long task costs far fewer tokens than many short ones.";
    return `This is a long-running task: finish this step completely, then keep going into the rest of the objective in this same task, committing at each coherent point. Stop only when the ENTIRE objective is achieved or you are blocked on something only the owner can resolve. ${carry} Then report what you did.`;
  }
  const beside = siblings.length ? ` Running beside you right now: ${siblings.map((s) => `step ${s.seq} "${s.title}"`).join(", ")}.` : "";
  return `This is a long-running task: finish this step completely, committing at each coherent point. Up to ${goal.maxConcurrent} step tasks of this goal run at once in this same repository.${beside} Stay within this step's scope rather than taking on work another step owns, commit only your own changes, and coordinate through the office when your work touches theirs. Stop when this step is done or you are blocked on something only the owner can resolve. Then report what you did.`;
}

/** The brief a step task receives: the director's step brief, framed by the goal and its ending rule. */
export function goalStepBrief(goal: Goal, seq: number, judgement: GoalJudgement, verification: boolean, siblings: GoalStep[] = []): string {
  return [
    `GOAL-DIRECTED TASK — step ${seq} of the goal "${goal.title}".`,
    `The overall objective (the owner's words):\n${goal.objective}`,
    goal.progress ? `Progress before this step (the director's summary):\n${goal.progress}` : "",
    verification
      ? `THIS STEP IS A VERIFICATION: the director believes the objective is already met. Check every part of it against the repository and running behaviour, fix any gap you find, then report honestly.\n\n${judgement.next.brief}`
      : `THIS STEP:\n${judgement.next.brief}`,
    scopeParagraph(goal, siblings),
    GOAL_STATUS_RULE,
  ].filter(Boolean).join("\n\n");
}

const GOAL_STATUS_RULE =
  "End your final report with one status line on its own. Write `GOAL STATUS: COMPLETE` only if the ENTIRE objective, not just this step, is now fully achieved and verified. Write `GOAL STATUS: WAITING — <the live job and how you checked it>` only when the next work depends on a process, job or tool run you can show is still live; `GOAL STATUS: BLOCKED — <the blocker>` when only the owner or an outside change can unblock you; otherwise `GOAL STATUS: CONTINUE — <what still remains>`. The director checks a COMPLETE claim against the evidence; claiming complete early only earns more work.";

/** What the director decided when it was asked mid-goal, for the turn it sends into the same session. */
export interface GoalTurnDirection {
  judgement: GoalJudgement;
  /** The director thinks the objective is met but the agent did not say so. */
  verification: boolean;
  /** The agent claimed the objective complete and the director disagreed. */
  auditRejected: boolean;
}

/**
 * The message that opens a goal's next turn in its task's own session: the objective, where the last turn
 * left off, and how to classify this one. Kept short, because the session already holds the work; it
 * replaces the fresh task brief and the director call a new step would cost.
 */
export function goalContinuationMessage(goal: Goal, step: GoalStep, last: GoalStatusLine | null, direction?: GoalTurnDirection): string {
  return [
    `GOAL CONTINUATION — turn ${step.turns + 1} of the goal "${goal.title}", in this same session.`,
    `The objective (the owner's words):\n${goal.objective}`,
    direction ? directedTurn(direction) : `Your last turn ended: ${describeStatus(last)}.`,
    "Start from evidence, not memory: check the repository, the tests and any running job against each part of the objective, then do the most valuable remaining work in this turn, committing at each coherent point.",
    "Wait only on a process, job or tool run you can show is still live, and wait for it inside this turn where you can; ending a turn just to poll again is no progress. A timeout while reading a live job is not a reason to restart it.",
    GOAL_STATUS_RULE,
    "A turn that makes no tool call hands the goal to the director, and a second in a row stops it. Automatic continuation also stops after turns that do no new work (no repository change, no new finding, nothing new tried), and after the same blocker three turns running.",
  ].join("\n\n");
}

function directedTurn({ judgement, verification, auditRejected }: GoalTurnDirection): string {
  const brief = judgement.next.brief;
  if (verification) return `THE DIRECTOR BELIEVES THE OBJECTIVE IS MET. Verify every part of it against the repository and running behaviour, fix any gap you find, then report honestly.\n\n${brief}`;
  if (auditRejected) return `THE DIRECTOR AUDITED YOUR COMPLETION CLAIM AND DOES NOT AGREE YET: ${judgement.reason}\n\nWhat remains:\n${brief}`;
  return `THE DIRECTOR'S DIRECTION FOR THIS TURN:\n${brief}`;
}

function describeStatus(last: GoalStatusLine | null): string {
  if (!last) return "without a goal status line";
  const detail = last.detail ? ` — ${clip(last.detail, 600)}` : "";
  return `${last.kind.toUpperCase()}${detail}`;
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
  /** Step tasks that answered they can take no more turns, so the director plans a fresh task instead of
   *  being asked to continue them again. In memory: after a restart one more attempt just gets the same answer. */
  private readonly retiredCarriers = new Set<string>();
  /** threadId → its consecutive unclean turns. In memory: a restart allows at most that many more. */
  private readonly uncleanTurns = new Map<string, number>();
  /** goalId → consecutive WAITING turns that did no new work, which stretch the wait before the next check. */
  private readonly idleWaits = new Map<string, number>();
  /** goalId → its carrier task's consecutive turns with no tool call. In memory, like `uncleanTurns`: the
   *  durable idle streak still bounds a restart that forgets one. */
  private readonly silentTurns = new Map<string, { threadId: string; count: number }>();
  /** The sub the last settings broadcast was burning for its reset; undefined until the first broadcast. */
  private resetBurnSubId: string | null | undefined;

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
        if (e.type === "settings") return this.resetBurnChanged(e.settings.resetBurn?.subId ?? null);
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

  /** ThreadManager's continuation guard: why this goal step should wrap up at its turn ceiling, or null. */
  wrapUpReason(threadId: string, provider?: ImplementorProvider | null): string | null {
    const step = this.db.listOpenGoalSteps().find((s) => s.threadId === threadId);
    const goal = step ? this.db.getGoal(step.goalId) : null;
    return step && goal ? stepWrapUpReason(goal, step, this.host.roster(), this.now(), provider ?? step.provider) : null;
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
    const pinError = validateGoalPin(pin) ?? validateTokenBudget(input.tokenBudget) ?? budgetPinError(input.tokenBudget, pin.provider);
    if (pinError) return { ok: false, error: pinError };
    const goal = this.db.createGoal({
      title,
      objective,
      workspace,
      effort: pin.effort ?? null,
      provider: pin.provider ?? null,
      model: pin.model ?? null,
      maxConcurrent: clampMaxConcurrent(input.maxConcurrent),
      burnConservation: input.burnConservation ?? true,
      burnRatePct: clampBurnRate(input.burnRatePct),
      persistentSession: input.persistentSession ?? true,
      tokenBudget: input.tokenBudget ?? null,
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
    const budget = patch.tokenBudget === undefined ? current.tokenBudget : patch.tokenBudget;
    const provider = pin.model === undefined ? current.provider : pin.provider;
    const pinError = validateGoalPin(pin) ?? validateTokenBudget(patch.tokenBudget) ?? budgetPinError(budget, provider);
    if (pinError) return { ok: false, error: pinError };
    const pace = paceChanges(current, patch);
    const objectiveChanged = !!objective && objective !== current.objective;
    const pinChanged = pinEdited(current, pin);
    // A new objective or pin changes what the director is asked, and a burn-rate hold or a full slot may no
    // longer apply, so any backoff is stale: look again now instead of at the next check.
    const replan = !!pace || objectiveChanged || pinChanged;
    // The DB clock, like the step rows these are compared with: a changed objective asks the director again,
    // and a changed pin ends the carried session, which runs on the old model.
    const at = Date.now();
    const goal = this.db.updateGoal(id, {
      ...(title ? { title } : {}),
      ...(objective ? { objective } : {}),
      ...(pin.effort !== undefined ? { effort: pin.effort } : {}),
      ...(pin.model !== undefined ? { provider: pin.provider ?? null, model: pin.model } : {}),
      ...(pace ?? {}),
      ...(objectiveChanged ? { replanAt: at } : {}),
      ...(pinChanged ? { pinChangedAt: at } : {}),
      ...(replan ? { nextCheckAt: null } : {}),
      // Only a live goal: a paused, blocked or budget-limited goal keeps its reason, and Resume releases the wait itself.
      ...(replan && current.status === "active" ? releaseRunningStepWait(current) : {}),
    });
    // The director is asked about the new objective instead, so a silent turn before it must not count toward a stop.
    if (objectiveChanged) this.silentTurns.delete(id);
    this.broadcast();
    if (replan && goal?.status === "active") this.evaluate(id);
    return { ok: true, goal: goal ?? undefined };
  }

  /**
   * The owner's lifecycle controls. Pausing or ending never interrupts the step task in flight: at its
   * next turn ceiling it is asked to commit and report instead of continuing, and no further step
   * follows. Resuming clears any backoff and the no-progress audit, and evaluates at once. `achieved` here
   * is the owner's own override and needs no agent or director agreement. `blocked` and `budget_limited`
   * are only reached by the loop; resuming a goal out of its budget needs a larger budget first.
   */
  setStatus(id: string, status: GoalOwnerStatus, reason?: string): GoalResult {
    const current = this.db.getGoal(id);
    if (!current) return { ok: false, error: "No such goal." };
    if (current.status === status) return { ok: true, goal: current };
    if (current.status === "achieved" || current.status === "abandoned") {
      if (status !== "active") return { ok: false, error: `The goal is already ${current.status}.` };
    }
    if (status === "active" && budgetSpent(current)) {
      return { ok: false, error: `The goal's step tasks have used its token budget (${describeGoalUsage(current.usage, current.tokenBudget)}). Raise or remove the budget first.` };
    }
    const terminal = status === "achieved" || status === "abandoned";
    const defaults: Record<GoalOwnerStatus, string | null> = {
      active: null,
      paused: "Paused by the owner.",
      achieved: "Marked achieved by the owner.",
      abandoned: "Abandoned by the owner.",
    };
    const goal = this.db.updateGoal(id, {
      ...(status === "active" ? releaseRunningStepWait(current) : {}),
      status,
      statusReason: reason?.trim() || defaults[status],
      nextCheckAt: null,
      hold: null,
      endedAt: terminal ? this.now() : null,
      // A resume starts a fresh audit: the director judges before the session continues on its own (the DB clock, as in `update`).
      ...(status === "active" ? { blockedStreak: 0, idleStreak: 0, lastTurnDigest: null, replanAt: Date.now() } : {}),
    });
    if (status === "active") this.silentTurns.delete(id);
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

  /**
   * The owner just aimed "prepare a sub for reset" at a sub: goals no longer pace that pool, so a goal held
   * for usage looks again now instead of sleeping out a hold of up to half an hour. Ending a burn needs no
   * wake-up: the next ordinary check paces the pool again.
   */
  private resetBurnChanged(subId: string | null): void {
    const changed = subId !== this.resetBurnSubId;
    this.resetBurnSubId = subId;
    if (!changed || !subId) return;
    for (const goal of this.db.listGoals()) {
      if (goal.status !== "active" || goal.hold !== "usage_limited" || goal.nextCheckAt == null) continue;
      this.db.updateGoal(goal.id, { nextCheckAt: null });
      this.evaluate(goal.id);
    }
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

    const open = await this.settleOpenSteps(goal);
    if (open === "stopped" || open === "orphan") return;
    const running = open;
    const current = this.db.getGoal(goalId)!;

    if (current.nextCheckAt && current.nextCheckAt > this.now()) return;
    if (running.length >= current.maxConcurrent) return;
    if (running.length && this.heldForRunningSteps(current)) return;
    if (!existsSync(current.workspace)) return this.pause(current, `Workspace ${current.workspace} no longer exists.`);
    if (budgetSpent(current)) return this.stopLoop(current, "budget_limited", budgetStopReason(current));
    if (!running.length && this.continueOnItsOwn(current)) return;
    await this.judgeAndAct(goalId, running);
  }

  /**
   * Records every open step whose task has ended and returns the ones still running. "orphan" means a step
   * is recorded but its task not yet found, so nothing may dispatch; "stopped" means a settle paused or
   * blocked the goal. A task GGO still owes work (`taskHold`) keeps its step running.
   */
  private async settleOpenSteps(goal: Goal): Promise<GoalStep[] | "orphan" | "stopped"> {
    this.reopenResumedSteps(goal);
    const running: GoalStep[] = [];
    let held: GoalTaskHold | null = null;
    for (const open of this.db.listOpenGoalSteps(goal.id)) {
      const step = this.adoptOrphan(goal, open);
      if (step.settledAt != null) continue;
      if (!step.threadId) return "orphan";
      const thread = this.db.getThread(step.threadId);
      const hold = thread && !UNFINISHED_STATES.has(thread.state) ? this.host.taskHold?.(thread.id) ?? null : null;
      if (hold) held ??= hold;
      if (hold || (thread && UNFINISHED_STATES.has(thread.state))) {
        running.push(step);
        continue;
      }
      const settled = await this.settleStep(goal, step, thread);
      if (settled === "stopped") return "stopped";
      if (settled === "restarted") running.push(step);
    }
    this.noteTaskHold(goal, held, running.length);
    return running;
  }

  /** Shows why a stopped step still holds its slot, and clears that once its task is back at work. A run
   *  only tearing down is looked at again in seconds, not at the next tick. */
  private noteTaskHold(goal: Goal, hold: GoalTaskHold | null, running: number): void {
    if (hold) {
      if (goal.hold !== hold.kind || goal.statusReason !== hold.reason) {
        this.db.updateGoal(goal.id, { hold: hold.kind, statusReason: hold.reason });
        this.broadcast();
      }
      if (hold.settling) setTimeout(() => void this.evaluate(goal.id), SETTLING_RECHECK_MS).unref?.();
    } else if (goal.hold && running) {
      this.db.updateGoal(goal.id, { hold: null, statusReason: null });
      this.broadcast();
    }
  }

  /**
   * A settled step whose task came back to life (a cap auto-resume, a Retry, an inject) is running again and
   * must hold its slot, or the goal runs more steps than `maxConcurrent`. Reopening it also means its real
   * ending is settled and reported later, not the stale one.
   */
  private reopenResumedSteps(goal: Goal): number {
    let reopened = 0;
    for (const step of this.db.listGoalSteps(goal.id)) {
      if (step.settledAt == null || !step.threadId) continue;
      const thread = this.db.getThread(step.threadId);
      if (!thread || !UNFINISHED_STATES.has(thread.state)) continue;
      this.db.updateGoalStep(step.id, { outcome: null, agentClaimedComplete: null, settledAt: null });
      this.uncountSettle(goal.id, step.settledAt);
      this.hub.log("info", `Goal "${goal.title}" step ${step.seq}'s task is ${thread.state} again, so the step counts as running.`);
      this.broadcast();
      reopened++;
    }
    return reopened;
  }

  /** Keeps the last verdict's settled count in step with the settled list, so the step's next ending is
   *  reported to the director and lifts any `wait` hold. */
  private uncountSettle(goalId: string, settledAt: number): void {
    const verdict = this.db.getGoal(goalId)?.lastVerdict;
    if (!verdict || verdict.settledSteps == null || settledAt > verdict.at) return;
    this.db.updateGoal(goalId, { lastVerdict: { ...verdict, settledSteps: Math.max(0, verdict.settledSteps - 1) } });
  }

  /** The director answered `wait` (or `complete`) while steps ran: plan nothing until one of them ends. */
  private heldForRunningSteps(goal: Goal): boolean {
    const verdict = goal.lastVerdict;
    if (verdict?.verdict !== "wait" || verdict.waitReleased || verdict.settledSteps == null) return false;
    return this.settledSteps(goal.id).length <= verdict.settledSteps;
  }

  /** A goal's settled steps in the order they ended. */
  private settledSteps(goalId: string, all: GoalStep[] = this.db.listGoalSteps(goalId)): GoalStep[] {
    return all.filter((s) => s.settledAt != null).sort((a, b) => a.settledAt! - b.settledAt! || a.seq - b.seq);
  }

  /**
   * A step recorded but never linked to its task: the process died between recording the step and the
   * dispatch returning. Adopt the task it created if one exists, else close the step as lost.
   */
  private adoptOrphan(goal: Goal, step: GoalStep): GoalStep {
    if (step.threadId || step.settledAt != null) return step;
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

  /**
   * Records how the step's turn ended. "stopped" means that ending paused or blocked the goal; "restarted"
   * means the task was resumed or steered while the turn's evidence was read, so it is running again and
   * its old report must not settle it.
   */
  private async settleStep(goal: Goal, step: GoalStep, thread: Thread | null): Promise<"settled" | "stopped" | "restarted"> {
    if (!step.threadId) return "settled";
    const turn = thread ? this.db.goalTurnActivity(thread.id, step.turnStartedAt) : null;
    const status = readGoalStatusLine(turn?.report);
    const claimed = status?.kind === "complete";
    const outcome = thread?.state ?? null;
    const evidence = thread && turn && this.persistent(goal) ? await this.turnEvidence(step, thread.id) : null;
    if (evidence && !this.turnUnchanged(step, thread!)) return "restarted";
    this.db.updateGoalStep(step.id, {
      outcome,
      agentClaimedComplete: claimed,
      settledAt: this.now(),
      ...(evidence ? { turnFingerprint: evidence.fingerprint } : {}),
    });
    this.hub.log("info", `Goal "${goal.title}" step ${step.seq} ended ${outcome ?? "(task missing)"}${claimed ? " — agent declared the objective complete" : ""}.`);
    // The owner may have paused or ended the goal while the workspace was read: record the ending, act on nothing.
    if (this.db.getGoal(goal.id)?.status !== "active") return "stopped";
    if (outcome === "cancelled") {
      this.pause(goal, `Step ${step.seq}'s task was cancelled. Resume the goal to keep going.`);
      return "stopped";
    }
    const recent = this.settledSteps(goal.id).slice(-GOAL_MAX_FAILED_STEPS);
    if (recent.length >= GOAL_MAX_FAILED_STEPS && recent.every(stepFailed)) {
      this.pause(goal, `The last ${GOAL_MAX_FAILED_STEPS} steps failed. Check the latest step's task, then resume the goal.`);
      return "stopped";
    }
    const stop = evidence && turn
      ? this.blockerStreak(goal, status, evidence) ?? (outcome === "done" || outcome === "review" ? this.noProgress(goal, step, turn, status, evidence, outcome) : null)
      : null;
    if (evidence) this.noteUncleanTurn(goal, step, outcome);
    if (stop) {
      this.stopLoop(goal, "blocked", stop);
      return "stopped";
    }
    this.broadcast();
    return "settled";
  }

  /**
   * Whether the step's task is still exactly where it was before the turn's evidence was read. The owner may
   * resume or steer it meanwhile, and a turn that started again must not be settled, or blocked, on the
   * report it replaced.
   */
  private turnUnchanged(step: GoalStep, before: Thread): boolean {
    const now = this.db.getThread(before.id);
    const open = this.db.listOpenGoalSteps(step.goalId).find((s) => s.id === step.id);
    return !!now && !!open &&
      now.state === before.state && now.updatedAt === before.updatedAt &&
      open.turnStartedAt === step.turnStartedAt &&
      !this.host.taskHold?.(before.id);
  }

  /**
   * Whether a persistent goal's turn did new work, judged the way auto-continue judges a session
   * (`continuationProgress.ts`): enough tool calls the task's earlier turns never made, a finding it never
   * posted, or a changed git state. Prose is never evidence. `moved` is the stronger half: the repository or
   * the task's findings changed, which trying new commands around the same impasse does not do.
   */
  private async turnEvidence(step: GoalStep, threadId: string): Promise<TurnEvidence> {
    const fingerprint = (await this.host.workspaceFingerprint?.(threadId).catch(() => null)) ?? null;
    const activity = this.db.roleActivitySince(threadId, "implementor", step.turnStartedAt);
    const earlier = this.db.roleActionsBefore(threadId, "implementor", step.turnStartedAt, EARLIER_ACTIONS_COMPARED);
    const earlierKeys = new Set(earlier.map(actionKey).filter((k): k is string => !!k));
    const workspaceChanged = fingerprint != null && step.turnFingerprint != null && fingerprint !== step.turnFingerprint;
    const progress = assessSessionProgress(activity, earlierKeys, workspaceChanged);
    return { fingerprint, progressed: progress.progressed, moved: workspaceChanged || progress.newFindings > 0 };
  }

  /**
   * Counts consecutive turns stuck on the same impasse; the third stops the goal. The agent's wording is never
   * compared, so rephrasing a blocker cannot reset the count. Only evidence that the impasse moved (a
   * repository change or a new finding) starts a new count, as a blocker that follows real work is a new one.
   * Any ending other than BLOCKED clears it.
   */
  private blockerStreak(goal: Goal, status: GoalStatusLine | null, evidence: TurnEvidence): string | null {
    const before = this.db.getGoal(goal.id)?.blockedStreak ?? 0;
    const streak = status?.kind !== "blocked" ? 0 : before > 0 && !evidence.moved ? before + 1 : 1;
    if (streak !== before) this.db.updateGoal(goal.id, { blockedStreak: streak });
    if (streak < GOAL_BLOCKED_TURNS) return null;
    return `The last ${GOAL_BLOCKED_TURNS} turns ended blocked on the same impasse with no change to the repository or new finding${status!.detail ? `, most recently: ${clip(status!.detail, 400)}` : ""}. Resolve it, then resume the goal.`;
  }

  /**
   * Why a turn of a persistent goal must not be followed automatically. Any turn that did new work resets the
   * idle count, whatever it ended on. A turn that made no tool call (where its backend reports them), clean or
   * not, hands the next turn to the director, since a closing report is how a turn normally ends; the
   * GOAL_SILENT_TURNS-th in a row stops; the turns before it still count toward the idle streak. Otherwise a clean turn that did no new work stops when it also repeated
   * the report of the turn before, or when it is the GOAL_IDLE_TURNS-th such turn running. A completion claim is left to the
   * audit, a BLOCKED turn is counted by `blockerStreak`, an unclean one by `noteUncleanTurn`, and a WAITING one
   * that did no new work stretches the wait before the next check instead of stopping a live job's watch.
   */
  private noProgress(goal: Goal, step: GoalStep, turn: GoalTurnActivity, status: GoalStatusLine | null, evidence: TurnEvidence, outcome: ThreadState): string | null {
    const digest = turn.report ? reportDigest(turn.report) : null;
    if (evidence.progressed) {
      this.db.updateGoal(goal.id, { lastTurnDigest: digest, idleStreak: 0 });
      this.idleWaits.delete(goal.id);
    }
    if (status?.kind === "complete") {
      this.silentTurns.delete(goal.id);
      return null;
    }
    const silent = this.countSilentTurn(goal, step, turn);
    if (silent >= GOAL_SILENT_TURNS) {
      const unclean = outcome === "review" ? ", and the last did not finish cleanly" : "";
      return `Step ${step.seq}'s last ${silent} turns made no tool call${unclean}, even with the director's direction after the first, so automatic continuation is suppressed. Resume the goal to continue.`;
    }
    if (evidence.progressed || outcome !== "done") return null;
    if (status?.kind === "waiting" || status?.kind === "blocked") {
      this.db.updateGoal(goal.id, { lastTurnDigest: digest });
      if (status.kind === "waiting") this.idleWaits.set(goal.id, (this.idleWaits.get(goal.id) ?? 0) + 1);
      return null;
    }
    const { lastTurnDigest, idleStreak } = this.db.goalLoopState(goal.id);
    // A backend that reports no tool calls cannot show investigative work, so only the report and the
    // repository speak for its turns: they never count as idle, but a repeated report still stops them.
    const idle = turn.toolCalls == null ? idleStreak : idleStreak + 1;
    this.db.updateGoal(goal.id, { lastTurnDigest: digest, idleStreak: idle });
    // The first silent turn is the director's to judge, even when it repeated itself: a refusal usually does.
    if (silent > 0) return null;
    const nothingNew = "no repository change, no new finding and nothing new tried";
    if (digest != null && digest === lastTurnDigest) {
      return `Step ${step.seq}'s last turn repeated the report of the turn before and did no new work (${nothingNew}), so automatic continuation is suppressed. Resume the goal to continue.`;
    }
    if (idle >= GOAL_IDLE_TURNS) {
      return `The last ${idle} turns did no new work (${nothingNew}), so automatic continuation is suppressed. Resume the goal to continue.`;
    }
    return null;
  }

  /** The carrier's consecutive turns with no tool call, this one included; 0 when it made one or its backend
   *  reports none. A fresh step task starts its own count. */
  private countSilentTurn(goal: Goal, step: GoalStep, turn: GoalTurnActivity): number {
    if (turn.toolCalls !== 0) {
      this.silentTurns.delete(goal.id);
      return 0;
    }
    const prior = this.silentTurns.get(goal.id);
    const count = prior?.threadId === step.threadId ? prior.count + 1 : 1;
    this.silentTurns.set(goal.id, { threadId: step.threadId!, count });
    return count;
  }

  /**
   * Counts a task's consecutive unclean turns. A session that keeps failing to finish a turn (a context it
   * can no longer resume, a provider error) is not continued again after GOAL_UNCLEAN_TURNS: the next step
   * is a fresh task, which the failed-step guard then bounds like any other.
   */
  private noteUncleanTurn(goal: Goal, step: GoalStep, outcome: ThreadState | null): void {
    const threadId = step.threadId!;
    if (outcome !== "review") {
      this.uncleanTurns.delete(threadId);
      return;
    }
    const count = (this.uncleanTurns.get(threadId) ?? 0) + 1;
    if (count < GOAL_UNCLEAN_TURNS) {
      this.uncleanTurns.set(threadId, count);
      return;
    }
    this.uncleanTurns.delete(threadId);
    this.retiredCarriers.add(threadId);
    this.hub.log("info", `Goal "${goal.title}": step ${step.seq}'s task ended ${count} turns running without finishing cleanly; the next step is a fresh task.`);
  }

  /** Whether this goal continues its task's own session between turns instead of dispatching fresh steps. */
  private persistent(goal: Goal): boolean {
    return goal.persistentSession && goal.maxConcurrent <= 1 && !!this.host.continueTask;
  }

  private async judgeAndAct(goalId: string, running: GoalStep[]): Promise<void> {
    const goal = this.db.getGoal(goalId)!;
    const all = this.db.listGoalSteps(goalId);
    const settled = this.settledSteps(goalId, all);
    const roster = this.host.roster();
    const available = meteredRoster(goal, roster);
    if (!available.length) return this.wait(goal, noCapacityReason(goal, roster), undefined, "usage_limited");
    const burn = checkBurnRate(goal, available, this.now());
    if (burn.hold) return this.wait(goal, burn.hold.reason, burn.hold.until, "usage_limited");
    const carrier = running.length ? null : this.carrier(goal, settled);
    // The next turn goes into the carrier's session, on its pool: wait for that pool before asking the director.
    const carrierHeld = carrier ? this.turnCapacity(goal, carrier, available) : null;
    if (carrierHeld) return this.wait(goal, carrierHeld.reason, carrierHeld.until, "usage_limited");

    const prompt = buildGoalJudgePrompt({
      goal,
      steps: all.slice(-HISTORY_SHOWN),
      settled: this.justSettled(goal, settled).map((step) => this.settledReport(step)),
      running: running.map((step) => ({ step, brief: this.db.goalStepBrief(step.id) })),
      roster: burn.roster,
      overPace: burn.over,
      ownerName: this.options.ownerName,
      continues: !!carrier,
      askedBecause: this.persistent(goal) ? this.askedBecause(goal, settled.at(-1), carrier) : undefined,
    });
    const answer = await this.host
      .judge(prompt, goalJudgeSchema(goal, burn.roster, running.length))
      .catch((e): GoalJudgeAnswer => ({ failure: `the director call failed: ${String(e)}` }));
    const judgement = "failure" in answer ? null : parseGoalJudgement(answer.output);
    // The owner may have paused, ended or deleted the goal while the director was thinking.
    const fresh = this.db.getGoal(goalId);
    if (!fresh || fresh.status !== "active") return;
    // An owner edit during the call queues another evaluation. Do not dispatch a step planned from
    // the old objective, pin, capacity or burn policy before that fresh evaluation runs.
    if (planChanged(goal, fresh.objective, fresh) ||
        goal.maxConcurrent !== fresh.maxConcurrent ||
        goal.burnConservation !== fresh.burnConservation ||
        goal.burnRatePct !== fresh.burnRatePct ||
        goal.persistentSession !== fresh.persistentSession ||
        goal.tokenBudget !== fresh.tokenBudget) {
      if (this.running.has(goalId)) this.running.set(goalId, true);
      return;
    }
    // Spend keeps growing while the director thinks (a step may still be reporting usage).
    if (budgetSpent(fresh)) return this.stopLoop(fresh, "budget_limited", budgetStopReason(fresh));
    // A settled step's task came back while the director was thinking (a cap reset both resumes it and
    // frees capacity for this judgement). The slot count above is stale, so plan again with it in view.
    if (this.reopenResumedSteps(fresh)) {
      if (this.running.has(goalId)) this.running.set(goalId, true);
      return;
    }
    if (!judgement) return this.wait(fresh, `Waiting for the director: ${unusableAnswer(answer)}`);

    const agentClaimed = settled.at(-1)?.agentClaimedComplete === true;
    const held = running.length > 0 && judgement.verdict !== "continue";
    this.recordVerdict(fresh, judgement, agentClaimed, held, settled.length, running.length);
    if (held) return this.broadcast();

    if (judgement.verdict === "complete" && agentClaimed) return this.achieve(fresh, judgement.reason);
    const verification = judgement.verdict === "complete";
    const latest = this.db.getGoal(goalId)!;
    if (carrier) {
      // The judgement was written for this session, so a pool that ran out meanwhile means waiting for it,
      // not handing a continuation's brief to a fresh task.
      const capacity = this.turnCapacity(latest, carrier, this.host.roster());
      if (capacity) return this.wait(latest, capacity.reason, capacity.until, "usage_limited");
      const message = goalContinuationMessage(latest, carrier, null, { judgement, verification, auditRejected: agentClaimed });
      if (this.sendTurn(latest, carrier, message)) return;
    }
    await this.dispatchStep(this.db.getGoal(goalId)!, judgement, verification, burn, running);
  }

  /**
   * A persistent goal's next turn without the director: its last turn ended cleanly with no completion
   * claim and nothing about the goal changed, so it continues in the same task and session. False hands
   * the evaluation to the director: no task to carry on, a claim to audit, a changed objective, an
   * unclean turn, a turn with no tool call, or a task that can no longer take a turn. A WAITING turn is
   * deferred once, at no cost.
   */
  private continueOnItsOwn(goal: Goal): boolean {
    const carrier = this.carrier(goal, this.settledSteps(goal.id));
    if (!carrier || carrier.outcome !== "done" || carrier.agentClaimedComplete) return false;
    if (this.silentTurns.get(goal.id)?.threadId === carrier.threadId) return false;
    const { replanAt } = this.db.goalLoopState(goal.id);
    if (replanAt != null && replanAt >= carrier.turnStartedAt) return false;
    const last = readGoalStatusLine(this.db.goalTurnActivity(carrier.threadId!, carrier.turnStartedAt).report);
    if (last?.kind === "waiting" && goal.nextCheckAt == null) {
      // Each check that found the job still running and nothing new doubles the wait, so a long job's watch
      // costs a turn an hour at most instead of a turn every few minutes.
      const idle = this.idleWaits.get(goal.id) ?? 0;
      const delay = Math.min(this.retryMs() * 2 ** idle, GOAL_WAIT_BACKOFF_MAX_MS);
      const stretched = idle ? ` ${idle} check${idle === 1 ? "" : "s"} running found no new work, so the next one waits longer.` : "";
      this.wait(goal, `Waiting on a live job the last turn reported${last.detail ? `: ${clip(last.detail, 300)}` : ""}. The goal continues in the same session at the next check.${stretched}`, this.now() + delay);
      return true;
    }
    const capacity = this.turnCapacity(goal, carrier, this.host.roster());
    if (capacity) {
      this.wait(goal, capacity.reason, capacity.until, "usage_limited");
      return true;
    }
    return this.sendTurn(goal, carrier, goalContinuationMessage(goal, carrier, last));
  }

  /**
   * The step whose task a persistent goal continues: the last one to end, if it ended done or review (a
   * failed or cancelled task gets a fresh step) and the owner's pin has not changed since it was
   * dispatched, as its session runs on the old model.
   */
  private carrier(goal: Goal, settled: GoalStep[]): GoalStep | null {
    if (!this.persistent(goal)) return null;
    const last = settled.at(-1);
    if (!last?.threadId || (last.outcome !== "done" && last.outcome !== "review") || this.retiredCarriers.has(last.threadId)) return null;
    if (goal.tokenBudget != null && this.runningProvider(last) === UNMETERED_PROVIDER) return null;
    const { pinChangedAt } = this.db.goalLoopState(goal.id);
    return pinChangedAt != null && pinChangedAt >= last.createdAt ? null : last;
  }

  /** The backend a step's session actually runs on: its latest implementor run's, since an auto-routed step
   *  records no provider and a failed-over one left the pool it was dispatched to. */
  private runningProvider(step: GoalStep): ImplementorProvider | null {
    const run = this.db.listRuns(step.threadId!).filter((r) => r.role === "implementor").at(-1);
    return run ? providerOfRunAccount(run.account) : step.provider;
  }

  /** Why a persistent goal asks the director now instead of continuing on its own, for the judge prompt. */
  private askedBecause(goal: Goal, last: GoalStep | undefined, carrier: GoalStep | null): string | undefined {
    if (!last) return undefined;
    if (last.agentClaimedComplete) return "the last turn's agent claimed the objective complete: audit that claim against the evidence before agreeing";
    if (!carrier) {
      if (last.outcome === "failed" || last.outcome == null) return "the last step's task failed, so the next step is a fresh task";
      return "the last step's task cannot carry the goal on (the owner changed the model/effort pin, its session is gone, or it runs on Grok, which this goal's token budget cannot meter), so the next step is a fresh task";
    }
    const { replanAt } = this.db.goalLoopState(goal.id);
    if (replanAt != null && replanAt >= carrier.turnStartedAt) return "the owner changed the objective or resumed the goal since the last turn: check where it stands before it goes on";
    if (this.silentTurns.get(goal.id)?.threadId === carrier.threadId) {
      const unclean = last.outcome === "review" ? " and did not finish cleanly (its task ended in review)" : "";
      return `the last turn made no tool call${unclean}: it only wrote its report. Judge from that report why it stopped. If it stopped on an instruction or an impasse that no longer holds, say so in \`next\` and give the turn concrete work; if this task's next turn again makes no tool call, the goal stops for the owner`;
    }
    if (last.outcome === "review") return "the last turn did not finish cleanly (its task ended in review)";
    return "its task could not take another turn on its own";
  }

  /** Whether the carrier's pool may take another turn now: some backend has room, and the pool the
   *  step runs on is within the goal's burn rate. Null when it may. */
  private turnCapacity(goal: Goal, step: GoalStep, roster: ModelCandidate[]): { reason: string; until: number } | null {
    if (!roster.length) return { reason: "Waiting for model capacity: no backend can take a task right now.", until: this.now() + this.retryMs() };
    const pool = step.provider && step.model ? { ...goal, provider: step.provider, model: step.model } : goal;
    return checkBurnRate(pool, roster, this.now()).hold;
  }

  /**
   * Sends the next turn into the step's own task. On success the step holds the goal's slot again and its
   * turn is read from now on. A hold waits without cost, a stop pauses the goal for the owner, and
   * false means this task can take no more turns, so the caller starts a fresh step.
   */
  private sendTurn(goal: Goal, step: GoalStep, message: string): boolean {
    // The DB clock, taken BEFORE the send: the host may create the turn's run row synchronously, and the turn's
    // report, tool calls and runs are read from rows stamped at or after this boundary.
    const turnStartedAt = Date.now();
    const result = this.host.continueTask!(step.threadId!, message);
    if (result.ok) {
      this.db.updateGoalStep(step.id, { outcome: null, agentClaimedComplete: null, settledAt: null, turns: step.turns + 1, turnStartedAt });
      if (step.settledAt != null) this.uncountSettle(goal.id, step.settledAt);
      this.db.updateGoal(goal.id, { currentThreadId: step.threadId, hold: null, statusReason: null, nextCheckAt: null });
      this.hub.log("info", `Goal "${goal.title}" continues in step ${step.seq}'s task ${step.threadId!.slice(0, 8)} (turn ${step.turns + 1}).`);
      this.broadcast();
      return true;
    }
    if ("hold" in result) {
      this.wait(goal, result.hold.reason, undefined, result.hold.kind);
      return true;
    }
    if ("stop" in result) {
      this.pause(goal, result.stop);
      return true;
    }
    this.retiredCarriers.add(step.threadId!);
    this.hub.log("info", `Goal "${goal.title}" cannot continue in step ${step.seq}'s task (${result.fresh}); a fresh step follows.`);
    return false;
  }

  /** The steps that ended since the director last judged, so parallel endings are all reported once. */
  private justSettled(goal: Goal, settled: GoalStep[]): GoalStep[] {
    const since = goal.lastVerdict?.settledSteps;
    return (since == null ? settled.slice(-1) : settled.slice(since)).slice(-SETTLED_SHOWN);
  }

  private settledReport(step: GoalStep): SettledStepReport {
    const id = step.threadId;
    return {
      step,
      report: id ? this.db.lastMessageOf(id, "implementor", "text")?.content ?? null : null,
      qa: id ? this.db.lastMessageOf(id, "qa", "text")?.content ?? null : null,
      error: id ? this.db.getThread(id)?.error ?? null : null,
    };
  }

  /** Stores the judgement. A `wait`, or a `complete` while steps still run, becomes a hold that lasts
   *  until another step settles; a `wait` with nothing running cannot hold anything and reads as continue. */
  private recordVerdict(goal: Goal, judgement: GoalJudgement, agentClaimed: boolean, held: boolean, settledCount: number, running: number): void {
    const plural = running === 1 ? "the running step ends" : `one of the ${running} running steps ends`;
    const verdict: GoalVerdict = {
      verdict: held ? "wait" : judgement.verdict === "wait" ? "continue" : judgement.verdict,
      reason: held && judgement.verdict === "complete" ? `Looks complete; deciding once ${plural}. ${judgement.reason}` : judgement.reason,
      agentClaimedComplete: agentClaimed,
      at: this.now(),
      settledSteps: settledCount,
    };
    this.db.updateGoal(goal.id, {
      lastVerdict: verdict,
      progress: judgement.progress || goal.progress,
      statusReason: held ? `Holding the next step until ${plural}.` : null,
      nextCheckAt: null,
      hold: null,
    });
  }

  private async dispatchStep(goal: Goal, judgement: GoalJudgement, verification: boolean, burn: BurnCheck, running: GoalStep[]): Promise<void> {
    const pin = this.pinWithinBurnRate(goal, judgement.next, burn);
    const rationale = [judgement.next.rationale, pin.note].filter(Boolean).join(" ");
    const step = this.db.createGoalStep({
      goalId: goal.id,
      title: judgement.next.title,
      provider: pin.provider,
      model: pin.model,
      effort: pin.effort,
      rationale,
      brief: judgement.next.brief,
    });
    // A new task's turns are judged against each other, not against the session it replaces.
    this.db.updateGoal(goal.id, { idleStreak: 0, lastTurnDigest: null });
    this.idleWaits.delete(goal.id);
    try {
      const threadId = await this.host.dispatch({
        title: stepTitle(goal, step.seq, step.title),
        workspace: goal.workspace,
        brief: goalStepBrief(goal, step.seq, judgement, verification, running),
        effort: pin.effort ?? undefined,
        requestedModel: pin.model,
        requestedProvider: pin.provider,
        skipQa: true,
        // A self-improvement round after each turn would replace the report the goal reads its status from.
        ...(this.persistent(goal) ? { skipSelfImprovement: true as const } : {}),
      });
      this.db.updateGoalStep(step.id, { threadId });
      this.db.updateGoal(goal.id, { currentThreadId: threadId, hold: null });
      this.hub.log(
        "info",
        `Goal "${goal.title}" step ${step.seq} dispatched → task ${threadId.slice(0, 8)} (${[pin.provider, pin.model, pin.effort].filter(Boolean).join(" / ") || "auto routing"}).`,
      );
      // Another slot is free: evaluate again once this pass ends, so the director fills it with the new step in view.
      if (running.length + 1 < goal.maxConcurrent && this.running.has(goal.id)) this.running.set(goal.id, true);
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
    this.db.updateGoal(goal.id, { status: "paused", statusReason: reason, nextCheckAt: null, hold: null });
    this.hub.log("warn", `Goal "${goal.title}" paused: ${reason}`);
    this.host.notify?.("input", `Goal paused: ${goal.title}`, reason, goal.workspace);
    this.broadcast();
  }

  /** Stops the automatic loop in a state of its own, so the board tells an impasse or a spent budget apart
   *  from an owner pause and from completion. Like a pause, it waits for the owner and never interrupts a turn. */
  private stopLoop(goal: Goal, status: "blocked" | "budget_limited", reason: string): void {
    this.db.updateGoal(goal.id, { status, statusReason: reason, nextCheckAt: null, hold: null });
    this.hub.log("warn", `Goal "${goal.title}" ${status === "blocked" ? "blocked" : "is out of token budget"}: ${reason}`);
    this.host.notify?.("input", `${status === "blocked" ? "Goal blocked" : "Goal out of token budget"}: ${goal.title}`, reason, goal.workspace);
    this.broadcast();
  }

  /**
   * The step's pin, kept on a pool within the burn rate and, for a budgeted goal, on a metered one. A pick
   * the roster cannot place would otherwise route automatically, and automatic routing may choose the very
   * pool the burn rate left out, or Grok, whose runs a token budget cannot see.
   */
  private pinWithinBurnRate(goal: Goal, pick: GoalJudgement["next"], burn: BurnCheck): StepPin {
    const pin = goalStepPin(goal, pick, burn.roster);
    const fallback = burn.roster[0];
    const budgeted = goal.tokenBudget != null;
    if (pin.provider || (!burn.over.length && !budgeted) || !fallback) return pin;
    const moved = goalStepPin(goal, { ...pick, provider: fallback.provider, model: fallback.model }, burn.roster);
    const risk = burn.over.length ? "a pool over this goal's burn rate" : "Grok, which reports no usage for this goal's token budget";
    const why = `${pick.model || "The director's pick"} could not be placed, and automatic routing could land on ${risk}, so this step runs on ${fallback.model}.`;
    return { ...moved, note: [why, moved.note].filter(Boolean).join(" ") };
  }

  /** Stays active but backs off; the reason is shown on the goal so the wait is never silent. */
  private wait(goal: Goal, reason: string, until = this.now() + this.retryMs(), hold: GoalHold = "waiting"): void {
    const at = Math.max(until, this.now() + Math.min(this.retryMs(), BURN_RECHECK_MAX_MS));
    this.db.updateGoal(goal.id, { statusReason: reason, nextCheckAt: at, hold });
    this.hub.log("info", `Goal "${goal.title}": ${reason} Checking again in ${Math.max(1, Math.round((at - this.now()) / 60_000))} min.`);
    this.broadcast();
  }

  private retryMs(): number {
    return this.options.retryMs ?? GOAL_RETRY_MS;
  }

  /** Every open step's task and every goal's latest task, so any of them settling wakes its goal at once. */
  private refreshCurrentThreads(goals: Goal[] = this.db.listGoals()): void {
    const entries: [string, string][] = goals.filter((g) => g.currentThreadId).map((g) => [g.currentThreadId!, g.id]);
    for (const step of this.db.listOpenGoalSteps()) if (step.threadId) entries.push([step.threadId, step.goalId]);
    this.currentThreads = new Map(entries);
  }

  private broadcast(): void {
    const goals = this.db.listGoals();
    this.refreshCurrentThreads(goals);
    this.hub.publish({ type: "goals", goals });
  }
}

/** Keep the last judgement and its report cursor, but let an owner-requested replan reach the director. */
function releaseRunningStepWait(goal: Goal): Partial<Goal> {
  if (goal.lastVerdict?.verdict !== "wait") return {};
  return { lastVerdict: { ...goal.lastVerdict, waitReleased: true }, statusReason: null, hold: null };
}

type GoalPaceFields = Pick<Goal, "maxConcurrent" | "burnConservation" | "burnRatePct" | "persistentSession" | "tokenBudget">;

/** The concurrency, burn-rate, session and budget fields a patch actually changes, clamped; null when it changes none. */
function paceChanges(current: Goal, patch: GoalPaceInput): Partial<GoalPaceFields> | null {
  const next: Partial<GoalPaceFields> = {
    ...(patch.maxConcurrent !== undefined ? { maxConcurrent: clampMaxConcurrent(patch.maxConcurrent) } : {}),
    ...(patch.burnConservation !== undefined ? { burnConservation: patch.burnConservation } : {}),
    ...(patch.burnRatePct !== undefined ? { burnRatePct: clampBurnRate(patch.burnRatePct) } : {}),
    ...(patch.persistentSession !== undefined ? { persistentSession: patch.persistentSession } : {}),
    ...(patch.tokenBudget !== undefined ? { tokenBudget: patch.tokenBudget } : {}),
  };
  const changed = (Object.keys(next) as (keyof GoalPaceFields)[]).some((k) => current[k] !== next[k]);
  return changed ? next : null;
}

/** Whether an edit changes the owner's model/effort pin. */
function pinEdited(current: Goal, pin: GoalPinInput): boolean {
  if (pin.effort !== undefined && pin.effort !== current.effort) return true;
  return pin.model !== undefined && (pin.model !== current.model || (pin.provider ?? null) !== current.provider);
}

/** Whether an edit changes what the director is asked to plan: the objective, or the owner's model/effort pin. */
function planChanged(current: Goal, objective: string | undefined, pin: GoalPinInput): boolean {
  return (!!objective && objective !== current.objective) || pinEdited(current, pin);
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

/** How hard the goal may run, as the director reads it, e.g. "up to 3 steps at once, burn rate 100%". */
export function describeGoalPace(g: Pick<Goal, "maxConcurrent" | "burnConservation" | "burnRatePct">): string {
  const slots = g.maxConcurrent > 1 ? `up to ${g.maxConcurrent} steps at once` : "one step at a time";
  return `${slots}, ${g.burnConservation ? `burn rate ${g.burnRatePct}%` : "burn-rate conservation off"}`;
}

/** One line per goal for the director's list tool and its CLI bridge. */
export function describeGoal(g: Goal): string {
  const running = g.steps.filter((s) => s.settledAt == null && s.threadId).map((s) => s.threadId!.slice(0, 8));
  const current = running.length
    ? `, running task${running.length === 1 ? "" : "s"} ${running.join(", ")}`
    : g.currentThreadId ? `, last task ${g.currentThreadId.slice(0, 8)}` : "";
  const status = g.hold && g.status === "active" ? `${g.status}, ${g.hold.replace("_", " ")}` : g.status;
  const reason = g.statusReason ? ` (${g.statusReason})` : "";
  const session = g.maxConcurrent <= 1 && g.persistentSession ? ", one persistent session" : "";
  const usage = ` Step-task run usage: ${describeGoalUsage(g.usage, g.tokenBudget)}.`;
  const progress = g.progress ? ` Progress: ${clip(g.progress, 300)}` : "";
  return `- ${g.id} [${status}]${reason} "${g.title}" @ ${g.workspace} — ${g.stepCount} step${g.stepCount === 1 ? "" : "s"}, ${describeGoalPin(g)}, ${describeGoalPace(g)}${session}${current}.${usage}${progress}`;
}

/** The director's update_goal, shared by the MCP tool and the CLI bridge. Returns the reply text; a
 *  failure starts with "Could not". */
export function applyGoalChange(
  goals: GoalRunner,
  change: { id: string; title?: string; objective?: string; status?: GoalOwnerStatus } & GoalPinInput & GoalPaceInput,
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
