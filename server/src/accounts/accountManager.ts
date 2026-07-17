import type { EventHub } from "../events.js";
import { fallbackModelFor } from "../config.js";
import type { RateLimitInfo } from "../types.js";
import type { AccountDTO } from "../ws/protocol.js";
import type { Account } from "./account.js";
import { pingUsage, type PingFailReason, type PingUsage } from "./usagePing.js";
import { ResetStagger, WINDOW_MS } from "./resetStagger.js";
import { logCrash } from "../crashLog.js";

interface AccountState {
  account: Account;
  fiveHour: number | null; // utilization 0-100
  sevenDay: number | null; // overall weekly utilization 0-100
  fiveHourReset: number | null; // epoch ms
  sevenDayReset: number | null; // epoch ms
  usageAt: number; // when usage was last read
  usageStale: boolean; // last ping failed and the value is getting old
  error: string | null; // short, actionable reason the last ping had no usable read (null = OK)
  rateLimited: boolean;
  rateLimitWindow: string | null;
  rateLimitResetAt: number | null;
  enabled: boolean; // operator toggle — a disabled account is held out of dispatch/failover rotation
  lastPick: number; // monotonic selection sequence — round-robin tiebreak
  holdUntil: number | null; // stagger hold-off: the 5h window is idle and its start ping waits for this slot
  extWakeAt: number | null; // last time a hold-release ping found the window ALREADY started by someone else
  // Model-scoped pool caps (Fable's separately-gated allowance): model id → reset epoch. While latched,
  // dispatch on this account falls back to the model's stand-in (fallbackModelFor) instead of parking —
  // the account's NORMAL windows still have headroom, so the account itself stays in rotation.
  modelLimits: Map<string, number>;
  updatedAt: number;
}

/** The last real usage read, persisted (kv) so a restart doesn't have to ping every account at boot —
 *  which would start all their 5h windows in sync and undo the stagger on every deploy. */
export interface PersistedAccountUsage {
  fiveHour: number | null;
  sevenDay: number | null;
  fiveHourReset: number | null;
  sevenDayReset: number | null;
  usageAt: number;
  holdUntil?: number | null;
  extWakeAt?: number | null;
  modelLimits?: Record<string, number>;
}

export interface AccountUsagePersistence {
  load(accountId: string): PersistedAccountUsage | null;
  save(accountId: string, usage: PersistedAccountUsage): void;
}

export interface AccountDispatchPreview {
  account: Account;
  hasHeadroom: boolean;
  fiveHour: number | null;
  sevenDay: number | null;
  fiveHourReset: number | null;
  sevenDayReset: number | null;
}

// At/above this on the tightest window, treat the account as effectively capped.
const HARD_LIMIT = 98;
const STALE_MS = 20 * 60 * 1000; // a value older than this (ping failing) shows "stale"
const RESET_BUFFER_MS = 3_000; // ping this long after a window reset to catch the rollover
const MIN_RESET_DELAY_MS = 1_000;
// ---- 5h window-start staggering ----
// Any /v1/messages request — including our own usage pings — STARTS a new 5h window when none is
// running, so pinging every account right at its reset keeps all subscriptions phase-locked: they
// cap together and reset together. Instead an idle window is only restarted at the slot the shared
// ResetStagger computes from every OTHER participant's live reset phase (Claude subs + Codex), so
// resets spread out and re-converge even when outside traffic moves some window's phase.
// If the hold would be shorter than this, just ping at the reset — a sub-minute stagger isn't worth
// the synthesized-idle bookkeeping.
const MIN_HOLD_MS = 60_000;
// A hold-release ping that finds the window started this much before the ping was sent proves an
// OUTSIDE consumer (the operator's own sessions, a background service pinging the sub) woke the account
// while we held it idle. Generous enough to absorb ping latency and modest clock skew.
const EXT_WAKE_TOLERANCE_MS = 120_000;
// An externally-woken account skips stagger holds for this long: we can't place its phase anyway,
// and a hold would blind us (and dispatch decisions) to the burn the outside consumer keeps adding.
// After it lapses, one probing hold re-tests whether the outside consumer is still there.
const EXT_WAKE_TTL_MS = 24 * 3_600_000;
// Persisted usage older than this isn't trusted to skip the boot ping (the operator's own interactive
// sessions may have burned the account while we were down) — unless a persisted holdUntil proves the
// account was deliberately idle.
const BOOT_TRUST_MS = 30 * 60 * 1000;
// A model-pool cap whose rejection carried no reset self-expires after this, so the fallback never
// sticks forever — the next dispatch simply re-probes the model and re-latches if it's still gated.
const MODEL_LIMIT_FALLBACK_MS = 5 * 60 * 60 * 1000;

