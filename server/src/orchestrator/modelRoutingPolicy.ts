// Deterministic capability floor for task-aware implementor routing.
//
// Auto-selection still judges cost, effort and local outcomes for ordinary work. A route classified as
// flagship is different: historical success or cheaper quota may choose only inside this reviewed set,
// with Claude Opus 5 preferred whenever it is dispatchable. Unknown/new model ids fail closed until the
// policy is deliberately extended; a live catalog entry alone is not evidence that it is a safe fallback.

import type { ImplementorModelPolicy, ImplementorProvider } from "../types.js";

export const DEFAULT_FLAGSHIP_MODEL = "claude-opus-5";

export interface RoutableModel {
  provider: ImplementorProvider;
  model: string;
}

export type ModelPolicyMode = "adaptive" | "preferred" | "fallback" | "blocked";

export interface ModelPolicyCandidates<T extends RoutableModel> {
  eligible: T[];
  excluded: T[];
  mode: ModelPolicyMode;
}

function normalized(model: string): string {
  return model.trim().toLowerCase();
}

/** Explicitly reviewed fallback classes. Workhorse/economy variants such as Sonnet, Terra, Luna,
 * Mini, Spark, Grok and GLM are intentionally absent. They remain valid adaptive or owner-pinned picks. */
export function isPolicyApprovedFlagship(candidate: RoutableModel): boolean {
  const model = normalized(candidate.model);
  if (candidate.provider === "claude") return /^claude-(?:opus|fable)-/.test(model);
  if (candidate.provider === "codex") return /^gpt-5(?:\.\d+)?(?:-codex|-sol)?$/.test(model);
  return false;
}

export function applyImplementorModelPolicy<T extends RoutableModel>(
  candidates: readonly T[],
  policy: ImplementorModelPolicy | null | undefined,
): ModelPolicyCandidates<T> {
  if (policy?.tier !== "flagship") {
    return { eligible: [...candidates], excluded: [], mode: "adaptive" };
  }
  const approved = candidates.filter(isPolicyApprovedFlagship);
  const preferredId = normalized(policy.preferredModel || DEFAULT_FLAGSHIP_MODEL);
  const preferred = approved.find((candidate) => normalized(candidate.model) === preferredId);
  if (preferred) {
    return {
      eligible: [preferred],
      excluded: candidates.filter((candidate) => candidate !== preferred),
      mode: "preferred",
    };
  }
  return {
    eligible: approved,
    excluded: candidates.filter((candidate) => !approved.includes(candidate)),
    mode: approved.length ? "fallback" : "blocked",
  };
}

export function modelMatchesPolicy(candidate: RoutableModel, policy: ImplementorModelPolicy | null | undefined): boolean {
  return policy?.tier !== "flagship" || isPolicyApprovedFlagship(candidate);
}
