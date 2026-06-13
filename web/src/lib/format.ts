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
      return "var(--accent)";
    case "done":
      return "var(--ok)";
    case "failed":
      return "var(--danger)";
    case "paused":
    case "awaiting_user":
    case "review":
      return "var(--warn)";
    case "cancelled":
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
