#!/usr/bin/env node
// Gate for the Co-work lane's durable-state classifier and its probe.
//
// Every scenario here is a shape the running server can actually produce: a restart mid-turn, a claim
// nothing released, a pin that was substituted, one provider session reaching two conversations. The
// classifier is what makes those readable without hand-written SQLite joins, so it is gated like any
// other classifier in this repo.

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { coworkBoardIssues, coworkReading, coworkTablesExist, selectCoworkRows } = require("./cowork-health.cjs");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ggo-cowork-health-"));
const probe = path.resolve(__dirname, "probe-cowork.cjs");
let checks = 0;

function check(label, fn) {
  fn();
  checks += 1;
  console.log(`  ok  ${label}`);
}

function runProbe(file, ...args) {
  return spawnSync(process.execPath, [probe, ...args], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, ORCH_DB: file },
    encoding: "utf8",
  });
}

function freshDb(name) {
  const file = path.join(temp, `${name}.sqlite`);
  if (fs.existsSync(file)) fs.rmSync(file);
  const db = new Database(file);
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE cowork_sessions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      auto_named INTEGER NOT NULL DEFAULT 1,
      workspace TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'idle',
      requested_provider TEXT,
      requested_model TEXT,
      provider TEXT,
      model TEXT,
      effort TEXT,
      account TEXT,
      agent_session_id TEXT,
      active_turn_id TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE cowork_turns (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      state TEXT NOT NULL,
      provider TEXT,
      model TEXT,
      effort TEXT,
      account TEXT,
      agent_session_id TEXT,
      error TEXT,
      cost_usd REAL,
      num_turns INTEGER,
      total_tokens INTEGER,
      started_at INTEGER NOT NULL,
      ended_at INTEGER
    );
    CREATE TABLE cowork_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      turn_id TEXT,
      role TEXT NOT NULL,
      kind TEXT NOT NULL,
      content TEXT NOT NULL,
      meta TEXT,
      partial INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  return { db, file };
}

function addSession(db, id, overrides = {}) {
  const row = {
    id,
    name: `Session ${id}`,
    auto_named: 0,
    workspace: "C:\\repo",
    state: "idle",
    requested_provider: null,
    requested_model: null,
    provider: "claude",
    model: "claude-opus-5",
    effort: "high",
    account: "personal",
    agent_session_id: null,
    active_turn_id: null,
    error: null,
    created_at: 1_000,
    updated_at: 2_000,
    ...overrides,
  };
  db.prepare(
    `INSERT INTO cowork_sessions
       (id,name,auto_named,workspace,state,requested_provider,requested_model,provider,model,effort,
        account,agent_session_id,active_turn_id,error,created_at,updated_at)
     VALUES (@id,@name,@auto_named,@workspace,@state,@requested_provider,@requested_model,@provider,
             @model,@effort,@account,@agent_session_id,@active_turn_id,@error,@created_at,@updated_at)`,
  ).run(row);
  return row;
}

function addTurn(db, sessionId, id, overrides = {}) {
  const row = {
    id,
    session_id: sessionId,
    state: "done",
    provider: "claude",
    model: "claude-opus-5",
    effort: "high",
    account: "personal",
    agent_session_id: "agent-1",
    error: null,
    cost_usd: 0.25,
    num_turns: 7,
    total_tokens: 4_200,
    started_at: 1_100,
    ended_at: 1_900,
    ...overrides,
  };
  db.prepare(
    `INSERT INTO cowork_turns
       (id,session_id,state,provider,model,effort,account,agent_session_id,error,cost_usd,num_turns,
        total_tokens,started_at,ended_at)
     VALUES (@id,@session_id,@state,@provider,@model,@effort,@account,@agent_session_id,@error,
             @cost_usd,@num_turns,@total_tokens,@started_at,@ended_at)`,
  ).run(row);
  return row;
}

function addMessage(db, sessionId, id, overrides = {}) {
  const row = {
    id,
    session_id: sessionId,
    turn_id: null,
    role: "user",
    kind: "text",
    content: "do the thing",
    meta: null,
    partial: 0,
    created_at: 1_100,
    updated_at: 1_100,
    ...overrides,
  };
  db.prepare(
    `INSERT INTO cowork_messages
       (id,session_id,turn_id,role,kind,content,meta,partial,created_at,updated_at)
     VALUES (@id,@session_id,@turn_id,@role,@kind,@content,@meta,@partial,@created_at,@updated_at)`,
  ).run(row);
  return row;
}

