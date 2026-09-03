import type { Db } from "../db/db.js";
import type { EventHub } from "../events.js";
import type { ThreadState } from "../types.js";
import { restartSelf, type RestartAttempt } from "../selfRestart.js";

/**
 * How often an AGENT may bounce this server.
 *
 * Deploying tree-kills the console and every live agent. In-flight tasks auto-resume, so the machine
 * recovers — but the owner does not: mid-thought, the board they were reading goes away and comes back.
 * With several tasks running, each finishing its own patch, that was landing every few minutes.
 *
 * So while the owner is multitasking (`minActiveTasks` or more tasks actually running), agent-initiated
 * restarts collapse to one per `minIntervalMs`. The build is NOT refused — `deploy.cjs` still compiles
 * `dist` exactly as before, and the gate takes ownership of the bounce, firing it itself once the window
 * opens. Several deferred deploys therefore ride one restart, which is the point: the owner is
 * interrupted once an hour instead of once a patch, and nothing ends up un-deployed.
 *
 * The gate is a coordination point, not a security boundary — a local process can always call the hub
 * itself. The owner's own restarts (the update badge, a hand-issued hub restart) are never gated.
 *
 * Standalone over (Db, EventHub) like `notes.ts`/`scheduler.ts`: it never imports ThreadManager, and
 * reaches the board through one `activeTasks` callback.
 */

/** Board states that mean an agent is live on the task — what the owner sees as "a task running".
 *  `queued`/`paused`/`awaiting_*` hold no agent, so bouncing does not interrupt them. */
export const ACTIVE_TASK_STATES: readonly ThreadState[] = ["planning", "researching", "implementing", "qa", "reviewing"];

export interface DeployWindow {
  /** Minimum gap between agent-initiated bounces while the owner is multitasking. 0 disables the gate. */
  minIntervalMs: number;
  /** Running tasks at which a bounce becomes expensive enough to hold. */
  minActiveTasks: number;
}

export interface DeployDecisionInput extends DeployWindow {
  now: number;
  /** The most recent bounce this instance knows about, whoever caused it. */
  lastRestartAt: number;
  activeTasks: number;
}

export type DeployDecision =
  | { allow: true; reason: string }
  | { allow: false; readyAt: number; reason: string };

/**
 * May an agent bounce the server right now?
 *
 * Pure, so the policy is a unit test rather than something only reproducible by running a deploy.
 */
export function decideDeploy(input: DeployDecisionInput): DeployDecision {
  const { now, lastRestartAt, activeTasks, minIntervalMs, minActiveTasks } = input;
  if (minIntervalMs <= 0) return { allow: true, reason: "the deploy gate is off" };
  if (activeTasks < minActiveTasks) {
    return { allow: true, reason: `${countTasks(activeTasks)} running — below the ${minActiveTasks} that holds a bounce` };
  }
  const elapsed = now - lastRestartAt;
  if (elapsed >= minIntervalMs) {
    return { allow: true, reason: `${countTasks(activeTasks)} running, but the last restart was ${duration(elapsed)} ago` };
  }
  // A `lastRestartAt` in the future (a clock step, a hand-edited kv row) must never park deploys for
  // longer than one window — clamp it so the gate always drains.
  const readyAt = elapsed < 0 ? now + minIntervalMs : lastRestartAt + minIntervalMs;
  const ago = elapsed < 0 ? "in the future (clock skew)" : `${duration(elapsed)} ago`;
  return {
    allow: false,
    readyAt,
    reason: `${countTasks(activeTasks)} running and the last restart was ${ago} — one restart per ${duration(minIntervalMs)} while multitasking`,
  };
}

export interface DeployRequester {
  at: number;
  /** Who asked, e.g. "implementor · Limit GGO restarts". Free text from the deploy script. */
  label: string | null;
  /** The commit they staged into `dist`, when they knew one. */
  commit: string | null;
  /** When that `dist` was stamped — the only thing that identifies a build exactly (see `alreadyLive`). */
  stampedAt: number | null;
}

