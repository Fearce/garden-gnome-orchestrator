/**
 * Codex capacity POOLS — the per-limit meters behind one ChatGPT plan, and the policy for which roles
 * may spend a dedicated pool.
 *
 * A ChatGPT plan is not one allowance. `account/rateLimits/read` returns `rateLimitsByLimitId`: the
 * general `codex` pool that every ordinary model draws on, PLUS a dedicated pool per model that ships
 * with its own allowance. On this deployment's plan that pool is GPT-5.3-Codex-Spark — its own 5h AND
 * weekly windows, resetting on their own clock, sitting at 0% while the general weekly pool burns down.
 * We read only the top-level `rateLimits` before this, so that capacity was invisible and unroutable.
 *
 * Two rules this module exists to keep:
 *
 * 1. **A pool's identity is its `limitId`, but the model it meters is only discoverable from
 *    `limitName`.** The live id is `codex_bengalfox` — an internal codename with no relationship to
 *    the model slug, and every reason to change on the next release. So the model→pool link is made by
 *    NORMALIZING the human label ("GPT-5.3-Codex-Spark" → "gpt-5.3-codex-spark") and matching it
 *    against the model id. Never hardcode a limitId.
 *
 * 2. **Pools are independent, so a cap in one must never be read as a cap in the other.** Latching
 *    the general pool because Spark 429'd would disable a backend with 71% of its weekly allowance
 *    left; the reverse would strand idle Spark capacity behind an exhausted general pool.
 */

import type { Role } from "../types.js";
import { preferCapacity, standardCapacityWindows, type CapacityDemand } from "../orchestrator/capacityRouting.js";

/** The pool every model without a dedicated allowance draws on. */
export const GENERAL_LIMIT_ID = "codex";

/** One independently-metered Codex allowance. `fiveHour`/`sevenDay` are 0-100 used-percent (null =
 *  the backend reported no such window), resets are epoch ms. */
export interface CodexPool {
  limitId: string;
  limitName: string | null;
  /** The model slug this pool meters, normalized from `limitName`. Null for the general pool, which
   *  meters everything else and is identified by `limitId` instead. */
  modelSlug: string | null;
  fiveHour: number | null;
  sevenDay: number | null;
  fiveHourReset: number | null; // epoch ms
  sevenDayReset: number | null; // epoch ms
}

/**
 * The roles automatic capacity routing may place on a DEDICATED pool. Deliberately excludes
 * implementor, qa and reviewer, and the reason is capability, not thrift. A strict task-local model
 * request is an explicit owner override and is validated against that exact pool outside this
 * automatic policy; it never makes Spark an ordinary implementor candidate.
 *
 * The dedicated pool on this plan is Spark, and the Codex CLI ships Spark with an instruction template
 * that tells it "Do NOT modify or run tests or verify your work unless the user asks explicitly",
 * "NEVER do another pass just to check", "NEVER review code you've written" and "STRICT ONE_SHOT MODE".
 * A model instructed never to verify is the wrong shape for an implementor and an actively unsafe one
 * for QA or the auto-reviewer — those roles exist to check work. Its 128K context window (against the
 * flagships' 272K) is the second reason: a long implementor session outgrows it.
 *
 * What it IS good at is exactly the bounded, one-shot, read-then-answer work the other three roles do:
 * the reader answers a lookup and posts a finding, the planner reads the repo and emits a structured
 * plan, the researcher gathers external context. Each is a short structured turn with no obligation to
 * re-verify — so spending an otherwise-idle allowance on them is free capacity, not a downgrade.
 */
export const DEDICATED_POOL_ROLES: ReadonlySet<Role> = new Set<Role>(["reader", "planner", "researcher"]);

/** Used-percent at or above which a window counts as spent. Codex reports 100 at the plan limit; the
 *  margin below that keeps us from claiming a pool that can't finish the run we'd route to it. */
export const POOL_HARD_LIMIT_PCT = 95;

/** Collapse a human limit label to a comparable model slug: "GPT-5.3-Codex-Spark" → "gpt-5.3-codex-spark".
 *  Dots are preserved (they are part of a version, "5.3"), every other separator becomes a hyphen. */
export function normalizeLimitName(name: string | null | undefined): string | null {
  if (!name) return null;
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || null;
}

/** Normalize a model id the same way, so the two sides of the match are directly comparable. */
export function normalizeModelId(model: string | null | undefined): string | null {
  return normalizeLimitName(model);
}

/** The dedicated pools — every pool that names a specific model. The general pool is excluded: it
 *  meters everything without an allowance of its own and is never a routing *target*, only the default. */
export function dedicatedPools(pools: readonly CodexPool[]): CodexPool[] {
  return pools.filter((p) => p.limitId !== GENERAL_LIMIT_ID && p.modelSlug != null);
}

/** The general pool, if the backend reported one. */
export function generalPool(pools: readonly CodexPool[]): CodexPool | undefined {
  return pools.find((p) => p.limitId === GENERAL_LIMIT_ID);
}

