#!/usr/bin/env node
// Retire an already-stopped collaborator and give its lead the full task on the next turn.
// Stop the collaborator through thread.cancel first. This script refuses to change ownership
// while any collaborator run is live. Inject the new scope into the lead after it succeeds.
// Usage: node scripts/collapse-shotgun-task.cjs <lead-uuid> --apply

const Database = require("better-sqlite3");
const path = require("node:path");

const dbPath = path.join(__dirname, "..", "data", "orchestrator.sqlite");

function singleAgentKickoff(kickoff) {
  const marker = kickoff.indexOf("You are one of several agents working this repository RIGHT NOW");
  if (marker < 0) throw new Error("The saved kickoff has no parallel-ownership section.");
  const start = kickoff.lastIndexOf("\n\n##", marker);
  if (start < 0) throw new Error("Cannot locate the start of the parallel-ownership section.");
  return kickoff.slice(0, start).replace(
    /multiple agents requested[^\n]*/,
    "one implementor now owns the full objective",
  ) + "\n\n## Single-agent scope\nThe collaborator has stopped. You own the full task and all files in the workspace. Review its committed and uncommitted work before editing it. Continue the original brief. The old file ownership split no longer applies.";
}

function collapse(db, leadId) {
  return db.transaction(() => {
    const lead = db.prepare("SELECT id, title, state, agent_count, stage_outputs FROM threads WHERE id = ? AND parent_id IS NULL").get(leadId);
    if (!lead) throw new Error("No lead task has that ID.");
    if (lead.agent_count !== 2) throw new Error(`Expected a two-agent lead; found agent_count=${lead.agent_count}.`);
    const children = db.prepare("SELECT id, title, state FROM threads WHERE parent_id = ?").all(leadId);
    if (children.length !== 1) throw new Error(`Expected one collaborator; found ${children.length}.`);
    const child = children[0];
    if (child.state !== "cancelled") throw new Error(`Cancel collaborator ${child.id} through the live server first (state=${child.state}).`);
    const live = db.prepare("SELECT COUNT(*) AS n FROM agent_runs WHERE thread_id = ? AND ended_at IS NULL").get(child.id).n;
    if (live) throw new Error(`Collaborator ${child.id} still has ${live} live run(s).`);
    const stage = JSON.parse(lead.stage_outputs || "{}");
    if (stage.shotgunChildren?.length !== 1 || stage.shotgunChildren[0] !== child.id || !stage.shotgunAssignment) {
      throw new Error("The saved split does not match the collaborator; no change was made.");
    }
    if (!stage.kickoff) throw new Error("The lead has no saved kickoff.");
    stage.kickoff = singleAgentKickoff(stage.kickoff);
    stage.shotgunChildren = [];
    stage.shotgunAssignment = null;
    stage.shotgunIntegrated = true;
    stage.shotgunDegraded = "Owner changed this running task to one agent after the collaborator stopped.";
    db.prepare("UPDATE threads SET agent_count = 1, stage_outputs = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(stage), Date.now(), leadId);
    return { lead: { id: lead.id, title: lead.title, state: lead.state, agentCount: 1 }, retiredCollaborator: child };
  })();
}

function main(args) {
  const [leadId, flag] = args;
  if (!/^[0-9a-f-]{36}$/i.test(leadId || "") || flag !== "--apply" || args.length !== 2) {
    throw new Error("Usage: node scripts/collapse-shotgun-task.cjs <lead-uuid> --apply");
  }
  const db = new Database(dbPath);
  try { console.log(JSON.stringify(collapse(db, leadId), null, 2)); }
  finally { db.close(); }
}

if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { singleAgentKickoff, collapse };
