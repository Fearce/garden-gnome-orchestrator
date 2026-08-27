import { config } from "../config.js";

/**
 * TIMED TASKS — a single task with a wall-clock work window.
 *
 * "Work on this for 8 hours." Not a schedule (that is `cron.ts`/`scheduler.ts`, which fires a NEW task
 * repeatedly) and not a lane (the read lane short-circuits the pipeline; a timed task IS the normal
 * pipeline). It is one task that keeps finding useful work against its own brief until a deadline, then
 * runs the ordinary final integration/QA path.
 *
 * Everything here is pure and clock-injected so the decisions can be tested without an agent. The state
 * it reasons over is durable (`threads.deadline_at` + counters in `stage_outputs`), which is what makes
 * the window survive restarts, per-session turn ceilings, provider hand-offs and cap parks: each of
 * those re-enters the pipeline and re-asks `timedDecision`, rather than holding a timer in memory.
 *
 * Three rules the design turns on:
 *
 * 1. **The deadline is enforced at work-round BOUNDARIES, never by aborting a live turn.** Killing a
 *    turn mid-flight returns a success-shaped result carrying no output, which the pipeline cannot tell
 *    from a real finish — the same trap documented on `steerStructuredRole`. So a round that is running
 *    when the deadline passes is allowed to finish; what the deadline stops is starting another.
 *
 * 2. **Finishing early is a valid outcome.** A window is a budget, not a quota to burn. If the
 *    implementor reports the objective genuinely complete, we stop and integrate rather than inventing
 *    scope — which is why the extension directive asks for an explicit declaration and this module
 *    detects it (`detectTimedComplete`).
 *
 * 3. **Every loop is bounded twice.** A count (`maxExtensions`) and a productivity guard: rounds that
 *    return instantly having done nothing are counted, and a run of them ends the window early. A
 *    count alone cannot tell "40 useful hours" from "40 no-op rounds in ninety seconds".
 */

/** How the pipeline should proceed at a timed task's round boundary. */
export type TimedAction = "extend" | "finalize";

export interface TimedWindow {
  /** What the owner asked for, kept for display after the fact ("an 8h task"). */
  durationMs: number;
  /** The instant the window closes. Absolute, so a restart resumes the same wall clock. */
  deadlineAt: number;
}

export interface TimedDecisionInput {
  deadlineAt: number;
  now: number;
  /** Extension rounds already granted (durable, so a restart cannot reset the budget). */
  extensionsUsed: number;
  /** The implementor declared the objective complete — stop, whatever time is left. */
  completeEarly?: boolean;
  /** Consecutive rounds that returned with nothing to show (the runaway guard). */
  hollowRounds?: number;
  maxExtensions?: number;
  /** Time that must remain for another round to be worth starting; also the reserve kept for the
   *  final integration/QA path, so the deadline never eats the verification the task exists to pass. */
  minSliceMs?: number;
  maxHollowRounds?: number;
}

export interface TimedDecision {
  action: TimedAction;
  /** Owner-facing sentence: why the window extended, or why it closed. Surfaced as a finding and, on
   *  the final round, as part of the park/settle reason — the brief's "actionable reason", never a
   *  silent abandonment. */
  reason: string;
  remainingMs: number;
}

/** Hard bounds on what a caller may request. A window under a minute cannot fit a single useful round;
 *  a week is already far beyond any plausible single task and keeps a typo (`8` read as days) bounded. */
export const MIN_DURATION_MS = 60_000;
export const MAX_DURATION_MS = 7 * 24 * 3_600_000;

/** Defaults, overridable per deployment via config. */
export const DEFAULT_MAX_EXTENSIONS = 40;
export const DEFAULT_MIN_SLICE_MS = 5 * 60_000;
export const DEFAULT_MAX_HOLLOW_ROUNDS = 3;
/** A round shorter than this that also produced no commits/messages counts as hollow. Generous: a real
 *  round that merely finished fast is not hollow, because the productivity signal is checked too. */
export const HOLLOW_ROUND_MS = 60_000;

/** The marker an implementor writes to end a timed window early. Mirrors the CLI text bridges
 *  (`OFFICE[team]:`, `DELIVERABLE:`) — a standalone line the pipeline reads as a decision. Kept
 *  distinctive so ordinary prose about a task being complete can never trip it. */
export const TIMED_COMPLETE_MARKER = "TIMED_TASK_COMPLETE";

/** Anchored to a line start so the marker only counts as a declaration when the implementor writes it
 *  as its own statement — not when it quotes these instructions back, mid-sentence. */
