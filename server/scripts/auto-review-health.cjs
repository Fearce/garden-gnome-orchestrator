// Durable auto-review episode diagnostics shared by probe:auto-review and probe:task-runs.
//
// Keep the classification here, rather than copying SQL/heuristics into each probe. The episode row is
// the ownership and idempotency authority; reviewer findings alone cannot distinguish a rejected verdict,
// a verdict-less run, restart reconciliation, or an explicit owner retry.

const VALID_STATUSES = new Set(["running", "accepted", "parked"]);
const VALID_SOURCES = new Set(["owner", "supervisor", "reconciled"]);
const ACTIVE_STATES = new Set(["reviewing", "implementing", "awaiting_user"]);
const TERMINAL_STATES = new Set(["done", "closed", "cancelled"]);

function autoReviewTableExists(db) {
  return !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='auto_review_episodes'")
    .get();
}

/**
 * Read every durable episode plus the one unsafe legacy shape: a review task whose latest reviewer run
 * covers its latest non-reviewer work, but which has no episode to suppress an unattended relaunch.
 * Passing threadId returns that thread even when it has no episode, for probe:task-runs.
 */
function selectAutoReviewRows(db, threadId = null) {
  const scope = threadId
    ? "WHERE t.id = ?"
    : `WHERE e.thread_id IS NOT NULL
          OR (
            t.state = 'review'
            AND EXISTS (SELECT 1 FROM agent_runs rr WHERE rr.thread_id=t.id AND rr.role='reviewer')
          )`;
  const sql = `
    SELECT
      t.id AS threadId,
      t.title AS title,
      t.state AS threadState,
      t.error AS threadError,
      t.created_at AS threadCreatedAt,
      t.updated_at AS threadUpdatedAt,
      e.thread_id AS episodeThreadId,
      e.revision AS episodeRevision,
      e.status AS status,
      e.source AS source,
      e.claim_token AS claimToken,
      e.attempt_count AS attemptCount,
      e.reason AS reason,
      e.verdict_json AS verdictJson,
      e.verdict_run_id AS verdictRunId,
      e.started_at AS startedAt,
      e.settled_at AS settledAt,
      e.updated_at AS episodeUpdatedAt,
      (SELECT wr.id FROM agent_runs wr
        WHERE wr.thread_id=t.id AND wr.role<>'reviewer'
        ORDER BY wr.started_at DESC, wr.rowid DESC LIMIT 1) AS latestWorkRunId,
      (SELECT wr.started_at FROM agent_runs wr
        WHERE wr.thread_id=t.id AND wr.role<>'reviewer'
        ORDER BY wr.started_at DESC, wr.rowid DESC LIMIT 1) AS latestWorkStartedAt,
      (SELECT wr.rowid FROM agent_runs wr
        WHERE wr.thread_id=t.id AND wr.role<>'reviewer'
        ORDER BY wr.started_at DESC, wr.rowid DESC LIMIT 1) AS latestWorkRowid,
      (SELECT rr.id FROM agent_runs rr
        WHERE rr.thread_id=t.id AND rr.role='reviewer'
        ORDER BY rr.started_at DESC, rr.rowid DESC LIMIT 1) AS latestReviewerRunId,
      (SELECT rr.started_at FROM agent_runs rr
        WHERE rr.thread_id=t.id AND rr.role='reviewer'
        ORDER BY rr.started_at DESC, rr.rowid DESC LIMIT 1) AS latestReviewerStartedAt,
      (SELECT rr.rowid FROM agent_runs rr
        WHERE rr.thread_id=t.id AND rr.role='reviewer'
        ORDER BY rr.started_at DESC, rr.rowid DESC LIMIT 1) AS latestReviewerRowid,
      (SELECT COUNT(*) FROM agent_runs rr
        WHERE rr.thread_id=t.id AND rr.role='reviewer') AS reviewerRuns,
      (SELECT COUNT(*) FROM agent_runs rr
        WHERE rr.thread_id=t.id AND rr.role='reviewer'
          AND e.settled_at IS NOT NULL
          AND rr.started_at > e.updated_at) AS reviewerRunsAfterSettle
    FROM threads t
    LEFT JOIN auto_review_episodes e ON e.thread_id=t.id
    ${scope}
    ORDER BY COALESCE(e.updated_at, t.updated_at) DESC, t.id`;
  const rows = (threadId ? db.prepare(sql).all(threadId) : db.prepare(sql).all()).map(normalizeRow);
  return threadId
    ? rows
    : rows.filter((row) => row.hasEpisode || (row.threadState === "review" && row.reviewerCoversCurrentRevision));
}