const tightest = (s: AccountState): number => Math.max(s.fiveHour ?? 0, s.sevenDay ?? 0);
const weeklyHeadroom = (s: AccountState): number => 100 - (s.sevenDay ?? 0);
const fiveHeadroom = (s: AccountState): number => 100 - (s.fiveHour ?? 0);
const hasBurnData = (s: AccountState): boolean => s.fiveHour != null || s.sevenDay != null;
// When a weekly reset is unknown (pre-ping) it sorts last, so a known soon reset wins and accounts
// with no data yet fall through to the round-robin tiebreak.
const weeklyResetAt = (s: AccountState): number => s.sevenDayReset ?? Number.POSITIVE_INFINITY;

/**
 * Selection order — burn the "perishable" weekly allowance first: prefer the account whose WEEKLY
 * window resets **soonest**, and keep the one with days of runway in reserve for when the soonest is
 * capped. A capped/near-limit account is filtered out of the pool before this runs, so we ride the
 * soonest-reset sub until it hits its 5h (or weekly) cap, switch to the other, and — once the first
 * account's window resets (its reset-ping clears the cap and pushes its weekly reset ~7d out) — the
 * other becomes the soonest-resetting one and naturally takes over, or the first is preferred again.
 * Ties / no reset data → more weekly headroom, then 5h headroom, then least-recently-selected.
 */
const bySelectionPriority = (x: AccountState, y: AccountState): number =>
  weeklyResetAt(x) - weeklyResetAt(y) ||
  weeklyHeadroom(y) - weeklyHeadroom(x) ||
  fiveHeadroom(y) - fiveHeadroom(x) ||
  x.lastPick - y.lastPick;

/**
 * Tracks each subscription's 5h/weekly burn and routes dispatches to spend the
 * "perishable" weekly allowance first — the sub whose weekly window resets soonest
 * — holding the long-runway one in reserve for when the first one caps.
 *
 * Usage comes from a "super tiny" Haiku ping per account (`usagePing.ts`): the
 * /v1/messages response headers carry exact live 5h + weekly utilization for the
 * token's account — works with setup-tokens, which 403 on the /usage endpoint.
 * Pings run on an interval (fresh display) and are also scheduled at each window's
 * reset, which flips the strip to ~0% and starts the new window's timer. Those
 * window-start pings are STAGGERED: each account restarts its idle 5h window only
 * at the slot the shared ResetStagger derives from every other participant's live
 * reset phase (Claude subs + Codex), so the windows reset spread-out instead of
 * all at once — and an account something else keeps waking (a background service) is
 * detected and left unheld, its phase anchoring the rest.
 * `select()` round-robins until burn is known, then **burns the account whose
 * weekly window resets soonest** — spending the "perishable" weekly allowance
 * first and keeping the one with days of runway in reserve — avoiding any that
 * 429-rejected until its reset passes (see `bySelectionPriority`).
 */
export class AccountManager {
  private readonly states = new Map<string, AccountState>();
  private periodic: NodeJS.Timeout | undefined;
  private readonly resetTimers = new Map<string, NodeJS.Timeout>();
  private preferredId: string | undefined;
  private selSeq = 0;
  private readonly persist?: AccountUsagePersistence;
  private readonly stagger?: ResetStagger;
  // Fired right after every usage publish (periodic ping + reset ping), so a consumer can react to a
  // fresh utilization read — drives the token-safety auto-stop in ThreadManager. Set once at construction.
  private onUsage?: () => void;

  constructor(
    private readonly accounts: Account[],
    private readonly hub: EventHub,
    private pingIntervalMs = 600_000, // 10 min (operator can switch to the fast cadence via setPingInterval)
    opts?: { persist?: AccountUsagePersistence; stagger?: ResetStagger },
  ) {
    this.persist = opts?.persist;
    this.stagger = opts?.stagger;
    for (const a of accounts) {
      this.states.set(a.id, {
        account: a,
        fiveHour: null,
        sevenDay: null,
        fiveHourReset: null,
        sevenDayReset: null,
        usageAt: 0,
        usageStale: false,
        error: null,
        rateLimited: false,
        rateLimitWindow: null,
        rateLimitResetAt: null,
        enabled: true,
        lastPick: 0,
        holdUntil: null,
        extWakeAt: null,
        modelLimits: new Map(),
        updatedAt: 0,
      });
      this.stagger?.register(a.id, () => this.phase(a.id));
    }
  }

  start(): void {
    if (!this.accounts.length) return;
    void this.bootPing().catch((e) => logCrash("accountPing.initial", e)); // immediate, so the strip fills within a few seconds
    this.periodic = setInterval(() => void this.pingAll().catch((e) => logCrash("accountPing.periodic", e)), this.pingIntervalMs);
    this.periodic.unref?.();
  }