/** The bounce the gate owes the owner: one restart that carries every build staged since it was made. */
export interface PendingRestart {
  /** Earliest instant the gate may fire. Recomputed whenever the window moves under it. */
  readyAt: number;
  createdAt: number;
  requesters: DeployRequester[];
  /** Consecutive fire attempts that answered but bounced nothing (an elevated listener). */
  failures: number;
}

export interface DeployGateStatus extends DeployWindow {
  now: number;
  activeTasks: number;
  lastRestartAt: number;
  bootedAt: number;
  decision: DeployDecision;
  pending: PendingRestart | null;
  /** "14:20 (in 47m)" for the held restart — preformatted for the same reason as `readyAtLabel`. */
  pendingLabel: string | null;
}

export interface DeployRequestResult {
  /** `restarting` — the bounce is in flight. `deferred` — staged; the gate fires it at `readyAt`. */
  outcome: "restarting" | "deferred";
  reason: string;
  readyAt: number | null;
  waitMs: number;
  /** Preformatted for the caller's console. The deploy script is a `.cjs` and cannot import this
   *  module, so the wording lives here rather than being re-invented (and drifting) there. */
  readyAtLabel: string | null;
  waitLabel: string;
  activeTasks: number;
  minIntervalMs: number;
  minActiveTasks: number;
  /** How many staged builds the coming bounce carries, this requester included. */
  staged: number;
}

export interface DeployGateDeps {
  db: Db;
  hub: EventHub;
  /** How many tasks the owner currently has running. */
  activeTasks: () => number;
  window?: Partial<DeployWindow>;
  /** How often a pending restart re-checks its window — it can open EARLY when the board quiets down. */
  pollMs?: number;
  /** Delay between accepting a request and bouncing, so the HTTP reply flushes before we are killed. */
  settleMs?: number;
  /** How long after boot the board is still settling (interrupted tasks not yet auto-resumed). */
  bootGraceMs?: number;
  /** Injected so a gate test can observe the bounce without owning a real process supervisor. */
  restart?: () => Promise<RestartAttempt>;
  /** Overridable so a test can place this process's boot wherever it needs it. */
  bootedAt?: number;
  /** The `dist` stamp THIS process loaded, so a held restart whose build some other bounce already
   *  deployed can be dropped instead of costing the owner an interruption for nothing. */
  liveBuild?: () => { at: number | null } | null;
}

const LAST_RESTART_KEY = "deploy_gate_last_restart_at";
const PENDING_KEY = "deploy_gate_pending";
/** Bound on the kv row: a busy hour stages a handful of builds, not hundreds. */
const MAX_REQUESTERS = 20;
/** A refused fire (elevated listener) is retried on a backoff rather than spun on. */
const RETRY_BASE_MS = 5 * 60_000;
const RETRY_MAX_MS = 30 * 60_000;
/** Consecutive failures before the owner is told the hub cannot kill the listener. */
const FAILURES_BEFORE_ALERT = 3;

/** When this process started. Every bounce interrupts the owner, whoever caused it — so a crash-respawn
 *  or a hand-issued restart starts the window just as an agent's deploy does. */
const BOOTED_AT = Date.now() - Math.round(process.uptime() * 1000);

export class DeployGate {
  private readonly db: Db;
  private readonly hub: EventHub;
  private readonly activeTasks: () => number;
  private readonly window: DeployWindow;
  private readonly pollMs: number;
  private readonly settleMs: number;
  private readonly bootGraceMs: number;
  private readonly restart: () => Promise<RestartAttempt>;
  private readonly bootedAt: number;
  /** Monotonic deadline: a wall-clock correction must not turn one minute of boot grace into hours. */
  private readonly bootGraceEndsAt: number;
  private readonly liveBuild: () => { at: number | null } | null;
  private timer: NodeJS.Timeout | null = null;
  /** Set once a bounce is committed to, so requests arriving inside the settle delay join it rather
   *  than scheduling a second one. */
  private firing = false;
  /** What the committed-to bounce is carrying. Held in memory rather than kv precisely because the kv
   *  row is cleared when the window is claimed — a REFUSED fire re-arms from this. */
  private inFlight: PendingRestart | null = null;
  /** Stable replacement for a restart timestamp that lies in the future after a wall-clock step.
   *  Without this latch, recomputing `now + window` on every poll slides forever and never drains. */
  private clockSkew: { observedRestartAt: number; effectiveRestartAt: number } | null = null;

