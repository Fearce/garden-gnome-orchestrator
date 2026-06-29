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

/** The codex CLI does not expose rolling rate limits over `codex exec --json`, but it PERSISTS them to
 *  the session rollout after every turn — a `token_count` event whose `rate_limits` holds the plan-wide
 *  primary/secondary windows. Reading the freshest rollout therefore gives real usage at ZERO extra API
 *  cost, refreshed whenever Codex (here or the operator's own `codex`) actually runs. Account-wide, so the
 *  snapshot is the same regardless of which home produced it; we scan both the orchestrator's isolated
 *  CODEX_HOME and the operator's ~/.codex and take the most recent. Returns null when no rollout exists yet. */
export function readCodexUsage(): CodexUsageDTO | null {
  const homes = [config.codex.home, config.codex.sourceAuthHome];
  let best: CodexUsageDTO | null = null;
  for (const home of homes) {
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
  // Only parse the few most-recently-modified rollouts — the freshest snapshot is in one of them, and a
  // long-lived home can hold thousands of old session files we never need to read.
  const recent = files
    .map((f) => ({ f, m: safeMtime(f) }))
    .sort((a, b) => b.m - a.m)
    .slice(0, 3);
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

/** Scan a rollout for the LAST `token_count` event carrying `rate_limits`. */
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
    const ts = obj.timestamp ? Date.parse(obj.timestamp) : NaN;
    found = {
      fiveHour: pct(rl.primary),
      sevenDay: pct(rl.secondary),
      fiveHourReset: resetMs(rl.primary),
      sevenDayReset: resetMs(rl.secondary),
      planType: rl.plan_type ?? null,
      updatedAt: Number.isFinite(ts) ? ts : safeMtime(file),
    };
  }
  return found;
}

function pct(w: RateLimitWindow | null | undefined): number | null {
  return w && typeof w.used_percent === "number" ? Math.min(100, Math.max(0, w.used_percent)) : null;
}
function resetMs(w: RateLimitWindow | null | undefined): number | null {
  return w && typeof w.resets_at === "number" ? w.resets_at * 1000 : null;
}
