// Which Claude line runs a task: Sonnet 5.5 or Opus 5.5.
//
// Owner direction, 2026-10-02: Sonnet 5.5 "is faster and excels at well-scoped tasks. It scores super low
// on agentic coding, but super high on normal coding." So the line follows the shape of the WORK, judged
// from the evidence the route classifier already gathered (routeSelection.ts) rather than a second guess:
//
//  - Sonnet: a narrow or contained change, and work whose planner came back with a tight, concrete plan.
//  - Opus: anything open-ended or agentic — investigation, flagship risk/scale, goal steps, duration
//    windows, multi-agent splits — and every brief that is not obviously contained until a plan says so.
//
// A pure function of the route and plan, so the same task always gets the same line and the reason can be
// shown verbatim in the route note. Applying it (the matrix, pins, usage saving, pool fallback) is
// threadManager's job; nothing here knows which models are dispatchable.

import { compareModelVersions, modelFamilyVersion } from "../agents/modelFamily.js";
import type { ClaudeModelRoute, Effort, PlanOutput, RouteScope } from "../types.js";

/** The Sonnet a scoped task runs. The newest-in-family rule moves it to a newer Sonnet once installed. */
export const SCOPED_SONNET_MODEL = "claude-sonnet-5-5";

/** A Sonnet at or above the scoped model — the only Sonnet scoped routing ever dispatches. */
export function isScopedSonnetModel(model: string): boolean {
  const own = modelFamilyVersion(model);
  const scoped = modelFamilyVersion(SCOPED_SONNET_MODEL);
  return !!own && !!scoped && own.family === scoped.family && compareModelVersions(own.version, scoped.version) >= 0;
}

/** Plan size at or under which the implementor's work is "normal coding" rather than a long tool loop. */
const TIGHT_PLAN_MAX_STEPS = 4;
const TIGHT_PLAN_MAX_FILES = 3;
const HEAVY_PLAN_EFFORTS = new Set<Effort>(["high", "xhigh", "max", "ultra"]);

export interface ClaudeRouteEvidence {
  scope: RouteScope;
  usePlanner: boolean;
  /** Risk/scale signals that already made this a flagship route. */
  flagshipSignals: string[];
  riskHits: string[];
  /** Structural signals (file count, compound brief, work window, pinned heavy effort). */
  structural: string[];
  goalStep?: boolean;
  shotgun?: boolean;
  timed?: boolean;
}

const opus = (reason: string, planRefinable = false): ClaudeModelRoute => ({ tier: "opus", reason, planRefinable });
const sonnet = (reason: string, planRefinable = true): ClaudeModelRoute => ({ tier: "sonnet", reason, planRefinable });

/** The line the route alone implies. Locked Opus reasons describe agentic work no plan can shrink. */
export function routeClaudeModel(evidence: ClaudeRouteEvidence): ClaudeModelRoute {
  if (evidence.goalStep) return opus("goal step: long autonomous work stays on Opus");
  if (evidence.shotgun) return opus("multi-agent split: decomposed, agentic work stays on Opus");
  if (evidence.timed) return opus("duration window: a long autonomous run stays on Opus");
  if (evidence.flagshipSignals.length) return opus(`flagship risk or scale (${evidence.flagshipSignals.join("; ")}) stays on Opus`);
  if (evidence.riskHits.includes("open-ended/ambiguous")) return opus("open-ended investigation: agentic debugging stays on Opus");
  if (evidence.structural.length) return opus(`${evidence.structural.join("; ")}: Opus unless the planner's plan comes back tight`, true);
  if (evidence.riskHits.length) return opus(`${evidence.riskHits.join("; ")}: Opus unless the planner's plan comes back tight`, true);
  if (evidence.scope === "narrow") return sonnet("narrow, contained change: well-scoped coding runs on Sonnet");
  if (!evidence.usePlanner) return sonnet("contained change with a clear check: well-scoped coding runs on Sonnet");
  return opus("not obviously contained: Opus unless the planner's plan comes back tight", true);
}

/**
 * Re-judge a refinable line against the planner's concrete plan. A plan is tight when it names every file
 * it touches, stays within a few steps and files, leaves nothing open, needs no research and was not
 * judged high effort: the implementor then does normal coding, which is what Sonnet is for. Anything
 * else is a longer tool loop and runs on Opus. The result is final — a plan is judged once.
 */
export function planClaudeModel(route: ClaudeModelRoute, plan: PlanOutput): ClaudeModelRoute {
  if (!route.planRefinable) return route;
  const loose = looseness(plan);
  if (loose) return opus(`the plan ${loose}: Opus for the longer tool loop`);
  const files = planFiles(plan);
  return sonnet(`the planner's plan is tight (${plan.steps.length} step${plan.steps.length === 1 ? "" : "s"}, ${files.size} file${files.size === 1 ? "" : "s"}): well-scoped coding runs on Sonnet`, false);
}

/** Why a plan is not tight, or null when it is. */
function looseness(plan: PlanOutput): string | null {
  const steps = plan.steps ?? [];
  if (plan.nextAgent === "researcher") return "needs external research first";
  if (plan.openQuestions?.length) return `leaves ${plan.openQuestions.length} open question${plan.openQuestions.length === 1 ? "" : "s"}`;
  if (plan.effort && HEAVY_PLAN_EFFORTS.has(plan.effort)) return `was judged ${plan.effort} effort`;
  if (!steps.length) return "has no concrete steps";
  if (steps.length > TIGHT_PLAN_MAX_STEPS) return `spans ${steps.length} steps`;
  if (steps.some((step) => !step.files?.length)) return "has a step without named files";
  const files = planFiles(plan);
  if (files.size > TIGHT_PLAN_MAX_FILES) return `touches ${files.size} files`;
  return null;
}

function planFiles(plan: PlanOutput): Set<string> {
  return new Set((plan.steps ?? []).flatMap((step) => step.files ?? []).map((file) => file.trim().toLowerCase()).filter(Boolean));
}
