import type { TokenSafetyState } from "../types.js";

/** Which Token Safety box is on screen: the freeze itself, the post-bypass confirmation, or none. */
export type TokenSafetyBox = "freeze" | "bypassed" | null;

/** Identity of the box currently implied by the server state. A dismissal stores this key, so it hides
 *  that one freeze (or that one bypass confirmation) and never a later one. */
export function tokenSafetyBoxKey(state: TokenSafetyState): string | null {
  if (state.tripped) return `freeze:${state.trippedAt ?? 0}`;
  if (state.bypass) return `bypass:${state.bypass.at}`;
  return null;
}

export function tokenSafetyBox(state: TokenSafetyState | null, dismissed: string | null): TokenSafetyBox {
  if (!state) return null;
  const key = tokenSafetyBoxKey(state);
  if (!key || key === dismissed) return null;
  return state.tripped ? "freeze" : "bypassed";
}
