import { readGrokAuth } from "./grokRunner.js";

/**
 * Grok (SuperGrok) "usage" surface for the top-bar chip. Unlike Claude/Codex, the Grok CLI exposes NO
 * rolling rate-limit windows — the proxy has no usage endpoint and the session files persist no
 * rate_limits — so there are no 5h/weekly meters to show. What IS knowable: the signed-in identity (from
 * ~/.grok/auth.json) and whether a turn was recently rejected for hitting the plan's usage cap (latched by
 * the thread manager, mirrored here so the chip can count down to the retry). This DTO carries exactly
 * that — an honest surface, not a faked meter.
 */
export interface GrokUsageDTO {
  signedIn: boolean;
  email: string | null;
  tier: number | null; // SuperGrok plan tier from the OAuth token (1 = SuperGrok), null if unknown
  capUntil: number | null; // epoch ms a usage-cap rejection is latched until, else null (retry countdown)
  updatedAt: number; // epoch ms of this read (for the stale check)
}

// Mirrored cap latch: the authoritative one lives in the thread manager (kv-persisted, drives routing);
// this copy exists only so the broadcast chip can show "capped · retry in Xm" without threading manager
// state into the usage monitor.
let capUntil: number | null = null;

/** Record (or clear, with null) the latched usage-cap deadline for the chip. */
export function noteGrokCap(until: number | null): void {
  capUntil = until;
}

/** The current identity + cap state for the chip. Never throws — a missing login reads as signed-out. */
export function readGrokUsage(): GrokUsageDTO {
  const auth = readGrokAuth();
  const now = Date.now();
  if (capUntil != null && capUntil <= now) capUntil = null; // expired latch — clear as a side effect
  return { signedIn: auth.signedIn, email: auth.email, tier: auth.tier, capUntil, updatedAt: now };
}
