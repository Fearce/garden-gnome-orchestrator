// Pure operator-facing reading of an active-task deadline. The probe reads raw SQLite rows
// (snake_case), while tests and other diagnostics may pass mapped Thread objects (camelCase), so
// accept both without duplicating the deadline-state interpretation at each call site.

const { localStamp } = require("./task-timeline.cjs");

const ACTIVE_DEADLINE_PARK_PREFIX = "⏰ Hard deadline reached";
const TERMINAL_STATES = new Set(["done", "cancelled", "closed"]);

function deadlineEpoch(thread) {
  const raw = thread?.active_deadline_at ?? thread?.activeDeadlineAt;
  if (raw == null) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function compactDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(Math.abs(ms) / 1000));
  if (totalSeconds === 0) return "<1s";
  const units = [
    ["d", 86_400],
    ["h", 3_600],
    ["m", 60],
    ["s", 1],
  ];
  let remaining = totalSeconds;
  const parts = [];
  for (const [suffix, size] of units) {
    const amount = Math.floor(remaining / size);
    if (amount > 0) {
      parts.push(`${amount}${suffix}`);
      remaining -= amount * size;
    }
    if (parts.length === 2) break;
  }
  return parts.join(" ");
}

function relativeDeadline(deadlineAt, now) {
  const delta = deadlineAt - now;
  if (delta > 0) return `${compactDuration(delta)} remaining`;
  if (delta === 0) return "due now";
  return `expired ${compactDuration(delta)} ago`;
}

/**
 * Return a concise persisted/enforcement reading suitable for console.log inspection.
 * `blocked` describes automatic dispatch/resume right now, not whether a manual Resume is visible.
 */
function activeDeadlineReading(
  thread,
  { now = Date.now(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone } = {},
) {
  const deadlineAt = deadlineEpoch(thread);
  const terminal = TERMINAL_STATES.has(thread?.state);
  const parked = String(thread?.error ?? "").startsWith(ACTIVE_DEADLINE_PARK_PREFIX);

  if (deadlineAt == null) {
    if (parked && !terminal) {
      return {
        at: null,
        status: "cleared; task remains deadline-parked — automatic dispatch/resume blocked until you click Resume",
        blocked: true,
      };
    }
    return { at: null, status: "not appointed", blocked: false };
  }

  const reading = {
    at: localStamp(deadlineAt, timeZone),
    relative: relativeDeadline(deadlineAt, now),
    blocked: false,
  };

  if (terminal) {
    return { ...reading, status: "inactive — task is terminal" };
  }
  if (parked) {
    return {
      ...reading,
      status:
        deadlineAt <= now
          ? "expired + parked — automatic dispatch/resume blocked; extend or clear, then click Resume"
          : "extended; task remains deadline-parked — click Resume to continue deliberately",
      blocked: true,
    };
  }
  if (deadlineAt <= now) {
    return {
      ...reading,
      status: "OVERDUE without a persisted deadline park — enforcement/reconcile needs attention",
      blocked: true,
    };
  }
  return {
    ...reading,
    status: "armed — server will stop live work and block automatic dispatch/resume at expiry",
  };
}

module.exports = {
  ACTIVE_DEADLINE_PARK_PREFIX,
  activeDeadlineReading,
  compactDuration,
  deadlineEpoch,
  relativeDeadline,
};
