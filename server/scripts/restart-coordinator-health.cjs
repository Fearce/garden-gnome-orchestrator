/**
 * Validate and summarize the public restart-coordinator status contract.
 *
 * Kept pure so the nightly health probe can distinguish an idle coordinator, a healthy drain,
 * an in-flight bounce, and a refused restart without re-implementing server policy or touching prod.
 */

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function workLabel(count) {
  return `${count} active work item${count === 1 ? "" : "s"}`;
}

function inspectRestartCoordinator(status) {
  const issues = [];
  if (!isRecord(status)) {
    return {
      valid: false,
      level: "warn",
      message: "restart coordinator returned a non-object status",
      issues: ["status must be an object"],
    };
  }

  if (!Number.isFinite(status.now)) issues.push("now must be a finite timestamp");
  if (!Number.isInteger(status.activeWork) || status.activeWork < 0) {
    issues.push("activeWork must be a non-negative integer");
  }
  if (typeof status.draining !== "boolean") issues.push("draining must be boolean");

  const decision = status.decision;
  if (!isRecord(decision)) {
    issues.push("decision must be an object");
  } else {
    if (typeof decision.allow !== "boolean") issues.push("decision.allow must be boolean");
    if (typeof decision.reason !== "string" || !decision.reason.trim()) {
      issues.push("decision.reason must be a non-empty string");
    }
    if (decision.allow === false && decision.retryAt !== null && !Number.isFinite(decision.retryAt)) {
      issues.push("a deferred decision.retryAt must be null or finite");
    }
    if (Number.isInteger(status.activeWork) && status.activeWork > 0 && decision.allow !== false) {
      issues.push("decision cannot allow a restart while work is active");
    }
  }

  const pending = status.pending;
  if (pending !== null && !isRecord(pending)) {
    issues.push("pending must be null or an object");
  } else if (pending) {
    if (!Array.isArray(pending.requesters) || pending.requesters.length === 0) {
      issues.push("pending.requesters must contain at least one staged build");
    }
    if (!Number.isInteger(pending.failures) || pending.failures < 0) {
      issues.push("pending.failures must be a non-negative integer");
    }
    if (pending.retryAt !== null && !Number.isFinite(pending.retryAt)) {
      issues.push("pending.retryAt must be null or finite");
    }
    if (typeof status.pendingLabel !== "string" || !status.pendingLabel.trim()) {
      issues.push("pendingLabel must describe a pending restart");
    }
  } else if (status.pendingLabel !== null) {
    issues.push("pendingLabel must be null when no restart is pending");
  }

  if (issues.length) {
    return {
      valid: false,
      level: "warn",
      message: `restart coordinator status is malformed: ${issues.join("; ")}`,
      issues,
    };
  }

  const active = workLabel(status.activeWork);
  if (pending) {
    const staged = pending.requesters.length;
    const failures = pending.failures;
    const detail = `${status.pendingLabel}; ${staged} staged build${staged === 1 ? "" : "s"}, ${active}`;
    return failures > 0
      ? {
          valid: true,
          level: "warn",
          message: `restart coordinator: ${detail}; ${failures} refused restart attempt${failures === 1 ? "" : "s"}`,
          issues: [],
        }
      : { valid: true, level: "ok", message: `restart coordinator: ${detail}`, issues: [] };
  }

  if (status.draining) {
    return {
      valid: true,
      level: "ok",
      message: `restart coordinator: restart in flight; fresh work is paused (${active})`,
      issues: [],
    };
  }

  return {
    valid: true,
    level: "ok",
    message: `restart coordinator: idle (no restart pending); tracking ${active}`,
    issues: [],
  };
}

module.exports = { inspectRestartCoordinator };
