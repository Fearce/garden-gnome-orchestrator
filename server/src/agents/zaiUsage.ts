import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";

/**
 * z.ai (Zhipu GLM Coding Plan) usage for the top-bar chip AND provider routing.
 *
 * Source: the plan's real quota endpoint GET https://api.z.ai/api/monitor/usage/quota/limit (Bearer key,
 * no model turn — see zaiUsagePing). It returns `data.limits[]` + `data.level` (plan tier). The two windows
 * that gate our routing are the token limits, decoded by (unit, number):
 *   - TOKENS_LIMIT unit=3 number=5  → the 5-HOUR window   (`percentage` used, `nextResetTime` reset)
 *   - TOKENS_LIMIT unit=6 number=1  → the WEEKLY window
 * A third TIME_LIMIT entry meters z.ai's own built-in tools over a month (search-prime/web-reader/zread);
 * our agents don't use those, so it's ignored. With real 5h + weekly resets, z.ai competes in provider
 * routing by soonest weekly reset exactly like Claude/Codex/Grok.
 */
export interface ZaiUsageDTO {
  configured: boolean; // an API key is available (env or kv) — the chip shows even before the first ping
  plan: string | null; // plan tier from the quota response (data.level): "lite" | "pro" | "max"
  fiveHour: number | null; // 5-hour window used-percent (0-100), else null
  fiveHourReset: number | null; // epoch ms the 5-hour window resets, else null (null while the window is idle)
  sevenDay: number | null; // weekly window used-percent (0-100), else null
  sevenDayReset: number | null; // epoch ms the weekly window resets, else null
  capUntil: number | null; // epoch ms a live-run usage-cap rejection is latched until, else null
  stale?: boolean; // the reading hasn't refreshed within the freshness window
  error?: string | null; // last soft failure reason when meters are missing (chip surfaces it)
  updatedAt: number; // epoch ms of this read
}

/** A parsed quota snapshot (the meaningful subset of the endpoint response). */
export interface ZaiQuotaScrape {
  plan: string | null;
  fiveHour: number | null;
  fiveHourReset: number | null;
  sevenDay: number | null;
  sevenDayReset: number | null;
  at: number;
}

let liveUsage: ZaiQuotaScrape | null = null;
let lastError: string | null = null;
let configured = false;
// Mirrored cap latch (authoritative copy lives in the thread manager, kv-persisted).
let capUntil: number | null = null;

// A reading older than this reads as stale (the chip dims it). ~2.5× the default poll so a transient
// failure doesn't immediately blank the meter.
const SCRAPE_STALE_MS = 3 * 60_000;

const CACHE_FILE = (): string => join(config.dataDir, "zai-usage-cache.json");

interface ZaiUsageCache extends Partial<ZaiQuotaScrape> {}

/** Load the last successful reading from disk so a restart paints the chip immediately (stale until the
 *  first live ping lands). Never throws. */
function loadCache(): void {
  try {
    const c = JSON.parse(readFileSync(CACHE_FILE(), "utf8")) as ZaiUsageCache;
    if (typeof c.fiveHour === "number" || typeof c.sevenDay === "number") {
      liveUsage = {
        plan: typeof c.plan === "string" ? c.plan : null,
        fiveHour: typeof c.fiveHour === "number" ? clampPct(c.fiveHour) : null,
        fiveHourReset: typeof c.fiveHourReset === "number" ? c.fiveHourReset : null,
        sevenDay: typeof c.sevenDay === "number" ? clampPct(c.sevenDay) : null,
        sevenDayReset: typeof c.sevenDayReset === "number" ? c.sevenDayReset : null,
        at: typeof c.at === "number" ? c.at : 0,
      };
    }
  } catch {
    /* missing/corrupt — start empty */
  }
}

function persistCache(): void {
  if (!liveUsage) return;
  try {
    writeFileSync(CACHE_FILE(), JSON.stringify(liveUsage), "utf8");
  } catch {
    /* best-effort */
  }
}

// Warm from disk on first import so hello/WS paint a meter even before the first ping completes.
loadCache();

function clampPct(n: number): number {
  return Math.min(100, Math.max(0, n));
}

