// "Prepare a sub for reset" — the owner names ONE subscription to spend as fast as routing allows, because
// a banked reset is waiting for it: the reset refills the window, so allowance left unspent beforehand is
// simply lost. While a burn is active that sub outranks every soft routing preference; hard caps still win.
//
// A burn ends on its own once the window it was aimed at is gone — the weekly reset passed, or the window
// rolled early (which is exactly what spending the banked reset does) — so it cannot quietly keep steering
// work at a freshly reset sub.

import type { ImplementorProvider, ResetBurnDTO } from "../types.js";
import { CODEX_SUB_ID } from "../types.js";

/** The persisted burn. `windowReset` anchors it to the weekly window it was started against; it is null
 *  only while that window's reset is still unknown (no usage reading yet), and is filled in by the first. */
export interface ResetBurn {
  automatic?: boolean;
  subId: string;
  startedAt: number;
  windowReset: number | null;
}

/** Without a known weekly reset a burn still cannot outlive one weekly window. */
const UNANCHORED_MAX_MS = 7 * 24 * 60 * 60_000;
/** Provider reset timestamps jitter by seconds to minutes between readings; only a jump past this is a roll. */
const ROLL_TOLERANCE_MS = 60 * 60_000;

/** Subscriptions with a banked-reset programme: every Claude account and Codex. Grok and z.ai have none. */
export function resetBurnEligible(subId: string, claudeAccountIds: readonly string[]): boolean {
  return subId === CODEX_SUB_ID || claudeAccountIds.includes(subId);
}

/** The subscription a provider/account pair spends — the same id Settings and the burn use. */
export function burnSubIdOf(provider: ImplementorProvider, accountId: string): string {
  return provider === "claude" ? accountId : provider;
}

export function startResetBurn(subId: string, weeklyReset: number | null, now: number): ResetBurn {
  return { subId, startedAt: now, windowReset: weeklyReset != null && weeklyReset > now ? weeklyReset : null };
}

export function parseResetBurn(raw: string | null | undefined): ResetBurn | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const { subId, startedAt, windowReset } = value as Record<string, unknown>;
    if (typeof subId !== "string" || !subId || typeof startedAt !== "number" || !Number.isFinite(startedAt)) return null;
    const anchored = typeof windowReset === "number" && Number.isFinite(windowReset) ? windowReset : null;
    return { subId, startedAt, windowReset: anchored, ...((value as Record<string, unknown>).automatic === true ? { automatic: true } : {}) };
  } catch {
    return null;
  }
}

/** When the burn ends at the latest: the anchored weekly reset, else one weekly window after it began. */
export function resetBurnEndsAt(burn: ResetBurn): number {
  return burn.windowReset ?? burn.startedAt + UNANCHORED_MAX_MS;
}

export type ResetBurnStep =
  | { kind: "keep" }
  | { kind: "anchor"; burn: ResetBurn }
  | { kind: "end"; reason: string };

/**
 * Advance a burn against the target's latest weekly reset reading. `currentReset` is null when the
 * provider has not reported one; that never ends a burn, it just leaves it unanchored.
 */
export function stepResetBurn(burn: ResetBurn, currentReset: number | null, now: number): ResetBurnStep {
  if (now >= resetBurnEndsAt(burn)) return { kind: "end", reason: "its weekly window reset" };
  if (currentReset == null) return { kind: "keep" };
  if (burn.windowReset == null) {
    return currentReset > now ? { kind: "anchor", burn: { ...burn, windowReset: currentReset } } : { kind: "keep" };
  }
  if (currentReset > burn.windowReset + ROLL_TOLERANCE_MS) return { kind: "end", reason: "its window was reset" };
  return { kind: "keep" };
}

export function resetBurnDTO(burn: ResetBurn): ResetBurnDTO {
  return { subId: burn.subId, startedAt: burn.startedAt, endsAt: resetBurnEndsAt(burn), anchored: burn.windowReset != null };
}
