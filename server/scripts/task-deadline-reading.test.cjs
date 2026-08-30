// Gate for the hard-deadline status shown by `probe:task-runs`. These cases pin the distinctions an
// operator needs after an expiry: changing/clearing the timestamp does not itself unpark the task,
// while an overdue row without the durable park marker is an enforcement fault rather than "expired".

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const Database = require("better-sqlite3");
const {
  ACTIVE_DEADLINE_PARK_PREFIX,
  activeDeadlineReading,
} = require("./task-deadline-reading.cjs");

const NOW = Date.parse("2026-08-30T20:56:00.000Z");
const DEADLINE = NOW + 3 * 60 * 60_000;
const opts = { now: NOW, timeZone: "Europe/Copenhagen" };
const read = (overrides = {}) =>
  activeDeadlineReading({ state: "implementing", error: null, ...overrides }, opts);

assert.deepEqual(
  read(),
  { at: null, status: "not appointed", blocked: false },
  "absence is explicit instead of forcing an operator to infer it from a missing field",
);

const armed = read({ active_deadline_at: DEADLINE });
assert.equal(armed.at, "2026-08-31 01:56:00.000 Europe/Copenhagen (2026-08-30 23:56:00.000Z)");
assert.equal(armed.relative, "3h remaining");
assert.match(armed.status, /^armed — server will stop live work/);
assert.equal(armed.blocked, false, "ordinary automatic lifecycle paths remain available before expiry");

const expiredPark = read({
  state: "review",
  activeDeadlineAt: NOW - 65_000,
  error: `${ACTIVE_DEADLINE_PARK_PREFIX} at the appointed time.\n\nThe task was previously reporting: needs your review.`,
});
assert.equal(expiredPark.relative, "expired 1m 5s ago");
assert.match(expiredPark.status, /^expired \+ parked/);
assert.equal(expiredPark.blocked, true);

const clearedPark = read({ error: `${ACTIVE_DEADLINE_PARK_PREFIX} at the appointed time.` });
assert.equal(clearedPark.at, null);
assert.match(clearedPark.status, /^cleared; task remains deadline-parked/);
assert.equal(clearedPark.blocked, true, "clearing the clock alone must not imply the task resumed");

const extendedPark = read({
  active_deadline_at: DEADLINE,
  error: `${ACTIVE_DEADLINE_PARK_PREFIX} at the earlier appointed time.`,
});
assert.match(extendedPark.status, /^extended; task remains deadline-parked/);
assert.equal(extendedPark.blocked, true, "extending the clock alone must not imply the task resumed");

const overdue = read({ active_deadline_at: NOW - 1 });
assert.match(overdue.status, /^OVERDUE without a persisted deadline park/);
assert.equal(overdue.blocked, true, "due timestamps block autonomous recovery even before the park is observed");

const terminal = read({ state: "done", active_deadline_at: NOW - 60_000 });
assert.equal(terminal.status, "inactive — task is terminal");
assert.equal(terminal.blocked, false);

// Exercise the actual CLI entry point over a minimal read-only SQLite fixture. A pure helper test can
// stay green if the probe forgets to call it; this proves the deadline reaches the surface operators use.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gg-task-deadline-probe-"));
const dbPath = path.join(tmp, "orchestrator.sqlite");
const crashPath = path.join(tmp, "no-crash-log.txt");
let db;
try {
  db = new Database(dbPath);
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY, title TEXT, state TEXT, lane TEXT, created_at INTEGER, updated_at INTEGER,
      assignment TEXT, effort_override TEXT, brief TEXT, error TEXT, raw_prompt TEXT,
      stage_outputs TEXT, active_deadline_at INTEGER
    );
    CREATE TABLE agent_runs (
      id TEXT PRIMARY KEY, thread_id TEXT, role TEXT, model TEXT, account TEXT, effort TEXT,
      state TEXT, cost_usd REAL, num_turns INTEGER, started_at INTEGER, ended_at INTEGER,
      error TEXT, cap_flagged INTEGER, session_id TEXT
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, thread_id TEXT, run_id TEXT, role TEXT, kind TEXT, content TEXT, created_at INTEGER
    );
    CREATE TABLE findings (
      id TEXT PRIMARY KEY, thread_id TEXT, from_role TEXT, summary TEXT, detail TEXT,
      severity TEXT, kind TEXT, created_at INTEGER
    );
    CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT);
  `);
  const liveDeadline = Date.now() + 3 * 60 * 60_000;
  db.prepare(
    `INSERT INTO threads
      (id, title, state, created_at, updated_at, brief, stage_outputs, active_deadline_at)
     VALUES (?, ?, 'implementing', ?, ?, ?, '{}', ?)`,
  ).run("deadline-probe-fixture", "Long-lived task", Date.now(), Date.now(), "Keep working safely.", liveDeadline);
  db.close();
  db = null;

  const probe = spawnSync(process.execPath, [path.join(__dirname, "probe-task-runs.cjs"), "deadline-probe-fixture"], {
    cwd: path.resolve(__dirname, ".."),
    env: {
      ...process.env,
      ORCH_DB: dbPath,
      ORCH_CRASH_LOG: crashPath,
      ORCH_TIME_ZONE: "Europe/Copenhagen",
    },
    encoding: "utf8",
  });
  assert.equal(probe.status, 0, `probe failed:\n${probe.stderr || probe.stdout}`);
  assert.match(probe.stdout, /activeTaskDeadline:/, "the standard task probe names the persisted control");
  assert.match(probe.stdout, /status: 'armed — server will stop live work and block automatic dispatch\/resume at expiry'/);
  assert.match(probe.stdout, /blocked: false/);
} finally {
  if (db?.open) db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("taskDeadlineReading: all assertions passed");