  stop(): void {
    if (this.periodic) clearInterval(this.periodic);
    for (const t of this.resetTimers.values()) clearTimeout(t);
    this.resetTimers.clear();
  }

  /** Retune the periodic usage-ping cadence live (the "Fast usage polling" setting flips between the
   *  default 10-min interval and a 30s one). A no-op when unchanged; when the interval is already
   *  running it's cleared and re-armed so the new cadence takes effect without a restart. Applied
   *  before start() at boot simply updates the field the first setInterval reads. */
  setPingInterval(ms: number): void {
    if (!Number.isFinite(ms) || ms <= 0 || ms === this.pingIntervalMs) return;
    this.pingIntervalMs = ms;
    if (!this.periodic) return; // not started yet — start() will pick up the new value
    clearInterval(this.periodic);
    this.periodic = setInterval(() => void this.pingAll().catch((e) => logCrash("accountPing.periodic", e)), ms);
    this.periodic.unref?.();
  }

  /** Whether the 5h window-start stagger applies — 2+ participants in the shared coordinator
   *  (Claude subs plus Codex when it's configured). */
  private staggered(): boolean {
    return this.stagger?.enabled() ?? false;
  }

  /** This account's phase input to the shared stagger: the live window's reset, or the armed hold's
   *  planned start (same phase — a window is exactly 5h). Null while idle with no plan. */
  private phase(accountId: string): number | null {
    const st = this.states.get(accountId);
    if (!st) return null;
    const now = Date.now();
    if (st.holdUntil != null && st.holdUntil > now) return st.holdUntil;
    if (st.fiveHourReset != null && st.fiveHourReset > now) return st.fiveHourReset;
    return null;
  }

  private recentExtWake(st: AccountState, now: number): boolean {
    return st.extWakeAt != null && now - st.extWakeAt < EXT_WAKE_TTL_MS;
  }

  /**
   * First read after a (re)start. A plain ping-everyone would START every idle 5h window in the same
   * second — re-syncing all subscriptions on every deploy and undoing the stagger — so accounts whose
   * persisted state shows a deliberately idle window (a live hold, or a recent read with the window
   * expired) restore from the snapshot and wait for their slot instead of pinging. The live accounts
   * ping FIRST so the idle ones are placed around fresh observations, not the stale snapshot.
   */
  private async bootPing(): Promise<void> {
    const now = Date.now();
    const toPing: Account[] = [];
    const toHold: Array<{ a: Account; restoredHold: number | null }> = [];
    for (const a of this.accounts) {
      const st = this.states.get(a.id)!;
      const p = this.persist?.load(a.id) ?? null;
      if (p) {
        st.fiveHour = p.fiveHour;
        st.sevenDay = p.sevenDay;
        st.fiveHourReset = p.fiveHourReset;
        st.sevenDayReset = p.sevenDayReset;
        st.usageAt = p.usageAt;
        st.extWakeAt = p.extWakeAt ?? null;
        st.modelLimits = new Map(Object.entries(p.modelLimits ?? {}).filter(([, r]) => r > now));
        st.updatedAt = now;
      }
      const windowRunning = p?.fiveHourReset != null && p.fiveHourReset > now;
      const heldThrough = p?.holdUntil != null && p.holdUntil > now;
      const recentIdleRead = !windowRunning && p != null && now - p.usageAt < BOOT_TRUST_MS;
      // An externally-woken account never boot-holds: the outside consumer has likely started the
      // window again already, so a restored "idle" would just mask its live burn — read the truth.
      if (this.staggered() && !this.recentExtWake(st, now) && (heldThrough || recentIdleRead)) {
        toHold.push({ a, restoredHold: heldThrough ? p!.holdUntil! : null });
      } else {
        toPing.push(a);
      }
    }
    await Promise.all(toPing.map((a) => this.pingOne(a)));
    for (const { a, restoredHold } of toHold) {
      const st = this.states.get(a.id)!;
      st.fiveHour = 0;
      st.fiveHourReset = null;
      this.armHold(a, restoredHold ?? (this.stagger?.nextStart(a.id, Date.now()) ?? Date.now()));
    }
    this.publish();
    this.onUsage?.();
  }

  private inHold(st: AccountState, now: number): boolean {
    return st.holdUntil != null && st.holdUntil > now;
  }

  private async pingAll(): Promise<void> {
    // Skip held accounts: their 5h window is deliberately idle until their stagger slot, and any ping
    // would start it early. They're usable regardless (utilization 0 post-reset) and a dispatch to one
    // releases the hold (see releaseHold).
    const now = Date.now();
    const due = this.accounts.filter((a) => {
      const st = this.states.get(a.id);
      return !st || !this.inHold(st, now);
    });
    await Promise.all(due.map((a) => this.pingOne(a)));
    this.publish();
    this.onUsage?.();
  }

