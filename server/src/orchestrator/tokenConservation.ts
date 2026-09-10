import type { ImplementorProvider } from "../types.js";

/**
 * Token conservation mode (Settings → Usage routing, off by default): once a subscription's or
 * backend's WEEKLY usage window sits in its last TOKEN_CONSERVATION_THRESHOLD_PCT-complement (≥90%
 * used), every role dispatched against it is capped to that provider's economy-tier model instead of a
 * flagship one — unless the window is about to roll over anyway (within
 * TOKEN_CONSERVATION_RESET_GRACE_MS), in which case there is nothing worth conserving for; fresh
 * capacity is about to land regardless.
 *
 * Scoped to Claude and Codex: those are the only two backends this codebase already splits into a
 * reviewed flagship tier and an economy tier. Grok ships a single model and z.ai has no reviewed
 * flagship/economy split, so there is nothing to downgrade there.
 *
 * This only ever adjusts the DEFAULT model-resolution path (the per-role/per-subscription override
 * matrix and its built-in fallback) — never a strict owner model pin, an auto-model-selection pick, or
 * a Co-work session's frozen first-turn target (all three resolve, or freeze, BEFORE this layer runs;
 * see the `conserve: false` opt-out `modelFor`/`providerRoleModel` take in `threadManager.ts`).
 */

/** "Last 10%" of the weekly window, as the brief states it. */
export const TOKEN_CONSERVATION_THRESHOLD_PCT = 90;

/** Don't bother conserving when the window is about to roll over anyway. */
export const TOKEN_CONSERVATION_RESET_GRACE_MS = 24 * 60 * 60 * 1000;

/** The economy-tier model each conservable provider is capped to — the brief's own examples. */
export const TOKEN_CONSERVATION_MODEL: Partial<Record<ImplementorProvider, string>> = {
  claude: "claude-sonnet-5",
  codex: "gpt-5.6-luna",
};

/**
 * Models this module has reviewed and confirmed are ALREADY economy-tier — conservation never touches
 * these (an operator's or policy's own cheap pick is exactly what conservation exists to protect from
 * further downgrade, not something to replace with a different cheap model). Every other id — including
 * one this list has never seen — is treated as conservable.
 *
 * This deliberately does NOT reuse `modelRoutingPolicy.isPolicyApprovedFlagship`: that predicate fails
 * CLOSED (an unknown id is excluded from flagship-only routing, the safe direction for THAT policy), so
 * inverting it here would make conservation fail OPEN — a brand-new or simply unlisted id (e.g. a
 * just-added Codex preview model) would silently never be conserved. This list fails the other way: an
 * id not on it is conserved by default, matching `conservationActive`'s "missing data biases toward
 * conserving" contract below. A newly released, genuinely cheap model just eats one needless downgrade
 * until this list is updated — cheap insurance against quietly burning the reserve on a model nobody has
 * reviewed for conservation yet.
 */
const TOKEN_CONSERVATION_ECONOMY_MODELS: Partial<Record<ImplementorProvider, ReadonlySet<string>>> = {
  claude: new Set(["claude-sonnet-5", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"]),
  codex: new Set(["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.4-mini", "gpt-5.3-codex-spark"]),
};

export interface ConservationWindow {
  /** Used-percent 0-100 of the weekly window, or null when there is no reading yet. */
  usedPct: number | null;
  /** The weekly window's next reset, epoch ms, or null/undefined when unknown. */
  resetAt: number | null | undefined;
}

/**
 * Whether the window is deep enough into its last stretch, and far enough from resetting, to be worth
 * conserving. Pure function of the reading and `now`, so it is trivially unit-testable.
 *
 * Missing data biases toward CONSERVING: an unknown reset is treated as "not imminent" rather than
 * "unknown, so skip it" — never restricting is the unsafe direction here, since it risks burning through
 * the remaining window and hard-capping the subscription outright, whereas conserving when the reset was
 * actually near just costs some avoidable quality for a short stretch. The same bias applies to a STALE
 * reading (`AccountDTO.stale`/a boot-restored snapshot — the caller passes the percentage straight
 * through and deliberately never consults `stale`): a
 * stale 95%-used reading still conserves, since the alternative — trusting a possibly-out-of-date "it's
 * fine" — is the direction that risks a hard cap.
 */
export function conservationActive(window: ConservationWindow, now: number): boolean {
  if (window.usedPct == null || window.usedPct < TOKEN_CONSERVATION_THRESHOLD_PCT) return false;
  if (window.resetAt != null && window.resetAt - now <= TOKEN_CONSERVATION_RESET_GRACE_MS) return false;
  return true;
}

/**
 * Apply conservation to one resolved model. A pick that is already economy-tier (an explicit Haiku
 * override, a dedicated Codex pool model, a Grok/z.ai model, or anything else on
 * `TOKEN_CONSERVATION_ECONOMY_MODELS`) passes through unchanged: conservation only ever pulls a
 * non-economy pick down to the provider's economy tier, it never substitutes a different economy model
 * for another.
 */
export function conservationResolvedModel(
  provider: ImplementorProvider,
  model: string,
  window: ConservationWindow,
  now: number,
): string {
  const cheap = TOKEN_CONSERVATION_MODEL[provider];
  if (!cheap) return model; // no reviewed economy tier for this provider (Grok / z.ai)
  if (!conservationActive(window, now)) return model;
  if (TOKEN_CONSERVATION_ECONOMY_MODELS[provider]?.has(model)) return model;
  return cheap;
}