/** Whether an API key is available (drives the chip's "configured" state). Set by the poller each tick. */
export function noteZaiConfigured(value: boolean): void {
  configured = value;
}

/** Record (or clear, with null) the latched usage-cap deadline for the chip. */
export function noteZaiCap(until: number | null): void {
  capUntil = until;
}

/** Record a fresh quota reading. Called by zaiUsagePing on every successful poll. */
export function noteZaiUsage(scrape: Omit<ZaiQuotaScrape, "at">): void {
  liveUsage = {
    plan: scrape.plan,
    fiveHour: scrape.fiveHour != null ? clampPct(scrape.fiveHour) : null,
    fiveHourReset: scrape.fiveHourReset,
    sevenDay: scrape.sevenDay != null ? clampPct(scrape.sevenDay) : null,
    sevenDayReset: scrape.sevenDayReset,
    at: Date.now(),
  };
  lastError = null;
  persistCache();
}

/** Soft failure note for the chip when no meter is available yet. Cleared on the next success. */
export function noteZaiUsageError(msg: string | null): void {
  lastError = msg;
}

interface RawLimit {
  type?: unknown;
  unit?: unknown;
  number?: unknown;
  percentage?: unknown;
  nextResetTime?: unknown;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Parse the quota endpoint's JSON body into the 5-hour + weekly windows and the plan tier. The window
 * classification is the canonical (unit, number) mapping z.ai uses (verified against the live endpoint and
 * the opencode-glm-quota reference plugin): unit=3,number=5 = 5-hour; unit=6,number=1 = weekly. Returns
 * null when the body isn't a recognizable quota response. Never throws.
 */
export function parseZaiQuota(body: unknown): Omit<ZaiQuotaScrape, "at"> | null {
  const data = (body as { data?: { limits?: unknown; level?: unknown } } | null)?.data;
  if (!data || !Array.isArray(data.limits)) return null;
  const plan = typeof data.level === "string" ? data.level : null;
  let fiveHour: number | null = null;
  let fiveHourReset: number | null = null;
  let sevenDay: number | null = null;
  let sevenDayReset: number | null = null;
  for (const raw of data.limits as RawLimit[]) {
    if (!raw || raw.type !== "TOKENS_LIMIT") continue;
    const unit = num(raw.unit);
    const number = num(raw.number);
    const pct = num(raw.percentage);
    const reset = num(raw.nextResetTime);
    if (unit === 3 && number === 5) {
      fiveHour = pct;
      fiveHourReset = reset;
    } else if (unit === 6 && number === 1) {
      sevenDay = pct;
      sevenDayReset = reset;
    }
  }
  // A response with neither token window recognized isn't useful — signal "no reading" so the caller keeps
  // the last good meter rather than blanking it with all-nulls.
  if (fiveHour == null && sevenDay == null) return null;
  return { plan, fiveHour, fiveHourReset, sevenDay, sevenDayReset };
}

/** Whether z.ai is exhausted per the latest meters — either window used ≥ 100 with a future (or unknown)
 *  reset. Best-effort under the live-run cap latch (which the thread manager holds authoritatively). */
export function zaiUsageCapped(now: number): boolean {
  if (!liveUsage) return false;
  const spent = (pct: number | null, reset: number | null): boolean =>
    pct != null && pct >= 100 && (reset == null || reset > now);
  return spent(liveUsage.fiveHour, liveUsage.fiveHourReset) || spent(liveUsage.sevenDay, liveUsage.sevenDayReset);
}

/** The current meters + plan + cap state for the chip and routing. Never throws — a missing reading leaves
 *  the meters null (the chip shows what it can). */
export function readZaiUsage(): ZaiUsageDTO {
  const now = Date.now();
  if (capUntil != null && capUntil <= now) capUntil = null;
  const u = liveUsage;
  const stale = u && u.at > 0 ? now - u.at > SCRAPE_STALE_MS : undefined;
  return {
    configured,
    plan: u?.plan ?? null,
    fiveHour: u?.fiveHour ?? null,
    fiveHourReset: u?.fiveHourReset ?? null,
    sevenDay: u?.sevenDay ?? null,
    sevenDayReset: u?.sevenDayReset ?? null,
    capUntil,
    stale,
    error: u ? null : lastError,
    updatedAt: now,
  };
}
