import type { Db } from "../db/db.js";
import type { EventHub } from "../events.js";
import { restartSelf, type RestartAttempt } from "../selfRestart.js";

/**
 * Coordinates planned server restarts with the agents that server owns.
 *
 * The process supervisor tree-kills the server and its CLI children. A restart is therefore safe only
 * after the current task, Co-work, Director, and Supervisor cohort has finished. Once a restart is
 * requested, callers use `isDraining()` as an admission lock: existing work may run through its normal
 * completion boundary, while fresh agent starts wait until the new process is live. There is no
 * elapsed-time escape hatch. An active agent is never traded for a faster deploy.
 *
 * The pending record is durable because the operation it represents destroys the in-memory timer that
 * owns it. Multiple builds staged during one drain ride the same restart. The existing `/api/deploy/*`
 * route names remain a compatibility surface for deploy scripts; this class is not a rate-limit gate.
 */

export interface RestartDecisionInput {
  activeWork: number;
  now: number;
  /** Set only after a restart mechanism refused/failed, to bound retries without busy-looping. */
  retryAt?: number | null;
}

export type RestartDecision =
  | { allow: true; reason: string }
  | { allow: false; retryAt: number | null; reason: string };

/** Pure policy: active work always wins; time only controls retries after a failed restart attempt. */
export function decideRestart(input: RestartDecisionInput): RestartDecision {
  const activeWork = Math.max(0, Math.floor(input.activeWork));
  if (activeWork > 0) {
    return {
      allow: false,
      retryAt: null,
      reason: activeWork === 1
        ? "1 active work item remains — restart after it finishes"
        : `${countWork(activeWork)} remain — restart after they finish`,
    };
  }
  const retryAt = Number.isFinite(input.retryAt) ? Number(input.retryAt) : null;
  if (retryAt != null && retryAt > input.now) {
    return {
      allow: false,
      retryAt,
      reason: `no active agent work, but the failed restart retries in ${duration(retryAt - input.now)}`,
    };
  }
  return { allow: true, reason: "no active agent work remains" };
}

export interface RestartRequester {
  at: number;
  /** Who asked, e.g. "implementor · restart drain" or "owner update". */
  label: string | null;
  /** The commit staged into `dist`, when known. */
  commit: string | null;
  /** The dist stamp identifies the exact build even when several builds share one commit. */
  stampedAt: number | null;
}

/** One restart owed after the current work cohort drains. */
export interface PendingRestart {
  createdAt: number;
  requesters: RestartRequester[];
  /** Consecutive restart attempts that returned without bouncing the process. */
  failures: number;
  /** Null during a normal agent drain; populated only for a refused-attempt backoff. */
  retryAt: number | null;
}

export interface RestartCoordinatorStatus {
  now: number;
  activeWork: number;
  decision: RestartDecision;
  pending: PendingRestart | null;
  /** Human-ready because the CommonJS deploy script cannot import this TypeScript formatter. */
  pendingLabel: string | null;
  draining: boolean;
}

export interface RestartRequestResult {
  /** `restarting` means the bounce is committed; `deferred` means current agents finish first. */
  outcome: "restarting" | "deferred";
  reason: string;
  activeWork: number;
  /** Non-null only for a retry backoff. A normal drain has no guessed completion time. */
  readyAt: number | null;
  readyAtLabel: string | null;
  waitMs: number;
  waitLabel: string;
  /** How many staged builds the coming bounce carries, including this requester. */
  staged: number;
}

export interface RestartCoordinatorDeps {
  db: Db;
  hub: EventHub;
  /** Current top-level task, Co-worker, Director, and Supervisor work. */
  activeWork: () => number;
  /** Poll is a crash/race backstop; release paths can also call `workChanged()` for an immediate check. */
  pollMs?: number;
  /** Lets the HTTP response flush before a process supervisor kills the tree. */
  settleMs?: number;
  restart?: () => Promise<RestartAttempt>;
  /** The build loaded by this process, used to discard a pending restart another bounce already paid. */
  liveBuild?: () => { at: number | null } | null;
  /** Called whenever the admission lock opens — a moot drain, or a restart mechanism that keeps
   *  refusing — so queued work may start on this process. */
  onDrainReleased?: () => void;
}

