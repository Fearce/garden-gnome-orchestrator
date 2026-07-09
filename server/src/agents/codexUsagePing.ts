import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { config } from "../config.js";
import { logCrash } from "../crashLog.js";
import type { EventHub } from "../events.js";
import { withAgentToolPath } from "./env.js";
import { seedCodexAuth } from "./codexRunner.js";
import { noteCodexPing, readCodexUsage, type CodexUsageDTO } from "./codexUsage.js";

/**
 * A live Codex usage read — the ChatGPT-plan counterpart of the Claude Haiku ping. The rollout-file
 * snapshot (`codexUsage.ts`) only refreshes when a real Codex turn runs, so between runs the top-bar
 * chip sat frozen on the last reading with its 5h reset long expired. The codex `app-server` exposes
 * `account/rateLimits/read` over stdio JSON-RPC, which fetches the CURRENT plan-wide windows from the
 * backend WITHOUT running a model turn — exact 5h/weekly used-percent + reset epochs, zero quota cost.
 * (Verified live on codex-cli 0.142.4.)
 */

const PING_TIMEOUT_MS = 30_000;
// Same cadence as the Claude account pings by default; each ping spawns a short-lived codex process.
const CODEX_PING_MS = Number(process.env.CODEX_PING_MS) > 0 ? Number(process.env.CODEX_PING_MS) : 600_000;
const RESET_BUFFER_MS = 5_000; // re-read shortly after a window reset so the meter flips without waiting a full interval
const ROLLOUT_POLL_MS = 30_000; // the cheap rollout-file poll (fresh mid-run data) + change broadcast

interface RpcWindow {
  usedPercent?: number;
  resetsAt?: number; // epoch SECONDS
  windowDurationMins?: number;
}
interface RpcRateLimits {
  primary?: RpcWindow | null;
  secondary?: RpcWindow | null;
  planType?: string | null;
}

/** Read the live plan-wide rate limits via `codex app-server`. Seeds auth exactly like an implementor
 *  turn (ChatGPT login preferred, API key fallback), so it works with whichever auth the runs use.
 *  Returns null on any failure — no auth, spawn error, RPC error, timeout — callers keep the last
 *  snapshot in that case rather than blanking the meters. */
export async function pingCodexUsage(apiKey: string | undefined, timeoutMs = PING_TIMEOUT_MS): Promise<CodexUsageDTO | null> {
  if (!existsSync(config.codex.binJs)) return null;
  await mkdir(config.codex.home, { recursive: true }).catch(() => {});
  const authMode = await seedCodexAuth(apiKey).catch(() => "none" as const);
  if (authMode === "none") return null;
  // Mirror runTurn's env rules: point the CLI at the seeded isolated home, and carry OPENAI_API_KEY
  // only in apikey mode (an inherited key under a ChatGPT login could nudge the CLI to the API path).
  const env: NodeJS.ProcessEnv = withAgentToolPath({ ...process.env, CODEX_HOME: config.codex.home });
  const key = apiKey?.trim();
  if (authMode === "apikey" && key) env.OPENAI_API_KEY = key;
  else delete env.OPENAI_API_KEY;

  let child: ChildProcess;
  try {
    child = spawn(process.execPath, [config.codex.binJs, "app-server"], { env, stdio: ["pipe", "pipe", "ignore"] });
  } catch {
    return null;
  }
  try {
    const rl = await appServerRateLimits(child, timeoutMs);
    if (!rl) return null;
    const usage: CodexUsageDTO = {
      fiveHour: pct(rl.primary),
      sevenDay: pct(rl.secondary),
      fiveHourReset: resetMs(rl.primary),
      sevenDayReset: resetMs(rl.secondary),
      planType: rl.planType ?? null,
      updatedAt: Date.now(),
    };
    if (usage.fiveHour == null && usage.sevenDay == null) return null; // no meter info — treat as a failed read
    noteCodexPing(usage);
    return usage;
  } finally {
    child.kill();
  }
}

