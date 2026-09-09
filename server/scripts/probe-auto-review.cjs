#!/usr/bin/env node
// Read-only board-wide audit of durable auto-review ownership and convergence.
//
// Two questions, two sections. The per-task section reads the CURRENT episode row: does every task's
// ownership, verdict and park text hold together right now. The convergence section reads the
// append-only Supervisor audit instead, and answers the one the owner asks after switching the
// Supervisor off: did the unattended lane repeat unchanged work or cross its task-level budget.
//
// Exit 0 = no invariant violations, 1 = actionable inconsistency (including a post-fix repeat claim),
// 2 = usage/schema error.

const path = require("node:path");
const Database = require("better-sqlite3");
const {
  CONVERGENCE_FIX_COMMIT,
  HISTORY_DEFAULT_DAYS,
  autoReviewHistoryReading,
  autoReviewReading,
  autoReviewTableExists,
  selectAutoReviewClaimHistory,
  selectAutoReviewRows,
  supervisorEnabled,
  supervisorEventsTableExists,
} = require("./auto-review-health.cjs");
const { resolveShipDate } = require("./recovery-features.cjs");

const USAGE = "usage: node scripts/probe-auto-review.cjs [--json] [--days N]";
const args = process.argv.slice(2);
let days = HISTORY_DEFAULT_DAYS;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--json") continue;
  const inline = arg.startsWith("--days=") ? arg.slice("--days=".length) : arg === "--days" ? args[++i] : null;
  if (inline == null) {
    console.error(USAGE);
    process.exit(2);
  }
  days = Number(inline);
  if (!Number.isFinite(days) || days <= 0) {
    console.error(`--days needs a positive number of days, got '${inline}' - ${USAGE}`);
    process.exit(2);
  }
}
const json = args.includes("--json");
const dbPath = process.env.ORCH_DB
  ? path.resolve(process.env.ORCH_DB)
  : path.resolve(__dirname, "..", "data", "orchestrator.sqlite");

let db;
try {
  db = new Database(dbPath, { readonly: true });
  db.pragma("busy_timeout = 5000");
} catch (error) {
  console.error(`Cannot open orchestrator DB read-only at ${dbPath}: ${error.message}`);
  process.exit(2);
}

if (!autoReviewTableExists(db)) {
  db.close();
  console.error(`auto_review_episodes is absent in ${dbPath}; this DB predates durable auto-review ownership.`);
  process.exit(2);
}

const readings = selectAutoReviewRows(db).map(autoReviewReading);
const fixShipDate = resolveShipDate(CONVERGENCE_FIX_COMMIT);
const history = supervisorEventsTableExists(db)
  ? autoReviewHistoryReading(selectAutoReviewClaimHistory(db, { sinceMs: Date.now() - days * 86_400_000 }), {
      fixAt: fixShipDate ? fixShipDate.getTime() : null,
      enabled: supervisorEnabled(db),
      windowDays: days,
    })
  : null;
db.close();

const counts = {};
for (const reading of readings) counts[reading.disposition] = (counts[reading.disposition] ?? 0) + 1;
const attention = readings.filter((reading) => reading.attention);