const PENDING_KEY = "restart_coordinator_pending";
/** Read once during upgrade so a build staged by the removed rate limiter is not lost. */
const LEGACY_PENDING_KEY = "deploy_gate_pending";
const MAX_REQUESTERS = 20;
const RETRY_BASE_MS = 5 * 60_000;
const RETRY_MAX_MS = 30 * 60_000;
/**
 * Consecutive refused restarts after which the coordinator alerts the owner AND stops holding fresh work
 * out *between* retry attempts.
 *
 * A restart mechanism that has refused this many times is broken rather than busy — an elevated :4317
 * listener (see CLAUDE.md), a dead script-hub, no supervisor at all — and it can stay broken until a
 * human intervenes. Holding the admission lock through that freezes the whole console: no dispatch, no
 * resume, no Auto-review, no Director or Co-work turn, including the agent that would repair it.
 *
 * So past this count the lock releases during the backoff and closes again the moment the next attempt is
 * due, which still lets the board drain for that attempt. The staged builds are kept either way, and a
 * restart still only fires at zero active work — no agent is interrupted in any of these states.
 */
const FAILURES_BEFORE_ALERT = 3;

export class RestartCoordinator {
  private readonly db: Db;
  private readonly hub: EventHub;
  private readonly activeWork: () => number;
  private readonly pollMs: number;
  private readonly settleMs: number;
  private readonly restart: () => Promise<RestartAttempt>;
  private readonly liveBuild: () => { at: number | null } | null;
  private readonly onDrainReleased: () => void;
  private timer: NodeJS.Timeout | null = null;
  /** True from the synchronous decision through the supervisor call, closing the zero-work launch race. */
  private firing = false;
  /** Kept in memory after the durable row is claimed so a refused fire can restore every requester. */
  private inFlight: PendingRestart | null = null;

  constructor(deps: RestartCoordinatorDeps) {
    this.db = deps.db;
    this.hub = deps.hub;
    this.activeWork = deps.activeWork;
    this.pollMs = Math.max(25, deps.pollMs ?? 1_000);
    this.settleMs = Math.max(0, deps.settleMs ?? 800);
    this.restart = deps.restart ?? restartSelf;
    this.liveBuild = deps.liveBuild ?? (() => null);
    this.onDrainReleased = deps.onDrainReleased ?? (() => {});
  }

  /** Re-arm a drain/retry the previous process recorded. */
  start(): void {
    const pending = this.pending();
    if (!pending) return;
    if (this.alreadyLive(pending)) {
      this.clearPending();
      this.hub.log("info", "restart coordinator: staged build is already live — cancelling the moot restart");
      this.onDrainReleased();
      return;
    }
    const now = Date.now();
    const active = this.countActive();
    const decision = decideRestart({ activeWork: active, now, retryAt: pending.retryAt });
    this.hub.log(
      "info",
      !holdsAdmission(pending, now)
        ? `restart coordinator: ${pending.requesters.length} staged build(s) retry at ${clock(pending.retryAt!)}; fresh work may start meanwhile`
        : active > 0
        ? `restart coordinator: ${pending.requesters.length} staged build(s) waiting for ${countWork(active)} to finish`
        : decision.allow
          ? `restart coordinator: ${pending.requesters.length} staged build(s) are ready to restart`
          : `restart coordinator: ${pending.requesters.length} staged build(s) retry at ${clock(decision.retryAt!)}`,
    );
    if (!holdsAdmission(pending, now)) this.onDrainReleased();
    this.arm();
  }

  stop(): void {
    this.clearTimer();
  }

  /** Admission lock shared by every agent entry point. It remains true through the settle delay. */
  isDraining(): boolean {
    if (this.firing) return true;
    try {
      const pending = this.pending();
      return pending !== null && holdsAdmission(pending, Date.now());
    } catch {
      // Losing the coordination read must never become permission to launch into a possible restart.
      return true;
    }
  }

