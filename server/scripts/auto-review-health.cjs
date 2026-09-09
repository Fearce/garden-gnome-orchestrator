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

/** `unattended_streak` arrived after this probe did, and the sweep must survive being pointed at a DB
 *  the new server has not opened yet. Select NULL there — an unmeasured column, not a healthy zero. */
function episodeStreakExpr(db) {
  const present = db
    .prepare("SELECT 1 FROM pragma_table_info('auto_review_episodes') WHERE name='unattended_streak'")
    .get();
  return present ? "e.unattended_streak" : "NULL";
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
      ${episodeStreakExpr(db)} AS unattendedStreak,
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
    // null on a DB that predates the column — "not measured", never a reassuring 0.
    unattendedStreak: hasEpisode && row.unattendedStreak != null ? Number(row.unattendedStreak) : null,
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
  if (row.unattendedStreak != null && (!Number.isInteger(row.unattendedStreak) || row.unattendedStreak < 0)) {
    issues.push("unattended_streak must be a non-negative integer");
  }
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

  // The claim gate refuses at the budget, so the streak can reach it and never pass it. Above it means
  // an unattended claim got through a spent budget — the loop reopening, which is the whole point.
  const budget = unattendedBudget();
  if (row.unattendedStreak != null && row.unattendedStreak > budget) {
    issues.push(`${row.unattendedStreak} consecutive unattended auto-reviews exceeds the budget of ${budget} — the per-task bound leaked`);
  } else if (row.unattendedStreak != null && row.unattendedStreak >= budget) {
    notes.push(`the unattended budget is spent (${row.unattendedStreak}/${budget}); the Supervisor will not re-review this task until you do, it is accepted, or it is retried`);
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

// ---------------------------------------------------------------------------------------------
// Historical convergence — "did the unattended Supervisor re-review the same unchanged work?"
//
// The episode row above is CURRENT state: `auto_review_episodes` is keyed by thread_id and is
// overwritten on every new revision, so it cannot answer the question the owner actually asks after
// disabling the Supervisor ("is the loop closed — is it safe to turn back on?"). That answer lives in
// `supervisor_events`, which is append-only:
//
//   kind='action', action='start_auto_review'  ->  an unattended review that ACTUALLY started
//   kind='skip',   action='start_auto_review'  ->  one that did not (the fence, or a race guard)
//
// Two reviewer runs on one revision are NOT the loop — the reviewer recovers its own involuntary
// stops (MAX_REVIEW_RECOVERIES) and a fix round re-checks its own work, both inside ONE claim. The
// two loop shapes are a second unattended CLAIM on unchanged work, or a claim whose persisted task
// counter crossed its budget after intermediate work kept minting revisions.

// The exact sentences `db.autoReviewAutomationBlock` emits. Wording drift here does not throw — it
// silently turns "the fence fired N times" into zero, i.e. into a quiet, wrong all-clear. The gate
// pins each literal against db.ts for that reason (same discipline as PARK_CLASSES).
const SUPPRESSION_LITERALS = [
  "Auto-review already owns this unchanged task.",
  "This revision already has a recorded accepted auto-review verdict.",
  "Auto-review already parked this unchanged task:",
  "This task has a verified manual deployment handoff and is terminal in GGO.",
  "Auto-review already ran unattended",
];

// Appended to `supervisor_events.detail` when a launch succeeds. Unlike a raw per-task launch count,
// this survives episode resets without confusing a legitimate owner-triggered reset for a budget leak.
const ATTEMPT_DETAIL_PATTERN = /\bunattended auto-review attempt (\d+)\/(\d+)\b/i;

/** `config.maxUnattendedAutoReviews`'s default, mirrored because a .cjs probe cannot import config.ts.
 *  The gate pins it against that source, so a changed default fails here instead of drifting silently. */
const UNATTENDED_BUDGET_DEFAULT = 2;

function unattendedBudget() {
  const n = Number(process.env.MAX_UNATTENDED_AUTO_REVIEWS);
  return Math.max(1, Math.floor(Number.isFinite(n) ? n : UNATTENDED_BUDGET_DEFAULT));
}

// fix: make auto-review converge — the commit that made one unattended claim per work revision
// durable. Recorded as a SHA and resolved through git at runtime (never a hardcoded date), so a
// rebase moves it without a source edit; see recovery-features.cjs for the same convention.
const CONVERGENCE_FIX_COMMIT = "6532716";

const HISTORY_DEFAULT_DAYS = 30;

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function supervisorEventsTableExists(db) {
  return tableExists(db, "supervisor_events");
}

/** Whether the Supervisor is switched on right now. `null` when the setting has never been written
 *  (or the kv table predates it) — which is NOT the same as "off" and must not be reported as such. */
function supervisorEnabled(db) {
  if (!tableExists(db, "kv")) return null;
  const row = db.prepare("SELECT value FROM kv WHERE key='setting_director_supervisor_enabled'").get();
  if (!row || row.value == null) return null;
  return String(row.value) === "1";
}

/**
 * Every unattended auto-review decision in the window. Each carries the work revision live at that
 * instant — the correlated subquery mirrors `db.autoReviewRevision` exactly (role<>'reviewer',
 * started_at DESC then rowid DESC) so the probe reads the same identity the runtime fence compares.
 *
 * Each launched review also carries `workSincePreviousClaim`: non-reviewer runs that started STRICTLY
 * between it and this thread's previous launched review. That interval is the repeat test, and its
 * bounds are the two audit rows themselves — deliberately not "since the last reviewer run", which is
 * unusable: a claim's own reviewer run is written a fraction before the audit row, so every claim would
 * pick up its own reviewer as the boundary and read as work-free.
 */
function selectAutoReviewClaimHistory(db, { sinceMs = 0 } = {}) {
  const events = db
    .prepare(`
      SELECT
        e.id            AS eventId,
        e.thread_id     AS threadId,
        e.thread_title  AS threadTitle,
        e.created_at    AS createdAt,
        e.kind          AS kind,
        e.trigger       AS trigger,
        e.used_agent    AS usedAgent,
        e.summary       AS summary,
        e.detail        AS detail,
        (SELECT w.id FROM agent_runs w
          WHERE w.thread_id = e.thread_id AND w.role <> 'reviewer' AND w.started_at <= e.created_at
          ORDER BY w.started_at DESC, w.rowid DESC LIMIT 1) AS workRunId
      FROM supervisor_events e
      WHERE e.action = 'start_auto_review' AND e.thread_id IS NOT NULL AND e.created_at >= @since
      ORDER BY e.created_at, e.rowid`)
    .all({ since: sinceMs })
    .map((row) => {
      const attempt = String(row.detail ?? "").match(ATTEMPT_DETAIL_PATTERN);
      return {
        ...row,
        createdAt: Number(row.createdAt),
        usedAgent: Number(row.usedAgent) === 1,
        revision: row.workRunId ? `run:${row.workRunId}` : `thread:${row.threadId}`,
        fenced: SUPPRESSION_LITERALS.some((literal) => String(row.summary ?? "").includes(literal)),
        unattendedAttempt: attempt ? Number(attempt[1]) : null,
        unattendedBudgetAtClaim: attempt ? Number(attempt[2]) : null,
        previousClaimAt: null,
        workSincePreviousClaim: null,
      };
    });

  const countWork = db.prepare(
    `SELECT COUNT(*) AS n FROM agent_runs
      WHERE thread_id = ? AND role <> 'reviewer' AND started_at > ? AND started_at < ?`,
  );
  const previousClaim = new Map();
  for (const event of events) {
    if (event.kind !== "action") continue;
    const previousAt = previousClaim.get(event.threadId);
    if (previousAt != null) {
      event.previousClaimAt = previousAt;
      event.workSincePreviousClaim = Number(countWork.get(event.threadId, previousAt, event.createdAt).n);
    }
    previousClaim.set(event.threadId, event.createdAt);
  }
  return events;
}

/**
 * Classify the window. `fixAt` is the convergence fix's ship time in epoch ms (null when the SHA no
 * longer resolves, e.g. a rewritten history — every repeat then reads as post-fix, which errs toward
 * reporting rather than toward a quiet all-clear).
 *
 * THE BOUNDARY THAT BIT: `repeats` only sees a repeat with NO work in between, and a loop mediated by
 * new task runs can therefore look healthy per revision while one task absorbs review after review.
 * New launch events carry the episode's attempt/budget counter, so an over-budget launch stays provable
 * after a later owner review or acceptance resets the live episode. Older rows have no counter; their raw
 * per-task load is still shown as context but is not treated as a verdict because historical owner resets
 * were not recorded there. The current episode invariant remains checked by `autoReviewReading`.
 */
function autoReviewHistoryReading(events, { fixAt = null, enabled = null, windowDays = HISTORY_DEFAULT_DAYS } = {}) {
  const launches = events.filter((event) => event.kind === "action");
  const skips = events.filter((event) => event.kind === "skip");
  const fenced = skips.filter((event) => event.fenced);

  // A second unattended review with nothing done in between is the loop: the reviewer's own hand-back is
  // not new work, so re-reviewing it can only reach the same verdict. Work in between — an owner
  // injection, a resume, a fix the owner asked for — is a new question and a legitimate second look.
  const repeats = launches
    .filter((launch) => launch.previousClaimAt != null && launch.workSincePreviousClaim === 0)
    .map((launch) => ({
      eventId: launch.eventId,
      threadId: launch.threadId,
      title: launch.threadTitle,
      revision: launch.revision,
      previousAt: launch.previousClaimAt,
      at: launch.createdAt,
      postFix: fixAt == null || launch.createdAt >= fixAt,
    }))
    .sort((a, b) => b.at - a.at);
  const postFixRepeats = repeats.filter((repeat) => repeat.postFix);

  // This is the cross-revision loop detector. A legitimate explicit owner retry resets the next marker
  // to 1, so only a claim that actually crossed its persisted runtime budget is red.
  const budgetLeaks = launches
    .filter((launch) =>
      Number.isInteger(launch.unattendedAttempt) &&
      Number.isInteger(launch.unattendedBudgetAtClaim) &&
      launch.unattendedAttempt > launch.unattendedBudgetAtClaim)
    .map((launch) => ({
      eventId: launch.eventId,
      threadId: launch.threadId,
      title: launch.threadTitle,
      revision: launch.revision,
      at: launch.createdAt,
      attempt: launch.unattendedAttempt,
      budget: launch.unattendedBudgetAtClaim,
    }))
    .sort((a, b) => b.at - a.at);

  const violationsByEvent = new Map();
  for (const repeat of postFixRepeats) violationsByEvent.set(repeat.eventId, { kind: "revision-repeat", ...repeat });
  for (const leak of budgetLeaks) violationsByEvent.set(leak.eventId, { kind: "task-budget", ...leak });
  const violations = [...violationsByEvent.values()].sort((a, b) => b.at - a.at);

  // How many unattended reviews each task actually received. Per REVISION this window looked clean;
  // per TASK it did not. Always reported, so the shape that hid the loop cannot hide again.
  const perTask = new Map();
  for (const launch of launches) {
    const entry = perTask.get(launch.threadId) ?? { threadId: launch.threadId, title: launch.threadTitle, launches: 0, firstAt: launch.createdAt, lastAt: launch.createdAt };
    entry.launches += 1;
    entry.lastAt = launch.createdAt;
    perTask.set(launch.threadId, entry);
  }
  const launchesPerTask = [...perTask.values()].sort((a, b) => b.launches - a.launches || b.lastAt - a.lastAt);

  // A window with no unattended claim proves nothing about convergence. Saying PASS there is the
  // dangerous direction: it suppresses the investigation it was meant to license.
  const verdict = violations.length ? "LOOP" : launches.length ? "PASS" : "NO EVIDENCE";
  return {
    verdict,
    windowDays,
    fixAt,
    enabled,
    launches: launches.length,
    revisions: new Set(launches.map((launch) => `${launch.threadId}|${launch.revision}`)).size,
    launchesPerTask,
    busiestTask: launchesPerTask[0] ?? null,
    unattendedBudget: unattendedBudget(),
    taskBudgetMeasuredClaims: launches.filter((launch) => launch.unattendedAttempt != null).length,
    taskBudgetUnmeasuredClaims: launches.filter((launch) => launch.unattendedAttempt == null).length,
    repeats,
    postFixRepeats,
    preFixRepeats: repeats.filter((repeat) => !repeat.postFix),
    budgetLeaks,
    violations,
    fencedFree: fenced.filter((event) => !event.usedAgent).length,
    fencedPaid: fenced.filter((event) => event.usedAgent).length,
    otherSkips: skips.length - fenced.length,
    lastLaunchAt: launches.length ? launches[launches.length - 1].createdAt : null,
    lastFencedAt: fenced.length ? fenced[fenced.length - 1].createdAt : null,
  };
}

module.exports = {
  ATTEMPT_DETAIL_PATTERN,
  CONVERGENCE_FIX_COMMIT,
  HISTORY_DEFAULT_DAYS,
  SUPPRESSION_LITERALS,
  UNATTENDED_BUDGET_DEFAULT,
  unattendedBudget,
  autoReviewHistoryReading,
  autoReviewReading,
  autoReviewTableExists,
  selectAutoReviewClaimHistory,
  selectAutoReviewRows,
  supervisorEnabled,
  supervisorEventsTableExists,
};
