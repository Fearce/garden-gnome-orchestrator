/**
 * Pure decisions the recorder makes about which stream to pull and when to retry. Ported from the Dashboard
 * Deck, where each rule was paid for by an incident; the tests in `surveillancePolicy.test.ts` pin them.
 */

export const SEGMENT_SECONDS = 15 * 60;
const MAIN_RETRY_INITIAL_MS = 5 * 60_000;
const MAIN_RETRY_CAP_MS = 60 * 60_000;

export interface StreamFallback {
  url: string;
  attempts: number;
  retryMainAt: number;
}

export interface FailureStreak {
  sourceUrl: string;
  count: number;
  nextAttemptAt: number;
  lastNoteAt: number;
}

/**
 * Cameras cut their 15-minute segments at staggered clock offsets: every recorder flushing and opening a file
 * in the same second was enough to stall desktop input on the PC doing the recording.
 */
export function segmentOffsets(keys: string[], durationSeconds = SEGMENT_SECONDS): Map<string, number> {
  const unique = [...new Set(keys)].sort();
  return new Map(unique.map((key, index) => [key, Math.floor((index * durationSeconds) / unique.length)]));
}

/** A camera whose main stream stopped delivering uses its sub stream for a while, then tries main again. */
export function selectStream(candidates: string[], fallback: StreamFallback | undefined, now: number): { url: string | null; usingFallback: boolean } {
  const primary = candidates[0] ?? null;
  if (!primary) return { url: null, usingFallback: false };
  const alternate = fallback?.url && fallback.url !== primary && candidates.includes(fallback.url);
  if (!alternate || fallback!.retryMainAt <= now) return { url: primary, usingFallback: false };
  return { url: fallback!.url, usingFallback: true };
}

export function nextMainRetry(previous: StreamFallback | undefined, url: string, now: number): StreamFallback & { delayMs: number } {
  const attempts = Math.max(0, Math.trunc(previous?.attempts ?? 0)) + 1;
  const delayMs = Math.min(MAIN_RETRY_CAP_MS, MAIN_RETRY_INITIAL_MS * 2 ** Math.min(attempts - 1, 30));
  return { url, attempts, retryMainAt: now + delayMs, delayMs };
}

/** When a camera that keeps failing to connect on `sourceUrl` may be tried again; null when no streak applies. */
export function retryAt(streak: FailureStreak | undefined, sourceUrl: string): number | null {
  if (!streak || !streak.sourceUrl || streak.sourceUrl !== sourceUrl) return null;
  return Number.isFinite(streak.nextAttemptAt) ? Math.max(0, streak.nextAttemptAt) : 0;
}

/** An offline camera would otherwise respawn ffmpeg every few seconds forever; back off up to `capMs`. */
export function advanceStreak(previous: FailureStreak | undefined, sourceUrl: string, now: number, baseMs: number, capMs: number): FailureStreak {
  const same = retryAt(previous, sourceUrl) !== null;
  const count = (same ? Math.max(0, Math.trunc(previous!.count)) : 0) + 1;
  const delayMs = Math.min(Math.max(baseMs, capMs), baseMs * 1.7 ** Math.min(count - 1, 10));
  return { sourceUrl, count, nextAttemptAt: now + delayMs, lastNoteAt: same ? previous!.lastNoteAt : 0 };
}

/**
 * A recorder is stale when neither its preview frames nor its newest segment file have moved within
 * `freshMs`, after a warm-up during which a fresh process may not have produced anything yet.
 */
export function isRecorderStale(ages: { ageMs: number; frameAgeMs: number; fileAgeMs: number }, warmupMs: number, freshMs: number): boolean {
  if (ages.ageMs < warmupMs) return false;
  if (ages.frameAgeMs < freshMs) return false;
  if (ages.fileAgeMs < freshMs) return false;
  return true;
}
