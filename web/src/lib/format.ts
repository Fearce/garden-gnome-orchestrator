import type { AgentRunState, Role, ThreadState } from "../types.js";

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