  constructor(deps: DeployGateDeps) {
    this.db = deps.db;
    this.hub = deps.hub;
    this.activeTasks = deps.activeTasks;
    this.window = {
      minIntervalMs: Math.max(0, deps.window?.minIntervalMs ?? 3_600_000),
      minActiveTasks: Math.max(1, deps.window?.minActiveTasks ?? 2),
    };
    this.pollMs = Math.max(1_000, deps.pollMs ?? 30_000);
    this.settleMs = Math.max(0, deps.settleMs ?? 800);
    this.bootGraceMs = Math.max(0, deps.bootGraceMs ?? 60_000);
    this.restart = deps.restart ?? restartSelf;
    this.bootedAt = deps.bootedAt ?? BOOTED_AT;
    const bootAgeMs = Math.max(0, Date.now() - this.bootedAt);
    this.bootGraceEndsAt = performance.now() + Math.max(0, this.bootGraceMs - bootAgeMs);
    this.liveBuild = deps.liveBuild ?? (() => null);
  }

  /** Re-arm a restart the previous process owed. The record is durable precisely because the thing it
   *  is waiting for — a bounce — destroys any in-memory timer holding it. */
  start(): void {
    const pending = this.pending();
    if (!pending) return;
    if (this.alreadyLive(pending)) {
      this.clearPending();
      this.hub.log("info", `deploy gate: the held restart is moot — this process already runs the build it was staging`);
      return;
    }
    this.hub.log(
      "info",
      `deploy gate: ${pending.requesters.length} staged build(s) still owe a restart — holding it until ${clock(pending.readyAt)}`,
    );
    this.arm();
  }

  /**
   * Is the bounce we owe already paid for?
   *
   * Any restart deploys whatever `dist` holds, so a crash-respawn, a keepAlive bounce or the owner's
   * own update click can land a staged build for free. Firing the held restart afterwards would spend
   * an interruption on code that is already running — exactly what this gate exists to prevent.
   *
   * Judged on the `dist` STAMP TIME, not the commit: a docs-only commit, two dirty builds of one HEAD,
   * or a rebuild of the same sha all share a commit id while holding different code, and getting this
   * wrong the optimistic way silently strands a build nobody will deploy again. A process that loaded
   * a `dist` stamped no earlier than the staged one is running that code, whatever it is called.
   *
   * Judged on the NEWEST requester only: each deploy overwrites `dist` wholesale, so if the last one is
   * live, every earlier one it superseded is too. An unstamped build is never assumed live.
   */
  private alreadyLive(pending: PendingRestart): boolean {
    const staged = pending.requesters.at(-1)?.stampedAt;
    const live = this.liveBuild()?.at;
    return !!staged && !!live && live >= staged;
  }

  stop(): void {
    this.clearTimer();
  }

  status(): DeployGateStatus {
    const now = Date.now();
    const activeTasks = this.countActive();
    const pending = this.pending();
    const lastRestartAt = this.lastRestartAt(now);
    return {
      pending,
      pendingLabel: pending ? `${clock(pending.readyAt)} (in ${duration(Math.max(0, pending.readyAt - now))})` : null,
      now,
      activeTasks,
      lastRestartAt,
      bootedAt: this.bootedAt,
      minIntervalMs: this.window.minIntervalMs,
      minActiveTasks: this.window.minActiveTasks,
      decision: decideDeploy({ now, activeTasks, lastRestartAt, ...this.window }),
    };
  }

