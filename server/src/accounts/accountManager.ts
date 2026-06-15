import type { EventHub } from "../events.js";
import type { RateLimitInfo } from "../types.js";
import type { AccountDTO } from "../ws/protocol.js";
import type { Account } from "./account.js";

interface AccountState {
  account: Account;
  // Per-window utilization (0-100), keyed by rate_limit_event `rateLimitType`.
  // Each window is set authoritatively by its own events; never conflated.
  util: Map<string, number>;
  rateLimited: boolean;
  rateLimitWindow: string | null; // which window 429-rejected (only it can clear the flag)
  rateLimitResetAt: number | null; // epoch ms
  lastPick: number; // monotonic selection sequence — round-robin tiebreak
  updatedAt: number;
}

// At/above this on the tightest window, treat the account as effectively capped.
const HARD_LIMIT = 98;

// seven_day, plus the per-model weekly sub-caps — opus binds our Opus implementor.
const WEEKLY_FAMILY = ["seven_day", "seven_day_opus", "seven_day_sonnet"];

const fiveHourOf = (s: AccountState): number | null => s.util.get("five_hour") ?? null;
const weeklyOf = (s: AccountState): number | null => {
  let m: number | null = null;
  for (const k of WEEKLY_FAMILY) {
    const v = s.util.get(k);
    if (v != null) m = m == null ? v : Math.max(m, v);
  }
  return m;
};
const tightest = (s: AccountState): number => Math.max(fiveHourOf(s) ?? 0, weeklyOf(s) ?? 0);
const weeklyHeadroom = (s: AccountState): number => 100 - (weeklyOf(s) ?? 0);
const fiveHeadroom = (s: AccountState): number => 100 - (fiveHourOf(s) ?? 0);
const hasBurnData = (s: AccountState): boolean => s.util.size > 0;

/**
 * Routes dispatches across the subscriptions to drain both evenly.
 *
 * Setup-tokens (what this console runs on) can't read the /api/oauth/usage
 * endpoint — it 403s for anything but an interactive OAuth access token — so
 * per-account burn comes instead from each run's `rate_limit_event`, which the
 * message API returns for the account that's actually running (utilization +
 * which window + allowed/warning/rejected). Until an account reports burn,
 * routing round-robins so both subs get used; once a window's utilization is
 * known, traffic favors the account with more weekly headroom and avoids any
 * that 429-rejected (until its reset passes).
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
        util: new Map(),
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
    this.publish();
    // Liveness tick: lazily expire rate-limits and republish. No network probe —
    // burn data arrives via updateFromRateLimit during real runs.
    this.timer = setInterval(() => this.sweep(), this.tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private sweep(): void {
    const now = Date.now();
    let changed = false;
    for (const s of this.states.values()) {
      if (s.rateLimited && s.rateLimitResetAt != null && now > s.rateLimitResetAt) {
        // Window reset: drop its (capped) utilization so it re-learns, and lift the limit.
        if (s.rateLimitWindow) s.util.delete(s.rateLimitWindow);
        s.rateLimited = false;
        s.rateLimitWindow = null;
        s.rateLimitResetAt = null;
        changed = true;
      }
    }
    if (changed) this.publish();
  }

  /** Burn signal from a real run's rate_limit_event — the only usage source for setup-token accounts. */
  updateFromRateLimit(accountId: string, info: RateLimitInfo): void {
    const st = this.states.get(accountId);
    if (!st) return;
    if (info.utilization != null && info.rateLimitType) {
      st.util.set(info.rateLimitType, info.utilization);
    }
    if (info.status === "rejected") {
      st.rateLimited = true;
      st.rateLimitWindow = info.rateLimitType ?? null;
      st.rateLimitResetAt = info.resetsAt ?? null;
      if (info.rateLimitType) st.util.set(info.rateLimitType, 100);
    } else if (st.rateLimited && (st.rateLimitWindow == null || st.rateLimitWindow === info.rateLimitType)) {
      // Only an "allowed" on the window that set the limit (or an untyped event) clears it —
      // an allowed five_hour event must not unblock a rejected weekly window.
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
    this.sweep(); // lift any rate-limits whose reset has passed before choosing
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
        ? `weekly ${fmt(weeklyOf(chosen))} · 5h ${fmt(fiveHourOf(chosen))} — most headroom`
        : "round-robin (no burn data yet)";
    return { account: chosen.account, reason };
  }

  dto(): AccountDTO[] {
    return [...this.states.values()].map((s) => ({
      id: s.account.id,
      label: s.account.label,
      fiveHour: fiveHourOf(s),
      sevenDay: weeklyOf(s),
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
