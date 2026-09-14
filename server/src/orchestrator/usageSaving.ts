import type { UsageSavingPolicy } from "../types.js";

export interface UsageSavingMeters {
  fiveHour: number | null | undefined;
  sevenDay: number | null | undefined;
}

/** A provider enters saving mode when either meter it actually exposes reaches the configured threshold.
 * Unknown meters do not trigger it; a stale last-known percentage still does, which errs toward preserving
 * the remaining allowance until a fresh reading arrives. */
export function usageSavingActive(policy: UsageSavingPolicy | undefined, meters: UsageSavingMeters): boolean {
  if (!policy?.enabled || !policy.model.trim()) return false;
  return [meters.fiveHour, meters.sevenDay].some((used) => used != null && used >= policy.thresholdPct);
}