function short(value, max = 220) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function stamp(ms) {
  return ms == null ? "never" : new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

/** The headline's convergence clause. "0 repeat claims" is a MEASUREMENT, so it must not be printed for
 *  a window that measured nothing — that reads as an all-clear to anyone skimming the first line only. */
function convergenceHeadline() {
  if (!history) return "no unattended review history in this DB";
  if (history.verdict === "NO EVIDENCE") return "no unattended review in the window - see below";
  return `${looping} unattended loop violation(s)`;
}

function supervisorStateLine() {
  if (history.enabled === false) {
    return "The Supervisor is OFF right now, so this window is history rather than a live measurement.";
  }
  if (history.enabled == null) {
    return "The Supervisor setting has never been written (it defaults to off), so this window may predate any unattended work.";
  }
  return "The Supervisor is ON, so this window measures the lane as it currently runs.";
}

/** How many unattended reviews each TASK received in the selected window. This is historical load, not
 *  a budget verdict: old Supervisor rows did not record explicit-owner resets. New rows carry an exact
 *  attempt/budget marker and are classified separately by `budgetLeaks`. */
function printPerTaskLoad() {
  const budget = history.unattendedBudget;
  const loaded = history.launchesPerTask.filter((task) => task.launches >= budget);
  if (!loaded.length) {
    console.log(`  Historical task load: busiest task took ${history.busiestTask?.launches ?? 0} unattended review(s) in this window.`);
    return;
  }
  console.log(`  Historical task load: ${loaded.length} task(s) received at least ${budget} unattended review(s) in this window:`);
  for (const task of loaded.slice(0, 10)) {
    console.log(
      `    ${task.threadId.slice(0, 8)} x${task.launches} - ${short(task.title, 60)}\n` +
        `      ${stamp(task.firstAt)} .. ${stamp(task.lastAt)}; raw load only (legacy rows do not record owner resets)`,
    );
  }
}

/** The convergence section. It reports its own evidence basis on purpose: an empty window is not a
 *  clean bill of health, and printing one would license exactly the investigation it skipped. */
function printConvergence() {
  if (!history) {
    console.log("\nUnattended convergence: supervisor_events is absent, so this DB records no unattended review history.");
    return;
  }
  const shipped = fixShipDate ? `${CONVERGENCE_FIX_COMMIT}, ${stamp(fixShipDate.getTime())}` : `${CONVERGENCE_FIX_COMMIT} (unresolved SHA - every repeat below counts)`;
  console.log(`\nUnattended convergence (last ${history.windowDays}d) - ${history.verdict}`);
  console.log(`  ${supervisorStateLine()}`);

  if (history.verdict === "NO EVIDENCE") {
    console.log("  No unattended review started in this window, so nothing here proves the loop is closed.");
    console.log("  Turn the Supervisor on, or widen the window with --days N, before reading this as healthy.");
  } else {
    console.log(
      `  ${history.launches} unattended review(s) started across ${history.revisions} work revision(s); ` +
        `${history.postFixRepeats.length} repeat claim(s) on unchanged work since the fence shipped (${shipped}).`,
    );
    console.log(
      `  Task-level budget audit: ${history.taskBudgetMeasuredClaims} launch(es) carried attempt counters; ` +
        `${history.taskBudgetUnmeasuredClaims} older launch(es) predate that audit marker.`,
    );
    console.log(`  Last unattended review started ${stamp(history.lastLaunchAt)}.`);
    printPerTaskLoad();
  }
  console.log(
    `  Fence fired ${history.fencedFree}x before any paid check-in and ${history.fencedPaid}x after one` +
      `${history.lastFencedAt ? ` (last ${stamp(history.lastFencedAt)})` : ""}; ` +
      `${history.otherSkips} other skip(s) - state and race guards, not the fence.`,
  );

  for (const repeat of history.postFixRepeats) {
    console.log(
      `  LOOP: ${repeat.threadId.slice(0, 8)} - ${short(repeat.title, 70)}\n` +
        `    re-reviewed ${stamp(repeat.at)} with no task work since the previous unattended review ` +
        `(${stamp(repeat.previousAt)}); revision ${repeat.revision}`,
    );
  }
  for (const leak of history.budgetLeaks) {
    console.log(
      `  LOOP: ${leak.threadId.slice(0, 8)} - ${short(leak.title, 70)}\n` +
        `    unattended attempt ${leak.attempt} exceeded its persisted task budget of ${leak.budget} ` +
        `at ${stamp(leak.at)}; revision ${leak.revision}`,
    );
  }
  if (history.preFixRepeats.length) {
    console.log(
      `  ${history.preFixRepeats.length} pre-fix repeat(s) remain in history (newest ${stamp(history.preFixRepeats[0].at)}) - ` +
        `closed by ${CONVERGENCE_FIX_COMMIT}, so they are reported but never counted against this window.`,
    );
  }
}

function publicEntry(reading) {
  const { row } = reading;
  return {
    threadId: row.threadId,
    title: row.title,
    threadState: row.threadState,
    disposition: reading.disposition,
    attention: reading.attention,
    issues: reading.issues,
    notes: reading.notes,
    currentRevision: row.currentRevision,
    episode: row.hasEpisode
      ? {
          revision: row.episodeRevision,
          revisionCurrent: reading.revisionCurrent,
          status: row.status,
          source: row.source,
          attemptCount: row.attemptCount,
          unattendedStreak: row.unattendedStreak,
          claimed: row.status === "running" && !!row.claimToken,
          reason: row.reason,
          verdictAccept: reading.verdict?.accept ?? null,
          verdictRunId: row.verdictRunId,
          startedAt: row.startedAt,
          settledAt: row.settledAt,
          updatedAt: row.episodeUpdatedAt,
        }
      : null,
    reviewerRuns: row.reviewerRuns,
    reviewerRunsAfterSettle: row.reviewerRunsAfterSettle,
  };
}

const looping = history?.violations.length ?? 0;

const payload = {
  verdict: attention.length || looping ? "ATTENTION" : "PASS",
  dbPath,
  checked: readings.length,
  attention: attention.length,
  counts,
  convergence: history
    ? {
        ...history,
        fixCommit: CONVERGENCE_FIX_COMMIT,
        fixShippedAt: fixShipDate ? fixShipDate.toISOString() : null,
      }
    : null,
  entries: readings.map(publicEntry),
};

if (json) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log(
    `${payload.verdict} - checked ${payload.checked} auto-review task(s); ` +
      `${payload.attention} invariant violation(s); ${convergenceHeadline()}.`,
  );
  const countLine = Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, count]) => `${name}=${count}`)
    .join("; ");
  if (countLine) console.log(`  ${countLine}`);
  if (!readings.length) console.log("  No durable auto-review history or uncovered legacy review task was found.");

  printConvergence();

  for (const reading of readings) {
    const { row } = reading;
    console.log(`\n[${reading.disposition.toUpperCase()}] ${row.threadId.slice(0, 8)} - ${short(row.title, 90)}`);
    if (row.hasEpisode) {
      console.log(
        `  task=${row.threadState}; episode=${row.status}/${row.source}; attempts=${row.attemptCount}; ` +
          `unattended=${row.unattendedStreak ?? "unmeasured"}/${history?.unattendedBudget ?? "?"}; ` +
          `revision=${reading.revisionCurrent ? "current" : "newer work recorded"}; reviewer runs=${row.reviewerRuns}`,
      );
      if (row.reason) console.log(`  reason: ${short(row.reason)}`);
    } else {
      console.log(`  task=${row.threadState}; episode=missing; reviewer runs=${row.reviewerRuns}`);
    }
    for (const note of reading.notes) console.log(`  note: ${note}`);
    for (const issue of reading.issues) console.log(`  ISSUE: ${issue}`);
  }
}

if (attention.length || looping) process.exitCode = 1;
