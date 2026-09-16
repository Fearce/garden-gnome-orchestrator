// Gate for probe-hot-paths.cjs — proves the query-plan and payload-size checks actually DETECT the
// regressions the 2026-09-04 perf pass (14daac9, 04154de, 7a0cbca) fixed, not just that they stay quiet
// on a database that already has the fix. Every assertion below builds a database that HAS the defect
// first and requires the checker to see it — same discipline as db-size.test.cjs.
//
// Free (no agents, no network, no quota): a throwaway SQLite file in a temp dir.
//
// Run: node scripts/hot-paths.test.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");

const {
  explain,
  planVerdict,
  hotQueryPlans,
  boardSnapshotPlan,
  BOARD_SNAPSHOT_SQL,
  busiestThread,
  helloSnapshotFootprint,
  verdictFor,
  retiredIndexesPresent,
  RETIRED_INDEXES,
  BRIEF_PREVIEW_CHARS,
} = require("./probe-hot-paths.cjs");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gg-hotpaths-"));
const dbPath = path.join(dir, "t.sqlite");
const db = new Database(dbPath);

db.exec(`
  CREATE TABLE threads (id TEXT PRIMARY KEY, brief TEXT NOT NULL DEFAULT '', raw_prompt TEXT NOT NULL DEFAULT '', created_at INTEGER);
  CREATE TABLE messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE findings (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, summary TEXT NOT NULL, created_at INTEGER NOT NULL);
`);

const insertMsg = db.prepare("INSERT INTO messages(id, thread_id, content, created_at) VALUES (?,?,?,?)");
const insertFinding = db.prepare("INSERT INTO findings(id, thread_id, summary, created_at) VALUES (?,?,?,?)");
for (let i = 0; i < 500; i++) insertMsg.run(`m-${i}`, "t1", "x".repeat(200), 1000 + i);
for (let i = 0; i < 20; i++) insertFinding.run(`f-${i}`, "t1", "s", 1000 + i);

// ---- the regression: without the composite indexes, at least one hot path scans or sorts by hand -----
let plans = hotQueryPlans(db, "t1");
let bad = plans.filter((p) => !p.ok);
assert.ok(bad.length > 0, "an unindexed database must fail at least one hot-path check — otherwise the checker can't see the defect it exists for");
assert.ok(
  bad.some((p) => p.problems.some((x) => /TEMP B-TREE|full scan/.test(x))),
  `expected a sort-by-hand or scan problem, got ${JSON.stringify(bad)}`,
);

// ---- the fix: the real composite indexes make every hot path seek instead ----------------------------
db.exec(`
  CREATE INDEX idx_messages_thread_time ON messages(thread_id, created_at);
  CREATE INDEX idx_findings_thread_time ON findings(thread_id, created_at);
`);
plans = hotQueryPlans(db, "t1");
bad = plans.filter((p) => !p.ok);
assert.deepEqual(bad, [], `every hot path should be healthy once the composite indexes exist, got ${JSON.stringify(bad)}`);

// ---- planVerdict itself: SEARCH is healthy, a bare SCAN is not, an index-order SCAN is not a filter
//      failure (it's still cheap — this checks for a seek being POSSIBLE, not literal query strategy) --
assert.equal(planVerdict("x", "SEARCH messages USING INDEX idx_messages_thread_time (thread_id=?)", { table: "messages" }).ok, true);
assert.equal(planVerdict("x", "SCAN messages", { table: "messages" }).ok, false, "a bare table scan must be flagged");
assert.equal(
  planVerdict("x", "SCAN messages USING INDEX idx_messages_thread_time", { table: "messages" }).ok,
  true,
  "a scan restricted to an index is not the failure being checked for",
);
assert.equal(planVerdict("x", "SEARCH messages USING TEMP B-TREE", { table: "messages" }).ok, false, "a hand sort must be flagged even if it also names an index");

// ---- the retired-index regression: a rebuilt superseded index must be caught by name ------------------
const retiredName = RETIRED_INDEXES[0];
assert.deepEqual(retiredIndexesPresent(db), [], "none of the retired indexes exist yet");
db.exec(`CREATE INDEX ${retiredName} ON messages(thread_id, created_at, id)`);
assert.deepEqual(retiredIndexesPresent(db), [retiredName], "a rebuilt superseded index must be detected by exact name");
db.exec(`DROP INDEX ${retiredName}`);

// ---- verdictFor aggregates both signals; a retired index fails it even with otherwise-healthy plans ---
assert.equal(verdictFor(plans, []).ok, true, "healthy plans + no retired indexes => ok");
assert.equal(verdictFor(plans, [retiredName]).ok, false, "a retired index reappearing must fail the verdict even with healthy plans");