  /**
   * A deploying agent asking to bounce the server it has just rebuilt.
   *
   * Never refuses: either the restart happens now, or the gate takes it over and fires it when the
   * window opens. The caller's build is live either way — the only question is when.
   */
  request(input: { label?: string | null; commit?: string | null; stampedAt?: number | null } = {}): DeployRequestResult {
    const now = Date.now();
    const activeTasks = this.countActive();
    const decision = this.decide(now, activeTasks);
    const requester: DeployRequester = {
      at: now,
      label: trimOrNull(input.label, 200),
      commit: trimOrNull(input.commit, 60),
      stampedAt: Number.isFinite(input.stampedAt) ? Number(input.stampedAt) : null,
    };

    if (decision.allow) {
      // One bounce serves everything staged so far, including anything that was still waiting — and the
      // combined list is carried into the fire, so a refused restart re-arms with all of them intact.
      const held = this.pending();
      const carried: PendingRestart = {
        readyAt: now,
        createdAt: held?.createdAt ?? now,
        requesters: [...(held?.requesters ?? []), requester].slice(-MAX_REQUESTERS),
        failures: held?.failures ?? 0,
      };
      this.clearPending();
      this.beginRestart(`${describe(requester)} — ${decision.reason}`, carried);
      return this.result("restarting", decision.reason, null, activeTasks, carried.requesters.length);
    }

    const pending = this.mergePending(requester, decision.readyAt, now);
    this.arm();
    return this.result("deferred", decision.reason, pending.readyAt, activeTasks, pending.requesters.length);
  }

  // ---- the window ----

  private decide(now: number, activeTasks = this.countActive()): DeployDecision {
    return decideDeploy({ now, activeTasks, lastRestartAt: this.lastRestartAt(now), ...this.window });
  }

  private countActive(): number {
    try {
      return this.activeTasks();
    } catch {
      // A board we cannot read must not become a licence to bounce; assume the owner is multitasking.
      return this.window.minActiveTasks;
    }
  }

  /** The most recent bounce we know of: the one the gate authorized, or this process starting up. */
  private lastRestartAt(now: number): number {
    const observedRestartAt = Math.max(this.storedRestartAt(), this.bootedAt);
    if (this.clockSkew?.observedRestartAt === observedRestartAt) return this.clockSkew.effectiveRestartAt;
    if (observedRestartAt > now) {
      // Anchor the bad timestamp ONCE. Returning `now` afresh on every poll would keep making the
      // deadline `now + minIntervalMs`, turning a safety window into a permanent deploy freeze.
      this.clockSkew = { observedRestartAt, effectiveRestartAt: now };
      return now;
    }
    this.clockSkew = null;
    return observedRestartAt;
  }

  private storedRestartAt(): number {
    const raw = Number(this.db.kvGet(LAST_RESTART_KEY));
    return Number.isFinite(raw) ? raw : 0;
  }

  // ---- the pending restart ----

  private pending(): PendingRestart | null {
    const raw = this.db.kvGet(PENDING_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<PendingRestart>;
      const requesters = Array.isArray(parsed.requesters) ? (parsed.requesters as DeployRequester[]) : [];
      if (!Number.isFinite(parsed.readyAt)) return null;
      return {
        readyAt: Number(parsed.readyAt),
        createdAt: Number.isFinite(parsed.createdAt) ? Number(parsed.createdAt) : Number(parsed.readyAt),
        requesters,
        failures: Number.isFinite(parsed.failures) ? Number(parsed.failures) : 0,
      };
    } catch {
      // Unreadable metadata must not strand the bounce it represents — treat it as none and let the
      // next request rebuild it.
      return null;
    }
  }

  private savePending(p: PendingRestart): void {
    this.db.kvSet(PENDING_KEY, JSON.stringify(p));
  }

  private clearPending(): void {
    this.clearTimer();
    this.db.kvSet(PENDING_KEY, "");
  }

