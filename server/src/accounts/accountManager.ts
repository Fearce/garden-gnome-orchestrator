import type { EventHub } from "../events.js";
import type { RateLimitInfo } from "../types.js";
import type { AccountDTO } from "../ws/protocol.js";
import type { Account } from "./account.js";
import { probeUsage, type AccountUsageSnapshot } from "./usageProbe.js";

interface AccountState {
  account: Account;
  usage: AccountUsageSnapshot | null;
  rateLimited: boolean;
  rateLimitResetAt: number | null;
  updatedAt: number;
}

// At/above this on the tightest window, treat the account as effectively capped.
const HARD_LIMIT = 98;

const tightest = (u: AccountUsageSnapshot | null): number => Math.max(u?.fiveHour ?? 0, u?.sevenDay ?? 0);
const weeklyHeadroom = (u: AccountUsageSnapshot | null): number => 100 - (u?.sevenDay ?? 0);
const fiveHeadroom = (u: AccountUsageSnapshot | null): number => 100 - (u?.fiveHour ?? 0);

/**
 * Tracks each subscription's 5-hour and weekly utilization and routes dispatches
 * to the account with the most weekly headroom that isn't 5h-throttled — so both
 * subs drain evenly and neither sits idle while the other is capped.
 */
export class AccountManager {
  private readonly states = new Map<string, AccountState>();
  private timer: NodeJS.Timeout | undefined;
  private preferredId: string | undefined;
  private probing = false;

  constructor(
    private readonly accounts: Account[],
    private readonly hub: EventHub,
    private readonly intervalMs = 120_000,
  ) {
    for (const a of accounts) {
      this.states.set(a.id, { account: a, usage: null, rateLimited: false, rateLimitResetAt: null, updatedAt: 0 });
    }
  }

  start(): void {
    if (!this.accounts.length) return;
    void this.probeAll();
    this.timer = setInterval(() => void this.probeAll(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async probeAll(): Promise<void> {
    if (this.probing) return; // never let a slow probe round stack onto the next tick
    this.probing = true;
    try {
      await Promise.all(this.accounts.map((a) => this.probeOne(a)));
      this.publish();
    } finally {
      this.probing = false;
    }
  }

  private async probeOne(a: Account): Promise<void> {
    const usage = await probeUsage(a.token);
    const st = this.states.get(a.id);
    if (!st) return;
    st.usage = usage;
    st.updatedAt = Date.now();
    // A fresh read below the cap clears a stale rate-limit flag.
    if (st.rateLimited && (tightest(usage) < HARD_LIMIT || (st.rateLimitResetAt != null && Date.now() > st.rateLimitResetAt))) {
      st.rateLimited = false;
      st.rateLimitResetAt = null;
    }
  }

  /** Opportunistic update from a real run's rate_limit_event (catches a cap between probes). */
  updateFromRateLimit(accountId: string, info: RateLimitInfo): void {
    const st = this.states.get(accountId);
    if (!st) return;
    if (info.status === "rejected") {
      st.rateLimited = true;
      st.rateLimitResetAt = info.resetsAt ?? null;
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
      return !limited && tightest(s.usage) < HARD_LIMIT;
    });
    const pool = usable.length ? usable : all;
    pool.sort(
      (x, y) => weeklyHeadroom(y.usage) - weeklyHeadroom(x.usage) || fiveHeadroom(y.usage) - fiveHeadroom(x.usage),
    );
    const chosen = pool[0]!;
    this.preferredId = chosen.account.id;
    this.publish();
    const u = chosen.usage;
    const reason = usable.length
      ? `weekly ${fmt(u?.sevenDay)} · 5h ${fmt(u?.fiveHour)} — most headroom`
      : "all accounts near limit — using least-burned";
    return { account: chosen.account, reason };
  }

  dto(): AccountDTO[] {
    return [...this.states.values()].map((s) => ({
      id: s.account.id,
      label: s.account.label,
      email: s.usage?.email,
      subscriptionType: s.usage?.subscriptionType,
      fiveHour: s.usage?.fiveHour ?? null,
      sevenDay: s.usage?.sevenDay ?? null,
      rateLimited: s.rateLimited,
      resetsAt: s.rateLimitResetAt,
      active: s.account.id === this.preferredId,
      updatedAt: s.updatedAt,
      error: s.usage?.error ?? null,
    }));
  }

  private publish(): void {
    this.hub.publish({ type: "accounts", accounts: this.dto() });
  }
}

function fmt(n: number | null | undefined): string {
  return n == null ? "—" : `${Math.round(n)}%`;
}
