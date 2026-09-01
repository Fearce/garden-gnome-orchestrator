#!/usr/bin/env node

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { autoReviewReading, autoReviewTableExists, selectAutoReviewRows } = require("./auto-review-health.cjs");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ggo-auto-review-health-"));
const dbPath = path.join(temp, "health.sqlite");
const probe = path.resolve(__dirname, "probe-auto-review.cjs");
let db;

function runProbe(file, ...args) {
  return spawnSync(process.execPath, [probe, ...args], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, ORCH_DB: file },
    encoding: "utf8",
  });
}

function insertThread(id, state, error = null) {
  db.prepare("INSERT INTO threads(id,title,state,error,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(
    id,
    `Task ${id}`,
    state,
    error,
    10,
    500,
  );
}

function insertRun(threadId, id, role, startedAt) {
  db.prepare("INSERT INTO agent_runs(id,thread_id,role,state,started_at,ended_at) VALUES(?,?,?,?,?,?)").run(
    id,
    threadId,
    role,
    "done",
    startedAt,
    startedAt + 10,
  );
}

function insertEpisode(threadId, value) {
  db.prepare(`
    INSERT INTO auto_review_episodes
      (thread_id,revision,status,source,claim_token,attempt_count,reason,verdict_json,
       verdict_run_id,started_at,settled_at,updated_at)
    VALUES
      (@threadId,@revision,@status,@source,@claimToken,@attemptCount,@reason,@verdictJson,
       @verdictRunId,@startedAt,@settledAt,@updatedAt)
  `).run({
    threadId,
    revision: `run:${threadId}-work`,
    status: "parked",
    source: "supervisor",
    claimToken: null,
    attemptCount: 1,
    reason: "Reviewer did not accept the work.",
    verdictJson: JSON.stringify({ accept: false, summary: "Rejected", issues: ["Fix it"] }),
    verdictRunId: `${threadId}-review`,
    startedAt: 120,
    settledAt: 200,
    updatedAt: 200,
    ...value,
  });
}

function seedReviewed(id, state, error, episode) {
  insertThread(id, state, error);
  insertRun(id, `${id}-work`, "implementor", 100);
  insertRun(id, `${id}-review`, "reviewer", 150);
  insertEpisode(id, episode);
}