/** Drive the minimal JSON-RPC exchange: initialize → initialized → account/rateLimits/read. */
function appServerRateLimits(child: ChildProcess, timeoutMs: number): Promise<RpcRateLimits | null> {
  return new Promise((resolve) => {
    let buf = "";
    let step: "init" | "read" = "init";
    const timer = setTimeout(() => resolve(null), timeoutMs);
    const finish = (v: RpcRateLimits | null): void => {
      clearTimeout(timer);
      resolve(v);
    };
    const send = (msg: object): void => {
      try {
        child.stdin?.write(JSON.stringify(msg) + "\n");
      } catch {
        finish(null);
      }
    };
    child.stdin?.on("error", () => {});
    child.on("error", () => finish(null));
    child.on("exit", () => finish(null));
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg: { id?: number; result?: { rateLimits?: RpcRateLimits }; error?: unknown };
        try {
          msg = JSON.parse(line) as typeof msg;
        } catch {
          continue;
        }
        if (msg.id === 1 && step === "init") {
          if (msg.error) return finish(null);
          step = "read";
          send({ jsonrpc: "2.0", method: "initialized", params: {} });
          send({ jsonrpc: "2.0", id: 2, method: "account/rateLimits/read", params: {} });
        } else if (msg.id === 2) {
          finish(msg.error ? null : (msg.result?.rateLimits ?? null));
        }
        // Anything else (notifications) is ignored.
      }
    });
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "gg-orchestrator", title: "GG Orchestrator", version: "1.0.0" } },
    });
  });
}

function pct(w: RpcWindow | null | undefined): number | null {
  return w && typeof w.usedPercent === "number" ? Math.min(100, Math.max(0, w.usedPercent)) : null;
}
function resetMs(w: RpcWindow | null | undefined): number | null {
  return w && typeof w.resetsAt === "number" ? w.resetsAt * 1000 : null;
}

/**
 * Keep the Codex meters live: broadcast `codex.usage` whenever the merged reading (rollout snapshot ∪
 * live ping) changes, ping the app-server periodically and once shortly after each 5h/weekly reset —
 * so the chip's percentages AND reset countdowns track reality even when no Codex turn has run for
 * hours. Skips entirely (and cheaply) while Codex isn't configured; picks up the moment it is.
 */
export function startCodexUsageMonitor(hub: EventHub, opts: { apiKey: () => string | undefined; configured: () => boolean }): void {
  let lastSig = "";
  let resetTimer: NodeJS.Timeout | undefined;
  let resetArmedFor = 0;
  let pinging = false;

  const push = (): void => {
    const usage = readCodexUsage();
    const sig = JSON.stringify(usage);
    if (sig !== lastSig) {
      lastSig = sig;
      hub.publish({ type: "codex.usage", usage });
    }
    armResetPing(usage);
  };

  const ping = async (): Promise<void> => {
    if (pinging || !opts.configured()) return; // never stack spawns; a wedged child times out on its own
    pinging = true;
    try {
      await pingCodexUsage(opts.apiKey());
    } finally {
      pinging = false;
    }
    push();
  };

  // Re-read just after the soonest upcoming window reset, so the meter flips to the new window (and its
  // new reset countdown) immediately instead of sitting at the stale 100%/expired state for up to a full
  // ping interval. Armed off every push; re-arming for the same epoch is a no-op.
  const armResetPing = (usage: CodexUsageDTO | null): void => {
    const now = Date.now();
    const upcoming = [usage?.fiveHourReset, usage?.sevenDayReset].filter((r): r is number => r != null && r > now);
    if (!upcoming.length) return;
    const at = Math.min(...upcoming) + RESET_BUFFER_MS;
    if (resetArmedFor === at) return;
    if (resetTimer) clearTimeout(resetTimer);
    resetArmedFor = at;
    resetTimer = setTimeout(() => void ping().catch((e) => logCrash("codexPing.reset", e)), Math.max(at - now, 1_000));
    resetTimer.unref?.();
  };

  push(); // rollout snapshot first, so the strip fills instantly on boot
  void ping().catch((e) => logCrash("codexPing.initial", e));
  setInterval(() => void ping().catch((e) => logCrash("codexPing.periodic", e)), CODEX_PING_MS).unref();
  setInterval(push, ROLLOUT_POLL_MS).unref();
}
