import { readFileSync } from "node:fs";

// The background "agent orchestrator" already reads Claude usage for the active
// account (the one in ~/.claude/.credentials.json) and caches it, and keeps a
// per-account snapshot in its account index. Our setup-tokens 403 on the usage
// endpoint, so we read those files (read-only, no tokens, no API calls) to fill
// the burn strip with real numbers. Paths are env-overridable; missing/garbled
// files degrade to an empty map (the strip then falls back to rate_limit_event).
const INDEX_PATH =
  process.env.TRADING_ACCOUNTS_INDEX ||
  "C:\\Users\\user\\.claude\\agent-orchestrator\\accounts\\index.json";
const CACHE_PATH =
  process.env.TRADING_USAGE_CACHE ||
  (process.env.TEMP ? `${process.env.TEMP}\\orch-claude-usage-cache.json` : "");

const LIVE_STALE_MS = 15 * 60 * 1000;

export interface TradingUsage {
  fiveHour: number | null;
  sevenDay: number | null;
  at: number; // epoch ms of the measurement
  stale: boolean; // from a per-account snapshot (or an old cache), not live
}

/** Best-available usage per account NAME (lowercased: "personal" / "myaccount"). */
export function readTradingUsage(now = Date.now()): Map<string, TradingUsage> {
  const out = new Map<string, TradingUsage>();

  const index = readJson(INDEX_PATH);
  const accounts = Array.isArray(index?.accounts) ? index.accounts : [];
  if (!accounts.length) return out;

  // The cache holds the *active* account's live usage but doesn't name it; the
  // weekly-reset day-of-week is a stable per-account fingerprint that does.
  // (Requires distinct weekly-reset DOW per account; a third sub sharing a DOW
  // would attach the cache to whichever appears first — the liveUsed guard below
  // at least caps it to one.)
  const cache = readJson(CACHE_PATH);
  const u = cache?.usage;
  const live =
    u && typeof cache.at === "number"
      ? {
          fiveHour: numOrNull(u.five_hour?.utilization),
          sevenDay: numOrNull(u.seven_day?.utilization),
          dow: dayOfWeek(u.seven_day?.resets_at),
          at: Math.round(cache.at * 1000),
        }
      : null;

  let liveUsed = false;
  for (const a of accounts) {
    const name = String(a?.name ?? "").toLowerCase();
    if (!name) continue;
    const snap = (a?.usage_snapshot ?? {}) as Record<string, unknown>;
    const snapDow = dayOfWeek(snap.weekly_reset_at as string | undefined);

    if (live && !liveUsed && live.dow != null && live.dow === snapDow) {
      liveUsed = true; // the cache belongs to exactly one account
      out.set(name, {
        fiveHour: live.fiveHour,
        sevenDay: live.sevenDay,
        at: live.at,
        stale: now - live.at > LIVE_STALE_MS,
      });
    } else {
      // Inactive account: snapshot, but null any window whose reset has passed.
      const fiveReset = Date.parse(String(snap.five_h_reset_at ?? "")) || 0;
      const weekReset = Date.parse(String(snap.weekly_reset_at ?? "")) || 0;
      out.set(name, {
        fiveHour: fiveReset && now < fiveReset ? numOrNull(snap.five_h_used_pct) : null,
        sevenDay: weekReset && now < weekReset ? numOrNull(snap.weekly_used_pct) : null,
        // Small positive fallback so a snapshot with valid data but no taken_at
        // still surfaces once (1 > initial usageAt=0) yet never beats a real run event.
        at: Date.parse(String(snap.taken_at ?? "")) || 1,
        stale: true,
      });
    }
  }
  return out;
}

function readJson(path: string): any {
  if (!path) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function dayOfWeek(iso?: string): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : new Date(t).getUTCDay();
}
