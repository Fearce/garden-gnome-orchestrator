// Shared quota-runway policy for every provider/account/model dispatch.
//
// Providers expose different shapes (5h + weekly percentages, monthly credits, dedicated model
// pools), but the routing question is the same: can the allowance that gates THIS run plausibly carry
// the work until it finishes or a reset replenishes it? Keeping that calculation here prevents account
// selection, provider selection, smart model selection, and cap-wait scheduling from drifting apart.

import type { Effort, Role } from "../types.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** One quota window that gates a dispatch. `usedPct=null` means the provider exposes no live meter. */
export interface CapacityWindow {
  label: string;
  usedPct: number | null;
  resetAt: number | null;
  /** Relative share of this window a normal task burn consumes. 5h is 1; longer windows are lower. */
  burnWeight?: number;
}

/** A conservative routing reserve, not a promise about provider token accounting. */
export interface CapacityDemand {
  label: string;
  expectedDurationMs: number;
  expectedBurnPct: number;
  reservePct: number;
  substantial: boolean;
}

export type CapacityStatus = "viable" | "unknown" | "at-risk";

export interface WindowAssessment {
  label: string;
  remainingPct: number;
  requiredPct: number;
  resetAt: number | null;
  marginPct: number;
}

export interface CapacityAssessment {
  status: CapacityStatus;
  /** The tightest `remaining - required` margin across visible windows. Null when no meter exists. */
  marginPct: number | null;
  limiting?: WindowAssessment;
  windows: WindowAssessment[];
}

export interface CapacityTarget {
  label: string;
  windows: CapacityWindow[];
}

export interface CapacitySelection<T> {
  candidates: T[];
  assessments: Map<T, CapacityAssessment>;
  /** True only when every candidate has real telemetry and every one lacks the requested runway. */
  allKnownAtRisk: boolean;
  constrained: boolean;
}

export interface DemandInput {
  effort?: Effort | null;
  stepCount?: number;
  fileCount?: number;
  riskCount?: number;
  durationMs?: number | null;
  deadlineAt?: number | null;
  now?: number;
}

const BASE_DEMAND: Record<Role, Omit<CapacityDemand, "label">> = {
  director: { expectedDurationMs: 10 * MINUTE_MS, expectedBurnPct: 2, reservePct: 2, substantial: false },
  reader: { expectedDurationMs: 20 * MINUTE_MS, expectedBurnPct: 4, reservePct: 2, substantial: false },
  planner: { expectedDurationMs: 35 * MINUTE_MS, expectedBurnPct: 7, reservePct: 2, substantial: false },
  researcher: { expectedDurationMs: 60 * MINUTE_MS, expectedBurnPct: 10, reservePct: 3, substantial: false },
  qa: { expectedDurationMs: 75 * MINUTE_MS, expectedBurnPct: 14, reservePct: 3, substantial: true },
  reviewer: { expectedDurationMs: 75 * MINUTE_MS, expectedBurnPct: 14, reservePct: 3, substantial: true },
  implementor: { expectedDurationMs: 150 * MINUTE_MS, expectedBurnPct: 26, reservePct: 4, substantial: true },
};

const IMPLEMENTOR_BY_EFFORT: Record<Effort, Omit<CapacityDemand, "label">> = {
  low: { expectedDurationMs: 45 * MINUTE_MS, expectedBurnPct: 9, reservePct: 3, substantial: false },
  medium: { expectedDurationMs: 90 * MINUTE_MS, expectedBurnPct: 16, reservePct: 3, substantial: false },
  high: BASE_DEMAND.implementor,
  xhigh: { expectedDurationMs: 3 * HOUR_MS, expectedBurnPct: 34, reservePct: 4, substantial: true },
  max: { expectedDurationMs: 4 * HOUR_MS, expectedBurnPct: 40, reservePct: 5, substantial: true },
  ultra: { expectedDurationMs: 5 * HOUR_MS, expectedBurnPct: 46, reservePct: 5, substantial: true },
};

/**
 * Estimate the allowance reserve a role needs. The percentages are deliberately coarse: providers do
 * not publish tokens-per-percent, so false precision would be misleading. Their job is to separate a
 * tiny lookup from a multi-hour implementation and keep the latter off a nearly-spent pool.
 */
