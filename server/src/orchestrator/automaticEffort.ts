// The ceiling on every effort GGO chooses by itself — the route's fallback, the planner's judgement and
// the automatic model pick. Above it (xhigh/max/ultra) runs only when the owner named that effort
// (thread.effortOverride), and even then the per-subscription cap in Settings still bounds it.

import { EFFORTS, type Effort } from "../types.js";

export const AUTOMATIC_EFFORT_CEILING: Effort = "high";

const CEILING_RANK = EFFORTS.indexOf(AUTOMATIC_EFFORT_CEILING);

export function capAutomaticEffort(effort: Effort): Effort {
  return EFFORTS.indexOf(effort) <= CEILING_RANK ? effort : AUTOMATIC_EFFORT_CEILING;
}

/** The subset of a model's supported tiers an automatic choice may use. A model whose tiers all sit
 *  above the ceiling keeps only its lowest one, so it stays pickable at its cheapest setting. */
export function automaticEffortOptions(efforts: readonly Effort[]): Effort[] {
  const allowed = efforts.filter((effort) => EFFORTS.indexOf(effort) <= CEILING_RANK);
  if (allowed.length) return allowed;
  const lowest = EFFORTS.find((effort) => efforts.includes(effort));
  return lowest ? [lowest] : [];
}
