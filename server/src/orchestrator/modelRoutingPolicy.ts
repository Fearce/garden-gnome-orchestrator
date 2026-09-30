// Deterministic capability floor for task-aware implementor routing.
//
// Auto-selection still judges cost, effort and local outcomes for ordinary work. A route classified as
// flagship is different: historical success or cheaper quota may choose only inside this reviewed set,
// with Claude Opus 5.5 (or a newer Opus) preferred whenever it is dispatchable. A newer member of an
// approved line is approved with it; any other unknown id fails closed until the policy is extended — a
// live catalog entry alone is not evidence that a new LINE is a safe fallback.

import { compareModelVersions, modelFamilyVersion, newestInFamily } from "../agents/modelFamily.js";
import type { ImplementorModelPolicy, ImplementorProvider } from "../types.js";

export const DEFAULT_FLAGSHIP_MODEL = "claude-opus-5-5";

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

function gpt5Minor(model: string): number | null {
  const match = /^gpt-5\.(\d+)(?:-(?:codex|sol))?$/.exec(model);
  return match ? Number(match[1]) : null;
}

/** Explicitly reviewed fallback classes. Workhorse/economy variants such as Terra, Luna, Mini, Spark,
 * Grok and GLM are intentionally absent; they remain valid adaptive or owner-pinned picks. No Claude tier
 * but Opus 5.5 is a pick at all. */
export function isPolicyApprovedFlagship(candidate: RoutableModel): boolean {
  const model = normalized(candidate.model);
  // The preceding Opus generation is retired. A live provider catalog can continue to advertise it,
  // but that must not turn it into a reviewed fallback when 5.5 is unavailable. Fable is out too: the
  // owner runs Claude on Opus 5.5 only (claudeOpusFloor.ts).
  // Each approved line admits its newer members too (Opus 6, GPT-6.1 Sol), so a release never blocks it.
  if (candidate.provider === "claude") return atOrAbove(model, DEFAULT_FLAGSHIP_MODEL);
  if (candidate.provider === "codex") return atOrAbove(model, "gpt-6-astra") || atOrAbove(model, "gpt-6-sol") || (gpt5Minor(model) ?? 0) >= 6;
  return false;
}

/** `model` is `floor` or a newer member of `floor`'s family. */
function atOrAbove(model: string, floor: string): boolean {
  const own = modelFamilyVersion(model);
  const min = modelFamilyVersion(floor);
  return !!own && !!min && own.family === min.family && compareModelVersions(own.version, min.version) >= 0;
}

/** The approved candidate that is the preferred model or the newest member of its family. */
function preferredCandidate<T extends RoutableModel>(approved: readonly T[], preferredId: string): T | undefined {
  const newest = newestInFamily(preferredId, approved.map((candidate) => normalized(candidate.model)));
  return approved.find((candidate) => normalized(candidate.model) === newest);
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
  const preferred = preferredCandidate(approved, preferredId);
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