const TIMED_COMPLETE_RE = new RegExp(String.raw`^\s*(?:[-*>]\s*)?` + TIMED_COMPLETE_MARKER + String.raw`\s*[:\-—]?\s*(.*)$`, "im");

/** The window a thread is running under, or null for an ordinary task. */
export function timedWindow(thread: { durationMs?: number | null; deadlineAt?: number | null }): TimedWindow | null {
  const { durationMs, deadlineAt } = thread;
  if (deadlineAt == null || !Number.isFinite(deadlineAt)) return null;
  return { durationMs: durationMs && durationMs > 0 ? durationMs : 0, deadlineAt };
}

/** Milliseconds left in the window, floored at 0. */
export function remainingMs(deadlineAt: number, now: number): number {
  return Math.max(0, deadlineAt - now);
}

/**
 * Whether to spend another work round or close the window and hand off to the final path.
 *
 * The order of the vetoes is the policy, and each has a distinct owner-facing reason: an explicit
 * completion outranks everything (never pad a finished task), then the productivity guard (a loop
 * making no progress must not run for hours), then the wall clock, then the count. The time check
 * requires a WHOLE `minSliceMs` left rather than any time at all, so the reserve for the closing
 * QA/integration pass is protected — a round started with four minutes left would be cut off by its
 * own deadline and produce exactly the half-finished state this feature has to avoid.
 */
export function timedDecision(input: TimedDecisionInput): TimedDecision {
  const {
    deadlineAt,
    now,
    extensionsUsed,
    completeEarly = false,
    hollowRounds = 0,
    maxExtensions = DEFAULT_MAX_EXTENSIONS,
    minSliceMs = DEFAULT_MIN_SLICE_MS,
    maxHollowRounds = DEFAULT_MAX_HOLLOW_ROUNDS,
  } = input;
  const left = remainingMs(deadlineAt, now);
  const finalize = (reason: string): TimedDecision => ({ action: "finalize", reason, remainingMs: left });

  if (completeEarly) {
    return finalize(
      `The implementor reported the objective fully complete with ${formatDuration(left)} of the window unused — finishing now rather than padding the task with invented scope.`,
    );
  }
  if (hollowRounds >= maxHollowRounds) {
    return finalize(
      `${hollowRounds} consecutive work rounds finished immediately without making progress, so the window was closed early with ${formatDuration(left)} left rather than spin for the remainder.`,
    );
  }
  if (left <= 0) return finalize("The work window has ended — running the final integration and review pass.");
  if (left < minSliceMs) {
    return finalize(
      `Only ${formatDuration(left)} of the window remains — too little to start another round, and it is held back for the closing review pass.`,
    );
  }
  if (extensionsUsed >= maxExtensions) {
    return finalize(
      `The window's ${maxExtensions}-round safety limit was reached with ${formatDuration(left)} still on the clock — closing it rather than looping unbounded.`,
    );
  }
  return {
    action: "extend",
    reason: `${formatDuration(left)} left in the work window — continuing with round ${extensionsUsed + 1}.`,
    remainingMs: left,
  };
}

/** Whether a finished round counts as HOLLOW: it came back almost immediately AND left no trace. Both
 *  halves are required — a genuinely fast round that committed something is productive, and a long
 *  round that happened to produce no commit was still thinking. */
export function isHollowRound(roundMs: number, producedWork: boolean, hollowRoundMs = HOLLOW_ROUND_MS): boolean {
  return !producedWork && roundMs < hollowRoundMs;
}

/** The implementor's early-completion declaration, if the text carries one. Returns the reason it gave
 *  (may be empty), or null when it did not declare. */
export function detectTimedComplete(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = TIMED_COMPLETE_RE.exec(text);
  if (!m) return null;
  return (m[1] ?? "").trim();
}

/** Parse an owner-supplied duration: "8h", "90m", "2h30m", "45", "1d". A bare number is MINUTES, which
 *  is what the composer's numeric field means. Returns null when nothing parses, so a caller can tell
 *  "no window asked for" from "asked for something invalid" via `validateDuration`. */
