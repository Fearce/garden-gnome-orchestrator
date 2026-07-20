import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../config.js";
import { logCrash } from "../crashLog.js";
import type { EventHub } from "../events.js";
import { noteGrokUsageScrape, parseGrokUsage, readGrokUsage, type GrokUsageDTO } from "./grokUsage.js";

/**
 * Keep the Grok chip + routing fed with the REAL weekly usage. xAI's API forbids OAuth-token clients from
 * reading SuperGrok's rate limit, but the CLI's own `/usage show` renders it. This monitor drives the CLI
 * through a pseudo-console (winpty — the headless orchestrator has no real TTY) on a slow timer, scrapes
 * "Weekly limit: N%" + "Next reset: <Mon Day, HH:MM>", and feeds them as the weekly meter + reset epoch.
 * A fresh identity read (auth.json) is broadcast even without a scrape, so the chip shows the signed-in
 * account immediately and the meter fills in on the first scrape.
 *
 * Robustness: every scrape is a short-lived spawn with a hard timeout; failures keep the last reading
 * rather than blanking it. The scrape is Windows-only (winpty); on other platforms — or with the scrape
 * disabled/winpty missing — the chip still shows identity + the live-run cap latch, just no weekly gauge.
 */

const SCRAPE_READY_RE = /Weekly limit:/i;

/** Strip ANSI CSI + OSC escapes and NULs from a raw TUI capture so the plain "Weekly limit: N%" text
 *  survives for the parser. */
function stripAnsi(s: string): string {
  const esc = String.fromCharCode(27);
  return s
    .replace(new RegExp(esc + "\\[[0-9;?]*[a-zA-Z]", "g"), "")
    .replace(new RegExp(esc + "\\][0-9;]*[^\\x07]*\\x07", "g"), "")
    .replace(/\x00/g, "");
}

/** Whether the usage scrape can run at all: Windows, enabled, and both the CLI + winpty present. */
export function grokUsageScrapeAvailable(): boolean {
  return (
    process.platform === "win32" &&
    config.grok.usagePollMs > 0 &&
    existsSync(config.grok.bin) &&
    existsSync(config.grok.winpty)
  );
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
  let scraping = false;

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

  const scrape = async (): Promise<void> => {
    if (scraping || !opts.configured() || !grokUsageScrapeAvailable()) return;
    scraping = true;
    try {
      const r = await scrapeGrokUsage();
      if (r) {
        noteGrokUsageScrape(r.sevenDay, r.sevenDayReset);
        push();
      }
    } finally {
      scraping = false;
    }
  };

  push(); // fill identity on boot
  void scrape().catch((e) => logCrash("grokUsage.scrape.initial", e));
  // Re-read identity/cap frequently (cheap, local), scrape the weekly meter on the slow cadence.
  setInterval(push, 15_000).unref();
  if (config.grok.usagePollMs > 0) {
    setInterval(() => void scrape().catch((e) => logCrash("grokUsage.scrape.periodic", e)), config.grok.usagePollMs).unref();
  }
}
