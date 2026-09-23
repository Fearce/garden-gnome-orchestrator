import { isGpt6Model } from "../agents/codexModelGeneration.js";
// Deterministic model floor for the REVIEW stages — QA and the auto-reviewer — on the Codex backend.
//
// The implementor's auto-selection already refuses legacy Codex ids (`filterAutoSelectionCandidates`),
// but a review agent never passes through that selector: its model comes straight out of the operator's
// per-role override matrix, so a stored `codex.qa = "gpt-5.5"` was enforced verbatim on every QA run —
// 270 of them between 2026-08-27 and the owner's second complaint. This is the enforcement point that
// stored value cannot bypass, and it deliberately sits BELOW the matrix rather than beside it: a
// deny-list that only filters the Settings dropdown leaves every already-persisted pin running.
//
// Out of scope by design: the implementor's own auto-selection path and the per-task strict model pin
// (`thread.modelRequest`, implementor-only). Naming a model for one task must keep working exactly.

import { isLegacyCodexAutoModel, isPreferredCodexAutoModel } from "./modelSelector.js";
import type { CodexEffort, Role } from "../types.js";

/** The two review stages. Both read a verdict on someone else's work rather than producing it. */
const REVIEW_ROLES: ReadonlySet<Role> = new Set(["qa", "reviewer"]);

/**
 * Cheapest-first preference among the GPT-5.6 tiers. Luna leads because the roster's own note already
 * says a low/medium-effort Luna should beat legacy GPT-5.5/5.4 on both quality and cost — which is the
 * substitution this floor is making. Matched as a prefix so a dated/suffixed variant still qualifies.
 */
const REPLACEMENT_PREFERENCE: readonly RegExp[] = [
  /^gpt-6-luna(?:[-.]|$)/i,
  /^gpt-6-sol(?:[-.]|$)/i,
  /^gpt-5\.6-luna(?:[-.]|$)/i,
  /^gpt-5\.6-terra(?:[-.]|$)/i,
  /^gpt-5\.6-sol(?:[-.]|$)/i,
];

/** The effort a substituted review model runs at: the owner's "gpt-5.6 at low effort as the cheap
 *  default where gpt-5.5 would have been picked". It applies ONLY to a substitution — an operator who
 *  pins a current Codex model for review keeps the configured effort. */
export const REVIEW_SUBSTITUTE_EFFORT: CodexEffort = "low";

export interface CodexReviewTarget {
  /** The model to actually run. Equals `configured` unless a substitution was made. */
  model: string;
  /** Set only on a substitution, and then it overrides the configured Codex effort. */
  effort?: CodexEffort;
  /** The excluded legacy id, for the owner-facing note. Set only on a substitution. */
  replaced?: string;
  /** True when a legacy id had to be refused and nothing current was dispatchable to take its place. */
  blocked?: boolean;
}

export function isReviewFloorRole(role: Role): boolean {
  return REVIEW_ROLES.has(role);
}

/** Whether this exact model is one a review stage may run on. */
export function reviewModelAllowed(model: string): boolean {
  return isGpt6Model(model);
}

function firstMatch(dispatchable: readonly string[], pattern: RegExp): string | undefined {
  return dispatchable.find((model) => pattern.test(model.trim()));
}

/**
 * Resolve what a review role runs on Codex, given the configured model and the models this
 * installation can actually dispatch right now.
 *
 * A non-review role, or an already-current model, is returned untouched. A legacy id is replaced by the
 * cheapest dispatchable GPT-5.6 tier, else by any other current Codex model on the roster — never by a
 * hand-written id, because a string this installation's catalog does not resolve fails the whole run.
 */
export function codexReviewTarget(role: Role, configured: string, dispatchable: readonly string[]): CodexReviewTarget {
  dispatchable = dispatchable.filter(isGpt6Model);
  if (!isReviewFloorRole(role)) return { model: configured };
  if (reviewModelAllowed(configured)) return { model: configured, ...(dispatchable.includes(configured) ? {} : { blocked: true }) };
  const preferred = REPLACEMENT_PREFERENCE.reduce<string | undefined>(
    (found, pattern) => found ?? firstMatch(dispatchable, pattern),
    undefined,
  );
  const replacement = preferred ?? dispatchable.find((model) => isPreferredCodexAutoModel({ provider: "codex", model }));
  if (!replacement) return { model: configured, blocked: true };
  return { model: replacement, effort: REVIEW_SUBSTITUTE_EFFORT, replaced: configured.trim() };
}
