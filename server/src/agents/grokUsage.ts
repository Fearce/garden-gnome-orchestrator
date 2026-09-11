import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { readGrokAuth } from "./grokRunner.js";
import { allowanceReopened, readingIsStale, windowStillSpent, type AllowanceEvidence } from "./usageFreshness.js";

/**
 * Grok (SuperGrok) usage for the top-bar chip AND provider routing.
 *
 * Sources (best → fallback), merged by grokUsagePing:
 *  1. CLI log `billing: fetched credits config` — real weekly used-% + period end + SuperGrok tier
 *  2. HTTP `GET https://cli-chat-proxy.grok.com/v1/billing` — monthly credit used/limit (OAuth works)
 *  3. winpty TUI scrape of `/usage show` — weekly used-% when the log is cold
 *  4. Live-run cap latch — fallback when a turn is rejected for quota
 *
 * With a real weekly reset, Grok competes in provider routing by soonest weekly reset exactly like
 * Claude/Codex.
 */
export interface GrokUsageDTO {
  signedIn: boolean;
  email: string | null;
  tier: number | null; // SuperGrok plan tier from the OAuth token / auth entry, if present
  plan: string | null; // e.g. "SuperGrok" from the billing config, if known
  sevenDay: number | null; // weekly used-percent (0-100), else null
  sevenDayReset: number | null; // epoch ms the weekly window resets, else null
  monthlyUsed: number | null; // monthly credit units used (HTTP billing), else null
  monthlyLimit: number | null; // monthly credit unit cap, else null
  monthlyReset: number | null; // epoch ms the monthly billing period ends, else null
  capUntil: number | null; // epoch ms a live-run usage-cap rejection is latched until, else null
  stale?: boolean; // the reading hasn't refreshed within the freshness window
  error?: string | null; // last soft failure reason when meters are missing (chip surfaces it)
  updatedAt: number; // epoch ms of this read
}

/** Weekly meter snapshot (from log scrape or winpty `/usage show`). */
interface GrokWeeklyScrape {
  sevenDay: number;
  sevenDayReset: number | null;
  plan?: string | null;
  at: number;
  source: "log" | "winpty" | "cache";
}

/** Monthly credit snapshot from the HTTP billing endpoint. */
interface GrokMonthlyScrape {
  monthlyUsed: number;
  monthlyLimit: number;
  monthlyReset: number | null;
  at: number;
}

let liveWeekly: GrokWeeklyScrape | null = null;
let liveMonthly: GrokMonthlyScrape | null = null;
let lastError: string | null = null;

// A scrape older than this reads as stale (the chip dims it). ~2.5× the default HTTP/log poll so a
// transient failure doesn't immediately blank the meter.
export const GROK_SCRAPE_STALE_MS = 40 * 60_000;

// Mirrored cap latch (authoritative copy lives in the thread manager, kv-persisted).
let capUntil: number | null = null;

const CACHE_FILE = (): string => join(config.dataDir, "grok-usage-cache.json");

interface GrokUsageCache {
  sevenDay?: number;
  sevenDayReset?: number | null;
  plan?: string | null;
  monthlyUsed?: number;
  monthlyLimit?: number;
  monthlyReset?: number | null;
  /** When each meter was READ. A single shared `at` cannot describe two independently-aged readings,
   *  and the freshness rule is only sound on the reading clock — see `usageFreshness.ts`. `at` is kept
   *  as the older single-stamp form so a downgrade still paints a chip. */
  weeklyAt?: number;
  monthlyAt?: number;
  at?: number;
}

/** Load the last successful reading from disk so a restart paints the chip immediately (stale until the
 *  first live ping lands). Never throws. */