export function demandForRole(role: Role, input: DemandInput = {}): CapacityDemand {
  const now = input.now ?? Date.now();
  let demand = role === "implementor"
    ? { ...IMPLEMENTOR_BY_EFFORT[input.effort ?? "high"] }
    : { ...BASE_DEMAND[role] };

  if (role === "implementor") {
    const complexity = (input.stepCount ?? 0) + Math.ceil((input.fileCount ?? 0) / 2) + 2 * (input.riskCount ?? 0);
    if (complexity >= 12) {
      demand.expectedDurationMs = Math.max(demand.expectedDurationMs, 3 * HOUR_MS);
      demand.expectedBurnPct = Math.max(demand.expectedBurnPct, 34);
      demand.substantial = true;
    }

    const requestedWindow = input.deadlineAt != null
      ? Math.max(0, input.deadlineAt - now)
      : Math.max(0, input.durationMs ?? 0);
    if (requestedWindow > 0) {
      // A timed task may run for days. Routing against a twelve-hour slice is conservative without
      // claiming one provider window must carry the entire wall-clock request (resets replenish it).
      const routedWindow = Math.min(requestedWindow, 12 * HOUR_MS);
      demand.expectedDurationMs = Math.max(demand.expectedDurationMs, routedWindow);
      demand.expectedBurnPct = Math.max(demand.expectedBurnPct, Math.min(75, 10 + (routedWindow / HOUR_MS) * 8));
      demand.substantial = demand.substantial || requestedWindow >= 2 * HOUR_MS;
    }
  }

  const kind = role === "implementor"
    ? demand.substantial ? "substantial implementation" : "bounded implementation"
    : `${role} turn`;
  return { ...demand, label: kind };
}

/** Build the common 5h/weekly window pair while preserving null meters for operator-facing status. */
export function standardCapacityWindows(
  fiveHour: number | null | undefined,
  fiveHourReset: number | null | undefined,
  sevenDay: number | null | undefined,
  sevenDayReset: number | null | undefined,
): CapacityWindow[] {
  return [
    { label: "5h", usedPct: finitePct(fiveHour), resetAt: finiteEpoch(fiveHourReset), burnWeight: 1 },
    { label: "weekly", usedPct: finitePct(sevenDay), resetAt: finiteEpoch(sevenDayReset), burnWeight: 0.2 },
  ];
}

/** Represent a dispatch hard ceiling as an explicit gating window. The raw meter may still have a few
 * percent free (98% used at a 98% ceiling), which can look sufficient for a tiny turn; routing policy
 * nevertheless holds it until reset. Making that hold a window lets reset simulation wake at the right
 * time instead of returning "viable now" and losing the timer. */
export function withRoutingCeiling(
  windows: readonly CapacityWindow[],
  limitPct: number,
  now = Date.now(),
): CapacityWindow[] {
  const out = [...windows];
  for (const window of windows) {
    if (
      window.usedPct != null &&
      window.usedPct >= limitPct &&
      (window.resetAt == null || window.resetAt > now)
    ) {
      out.push({ label: `${window.label} routing ceiling`, usedPct: 100, resetAt: window.resetAt });
    }
  }
  return out;
}

/** Apply the hard routing ceiling, then discard stale percentages as selection evidence. A stale value
 * already beyond the ceiling remains a real hold until its reset; stale apparent headroom becomes
 * unknown so it cannot outrank a fresh viable pool or create a false capacity park. */
export function capacityWindowsWithFreshness(
  windows: readonly CapacityWindow[],
  limitPct: number,
  stale: boolean,
  now = Date.now(),
): CapacityWindow[] {
  const routed = withRoutingCeiling(windows, limitPct, now);
  if (!stale) return routed;
  return routed.map((window) =>
    window.label.endsWith(" routing ceiling") ? window : { ...window, usedPct: null },
  );
}

/**
 * Assess whether every visible gating window has enough room to bridge the task to completion or its
 * own reset. A reset inside the expected task duration reduces the reserve needed BEFORE that reset;
 * a reset after completion (or an unknown reset) requires the whole estimated burn up front.
 */
export function assessCapacity(windows: readonly CapacityWindow[], demand: CapacityDemand, now = Date.now()): CapacityAssessment {
  const visible = windows.filter((window) => window.usedPct != null);
  if (!visible.length) return { status: "unknown", marginPct: null, windows: [] };

  const assessed = visible.map((window): WindowAssessment => {
    const resetPassed = window.resetAt != null && window.resetAt <= now;
    const remainingPct = resetPassed ? 100 : Math.max(0, 100 - clampPct(window.usedPct!));
    const fractionBeforeReset = resetPassed
      ? 0
      : window.resetAt != null && window.resetAt < now + demand.expectedDurationMs
        ? Math.max(0, (window.resetAt - now) / demand.expectedDurationMs)
        : 1;
    const requiredPct = Math.min(100, demand.reservePct + demand.expectedBurnPct * windowBurnWeight(window) * fractionBeforeReset);
    return {
      label: window.label,
      remainingPct,
      requiredPct,
      resetAt: window.resetAt,
      marginPct: remainingPct - requiredPct,
    };
  });
  const limiting = assessed.reduce((worst, item) => (item.marginPct < worst.marginPct ? item : worst));
  return {
    status: limiting.marginPct >= 0 ? "viable" : "at-risk",
    marginPct: limiting.marginPct,
    limiting,
    windows: assessed,
  };
}