function readings(db) {
  return selectCoworkRows(db).map(coworkReading);
}

function only(db) {
  const all = readings(db);
  assert.equal(all.length, 1, "expected exactly one session in this fixture");
  return all[0];
}

function issueText(reading) {
  return reading.issues.join(" | ");
}

console.log("cowork-health");

// A settled conversation: one finished turn, a linked provider session, ready for the next prompt.
check("a settled session with a finished turn reads idle and clean", () => {
  const { db } = freshDb("healthy");
  addSession(db, "s-healthy", { agent_session_id: "agent-1" });
  addTurn(db, "s-healthy", "t-1");
  addMessage(db, "s-healthy", "m-1", { turn_id: "t-1" });
  addMessage(db, "s-healthy", "m-2", { turn_id: "t-1", role: "coworker", content: "changed x" });
  const reading = only(db);
  assert.equal(reading.disposition, "idle", issueText(reading));
  assert.equal(reading.attention, false, issueText(reading));
  assert.equal(reading.session.messages.owner, 1);
  assert.equal(reading.session.messages.replies, 1);
  assert.equal(reading.costUsd, 0.25);
  assert.deepEqual(coworkBoardIssues(db, [reading]), []);
  db.close();
});

// A live turn legitimately holds a claim and streams a partial reply.
check("a running turn with a streaming partial reply reads active, not broken", () => {
  const { db } = freshDb("active");
  addSession(db, "s-active", { state: "running", active_turn_id: "t-live" });
  addTurn(db, "s-active", "t-live", { state: "running", ended_at: null, cost_usd: null, num_turns: null });
  addMessage(db, "s-active", "m-live", { turn_id: "t-live", role: "coworker", partial: 1 });
  const reading = only(db);
  assert.equal(reading.disposition, "active", issueText(reading));
  assert.equal(reading.issues.length, 0, issueText(reading));
  db.close();
});

// beginCoworkTurn only claims from idle/error, so this session can never accept another prompt again.
check("a running session with no active turn is flagged as unable to accept a prompt", () => {
  const { db } = freshDb("wedged");
  addSession(db, "s-wedged", { state: "running", active_turn_id: null });
  const reading = only(db);
  assert.equal(reading.disposition, "attention");
  assert.match(issueText(reading), /cannot accept another prompt/);
  db.close();
});

check("an idle session still holding a claim is flagged", () => {
  const { db } = freshDb("stale-claim");
  addSession(db, "s-stale", { state: "idle", active_turn_id: "t-1" });
  addTurn(db, "s-stale", "t-1");
  const reading = only(db);
  assert.match(issueText(reading), /state 'idle' still holds active_turn_id/);
  db.close();
});

check("a claim pointing at a missing turn row is flagged", () => {
  const { db } = freshDb("ghost-claim");
  addSession(db, "s-ghost", { state: "running", active_turn_id: "t-missing" });
  const reading = only(db);
  assert.match(issueText(reading), /has no cowork_turns row/);
  db.close();
});

// The boot reconcile (interruptOrphanedCoworkTurns) exists to make this shape impossible.
check("a leftover running turn that is not the active turn reads as unreconciled", () => {
  const { db } = freshDb("unreconciled");
  addSession(db, "s-orphan", { state: "idle", active_turn_id: null });
  addTurn(db, "s-orphan", "t-old", { state: "running", ended_at: null });
  const reading = only(db);
  assert.match(issueText(reading), /still 'running' but is not the active turn/);
  db.close();
});

check("a terminal turn with no ended_at is flagged", () => {
  const { db } = freshDb("no-ended");
  addSession(db, "s-noend");
  addTurn(db, "s-noend", "t-1", { state: "done", ended_at: null });
  assert.match(issueText(only(db)), /has no ended_at/);
  db.close();
});

// A failed turn is recoverable, but only if the owner can read why it failed.
check("a failed turn with no reason is flagged; with a reason it reads recoverable", () => {
  const { db } = freshDb("failed-blank");
  addSession(db, "s-blank", { state: "error", error: null });
  addTurn(db, "s-blank", "t-1", { state: "error", error: null });
  assert.match(issueText(only(db)), /failed with no owner-visible reason/);
  db.close();

  const withReason = freshDb("failed-reason");
  addSession(withReason.db, "s-reason", { state: "error", error: "capacity exhausted" });
  addTurn(withReason.db, "s-reason", "t-1", { state: "error", error: "capacity exhausted" });
  const reading = only(withReason.db);
  assert.equal(reading.disposition, "recoverable", issueText(reading));
  assert.equal(reading.attention, false, issueText(reading));
  withReason.db.close();
});