  /** Tiny Haiku ping → live usage from rate-limit headers; also (re)schedules the reset ping.
   *  Returns the fresh read (null when the ping had no usable one) so classifyCap can judge headroom
   *  from the raw headers. `expectIdle` marks a ping we believed would START the window (a hold
   *  release): finding the window already running then proves an outside consumer woke the account
   *  during the hold. */
  private async pingOne(a: Account, expectIdle = false): Promise<PingUsage | null> {
    const sentAt = Date.now();
    const r = await pingUsage(a.token);
    const st = this.states.get(a.id);
    if (!st) return null;
    const now = Date.now();
    if (!r.ok) {
      // Surface the failure immediately (don't wait 20 min for usageStale): a
      // never-read account would otherwise just show "—" with no clue why.
      const msg = pingErrorMessage(r.reason);
      if (st.error !== msg) {
        st.error = msg;
        st.updatedAt = now;
      }
      if (st.usageAt && now - st.usageAt > STALE_MS && !st.usageStale) {
        st.usageStale = true;
        st.updatedAt = now;
      }
      return null;
    }
    const u = r.usage;
    if (expectIdle && u.fiveHourReset != null && u.fiveHourReset - WINDOW_MS < sentAt - EXT_WAKE_TOLERANCE_MS) {
      st.extWakeAt = now; // window started well before this ping — someone else woke the held account
    }
    st.fiveHour = u.fiveHour;
    st.sevenDay = u.sevenDay;
    st.fiveHourReset = u.fiveHourReset;
    st.sevenDayReset = u.sevenDayReset;
    st.usageAt = now;
    st.usageStale = false;
    st.error = null;
    st.holdUntil = null; // a real read means the window is live (the ping itself starts one) — no hold applies
    this.persist?.save(a.id, {
      fiveHour: u.fiveHour,
      sevenDay: u.sevenDay,
      fiveHourReset: u.fiveHourReset,
      sevenDayReset: u.sevenDayReset,
      usageAt: now,
      holdUntil: null,
      extWakeAt: st.extWakeAt,
      modelLimits: liveModelLimits(st, now),
    });
    // Preserve a run-flagged cap whose reset is still in the future. A per-session ("You've hit your
    // session limit") cap is invisible to these 5h/weekly headers, so a routine ping would otherwise
    // read the windows as clear and wipe the cap — un-freezing the account, which then gets a parked
    // task auto-resumed straight back into the same limit. A header-visible 5h/weekly cap isn't affected:
    // once its window resets, its stored reset is in the past, so this hold lapses and the header truth wins.
    const capHold = st.rateLimited && st.rateLimitResetAt != null && st.rateLimitResetAt > now;
    if (u.fiveHourRejected) {
      st.rateLimited = true;
      st.rateLimitWindow = "five_hour";
      st.rateLimitResetAt = u.fiveHourReset;
    } else if (u.sevenDayRejected) {
      st.rateLimited = true;
      st.rateLimitWindow = "seven_day";
      st.rateLimitResetAt = u.sevenDayReset;
    } else if (capHold) {
      st.rateLimited = true; // keep the existing window/reset — the cap is real but not header-visible yet
    } else {
      st.rateLimited = false;
      st.rateLimitWindow = null;
      st.rateLimitResetAt = null;
    }
    st.updatedAt = now;
    this.scheduleResetEvent(a, u);
    return u;
  }

  /**
   * Schedule the one-shot follow-up for the soonest upcoming window reset. A weekly reset (or any reset
   * without staggering) gets a plain ping just after it — flipping the strip to ~0% and starting the new
   * window's timer immediately. A 5h reset under staggering instead rolls the account into an idle
   * hold-off (see rollover5h) so its next window starts at the account's slot, not in sync with the rest.
   */
  private scheduleResetEvent(a: Account, u: { fiveHourReset: number | null; sevenDayReset: number | null }): void {
    const now = Date.now();
    const five = u.fiveHourReset != null && u.fiveHourReset > now ? u.fiveHourReset : null;
    const seven = u.sevenDayReset != null && u.sevenDayReset > now ? u.sevenDayReset : null;
    const prev = this.resetTimers.get(a.id);
    if (prev) clearTimeout(prev);
    if (five == null && seven == null) return;
    if (five != null && (seven == null || five <= seven)) {
      const delay = Math.max(five - now + RESET_BUFFER_MS, MIN_RESET_DELAY_MS);
      this.armTimer(a, delay, () => this.rollover5h(a, five));
      return;
    }
    const delay = Math.max(seven! - now + RESET_BUFFER_MS, MIN_RESET_DELAY_MS);
    this.armTimer(a, delay, () => this.resetPing(a));
  }

