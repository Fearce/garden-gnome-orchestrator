/** Read-only subscription billing check. Never buys funds, enables overage, or alters auto-reload. */
export interface PrepaidCredits {
  balance: number;
  currency: string;
  autoReload: boolean;
  enabled: boolean;
  readAt: number;
}

export function parsePrepaidCredits(raw: unknown, enabled: boolean, readAt = Date.now()): PrepaidCredits | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as { amount?: unknown; currency?: unknown; auto_reload_settings?: { enabled?: unknown } };
  if (typeof v.amount !== "number" || !Number.isFinite(v.amount) || v.amount < 0
    || typeof v.currency !== "string" || !/^[A-Z]{3}$/.test(v.currency)
    || typeof v.auto_reload_settings?.enabled !== "boolean") return null;
  return { balance: v.amount / 100, currency: v.currency, autoReload: v.auto_reload_settings.enabled, enabled, readAt };
}

/** Two default usage-read intervals (10 min each), so one late read cannot flap the fallback off. */
export const PREPAID_FRESH_MS = 20 * 60_000;

export function prepaidCreditsReady(value: PrepaidCredits | null | undefined, now = Date.now()): boolean {
  return !!value && value.enabled && !value.autoReload && value.balance > 0
    && value.readAt <= now && now - value.readAt < PREPAID_FRESH_MS;
}

export async function fetchPrepaidCredits(token: string, organizationId: string): Promise<PrepaidCredits | null> {
  if (!token.trim() || !/^[a-zA-Z0-9-]{1,80}$/.test(organizationId)) return null;
  const get = async (url: string): Promise<any> => {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token.trim()}`,
      "anthropic-beta": "oauth-2025-04-20", "user-agent": "claude-cli/2.0.0" }, signal: AbortSignal.timeout(12_000) });
    return res.ok ? res.json() : null;
  };
  try {
    const profile = await get("https://api.anthropic.com/api/oauth/profile");
    if (profile?.organization?.uuid !== organizationId) return null;
    const [balance, usage] = await Promise.all([
      get(`https://api.anthropic.com/api/oauth/organizations/${organizationId}/prepaid/credits`),
      get("https://api.anthropic.com/api/oauth/usage"),
    ]);
    return parsePrepaidCredits(balance, usage?.extra_usage?.is_enabled === true);
  } catch { return null; }
}
