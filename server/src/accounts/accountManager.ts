import type { EventHub } from "../events.js";
import type { RateLimitInfo } from "../types.js";
import type { AccountDTO } from "../ws/protocol.js";
import type { Account } from "./account.js";

interface AccountState {
  account: Account;
  fiveHour: number | null; // utilization 0-100, null until first observed
  sevenDay: number | null; // utilization 0-100
  rateLimited: boolean;
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
        fiveHour: null,
        sevenDay: null,
        rateLimited: false,
        rateLimitResetAt: null,
        lastPick: 0,
        updatedAt: 0,
      });
    }
  }

  start(): void {
    if (!this.accounts.length) return;
    this.publish();
    // Liveness tick: lazily clear expired rate-limits and republish. No network
    // probe — burn data arrives via updateFromRateLimit during real runs.
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
        s.rateLimited = false;
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
    if (info.utilization != null) {
      if (info.rateLimitType === "five_hour") st.fiveHour = info.utilization;
      else if (info.rateLimitType === "seven_day") st.sevenDay = info.utilization;
    }
    if (info.status === "rejected") {
      st.rateLimited = true;
      st.rateLimitResetAt = info.resetsAt ?? null;
      // A rejection means the binding window is at its cap.
      if (info.rateLimitType === "five_hour") st.fiveHour = Math.max(st.fiveHour ?? 0, 100);
      else if (info.rateLimitType === "seven_day") st.sevenDay = Math.max(st.sevenDay ?? 0, 100);
    } else {
      st.rateLimited = false;
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