  /** The 5h window just rolled over. Without staggering (or when the slot is effectively now) ping
   *  immediately — starting the next window back-to-back, today's behavior. Staggered, show the truth
   *  instead: the window is idle at 0%, and the start ping waits for this account's slot. */
  private rollover5h(a: Account, resetAt: number): void {
    const st = this.states.get(a.id);
    // An externally-woken account gets no hold: something outside the orchestrator keeps starting its
    // window anyway, so its phase isn't ours to place, and holding it would just hide the burn that
    // consumer adds from dispatch decisions. Ping right at the reset — the others space around it.
    if (st && this.recentExtWake(st, Date.now())) {
      this.resetPing(a);
      return;
    }
    const startAt = this.staggered() ? this.stagger!.nextStart(a.id, resetAt) : resetAt;
    if (startAt - Date.now() < MIN_HOLD_MS) {
      this.resetPing(a);
      return;
    }
    if (st) {
      st.fiveHour = 0;
      st.fiveHourReset = null;
      st.updatedAt = Date.now();
      this.persist?.save(a.id, {
        fiveHour: st.fiveHour,
        sevenDay: st.sevenDay,
        fiveHourReset: null,
        sevenDayReset: st.sevenDayReset,
        usageAt: st.usageAt,
        holdUntil: startAt,
        extWakeAt: st.extWakeAt,
        modelLimits: liveModelLimits(st, Date.now()),
      });
    }
    this.armHold(a, startAt);
    this.publish();
    this.onUsage?.();
  }

  /** Park the account's 5h window as idle until `startAt` (its stagger slot), then fire the start ping. */
  private armHold(a: Account, startAt: number): void {
    const st = this.states.get(a.id);
    if (!st) return;
    st.holdUntil = startAt;
    this.armTimer(a, Math.max(startAt - Date.now(), MIN_RESET_DELAY_MS), () => {
      const s = this.states.get(a.id);
      if (s) s.holdUntil = null;
      this.resetPing(a, true);
    });
  }

  /** Release a held account because a dispatch just chose it — its window is starting anyway (the run's
   *  first request starts it), so ping right away for a fresh read instead of waiting for the slot. */
  private releaseHold(st: AccountState): void {
    if (st.holdUntil == null) return;
    st.holdUntil = null;
    const prev = this.resetTimers.get(st.account.id);
    if (prev) clearTimeout(prev);
    this.resetTimers.delete(st.account.id);
    this.resetPing(st.account, true);
  }

  /** One-shot ping + publish (reset edges, hold releases). pingOne re-schedules the next event itself. */
  private resetPing(a: Account, expectIdle = false): void {
    void this.pingOne(a, expectIdle)
      .then(() => {
        this.publish();
        this.onUsage?.();
      })
      .catch((e) => logCrash("accountPing.reset", e));
  }

  private armTimer(a: Account, delayMs: number, fn: () => void): void {
    const prev = this.resetTimers.get(a.id);
    if (prev) clearTimeout(prev);
    const t = setTimeout(fn, delayMs);
    t.unref?.();
    this.resetTimers.set(a.id, t);
  }

  /** Toggle an account in/out of the dispatch+failover rotation (operator control). Refuses to disable
   *  the LAST enabled account — planner/researcher/QA always need a Claude account — and returns whether
   *  the change applied. Persistence lives in the caller (ThreadManager kv); this is the live state. */
  setEnabled(accountId: string, enabled: boolean): boolean {
    const st = this.states.get(accountId);
    if (!st || st.enabled === enabled) return false;
    if (!enabled && this.enabledCount() <= 1) return false; // never strand the pipeline
    st.enabled = enabled;
    st.updatedAt = Date.now();
    this.publish();
    return true;
  }

  /** Apply a persisted enabled flag on boot WITHOUT the last-account guard or a publish (the initial
   *  dto() broadcast carries the state). A flag for an unknown account id is ignored. */
  applyEnabled(accountId: string, enabled: boolean): void {
    const st = this.states.get(accountId);
    if (st) st.enabled = enabled;
  }

  private enabledCount(): number {
    let n = 0;
    for (const s of this.states.values()) if (s.enabled) n++;
    return n;
  }

