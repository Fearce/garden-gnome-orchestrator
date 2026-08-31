#!/usr/bin/env node
// Gate for probe:supervisor-chat. It drives the real CLI against an on-disk SQLite fixture so argv,
// literal search semantics, current-task joins, status/action readings, exit codes, and read-only access
// are all exercised the way an operator uses them.

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");

const PROBE = path.join(__dirname, "probe-supervisor-chat.cjs");
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), "gg-supervisor-chat-probe-"));
const DB_PATH = path.join(TEMP, "orchestrator.sqlite");
const NOW = Date.now();
const TASK_ID = "1d444976-3217-44bb-9d8d-f9bba1159ce5";
const OTHER_TASK_ID = "8c3df3cc-63b9-4314-a6d7-2cc24f53a1b0";
const BOARD_TASK_ID = "9f07c915-5567-41e3-8859-ec663d1da9c7";
const BOARD_MESSAGE = "The tasks we have running have been churning for way too long, can u tell them to finish up";
const BOARD_INSTRUCTION = "Finish the current approved scope promptly and do not expand it. Keep every required test, verification, QA/review, deployment, commit/push, and acceptance gate.";

let passed = 0;
function check(label, condition, detail = "") {
  assert.ok(condition, `${label}${detail ? ` -- ${detail}` : ""}`);
  passed++;
  console.log(`  [OK] ${label}`);
}

function run(dbPath, ...args) {
  return spawnSync(process.execPath, [PROBE, ...args], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, ORCH_DB: dbPath, ORCH_TIME_ZONE: "Europe/Copenhagen" },
    encoding: "utf8",
    windowsHide: true,
  });
}

