import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { config } from "../config.js";
import { logCrash } from "../crashLog.js";
import type { EventHub } from "../events.js";
import type { ResetStagger } from "../accounts/resetStagger.js";
import { withAgentToolPath } from "./env.js";
import { seedCodexAuth } from "./codexRunner.js";
import { classifyRateWindows, latestTurnFiveHourReset, noteCodexPing, noteCodexWake, readCodexUsage, type CodexUsageDTO, type MeterWindow } from "./codexUsage.js";

/**
 * A live Codex usage read — the ChatGPT-plan counterpart of the Claude Haiku ping. The rollout-file
 * snapshot (`codexUsage.ts`) only refreshes when a real Codex turn runs, so between runs the top-bar
 * chip sat frozen on the last reading with its 5h reset long expired. The codex `app-server` exposes
 * `account/rateLimits/read` over stdio JSON-RPC, which fetches the CURRENT plan-wide windows from the
 * backend WITHOUT running a model turn — exact 5h/weekly used-percent + reset epochs, zero quota cost.
 * (Verified live on codex-cli 0.142.4.)
 *
 * The free read can't START a 5h window, though — only a real model turn can — so an idle Codex has
 * no rolling 5h reset at all. The monitor therefore also WAKES Codex: whenever a live read shows no
 * running 5h window, it schedules the cheapest real turn we found (one-word prompt, low effort,
 * read-only sandbox — ~5 output tokens) at the slot the shared ResetStagger picks, so Codex's resets
 * interleave with the Claude subscriptions' instead of clumping or never rolling.
 */

const PING_TIMEOUT_MS = 30_000;
// Same cadence as the Claude account pings by default; each ping spawns a short-lived codex process.
const CODEX_PING_MS = Number(process.env.CODEX_PING_MS) > 0 ? Number(process.env.CODEX_PING_MS) : 600_000;
const RESET_BUFFER_MS = 5_000; // re-read shortly after a window reset so the meter flips without waiting a full interval
const ROLLOUT_POLL_MS = 30_000; // the cheap rollout-file poll (fresh mid-run data) + change broadcast

// ---- the cheap wake turn ----
// gpt-5.5 is the cheapest model a ChatGPT-plan login can run: the mini/codex-mini ids 400 with "not
// supported when using Codex with a ChatGPT account" (verified live, CLI 0.142.4). Effort "low", not
// "minimal" — minimal 400s against the built-in web_search tool. CODEX_WAKE=off disables waking.
const WAKE_OFF = process.env.CODEX_WAKE === "off";
const WAKE_MODEL = process.env.CODEX_WAKE_MODEL?.trim() || "gpt-5.5";
const WAKE_EFFORT = "low";
const WAKE_PROMPT = "Reply with exactly: ok";
const WAKE_TIMEOUT_MS = 180_000;
// After a failed wake turn (bad model id, transient 5xx), hold off before trying again so a broken
// wake can't burn a spawn every ping cycle.
const WAKE_FAIL_BACKOFF_MS = 30 * 60_000;
// At/above this weekly used-percent, don't wake: a fresh 5h window can't add headroom the weekly cap
// has already taken away, and the turn itself would likely 429.
const WAKE_WEEKLY_GUARD = 98;

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
      ...classifyRateWindows(toMeterWindow(rl.primary), toMeterWindow(rl.secondary)),
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
      if (buf.length > 1_000_000) return finish(null); // runaway unterminated output — bail before the timeout
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

function toMeterWindow(w: RpcWindow | null | undefined): MeterWindow | null {
  if (!w) return null;
  return {
    pct: typeof w.usedPercent === "number" ? Math.min(100, Math.max(0, w.usedPercent)) : null,
    resetMs: typeof w.resetsAt === "number" ? w.resetsAt * 1000 : null,
    durationMins: typeof w.windowDurationMins === "number" ? w.windowDurationMins : null,
  };
}

/** Run the cheapest real Codex turn we can — a one-word prompt, low effort, read-only sandbox, no
 *  repo. Unlike the free rateLimits read this consumes a (trivial) slice of quota, which is exactly
 *  the point: it STARTS a fresh 5h window. The rollout it writes doubles as a free meter snapshot.
 *  Resolves true only on a completed turn. */