  /** Cap signal from a real run's rate_limit_event — flags rateLimited fast mid-burst; pings own the %. */
  updateFromRateLimit(accountId: string, info: RateLimitInfo): void {
    const st = this.states.get(accountId);
    if (!st) return;
    if (info.status === "rejected") {
      st.rateLimited = true;
      st.rateLimitWindow = info.rateLimitType ?? null;
      st.rateLimitResetAt = info.resetsAt ?? null;
    } else if (st.rateLimited && (st.rateLimitWindow == null || st.rateLimitWindow === info.rateLimitType)) {
      st.rateLimited = false;
      st.rateLimitWindow = null;
      st.rateLimitResetAt = null;
    }
    st.updatedAt = Date.now();
    this.publish();
  }

  /**
   * Classify a rejected run's cap: the account's normal 5h/weekly window ("account" → fail over to
   * another subscription), or the run model's OWN separately-metered pool ("model" → the caller retries
   * on the SAME account with the fallback model). A fresh usage ping decides — it rides Haiku, which a
   * model-scoped gate doesn't touch, and its unified headers are ground truth for the normal windows.
   * On "model" the pool cap is latched for `modelFor`-style resolution AND the account-wide flag the
   * event fast-path set (updateFromRateLimit) is lifted, so the account stays in rotation for every
   * other role. An unreadable ping conservatively classifies "account" (today's failover behavior).
   */
  async classifyCap(accountId: string, model: string, info: RateLimitInfo | undefined): Promise<"account" | "model"> {
    const st = this.states.get(accountId);
    if (!st) return "account";
    // pingOne may re-assert the account-wide cap flag via its capHold preservation (the event fast
    // path stored a future resetsAt) — the clear below overrides it once headroom is header-confirmed,
    // so it must stay AFTER this ping.
    const u = await this.pingOne(st.account).catch(() => null);
    const headroom =
      !!u && !u.fiveHourRejected && !u.sevenDayRejected && Math.max(u.fiveHour ?? 0, u.sevenDay ?? 0) < HARD_LIMIT;
    if (!headroom) {
      this.publish();
      return "account";
    }
    this.noteModelLimit(accountId, model, info?.resetsAt);
    st.rateLimited = false; // the fast path flagged the whole account; the fresh headers prove its normal windows are fine
    st.rateLimitWindow = null;
    st.rateLimitResetAt = null;
    st.updatedAt = Date.now();
    this.publish();
    return "model";
  }

  /** Latch `model` as pool-capped on this account until `resetsAt` (its own metered allowance is
   *  exhausted — the account's normal windows are unaffected). A rejection with no reset self-expires
   *  after MODEL_LIMIT_FALLBACK_MS so the fallback never sticks forever. */
  noteModelLimit(accountId: string, model: string, resetsAt?: number | null): void {
    const st = this.states.get(accountId);
    if (!st) return;
    const now = Date.now();
    const until = resetsAt != null && resetsAt > now ? resetsAt : now + MODEL_LIMIT_FALLBACK_MS;
    st.modelLimits = new Map([...st.modelLimits].filter(([, r]) => r > now));
    st.modelLimits.set(model, until);
    st.updatedAt = now;
    this.persist?.save(accountId, {
      fiveHour: st.fiveHour,
      sevenDay: st.sevenDay,
      fiveHourReset: st.fiveHourReset,
      sevenDayReset: st.sevenDayReset,
      usageAt: st.usageAt,
      holdUntil: st.holdUntil,
      extWakeAt: st.extWakeAt,
      modelLimits: liveModelLimits(st, now),
    });
    this.publish();
  }

  /** Is `model` latched as pool-capped on this account (and not yet past its reset)? Expired latches
   *  are pruned on read, so the next dispatch re-probes the model itself. */
  isModelLimited(accountId: string, model: string): boolean {
    const st = this.states.get(accountId);
    const until = st?.modelLimits.get(model);
    if (st == null || until == null) return false;
    if (until <= Date.now()) {
      st.modelLimits.delete(model);
      return false;
    }
    return true;
  }

  /** The configured account with this id (dispatch metadata — id/label/token), or undefined. */
  byId(accountId: string): Account | undefined {
    return this.states.get(accountId)?.account;
  }

  /** Pick the best account for the next dispatch. */
  select(): { account: Account; reason: string } {
    if (this.accounts.length <= 1) {
      // loadAccounts() always yields ≥1 account (a synthetic "logged-in" entry when no tokens are
      // configured), so accounts[0] is always defined — no synthetic fallback needed here.
      const only = this.accounts[0]!;
      this.preferredId = only.id;
      const st = this.states.get(only.id);
      if (st) this.releaseHold(st); // a lone sub can still be held (staggered against Codex) — dispatch starts the window anyway
      return { account: only, reason: "single account" };
    }
    const now = Date.now();
    const { usable, pool } = this.selectionPool(now);
    // Burn the account whose weekly window resets soonest first (see bySelectionPriority).
    pool.sort(bySelectionPriority);
    const chosen = pool[0]!;
    chosen.lastPick = ++this.selSeq;
    this.preferredId = chosen.account.id;
    this.releaseHold(chosen); // dispatch traffic starts the held window anyway — refresh the read now
    this.publish();
    const reason = !usable.length
      ? "all accounts near limit — using the one resetting soonest"
      : pool.some(hasBurnData)
        ? `weekly ${fmt(chosen.sevenDay)} · 5h ${fmt(chosen.fiveHour)} · resets ${untilReset(chosen.sevenDayReset, now)} — soonest weekly reset`
        : "round-robin (no burn data yet)";
    return { account: chosen.account, reason };
  }