/** Which pool meters a given model: its dedicated pool when one exists, else the general pool. */
export function poolForModel(pools: readonly CodexPool[], model: string): CodexPool | undefined {
  const slug = normalizeModelId(model);
  if (slug) {
    const dedicated = dedicatedPools(pools).find((p) => p.modelSlug === slug);
    if (dedicated) return dedicated;
  }
  return generalPool(pools);
}

/**
 * Whether a pool can take a run right now. A window counts as spent only when it is at/above the limit
 * AND its reset is still in the future — a window whose reset has passed has rolled over and is free
 * again even while the cached percentage still reads 100 (the same rule the failover ladder applies to
 * provider windows). A pool reporting NO windows at all is unusable: this is fail-closed on purpose,
 * so a failed or missing meter read routes to the normal ladder instead of gambling a run on a pool
 * we cannot see.
 */
export function poolHasHeadroom(pool: CodexPool | undefined, now: number, limitPct = POOL_HARD_LIMIT_PCT): boolean {
  if (!pool) return false;
  if (pool.fiveHour == null && pool.sevenDay == null) return false;
  const spent = (pct: number | null, reset: number | null): boolean => pct != null && pct >= limitPct && (reset == null || reset > now);
  return !spent(pool.fiveHour, pool.fiveHourReset) && !spent(pool.sevenDay, pool.sevenDayReset);
}

/** Whether this role is allowed to spend a dedicated pool at all (see DEDICATED_POOL_ROLES). */
export function roleMayUseDedicatedPool(role: Role): boolean {
  return DEDICATED_POOL_ROLES.has(role);
}

/** A dedicated pool that is currently latched as capped — keyed by limitId, value = epoch ms until. */
export type PoolCapLatches = ReadonlyMap<string, number>;

export interface DedicatedPickInput {
  pools: readonly CodexPool[];
  role: Role;
  now: number;
  /** Model ids this deployment can actually dispatch (the live Codex roster). A pool whose model is not
   *  dispatchable is skipped — the allowance is real but we have no way to spend it. */
  dispatchable: readonly string[];
  /** Per-pool cap latches from live 429s, so a just-rejected pool isn't immediately retried. */
  capLatches?: PoolCapLatches;
  limitPct?: number;
  /** Role/task-sized reserve. When present, a nearly-spent pool loses to one able to carry the turn. */
  demand?: CapacityDemand;
}

/**
 * The model to run this Codex role on so it draws from an otherwise-idle dedicated pool — or undefined
 * to leave routing exactly as it was.
 *
 * Every condition is a veto, and the default is always "no": the role must be one of the bounded ones,
 * the pool must be un-latched and report real headroom, and its model must be in the dispatchable
 * roster. Ties break on the pool with the most headroom so a burst spreads rather than hammering one.
 */
export function dedicatedPoolModel(input: DedicatedPickInput): string | undefined {
  const { pools, role, now, dispatchable, capLatches, limitPct, demand } = input;
  if (!roleMayUseDedicatedPool(role)) return undefined;
  const runnable = new Set(dispatchable.map((m) => normalizeModelId(m)).filter((m): m is string => !!m));
  const usable = dedicatedPools(pools)
    .filter((p) => runnable.has(p.modelSlug!))
    .filter((p) => !poolLatched(capLatches, p.limitId, now))
    .filter((p) => poolHasHeadroom(p, now, limitPct));
  const capacity = demand
    ? preferCapacity(usable, (pool) => standardCapacityWindows(pool.fiveHour, pool.fiveHourReset, pool.sevenDay, pool.sevenDayReset), demand, now)
    : undefined;
  // With a workload reserve, an all-at-risk dedicated tier is not a useful target: return control to
  // the caller so it can consider the general Codex pool and the other providers. Without this guard,
  // merely having 1% below the hard cutoff made a dedicated pool shadow a healthy general allowance.
  if (capacity?.allKnownAtRisk) return undefined;
  const ranked = [...(capacity?.candidates ?? usable)].sort((a, b) => poolHeadroomPct(b) - poolHeadroomPct(a));
  return ranked[0]?.modelSlug ?? undefined;
}

/** Whether a live 429 latch is still holding this pool off. */
export function poolLatched(latches: PoolCapLatches | undefined, limitId: string, now: number): boolean {
  const until = latches?.get(limitId);
  return until != null && until > now;
}

/** How much room a pool has left, as the percent free on its TIGHTEST reported window. */
export function poolHeadroomPct(pool: CodexPool): number {
  const used = [pool.fiveHour, pool.sevenDay].filter((p): p is number => p != null);
  return used.length ? 100 - Math.max(...used) : 0;
}

/** A one-line human summary of a pool, for the account chip tooltip and the failover-ladder probe. */
export function describePool(pool: CodexPool): string {
  const label = pool.limitName ?? pool.limitId;
  const part = (name: string, pct: number | null): string | null => (pct == null ? null : `${name} ${pct}%`);
  const meters = [part("5h", pool.fiveHour), part("7d", pool.sevenDay)].filter((s): s is string => !!s);
  return `${label}: ${meters.length ? meters.join(" · ") : "no meter"}`;
}