function loadCache(): void {
  try {
    const raw = readFileSync(CACHE_FILE(), "utf8");
    const c = JSON.parse(raw) as GrokUsageCache;
    if (typeof c.sevenDay === "number" && Number.isFinite(c.sevenDay)) {
      liveWeekly = {
        sevenDay: Math.min(100, Math.max(0, c.sevenDay)),
        sevenDayReset: typeof c.sevenDayReset === "number" ? c.sevenDayReset : null,
        plan: typeof c.plan === "string" ? c.plan : null,
        // A legacy cache carries only `at`, which was a WRITE clock (`max(..., Date.now())`). Adopting
        // it as a read clock would resurrect every frozen meter as brand new on the first boot after
        // this ships. An unknown read time is 0 — i.e. stale — and the next poll repairs it.
        at: typeof c.weeklyAt === "number" ? c.weeklyAt : 0,
        source: "cache",
      };
    }
    if (typeof c.monthlyUsed === "number" && typeof c.monthlyLimit === "number" && c.monthlyLimit > 0) {
      liveMonthly = {
        monthlyUsed: c.monthlyUsed,
        monthlyLimit: c.monthlyLimit,
        monthlyReset: typeof c.monthlyReset === "number" ? c.monthlyReset : null,
        at: typeof c.monthlyAt === "number" ? c.monthlyAt : 0, // see the weekly note above
      };
    }
  } catch {
    /* missing/corrupt — start empty */
  }
}

function persistCache(): void {
  try {
    // Never Date.now(): the write clock would re-date a meter that has not been re-read, and after a
    // restart a frozen reading would come back looking brand new — the exact inversion the freshness
    // rule exists to prevent.
    const body: GrokUsageCache = {
      sevenDay: liveWeekly?.sevenDay,
      sevenDayReset: liveWeekly?.sevenDayReset ?? null,
      plan: liveWeekly?.plan ?? null,
      monthlyUsed: liveMonthly?.monthlyUsed,
      monthlyLimit: liveMonthly?.monthlyLimit,
      monthlyReset: liveMonthly?.monthlyReset ?? null,
      weeklyAt: liveWeekly?.at,
      monthlyAt: liveMonthly?.at,
      at: Math.max(liveWeekly?.at ?? 0, liveMonthly?.at ?? 0),
    };
    writeFileSync(CACHE_FILE(), JSON.stringify(body), "utf8");
  } catch {
    /* best-effort */
  }
}

// Warm from disk on first import so hello/WS paint a meter even before the first ping completes.
loadCache();

/** Record (or clear, with null) the latched usage-cap deadline for the chip. */
export function noteGrokCap(until: number | null): void {
  capUntil = until;
}

/** Record a fresh weekly reading (log or winpty). Called by grokUsagePing on every successful read. */
export function noteGrokUsageScrape(
  sevenDay: number,
  sevenDayReset: number | null,
  opts?: { plan?: string | null; source?: GrokWeeklyScrape["source"]; at?: number },
): void {
  // `at` is the moment the READING was taken. The CLI log source must pass the line's own timestamp:
  // a billing line lingering in the tail is re-read on every poll, and stamping it `now` would make a
  // frozen meter permanently fresh — defeating both the rollover guard and the rescrape gate.
  const now = Date.now();
  // Clamped to the read clock: a forward-skewed stamp would be permanently fresh AND permanently
  // newer than any recorded cap, so one bad line could lift every latch on sight.
  const at = Math.min(opts?.at ?? now, now);
  // A meter's reading time never moves backwards. The CLI log keeps re-offering the same lingering
  // billing line on every poll, and without this it would clobber a newer winpty scrape each time.
  if (liveWeekly && at < liveWeekly.at) return;
  liveWeekly = {
    sevenDay: Math.min(100, Math.max(0, sevenDay)),
    sevenDayReset,
    plan: opts?.plan ?? liveWeekly?.plan ?? null,
    at,
    source: opts?.source ?? "winpty",
  };
  lastError = null;
  persistCache();
}

/** Record a fresh monthly credit reading from the HTTP billing endpoint. `at` is the moment the reading
 *  was taken; it is clamped to the read clock for the same reason `noteGrokUsageScrape`'s is. */
