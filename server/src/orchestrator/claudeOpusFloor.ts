// Deterministic Claude model floor: every CONFIGURED Claude role model resolves to Opus 5.5 or a newer
// Opus — never an older Opus, and never Sonnet, Haiku or Fable. The one automatic way onto Sonnet is the
// task route (claudeModelRoute.ts), which ThreadManager applies beside this floor, not through it.
//
// Same defect shape as `reviewModelFloor.ts`, on the other backend. The persisted per-subscription role
// override matrix is enforced verbatim by `modelFor`, so a stored `acct1.implementor` naming the bare-major 5.0 Opus
// kept dispatching the retired predecessor long after 5.5 shipped — on every role, on every run, with
// nothing below the matrix to refuse it. `modelRoutingPolicy` already excluded retired Opus from the
// reviewed FLAGSHIP set and `filterAutoSelectionCandidates` already dropped legacy Codex ids, but
// neither sits on the path a plain configured Claude model takes. This is that enforcement point, and
// like the Codex floor it deliberately sits BELOW the matrix: deny-listing the Settings dropdown alone
// would leave every already-persisted pin running.
//
// Scope:
//  - Every non-Opus Claude tier is lifted too. Owner directive, 2026-09-27: "always use opus 5.5, never
//    use sonnet as a claude model". Adaptive auto-selection had put a Sonnet implementor on ordinary work.
//    Refined 2026-10-02: Sonnet 5.5 "excels at well-scoped tasks", so a task the route judges well-scoped
//    runs its implementor/QA (and the reader lane) on Sonnet 5.5 — a deterministic route decision, never
//    a stored setting or a free selector choice, both of which this floor still lifts.
//  - The per-task strict owner model pin (`thread.modelRequest`) is untouched, exactly as the Codex
//    floor leaves it: naming a model for one task must keep naming that model.
//  - It is a MINIMUM, not a pin. A future `claude-opus-6` is already above the floor and passes through,
//    and once the roster carries it every Opus resolves to it (the newest-in-family rule, modelFamily.ts).

import { newestInFamily } from "../agents/modelFamily.js";

/** The oldest Opus a role may run on, as a comparable number. Owner directive, 2026-09-22. */
const MIN_OPUS_VERSION = 5.5;

/** Preferred replacement whenever it is dispatchable — the current flagship, not merely "the newest
 *  Opus the catalog happens to list", so a preview/dated id cannot quietly become the default. */
export const CLAUDE_OPUS_FLOOR_MODEL = "claude-opus-5-5";

export interface ClaudeOpusTarget {
  /** The model to actually run. Equals `configured` unless a substitution was made. */
  model: string;
  /** The retired id that was replaced, for the owner-facing note. Set only on a substitution. */
  replaced?: string;
}

/**
 * The Opus version an id names, or null when it is not an Opus at all.
 *
 * Ids here are `claude-opus-<major>[-<minor>][-<snapshot date>]` (`claude-opus-6`,
 * `claude-opus-5-5`, `claude-opus-4-5-20251101`). A bare major means `.0`, and an 8-digit trailing
 * group is a snapshot date rather than a version part — reading `20251101` as the minor would rank
 * every dated build above every current one.
 */
export function claudeOpusVersion(model: string): number | null {
  const match = /^claude-opus-(\d+)(?:-(\d+))?(?:-\d{8})?$/.exec(model.trim().toLowerCase());
  if (!match) return null;
  const minor = match[2] && match[2].length < 8 ? Number(match[2]) : 0;
  return Number(match[1]) + minor / 10;
}

/** True for an Opus id below the floor. False for every non-Opus model and for Opus 5.5 or newer. */
export function isRetiredClaudeOpus(model: string): boolean {
  const version = claudeOpusVersion(model);
  return version !== null && version < MIN_OPUS_VERSION;
}

/** Every Claude tier that is not Opus, bare alias or full id (`sonnet`, `claude-sonnet-5`,
 *  `claude-3-5-haiku-20241022`, `claude-fable-5-1`). */
const NON_OPUS_CLAUDE_TIER = /^(?:claude-(?:[\d.-]+-)?)?(?:sonnet|haiku|fable|mythos)(?:[-.[]|$)/i;

/** True for any Claude model a role must not run on: a retired Opus or any non-Opus tier. False for
 *  Opus 5.5 or newer and for every non-Claude model. */
export function isDisallowedClaudeModel(model: string): boolean {
  return isRetiredClaudeOpus(model) || NON_OPUS_CLAUDE_TIER.test(model.trim());
}

/** The best Opus at or above the floor that this installation can actually dispatch. */
function replacementFor(dispatchable: readonly string[]): string | undefined {
  const current = dispatchable
    .map((model) => ({ model: model.trim(), version: claudeOpusVersion(model) }))
    .filter((entry): entry is { model: string; version: number } => entry.version !== null && entry.version >= MIN_OPUS_VERSION);
  const preferred = current.find((entry) => entry.model.toLowerCase() === CLAUDE_OPUS_FLOOR_MODEL);
  if (preferred) return preferred.model;
  return current.sort((a, b) => b.version - a.version)[0]?.model;
}

/**
 * Resolve what a role runs on Claude, given the configured model and the Claude ids this installation
 * can name right now.
 *
 * A current Opus is returned untouched. A retired Opus or any non-Opus Claude tier is replaced by
 * the floor model when the roster carries it, else by the newest Opus above the floor that it does —
 * never by a hand-written id, which is the lesson the Codex floor paid for: a model string this
 * installation's catalog does not resolve fails the whole run rather than degrading.
 *
 * When the roster carries NO current Opus the configured id passes through unchanged. That differs
 * from the Codex review floor, which blocks and routes the role elsewhere, and the difference is the
 * backend's position: Claude is the backbone here, so refusing it on a degraded catalog fetch would
 * park the whole fleet.
 */
export function claudeOpusTarget(configured: string, dispatchable: readonly string[]): ClaudeOpusTarget {
  const latest = newestInFamily(configured, dispatchable);
  if (!isDisallowedClaudeModel(latest)) return latest === configured ? { model: configured } : { model: latest, replaced: configured.trim() };
  const replacement = replacementFor(dispatchable);
  if (!replacement) return { model: configured };
  return { model: newestInFamily(replacement, dispatchable), replaced: configured.trim() };
}