check("an interrupted turn carrying the restart notice is not an invariant violation", () => {
  const { db } = freshDb("interrupted");
  addSession(db, "s-int", {
    state: "error",
    error: "The server restarted during this turn.",
    agent_session_id: "agent-9",
  });
  addTurn(db, "s-int", "t-1", { state: "interrupted", error: "The server restarted during this turn." });
  const reading = only(db);
  assert.equal(reading.disposition, "recoverable", issueText(reading));
  db.close();
});

// "Do not silently substitute an explicitly selected model" is the pin's whole point.
check("a pinned session that ran on another provider/model is flagged as a substitution", () => {
  const { db } = freshDb("substituted");
  addSession(db, "s-pin", {
    requested_provider: "claude",
    requested_model: "claude-opus-5",
    provider: "zai",
    model: "glm-5.3",
  });
  addTurn(db, "s-pin", "t-1", { provider: "zai", model: "glm-5.3", account: "zai" });
  const reading = only(db);
  assert.match(issueText(reading), /ran on zai\/glm-5\.3 despite the pin claude\/claude-opus-5/);
  db.close();
});

check("a pinned session that honored its pin is clean and says so in a note", () => {
  const { db } = freshDb("pin-ok");
  addSession(db, "s-ok", { requested_provider: "claude", requested_model: "claude-opus-5" });
  addTurn(db, "s-ok", "t-1");
  const reading = only(db);
  assert.equal(reading.attention, false, issueText(reading));
  assert.match(reading.notes.join(" "), /fails rather than substituting/);
  db.close();
});

check("a half-set target is flagged", () => {
  const { db } = freshDb("half-pin");
  addSession(db, "s-half", { requested_provider: "claude", requested_model: null });
  assert.match(issueText(only(db)), /half-set/);
  db.close();
});

// A partial row outside a running turn renders as a truncated reply forever after reload.
check("a partial message left outside a running turn is flagged", () => {
  const { db } = freshDb("dangling");
  addSession(db, "s-partial", { state: "idle", active_turn_id: null });
  addTurn(db, "s-partial", "t-1", { state: "done" });
  addMessage(db, "s-partial", "m-1", { turn_id: "t-1", role: "coworker", partial: 1 });
  assert.match(issueText(only(db)), /still partial=1 outside a running turn/);
  db.close();
});

check("a session with no turns yet reads empty, not broken", () => {
  const { db } = freshDb("empty");
  addSession(db, "s-empty");
  const reading = only(db);
  assert.equal(reading.disposition, "empty", issueText(reading));
  db.close();
});

check("a session with no linked provider session says the next turn starts fresh", () => {
  const { db } = freshDb("nolink");
  addSession(db, "s-nolink", { agent_session_id: null });
  addTurn(db, "s-nolink", "t-1", { state: "done" });
  assert.match(only(db).notes.join(" "), /replays the transcript into a fresh agent session/);
  db.close();
});

// Board-level: one provider session must never back two conversations.
check("one provider session shared by two sessions is a board issue", () => {
  const { db } = freshDb("shared-agent");
  addSession(db, "s-a", { agent_session_id: "agent-shared" });
  addSession(db, "s-b", { agent_session_id: "agent-shared" });
  const issues = coworkBoardIssues(db, readings(db));
  assert.equal(issues.length, 1, issues.join(" | "));
  assert.match(issues[0], /shared by 2 Co-work sessions/);
  db.close();
});

check("distinct provider sessions raise no board issue", () => {
  const { db } = freshDb("distinct-agents");
  addSession(db, "s-a", { agent_session_id: "agent-a" });
  addSession(db, "s-b", { agent_session_id: "agent-b" });
  assert.deepEqual(coworkBoardIssues(db, readings(db)), []);
  db.close();
});

