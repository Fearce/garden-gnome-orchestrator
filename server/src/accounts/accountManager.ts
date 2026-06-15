import type { EventHub } from "../events.js";
import type { RateLimitInfo } from "../types.js";
import type { AccountDTO } from "../ws/protocol.js";
import type { Account } from "./account.js";
import { readTradingUsage } from "./tradingUsage.js";

interface AccountState {
  account: Account;
  fiveHour: number | null; // utilization 0-100
  sevenDay: number | null; // overall weekly utilization 0-100
  usageAt: number; // when fiveHour/sevenDay were last set (for source-recency merge)
  usageStale: boolean; // displayed usage is from a snapshot/old cache, not live
  rateLimited: boolean;
  rateLimitWindow: string | null; // which window 429-rejected (only it can clear the flag)
  rateLimitResetAt: number | null; // epoch ms
  lastPick: number; // monotonic selection sequence — round-robin tiebreak
  updatedAt: number;
}

// At/above this on the tightest window, treat the account as effectively capped.
const HARD_LIMIT = 98;

const tightest = (s: AccountState): number => Math.max(s.fiveHour ?? 0, s.sevenDay ?? 0);
const weeklyHeadroom = (s: AccountState): number => 100 - (s.sevenDay ?? 0);
const fiveHeadroom = (s: AccountState): number => 100 - (s.fiveHour ?? 0);
const hasBurnData = (s: AccountState): boolean => s.fiveHour != null || s.sevenDay != null;

/**
 * Tracks each subscription's 5h/weekly burn and routes dispatches to drain both
 * evenly.
 *
 * Burn comes from two sources, merged by recency: (1) the agent-orchestrator's
 * usage files — read-only, no tokens — which give the active account's *live*
 * usage plus a per-account snapshot for the other (our own `setup-token`s 403 on
 * the usage endpoint, so this is how the strip shows real numbers); and (2) each
 * run's `rate_limit_event`, freshest for an account we're actively burning.
 * `select()` round-robins while burn is unknown, then favors the account with the
 * most weekly headroom and avoids any that 429-rejected until its reset passes.
 */
export class AccountManager {
  private readonly states = new Map<string, AccountState>();
  private timer: NodeJS.Timeout | undefined;
  private preferredId: string | undefined;
  private selSeq = 0; // ever-increasing dispatch counter; drives round-robin without clock collisions

  constructor(
    private readonly accounts: Account[],
    private readonly hub: EventHub,
    private readonly tickMs = 60_000,
  ) {
    for (const a of accounts) {
      this.states.set(a.id, {
        account: a,
        fiveHour: null,
        sevenDay: null,
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
    this.refreshFromTrading();
    this.publish();
    // Liveness tick: pull the latest background usage and expire rate-limits. No
    // network call — usage is read from local files / run events.
    this.timer = setInterval(() => this.tick(), this.tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private tick(): void {
    const now = Date.now();
    let changed = this.refreshFromTrading();
    for (const s of this.states.values()) {
      if (s.rateLimited && s.rateLimitResetAt != null && now > s.rateLimitResetAt) {
        s.rateLimited = false;
        s.rateLimitWindow = null;
        s.rateLimitResetAt = null;
        changed = true;
      }
    }
    if (changed) this.publish();
  }

  /** Pull the agent-orchestrator's usage files; update any account with fresher data. Returns whether anything changed. */
  private refreshFromTrading(): boolean {
    let usage: ReturnType<typeof readTradingUsage>;
    try {
      usage = readTradingUsage();
    } catch {
      return false;
    }
    let changed = false;
    for (const st of this.states.values()) {
      const u = usage.get(st.account.label.toLowerCase());
      if (!u || u.at <= st.usageAt) continue; // keep fresher (e.g. a recent rate_limit_event)
      st.fiveHour = u.fiveHour;
      st.sevenDay = u.sevenDay;
      st.usageAt = u.at;
      st.usageStale = u.stale;
      st.updatedAt = Date.now();
      changed = true;
    }
    return changed;
  }

  /** Burn signal from a real run's rate_limit_event — freshest for an account we're burning. */
  updateFromRateLimit(accountId: string, info: RateLimitInfo): void {
    const st = this.states.get(accountId);
    if (!st) return;
    const now = Date.now();
    if (info.utilization != null) {
      if (info.rateLimitType === "five_hour") {
        st.fiveHour = info.utilization;
        st.usageAt = now;
        st.usageStale = false;
      } else if (info.rateLimitType === "seven_day") {
        st.sevenDay = info.utilization;
        st.usageAt = now;
        st.usageStale = false;
      }
      // opus/sonnet/overage utilization isn't the overall weekly number — a
      // rejection on those still flags rateLimited below, but we don't show it.
    }
    if (info.status === "rejected") {
      st.rateLimited = true;
      st.rateLimitWindow = info.rateLimitType ?? null;
      st.rateLimitResetAt = info.resetsAt ?? null;
      if (info.rateLimitType === "five_hour") {
        st.fiveHour = 100;
        st.usageAt = now;
        st.usageStale = false;
      } else if (info.rateLimitType === "seven_day") {
        st.sevenDay = 100;
        st.usageAt = now;
        st.usageStale = false;
      }
    } else if (st.rateLimited && (st.rateLimitWindow == null || st.rateLimitWindow === info.rateLimitType)) {
      // Only an "allowed" on the window that set the limit clears it.
      st.rateLimited = false;
      st.rateLimitWindow = null;
      st.rateLimitResetAt = null;
    }
    st.updatedAt = now;
    this.publish();
  }

  /** Pick the best account for the next dispatch. */
  select(): { account: Account; reason: string } {
    const first = this.accounts[0];
    if (this.accounts.length <= 1) {
      this.preferredId = first?.id;
      return { account: first ?? { id: "default", label: "logged-in", token: "" }, reason: "single account" };
    }
    this.tick(); // refresh + lift expired rate-limits before choosing
    const now = Date.now();
    const all = [...this.states.values()];
    const usable = all.filter((s) => {
      const limited = s.rateLimited && (s.rateLimitResetAt == null || s.rateLimitResetAt > now);
      return !limited && tightest(s) < HARD_LIMIT;
    });
    const pool = usable.length ? usable : all;
    // Prefer weekly headroom, then 5h headroom, then least-recently-selected —
    // so equal/unknown burn alternates evenly instead of always hitting acct 1.
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
