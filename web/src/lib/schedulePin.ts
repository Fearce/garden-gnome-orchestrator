import type { ImplementorProvider, ScheduledTask } from "../types.js";

/** Provider value for a pin this console cannot attribute to a backend — see `storedPin`. */
export const AS_REQUESTED = "__requested" as const;

/** What the editor's provider select can hold: `""` is automatic routing. */
export type PinProvider = ImplementorProvider | "" | typeof AS_REQUESTED;

export interface StoredPin {
  /** null for a pin the server still re-reads as owner wording on every fire. */
  provider: ImplementorProvider | null;
  model: string;
}

/** Just the roster shape `storedPin` reads, so this stays a pure function of data (`taskModelTargets`
 *  is the caller's job) and the gate can drive it without mounting a component. */
interface ProviderRoster {
  provider: ImplementorProvider;
  models: readonly string[];
}

/**
 * The saved pin, with its backend resolved when the row predates the `provider` column.
 *
 * Two shapes exist on disk: a pair chosen from the picker, and a bare `model` string from before it,
 * which dispatch re-reads as owner WORDING on every fire. An id a live roster publishes is upgraded to
 * the pair; anything else is kept verbatim, because interpreting wording is the server's job — guessing
 * at it here would silently repoint the owner's schedule at a different backend, and dropping it would
 * turn one save into an unnoticed loss of the pin.
 */
export function storedPin(rosters: readonly ProviderRoster[], sched: ScheduledTask | null): StoredPin | null {
  const model = sched?.model?.trim();
  if (!model) return null;
  if (sched?.provider) return { provider: sched.provider, model };
  for (const roster of rosters) {
    const exact = roster.models.find((m) => m.toLowerCase() === model.toLowerCase());
    if (exact) return { provider: roster.provider, model: exact };
  }
  return { provider: null, model };
}
