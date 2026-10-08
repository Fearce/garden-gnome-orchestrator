import { setTimeout as delay } from "node:timers/promises";

/** Promotional cloud dollars only. Never count them as local prepaid usage or quota headroom. */
export interface CloudCreditsDTO {
  remaining: number;
  limit: number;
  used: number;
  expiresAt: number;
  locked: boolean;
  readAt: number;
}

export const CLOUD_CREDITS_FRESH_MS = 5 * 60_000;
export function cloudCreditsReady(value: CloudCreditsDTO | null | undefined, now = Date.now()): boolean {
  return !!value && !value.locked && value.remaining > 0 && value.expiresAt > now
    && value.readAt <= now && now - value.readAt < CLOUD_CREDITS_FRESH_MS;
}

/** No prepaid balance is required to use the promotion. Verify only identity and the overage toggle. */
export async function fetchCloudFallbackCredits(token: string, organizationId: string, request: typeof fetch = fetch,
  pause: (ms: number) => Promise<unknown> = ms => delay(ms)): Promise<CloudCreditsDTO | null> {
  const headers = { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", "user-agent": "claude-cli/2.0.0" };
  try {
    const profile = await request("https://api.anthropic.com/api/oauth/profile", { headers, signal: AbortSignal.timeout(12_000) });
    if (!profile.ok) return null;
    const identity = await profile.json() as { organization?: { uuid?: unknown } } | null;
    if (identity?.organization?.uuid !== organizationId) return null;
    const usageRead = () => request("https://api.anthropic.com/api/oauth/usage?cedar_ember=1", { headers, signal: AbortSignal.timeout(12_000) });
    let response = await usageRead();
    // The usage chip can consume the provider's read allowance just before launch. One
    // bounded read-only retry honors Retry-After; no session has been created yet.
    if (response.status === 429) {
      const retry = response.headers.get("retry-after");
      const waitMs = retry == null ? NaN : /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
      if (!Number.isFinite(waitMs) || waitMs < 0 || waitMs > CLOUD_CREDITS_FRESH_MS) return null;
      await response.body?.cancel();
      await pause(waitMs);
      response = await usageRead();
    }
    if (!response.ok) return null;
    const usage = await response.json() as { extra_usage?: { is_enabled?: unknown }; iguana_necktie?: unknown } | null;
    return usage?.extra_usage?.is_enabled === false ? parseCloudCredits(usage.iguana_necktie) : null;
  } catch { return null; }
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
