import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, openSync, readSync, statSync, closeSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "../config.js";
import { logCrash } from "../crashLog.js";
import type { EventHub } from "../events.js";
import {
  noteGrokMonthly,
  noteGrokUsageError,
  noteGrokUsageScrape,
  parseGrokBillingHttp,
  parseGrokCreditsLog,
  parseGrokUsage,
  readGrokAccessTokenRaw,
  readGrokUsage,
  type GrokUsageDTO,
} from "./grokUsage.js";

/**
 * Keep the Grok chip + routing fed with REAL SuperGrok usage.
 *
 * Three sources, cheapest first:
 *  1. CLI unified.jsonl — the CLI already logs `creditUsagePercent` + weekly period end on every TUI
 *     boot (and our own winpty scrape). Free, no network, no PTY.
 *  2. HTTP `GET https://cli-chat-proxy.grok.com/v1/billing` with the OAuth access token — monthly
 *     credit used/limit. Verified live against SuperGrok; no model turn.
 *  3. winpty TUI scrape of `/usage show` — weekly meter when the log is cold (Windows only).
 *
 * Failures keep the last reading rather than blanking it. Identity (auth.json) is always re-read so
 * the chip shows the signed-in account even before the first meter lands.
 */

const SCRAPE_READY_RE = /Weekly limit:/i;
// How often to re-drive the expensive winpty TUI scrape when the log hasn't produced a weekly meter.
const WINPTY_MIN_INTERVAL_MS = 10 * 60_000;
// Tail at most this many bytes of the CLI log per poll (the file grows without bound).
const LOG_TAIL_BYTES = 512 * 1024;

/** Strip ANSI CSI + OSC escapes and NULs from a raw TUI capture so the plain "Weekly limit: N%" text
 *  survives for the parser. */
function stripAnsi(s: string): string {
  const esc = String.fromCharCode(27);
  return s
    .replace(new RegExp(esc + "\\[[0-9;?]*[a-zA-Z]", "g"), "")
    .replace(new RegExp(esc + "\\][0-9;]*[^\\x07]*\\x07", "g"), "")
    .replace(/\x00/g, "");
}

/** Whether the winpty TUI scrape can run: Windows, enabled, and both the CLI + winpty present. */
export function grokUsageScrapeAvailable(): boolean {
  return (
    process.platform === "win32" &&
    config.grok.usagePollMs > 0 &&
    existsSync(config.grok.bin) &&
    existsSync(config.grok.winpty)
  );
}

/** Tail-read the CLI unified log and extract the latest SuperGrok weekly creditUsagePercent. Returns
 *  null when the log is missing/empty or has no billing line yet. Never throws. */
