import { readGrokAuth } from "./grokRunner.js";

/**
 * Grok (SuperGrok) usage for the top-bar chip AND provider routing. SuperGrok's weekly limit is real but
 * xAI's API forbids OAuth-token clients from reading it (grok.com's rate-limit endpoint returns
 * oauth2-auth-forbidden). The CLI itself, however, renders it via `/usage show` ("Weekly limit: N% · Next
 * reset: <Mon Day, HH:MM>") using the same auth.json the orchestrator has — so grokUsagePing scrapes that
 * and feeds it here as `sevenDay` (weekly used %) + `sevenDayReset` (epoch ms). With a real reset, Grok
 * competes in provider routing by soonest weekly reset exactly like Claude/Codex. `capUntil` is a
 * fallback latch for a live-run rejection when a fresh scrape isn't available.
 */
export interface GrokUsageDTO {
  signedIn: boolean;
  email: string | null;
  tier: number | null; // SuperGrok plan tier from the OAuth token, if present
  sevenDay: number | null; // weekly used-percent (0-100) scraped from `grok /usage show`, else null
  sevenDayReset: number | null; // epoch ms the weekly window resets, parsed from the scrape, else null
  capUntil: number | null; // epoch ms a live-run usage-cap rejection is latched until, else null
  stale?: boolean; // the scrape hasn't refreshed within the freshness window
  updatedAt: number; // epoch ms of this read
}

// The last successful `/usage show` scrape (weekly % + reset epoch + when it was read). Held module-wide
// so every consumer — the chip, provider routing, the cap checks — sees the same live reading.
interface GrokScrape {
  sevenDay: number;
  sevenDayReset: number | null;
  at: number; // epoch ms of the scrape
}
let liveScrape: GrokScrape | null = null;

// A scrape older than this reads as stale (the chip dims it); ~2.5× the default poll cadence, so a
// transient scrape failure doesn't immediately blank the meter.
const SCRAPE_STALE_MS = 40 * 60_000;

// Mirrored cap latch (authoritative copy lives in the thread manager, kv-persisted).
let capUntil: number | null = null;

/** Record (or clear, with null) the latched usage-cap deadline for the chip. */
export function noteGrokCap(until: number | null): void {
  capUntil = until;
}

/** Record a fresh `/usage show` scrape. Called by grokUsagePing on every successful read. */
export function noteGrokUsageScrape(sevenDay: number, sevenDayReset: number | null): void {
  liveScrape = { sevenDay, sevenDayReset, at: Date.now() };
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

/** Whether Grok's weekly window is exhausted per the latest scrape (used ≥ 100 with a real future reset).
 *  A best-effort layer under the live-run cap latch. */
export function grokUsageCapped(now: number): boolean {
  if (!liveScrape) return false;
  return liveScrape.sevenDay >= 100 && liveScrape.sevenDayReset != null && liveScrape.sevenDayReset > now;
}

/** The current identity + weekly meter + cap state for the chip and routing. Never throws — a missing
 *  login reads as signed-out, a missing scrape leaves the meter null (the chip shows what it can). */
export function readGrokUsage(): GrokUsageDTO {
  const auth = readGrokAuth();
  const now = Date.now();
  if (capUntil != null && capUntil <= now) capUntil = null; // expired latch — clear as a side effect
  const scrape = liveScrape;
  return {
    signedIn: auth.signedIn,
    email: auth.email,
    tier: auth.tier,
    sevenDay: scrape?.sevenDay ?? null,
    sevenDayReset: scrape?.sevenDayReset ?? null,
    capUntil,
    stale: scrape ? now - scrape.at > SCRAPE_STALE_MS : undefined,
    updatedAt: now,
  };
}
