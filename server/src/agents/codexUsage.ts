import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";

/** Codex (ChatGPT-plan) usage windows, mirroring AccountDTO's 5h/weekly meters. `primary` is the rolling
 *  5-hour window, `secondary` the weekly one — both as 0-100 used-percent with an epoch-ms reset. */
export interface CodexUsageDTO {
  fiveHour: number | null;
  sevenDay: number | null;
  fiveHourReset: number | null; // epoch ms
  sevenDayReset: number | null; // epoch ms
  planType: string | null; // "plus" | "pro" | …
  updatedAt: number; // epoch ms of the turn that produced this snapshot (for the stale check)
  wakeAt?: number | null; // 5h window idle — a cheap wake turn is scheduled at this epoch ms (stagger slot)
}

interface RateLimitWindow {
  used_percent?: number;
  window_minutes?: number;
  resets_at?: number; // epoch SECONDS
}
interface RateLimits {
  primary?: RateLimitWindow | null;
  secondary?: RateLimitWindow | null;
  plan_type?: string | null;
}

/** A rate-limit window normalized from either wire shape (rollout snake_case / app-server camelCase). */
export interface MeterWindow {
  pct: number | null;
  resetMs: number | null;
  durationMins: number | null;
}

/** The DTO's four meter fields, as classified from a primary/secondary window pair. */
export type MeterFields = Pick<CodexUsageDTO, "fiveHour" | "sevenDay" | "fiveHourReset" | "sevenDayReset">;

// Windows spanning a day or more are the weekly meter; the rolling window is 5h (300 mins).
const WEEKLY_MIN_MINS = 24 * 60;

/** Map a primary/secondary window pair onto the 5h/weekly meters. The backend does NOT pin which slot
 *  holds which window: normally primary=5h and secondary=weekly, but when only the weekly window is
 *  reported (e.g. the 5h meter is idle) it arrives AS `primary` with `secondary: null` — positional
 *  mapping then paints weekly data into the 5h row. Classify by each window's own duration instead,
 *  falling back to slot position only when the duration is absent. */
export function classifyRateWindows(primary: MeterWindow | null, secondary: MeterWindow | null): MeterFields {
  const out: MeterFields = { fiveHour: null, sevenDay: null, fiveHourReset: null, sevenDayReset: null };
  const slots: Array<[MeterWindow | null, boolean]> = [
    [primary, false],
    [secondary, true],
  ];
  for (const [w, isSecondarySlot] of slots) {
    if (!w || w.pct == null) continue; // no used_percent — carries no meter info
    const weekly = w.durationMins != null ? w.durationMins >= WEEKLY_MIN_MINS : isSecondarySlot;
    if (weekly && out.sevenDay == null) {
      out.sevenDay = w.pct;
      out.sevenDayReset = w.resetMs;
    } else if (!weekly && out.fiveHour == null) {
      out.fiveHour = w.pct;
      out.fiveHourReset = w.resetMs;
    }
  }
  return out;
}

// How many recent rollout files readCodexUsage scans (newest-first) looking for the last real usage
// snapshot. Sized to ride out a burst of instant-death capped dispatches without losing the last reading.
const USAGE_SCAN_FILES = 40;
// used_percent at/above which a window counts as capped. Codex reports 100 when the plan limit is hit.
const CODEX_CAP_PCT = 100;

/** Whether the latest usage snapshot shows Codex's 5h or weekly window fully consumed (and not yet
 *  reset). A best-effort read layered under the live-run cap latch — it catches the case where the
 *  operator's own `codex` already exhausted the shared plan before the orchestrator ran a single turn. */
export function codexUsageCapped(now: number): boolean {
  const u = readCodexUsage();
  if (!u) return false;
  // Require a REAL future reset — a 100% snapshot with an unknown reset must NOT count as capped here, or
  // it would pin Codex off forever (this snapshot check is the fallback after the in-memory latch expires,
  // and unlike noteCodexCap it has no cooldown bound). The bounded live-run latch owns the reset-unknown case.
  const hit = (pct: number | null, reset: number | null): boolean =>
    pct != null && pct >= CODEX_CAP_PCT && reset != null && reset > now;
  return hit(u.fiveHour, u.fiveHourReset) || hit(u.sevenDay, u.sevenDayReset);
}

// The freshest live read from the codex app-server's account/rateLimits/read RPC (see codexUsagePing).
// Held here so readCodexUsage merges it in for EVERY consumer — the top-bar chip, provider routing, and
// the cap checks all see live data between real runs instead of a snapshot frozen at the last turn.
let livePing: CodexUsageDTO | null = null;

// A live ping older than this stops outranking the rollout snapshot: if the pings break (auth expiry,
// a CLI upgrade changing the RPC), a last-known 100%-capped reading must not pin the cap checks past
// reality — fall back to the rollout truth instead. ~3× the default ping cadence.
const LIVE_PING_MAX_AGE_MS = 30 * 60_000;

/** Record a live app-server rate-limit read. Called by the usage ping on every successful probe. */
export function noteCodexPing(usage: CodexUsageDTO): void {
  livePing = usage;
}

// When the 5h window is idle, the monitor schedules a cheap wake turn at Codex's stagger slot
// (codexUsagePing). Kept here so every readCodexUsage consumer — the top-bar chip via the hello
// event and the codex.usage broadcasts alike — sees the plan without threading monitor state around.
let plannedWakeAt: number | null = null;

/** Record (or clear, with null) the scheduled Codex wake turn. */
export function noteCodexWake(at: number | null): void {
  plannedWakeAt = at;
}

