import { config } from "../config.js";
import { logCrash } from "../crashLog.js";
import type { EventHub } from "../events.js";
import {
  noteZaiConfigured,
  noteZaiUsage,
  noteZaiUsageError,
  parseZaiQuota,
  readZaiUsage,
  type ZaiUsageDTO,
} from "./zaiUsage.js";

/**
 * Keep the z.ai chip + routing fed with REAL GLM Coding Plan usage.
 *
 * One cheap source: an HTTP GET to z.ai's quota endpoint with the API key (no model turn). It returns the
 * 5-hour + weekly windows and the plan tier; parseZaiQuota decodes them. A failure keeps the last reading
 * rather than blanking it. The key presence is re-checked every tick so the chip reflects config changes
 * (a key added/removed in Settings) without a restart.
 */

/** One quota poll. Returns the parsed windows, or null on any failure (no key, HTTP error, unparseable). */
export async function pingZaiQuota(
  apiKey: string | undefined,
  timeoutMs = 12_000,
): Promise<ReturnType<typeof parseZaiQuota>> {
  if (!apiKey) return null;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(config.zai.usageUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "User-Agent": "garden-gnome-orchestrator/zai-usage",
      },
      signal: ac.signal,
    });
    if (!res.ok) {
      noteZaiUsageError(`quota HTTP ${res.status}`);
      return null;
    }
    const body: unknown = await res.json();
    const parsed = parseZaiQuota(body);
    if (!parsed) noteZaiUsageError("quota response had no recognizable usage windows");
    return parsed;
  } catch (e) {
    noteZaiUsageError(e instanceof Error ? e.message : "quota HTTP failed");
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function startZaiUsageMonitor(
  hub: EventHub,
  opts: { apiKey: () => string | undefined; configured: () => boolean },
): void {
  let lastSig = "";
  let pinging = false;

  const push = (): void => {
    noteZaiConfigured(!!opts.apiKey());
    const usage: ZaiUsageDTO | null = opts.configured() ? readZaiUsage() : null;
    // Ignore updatedAt when diffing so a bare timestamp tick doesn't spam the WS. `stale` stays in the
    // signature so an aged-out reading still transitions clients to the stale presentation.
    const sig = usage ? JSON.stringify({ ...usage, updatedAt: 0 }) : "null";
    if (sig === lastSig) return;
    lastSig = sig;
    hub.publish({ type: "zai.usage", usage });
  };

  const ping = async (): Promise<void> => {
    if (pinging || !opts.configured()) return;
    pinging = true;
    try {
      const parsed = await pingZaiQuota(opts.apiKey());
      if (parsed) noteZaiUsage(parsed);
      push();
    } finally {
      pinging = false;
    }
  };

  push(); // fill configured-state + any disk-cached meters on boot
  void ping().catch((e) => logCrash("zaiUsage.ping.initial", e));
  // Re-read identity/cap frequently (cheap, local); poll the quota endpoint on the configured cadence.
  setInterval(push, 15_000).unref();
  if (config.zai.usagePollMs > 0) {
    setInterval(() => void ping().catch((e) => logCrash("zaiUsage.ping.periodic", e)), config.zai.usagePollMs).unref();
  }
}