function normalizeRow(row) {
  const hasEpisode = row.episodeThreadId != null;
  const currentRevision = row.latestWorkRunId
    ? `run:${row.latestWorkRunId}`
    : `thread:${row.threadId}:${Number(row.threadCreatedAt)}`;
  const latestReviewerAfterWork =
    row.latestReviewerRunId != null &&
    (row.latestWorkRunId == null ||
      Number(row.latestReviewerStartedAt) > Number(row.latestWorkStartedAt) ||
      (Number(row.latestReviewerStartedAt) === Number(row.latestWorkStartedAt) &&
        Number(row.latestReviewerRowid) > Number(row.latestWorkRowid)));
  return {
    ...row,
    hasEpisode,
    currentRevision,
    reviewerCoversCurrentRevision: latestReviewerAfterWork,
    attemptCount: hasEpisode ? Number(row.attemptCount) : null,
    reviewerRuns: Number(row.reviewerRuns ?? 0),
    reviewerRunsAfterSettle: Number(row.reviewerRunsAfterSettle ?? 0),
  };
}

function parseVerdict(raw) {
  if (raw == null) return { value: null, error: null };
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { value: null, error: "verdict_json is not a JSON object" };
    }
    return { value, error: null };
  } catch {
    return { value: null, error: "verdict_json is invalid JSON" };
  }
}

function nonBlank(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/** Classify one normalized row. `attention` is reserved for durable invariant violations. */
function autoReviewReading(row) {
  const issues = [];
  const notes = [];
  const verdict = parseVerdict(row.verdictJson);

  if (!row.hasEpisode) {
    if (row.threadState === "review" && row.reviewerCoversCurrentRevision) {
      issues.push("the latest reviewer covers the current work, but no durable episode fences another unattended launch");
    }
    return {
      row,
      disposition: issues.length ? "attention" : "none",
      attention: issues.length > 0,
      issues,
      notes,
      verdict: null,
      revisionCurrent: false,
    };
  }

  if (!VALID_STATUSES.has(row.status)) issues.push(`unknown episode status '${row.status}'`);
  if (!VALID_SOURCES.has(row.source)) issues.push(`unknown episode source '${row.source}'`);
  if (!Number.isInteger(row.attemptCount) || row.attemptCount < 1) issues.push("attempt_count must be a positive integer");
  if (!nonBlank(row.episodeRevision)) issues.push("the episode has no revision identity");
  if (verdict.error) issues.push(verdict.error);

  if (row.status === "running") {
    if (!nonBlank(row.claimToken)) issues.push("a running episode has no claim token");
    if (row.settledAt != null) issues.push("a running episode already has settled_at");
    if (!ACTIVE_STATES.has(row.threadState)) {
      issues.push(`a running episode owns a task in non-review state '${row.threadState}'`);
    }
  } else if (VALID_STATUSES.has(row.status)) {
    if (row.claimToken != null) issues.push("a terminal episode still exposes a claim token");
    if (row.settledAt == null) issues.push("a terminal episode has no settled_at");
  }

  if (row.status === "accepted") {
    if (verdict.value?.accept !== true) issues.push("accepted status has no valid accept=true verdict");
    if (row.source === "reconciled") issues.push("legacy reconciliation must never infer acceptance");
  }
  if (row.status === "parked") {
    if (!nonBlank(row.reason)) issues.push("a parked episode has no persisted reason");
    if (verdict.value?.accept === true) issues.push("a parked episode carries a contradictory accept=true verdict");
  }
  if (row.source === "supervisor" && row.attemptCount > 1) {
    issues.push(`the unattended Supervisor claimed the same revision ${row.attemptCount} times`);
  }
  if (row.reviewerRunsAfterSettle > 0) {
    issues.push(`${row.reviewerRunsAfterSettle} reviewer run(s) started after this episode settled`);
  }

  const revisionCurrent = row.episodeRevision === row.currentRevision;
  if (revisionCurrent && row.status === "accepted" && !TERMINAL_STATES.has(row.threadState)) {
    issues.push(`an accepted current revision left the task in '${row.threadState}' instead of a terminal state`);
  }
  if (revisionCurrent && row.status === "parked" && row.threadState === "review") {
    if (!nonBlank(row.threadError)) {
      issues.push("the parked reason is not visible on the review task");
    } else if (row.threadError.trim() !== row.reason?.trim()) {
      issues.push("the owner-visible task reason differs from the durable parked reason");
    }
  }

  if (row.source === "reconciled" && row.attemptCount > 1) {
    notes.push(`${row.attemptCount} historical reviewer attempts were imported and fenced; this is repaired history, not a new retry`);
  } else if (row.source === "owner" && row.attemptCount > 1) {
    notes.push(`${row.attemptCount} attempts were explicit owner retries on unchanged work`);
  }

  let disposition = "progressed";
  if (issues.length) disposition = "attention";
  else if (row.status === "running") disposition = "active";
  else if (!revisionCurrent) disposition = row.threadState === "review" ? "eligible" : "superseded";
  else if (row.status === "accepted") disposition = "accepted";
  else if (row.status === "parked" && row.threadState === "review") disposition = "parked";
  else if (TERMINAL_STATES.has(row.threadState)) disposition = "owner-settled";

  return {
    row,
    disposition,
    attention: issues.length > 0,
    issues,
    notes,
    verdict: verdict.value,
    revisionCurrent,
  };
}

module.exports = {
  autoReviewReading,
  autoReviewTableExists,
  selectAutoReviewRows,
};