  /**
   * True while any coordinated restart is owed, even if the admission latch has temporarily reopened
   * between repeated refused attempts. UI clients use this to avoid loading a staged web bundle against
   * the old in-memory server API before the pending bounce has landed.
   */
  hasPendingRestart(): boolean {
    if (this.firing) return true;
    try {
      return this.pending() !== null;
    } catch {
      // Losing the coordination read must never become permission for a client to switch bundles.
      return true;
    }
  }

  /** Release paths call this to avoid waiting for the fallback poll interval. */
  workChanged(): void {
    if (!this.isDraining() || this.firing) return;
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, 0);
    this.timer.unref?.();
  }

  status(): RestartCoordinatorStatus {
    const now = Date.now();
    const activeWork = this.countActive();
    const pending = this.pending();
    const decision = decideRestart({ activeWork, now, retryAt: pending?.retryAt });
    return {
      now,
      activeWork,
      decision,
      pending,
      pendingLabel: pending ? pendingStatus(decision, activeWork, now) : null,
      draining: this.firing || (pending !== null && holdsAdmission(pending, now)),
    };
  }

  /** Stage one build and either restart now or own the durable wait until current agents finish. */
  request(input: { label?: string | null; commit?: string | null; stampedAt?: number | null } = {}): RestartRequestResult {
    const now = Date.now();
    const requester: RestartRequester = {
      at: now,
      label: trimOrNull(input.label, 200),
      commit: trimOrNull(input.commit, 60),
      stampedAt: Number.isFinite(input.stampedAt) ? Number(input.stampedAt) : null,
    };

    if (this.firing) {
      const carried = this.inFlight ?? emptyPending(now);
      this.inFlight = appendRequester(carried, requester);
      return this.result("restarting", "a restart is already in flight", null, this.countActive(), this.inFlight.requesters.length);
    }

    const existing = this.pending();
    const carrying = appendRequester(existing ?? emptyPending(now), requester);
    const activeWork = this.countActive();
    const decision = decideRestart({ activeWork, now, retryAt: carrying.retryAt });
    if (decision.allow) {
      this.beginRestart(`${describe(requester)} — ${decision.reason}`, carrying);
      return this.result("restarting", decision.reason, null, activeWork, carrying.requesters.length);
    }

    this.savePending(carrying);
    if (existing) {
      this.hub.log(
        "info",
        `restart coordinator: ${describe(requester)} staged — it rides the existing drain (${carrying.requesters.length} staged)`,
      );
    } else {
      this.announceDrain(carrying, requester, activeWork, decision);
    }
    this.arm();
    return this.result("deferred", decision.reason, decision.retryAt, activeWork, carrying.requesters.length);
  }

  /** A newer/equal loaded dist proves some other bounce already deployed the newest staged build. */
  private alreadyLive(pending: PendingRestart): boolean {
    const staged = pending.requesters.at(-1)?.stampedAt;
    const live = this.liveBuild()?.at;
    return !!staged && !!live && live >= staged;
  }

  private countActive(): number {
    try {
      const n = this.activeWork();
      return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 1;
    } catch {
      return 1;
    }
  }

  private pending(): PendingRestart | null {
    const current = this.db.kvGet(PENDING_KEY);
    const legacy = current ? null : this.db.kvGet(LEGACY_PENDING_KEY);
    const raw = current || legacy;
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<PendingRestart> & { readyAt?: number };
      const requesters = Array.isArray(parsed.requesters)
        ? parsed.requesters.filter(validRequester).slice(-MAX_REQUESTERS)
        : [];
      if (!requesters.length) return null;
      const failures = Number.isFinite(parsed.failures) ? Math.max(0, Math.floor(Number(parsed.failures))) : 0;
      // Upgrade compatibility: old normal holds carried a rate-limit `readyAt`; discard it. Only an old
      // refused-fire record (`failures > 0`) represented a genuine retry backoff worth preserving.
      const retryAt = Number.isFinite(parsed.retryAt)
        ? Number(parsed.retryAt)
        : failures > 0 && Number.isFinite(parsed.readyAt)
          ? Number(parsed.readyAt)
          : null;
      const pending = {
        createdAt: Number.isFinite(parsed.createdAt) ? Number(parsed.createdAt) : requesters[0]!.at,
        requesters,
        failures,
        retryAt,
      };
      if (legacy) {
        this.db.kvSet(PENDING_KEY, JSON.stringify(pending));
        this.db.kvSet(LEGACY_PENDING_KEY, "");
      }
      return pending;
    } catch {
      return null;
    }
  }

  private savePending(pending: PendingRestart): void {
    this.db.kvSet(PENDING_KEY, JSON.stringify(pending));
  }

  private clearPending(): void {
    this.clearTimer();
    this.db.kvSet(PENDING_KEY, "");
    this.db.kvSet(LEGACY_PENDING_KEY, "");
  }

  private announceDrain(
    pending: PendingRestart,
    requester: RestartRequester,
    activeWork: number,
    decision: Extract<RestartDecision, { allow: false }>,
  ): void {
    this.hub.log("info", `restart coordinator: holding ${describe(requester)} — ${decision.reason}`);
    const message = activeWork > 0
      ? `${countWork(activeWork)} will finish before GGO restarts. Fresh agent starts are paused; ${pending.requesters.length} staged build(s) will ride the restart.`
      : `The prior restart was refused. GGO will retry at ${clock(decision.retryAt!)}; staged builds remain queued.`;
    this.hub.publish({
      type: "notice",
      level: "info",
      title: activeWork > 0 ? "Restart waiting for active agents" : "Restart retry scheduled",
      message,
    });
  }

  private arm(): void {
    this.clearTimer();
    const pending = this.pending();
    if (!pending || this.firing) return;
    const activeWork = this.countActive();
    const decision = decideRestart({ activeWork, now: Date.now(), retryAt: pending.retryAt });
    const wait = decision.allow
      ? 0
      : decision.retryAt == null
        ? this.pollMs
        : Math.min(this.pollMs, Math.max(0, decision.retryAt - Date.now()));
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, wait);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    const pending = this.pending();
    if (!pending || this.firing) return;
    const activeWork = this.countActive();
    const decision = decideRestart({ activeWork, now: Date.now(), retryAt: pending.retryAt });
    if (!decision.allow) {
      this.arm();
      return;
    }
    this.beginRestart(`${pending.requesters.length} staged build(s) — ${decision.reason}`, pending);
  }

  /** Set `firing` before clearing the row so admission never observes an unguarded gap. */
  private beginRestart(why: string, carrying: PendingRestart): void {
    if (this.firing) {
      this.inFlight = this.inFlight ? mergeRequesters(this.inFlight, carrying) : carrying;
      return;
    }
    this.firing = true;
    this.inFlight = carrying;
    this.clearPending();
    this.hub.log("warn", `restart coordinator: restarting GGO — ${why}`);
    setTimeout(() => void this.fire(), this.settleMs).unref?.();
  }

  /** A refused supervisor/hub call restores the drain and retries later; no staged build is lost. */
  private async fire(): Promise<void> {
    const attemptedAt = Date.now();
    let attempt: RestartAttempt;
    try {
      attempt = await this.restart();
    } catch (error) {
      attempt = { route: "none", ok: false, detail: String(error) };
    }
    if (attempt.ok) return;

    const inFlight = this.inFlight ?? emptyPending(attemptedAt);
    const failures = inFlight.failures + 1;
    const retryIn = Math.min(RETRY_BASE_MS * failures, RETRY_MAX_MS);
    const requesters = inFlight.requesters.length
      ? inFlight.requesters
      : [{ at: attemptedAt, label: "restart coordinator", commit: null, stampedAt: null }];
    const pending: PendingRestart = {
      createdAt: inFlight.createdAt,
      requesters,
      failures,
      retryAt: Date.now() + retryIn,
    };
    // Restore the durable admission lock synchronously before exposing `firing=false` to another turn.
    this.savePending(pending);
    this.inFlight = null;
    this.firing = false;
    this.hub.log("error", `restart coordinator: restart did not happen — ${attempt.detail}. Retrying in ${duration(retryIn)}.`);
    if (failures === FAILURES_BEFORE_ALERT) {
      this.hub.publish({
        type: "notice",
        level: "warn",
        title: "Restart refused",
        message: `GGO has ${requesters.length} staged build(s) it cannot deploy: ${attempt.detail}. New agent work runs again meanwhile; the restart retries on its own.`,
      });
    }
    if (!holdsAdmission(pending, Date.now())) {
      // The mechanism is refusing rather than busy. Let queued work start instead of freezing the board
      // on a bounce that is not coming; admission closes again when the next attempt is due.
      this.hub.log("warn", `restart coordinator: ${failures} refused restarts — releasing the hold on fresh work until the next attempt`);
      this.onDrainReleased();
    }
    this.arm();
  }

  private result(
    outcome: "restarting" | "deferred",
    reason: string,
    readyAt: number | null,
    activeWork: number,
    staged: number,
  ): RestartRequestResult {
    const waitMs = readyAt == null ? 0 : Math.max(0, readyAt - Date.now());
    return {
      outcome,
      reason,
      activeWork,
      readyAt,
      readyAtLabel: readyAt == null ? null : clock(readyAt),
      waitMs,
      waitLabel: readyAt == null ? (activeWork > 0 ? "until active work finishes" : "now") : duration(waitMs),
      staged,
    };
  }
}