// ---- busiestThread ranks by ROW COUNT, not recency or insertion order ---------------------------------
insertMsg.run("solo", "t2", "y", 999999);
assert.equal(busiestThread(db).thread_id, "t1", "t1 (500 rows) must outrank a newer task with 1 row");

// ---- hello-snapshot math: the clipped preview must be smaller, by exactly the clipped amount ----------
db.prepare("INSERT INTO threads(id, brief, raw_prompt, created_at) VALUES (?,?,?,?)").run("th1", "b".repeat(5000), "p".repeat(3000), 1);
db.prepare("INSERT INTO threads(id, brief, raw_prompt, created_at) VALUES (?,?,?,?)").run("th2", "short brief", "short prompt", 2);
const footprint = helloSnapshotFootprint(db);
assert.equal(footprint.threadCount, 2);
assert.equal(footprint.fullBytes, 5000 + 3000 + "short brief".length + "short prompt".length, "full = every task's brief + raw_prompt bytes");
assert.equal(
  footprint.slimBytes,
  BRIEF_PREVIEW_CHARS + "short brief".length,
  "slim = the clipped brief only — th1's brief is longer than the clip, th2's is shorter",
);
assert.ok(footprint.savedBytes > 0 && footprint.savedPct > 0, "the slim snapshot must measurably shrink the payload");

// ---- the board snapshot must not read `messages` once per task ---------------------------------------
//
// The defect this catches shipped as a plain, indexed, fast-looking subquery: it SEEKS its index and
// sorts nothing, so every existing check above stayed green on it. What made it the worst query in the
// process was that the snapshot runs it for every task on the board — 2,773 random reads per client
// connect on the live database. So the assertion is about the table it touches, not the plan's shape.
assert.equal(
  planVerdict("x", "SCAN threads | CORRELATED SCALAR SUBQUERY 1 | SEARCH messages USING INDEX idx_messages_thread_time (thread_id=?)", {
    forbidTable: "messages",
  }).ok,
  false,
  "a per-task seek into messages must be flagged even though it is indexed and unsorted",
);
assert.equal(planVerdict("x", "SCAN threads USING INDEX idx_threads_created", { forbidTable: "messages" }).ok, true);

// …and against a real database, on the two shapes themselves. The fixture needs the snapshot's columns.
db.exec(`
  ALTER TABLE threads ADD COLUMN title TEXT;
  ALTER TABLE threads ADD COLUMN state TEXT;
  ALTER TABLE threads ADD COLUMN workspace TEXT;
  ALTER TABLE threads ADD COLUMN error TEXT;
  ALTER TABLE threads ADD COLUMN effort_override TEXT;
  ALTER TABLE threads ADD COLUMN latest_message_preview TEXT;
  ALTER TABLE threads ADD COLUMN model_request TEXT;
  ALTER TABLE threads ADD COLUMN closed_at INTEGER;
  ALTER TABLE threads ADD COLUMN closed_prev_state TEXT;
  ALTER TABLE threads ADD COLUMN lane TEXT;
  ALTER TABLE threads ADD COLUMN baseline_head TEXT;
  ALTER TABLE threads ADD COLUMN duration_ms INTEGER;
  ALTER TABLE threads ADD COLUMN deadline_at INTEGER;
  ALTER TABLE threads ADD COLUMN active_deadline_at INTEGER;
  ALTER TABLE threads ADD COLUMN agent_count INTEGER;
  ALTER TABLE threads ADD COLUMN parent_id TEXT;
  ALTER TABLE threads ADD COLUMN assignment TEXT;
  ALTER TABLE threads ADD COLUMN stage_outputs TEXT;
  ALTER TABLE threads ADD COLUMN updated_at INTEGER;
  ALTER TABLE messages ADD COLUMN kind TEXT;
  CREATE INDEX idx_threads_created ON threads(created_at);
`);
const defectiveSnapshot = BOARD_SNAPSHOT_SQL.replace(
  "latest_message_preview,",
  `(SELECT substr(content, 1, ${BRIEF_PREVIEW_CHARS}) FROM messages
     WHERE thread_id = threads.id AND kind IN ('text', 'system')
     ORDER BY created_at DESC, rowid DESC LIMIT 1) AS latest_message_preview,`,
);
assert.notEqual(defectiveSnapshot, BOARD_SNAPSHOT_SQL, "the probe's snapshot SQL must still read the stored column to be reverted");
assert.equal(
  planVerdict("defective snapshot", explain(db, defectiveSnapshot), { forbidTable: "messages" }).ok,
  false,
  "the pre-2026-09-16 snapshot, which derived the preview per task, must fail the check",
);
assert.equal(boardSnapshotPlan(db).ok, true, `the stored-column snapshot must pass, got ${JSON.stringify(boardSnapshotPlan(db).problems)}`);

db.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log("PASS — hot-paths probe analysis");