export function readGrokCreditsFromLog(): { sevenDay: number; sevenDayReset: number | null; plan: string | null } | null {
  const logPath = join(config.grok.home, "logs", "unified.jsonl");
  if (!existsSync(logPath)) return null;
  try {
    const size = statSync(logPath).size;
    if (size <= 0) return null;
    const start = Math.max(0, size - LOG_TAIL_BYTES);
    const len = size - start;
    const fd = openSync(logPath, "r");
    try {
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, start);
      // Drop a partial first line when we started mid-file.
      const text = buf.toString("utf8");
      const cut = start > 0 ? text.indexOf("\n") + 1 : 0;
      return parseGrokCreditsLog(cut > 0 ? text.slice(cut) : text);
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** HTTP monthly-credits ping. Uses the OAuth access token from auth.json. Returns null on any failure. */
export async function pingGrokBillingHttp(timeoutMs = 12_000): Promise<{
  monthlyUsed: number;
  monthlyLimit: number;
  monthlyReset: number | null;
} | null> {
  const token = readGrokAccessTokenRaw();
  if (!token) return null;
  const url = config.grok.billingUrl;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "User-Agent": "garden-gnome-orchestrator/grok-usage",
      },
      signal: ac.signal,
    });
    if (!res.ok) {
      noteGrokUsageError(`billing HTTP ${res.status}`);
      return null;
    }
    const body: unknown = await res.json();
    return parseGrokBillingHttp(body);
  } catch (e) {
    noteGrokUsageError(e instanceof Error ? e.message : "billing HTTP failed");
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Run one `/usage show` scrape through winpty and return the parsed weekly meter, or null on any failure
 *  (spawn error, timeout, no match). Never throws. */
export function scrapeGrokUsage(timeoutMs = config.grok.usageScrapeTimeoutMs): Promise<{ sevenDay: number; sevenDayReset: number | null } | null> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    // winpty resolves winpty-agent.exe / winpty.dll relative to its own dir; prepend that dir to PATH so
    // the spawn finds them regardless of the inherited PATH. GROK_DISABLE_AUTOUPDATER stops a mid-scrape
    // self-update from stalling the TUI.
    const env: NodeJS.ProcessEnv = { ...process.env, GROK_DISABLE_AUTOUPDATER: "1" };
    env.PATH = `${dirname(config.grok.winpty)};${env.PATH ?? ""}`;
    env.GROK_HOME = config.grok.home;
    try {
      child = spawn(config.grok.winpty, ["-Xallow-non-tty", config.grok.bin], { env, stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      resolve(null);
      return;
    }
    let out = "";
    let done = false;
    const finish = (v: { sevenDay: number; sevenDayReset: number | null } | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(sendTimer);
      try {
        child.stdin?.write("\x03"); // Ctrl+C to leave the pager
      } catch {
        /* already gone */
      }
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      resolve(v);
    };
    const onData = (d: Buffer): void => {
      out += d.toString("utf8");
      if (SCRAPE_READY_RE.test(out)) {
        // The line has rendered — parse and finish early rather than waiting out the timeout.
        const { sevenDay, sevenDayReset } = parseGrokUsage(stripAnsi(out), Date.now());
        if (sevenDay != null) finish({ sevenDay, sevenDayReset });
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.stdin?.on("error", () => {});
    child.on("error", () => finish(null));
    child.on("close", () => {
      const { sevenDay, sevenDayReset } = parseGrokUsage(stripAnsi(out), Date.now());
      finish(sevenDay != null ? { sevenDay, sevenDayReset } : null);
    });
    // Give the TUI a moment to boot, then request the usage view.
    const sendTimer = setTimeout(() => {
      try {
        child.stdin?.write("/usage show\r");
      } catch {
        /* child died; close/timeout resolves */
      }
    }, 3000);
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();
    sendTimer.unref?.();
  });
}

export function startGrokUsageMonitor(hub: EventHub, opts: { configured: () => boolean }): void {
  let lastSig = "";
  let pinging = false;
  let lastWinptyAt = 0;

  const push = (): void => {
    const usage: GrokUsageDTO | null = opts.configured() ? readGrokUsage() : null;
    // Ignore updatedAt when diffing so a bare timestamp tick doesn't spam the WS. `stale` remains in the
    // signature: if repeated scrape failures age the last reading out, clients must receive that state
    // transition and stop presenting the meter as fresh.
    const sig = usage ? JSON.stringify({ ...usage, updatedAt: 0 }) : "null";
    if (sig === lastSig) return;
    lastSig = sig;
    hub.publish({ type: "grok.usage", usage });
  };

  const ping = async (): Promise<void> => {
    if (pinging || !opts.configured()) return;
    pinging = true;
    try {
      // 1) Free weekly meter from the CLI log (any recent TUI/session, including our own scrapes).
      const fromLog = readGrokCreditsFromLog();
      if (fromLog) {
        noteGrokUsageScrape(fromLog.sevenDay, fromLog.sevenDayReset, { plan: fromLog.plan, source: "log" });
      }

      // 2) HTTP monthly credits (OAuth token — no model turn).
      const monthly = await pingGrokBillingHttp();
      if (monthly) {
        noteGrokMonthly(monthly.monthlyUsed, monthly.monthlyLimit, monthly.monthlyReset);
      }

      // 3) winpty fallback for weekly only when the log is cold and enough time has passed.
      const haveWeekly = readGrokUsage().sevenDay != null;
      const winptyDue = Date.now() - lastWinptyAt >= WINPTY_MIN_INTERVAL_MS;
      if (!haveWeekly && winptyDue && grokUsageScrapeAvailable()) {
        lastWinptyAt = Date.now();
        const r = await scrapeGrokUsage();
        if (r) {
          noteGrokUsageScrape(r.sevenDay, r.sevenDayReset, { source: "winpty" });
        } else if (!fromLog && !monthly) {
          noteGrokUsageError("usage scrape failed — retrying");
        }
      }

      push();
    } finally {
      pinging = false;
    }
  };

  push(); // fill identity + any disk-cached meters on boot
  void ping().catch((e) => logCrash("grokUsage.ping.initial", e));
  // Re-read identity/cap frequently (cheap, local); poll meters on the configured cadence.
  setInterval(push, 15_000).unref();
  if (config.grok.usagePollMs > 0) {
    setInterval(() => void ping().catch((e) => logCrash("grokUsage.ping.periodic", e)), config.grok.usagePollMs).unref();
  }
}