export function parseDuration(input: string | number | null | undefined): number | null {
  if (input == null) return null;
  if (typeof input === "number") return Number.isFinite(input) && input > 0 ? Math.round(input * 60_000) : null;
  const text = input.trim().toLowerCase();
  if (!text) return null;
  if (/^\d+(?:\.\d+)?$/.test(text)) return Math.round(parseFloat(text) * 60_000);
  const unit: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000 };
  const parts = [...text.matchAll(/(\d+(?:\.\d+)?)\s*([dhm])/g)];
  if (!parts.length) return null;
  // Reject trailing junk ("8h banana") rather than silently honouring the part that parsed.
  if (text.replace(/(\d+(?:\.\d+)?)\s*([dhm])/g, "").trim()) return null;
  let ms = 0;
  for (const [, n, u] of parts) ms += parseFloat(n!) * unit[u!]!;
  return ms > 0 ? Math.round(ms) : null;
}

/** Clamp a requested duration into the supported range. Clamping rather than rejecting keeps a dispatch
 *  from failing outright over a number the owner can't be expected to remember the bounds of. */
export function clampDuration(ms: number): number {
  return Math.min(MAX_DURATION_MS, Math.max(MIN_DURATION_MS, Math.round(ms)));
}

/** Validate + normalize an owner-supplied duration in one step. `null` means "no window". */
export function normalizeDuration(input: string | number | null | undefined): number | null {
  const parsed = parseDuration(input);
  return parsed == null ? null : clampDuration(parsed);
}

/** Compact human duration: "8h", "1h 30m", "45m", "2d 3h". Used in prompts, findings and the UI, so it
 *  is deliberately the same wording everywhere the window is described. */
export function formatDuration(ms: number): string {
  if (ms <= 0) return "0m";
  const total = Math.round(ms / 60_000);
  const d = Math.floor(total / 1440);
  const h = Math.floor((total % 1440) / 60);
  const m = total % 60;
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

// ---- the text an agent actually sees -------------------------------------------------------------
// Kept here beside the policy rather than in threadManager's kickoff builders, because the wording and
// the rules are one thing: the extension directive PROMISES what `timedDecision` then enforces, and a
// change to one that misses the other is how an agent ends up padding a finished task.

/** The window block folded into a timed task's implementor kickoff, so the agent plans for the whole
 *  window up front instead of racing to a finish and then being asked for more. */
export function timedBriefBlock(window: TimedWindow, now: number): string {
  const left = remainingMs(window.deadlineAt, now);
  return [
    "## ⏱ This is a TIMED task",
    `${config.ownerName} asked for a work window of ${formatDuration(window.durationMs || left)}; ${formatDuration(left)} of it remains.`,
    "",
    "That window is a BUDGET, not a quota to burn. What it means for you:",
    `- Plan work that genuinely fits the window — go deeper than you would on a quick fix: verify properly, cover edge cases, test what you built, harden what you touched, and follow up on what you find.`,
    "- Stay inside the brief. Do NOT invent unrelated scope, refactor things nobody asked about, or pad the time with busywork. Depth on the actual objective is the goal; breadth for its own sake is not.",
    "- Commit as you go, so progress survives an interruption. You may be resumed several times inside this window — that is normal, not a failure.",
    `- If you genuinely complete the objective and any further work would be padding, say so: write a standalone line \`${TIMED_COMPLETE_MARKER}: <why you consider it done>\` and stop. Finishing early is a good outcome, and the window closes there.`,
    "",
    "When the window ends, your work goes to the normal review path — so leave the tree in a reviewable state at every commit, not just at the end.",
  ].join("\n");
}

/** The directive that starts one more round of work inside the window. */
export function timedExtensionMessage(o: { remainingMs: number; round: number; maxExtensions: number }): string {
  return [
    `⏱ The work window is still open — ${formatDuration(o.remainingMs)} remains (round ${o.round} of at most ${o.maxExtensions}).`,
    "",
    "You have NOT been asked to start something new. Continue on the SAME objective and make it better in ways that genuinely matter:",
    "- finish anything you left partial, and fix anything you noticed but skipped;",
    "- verify your own work — run the build and the tests, drive the UI if there is one, and prove the change actually behaves;",
    "- strengthen coverage, error handling and edge cases around what you changed;",
    "- tidy what you touched and make sure the docs describing it are true.",
    "",
    "Scope discipline still applies: do not wander outside the brief, and do not manufacture work to fill time.",
    `If the objective is genuinely complete and anything further would be padding, write a standalone line \`${TIMED_COMPLETE_MARKER}: <why>\` and stop — the window closes there and the task moves to review.`,
    "",
    "Commit what you finish before you end this round.",
  ].join("\n");
}

/** The owner-facing note attached when the window closes. */
export function timedClosingNote(decision: TimedDecision, roundsUsed: number): string {
  return `${decision.reason} ${roundsUsed} work round(s) ran inside the window.`;
}