  /** Fold a newly-deferred requester into the pending bounce, creating it if this is the first. */
  private mergePending(requester: DeployRequester, readyAt: number, now: number): PendingRestart {
    const existing = this.pending();
    if (!existing) {
      const created: PendingRestart = { readyAt, createdAt: now, requesters: [requester], failures: 0 };
      this.savePending(created);
      this.announceHold(created, requester);
      return created;
    }
    const merged: PendingRestart = {
      ...existing,
      // The earliest legal moment wins: a later arrival must not push the queue further out.
      readyAt: Math.min(existing.readyAt, readyAt),
      requesters: [...existing.requesters, requester].slice(-MAX_REQUESTERS),
    };
    this.savePending(merged);
    this.hub.log(
      "info",
      `deploy gate: ${describe(requester)} staged — it rides the restart already held for ${clock(merged.readyAt)} (${merged.requesters.length} staged)`,
    );
    return merged;
  }

  private announceHold(pending: PendingRestart, requester: DeployRequester): void {
    const wait = duration(Math.max(0, pending.readyAt - Date.now()));
    this.hub.log("info", `deploy gate: holding ${describe(requester)}'s restart for ${wait} (until ${clock(pending.readyAt)})`);
    this.hub.publish({
      type: "notice",
      level: "info",
      title: "Restart held",
      message: `${this.countActive()} tasks are running, so the orchestrator won't bounce again for ${wait}. The rebuilt server goes live at ${clock(pending.readyAt)}; anything else deployed before then rides the same restart.`,
    });
  }

  // ---- firing ----

  private arm(): void {
    this.clearTimer();
    const pending = this.pending();
    if (!pending || this.firing) return;
    // Capped at pollMs so the window can also open EARLY — the board dropping below the multitasking
    // threshold makes a bounce cheap again, which is the whole reason the limit exists.
    //
    // Floored at the boot grace, because a board read seconds after a restart is not the board: the
    // manager's own reconcile has just moved every interrupted task out of a running state and the
    // auto-resume that puts them back is on a timer. Firing into that window would read "quiet", bounce,
    // and kill the very resume it was waiting for.
    const wait = Math.max(0, Math.min(pending.readyAt - Date.now(), this.pollMs), this.bootGraceEndsAt - performance.now());
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
    const decision = this.decide(Date.now());
    if (!decision.allow) {
      // Something else bounced under us, or the board is still busy: move the window and keep waiting.
      if (decision.readyAt > pending.readyAt) this.savePending({ ...pending, readyAt: decision.readyAt });
      this.arm();
      return;
    }
    this.clearPending();
    this.beginRestart(`${pending.requesters.length} staged build(s) — ${decision.reason}`, pending);
  }

  /** Commit to a bounce: claim the window, then fire once the caller's reply has flushed. */
  private beginRestart(why: string, carrying: PendingRestart): void {
    if (this.firing) {
      // A bounce is already committed to and will deploy this build too (they share one `dist`). Fold
      // the requester in anyway, so a REFUSED fire re-arms holding every staged build rather than only
      // those that arrived before the settle delay started.
      this.inFlight = this.inFlight ? mergeRequesters(this.inFlight, carrying) : carrying;
      return;
    }
    this.firing = true;
    this.inFlight = carrying;
    this.clearTimer();
    this.hub.log("warn", `deploy gate: restarting the orchestrator — ${why}`);
    setTimeout(() => void this.fire(), this.settleMs).unref?.();
  }

