// Director Supervisor: a lightweight watchdog over active tasks (Settings → Director Supervisor, off by
// default). See CLAUDE.md's "Director Supervisor" section for the policy in one place; this file is the
// mechanism.
//
// Off, it costs nothing: `setEnabled` is the only thing that ever arms the sweep timer, and the hub
// subscription (always live, so a mid-session enable needs no reconnect) returns in one boolean check.
//
// On, it is event-driven first: a thread state TRANSITION (not every field touch) enqueues one
// evaluation. A periodic sweep is the safety net for a task that stopped producing events entirely —
// its interval backs off exponentially while there is nothing active to watch, and snaps back the
// instant real work exists, so it never becomes a frequent poll.
//
// Every evaluation runs cheap DETERMINISTIC checks first (thread state, live-run presence, message
// activity — no model call). Only a signal that genuinely merits judgement — a task stalled with no live
// run, or sitting in review/failed for a long time with no follow-up — spends the cheap bounded no-tools
// agent check-in (`ThreadManager.supervisorJudge`), which reads the task's own findings/history before
// answering. A single async queue serializes every pass (deterministic or agent-backed) so at most one
// is ever in flight, which is also what makes "no work while off" and "one pass at a time while on" the
// same mechanism.
//
// Every action is bounded and reversible: `postFinding` (comment / critical-severity correction — reusing
// the SAME finding-routing path any agent's own findings take, never a bespoke interrupt) or
// `resumeThread` (the exact call the manual Resume button makes). Nothing here ever cancels, retries
// (which wipes history), or deletes anything, and 'cancelled'/'closed' tasks are never candidates at all.

import type { Db } from "../db/db.js";
import type { EventHub } from "../events.js";
import type { PostFindingInput, ThreadActionResult } from "./api.js";
import type { JsonSchemaLike } from "../agents/structuredText.js";
import type {
  AgentRun,
  Finding,
  ImplementorProvider,
  SupervisorAction,
  SupervisorEvent,
  SupervisorSnapshot,
  SupervisorTrigger,
  Thread,
  ThreadState,
  TokenUsage,
} from "../types.js";

/** What one cheap bounded judgement call cost and who ran it — `ThreadManager.supervisorJudge` builds
 *  this from the same result shape `askDirectorJson` discards, so the supervisor can keep a visible,
 *  bounded budget instead of an untracked one. Null = no capacity / the call failed outright. */
export interface SupervisorJudgement {
  output: unknown;
  costUsd: number;
  tokenUsage?: TokenUsage;
  model: string;
  provider: ImplementorProvider;
}

/** The narrow slice of ThreadManager the supervisor actually needs — kept separate from the full
 *  `OrchestratorApi` so this file never has to import ThreadManager (no cycle) and every capability the
 *  supervisor has is visible in one place. ThreadManager satisfies this structurally. */
export interface SupervisorHost {
  readonly db: Db;
  readonly hub: EventHub;
  supervisorJudge(prompt: string, schema: JsonSchemaLike): Promise<SupervisorJudgement | null>;
  postFinding(input: PostFindingInput): Finding;
  resumeThread(threadId: string, message?: string): Promise<ThreadActionResult>;
  /** Delegate a normal human-review park to the existing reviewer. The reviewer, not the supervisor,
   *  remains the only autonomous path that may accept work as done. */
  autoReview(threadId: string): Promise<ThreadActionResult>;
  supervisorDiscordReady(): boolean;
  /** Forward one high-signal event to the owner's phone — reuses the same Discord config/permission/
   *  serialization every other owner notice goes through; a no-op when the integration is off. */
  notifySupervisor(kind: "done" | "input" | "failed", title: string, detail?: string, repo?: string): void;
}

// ---- tunables ----

/** Tasks currently being worked BY an agent — the only states stall detection applies to. A task waiting
 *  on the owner (awaiting_user/awaiting_approval/paused) is already visibly waiting; nothing to add. */
const ACTIVE_STATES = new Set<ThreadState>(["planning", "researching", "implementing", "qa", "reviewing"]);
/** Settled-but-parked states worth a "did this get forgotten" check — never a state the owner is already
 *  mid-decision on (awaiting_user/awaiting_approval), which is a design wait, not a bug. */
const PARKED_STATES = new Set<ThreadState>(["review", "failed"]);

/** Per-state "no live run + no activity for this long" stall threshold. Generous on purpose — every
 *  backend already has its own no-output watchdog (Codex/Grok's firstEventMs/inactivityMs) for a wedged
 *  CLI turn; this is the second-layer net for a dropped promise the pipeline itself never noticed. */
