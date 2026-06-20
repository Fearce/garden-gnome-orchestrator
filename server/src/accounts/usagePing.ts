// A "super tiny" Haiku ping. Setup-tokens 403 on /api/oauth/usage, but the
// /v1/messages endpoint accepts them and every response carries the live
// `anthropic-ratelimit-unified-*` headers — exact 5h + weekly utilization for
// the token's account, for BOTH subs, with no background-file guesswork. The ping
// also *starts the window timer* the instant it's sent (used at resets).
const PING_MODEL = process.env.USAGE_PING_MODEL || "claude-haiku-4-5-20251001";

export interface PingUsage {
  fiveHour: number | null; // utilization 0-100
  sevenDay: number | null; // utilization 0-100
  fiveHourReset: number | null; // epoch ms
  sevenDayReset: number | null; // epoch ms
  fiveHourRejected: boolean;
  sevenDayRejected: boolean;
}

/**
 * Why a ping produced no usable read — so the UI can show *which* failure it is
 * instead of a silent blank:
 *  - `no-token`: no OAuth token configured (empty `CLAUDE_CODE_OAUTH_TOKEN`).
 *  - `auth`:     server answered but carried no unified rate-limit headers
 *                (a 401 / rejected token, or a non-subscription account).
 *  - `network`: fetch threw or timed out before any usable response.
 */
export type PingFailReason = "no-token" | "auth" | "network";

export type PingResult = { ok: true; usage: PingUsage } | { ok: false; reason: PingFailReason };

/** Fire a minimal Haiku message; read usage from the rate-limit response headers. */
export async function pingUsage(token: string, timeoutMs = 12_000): Promise<PingResult> {
  if (!token) return { ok: false, reason: "no-token" };
  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "user-agent": "claude-cli/2.0.0",
      },
      body: JSON.stringify({ model: PING_MODEL, max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { ok: false, reason: "network" };
  }
  const h = res.headers;
  await res.text().catch(() => ""); // drain so the socket frees
  // The unified rate-limit headers ride even a 429 (capped account), so parse
  // regardless of status; only their absence (e.g. 401) means "no usable read".
  if (!h.has("anthropic-ratelimit-unified-5h-utilization") && !h.has("anthropic-ratelimit-unified-7d-utilization")) {
    return { ok: false, reason: "auth" };
  }
  return {
    ok: true,
    usage: {
      fiveHour: pct(h.get("anthropic-ratelimit-unified-5h-utilization")),
      sevenDay: pct(h.get("anthropic-ratelimit-unified-7d-utilization")),
      fiveHourReset: epochMs(h.get("anthropic-ratelimit-unified-5h-reset")),
      sevenDayReset: epochMs(h.get("anthropic-ratelimit-unified-7d-reset")),
      fiveHourRejected: h.get("anthropic-ratelimit-unified-5h-status") === "rejected",
      sevenDayRejected: h.get("anthropic-ratelimit-unified-7d-status") === "rejected",
    },
  };
}

function pct(v: string | null): number | null {
  if (v == null) return null;
  const n = parseFloat(v) * 100; // header is a 0-1 fraction
  return Number.isFinite(n) ? n : null;
}

function epochMs(v: string | null): number | null {
  if (v == null) return null;
  const n = parseInt(v, 10) * 1000; // header is epoch seconds
  return Number.isFinite(n) ? n : null;
}