function emptyPending(now: number): PendingRestart {
  return { createdAt: now, requesters: [], failures: 0, retryAt: null };
}

function appendRequester(pending: PendingRestart, requester: RestartRequester): PendingRestart {
  return {
    ...pending,
    requesters: [...pending.requesters, requester].slice(-MAX_REQUESTERS),
  };
}

function mergeRequesters(a: PendingRestart, b: PendingRestart): PendingRestart {
  return {
    createdAt: Math.min(a.createdAt, b.createdAt),
    requesters: [...a.requesters, ...b.requesters].slice(-MAX_REQUESTERS),
    failures: Math.max(a.failures, b.failures),
    retryAt: maxNullable(a.retryAt, b.retryAt),
  };
}

function maxNullable(a: number | null, b: number | null): number | null {
  if (a == null) return b;
  if (b == null) return a;
  return Math.max(a, b);
}

function validRequester(value: unknown): value is RestartRequester {
  if (!value || typeof value !== "object") return false;
  const requester = value as Partial<RestartRequester>;
  return Number.isFinite(requester.at);
}

function pendingStatus(decision: RestartDecision, activeWork: number, now: number): string {
  if (activeWork > 0) return `waiting for ${countWork(activeWork)} to finish`;
  if (!decision.allow && decision.retryAt != null) {
    return `${clock(decision.retryAt)} (retry in ${duration(decision.retryAt - now)})`;
  }
  return "ready to restart";
}

function holdsAdmission(pending: PendingRestart, now: number): boolean {
  if (pending.failures < FAILURES_BEFORE_ALERT) return true;
  if (pending.retryAt == null) return true;
  return pending.retryAt <= now;
}

function countWork(n: number): string {
  return `${n} active work ${n === 1 ? "item" : "items"}`;
}

function describe(requester: RestartRequester): string {
  const commit = requester.commit ? ` (${requester.commit.slice(0, 8)})` : "";
  return `${requester.label ?? "a deploy"}${commit}`;
}

/** "45s" / "12m" / "1h 5m" — short enough for logs and deploy output. */
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function trimOrNull(value: string | null | undefined, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

/** The compatibility endpoint accepts local deploy children without exposing restart scheduling to LAN. */
export function isLoopbackAddress(ip: string | undefined | null): boolean {
  if (!ip) return false;
  const bare = ip.replace(/^::ffff:/, "").replace(/^\[|\]$/g, "");
  return bare === "127.0.0.1" || bare === "::1" || bare.startsWith("127.");
}