try {
  db = new Database(dbPath);
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      state TEXT NOT NULL,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE agent_runs (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      role TEXT NOT NULL,
      state TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER
    );
    CREATE TABLE auto_review_episodes (
      thread_id TEXT PRIMARY KEY,
      revision TEXT NOT NULL,
      status TEXT NOT NULL,
      source TEXT NOT NULL,
      claim_token TEXT,
      attempt_count INTEGER NOT NULL,
      reason TEXT,
      verdict_json TEXT,
      verdict_run_id TEXT,
      started_at INTEGER NOT NULL,
      settled_at INTEGER,
      updated_at INTEGER NOT NULL
    );
  `);

  seedReviewed("accepted", "done", null, {
    status: "accepted",
    reason: "All checks passed.",
    verdictJson: JSON.stringify({ accept: true, summary: "Verified", issues: [] }),
  });
  seedReviewed("parked", "review", "Kevin must choose the deployment target.", {
    reason: "Kevin must choose the deployment target.",
    verdictJson: JSON.stringify({ accept: false, summary: "Needs input", issues: ["Kevin must choose"] }),
  });
  seedReviewed("restart", "review", "Auto-review was interrupted by a server restart.", {
    source: "reconciled",
    attemptCount: 4,
    reason: "Auto-review was interrupted by a server restart.",
    verdictJson: null,
  });
  seedReviewed("active", "reviewing", null, {
    status: "running",
    source: "owner",
    claimToken: "do-not-print-this-claim-token",
    reason: null,
    verdictJson: null,
    verdictRunId: null,
    settledAt: null,
  });

  seedReviewed("newwork", "review", "New work is ready for review.", {
    reason: "Earlier revision was rejected.",
  });
  insertRun("newwork", "newwork-work-2", "implementor", 300);

  seedReviewed("duplicate", "review", "Reviewer did not accept the work.", { attemptCount: 2 });
  seedReviewed("badaccept", "done", null, { status: "accepted", reason: "Claimed success.", verdictJson: null });
  seedReviewed("late", "review", "Reviewer did not accept the work.", {});
  insertRun("late", "late-review-after-settle", "reviewer", 300);
  seedReviewed("hidden", "review", null, { reason: "Persisted but not visible." });

  insertThread("unowned", "review", "Old reviewer hand-back.");
  insertRun("unowned", "unowned-work", "implementor", 100);
  insertRun("unowned", "unowned-review", "reviewer", 150);

  assert.equal(autoReviewTableExists(db), true);
  const readings = new Map(selectAutoReviewRows(db).map((row) => [row.threadId, autoReviewReading(row)]));
  assert.equal(readings.get("accepted").disposition, "accepted", "a valid accepted verdict converges to done");
  assert.equal(readings.get("parked").disposition, "parked", "a needs-input verdict is visibly parked");
  assert.equal(readings.get("restart").disposition, "parked", "restart reconciliation is a terminal park");
  assert.equal(readings.get("restart").attention, false, "historical retry count is not fresh loop activity");
  assert.match(readings.get("restart").notes.join(" "), /historical reviewer attempts were imported and fenced/);
  assert.equal(readings.get("active").disposition, "active", "a well-formed claim is active, not an alarm");
  assert.equal(readings.get("newwork").disposition, "eligible", "new non-reviewer work opens a new revision");
  assert.match(readings.get("duplicate").issues.join(" "), /Supervisor claimed the same revision 2 times/);
  assert.match(readings.get("badaccept").issues.join(" "), /no valid accept=true verdict/);
  assert.match(readings.get("late").issues.join(" "), /started after this episode settled/);
  assert.match(readings.get("hidden").issues.join(" "), /not visible on the review task/);
  assert.match(readings.get("unowned").issues.join(" "), /no durable episode fences another unattended launch/);
  assert.equal(
    autoReviewReading(selectAutoReviewRows(db, "accepted")[0]).disposition,
    "accepted",
    "the single-task query uses the same classifier",
  );

  db.close();
  db = null;

  const bad = runProbe(dbPath);
  assert.equal(bad.status, 1, `actionable inconsistencies must exit 1:\n${bad.stdout}\n${bad.stderr}`);
  assert.match(bad.stdout, /^ATTENTION -/);
  assert.match(bad.stdout, /\[ATTENTION\] duplicat/);
  assert.doesNotMatch(bad.stdout, /do-not-print-this-claim-token/, "the ownership token must never be printed");

  const jsonRun = runProbe(dbPath, "--json");
  assert.equal(jsonRun.status, 1);
  const payload = JSON.parse(jsonRun.stdout);
  assert.equal(payload.verdict, "ATTENTION");
  assert.ok(payload.attention >= 5);
  assert.equal(payload.entries.find((entry) => entry.threadId === "active").episode.claimed, true);
  assert.doesNotMatch(jsonRun.stdout, /do-not-print-this-claim-token/);

  db = new Database(dbPath);
  db.prepare("DELETE FROM threads WHERE id IN ('duplicate','badaccept','late','hidden','unowned')").run();
  db.prepare("DELETE FROM agent_runs WHERE thread_id IN ('duplicate','badaccept','late','hidden','unowned')").run();
  db.prepare("DELETE FROM auto_review_episodes WHERE thread_id IN ('duplicate','badaccept','late','hidden','unowned')").run();
  db.close();
  db = null;

  const before = fs.readFileSync(dbPath);
  const good = runProbe(dbPath);
  const goodJson = runProbe(dbPath, "--json");
  const after = fs.readFileSync(dbPath);
  assert.equal(good.status, 0, `repaired, active, accepted, parked, and newer-work rows are healthy:\n${good.stdout}\n${good.stderr}`);
  assert.match(good.stdout, /^PASS -/);
  assert.equal(goodJson.status, 0);
  assert.ok(before.equals(after), "the health probe must leave the SQLite file byte-identical");

  const oldPath = path.join(temp, "old.sqlite");
  const old = new Database(oldPath);
  old.exec("CREATE TABLE threads(id TEXT PRIMARY KEY)");
  old.close();
  const oldRun = runProbe(oldPath);
  assert.equal(oldRun.status, 2);
  assert.match(oldRun.stderr, /auto_review_episodes is absent/);

  const usage = runProbe(dbPath, "--unknown");
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /usage:/);
} finally {
  if (db?.open) db.close();
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log("PASS - durable auto-review health probe covers convergence, recovery, and loop invariants");