/**
 * Keep only the safest capacity tier: known-viable first, then unmetered/unknown, then the least-risky
 * known candidates. Existing reset/spread policy remains the tiebreak *inside* that tier.
 */
export function preferCapacity<T>(
  candidates: readonly T[],
  windowsFor: (candidate: T) => readonly CapacityWindow[],
  demand: CapacityDemand,
  now = Date.now(),
): CapacitySelection<T> {
  const assessments = new Map<T, CapacityAssessment>();
  for (const candidate of candidates) assessments.set(candidate, assessCapacity(windowsFor(candidate), demand, now));
  const viable = candidates.filter((candidate) => assessments.get(candidate)!.status === "viable");
  if (viable.length) {
    return { candidates: [...viable], assessments, allKnownAtRisk: false, constrained: viable.length < candidates.length };
  }
  const unknown = candidates.filter((candidate) => assessments.get(candidate)!.status === "unknown");
  if (unknown.length) {
    return { candidates: [...unknown], assessments, allKnownAtRisk: false, constrained: unknown.length < candidates.length };
  }
  if (!candidates.length) return { candidates: [], assessments, allKnownAtRisk: false, constrained: false };
  const bestMargin = Math.max(...candidates.map((candidate) => assessments.get(candidate)!.marginPct ?? Number.NEGATIVE_INFINITY));
  const leastRisky = candidates.filter((candidate) => assessments.get(candidate)!.marginPct === bestMargin);
  return { candidates: [...leastRisky], assessments, allKnownAtRisk: true, constrained: leastRisky.length < candidates.length };
}

/** Earliest future reset after which this target can cover the demand; null if no known reset can. */
export function nextViableAt(windows: readonly CapacityWindow[], demand: CapacityDemand, now = Date.now()): number | null {
  if (assessCapacity(windows, demand, now).status === "viable") return now;
  const resets = [...new Set(windows.map((window) => window.resetAt).filter((at): at is number => at != null && at > now))].sort((a, b) => a - b);
  for (const at of resets) {
    const after = windows.map((window) =>
      window.resetAt != null && window.resetAt <= at
        ? { ...window, usedPct: 0, resetAt: null }
        : window,
    );
    if (assessCapacity(after, demand, at).status === "viable") return at;
  }
  return null;
}

/** Compact, operator-facing explanation used in task findings and cap-wait messages. */
export function describeCapacity(target: CapacityTarget, demand: CapacityDemand, now = Date.now()): string {
  const assessment = assessCapacity(target.windows, demand, now);
  const meters = target.windows
    .map((window) => {
      if (window.usedPct == null) return `${window.label} meter unknown`;
      const free = window.resetAt != null && window.resetAt <= now ? 100 : Math.max(0, 100 - clampPct(window.usedPct));
      const reset = window.resetAt == null ? "reset unknown" : `resets ${formatUntil(window.resetAt, now)}`;
      return `${window.label} ${round(free)}% free (${reset})`;
    })
    .join(" · ");
  if (assessment.status === "unknown") return `${target.label}: ${meters || "quota telemetry unavailable"} — runway unknown`;
  const limiting = assessment.limiting!;
  const verdict = assessment.status === "viable"
    ? `enough runway for ${demand.label}`
    : `at risk for ${demand.label}: ${round(limiting.remainingPct)}% ${limiting.label} free vs ~${round(limiting.requiredPct)}% needed before completion/reset`;
  return `${target.label}: ${meters} — ${verdict}`;
}

export function demandSummary(demand: CapacityDemand): string {
  return `${demand.label} (~${formatDuration(demand.expectedDurationMs)}, ~${round(demand.expectedBurnPct)}% estimated window burn + ${round(demand.reservePct)}% reserve)`;
}

export function formatUntil(at: number, now = Date.now()): string {
  const ms = at - now;
  if (ms <= 0) return "now";
  if (ms < HOUR_MS) return `in ${Math.max(1, Math.ceil(ms / MINUTE_MS))}m`;
  if (ms < 48 * HOUR_MS) return `in ${Math.round(ms / HOUR_MS)}h`;
  return `in ${Math.round(ms / (24 * HOUR_MS))}d`;
}

function formatDuration(ms: number): string {
  if (ms < HOUR_MS) return `${Math.max(1, Math.round(ms / MINUTE_MS))}m`;
  const hours = ms / HOUR_MS;
  return hours < 10 ? `${Math.round(hours * 10) / 10}h` : `${Math.round(hours)}h`;
}

function finitePct(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? clampPct(value) : null;
}

function finiteEpoch(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clampPct(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function windowBurnWeight(window: CapacityWindow): number {
  if (typeof window.burnWeight === "number" && Number.isFinite(window.burnWeight)) return Math.max(0, window.burnWeight);
  const label = window.label.toLowerCase();
  if (label.includes("monthly")) return 0.1;
  if (label.includes("weekly") || label.includes("7d")) return 0.2;
  return 1;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
