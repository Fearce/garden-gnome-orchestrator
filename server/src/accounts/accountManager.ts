import type { EventHub } from "../events.js";
import type { RateLimitInfo } from "../types.js";
import type { AccountDTO } from "../ws/protocol.js";
import type { Account } from "./account.js";
import { pingUsage, type PingFailReason } from "./usagePing.js";
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
  lastPick: number; // monotonic selection sequence — round-robin tiebreak
  updatedAt: number;
}

// At/above this on the tightest window, treat the account as effectively capped.
const HARD_LIMIT = 98;
const STALE_MS = 20 * 60 * 1000; // a value older than this (ping failing) shows "stale"
const RESET_BUFFER_MS = 3_000; // ping this long after a window reset to catch the rollover
const MIN_RESET_DELAY_MS = 1_000;

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
 * Pings run on an interval (fresh display) and are also scheduled right at each
 * window's reset, which both flips the strip to ~0% the moment a window resets
 * AND starts the new window's timer immediately. `select()` round-robins until
 * burn is known, then **burns the account whose weekly window resets soonest** —
 * spending the "perishable" weekly allowance first and keeping the one with days
 * of runway in reserve — avoiding any that 429-rejected until its reset passes
 * (see `bySelectionPriority`).
 */
export class AccountManager {
  private readonly states = new Map<string, AccountState>();
  private periodic: NodeJS.Timeout | undefined;
  private readonly resetTimers = new Map<string, NodeJS.Timeout>();
  private preferredId: string | undefined;
  private selSeq = 0;

  constructor(
    private readonly accounts: Account[],
    private readonly hub: EventHub,
    private readonly pingIntervalMs = 600_000, // 10 min
  ) {
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
        lastPick: 0,
        updatedAt: 0,
      });
    }
  }

  start(): void {
    if (!this.accounts.length) return;
    void this.pingAll().catch((e) => logCrash("accountPing.initial", e)); // immediate, so the strip fills within a few seconds
    this.periodic = setInterval(() => void this.pingAll().catch((e) => logCrash("accountPing.periodic", e)), this.pingIntervalMs);
    this.periodic.unref?.();
  }

  stop(): void {
    if (this.periodic) clearInterval(this.periodic);
    for (const t of this.resetTimers.values()) clearTimeout(t);
    this.resetTimers.clear();
  }

  private async pingAll(): Promise<void> {
    await Promise.all(this.accounts.map((a) => this.pingOne(a)));
    this.publish();
  }

  /** Tiny Haiku ping → live usage from rate-limit headers; also (re)schedules the reset ping. */
  private async pingOne(a: Account): Promise<void> {
    const r = await pingUsage(a.token);
    const st = this.states.get(a.id);
    if (!st) return;
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
      return;
    }
    const u = r.usage;
    st.fiveHour = u.fiveHour;
    st.sevenDay = u.sevenDay;
    st.fiveHourReset = u.fiveHourReset;
    st.sevenDayReset = u.sevenDayReset;
    st.usageAt = now;
    st.usageStale = false;
    st.error = null;
    st.rateLimited = u.fiveHourRejected || u.sevenDayRejected;
    st.rateLimitWindow = u.fiveHourRejected ? "five_hour" : u.sevenDayRejected ? "seven_day" : null;
    st.rateLimitResetAt = u.fiveHourRejected ? u.fiveHourReset : u.sevenDayRejected ? u.sevenDayReset : null;
    st.updatedAt = now;
    this.scheduleResetPing(a, u);
  }

  /**
   * Schedule a one-shot ping just after the soonest upcoming window reset — so a
   * new window's timer starts immediately and the strip flips to ~0% the moment
   * it resets, rather than waiting for the next periodic ping.
   */
  private scheduleResetPing(a: Account, u: { fiveHourReset: number | null; sevenDayReset: number | null }): void {
    const now = Date.now();
    const upcoming = [u.fiveHourReset, u.sevenDayReset].filter((r): r is number => r != null && r > now);
    const prev = this.resetTimers.get(a.id);
    if (prev) clearTimeout(prev);
    if (!upcoming.length) return;
    const delay = Math.max(Math.min(...upcoming) - now + RESET_BUFFER_MS, MIN_RESET_DELAY_MS);
    const t = setTimeout(
      () => void this.pingOne(a).then(() => this.publish()).catch((e) => logCrash("accountPing.reset", e)),
      delay,
    );
    t.unref?.();
    this.resetTimers.set(a.id, t);
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

  /** Pick the best account for the next dispatch. */
  select(): { account: Account; reason: string } {
    if (this.accounts.length <= 1) {
      // loadAccounts() always yields ≥1 account (a synthetic "logged-in" entry when no tokens are
      // configured), so accounts[0] is always defined — no synthetic fallback needed here.
      const only = this.accounts[0]!;
      this.preferredId = only.id;
      return { account: only, reason: "single account" };
    }
    const now = Date.now();
    const all = [...this.states.values()];
    const usable = all.filter((s) => {
      const limited = s.rateLimited && (s.rateLimitResetAt == null || s.rateLimitResetAt > now);
      return !limited && tightest(s) < HARD_LIMIT;
    });
    const pool = usable.length ? usable : all;
    // Burn the account whose weekly window resets soonest first (see bySelectionPriority).
    pool.sort(bySelectionPriority);
    const chosen = pool[0]!;
    chosen.lastPick = ++this.selSeq;
    this.preferredId = chosen.account.id;
    this.publish();
    const reason = !usable.length
      ? "all accounts near limit — using the one resetting soonest"
      : pool.some(hasBurnData)
        ? `weekly ${fmt(chosen.sevenDay)} · 5h ${fmt(chosen.fiveHour)} · resets ${untilReset(chosen.sevenDayReset, now)} — soonest weekly reset`
        : "round-robin (no burn data yet)";
    return { account: chosen.account, reason };
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
      if (s.account.id === excludeId) return false;
      const limited = s.rateLimited && (s.rateLimitResetAt == null || s.rateLimitResetAt > now);
      return !limited && tightest(s) < HARD_LIMIT;
    });
    if (!candidates.length) return null;
    // Same perishable-first order: the reserve account we fail over to is the next-soonest-resetting one.
    candidates.sort(bySelectionPriority);
    const chosen = candidates[0]!;
    chosen.lastPick = ++this.selSeq;
    this.preferredId = chosen.account.id;
    this.publish();
    return chosen.account;
  }

  /** A subscription token for an ANCILLARY call (e.g. resume-compression's Haiku summary) — purely
   *  read-only: unlike select(), it does NOT bump round-robin state, change the preferred/"active"
   *  account, or publish. Prefers the currently-preferred account, else the first. */
  auxToken(): string | undefined {
    const pick = (this.preferredId ? this.states.get(this.preferredId)?.account : undefined) ?? this.accounts[0];
    return pick?.token || undefined;
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

  /** Is this account currently cap-rejected and not yet past its reset? */
  isRateLimited(accountId: string): boolean {
    const st = this.states.get(accountId);
    if (!st) return false;
    return st.rateLimited && (st.rateLimitResetAt == null || st.rateLimitResetAt > Date.now());
  }

  dto(): AccountDTO[] {
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
      updatedAt: s.updatedAt,
      error: s.error,
    }));
  }

  private publish(): void {
    this.hub.publish({ type: "accounts", accounts: this.dto() });
  }
}

function fmt(n: number | null | undefined): string {
  return n == null ? "—" : `${Math.round(n)}%`;
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
