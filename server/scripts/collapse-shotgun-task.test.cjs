const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { collapse, singleAgentKickoff } = require("./collapse-shotgun-task.cjs");

const leadId = "1a67d70b-44ca-49df-bee6-150420d7aa38";
const childId = "c2f10a18-f3fe-49f5-b6f9-55dccec63f30";
const kickoff = "# Task\n\nFor this task: no planning, QA. multiple agents requested — split it\n\n## 🔀 You are one of several agents working this repository RIGHT NOW\n\nOnly edit your files\n\n## Your share of this task\nDo one part";

assert.match(singleAgentKickoff(kickoff), /Single-agent scope/);
assert.doesNotMatch(singleAgentKickoff(kickoff), /Only edit your files|Your share of this task|multiple agents requested/);

function fixture() {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, state TEXT, agent_count INTEGER, parent_id TEXT, stage_outputs TEXT, updated_at INTEGER); CREATE TABLE agent_runs (thread_id TEXT, ended_at INTEGER)");
  db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?)").run(leadId, "lead", "implementing", 2, null,
    JSON.stringify({ kickoff, shotgunChildren: [childId], shotgunAssignment: { files: ["src/a"] }, shotgunPlanned: true }), 1);
  db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?)").run(childId, "child", "cancelled", null, leadId, "{}", 1);
  return db;
}

{
  const db = fixture();
  const result = collapse(db, leadId);
  const lead = db.prepare("SELECT agent_count, stage_outputs FROM threads WHERE id = ?").get(leadId);
  const stage = JSON.parse(lead.stage_outputs);
  assert.equal(result.retiredCollaborator.id, childId);
  assert.equal(lead.agent_count, 1);
  assert.deepEqual(stage.shotgunChildren, []);
  assert.equal(stage.shotgunAssignment, null);
  assert.equal(stage.shotgunIntegrated, true);
  assert.equal(db.prepare("SELECT parent_id FROM threads WHERE id = ?").get(childId).parent_id, leadId);
  db.close();
}

{
  const db = fixture();
  db.prepare("INSERT INTO agent_runs VALUES (?, NULL)").run(childId);
  assert.throws(() => collapse(db, leadId), /still has 1 live run/);
  assert.equal(db.prepare("SELECT agent_count FROM threads WHERE id = ?").get(leadId).agent_count, 2);
  db.close();
}

console.log("collapse-shotgun-task: pass");
