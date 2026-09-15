#!/usr/bin/env node
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");

const root = mkdtempSync(path.join(tmpdir(), "ggo-routing-probe-"));
const dbPath = path.join(root, "fixture.sqlite");
const script = path.join(__dirname, "probe-routing.cjs");

try {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE threads (id TEXT, title TEXT, state TEXT, stage_outputs TEXT, created_at INTEGER);
    CREATE TABLE findings (thread_id TEXT, summary TEXT, detail TEXT, severity TEXT, created_at INTEGER);
    CREATE TABLE agent_runs (thread_id TEXT, role TEXT, model TEXT, account TEXT, state TEXT, started_at INTEGER);
    CREATE TABLE kv (key TEXT, value TEXT);
  `);
  db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?)").run(
    "f1e2d3c4-0000-0000-0000-000000000000",
    "Routing fixture",
    "done",
    JSON.stringify({ routeDecision: { scope: "broad", usePlanner: true, useQa: true, modelPolicy: { tier: "flagship", preferredModel: "claude-opus-5" }, signals: ["production/infra"] } }),
    1,
  );
  db.prepare("INSERT INTO findings VALUES (?, ?, ?, ?, ?)").run(
    "f1e2d3c4-0000-0000-0000-000000000000",
    "Usage-aware routing chose Codex - enough quota runway",
    "Claude: 5h 3% free - at risk\nCodex: 5h 80% free - enough runway",
    "info",
    2,
  );
  db.prepare("INSERT INTO agent_runs VALUES (?, ?, ?, ?, ?, ?)").run("f1e2d3c4-0000-0000-0000-000000000000", "implementor", "gpt-5.6-terra", "codex:gpt-5.6-terra", "done", 3);
  db.prepare("INSERT INTO agent_runs VALUES (?, ?, ?, ?, ?, ?)").run("f1e2d3c4-0000-0000-0000-000000000000", "qa", "claude-sonnet-5", "logged-in", "done", 4);
  for (const [key, value] of [["setting_spread_usage", "1"], ["setting_codex_enabled", "1"], ["setting_auto_model_selection", "0"], ["setting_planner_enabled", "1"], ["setting_qa_enabled", "1"]]) {
    db.prepare("INSERT INTO kv VALUES (?, ?)").run(key, value);
  }
  db.close();

  const env = { ...process.env, ORCH_DB: dbPath };
  const output = execFileSync(process.execPath, [script, "f1e2d3c4"], { encoding: "utf8", env });
  assert.match(output, /routing evidence: Routing fixture/);
  assert.match(output, /spread usage: on/);
  assert.match(output, /persisted Claude subscription disable overrides: none/);
  assert.match(output, /Usage-aware routing chose Codex - enough quota runway/);
  assert.match(output, /Claude run recorded: yes \(1\)/);
  assert.match(output, /does not ping providers/);

  const missing = spawnSync(process.execPath, [script, "missing"], { encoding: "utf8", env });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /No thread matches/);
  console.log("routing probe fixture: PASS");
} finally {
  rmSync(root, { recursive: true, force: true });
}
