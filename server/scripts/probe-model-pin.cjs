#!/usr/bin/env node
// Fast, read-only proof that an explicit task model request reached the real
// implementor runtime. Unlike probe:task-runs, this does not scan message history.

const path = require("node:path");
const Database = require("better-sqlite3");
const { modelPinReading, parsePersistedModelRequest, parseProbeArgs } = require("./model-pin-reading.cjs");

let options;
try {
  options = parseProbeArgs(["--verify-model-pin", ...process.argv.slice(2)]);
  if (options.showPrompt) throw new Error("--prompt belongs to probe:task-runs");
} catch (error) {
  console.error(`usage: node scripts/probe-model-pin.cjs <thread-id | title-substring> [--expect-model <canonical-id>]\n${error.message}`);
  process.exit(2);
}

const dbPath = process.env.ORCH_DB
  ? path.resolve(process.env.ORCH_DB)
  : path.resolve(__dirname, "..", "data", "orchestrator.sqlite");
const db = new Database(dbPath, { readonly: true });
db.pragma("busy_timeout = 5000");

let thread = db.prepare("SELECT id, title, state, model_request FROM threads WHERE id = ?").get(options.query);
if (!thread) {
  thread = db
    .prepare("SELECT id, title, state, model_request FROM threads WHERE id LIKE ? ORDER BY created_at DESC LIMIT 1")
    .get(`${options.query}%`);
}
if (!thread) {
  thread = db
    .prepare("SELECT id, title, state, model_request FROM threads WHERE title LIKE ? ORDER BY created_at DESC LIMIT 1")
    .get(`%${options.query}%`);
}
if (!thread) {
  db.close();
  console.error(`No thread matches "${options.query}" (by id or title).`);
  process.exit(1);
}

const runs = db
  .prepare(
    `SELECT role, model, account, state, started_at
     FROM agent_runs WHERE thread_id = ? ORDER BY started_at ASC`,
  )
  .all(thread.id);
const reading = modelPinReading({
  modelRequest: parsePersistedModelRequest(thread.model_request),
  runs,
  expectedModel: options.expectedModel,
});

console.log(`\n=== strict model pin: ${reading.ok ? "PASS" : "FAIL"} ===`);
console.log({
  threadId: thread.id,
  title: thread.title,
  threadState: thread.state,
  expectedModel: reading.expectedModel,
  requestedModel: reading.requestedModel,
  requestedProvider: reading.requestedProvider,
  strict: reading.strict,
  actualModel: reading.actualModel,
  actualProvider: reading.actualProvider,
  account: reading.account,
  runState: reading.runState,
});
if (reading.ok) {
  console.log("  ✓ persisted strict request matches the latest implementor agent_run");
} else {
  for (const error of reading.errors) console.log(`  ✗ ${error}`);
}

db.close();
if (!reading.ok) process.exitCode = 1;