  /** Non-mutating view of the account `select()` would choose. Used by provider routing so the
   *  Codex backend competes with Claude subscriptions without bumping round-robin state or the
   *  active account marker before a dispatch is actually committed. */
  dispatchPreview(): AccountDispatchPreview {
    const now = Date.now();
    const { usable, pool } = this.selectionPool(now);
    pool.sort(bySelectionPriority);
    const chosen = pool[0]!;
    return {
      account: chosen.account,
      hasHeadroom: usable.includes(chosen),
      fiveHour: chosen.fiveHour,
      sevenDay: chosen.sevenDay,
      fiveHourReset: chosen.fiveHourReset,
      sevenDayReset: chosen.sevenDayReset,
    };
  }

  /**
   * Pick a usable account OTHER than `excludeId` for mid-task failover — skips any that are
   * cap-rejected or near the hard limit, and never falls back to the excluded account. Returns
   * null when no alternative has headroom (so the caller settles the task to review instead).
   */
  selectFailover(excludeId: string): Account | null {
    if (this.accounts.length <= 1) return null;
    const now = Date.now();
    const candidates = [...this.states.values()].filter((s) => {
      if (s.account.id === excludeId || !s.enabled) return false;
      const limited = s.rateLimited && (s.rateLimitResetAt == null || s.rateLimitResetAt > now);
      return !limited && tightest(s) < HARD_LIMIT;
    });
    if (!candidates.length) return null;
    // Same perishable-first order: the reserve account we fail over to is the next-soonest-resetting one.
    candidates.sort(bySelectionPriority);
    const chosen = candidates[0]!;
    chosen.lastPick = ++this.selSeq;
    this.preferredId = chosen.account.id;
    this.releaseHold(chosen); // dispatch traffic starts the held window anyway — refresh the read now
    this.publish();
    return chosen.account;
  }

  /** A subscription token for an ANCILLARY call (e.g. resume-compression's Haiku summary) — unlike
   *  select(), it does NOT bump round-robin state or change the preferred/"active" account. It DOES
   *  prefer an account whose 5h window is already RUNNING: the call rides the live window without
   *  moving anyone's stagger phase. When only a held/idle account exists its hold is released first —
   *  the call is about to start that window anyway, so the idle plan would become a lie. */
  auxToken(): string | undefined {
    const now = Date.now();
    const states = [...this.states.values()];
    const preferred = this.preferredId ? this.states.get(this.preferredId) : undefined;
    const live = (s: AccountState | undefined): boolean =>
      !!s?.account.token && s.fiveHourReset != null && s.fiveHourReset > now && !this.inHold(s, now);
    const pick = (live(preferred) ? preferred : undefined) ?? states.find((s) => s.enabled && live(s)) ?? preferred ?? states[0];
    if (!pick?.account.token) return undefined;
    this.releaseHold(pick);
    return pick.account.token;
  }

  /** How many Claude subscriptions are configured (one account per setup-token; a single synthetic
   *  "logged-in" account when none are). Lets callers phrase an all-capped message for the real count
   *  instead of assuming two. */
  count(): number {
    return this.accounts.length;
  }

  /**
   * Soonest upcoming reset across all subs, for the "every sub is capped" message — when the first
   * one frees up. Per account that's its cap reset if set (rateLimitResetAt), else its 5h window.
   * Null when nothing has a known future reset.
   */
  soonestResetAt(): number | null {
    const now = Date.now();
    const resets: number[] = [];
    for (const s of this.states.values()) {
      const reset = s.rateLimitResetAt ?? s.fiveHourReset;
      if (reset != null && reset > now) resets.push(reset);
    }
    return resets.length ? Math.min(...resets) : null;
  }

  /** Is any enabled account currently usable for a dispatch — not cap-rejected (or past its reset) and
   *  under the hard limit? Drives the cap-park supervisor: a task parked because every account was
   *  capped is only auto-resumed once this turns true (a window reset, or a sub freed up). Mirrors the
   *  `usable` predicate in select() so "has headroom" and "what select would dispatch to" never diverge. */
  hasHeadroom(): boolean {
    return this.selectionPool(Date.now()).usable.length > 0;
  }