export async function codexWakeTurn(apiKey: string | undefined, model: string, timeoutMs = WAKE_TIMEOUT_MS): Promise<boolean> {
  if (!existsSync(config.codex.binJs)) return false;
  await mkdir(config.codex.home, { recursive: true }).catch(() => {});
  const authMode = await seedCodexAuth(apiKey).catch(() => "none" as const);
  if (authMode === "none") return false;
  const env: NodeJS.ProcessEnv = withAgentToolPath({ ...process.env, CODEX_HOME: config.codex.home });
  const key = apiKey?.trim();
  if (authMode === "apikey" && key) env.OPENAI_API_KEY = key;
  else delete env.OPENAI_API_KEY;
  const args = [
    config.codex.binJs,
    "exec",
    "--json",
    "--skip-git-repo-check",
    "-s",
    "read-only",
    "--color",
    "never",
    "-C",
    config.codex.home,
    "-c",
    `model_reasoning_effort="${WAKE_EFFORT}"`,
    "-m",
    model,
    "-",
  ];
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, args, { cwd: config.codex.home, env, stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      resolve(false);
      return;
    }
    let ok = false;
    let buf = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdin?.on("error", () => {});
    try {
      child.stdin?.end(WAKE_PROMPT);
    } catch {
      /* child died instantly; close resolves false */
    }
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (ok) return;
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try {
          if ((JSON.parse(line) as { type?: string }).type === "turn.completed") ok = true;
        } catch {
          /* non-JSON noise */
        }
      }
      if (buf.length > 65536) buf = buf.slice(-1024); // runaway unterminated line — keep memory bounded
    });
    child.on("error", () => {});
    child.on("close", () => {
      clearTimeout(timer);
      resolve(ok);
    });
  });
}

/**
 * Keep the Codex meters live: broadcast `codex.usage` whenever the merged reading (rollout snapshot ∪
 * live ping) changes, ping the app-server periodically and once shortly after each 5h/weekly reset —
 * so the chip's percentages AND reset countdowns track reality even when no Codex turn has run for
 * hours. Skips entirely (and cheaply) while Codex isn't configured; picks up the moment it is.
 *
 * With a `stagger`, the monitor also enrolls Codex as a stagger participant and keeps its 5h window
 * ROLLING: a live read proving the window idle schedules a cheap wake turn at Codex's slot, so its
 * resets interleave with the Claude subs' — and a cap-parked task gets a fresh Codex window on the
 * same cadence as everyone else instead of waiting for the next real dispatch.
 */