export function noteGrokMonthly(
  monthlyUsed: number,
  monthlyLimit: number,
  monthlyReset: number | null,
  at?: number,
): void {
  if (!Number.isFinite(monthlyUsed) || !Number.isFinite(monthlyLimit)) return;
  if (!(monthlyLimit > 0)) {
    // The endpoint answered and reported no metered monthly pool. Retiring the previous reading is the
    // point: a pinned snapshot whose reset is already past reads as a rollover — i.e. as free — forever.
    liveMonthly = null;
    persistCache();
    return;
  }
  const now = Date.now();
  liveMonthly = {
    monthlyUsed: Math.max(0, monthlyUsed),
    monthlyLimit,
    monthlyReset,
    at: Math.min(at ?? now, now),
  };
  lastError = null;
  persistCache();
}

/** Soft failure note for the chip when no meter is available yet. Cleared on the next success. */
export function noteGrokUsageError(msg: string | null): void {
  lastError = msg;
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** Parse the CLI's `Next reset: <Month Day, HH:MM>` (24-hour, no year, server-local) into an epoch ms —
 *  the next occurrence at/after `now`, rolling the year over when the date has already passed. Returns
 *  null when the text has no parseable reset. */
export function parseGrokReset(text: string, now: number): number | null {
  const m = /Next reset:\s*([A-Za-z]{3,})\s+(\d{1,2}),?\s*(\d{1,2}):(\d{2})/i.exec(text);
  if (!m) return null;
  const mon = MONTHS[m[1]!.slice(0, 3).toLowerCase()];
  if (mon == null) return null;
  const day = parseInt(m[2]!, 10);
  const hh = parseInt(m[3]!, 10);
  const mm = parseInt(m[4]!, 10);
  if (day < 1 || day > 31 || hh > 23 || mm > 59) return null;
  const d = new Date(now);
  let t = new Date(d.getFullYear(), mon, day, hh, mm, 0, 0).getTime();
  const parsed = new Date(t);
  if (parsed.getMonth() !== mon || parsed.getDate() !== day) return null;
  // A weekly reset is always in the future; if the computed date already passed, it's next year.
  if (t <= now - 60_000) t = new Date(d.getFullYear() + 1, mon, day, hh, mm, 0, 0).getTime();
  return t;
}

/** Extract the weekly used-percent + reset epoch from a `/usage show` render (ANSI already tolerated by
 *  the loose patterns). Returns nulls when the text doesn't carry a reading. */
export function parseGrokUsage(raw: string, now: number): { sevenDay: number | null; sevenDayReset: number | null } {
  const pct = /Weekly limit:\s*(\d{1,3})\s*%/i.exec(raw);
  const sevenDay = pct ? Math.min(100, Math.max(0, parseInt(pct[1]!, 10))) : null;
  return { sevenDay, sevenDayReset: sevenDay != null ? parseGrokReset(raw, now) : null };
}

/**
 * Parse one CLI unified.jsonl line (or a blob of them) for the latest SuperGrok weekly credits config.
 * The CLI logs `billing: fetched credits config` with `creditUsagePercent` + weekly period end whenever
 * a TUI session boots — cheaper and more reliable than re-driving the TUI ourselves.
 */
export function parseGrokCreditsLog(raw: string, now = Date.now()): {
  sevenDay: number;
  sevenDayReset: number | null;
  plan: string | null;
  /** The log line's OWN timestamp — the moment this reading was taken, not the moment we read it. */
  at: number;
} | null {
  let best: { sevenDay: number; sevenDayReset: number | null; plan: string | null; ts: number } | null = null;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.includes("fetched credits config") || !line.includes("creditUsagePercent")) continue;
    let obj: {
      ts?: string;
      msg?: string;
      ctx?: {
        config?: {
          creditUsagePercent?: number;
          currentPeriod?: { end?: string; type?: string };
          billingPeriodEnd?: string;
        };
        subscriptionTier?: string | null;
      };
    };
    try {
      obj = JSON.parse(line) as typeof obj;
    } catch {
      continue;
    }
    if (obj.msg !== "billing: fetched credits config") continue;
    const pct = obj.ctx?.config?.creditUsagePercent;
    if (typeof pct !== "number" || !Number.isFinite(pct)) continue;
    const endIso = obj.ctx?.config?.currentPeriod?.end ?? obj.ctx?.config?.billingPeriodEnd ?? null;
    let sevenDayReset: number | null = null;
    if (endIso) {
      const t = Date.parse(endIso);
      if (Number.isFinite(t)) sevenDayReset = t;
    }
    // A line that cannot state when it was written cannot vouch for the age of its own reading, and
    // dating it to the read clock is exactly how a frozen meter stays permanently fresh. Skip it.
    const ts = obj.ts ? Date.parse(obj.ts) : NaN;
    if (!Number.isFinite(ts)) continue;
    // A forward-skewed stamp would read as fresh AND as newer than any recorded cap, so it could lift
    // a live latch on its own. The read clock is the ceiling.
    const at = Math.min(ts, now);
    const plan = typeof obj.ctx?.subscriptionTier === "string" ? obj.ctx.subscriptionTier : null;
    if (!best || at >= best.ts) {
      best = { sevenDay: Math.min(100, Math.max(0, Math.round(pct))), sevenDayReset, plan, ts: at };
    }
  }
  return best ? { sevenDay: best.sevenDay, sevenDayReset: best.sevenDayReset, plan: best.plan, at: best.ts } : null;
}