const STALL_THRESHOLD_MS: Partial<Record<ThreadState, number>> = {
  planning: 15 * 60_000,
  researching: 15 * 60_000,
  implementing: 25 * 60_000,
  qa: 20 * 60_000,
  reviewing: 15 * 60_000,
};
/** How long a review/failed park can sit with no follow-up before it looks "forgotten" rather than a
 *  design wait for the owner's attention. The cap-park marker (checked separately) is excluded entirely —
 *  that queue is the capacity supervisor's, not ours. */
const FORGOTTEN_PARK_MS = 6 * 60 * 60_000;

/** Cap-park marker text `resumeCapParked` owns — matched loosely (case-insensitive substring) so a
 *  reworded message still excludes it; false negatives here just mean an extra (harmless) check-in. */
const CAP_PARK_MARKER = /auto-resume pending/i;

/** Don't re-examine the same task more than this often once it's been looked at (of any kind). Applies to
 *  the eligible-for-checkin path; a routine deterministic "healthy" log on a genuine phase change is not
 *  gated by it (those are naturally rate-limited by how often a task actually changes phase). */
const TASK_COOLDOWN_MS = 15 * 60_000;

/** Daily bounded-check-in budget — the ceiling that makes "cheap" durable even under a pathological flood
 *  of flapping tasks. Deterministic checks keep running past this; only the agent call stops. */
const MAX_CHECKINS_PER_DAY = 60;
const MAX_COST_USD_PER_DAY = 3;
// Preserve the originally intended 60-check-in daily runway after raising a single judgement from two
// to eight turns: 60 reservations x 8K tokens. The separate $3 cap remains the tighter practical cost
// control when a provider reports prices.
const MAX_TOKENS_PER_DAY = 480_000;
// No runner exposes a reliable output-token ceiling across every provider. Reserve enough room for the
// fuller eight-turn no-tools judgement before a check-in, so the durable daily token guard remains useful.
const TOKEN_RESERVATION_PER_CHECKIN = 8_000;

/** Two turns routinely cut off the first meaningful judgement before it could inspect a handoff and
 *  return the required JSON. Eight no-tools turns leave room to reason and self-correct, while the
 *  single-flight queue plus daily cost/token ceilings still bound this as an operator, not a swarm. */
export const SUPERVISOR_JUDGE_MAX_TURNS = 8;

/** Sweep cadence: a short, responsive interval the instant there's real work to watch, exponential
 *  backoff up to a long ceiling once nothing is active at all. */
const ACTIVE_SWEEP_MS = 5 * 60_000;
const IDLE_SWEEP_START_MS = 2 * 60_000;
const MAX_SWEEP_MS = 30 * 60_000;

/** Per-thread+action Discord dedupe, and a global minimum gap between any two supervisor notices — cheap
 *  batching: a burst of unrelated events still can't produce more than one phone buzz every few minutes. */
const DISCORD_THREAD_COOLDOWN_MS = 20 * 60_000;
const DISCORD_GLOBAL_GAP_MS = 5 * 60_000;

const EVENTS_BROADCAST_LIMIT = 100;
const DIGEST_FINDINGS = 5;
const DIGEST_RUNS = 3;
const DIGEST_MESSAGES = 6;
const MESSAGE_PREVIEW_CHARS = 220;
const VERDICT_MESSAGE_CHARS = 400;
const VERDICT_REASON_CHARS = 300;
const DEFAULT_STALL_MS = 20 * 60_000;

/** Every guardrail the supervisor enforces, gathered so a test (or a future settings surface) can tune
 *  them without touching the mechanism. `DEFAULT_SUPERVISOR_CONFIG` is what production actually runs. */
export interface SupervisorConfig {
  taskCooldownMs: number;
  maxCheckinsPerDay: number;
  maxCostUsdPerDay: number;
  maxTokensPerDay: number;
  forgottenParkMs: number;
  stallThresholdMs: Partial<Record<ThreadState, number>>;
  defaultStallMs: number;
  activeSweepMs: number;
  idleSweepStartMs: number;
  maxSweepMs: number;
  discordThreadCooldownMs: number;
  discordGlobalGapMs: number;
}

export const DEFAULT_SUPERVISOR_CONFIG: SupervisorConfig = {
  taskCooldownMs: TASK_COOLDOWN_MS,
  maxCheckinsPerDay: MAX_CHECKINS_PER_DAY,
  maxCostUsdPerDay: MAX_COST_USD_PER_DAY,
  maxTokensPerDay: MAX_TOKENS_PER_DAY,
  forgottenParkMs: FORGOTTEN_PARK_MS,
  stallThresholdMs: STALL_THRESHOLD_MS,
  defaultStallMs: DEFAULT_STALL_MS,
  activeSweepMs: ACTIVE_SWEEP_MS,
  idleSweepStartMs: IDLE_SWEEP_START_MS,
  maxSweepMs: MAX_SWEEP_MS,
  discordThreadCooldownMs: DISCORD_THREAD_COOLDOWN_MS,
  discordGlobalGapMs: DISCORD_GLOBAL_GAP_MS,
};