/** The codex CLI does not expose rolling rate limits over `codex exec --json`, but it PERSISTS them to
 *  the session rollout after every turn — a `token_count` event whose `rate_limits` holds the plan-wide
 *  primary/secondary windows. Reading the freshest rollout gives real usage at ZERO extra API cost,
 *  refreshed whenever Codex (here or the operator's own `codex`) actually runs. Account-wide, so the
 *  snapshot is the same regardless of which home produced it; we scan both the orchestrator's isolated
 *  CODEX_HOME and the operator's ~/.codex, fold in the latest live app-server ping (codexUsagePing), and
 *  return the most recent of them all. Returns null when nothing has produced a reading yet. */
export function readCodexUsage(): CodexUsageDTO | null {
  const homes = [config.codex.home, config.codex.sourceAuthHome];
  let best: CodexUsageDTO | null = null;
  for (const home of homes) {
    const snap = latestRollupUsage(home);
    if (snap && (!best || snap.updatedAt > best.updatedAt)) best = snap;
  }
  const pingFresh = livePing && Date.now() - livePing.updatedAt <= LIVE_PING_MAX_AGE_MS;
  if (pingFresh && (!best || livePing!.updatedAt > best.updatedAt)) best = livePing;
  if (!best) return null;
  const wakeAt = plannedWakeAt != null && plannedWakeAt > Date.now() ? plannedWakeAt : null;
  return { ...best, wakeAt };
}

/** The newest REAL codex turn's own rate-limit snapshot (freshest rollout token_count in either
 *  home), independent of the live ping — which fires without turns. Needed because a tiny turn can
 *  start a 5h window the backend doesn't REPORT yet: a fresh wake turn's own token_count shows
 *  primary=weekly, secondary=null (verified live on a plus plan), so the turn evidence is the only
 *  signal that a window is presumably rolling invisibly. `updatedAt` is the turn time; when the
 *  backend DID report the 5h window, `fiveHourReset` names that window's real reset. */
export function latestTurnSnapshot(): CodexUsageDTO | null {
  let best: CodexUsageDTO | null = null;
  for (const home of [config.codex.home, config.codex.sourceAuthHome]) {
    const snap = latestRollupUsage(home);
    if (snap && (!best || snap.updatedAt > best.updatedAt)) best = snap;
  }
  return best;
}

/** Newest `rate_limits` snapshot from the most recent rollout file under `<home>/sessions`. */
function latestRollupUsage(home: string): CodexUsageDTO | null {
  const sessions = join(home, "sessions");
  if (!existsSync(sessions)) return null;
  let files: string[];
  try {
    files = readdirSync(sessions, { recursive: true })
      .map((p) => String(p))
      .filter((p) => /rollout-.*\.jsonl$/.test(p))
      .map((p) => join(sessions, p));
  } catch {
    return null;
  }
  if (!files.length) return null;
  // Parse recent rollouts newest-first and return the first that carries a rate_limits snapshot. The
  // window is deliberately generous: once the plan hits its 5h/weekly cap, every subsequent turn dies
  // instantly (429) and writes a fresh rollout that has NO token_count/rate_limits line, so a burst of
  // capped dispatches can bury the last-good snapshot behind many empty files. Scanning only the top few
  // then made readCodexUsage return null — the top-bar chip's meters + reset countdown vanished exactly
  // when the cap made them most useful. A wider scan keeps surfacing the last real reading (empty rollouts
  // are tiny, so the extra reads are cheap and only happen while recent files lack a snapshot).
  const recent = files
    .map((f) => ({ f, m: safeMtime(f) }))
    .sort((a, b) => b.m - a.m)
    .slice(0, USAGE_SCAN_FILES);
  for (const { f } of recent) {
    const snap = parseRollout(f);
    if (snap) return snap;
  }
  return null;
}

function safeMtime(f: string): number {
  try {
    return statSync(f).mtimeMs;
  } catch {
    return 0;
  }
}

/** Scan a rollout for the LAST `token_count` event carrying REAL rate-limit windows. A token_count can
 *  carry a `rate_limits` object whose primary/secondary windows are null/absent (e.g. a failed or capped
 *  turn); those carry no meter info, so they're skipped — otherwise a recent empty snapshot would shadow
 *  the last real reading (leaving the chip's meters + reset countdown blank exactly when the cap made
 *  them useful). Returns the newest snapshot in this file that actually has a 5h or weekly percentage. */
function parseRollout(file: string): CodexUsageDTO | null {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  let found: CodexUsageDTO | null = null;
  for (const line of text.split("\n")) {
    if (!line.includes("rate_limits")) continue;
    let obj: { timestamp?: string; payload?: { type?: string; rate_limits?: RateLimits } };
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const rl = obj.payload?.rate_limits;
    if (obj.payload?.type !== "token_count" || !rl) continue;
    const meters = classifyRateWindows(toMeterWindow(rl.primary), toMeterWindow(rl.secondary));
    if (meters.fiveHour == null && meters.sevenDay == null) continue; // empty windows — no meter info to surface
    const ts = obj.timestamp ? Date.parse(obj.timestamp) : NaN;
    found = {
      ...meters,
      planType: rl.plan_type ?? null,
      updatedAt: Number.isFinite(ts) ? ts : safeMtime(file),
    };
  }
  return found;
}

function toMeterWindow(w: RateLimitWindow | null | undefined): MeterWindow | null {
  if (!w) return null;
  return {
    pct: typeof w.used_percent === "number" ? Math.min(100, Math.max(0, w.used_percent)) : null,
    resetMs: typeof w.resets_at === "number" ? w.resets_at * 1000 : null,
    durationMins: typeof w.window_minutes === "number" ? w.window_minutes : null,
  };
}