/** Parse the HTTP `/v1/billing` JSON body into monthly credit fields. */
export function parseGrokBillingHttp(body: unknown): {
  monthlyUsed: number;
  monthlyLimit: number;
  monthlyReset: number | null;
} | null {
  if (!body || typeof body !== "object") return null;
  const cfg = (body as { config?: Record<string, unknown> }).config;
  if (!cfg || typeof cfg !== "object") return null;
  const used = numVal(cfg.used);
  const limit = numVal(cfg.monthlyLimit);
  // A parseable `monthlyLimit: 0` is the plan STATING it meters no monthly credit pool — a real answer,
  // passed through so noteGrokMonthly can retire a stale pool. Only an unreadable body is a failure.
  if (used == null || limit == null) return null;
  const endIso = typeof cfg.billingPeriodEnd === "string" ? cfg.billingPeriodEnd : null;
  const monthlyReset = endIso && Number.isFinite(Date.parse(endIso)) ? Date.parse(endIso) : null;
  return { monthlyUsed: used, monthlyLimit: limit, monthlyReset };
}

function numVal(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (v && typeof v === "object" && typeof (v as { val?: unknown }).val === "number") {
    const n = (v as { val: number }).val;
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Pull the SuperGrok plan tier out of a JWT access token payload when auth.json omits `tier`. */
export function tierFromAccessToken(token: string | null | undefined): number | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const b64 = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const json = Buffer.from(pad, "base64").toString("utf8");
    const payload = JSON.parse(json) as { tier?: unknown };
    return typeof payload.tier === "number" ? payload.tier : null;
  } catch {
    return null;
  }
}

/** Whether Grok is exhausted per the latest meters — weekly used ≥ 100 with a future reset, OR monthly
 *  credits fully spent before the billing period ends. Best-effort under the live-run cap latch. */
export function grokUsageCapped(now: number): boolean {
  const weeklySpent =
    !!liveWeekly &&
    windowStillSpent(
      {
        atLimit: liveWeekly.sevenDay >= 100,
        resetAt: liveWeekly.sevenDayReset,
        readingAt: liveWeekly.at,
        staleAfterMs: GROK_SCRAPE_STALE_MS,
      },
      now,
    );
  const monthlySpent =
    !!liveMonthly &&
    liveMonthly.monthlyLimit > 0 &&
    windowStillSpent(
      {
        atLimit: liveMonthly.monthlyUsed >= liveMonthly.monthlyLimit,
        resetAt: liveMonthly.monthlyReset,
        readingAt: liveMonthly.at,
        staleAfterMs: GROK_SCRAPE_STALE_MS,
      },
      now,
    );
  return weeklySpent || monthlySpent;
}

/** Whether the weekly meter is fresh enough to act on. The winpty rescrape is gated on this rather than
 *  on the meter merely EXISTING: a frozen weekly reading otherwise satisfies "we have one" forever and
 *  permanently disables the only source that could refresh it. */