  /**
   * Bounce, and survive being wrong about it.
   *
   * The window is claimed BEFORE the restart, because a successful one kills this process mid-call and
   * the next boot has to see it. Reaching the code after `restart()` therefore means the bounce did not
   * land (the hub cannot kill an elevated listener), so the claim is rolled back and the pending
   * restart re-armed — otherwise one refused fire would cost the owner a whole silent window.
   */
  private async fire(): Promise<void> {
    const claimed = Date.now();
    const previous = this.storedRestartAt();
    this.db.kvSet(LAST_RESTART_KEY, String(claimed));

    let attempt: RestartAttempt;
    try {
      attempt = await this.restart();
    } catch (e) {
      attempt = { route: "none", ok: false, detail: String(e) };
    }
    if (attempt.ok) {
      // The hub accepted it and we are somehow still alive; the kill is in flight, so leave the claim
      // standing and stay `firing` — a second bounce scheduled into a dying process helps nobody.
      return;
    }

    const pending = this.inFlight;
    this.firing = false;
    this.inFlight = null;
    this.db.kvSet(LAST_RESTART_KEY, String(previous));
    const failures = (pending?.failures ?? 0) + 1;
    const retryIn = Math.min(RETRY_BASE_MS * failures, RETRY_MAX_MS);
    const requesters = pending?.requesters ?? [{ at: claimed, label: "the deploy gate", commit: null, stampedAt: null }];
    this.savePending({
      readyAt: Date.now() + retryIn,
      createdAt: pending?.createdAt ?? claimed,
      requesters,
      failures,
    });
    this.hub.log("error", `deploy gate: the restart did not happen — ${attempt.detail}. Retrying in ${duration(retryIn)}.`);
    if (failures === FAILURES_BEFORE_ALERT) {
      this.hub.publish({
        type: "notice",
        level: "warn",
        title: "Restart refused",
        message: `The orchestrator has ${requesters.length} staged build(s) it cannot deploy: ${attempt.detail}`,
      });
    }
    this.arm();
  }

  private result(
    outcome: "restarting" | "deferred",
    reason: string,
    readyAt: number | null,
    activeTasks: number,
    staged: number,
  ): DeployRequestResult {
    const waitMs = readyAt === null ? 0 : Math.max(0, readyAt - Date.now());
    return {
      outcome,
      reason,
      readyAt,
      waitMs,
      readyAtLabel: readyAt === null ? null : clock(readyAt),
      waitLabel: duration(waitMs),
      activeTasks,
      minIntervalMs: this.window.minIntervalMs,
      minActiveTasks: this.window.minActiveTasks,
      staged,
    };
  }
}

// ---- formatting (shared by the gate's own log lines and the deploy script's output) ----

function countTasks(n: number): string {
  return `${n} task${n === 1 ? "" : "s"}`;
}

/** Fold two staged sets into one bounce, keeping the older creation time and the earlier deadline. */
function mergeRequesters(a: PendingRestart, b: PendingRestart): PendingRestart {
  return {
    readyAt: Math.min(a.readyAt, b.readyAt),
    createdAt: Math.min(a.createdAt, b.createdAt),
    requesters: [...a.requesters, ...b.requesters].slice(-MAX_REQUESTERS),
    failures: Math.max(a.failures, b.failures),
  };
}

/**
 * Is this request from a process on this machine?
 *
 * The deploy gate's routes answer a local child process (`npm run deploy`) that holds no session
 * cookie. Loopback is the right boundary because it is not a privilege boundary at all: any local
 * process can already POST the script-hub's own restart. What it must exclude is the LAN — this
 * console is reachable on the network, and a restart is not something a passer-by gets to schedule.
 */
export function isLoopbackAddress(ip: string | undefined | null): boolean {
  if (!ip) return false;
  const bare = ip.replace(/^::ffff:/, "").replace(/^\[|\]$/g, "");
  return bare === "127.0.0.1" || bare === "::1" || bare.startsWith("127.");
}

function describe(r: DeployRequester): string {
  const commit = r.commit ? ` (${r.commit.slice(0, 8)})` : "";
  return `${r.label ?? "an agent"}${commit}`;
}

/** "45s" / "12m" / "1h 5m" — short enough for a log line and a banner alike. */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h}h ${rest}m` : `${h}h`;
}

/** Local wall-clock "14:20" — the owner reads a schedule, not an epoch. */
export function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function trimOrNull(v: string | null | undefined, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}