  /** Register the callback fired after each usage refresh (periodic + reset pings). One consumer
   *  (ThreadManager's token-safety auto-stop); set once at construction, before start() fires the
   *  first ping, so no early read is missed. */
  onUsageRefresh(cb: () => void): void {
    this.onUsage = cb;
  }

  /**
   * The live token utilization to gate the safety limit against, as a single 0–100 number — the
   * MIN of each enabled-with-data account's tightest (5h/weekly) window. Min, not max, so the limit
   * trips only when EVERY usable account has also reached the threshold (failover would otherwise
   * keep work running on a still-fresh account). Mirrors select()/hasHeadroom()'s enabled-fallback:
   * when all accounts are disabled, consider them all rather than report nothing. Null when no
   * account has any usage data yet (pre-ping) — the caller treats null as "don't trip".
   */
  effectiveUtilization(): number | null {
    const all = [...this.states.values()];
    const enabledStates = all.filter((s) => s.enabled);
    const base = enabledStates.length ? enabledStates : all;
    const withData = base.filter(hasBurnData);
    if (!withData.length) return null;
    return Math.min(...withData.map(tightest));
  }

  /** Is this account currently cap-rejected and not yet past its reset? */
  isRateLimited(accountId: string): boolean {
    const st = this.states.get(accountId);
    if (!st) return false;
    return st.rateLimited && (st.rateLimitResetAt == null || st.rateLimitResetAt > Date.now());
  }

  /** A usable OAuth token for out-of-band API calls that just need *some* valid subscription token
   *  (e.g. listing the account's available models). Prefers an enabled account; any token otherwise. */
  firstUsableToken(): string | undefined {
    const states = [...this.states.values()];
    const enabled = states.find((s) => s.enabled && s.account.token);
    return (enabled ?? states.find((s) => s.account.token))?.account.token || undefined;
  }

  dto(): AccountDTO[] {
    const now = Date.now();
    return [...this.states.values()].map((s) => ({
      id: s.account.id,
      label: s.account.label,
      fiveHour: s.fiveHour,
      sevenDay: s.sevenDay,
      fiveHourReset: s.fiveHourReset,
      sevenDayReset: s.sevenDayReset,
      stale: s.usageStale,
      rateLimited: s.rateLimited,
      resetsAt: s.rateLimitResetAt,
      active: s.account.id === this.preferredId,
      enabled: s.enabled,
      holdUntil: s.holdUntil,
      modelLimits: [...s.modelLimits]
        .filter(([, r]) => r > now)
        .map(([model, resetsAt]) => ({ model, fallback: fallbackModelFor(model) ?? model, resetsAt })),
      updatedAt: s.updatedAt,
      error: s.error,
    }));
  }

  private publish(): void {
    this.hub.publish({ type: "accounts", accounts: this.dto() });
  }

  private selectionPool(now: number): { usable: AccountState[]; pool: AccountState[] } {
    const all = [...this.states.values()];
    // Operator-disabled accounts are held out of the rotation. Safety net: if every account is
    // disabled, ignore the toggles rather than strand the pipeline (planner/researcher/QA need Claude).
    const enabledStates = all.filter((s) => s.enabled);
    const base = enabledStates.length ? enabledStates : all;
    const usable = base.filter((s) => {
      const limited = s.rateLimited && (s.rateLimitResetAt == null || s.rateLimitResetAt > now);
      return !limited && tightest(s) < HARD_LIMIT;
    });
    return { usable, pool: usable.length ? [...usable] : [...base] };
  }
}

function fmt(n: number | null | undefined): string {
  return n == null ? "—" : `${Math.round(n)}%`;
}

/** The still-live model-pool latches as a persistable record, dropping expired entries. */
function liveModelLimits(st: AccountState, now: number): Record<string, number> {
  return Object.fromEntries([...st.modelLimits].filter(([, r]) => r > now));
}

/** Short, actionable label for why a usage ping had no usable read — shown on the chip. */
function pingErrorMessage(reason: PingFailReason): string {
  switch (reason) {
    case "no-token":
      return "no token — run 'claude setup-token'";
    case "auth":
      return "token rejected — re-run 'claude setup-token'";
    case "network":
      return "usage read failed (network)";
  }
}

/** Compact "in 7h" / "in 3d" until a reset epoch, for the selection log line. */
export function untilReset(resetAt: number | null, now: number): string {
  if (resetAt == null) return "—";
  const ms = resetAt - now;
  if (ms <= 0) return "now";
  const h = ms / 3_600_000;
  return h < 48 ? `in ${Math.round(h)}h` : `in ${Math.round(h / 24)}d`;
}
