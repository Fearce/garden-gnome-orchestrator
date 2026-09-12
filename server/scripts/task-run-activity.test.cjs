// Gate for the hollow-run diagnostic shown by `probe:task-runs`. A resumed SDK query may replay the
// cut-off query's pending tool_use while itself running 0 model turns at $0. The operator probe must
// identify that contradiction instead of treating the persisted tool message as proof of new work.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const Database = require("better-sqlite3");
const { hollowRunReading } = require("./task-run-activity.cjs");

const ended = { state: "done", ended_at: 2 };
assert.equal(hollowRunReading(ended, 0)?.kind, "empty", "no output remains the ordinary hollow-run shape");
assert.equal(
  hollowRunReading({ ...ended, num_turns: 0, cost_usd: 0 }, 1)?.kind,
  "zero-turn-with-output",
  "explicit zero telemetry outranks a replayed message",
);
assert.equal(
  hollowRunReading({ ...ended, num_turns: 0, cost_usd: null }, 1),
  null,
  "missing provider telemetry is unknown, not proof that the model never ran",
);
assert.equal(
  hollowRunReading({ ...ended, num_turns: 1, cost_usd: 0 }, 1),
  null,
  "one measured model turn is real work even when it was free",
);
assert.equal(hollowRunReading({ ...ended, state: "error" }, 0), null, "an error row is already diagnosed as an error");
assert.equal(hollowRunReading({ state: "running", ended_at: null }, 0), null, "an active run is not judged prematurely");

// Exercise the CLI operators actually use. A helper-only gate could stay green if probe:task-runs stopped
// calling it, so replay the production task shape through a minimal read-only SQLite fixture.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gg-task-run-activity-"));
const dbPath = path.join(tmp, "orchestrator.sqlite");
const crashPath = path.join(tmp, "no-crash-log.txt");
let db;
try {
  db = new Database(dbPath);
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY, title TEXT, state TEXT, lane TEXT, created_at INTEGER, updated_at INTEGER,
      assignment TEXT, effort_override TEXT, brief TEXT, error TEXT, raw_prompt TEXT,
      stage_outputs TEXT, active_deadline_at INTEGER, model_request TEXT
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

  const now = Date.now();
  const threadId = "replay-only-probe-fixture";
  db.prepare(
    `INSERT INTO threads (id, title, state, created_at, updated_at, brief, stage_outputs)
     VALUES (?, ?, 'review', ?, ?, ?, '{}')`,
  ).run(threadId, "Verifier continuation parked", now - 10_000, now, "Diagnose the QA continuation.");

  const insertRun = db.prepare(
    `INSERT INTO agent_runs
      (id, thread_id, role, model, account, state, cost_usd, num_turns, started_at, ended_at, error, cap_flagged)
     VALUES (?, ?, 'qa', 'claude-opus-5', 'personal', ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertRun.run("cutoff-run", threadId, "error", 11.25, 101, now - 9_000, now - 6_000, "error_max_turns", 0);
  insertRun.run("replay-run", threadId, "done", 0, 0, now - 5_000, now - 3_000, null, 0);
  insertRun.run("real-run", threadId, "done", 0, 1, now - 2_000, now - 1_000, null, 0);

  const insertMessage = db.prepare(
    `INSERT INTO messages (id, thread_id, run_id, role, kind, content, created_at)
     VALUES (?, ?, ?, 'qa', ?, ?, ?)`,
  );
  insertMessage.run("replayed-tool", threadId, "replay-run", "tool", "Bash { pending tool_use }", now - 4_000);
  insertMessage.run("real-output", threadId, "real-run", "message", "QA verdict", now - 1_500);
  db.close();
  db = null;

  const probe = spawnSync(process.execPath, [path.join(__dirname, "probe-task-runs.cjs"), threadId], {
    cwd: path.resolve(__dirname, ".."),
    env: {
      ...process.env,
      ORCH_DB: dbPath,
      ORCH_CRASH_LOG: crashPath,
      ORCH_TIME_ZONE: "Europe/Copenhagen",
    },
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(probe.status, 0, `probe failed:\n${probe.stderr || probe.stdout}`);
  assert.match(probe.stdout, /=== hollow runs \(1\) ===/, "the replay-only query reaches the operator-facing section");
  assert.match(probe.stdout, /zero-turn-with-output/, "the probe names the contradictory production shape");
  assert.match(probe.stdout, /1 non-system message, but 0 turns \/ \$0/, "the run trail preserves the deciding evidence");
  assert.equal(
    (probe.stdout.match(/⚠ HOLLOW/g) ?? []).length,
    1,
    "the genuine one-turn completion is not misclassified as hollow",
  );
} finally {
  if (db?.open) db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("taskRunActivity: all assertions passed");