export function grokWeeklyIsFresh(now = Date.now()): boolean {
  return !!liveWeekly && !readingIsStale(liveWeekly.at, GROK_SCRAPE_STALE_MS, now);
}

/** Highest used-percent that still counts as reopened (mirrors Codex's threshold). */
export const GROK_REOPENED_ALLOWANCE_MAX_PCT = 50;

/** Whether Grok's own live meters, read after a cap was recorded, show headroom again. See
 *  `allowanceReopened`; the monthly pool contributes only when it actually meters a limit. */
export function grokAllowanceReopened(capRecordedAt: number | undefined, now = Date.now()): AllowanceEvidence {
  // The weekly window is what Grok actually gates on, so monthly credits alone are never a disproof:
  // a fresh credit reading beside a frozen weekly would otherwise carry the lift on its own.
  if (!liveWeekly) return { reopened: false, reason: "no Grok weekly reading" };
  const monthlyPct =
    liveMonthly && liveMonthly.monthlyLimit > 0
      ? Math.min(100, (liveMonthly.monthlyUsed / liveMonthly.monthlyLimit) * 100)
      : null;
  return allowanceReopened(
    "Grok",
    capRecordedAt,
    {
      meters: [
        { usedPct: liveWeekly.sevenDay, readingAt: liveWeekly.at },
        { usedPct: monthlyPct, readingAt: liveMonthly?.at ?? null },
      ],
      staleAfterMs: GROK_SCRAPE_STALE_MS,
      maxUsedPct: GROK_REOPENED_ALLOWANCE_MAX_PCT,
    },
    now,
  );
}

/** The current identity + meters + cap state for the chip and routing. Never throws — a missing login
 *  reads as signed-out, a missing scrape leaves the meter null (the chip shows what it can). */
export function readGrokUsage(): GrokUsageDTO {
  const auth = readGrokAuth();
  const now = Date.now();
  if (capUntil != null && capUntil <= now) capUntil = null;
  const weekly = liveWeekly;
  const monthly = liveMonthly;
  // STALEST, never freshest. The monthly HTTP ping succeeds on every poll, so `max()` let a fresh
  // credit reading vouch for a frozen weekly — and `stale` is what the chip dims and what
  // `capacityWindowsWithFreshness` hands to routing. One meter's age may not speak for another's.
  const ages = [weekly?.at, monthly?.at].filter((at): at is number => typeof at === "number");
  const stale = ages.length ? ages.some((at) => readingIsStale(at, GROK_SCRAPE_STALE_MS, now)) : undefined;
  // Prefer a plan name from the weekly log; otherwise map a known tier number.
  const plan = weekly?.plan ?? (auth.tier === 1 || tierFromAccessToken(readGrokAccessTokenRaw()) === 1 ? "SuperGrok" : null);
  const tier = auth.tier ?? tierFromAccessToken(readGrokAccessTokenRaw());
  return {
    signedIn: auth.signedIn,
    email: auth.email,
    tier,
    plan,
    sevenDay: weekly?.sevenDay ?? null,
    sevenDayReset: weekly?.sevenDayReset ?? null,
    monthlyUsed: monthly?.monthlyUsed ?? null,
    monthlyLimit: monthly?.monthlyLimit ?? null,
    monthlyReset: monthly?.monthlyReset ?? null,
    capUntil,
    stale,
    error: weekly || monthly ? null : lastError,
    updatedAt: now,
  };
}

/** Read the raw OAuth access token from ~/.grok/auth.json (newest entry). Used by the HTTP billing ping.
 *  Returns null when unsigned-in / unreadable — never throws. */
export function readGrokAccessTokenRaw(): string | null {
  const file = join(config.grok.home, "auth.json");
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, { key?: string; refresh_token?: string }>;
    const entries = Object.values(parsed).filter((e) => e && (e.key || e.refresh_token));
    if (!entries.length) return null;
    const key = entries[entries.length - 1]!.key?.trim();
    return key || null;
  } catch {
    return null;
  }
}

export const __grokUsageTestHooks = {
  /** Drop the weekly meter so a gate can assert what monthly credits alone may (not) prove. */
  clearWeekly(): void {
    liveWeekly = null;
  },
};
