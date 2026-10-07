/** Promotional cloud dollars only. Never count them as local prepaid usage or quota headroom. */
export interface CloudCreditsDTO {
  remaining: number;
  limit: number;
  used: number;
  expiresAt: number;
  locked: boolean;
  readAt: number;
}

export function parseCloudCredits(raw: unknown, readAt = Date.now()): CloudCreditsDTO | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  const dollars = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
  if (!dollars(v.limit_dollars) || !dollars(v.used_dollars)) return null;
  if (v.remaining_dollars != null && !dollars(v.remaining_dollars)) return null;
  const expiresAt = typeof v.resets_at === "string" ? Date.parse(v.resets_at) : NaN;
  if (!Number.isFinite(expiresAt)) return null;
  if (v.locked_reason != null && typeof v.locked_reason !== "string") return null;
  return {
    // Wire values are dollars, unlike the prepaid endpoint's cents.
    remaining: dollars(v.remaining_dollars) ? v.remaining_dollars : Math.max(0, v.limit_dollars - v.used_dollars),
    limit: v.limit_dollars, used: v.used_dollars, expiresAt,
    locked: !!v.locked_reason, readAt,
  };
}
