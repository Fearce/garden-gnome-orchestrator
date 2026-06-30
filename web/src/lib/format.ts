import type { AccountDTO, AgentRunState, Role, Thread, ThreadState } from "../types.js";

export function roleColor(role: Role): string {
  return `var(--role-${role})`;
}

export function stateColor(state: ThreadState): string {
  switch (state) {
    case "implementing":
    case "planning":
    case "researching":
    case "enriching":
    case "qa":
      return "var(--accent)";
    case "done":
      return "var(--ok)";
    case "failed":
      return "var(--danger)";
    case "paused":
    case "awaiting_user":
    case "awaiting_approval":
    case "review":
      return "var(--warn)";
    case "queued":
    case "cancelled":
    case "closed":
      return "var(--text-faint)";
    default:
      return "var(--text-faint)";
  }
}

export function stateLabel(state: ThreadState): string {
  return state.replace(/_/g, " ");
}

export function runActive(state: AgentRunState): boolean {
  return state === "running" || state === "starting";
}

/** Whether a task's clock should be ticking — i.e. a role is actively working it. Parked
 *  (paused / awaiting / review) and terminal states freeze the clock at its last duration. */
export function threadRunning(state: ThreadState): boolean {
  switch (state) {
    case "intake":
    case "enriching":
    case "planning":
    case "researching":
    case "implementing":
    case "qa":
      return true;
    default:
      return false;
  }
}

/** A task in a terminal state: finished and not resumable into the live pipeline. Mirrors the
 *  `terminal` predicate in ThreadDetail (which gates the Cancel button). */
export function isTerminal(state: ThreadState): boolean {
  return state === "done" || state === "cancelled" || state === "failed";
}

/** Whether the owner can manually accept a task as finished. Parked review/paused tasks only — the
 *  states the pipeline can't auto-complete (QA owns 'done'), mirroring DONEABLE on the server. */
export function isDoneable(state: ThreadState): boolean {
  return state === "review" || state === "paused";
}

/** Whether a card may be soft-closed (moved to the Closed holding area). The closeable set —
 *  done/failed/cancelled/review/paused — is the parked, not-actively-running states EXCEPT
 *  awaiting_user/awaiting_approval (those hold a pending resolver that closing wouldn't settle).
 *  Live pipeline states keep the ✕ hidden so active work is never discarded. The server enforces the
 *  same set authoritatively in `closeThread` (which also force-stops any stale lingering run). */
export function isClosable(state: ThreadState): boolean {
  return state === "done" || state === "failed" || state === "cancelled" || state === "review" || state === "paused";
}

/** A closed task auto-purges 30 days after it was closed; mirrors CLOSED_TTL_MS on the server. */
export const CLOSED_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Whole days remaining before a closed task auto-removes (0 = within the last day). */
export function closesInDays(closedAt: number): number {
  return Math.max(0, Math.ceil((closedAt + CLOSED_TTL_MS - Date.now()) / (24 * 60 * 60 * 1000)));
}

/** Compact running-or-final duration: "9s", "2m 34s", "1h 12m". */
export function elapsed(startMs: number, endMs?: number | null): string {
  const s = Math.max(0, Math.floor(((endMs ?? Date.now()) - startMs) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function sevColor(sev: string): string {
  switch (sev) {
    case "critical":
      return "var(--crit)";
    case "warning":
      return "var(--warn)";
    case "info":
      return "var(--text-dim)";
    default:
      return "var(--warn)";
  }
}

export function ago(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function clock(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** Wall-clock HH:MM (no seconds) in the viewer's locale — for the "resumes 7:10 PM" reset label. */
export function clockHM(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** The server's cap-park marker — a task settles into `review` with this prefix on its `error` ONLY
 *  when EVERY account was rate-limited mid-task, in which case the supervisor (resumeCapParked) will
 *  auto-resume it the moment one frees up. A plain "needs your review" park carries no marker. KEEP IN
 *  SYNC with CAP_PARK_PREFIX in server/src/orchestrator/threadManager.ts — if the server text changes,
 *  the frozen badge silently stops appearing. */
export const CAP_PARK_PREFIX = "⏳ Auto-resume pending";

/** Whether a task is frozen waiting on a token freeze — parked in `review` with the cap-park marker.
 *  Mirrors the server's own resumeCapParked scan, so it's true exactly when the task is genuinely
 *  blocked on rate limits (never on a human-review park — no false positives). */
export function isCapParked(thread: Thread): boolean {
  return thread.state === "review" && (thread.error ?? "").startsWith(CAP_PARK_PREFIX);
}

/** The soonest moment any account frees up: the min future reset across accounts. Mirrors the server's
 *  AccountManager.soonestResetAt (rateLimitResetAt ?? fiveHourReset), with the weekly window as a last
 *  resort so a known reset still surfaces. Null when no future reset is known — caller shows the badge
 *  without a time clause rather than an Invalid Date. */
export function soonestReset(accounts: AccountDTO[]): number | null {
  const now = Date.now();
  let soonest: number | null = null;
  for (const a of accounts) {
    const reset = a.resetsAt ?? a.fiveHourReset ?? a.sevenDayReset;
    if (reset != null && reset > now && (soonest == null || reset < soonest)) soonest = reset;
  }
  return soonest;
}
