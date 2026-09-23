// Deterministic version floor for the Claude Opus family: never run a role on an Opus older than 5.5.
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
// Scope, deliberately narrow in three directions:
//  - Opus to Opus only. A configured Sonnet, Fable or Haiku is a chosen cheaper tier, not an outdated
//    flagship, and lifting one to Opus would spend the owner's quota on a decision they did not make.
//  - The per-task strict owner model pin (`thread.modelRequest`) is untouched, exactly as the Codex
//    floor leaves it: naming a model for one task must keep naming that model.
//  - It is a MINIMUM, not a pin. A future `claude-opus-6` is already above the floor and passes through.

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
 * A non-Opus model and an already-current Opus are returned untouched. A retired Opus is replaced by
 * the floor model when the roster carries it, else by the newest Opus above the floor that it does —
 * never by a hand-written id, which is the lesson the Codex floor paid for: a model string this
 * installation's catalog does not resolve fails the whole run rather than degrading.
 *
 * When the roster carries NO current Opus the retired id passes through unchanged. That differs from
 * the Codex review floor, which blocks and routes the role elsewhere, and the difference is the
 * backend's position: Claude is the backbone here, so refusing it on a degraded catalog fetch would
 * park the whole fleet to avoid running a model that is merely a generation old.
 */
export function claudeOpusTarget(configured: string, dispatchable: readonly string[]): ClaudeOpusTarget {
  if (!isRetiredClaudeOpus(configured)) return { model: configured };
  const replacement = replacementFor(dispatchable);
  if (!replacement) return { model: configured };
  return { model: replacement, replaced: configured.trim() };
}