function json(dbPath, ...args) {
  const result = run(dbPath, ...args, "--json");
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function addTurn(insert, value) {
  insert.run({
    response: null,
    targets: "[]",
    actions: "[]",
    usedAgent: 0,
    costUsd: null,
    tokens: null,
    model: null,
    provider: null,
    ...value,
  });
}

let db;
try {
  db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE supervisor_chat_turns (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      targets TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL,
      response TEXT,
      action_results TEXT NOT NULL DEFAULT '[]',
      used_agent INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL,
      total_tokens INTEGER,
      model TEXT,
      provider TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      title TEXT,
      state TEXT,
      error TEXT,
      updated_at INTEGER
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      role TEXT NOT NULL,
      kind TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  db.prepare("INSERT INTO threads(id, title, state, error, updated_at) VALUES(?, ?, ?, ?, ?)").run(
    TASK_ID,
    "Concise communication complete",
    "done",
    null,
    NOW,
  );
  db.prepare("INSERT INTO threads(id, title, state, error, updated_at) VALUES(?, ?, ?, ?, ?)").run(
    OTHER_TASK_ID,
    "Review the deployment",
    "review",
    "Needs owner review.",
    NOW,
  );
  db.prepare("INSERT INTO threads(id, title, state, error, updated_at) VALUES(?, ?, ?, ?, ?)").run(
    BOARD_TASK_ID,
    "Audit Halifax menu crawl quality",
    "implementing",
    null,
    NOW,
  );

  const insert = db.prepare(`
    INSERT INTO supervisor_chat_turns
      (id, content, targets, status, response, action_results, used_agent, cost_usd,
       total_tokens, model, provider, created_at, updated_at)
    VALUES
      (@id, @content, @targets, @status, @response, @actions, @usedAgent, @costUsd,
       @tokens, @model, @provider, @createdAt, @updatedAt)
  `);

  addTurn(insert, {
    id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    content: BOARD_MESSAGE,
    status: "succeeded",
    response: "I will send a bounded append-only direction to each reachable active task. Scope resolved to 1 reachable active task.",
    actions: JSON.stringify([
      {
        threadId: BOARD_TASK_ID,
        threadTitle: "Audit Halifax menu crawl quality",
        action: "steer",
        ok: true,
        message: "Sent the instruction through the task's append injection path.",
        state: "implementing",
      },
    ]),
    createdAt: NOW - 12_000,
    updatedAt: NOW - 11_800,
  });
  const insertMessage = db.prepare("INSERT INTO messages(id, thread_id, role, kind, content, created_at) VALUES(?, ?, ?, ?, ?, ?)");
  insertMessage.run(
    "11111111-1111-4111-8111-111111111111",
    BOARD_TASK_ID,
    "director",
    "system",
    `↪ injected: Supervisor instruction from the owner: ${BOARD_INSTRUCTION}`,
    NOW - 11_900,
  );
  insertMessage.run(
    "22222222-2222-4222-8222-222222222222",
    BOARD_TASK_ID,
    "implementor",
    "text",
    "ACK: I’ll finish only the approved scope and retain every quality gate.",
    NOW - 10_500,
  );
  addTurn(insert, {
    id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    content: "Finish the active task but simulate a missing feed echo.",
    status: "succeeded",
    actions: JSON.stringify([
      {
        threadId: BOARD_TASK_ID,
        threadTitle: "Audit Halifax menu crawl quality",
        action: "steer",
        ok: true,
        message: "Sent the instruction through the task's append injection path.",
        state: "implementing",
      },
    ]),
    createdAt: NOW - 10_000,
    updatedAt: NOW - 9_000,
  });

  addTurn(insert, {
    id: "9e385dfd-2cfb-4455-895a-862672750a04",
    content: "Please ensure it is finished.",
    targets: JSON.stringify([{ threadId: TASK_ID, title: "Concise agent communication setting", state: "failed" }]),
    status: "succeeded",
    response: "The selected task was failed, so I resumed its existing work.",
    actions: JSON.stringify([
      {
        threadId: TASK_ID,
        threadTitle: "Concise agent communication setting",
        action: "resume",
        ok: true,
        message: "Started the existing saved-session resume path.",
        state: "implementing",
      },
    ]),
    createdAt: NOW - 8_000,
    updatedAt: NOW - 6_400,
  });
  addTurn(insert, {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    content: "Check the concise task status.",
    targets: JSON.stringify([{ threadId: TASK_ID, title: "Concise agent communication setting", state: "implementing" }]),
    status: "pending",
    createdAt: NOW - 5_000,
    updatedAt: NOW - 5_000,
  });
  addTurn(insert, {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    content: "Pause the deployment review.",
    targets: JSON.stringify([{ threadId: OTHER_TASK_ID, title: "Review the deployment", state: "review" }]),
    status: "failed",
    response: "Pause is only safe for a live implementing task.",
    actions: JSON.stringify([
      {
        threadId: OTHER_TASK_ID,
        threadTitle: "Review the deployment",
        action: "pause",
        ok: false,
        message: "Pause is only safe for a live implementing task; this task is review.",
        state: "review",
      },
    ]),
    usedAgent: 1,
    costUsd: 0.0123,
    tokens: 321,
    model: "claude-sonnet-5",
    provider: "claude",
    createdAt: NOW - 4_000,
    updatedAt: NOW - 3_000,
  });
  addTurn(insert, {
    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    content: "Handle whichever task needs attention.",
    status: "needs_input",
    response: "Which existing task should I supervise?",
    createdAt: NOW - 2_000,
    updatedAt: NOW - 1_000,
  });
  addTurn(insert, {
    id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    content: "Inspect the damaged audit row.",
    targets: "{not-json",
    status: "succeeded",
    actions: "{}",
    createdAt: NOW - 500,
    updatedAt: NOW - 100,
  });
  db.close();
  db = null;

  console.log("\nA. one durable turn answers delivery, execution, and current task state");
  {
    const payload = json(DB_PATH, "9e385dfd");
    check("turn-id prefix finds exactly one receipt", payload.matched === 1);
    const turn = payload.turns[0];
    check("terminal receipt is explicit", turn.receipt.state === "persisted_succeeded" && turn.receipt.elapsedMs === 1_600);
    check("send-time target snapshot is preserved", turn.targets[0].state === "failed");
    check("current task state is joined independently", turn.currentTasks[0].state === "done");
    check("the authoritative action result is summarized", turn.actionSummary.total === 1 && turn.actionSummary.succeeded === 1 && turn.actionSummary.failed === 0);
    check("deterministic control is distinguishable from a model turn", turn.usedAgent === false && turn.model === null);

    const human = run(DB_PATH, "9e385dfd");
    check("human output leads with the terminal state", human.status === 0 && /\[SUCCEEDED\] 9e385dfd/.test(human.stdout), human.stdout);
    check("human output contrasts sent and current state", /sent while failed; current done/.test(human.stdout), human.stdout);
    check("human output reports action success", /execution: 1\/1 action\(s\) succeeded, 0 failed/.test(human.stdout), human.stdout);
  }

  console.log("\nB. target routing can be found by ids, snapshot titles, and current titles");
  {
    check("full task id finds every turn routed to that task", json(DB_PATH, TASK_ID).matched === 2);
    check("send-time task title is searchable", json(DB_PATH, "Concise agent communication").matched === 2);
    check("renamed current task title resolves back to stored target ids", json(DB_PATH, "communication complete").matched === 2);
    check("owner message text is searchable", json(DB_PATH, "ensure it is finished").turns[0].id.startsWith("9e385dfd"));
    check("percent signs are literal rather than SQL wildcards", run(DB_PATH, "%").status === 1);
  }

  console.log("\nC. successful board-wide steering proves the task-feed delivery and prompt acknowledgment");
  {
    const payload = json(DB_PATH, BOARD_MESSAGE);
    check("the exact zero-target board-wide message finds one durable turn", payload.matched === 1 && payload.turns[0].targets.length === 0);
    const evidence = payload.turns[0].deliveryEvidence[0];
    check("the successful steer joins its persisted injection", evidence.injections.length === 1 && evidence.injections[0].content.includes(BOARD_INSTRUCTION));
    check("the prompt ACK is correlated without becoming execution authority", evidence.injections[0].acknowledgments.length === 1 && evidence.injections[0].acknowledgments[0].content.startsWith("ACK:"));

    const human = run(DB_PATH, BOARD_MESSAGE);
    check("human output prints the exact persisted instruction", /persisted injection:.*Finish the current approved scope promptly/s.test(human.stdout), human.stdout);
    check("human output prints the agent acknowledgment", /agent acknowledgment:.*retain every quality gate/s.test(human.stdout), human.stdout);

    const missing = json(DB_PATH, "ffffffff").turns[0];
    check("a successful steer without a feed echo is warned, not silently trusted", missing.warnings.some((warning) => warning.includes("no persisted Supervisor injection")));
  }

  console.log("\nD. pending, failure, needs-input, and corrupt audit data cannot look successful");
  {
    const pending = run(DB_PATH, "aaaaaaaa");
    check("pending says the message was persisted but not completed", /\[PENDING\]/.test(pending.stdout) && /no terminal Supervisor receipt yet/.test(pending.stdout), pending.stdout);

    const failed = run(DB_PATH, "bbbbbbbb");
    check("a received failure names its failed action", /\[FAILED\]/.test(failed.stdout) && /\[FAILED\] pause/.test(failed.stdout), failed.stdout);
    check("provider usage remains auditable", /agent \(claude \/ claude-sonnet-5; 321 tokens, \$0\.0123\)/.test(failed.stdout), failed.stdout);

    const needs = run(DB_PATH, "cccccccc");
    check("ambiguity is a distinct needs-input receipt", /\[NEEDS INPUT\]/.test(needs.stdout) && /Which existing task/.test(needs.stdout), needs.stdout);

    const corrupt = json(DB_PATH, "dddddddd").turns[0];
    check("invalid targets are surfaced, not folded into no targets", corrupt.targets === null && corrupt.warnings.some((warning) => warning.includes("targets is invalid JSON")));
    check("non-array action JSON is surfaced", corrupt.actionResults === null && corrupt.warnings.some((warning) => warning.includes("not an array")));
  }

  console.log("\nE. recent mode, not-found, schema drift, and usage have unambiguous exits");
  {
    const recent = json(DB_PATH, "--limit", "2");
    check("no-query mode returns the requested recent slice", recent.query === null && recent.matched === 2);
    check("recent rows are newest first", recent.turns[0].id.startsWith("dddddddd") && recent.turns[1].id.startsWith("cccccccc"));

    const absent = run(DB_PATH, "message that never arrived");
    check("a missing durable receipt exits like grep", absent.status === 1 && /No durable Supervisor-chat turn matches/.test(absent.stdout), absent.stdout);

    const emptyPath = path.join(TEMP, "old-build.sqlite");
    const old = new Database(emptyPath);
    old.exec("CREATE TABLE kv(key TEXT PRIMARY KEY, value TEXT)");
    old.close();
    const missingSchema = run(emptyPath);
    check("an old backend is distinct from an empty conversation", missingSchema.status === 2 && /supervisor_chat_turns is absent/.test(missingSchema.stderr), missingSchema.stderr);

    const badLimit = run(DB_PATH, "--limit", "0");
    check("invalid argv is a usage error", badLimit.status === 2 && /--limit must be an integer/.test(badLimit.stderr), badLimit.stderr);
  }

  console.log("\nF. the diagnostic is physically read-only");
  {
    const before = fs.readFileSync(DB_PATH);
    run(DB_PATH);
    run(DB_PATH, "bbbbbbbb", "--json");
    const after = fs.readFileSync(DB_PATH);
    check("probing leaves the SQLite file byte-identical", before.equals(after));
  }
} finally {
  if (db?.open) db.close();
  fs.rmSync(TEMP, { recursive: true, force: true });
}

console.log(`\nPASS -- ${passed} Supervisor-chat probe assertions passed`);
