import type { EventHub } from "../events.js";
import type { RateLimitInfo } from "../types.js";
import type { AccountDTO } from "../ws/protocol.js";
import type { Account } from "./account.js";
import { pingUsage } from "./usagePing.js";

interface AccountState {
  account: Account;
  fiveHour: number | null; // utilization 0-100
  sevenDay: number | null; // overall weekly utilization 0-100
  fiveHourReset: number | null; // epoch ms
  sevenDayReset: number | null; // epoch ms
  usageAt: number; // when usage was last read
  usageStale: boolean; // last ping failed and the value is getting old
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

/**
 * Tracks each subscription's 5h/weekly burn and routes dispatches to drain both
 * evenly.
 *
 * Usage comes from a "super tiny" Haiku ping per account (`usagePing.ts`): the
 * /v1/messages response headers carry exact live 5h + weekly utilization for the
 * token's account — works with setup-tokens, which 403 on the /usage endpoint.
 * Pings run on an interval (fresh display) and are also scheduled right at each
 * window's reset, which both flips the strip to ~0% the moment a window resets
 * AND starts the new window's timer immediately. `select()` round-robins until
 * burn is known, then favors the account with the most weekly headroom and
 * avoids any that 429-rejected until its reset passes.
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
    void this.pingAll(); // immediate, so the strip fills within a few seconds
    this.periodic = setInterval(() => void this.pingAll(), this.pingIntervalMs);
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
    const u = await pingUsage(a.token);
    const st = this.states.get(a.id);
    if (!st) return;
    const now = Date.now();
    if (!u) {
      if (st.usageAt && now - st.usageAt > STALE_MS && !st.usageStale) {
        st.usageStale = true;
        st.updatedAt = now;
      }
      return;
    }
    st.fiveHour = u.fiveHour;
    st.sevenDay = u.sevenDay;
    st.fiveHourReset = u.fiveHourReset;
    st.sevenDayReset = u.sevenDayReset;
    st.usageAt = now;
    st.usageStale = false;
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
    const t = setTimeout(() => void this.pingOne(a).then(() => this.publish()), delay);
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
    const first = this.accounts[0];
    if (this.accounts.length <= 1) {
      this.preferredId = first?.id;
      return { account: first ?? { id: "default", label: "logged-in", token: "" }, reason: "single account" };
    }
    const now = Date.now();
    const all = [...this.states.values()];
    const usable = all.filter((s) => {
      const limited = s.rateLimited && (s.rateLimitResetAt == null || s.rateLimitResetAt > now);
      return !limited && tightest(s) < HARD_LIMIT;
    });
    const pool = usable.length ? usable : all;
    // Prefer weekly headroom, then 5h headroom, then least-recently-selected.
    pool.sort(
      (x, y) =>
        weeklyHeadroom(y) - weeklyHeadroom(x) ||
        fiveHeadroom(y) - fiveHeadroom(x) ||
        x.lastPick - y.lastPick,
    );
    const chosen = pool[0]!;
    chosen.lastPick = ++this.selSeq;
    this.preferredId = chosen.account.id;
    this.publish();
    const reason = !usable.length
      ? "all accounts near limit — using least-burned"
      : pool.some(hasBurnData)
        ? `weekly ${fmt(chosen.sevenDay)} · 5h ${fmt(chosen.fiveHour)} — most headroom`
        : "round-robin (no burn data yet)";
    return { account: chosen.account, reason };
  }

  dto(): AccountDTO[] {
    return [...this.states.values()].map((s) => ({
      id: s.account.id,
      label: s.account.label,
      fiveHour: s.fiveHour,
      sevenDay: s.sevenDay,
      stale: s.usageStale,
      rateLimited: s.rateLimited,
      resetsAt: s.rateLimitResetAt,
      active: s.account.id === this.preferredId,
      updatedAt: s.updatedAt,
      error: null,
    }));
  }

  private publish(): void {
    this.hub.publish({ type: "accounts", accounts: this.dto() });
  }
}

function fmt(n: number | null | undefined): string {
  return n == null ? "—" : `${Math.round(n)}%`;
}
