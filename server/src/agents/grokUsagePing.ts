import { logCrash } from "../crashLog.js";
import type { EventHub } from "../events.js";
import { readGrokUsage, type GrokUsageDTO } from "./grokUsage.js";

/**
 * Keep the Grok chip live. Unlike the Codex monitor there's no remote read to make — Grok exposes no
 * rate-limit windows, so "usage" is just the signed-in identity (read from ~/.grok/auth.json) plus the
 * cap-latch countdown. This monitor re-reads that cheaply on a timer and broadcasts `grok.usage` whenever
 * it changes (a fresh login, a token refresh, a cap latching or expiring), so the top bar reflects Grok
 * without any model turn or network call. Skips entirely (and cheaply) while Grok isn't configured.
 */

// The auth.json read is local + instant, so poll briskly enough that a cap-latch countdown and a fresh
// login surface within a few seconds without any real cost.
const GROK_POLL_MS = Number(process.env.GROK_POLL_MS) > 0 ? Number(process.env.GROK_POLL_MS) : 15_000;

export function startGrokUsageMonitor(hub: EventHub, opts: { configured: () => boolean }): void {
  let lastSig = "";

  const push = (): void => {
    const usage: GrokUsageDTO | null = opts.configured() ? readGrokUsage() : null;
    // Ignore updatedAt when diffing so a bare timestamp tick doesn't spam the WS; only substantive
    // changes (identity / cap state / configured⇄not) rebroadcast.
    const sig = usage ? JSON.stringify({ ...usage, updatedAt: 0 }) : "null";
    if (sig === lastSig) return;
    lastSig = sig;
    hub.publish({ type: "grok.usage", usage });
  };

  push(); // fill the chip on boot
  setInterval(() => {
    try {
      push();
    } catch (e) {
      logCrash("grokPing.push", e);
    }
  }, GROK_POLL_MS).unref();
}
