#!/usr/bin/env node
// Read-only board-wide audit of durable auto-review ownership and convergence.
// Exit 0 = no invariant violations, 1 = actionable inconsistency, 2 = usage/schema error.

const path = require("node:path");
const Database = require("better-sqlite3");
const { autoReviewReading, autoReviewTableExists, selectAutoReviewRows } = require("./auto-review-health.cjs");

const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--json")) {
  console.error("usage: node scripts/probe-auto-review.cjs [--json]");
  process.exit(2);
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
db.close();

const counts = {};
for (const reading of readings) counts[reading.disposition] = (counts[reading.disposition] ?? 0) + 1;
const attention = readings.filter((reading) => reading.attention);

function short(value, max = 220) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
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

const payload = {
  verdict: attention.length ? "ATTENTION" : "PASS",
  dbPath,
  checked: readings.length,
  attention: attention.length,
  counts,
  entries: readings.map(publicEntry),
};

if (json) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log(
    `${payload.verdict} - checked ${payload.checked} auto-review task(s); ` +
      `${payload.attention} invariant violation(s).`,
  );
  const countLine = Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, count]) => `${name}=${count}`)
    .join("; ");
  if (countLine) console.log(`  ${countLine}`);
  if (!readings.length) console.log("  No durable auto-review history or uncovered legacy review task was found.");

  for (const reading of readings) {
    const { row } = reading;
    console.log(`\n[${reading.disposition.toUpperCase()}] ${row.threadId.slice(0, 8)} - ${short(row.title, 90)}`);
    if (row.hasEpisode) {
      console.log(
        `  task=${row.threadState}; episode=${row.status}/${row.source}; attempts=${row.attemptCount}; ` +
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

if (attention.length) process.exitCode = 1;