// prepareCoworkerRun builds a synthetic `cowork:<id>` Thread for the strict capacity gate only.
check("a persisted cowork: task row is a board issue", () => {
  const { db } = freshDb("leaked-thread");
  addSession(db, "s-leak");
  db.prepare("INSERT INTO threads(id,title,state,created_at,updated_at) VALUES(?,?,?,?,?)").run(
    "cowork:s-leak",
    "Session s-leak",
    "intake",
    1,
    2,
  );
  const issues = coworkBoardIssues(db, readings(db));
  assert.match(issues.join(" | "), /must never be persisted/);
  db.close();
});

check("filtering accepts an id prefix and a name substring", () => {
  const { db, file } = freshDb("filter");
  addSession(db, "abc12345", { name: "Refactor the parser" });
  addSession(db, "def67890", { name: "Fix the chip strip" });
  assert.equal(selectCoworkRows(db, "abc").length, 1);
  assert.equal(selectCoworkRows(db, "chip").length, 1);
  assert.equal(selectCoworkRows(db, "nothing-matches").length, 0);
  assert.equal(selectCoworkRows(db).length, 2);
  db.close();

  const filtered = runProbe(file, "chip");
  assert.equal(filtered.status, 0, filtered.stderr);
  assert.match(filtered.stdout, /Fix the chip strip/);
  assert.doesNotMatch(filtered.stdout, /Refactor the parser/);
  const missed = runProbe(file, "nothing-matches");
  assert.match(missed.stdout, /No Co-work session matched/);
});

console.log("probe-cowork");

check("the probe exits 0 and prints PASS on a healthy board", () => {
  const { db, file } = freshDb("probe-pass");
  addSession(db, "s-pass", { agent_session_id: "agent-1" });
  addTurn(db, "s-pass", "t-1");
  db.close();
  const run = runProbe(file);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^PASS - checked 1 Co-work session/m);
  assert.match(run.stdout, /\[IDLE\] s-pass/);
  assert.match(run.stdout, /next turn continues it/);
});

check("the probe exits 1 and names the violation on a wedged claim", () => {
  const { db, file } = freshDb("probe-fail");
  addSession(db, "s-bad", { state: "running", active_turn_id: null });
  db.close();
  const run = runProbe(file);
  assert.equal(run.status, 1, run.stdout);
  assert.match(run.stdout, /^ATTENTION/m);
  assert.match(run.stdout, /ISSUE: state 'running' has no active turn/);
});

check("the probe exits 1 on a board-level issue even when every session is clean", () => {
  const { db, file } = freshDb("probe-board");
  addSession(db, "s-a", { agent_session_id: "agent-shared" });
  addSession(db, "s-b", { agent_session_id: "agent-shared" });
  db.close();
  const run = runProbe(file);
  assert.equal(run.status, 1, run.stdout);
  assert.match(run.stdout, /BOARD ISSUE: provider session agent-shared is shared/);
});

check("--json carries the verdict, counts, issues and the turn trail", () => {
  const { db, file } = freshDb("probe-json");
  addSession(db, "s-json", { agent_session_id: "agent-1" });
  addTurn(db, "s-json", "t-1", { cost_usd: 0.5 });
  addTurn(db, "s-json", "t-2", { state: "error", error: "boom", cost_usd: 0.25 });
  db.close();
  const run = runProbe(file, "--json");
  assert.equal(run.status, 0, run.stderr);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.verdict, "PASS");
  assert.equal(payload.checked, 1);
  assert.equal(payload.counts.idle, 1);
  assert.equal(payload.entries[0].turns, 2);
  assert.equal(payload.entries[0].costUsd, 0.75);
  assert.equal(payload.entries[0].trail[1].error, "boom");
});

check("an unknown flag or a second positional is a usage error", () => {
  const { db, file } = freshDb("probe-usage");
  db.close();
  const bad = runProbe(file, "--nope");
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /usage: node scripts\/probe-cowork\.cjs/);
  const two = runProbe(file, "one", "two");
  assert.equal(two.status, 2);
});

check("a DB predating the Co-work lane exits 2 rather than reporting a clean board", () => {
  const file = path.join(temp, "legacy.sqlite");
  const legacy = new Database(file);
  legacy.exec("CREATE TABLE threads(id TEXT PRIMARY KEY)");
  assert.equal(coworkTablesExist(legacy), false);
  legacy.close();
  const run = runProbe(file);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /predates the Co-work lane/);
});

fs.rmSync(temp, { recursive: true, force: true });
console.log(`\ncowork-health: ${checks}/${checks} checks passed`);
