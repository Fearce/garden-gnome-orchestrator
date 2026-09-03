import { SUPERVISED_RESTART_CODE } from "./crashLog.js";

// How this server bounces ITSELF. Two deployments own the process in different ways, and both are
// live: on Windows the script-hub runs it under keepAlive, and `npm run serve` runs it under
// server/scripts/supervise.cjs. Everything that needs a restart — the update badge (update.ts) and the
// deploy gate (orchestrator/deployGate.ts) — goes through here, so the two can never drift on which
// mechanism owns the process or on what a refused restart looks like.

/** The script-hub that owns this server's process on the Windows deployment. Its atomic restart re-arms
 *  keepAlive and survives the caller being killed mid-restart (see CLAUDE.md "Deploying a change"). */
const HUB_URL = (process.env.SCRIPT_HUB_URL || "http://127.0.0.1:3939").replace(/\/$/, "");
const HUB_ID = process.env.SCRIPT_HUB_ID || "claude-orchestrator";

/** Which mechanism can bounce this process. `none` means nobody would respawn it, so we must not exit. */
export type RestartRoute = "supervisor" | "hub" | "none";

export interface RestartAttempt {
  route: RestartRoute;
  /** True only when the mechanism accepted the restart. A restart that actually lands tree-kills this
   *  process, so a resolved `ok: true` is the rare in-flight case; `ok: false` means nothing bounced. */
  ok: boolean;
  detail: string;
}

async function hubReachable(): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const r = await fetch(`${HUB_URL}/`, { signal: ctrl.signal }).catch(() => null);
    clearTimeout(t);
    return !!r; // any HTTP response means the hub process is up (even a 404)
  } catch {
    return false;
  }
}

/** Which mechanism owns this process right now. The supervisor wins when both are present: it is this
 *  process's direct parent, so its clean-exit handshake is cheaper and cannot race the hub. */
export async function restartRoute(): Promise<RestartRoute> {
  if (process.env.ORCH_SUPERVISED === "1") return "supervisor";
  return (await hubReachable()) ? "hub" : "none";
}

/**
 * Bounce this process onto the built `dist`.
 *
 * Under the supervisor a restart is a clean exit with the agreed code, which it respawns without
 * counting a crash — so this never returns. Under the hub it is the atomic `/api/restart`, which runs
 * outside this process tree and therefore survives the caller: a successful one kills us mid-`await`.
 *
 * Reaching the resolve at all therefore means the restart did NOT land, which is a real case worth
 * naming: the hub answers 200 with an empty kill list when the listener is elevated (see CLAUDE.md).
 */
export async function restartSelf(): Promise<RestartAttempt> {
  const route = await restartRoute();
  if (route === "supervisor") {
    process.exit(SUPERVISED_RESTART_CODE);
  }
  if (route === "none") {
    return { route, ok: false, detail: "no script-hub and no supervisor owns this process — restart it by hand" };
  }
  let reply: unknown = null;
  try {
    const r = await fetch(`${HUB_URL}/api/restart`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: HUB_ID }),
    });
    reply = await r.json().catch(() => null);
    if (!r.ok) {
      return { route, ok: false, detail: `the script-hub restart endpoint answered HTTP ${r.status}` };
    }
  } catch (e) {
    return { route, ok: false, detail: `the script-hub restart call failed: ${String(e)}` };
  }
  if (hubRestartWasANoop(reply)) {
    return {
      route,
      ok: false,
      detail: `the script-hub reported a restart that killed nothing — the listener is probably elevated. Self-elevate the kill (Start-Process powershell -Verb RunAs -File <kill.ps1>) and let keepAlive respawn it.`,
    };
  }
  return { route, ok: true, detail: "the script-hub accepted the atomic restart" };
}

/** The hub answers 200 with nothing killed when the listener is elevated — a silent no-op that reads
 *  like success. Mirrors `restartLookedLikeANoop` in scripts/deploy.cjs. */
export function hubRestartWasANoop(reply: unknown): boolean {
  if (!reply || typeof reply !== "object") return false;
  const r = reply as { ok?: unknown; stop?: { killed?: unknown } };
  if (r.ok === false) return true;
  const killed = r.stop && Array.isArray(r.stop.killed) ? r.stop.killed : null;
  return killed !== null && killed.length === 0;
}

/** Fire the restart once the caller's HTTP response has flushed — the bounce tree-kills this process,
 *  so an in-band restart would strand the client waiting on a reply that can never be written. */
export function scheduleRestartSelf(delayMs = 800): void {
  setTimeout(() => void restartSelf().catch(() => {}), delayMs).unref?.();
}