export interface Assessment {
  eligible: boolean;
  reason: string;
  /** A watchdog-shaped scenario worth logging even when not eligible for an agent call (a healthy phase
   *  change), vs. routine noise (an unrelated field touch, already filtered before this runs). */
  loggable: boolean;
}

export interface SupervisorVerdict {
  action: SupervisorAction | "none";
  message: string;
  reasoning: string;
  requiresOwner: boolean;
}

const VERDICT_SCHEMA: JsonSchemaLike = {
  type: "object",
  additionalProperties: false,
  required: ["action", "message", "reasoning", "requiresOwner"],
  properties: {
    action: { type: "string", enum: ["none", "comment", "inject_correction", "trigger_recovery", "start_auto_review", "alert", "cleanup"] },
    message: { type: "string" },
    reasoning: { type: "string" },
    requiresOwner: { type: "boolean" },
  },
};

function clip(text: string, max: number): string {
  const t = (text ?? "").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function humanDuration(ms: number): string {
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem ? `${hours}h${rem}m` : `${hours}h`;
}

function startOfDayMs(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function todayKey(): string {
  // Keep the display key aligned with startOfDayMs(), which deliberately uses the server's local
  // operator day rather than UTC. A UTC label would otherwise say "tomorrow" for part of an evening
  // while the budget was still correctly counting the current local day.
  const d = new Date();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

/** Deterministic, no-agent judgement of one task. Never mutates anything — pure read against the facts
 *  the caller already gathered, so it's directly unit-testable with no DB/agent involved. */
export function assess(
  thread: Thread,
  opts: { hasLiveRun: boolean; lastActivityAt: number | null; now: number; cfg?: SupervisorConfig },
): Assessment {
  const cfg = opts.cfg ?? DEFAULT_SUPERVISOR_CONFIG;
  // A lifecycle update is activity too. In particular, a task that just moved into QA after a quiet
  // implementation must not inherit an old agent-message timestamp and be called "stalled" straight
  // away. Findings/messages still win when they are newer.
  const lastActivityAt = Math.max(thread.updatedAt, opts.lastActivityAt ?? 0);
  const since = opts.now - lastActivityAt;

  if (PARKED_STATES.has(thread.state)) {
    if (CAP_PARK_MARKER.test(thread.error ?? "")) {
      return { eligible: false, loggable: false, reason: "cap-parked — owned by the capacity supervisor" };
    }
    if (opts.hasLiveRun) {
      // A parked task must not retain a live runner. Leave it untouched, but let the bounded judgement
      // inspect the history rather than silently accepting a contradictory lifecycle state.
      return { eligible: true, loggable: true, reason: `inconsistent state — ${thread.state} still has a live run` };
    }
    if (since >= cfg.forgottenParkMs) {
      return { eligible: true, loggable: true, reason: `sitting in ${thread.state} for ${humanDuration(since)} with no follow-up` };
    }
    return { eligible: false, loggable: true, reason: `${thread.state} — awaiting your review` };
  }

  if (ACTIVE_STATES.has(thread.state)) {
    const threshold = cfg.stallThresholdMs[thread.state] ?? cfg.defaultStallMs;
    if (!opts.hasLiveRun && since >= threshold) {
      return { eligible: true, loggable: true, reason: `no live run and no activity for ${humanDuration(since)} while ${thread.state}` };
    }
    if (opts.hasLiveRun && since >= threshold * 2) {
      // The runner's own no-output watchdog gets the first chance. This slower second layer catches
      // stale bookkeeping or an exhausted recovery loop without interrupting ordinary long commands.
      return { eligible: true, loggable: true, reason: `live run has made no recorded progress for ${humanDuration(since)} while ${thread.state}` };
    }
    return { eligible: false, loggable: true, reason: `${thread.state} — live and active` };
  }

  return { eligible: false, loggable: true, reason: `${thread.state}` };
}

export interface Digest {
  thread: Thread;
  assessment: Assessment;
  findingsText: string;
  runsText: string;
  messagesText: string;
}

export function buildDigest(db: Db, thread: Thread, assessment: Assessment): Digest {
  const findings = db.listFindings(thread.id).slice(-DIGEST_FINDINGS);
  const runs = db.listRuns(thread.id).slice(-DIGEST_RUNS);
  const messages = db.listMessages(thread.id).slice(-DIGEST_MESSAGES);
  return {
    thread,
    assessment,
    findingsText: findings.length
      ? findings.map((f) => `- [${f.severity}] ${f.fromRole ?? "?"}: ${f.summary}${f.detail ? ` — ${clip(f.detail, 200)}` : ""}`).join("\n")
      : "(no findings recorded)",
    runsText: runs.length
      ? runs
          .map((r: AgentRun) => `- ${r.role} on ${r.model}${r.account ? ` (${r.account})` : ""}: ${r.state}${r.error ? ` — ${clip(r.error, 200)}` : ""}${r.costUsd ? ` [$${r.costUsd.toFixed(2)}, ${r.numTurns ?? "?"} turns]` : ""}`)
          .join("\n")
      : "(no runs recorded)",
    messagesText: messages.length
      ? messages.map((m) => `- ${m.role} (${m.kind}): ${clip(m.content, MESSAGE_PREVIEW_CHARS)}`).join("\n")
      : "(no messages yet)",
  };
}

export function buildPrompt(d: Digest): string {
  return [
    "You are a careful supervisor watching ONE autonomous coding task in progress. You are not the implementor — you never edit code yourself. Your only job is to decide whether this task needs a bounded, reversible nudge, or should simply be left alone.",
    "",
    `Task: ${d.thread.title}`,
    `Repository: ${d.thread.workspace}`,
    `Current state: ${d.thread.state}${d.thread.error ? ` — ${clip(d.thread.error, 300)}` : ""}`,
    `Why this task was flagged for your attention: ${d.assessment.reason}`,
    "",
    "## Recent findings (the task's own blackboard)",
    d.findingsText,
    "",
    "## Recent agent runs",
    d.runsText,
    "",
    "## Recent feed messages (oldest first)",
    d.messagesText,
    "",
    "## Your options",
    "- start_auto_review: hand a normal newly-completed review park to the existing reviewer, which can inspect the workspace and either accept it as done or hand it back. Prefer this over claiming completion yourself. Never use it for a cap-park, an owner approval/input wait, or a task that is not in review.",
    "- none: nothing actually warrants acting — the deterministic flag was a false alarm or it's fine to keep waiting.",
    "- comment: append a short, useful note to the task's findings. Non-urgent, does not interrupt anything.",
    "- inject_correction: post an urgent correction that reaches a live agent immediately. Only when you have real evidence the task is off track and a live agent could act on it right now.",
    "- trigger_recovery: resume the task from where it left off (the same effect as a human clicking Resume) — appropriate when it looks stalled/dropped rather than genuinely blocked or intentionally waiting.",
    "- alert: this needs the owner's attention — a real blocker, exhausted retries, or a decision only they can make. Nothing you can safely do yourself.",
    "- cleanup: the task is done and healthy; just record that you looked.",
    "",
    "Be conservative. Never revive work the owner cancelled, never claim something is done when you're not sure, never invent an action beyond the six above. `message` is what gets shown/sent (comment text, correction text, alert text) — keep it concise and concrete. `reasoning` is your own short justification for the audit log. `requiresOwner` is true only when a human specifically needs to see this (used to decide whether it's worth a phone notification).",
    "Reply with exactly one JSON object matching the schema.",
  ].join("\n");
}

export function parseVerdict(output: unknown): SupervisorVerdict | null {
  if (!output || typeof output !== "object") return null;
  const raw = output as Record<string, unknown>;
  const actions: SupervisorAction[] = ["comment", "inject_correction", "trigger_recovery", "start_auto_review", "alert", "cleanup"];
  const action = typeof raw.action === "string" && (actions as string[]).includes(raw.action) ? (raw.action as SupervisorAction) : null;
  if (raw.action !== "none" && !action) return null;
  return {
    action: action ?? "none",
    message: typeof raw.message === "string" ? clip(raw.message, VERDICT_MESSAGE_CHARS) : "",
    reasoning: typeof raw.reasoning === "string" ? clip(raw.reasoning, VERDICT_REASON_CHARS) : "",
    requiresOwner: raw.requiresOwner === true,
  };
}

export class DirectorSupervisor {
  private readonly cfg: SupervisorConfig;
  private enabled = false;
  private running = false;
  private sweepTimer: ReturnType<typeof setTimeout> | undefined;
  private sweepIntervalMs: number;
  private readonly stateCache = new Map<string, ThreadState>();
  private readonly queue: { threadId: string; trigger: SupervisorTrigger }[] = [];
  private readonly queued = new Set<string>();
  private drainPromise: Promise<void> | undefined;
  private lastCheckAt: number | undefined;
  private lastDiscordAt = 0;

  constructor(
    private readonly host: SupervisorHost,
    cfgOverrides: Partial<SupervisorConfig> = {},
  ) {
    this.cfg = { ...DEFAULT_SUPERVISOR_CONFIG, ...cfgOverrides };
    this.sweepIntervalMs = this.cfg.idleSweepStartMs;
    this.host.hub.subscribe((e) => {
      if (!this.enabled) return;
      if (e.type === "thread.upsert") this.onThreadUpsert(e.thread);
      else if (e.type === "thread.removed") this.stateCache.delete(e.threadId);
    });
  }

  setEnabled(on: boolean): void {
    if (this.enabled === on) return;
    this.enabled = on;
    if (on) {
      // This is intentionally deferred until the feature is enabled: default-off owns no timer and
      // does not even perform a startup audit read merely to maintain a notification cooldown.
      this.lastDiscordAt = this.host.db.lastSupervisorNoticeAt() ?? 0;
      this.stateCache.clear();
      for (const t of this.host.db.listThreads()) this.stateCache.set(t.id, t.state);
      this.sweepIntervalMs = this.cfg.idleSweepStartMs;
      this.scheduleSweep(this.sweepIntervalMs);
    } else {
      clearTimeout(this.sweepTimer);
      this.sweepTimer = undefined;
      this.queue.length = 0;
      this.queued.clear();
    }
    this.broadcast();
  }

  /** An explicit "run now" — one immediate pass over every current candidate task, cooldown still
   *  respected per task (so repeated clicks don't spend the budget for nothing). Resolves once every
   *  enqueued task has been evaluated. */
  async runNow(): Promise<void> {
    if (!this.enabled) return;
    for (const t of this.host.db.listThreads()) {
      if (ACTIVE_STATES.has(t.state) || PARKED_STATES.has(t.state)) this.enqueue(t.id, "manual");
    }
    await this.drain();
  }

  snapshot(): SupervisorSnapshot {
    const budget = this.host.db.supervisorBudgetToday(startOfDayMs());
    const events = this.host.db.listSupervisorEvents(EVENTS_BROADCAST_LIMIT);
    return {
      enabled: this.enabled,
      running: this.running,
      watching: this.host.db.supervisorWatchingCount(Date.now() - 7 * 24 * 60 * 60_000),
      // lastCheckAt is a display cache while this process lives. The durable event row is the restart
      // authority, so the console never loses its "last check" line after a normal server bounce.
      lastCheckAt: this.lastCheckAt ?? events[0]?.createdAt ?? null,
      budget: {
        date: todayKey(),
        checkinsToday: budget.checkins,
        costUsdToday: Math.round(budget.costUsd * 10_000) / 10_000,
        tokensToday: budget.totalTokens,
        maxCheckinsPerDay: this.cfg.maxCheckinsPerDay,
        maxCostUsdPerDay: this.cfg.maxCostUsdPerDay,
        maxTokensPerDay: this.cfg.maxTokensPerDay,
      },
      events,
    };
  }

  private broadcast(): void {
    this.host.hub.publish({ type: "supervisor", supervisor: this.snapshot() });
  }

  private onThreadUpsert(thread: Thread): void {
    const prev = this.stateCache.get(thread.id);
    this.stateCache.set(thread.id, thread.state);
    if (prev === thread.state) return; // no phase change — the common case, cheap no-op
    if (thread.state === "cancelled" || thread.state === "closed") return; // never a candidate
    this.enqueue(thread.id, "state_change");
  }

  private enqueue(threadId: string, trigger: SupervisorTrigger): void {
    const key = `${threadId}:${trigger === "state_change" ? "state_change" : "sweep"}`;
    if (this.queued.has(key)) return;
    this.queued.add(key);
    this.queue.push({ threadId, trigger });
    void this.drain();
  }

  /** The single-flight guarantee: however many callers enqueue work, only one evaluation is ever
   *  in-flight, and `running` (visible on the snapshot) is true for exactly that window. */
  private async drain(): Promise<void> {
    // Return the already-running queue promise. Apart from maintaining the single-flight invariant,
    // this is what makes `runNow()` truthfully wait until all of its enqueued tasks were examined.
    if (this.drainPromise) return this.drainPromise;
    const work = this.drainQueue();
    let completed: Promise<void>;
    completed = work.finally(() => {
      // `drainQueue` can finish synchronously when there was nothing to do, so the pointer is assigned
      // before this continuation runs. That avoids retaining a fulfilled promise forever after Run now
      // on an empty board.
      if (this.drainPromise !== completed) return;
      this.drainPromise = undefined;
      this.broadcast();
      // A new item can only arrive after the loop last observed an empty queue. Start a fresh pass for
      // it rather than leaving an edge-of-turn event stranded until the next sweep.
      if (this.enabled && this.queue.length) void this.drain();
    });
    this.drainPromise = completed;
    return completed;
  }

  private async drainQueue(): Promise<void> {
    while (this.queue.length) {
      const item = this.queue.shift()!;
      this.queued.delete(`${item.threadId}:${item.trigger === "state_change" ? "state_change" : "sweep"}`);
      this.running = true;
      this.broadcast();
      try {
        await this.evaluate(item.threadId, item.trigger);
      } catch (e) {
        this.host.hub.log("warn", `Supervisor pass on ${item.threadId.slice(0, 8)} failed: ${String(e)}`);
      }
      this.running = false;
    }
  }

  private scheduleSweep(delayMs: number): void {
    clearTimeout(this.sweepTimer);
    if (!this.enabled) return;
    this.sweepTimer = setTimeout(() => void this.sweep(), delayMs);
    this.sweepTimer.unref?.();
  }

  /** The idle-catch safety net: scan every candidate task for staleness the event path might have missed
   *  (a dropped promise never re-touches the thread row, so it never fires a state-change event at all).
   *  Backs off exponentially while nothing is active; snaps back the moment real work exists. */
  private async sweep(): Promise<void> {
    if (!this.enabled) return;
    const threads = this.host.db.listThreads();
    const candidates = threads.filter((t) => ACTIVE_STATES.has(t.state) || PARKED_STATES.has(t.state));
    for (const t of candidates) this.enqueue(t.id, "stall_sweep");
    this.sweepIntervalMs = candidates.length ? this.cfg.activeSweepMs : Math.min(this.sweepIntervalMs * 2, this.cfg.maxSweepMs);
    this.scheduleSweep(this.sweepIntervalMs);
  }

  private async evaluate(threadId: string, trigger: SupervisorTrigger): Promise<void> {
    if (!this.enabled) return;
    const thread = this.host.db.getThread(threadId);
    if (!thread) return;

    if (thread.state === "done") {
      this.handleDone(thread, trigger);
      return;
    }

    const liveIds = new Set(this.host.db.listActiveRuns().map((r) => r.threadId));
    const lastActivity = this.host.db.lastActivityAt(threadId);
    const hasLiveRun = liveIds.has(threadId);
    let assessment = assess(thread, { hasLiveRun, lastActivityAt: lastActivity, now: Date.now(), cfg: this.cfg });

    // A new non-cap failure is rare and merits a concise diagnosis now, not six hours later. Restrict
    // this to a real lifecycle event: turning the supervisor on must not spend check-ins reviewing an
    // old backlog of historical failures. A capacity park remains exclusively owned by its existing
    // recovery loop, and a contradictory live run is already covered by assess().
    if (!assessment.eligible && trigger === "state_change" && thread.state === "failed" && !hasLiveRun && !CAP_PARK_MARKER.test(thread.error ?? "")) {
      assessment = {
        eligible: true,
        loggable: true,
        reason: "task newly entered failed state - inspect retries, fallback history, and whether the owner is needed",
      };
    }

    // A normal review park is the one state where the supervisor can safely be self-sufficient: it may
    // delegate the owner's review to the established, read-only auto-reviewer. This is deliberately a
    // lifecycle/manual signal only, never a sweep of old review backlog, and autoReview itself rechecks
    // the state, cap marker, workspace and capacity before it starts anything.
    if (
      !assessment.eligible &&
      thread.state === "review" &&
      !hasLiveRun &&
      !CAP_PARK_MARKER.test(thread.error ?? "") &&
      (trigger === "state_change" || trigger === "manual")
    ) {
      assessment = {
        eligible: true,
        loggable: true,
        reason: "task newly entered normal review - inspect its handoff and decide whether the existing auto-reviewer can verify it",
      };
    }

    if (!assessment.eligible) {
      // Log a routine phase change (transparency) but never spam the log every sweep tick for a task
      // that's simply, unremarkably, still working.
      if (trigger === "state_change" && assessment.loggable) {
        this.record(thread, trigger, "check", null, assessment.reason, false);
      }
      return;
    }

    // A routine phase-change transparency row must not hide a later high-signal lifecycle transition.
    // Failed/review transitions and contradictory parked+live states are each one distinct state_change,
    // so bypassing the cooldown here preserves immediate diagnosis/delegation without creating a
    // flapping retry loop.
    const bypassCooldown =
      trigger === "state_change" &&
      (thread.state === "failed" || thread.state === "review" || (PARKED_STATES.has(thread.state) && hasLiveRun));
    const lastAt = this.host.db.lastSupervisorEventAt(threadId);
    if (!bypassCooldown && lastAt != null && Date.now() - lastAt < this.cfg.taskCooldownMs) return; // recently examined — say nothing

    const budget = this.host.db.supervisorBudgetToday(startOfDayMs());
    if (
      budget.checkins >= this.cfg.maxCheckinsPerDay ||
      budget.costUsd >= this.cfg.maxCostUsdPerDay ||
      budget.totalTokens + TOKEN_RESERVATION_PER_CHECKIN > this.cfg.maxTokensPerDay
    ) {
      this.record(
        thread,
        trigger,
        "skip",
        null,
        `daily check-in budget reached (${budget.checkins} check-ins, $${budget.costUsd.toFixed(2)}, ${budget.totalTokens} tokens) — deterministic signal: ${assessment.reason}`,
        false,
      );
      return;
    }

    const digest = buildDigest(this.host.db, thread, assessment);
    const judged = await this.host.supervisorJudge(buildPrompt(digest), VERDICT_SCHEMA).catch(() => null);
    if (!judged) {
      this.record(thread, trigger, "error", null, `no capacity for a check-in right now — deterministic signal stands: ${assessment.reason}`, false);
      return;
    }
    const verdict = parseVerdict(judged.output);
    // A toggle-off while the bounded call was in flight cannot refund that one request, but it must
    // prevent every follow-up mutation/notification and must not leave another task queued behind it.
    if (!this.enabled) return;
    if (!verdict) {
      this.record(thread, trigger, "error", null, "the check-in returned an unusable reply", true, judged);
      return;
    }
    if (verdict.action === "none" || verdict.action === "cleanup") {
      this.record(thread, trigger, "skip", verdict.action === "cleanup" ? "cleanup" : null, verdict.reasoning || "no action warranted", true, judged);
      return;
    }

    // Re-fetch right before acting: the judgement call takes a few seconds, and a stale verdict must
    // never act on a task the owner (or another mechanism) has since moved on from.
    const fresh = this.host.db.getThread(threadId);
    if (!fresh || fresh.state === "cancelled" || fresh.state !== thread.state) {
      this.record(thread, trigger, "skip", verdict.action, `task moved on before acting (now ${fresh?.state ?? "gone"}) — verdict discarded`, true, judged);
      return;
    }

    const acted = await this.act(fresh, verdict);
    if (!acted.ok) {
      this.record(fresh, trigger, "skip", verdict.action, acted.reason, true, judged);
      return;
    }
    const notified = this.maybeNotify(fresh, verdict);
    this.record(fresh, trigger, "action", verdict.action, verdict.message || verdict.reasoning, true, judged, notified);
  }

  private handleDone(thread: Thread, trigger: SupervisorTrigger): void {
    // Idempotent: once this task has a 'check' row for its own settle, a duplicate state_change/sweep
    // pass (a resettle, a re-broadcast) has nothing new to say.
    if (this.host.db.lastSupervisorEventAt(thread.id) != null) {
      const events = this.host.db.listSupervisorEvents(EVENTS_BROADCAST_LIMIT);
      if (events.some((e) => e.threadId === thread.id && e.action === "cleanup")) return;
    }
    const runs = this.host.db.listRuns(thread.id);
    const cost = runs.reduce((s, r) => s + (r.costUsd ?? 0), 0);
    const watchedAt = this.host.db.lastSupervisorWatchAt(thread.id);
    const summary = `settled done — ${runs.length} run${runs.length === 1 ? "" : "s"}, $${cost.toFixed(2)} total`;
    let notified = false;
    if (watchedAt != null) {
      notified = this.notifyIfDue(thread, "cleanup", "done", `Supervisor: "${thread.title}" reached done after supervisor involvement.`, summary);
    }
    this.record(thread, trigger, "check", "cleanup", summary, false, undefined, notified);
  }

  /** Enforce the action boundaries again after the model replied: the task may have changed underneath
   *  it, and a stale verdict must not become an interrupt or an unwanted retry. */
  private async act(thread: Thread, verdict: SupervisorVerdict): Promise<{ ok: true } | { ok: false; reason: string }> {
    const message = verdict.message || verdict.reasoning || "(no message)";
    switch (verdict.action) {
      case "comment":
        this.host.postFinding({ threadId: thread.id, fromRole: "director", summary: `Supervisor: ${clip(message, 140)}`, detail: verdict.reasoning || null, severity: "note" });
        return { ok: true };
      case "inject_correction":
        if (!this.host.db.listActiveRuns().some((run) => run.threadId === thread.id)) {
          return { ok: false, reason: "correction skipped - no live agent remains to receive it" };
        }
        this.host.postFinding({ threadId: thread.id, fromRole: "director", summary: `Supervisor correction: ${clip(message, 140)}`, detail: verdict.reasoning || null, severity: "critical" });
        return { ok: true };
      case "trigger_recovery": {
        const live = this.host.db.listActiveRuns().some((run) => run.threadId === thread.id);
        // Review is an owner decision, not a crash. A live task has already recovered without us.
        if (live || (!ACTIVE_STATES.has(thread.state) && thread.state !== "failed")) {
          return { ok: false, reason: `recovery skipped - ${live ? "the task is live again" : `${thread.state} requires an owner decision`}` };
        }
        const recovery = await this.host.resumeThread(thread.id, `Supervisor: ${message}`);
        if (!recovery.ok) return { ok: false, reason: `recovery declined - ${recovery.error ?? "the task could not be resumed"}` };
        this.host.postFinding({ threadId: thread.id, fromRole: "director", summary: `Supervisor resumed this task: ${clip(message, 140)}`, detail: verdict.reasoning || null, severity: "note" });
        return { ok: true };
      }
      case "start_auto_review": {
        if (thread.state !== "review" || CAP_PARK_MARKER.test(thread.error ?? "")) {
          return { ok: false, reason: "auto-review skipped - only a normal review park is eligible" };
        }
        const review = await this.host.autoReview(thread.id);
        if (!review.ok) return { ok: false, reason: `auto-review declined - ${review.error ?? "the reviewer could not be started"}` };
        this.host.postFinding({
          threadId: thread.id,
          fromRole: "director",
          summary: `Supervisor delegated review: ${clip(message, 140)}`,
          detail: verdict.reasoning || "The reviewer now owns the acceptance decision; the supervisor did not mark this task done.",
          severity: "note",
        });
        return { ok: true };
      }
      case "alert":
        this.host.postFinding({ threadId: thread.id, fromRole: "director", summary: `Supervisor flagged: ${clip(message, 140)}`, detail: verdict.reasoning || null, severity: "warning" });
        return { ok: true };
      default:
        return { ok: false, reason: "unsupported supervisor action was discarded" };
    }
  }

  /** Forward to Discord only for the two owner-facing actions, with per-thread cooldown AND a global
   *  minimum gap between any two supervisor notices (the "cannot spam" guardrail). Returns whether a
   *  notice actually went out, so the audit row records it accurately. */
  private maybeNotify(thread: Thread, verdict: SupervisorVerdict): boolean {
    if (verdict.action !== "alert" && !(verdict.action === "trigger_recovery" && verdict.requiresOwner)) return false;
    const action: SupervisorAction = verdict.action === "alert" ? "alert" : "trigger_recovery";
    return this.notifyIfDue(thread, action, "input", `Supervisor: ${thread.title}`, verdict.message || verdict.reasoning);
  }

  private notifyIfDue(thread: Thread, action: SupervisorAction, kind: "done" | "input" | "failed", title: string, detail: string): boolean {
    if (!this.host.supervisorDiscordReady()) return false;
    const now = Date.now();
    if (now - this.lastDiscordAt < this.cfg.discordGlobalGapMs) return false;
    const lastForThis = this.host.db.lastSupervisorNoticeAt(thread.id, action);
    if (lastForThis != null && now - lastForThis < this.cfg.discordThreadCooldownMs) return false;
    this.host.notifySupervisor(kind, title, detail, thread.workspace);
    this.lastDiscordAt = now;
    return true;
  }

  private record(
    thread: Thread,
    trigger: SupervisorTrigger,
    kind: "check" | "action" | "skip" | "error",
    action: SupervisorAction | null,
    summary: string,
    usedAgent: boolean,
    judged?: SupervisorJudgement | null,
    notifiedDiscord = false,
  ): void {
    const event = this.host.db.recordSupervisorEvent({
      threadId: thread.id,
      threadTitle: thread.title,
      workspace: thread.workspace,
      trigger,
      kind,
      action,
      summary: clip(summary, 500),
      detail: judged ? `model ${judged.model} (${judged.provider})` : null,
      usedAgent,
      costUsd: judged?.costUsd ?? null,
      totalTokens: judged?.tokenUsage?.totalTokens ?? null,
      model: judged?.model ?? null,
      notifiedDiscord,
    });
    // The event timestamp is the durable definition of a visible supervisor check. Mirroring it in
    // memory keeps this process's snapshot cheap while making the restart snapshot byte-for-byte
    // consistent with the persisted audit trail.
    this.lastCheckAt = event.createdAt;
    this.broadcast();
  }
}
