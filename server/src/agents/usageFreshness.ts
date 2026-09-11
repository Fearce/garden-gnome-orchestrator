/**
 * Shared reading of one metered provider window (z.ai's 5h/weekly, Grok's weekly/monthly credits).
 *
 * The subtle half is the ROLLOVER INFERENCE. A reset timestamp already in the past normally means the
 * window rolled over, so a meter sitting at its limit is free again. That inference is only sound while
 * the READING is fresh: a scrape that stops updating leaves its reset drifting further into the past
 * every minute, so a permanently frozen exhausted pool reads as permanently free. Grok spent two days
 * being offered as a live failover rung that rejected every run it was handed, for exactly this reason.
 *
 * So a stale reading may still report a window spent; it may no longer CLEAR one on a reset it never
 * witnessed elapse. Fail closed on the inference, not on the meter.
 */
export interface UsageWindowReading {
  /** Whether the window's own meter says it is at (or past) its limit. */
  atLimit: boolean;
  /** Epoch ms the window resets, or null/undefined when the provider did not state one. */
  resetAt: number | null | undefined;
  /** Epoch ms this reading was taken — the SCRAPE time, never the time it was read back. */
  readingAt: number;
  /** How old a reading may be before it can no longer vouch for a reset having elapsed. */
  staleAfterMs: number;
}

/** Whether a window at its limit should still be treated as spent. See the module comment. */
export function windowStillSpent(reading: UsageWindowReading, now: number): boolean {
  if (!reading.atLimit) return false;
  if (reading.resetAt == null) return true; // no stated reset — nothing proves it reopened
  if (reading.resetAt > now) return true; // the reset is still ahead
  return readingIsStale(reading.readingAt, reading.staleAfterMs, now);
}

/** Whether a reading is too old to reason about. A reading from the future (clock skew) is not stale. */
export function readingIsStale(readingAt: number, staleAfterMs: number, now: number): boolean {
  return now - readingAt > staleAfterMs;
}

/**
 * Whether live telemetry proves a provider's allowance reopened after a cap was recorded, plus the
 * reason either way — the non-circular disproof Codex already has (`codexAllowanceReopened`).
 *
 * A cap latch blocks every run on that provider, so "a newer successful run disproves the stated reset"
 * can never fire: the latch is exactly what prevents that run from existing. Without a second route the
 * hold stands for its full nominal duration however wrong it was — one z.ai rejection on 2026-09-04
 * stated a weekly exhaustion resetting 6.2 days out, and the backend sat excluded for all of it while
 * z.ai's own quota endpoint reported its weekly window 6% used.
 *
 * Every clause is a veto and the default is "no": the reading must exist, be fresh, have been taken
 * strictly AFTER the cap was recorded, and show a real metered window well under the limit. Stale,
 * missing or still-spent telemetry all fail closed.
 */
export interface AllowanceEvidence {
  reopened: boolean;
  /** Why — carried into the operator-facing log line so a refusal is never silent. */
  reason: string;
}

export interface AllowanceMeter {
  /** How much of this window is used, 0-100. Null/undefined means the provider metered nothing here. */
  usedPct: number | null | undefined;
  /** Epoch ms THIS meter was read. Two windows can age independently; one shared timestamp would let a
   *  freshly-read pool vouch for a frozen one, which is the fail-open this split exists to prevent. */
  readingAt: number | null;
}

export interface AllowanceInputs {
  meters: AllowanceMeter[];
  staleAfterMs: number;
  /** Highest used-percent that still counts as reopened. */
  maxUsedPct: number;
}

export function allowanceReopened(
  provider: string,
  capRecordedAt: number | undefined,
  inputs: AllowanceInputs,
  now: number,
): AllowanceEvidence {
  const no = (reason: string): AllowanceEvidence => ({ reopened: false, reason });
  if (capRecordedAt == null) return no("no recorded cap time to compare a live reading against");
  const metered = inputs.meters.filter((m) => m.usedPct != null && Number.isFinite(m.usedPct));
  if (!metered.length) return no(`no ${provider} usage reading`);
  // EVERY contributing meter must vouch for itself. A stale one still lends its percentage to the
  // verdict, so letting a fresh sibling carry it is exactly the fail-open this guards.
  for (const m of metered) {
    if (m.readingAt == null) return no("a metered window carries no reading time");
    if (readingIsStale(m.readingAt, inputs.staleAfterMs, now)) return no("the live reading is stale");
    if (m.readingAt <= capRecordedAt) return no("the live reading is not newer than the recorded cap");
  }
  const used = Math.round(Math.max(...metered.map((m) => m.usedPct as number)));
  if (used > inputs.maxUsedPct) return no(`the busiest window is still ${used}% used`);
  const oldest = Math.min(...metered.map((m) => m.readingAt as number));
  return {
    reopened: true,
    reason: `${used}% used on the busiest window, read ${Math.round((now - oldest) / 60_000)} min ago`,
  };
}