export function startCodexUsageMonitor(
  hub: EventHub,
  opts: {
    apiKey: () => string | undefined;
    configured: () => boolean;
    stagger?: ResetStagger;
    /** The configured implementor model — the wake turn's fallback when WAKE_MODEL is rejected. */
    runModel?: () => string;
  },
): void {
  let lastSig = "";
  let resetTimer: NodeJS.Timeout | undefined;
  let resetArmedFor = 0;
  let pinging = false;
  let lastRead: CodexUsageDTO | null = null; // last successful live RPC read — the only proof of idleness
  let wakeTimer: NodeJS.Timeout | undefined;
  let wakeAt: number | null = null;
  let waking = false;
  let lastWakeFailAt = 0;
  let registered = false;

  const push = (): void => {
    const usage = readCodexUsage();
    const sig = JSON.stringify(usage);
    if (sig !== lastSig) {
      lastSig = sig;
      hub.publish({ type: "codex.usage", usage });
    }
    armResetPing(usage);
  };

  // The backend does not REPORT a 5h window whose usage is tiny: a wake turn's own token_count comes
  // back primary=weekly, secondary=null (verified live on a plus plan). So "no visible 5h reset" must
  // NOT read as idle right after a turn — without this, every wake would look like it did nothing and
  // the loop would re-fire a real turn each cycle. Presume a window from the newest REAL turn's own
  // snapshot (rollout evidence, either home — survives restarts and covers implementor/operator turns
  // too): the snapshot's 5h reset when the backend reported one, else turn + 5h — the latest possible
  // reset of the window that turn started or rode.
  const presumedReset = (now: number): number | null => {
    return latestTurnFiveHourReset(now)?.reset ?? null;
  };

  // Codex participates in the reset stagger only while it's configured; its phase is the merged 5h
  // reset when a window is live (visible or presumed), or the planned wake when one is scheduled.
  const syncRegistration = (): void => {
    if (!opts.stagger) return;
    const want = opts.configured();
    if (want && !registered) {
      opts.stagger.register("codex", () => {
        const now = Date.now();
        if (wakeAt != null && wakeAt > now) return wakeAt;
        const reset = readCodexUsage()?.fiveHourReset;
        if (reset != null && reset > now) return reset;
        return presumedReset(now);
      });
      registered = true;
    } else if (!want && registered) {
      opts.stagger.unregister("codex");
      registered = false;
      setWake(null);
      push(); // clear the chip's wake countdown right away, not on the next poll
    }
  };

  const setWake = (at: number | null): void => {
    if (wakeTimer) clearTimeout(wakeTimer);
    wakeTimer = undefined;
    wakeAt = at;
    noteCodexWake(at);
    if (at == null) return;
    wakeTimer = setTimeout(() => void fireWake().catch((e) => logCrash("codexWake.fire", e)), Math.max(at - Date.now(), 1_000));
    wakeTimer.unref?.();
  };

  /** (Re)plan the wake from the latest live read: window running (visible or presumed from a recent
   *  turn) → no wake; provably idle (and the weekly window not capped) → wake at the stagger slot.
   *  An already-armed future wake is left alone so the plan others spaced around stays put. */
  const maybeScheduleWake = (): void => {
    if (WAKE_OFF || !opts.configured() || waking) return;
    const now = Date.now();
    const live = lastRead;
    if (!live) return; // no live read — can't tell idle from broken auth; don't spend a turn blind
    if ((live.fiveHourReset != null && live.fiveHourReset > now) || presumedReset(now) != null) {
      if (wakeAt != null) {
        setWake(null); // a real turn started the window — the plan is moot
        push();
      }
      return;
    }
    if (wakeAt != null && wakeAt > now) return; // already planned; others are spacing around it
    if ((live.sevenDay ?? 0) >= WAKE_WEEKLY_GUARD) return;
    if (now - lastWakeFailAt < WAKE_FAIL_BACKOFF_MS) return;
    setWake(opts.stagger?.nextStart("codex", now) ?? now);
    push();
  };

  const fireWake = async (): Promise<void> => {
    setWake(null);
    if (WAKE_OFF || !opts.configured()) return;
    waking = true;
    try {
      // Re-verify right before spending a real turn — a genuine run may have started the window
      // (visibly or not) or the weekly cap may have landed since this wake was planned.
      lastRead = await pingCodexUsage(opts.apiKey());
      const now = Date.now();
      if (!lastRead || (lastRead.fiveHourReset != null && lastRead.fiveHourReset > now) || presumedReset(now) != null) return;
      if ((lastRead.sevenDay ?? 0) >= WAKE_WEEKLY_GUARD) return;
      const models = [...new Set([WAKE_MODEL, opts.runModel?.(), config.codex.defaultModel].filter((m): m is string => !!m))];
      let woke = false;
      for (const m of models) {
        if (await codexWakeTurn(opts.apiKey(), m)) {
          woke = true;
          break;
        }
      }
      if (!woke) {
        lastWakeFailAt = Date.now();
        logCrash("codexWake.turn", new Error(`codex wake turn failed on ${models.join(", ")}`));
        return;
      }
      lastRead = await pingCodexUsage(opts.apiKey()); // read the freshly-started window
    } finally {
      waking = false;
      push();
      maybeScheduleWake();
    }
  };

  const ping = async (): Promise<void> => {
    syncRegistration();
    if (pinging || !opts.configured()) return; // never stack spawns; a wedged child times out on its own
    pinging = true;
    try {
      lastRead = await pingCodexUsage(opts.apiKey());
    } finally {
      pinging = false;
    }
    maybeScheduleWake();
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
