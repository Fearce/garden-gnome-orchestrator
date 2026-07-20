// Diagnose ONE task's agent-run trail against the live DB — "why did this task loop / cost so much /
// keep getting interrupted?". Read-only. Safe while prod is up (WAL + busy_timeout).
//
//   node scripts/probe-task-runs.cjs <thread-id | title-substring>
//   node scripts/probe-task-runs.cjs 66695c82
//   node scripts/probe-task-runs.cjs "grok usage"
//   npm run probe:task-runs --prefix server -- 66695c82
//
// What it shows:
//   • the thread's state/error, then every agent_run in order (role · model · state · cost · turns ·
//     duration · error) — the run trail CLAUDE.md's "Debugging a failed task" section tells you to read.
//   • per-(role,model) totals, and a state breakdown (done / error / interrupted / running).
//   • a QA-loop heuristic: launches vs. the maxQaRounds setting, and how many QA runs were killed by a
//     restart (state='interrupted', no verdict) — the signature of the durable-QA-budget drain
//     (see qaRoundBudget.itest.ts / handoff 2026-07-20). If launches ≫ cap, the loop wasn't bounded.
//
// GOTCHA: agent_runs has NO `backend` column — the backend is encoded in `model` (grok-4.5 / gpt-*-sol /
// claude-*). Don't SELECT backend (SqliteError). `interrupted` = a server restart killed the run
// (markInterrupted), not the agent; null cost on such rows still burned real tokens before the kill.

const path = require("node:path");
const Database = require("better-sqlite3");

const arg = process.argv.slice(2).join(" ").trim();
if (!arg) {
  console.error("usage: node scripts/probe-task-runs.cjs <thread-id | title-substring>");
  process.exit(2);
}

const dbPath = path.resolve(__dirname, "..", "data", "orchestrator.sqlite");
const db = new Database(dbPath, { readonly: true });
db.pragma("busy_timeout = 5000");

function section(title) {
  console.log(`\n=== ${title} ===`);
}
function short(s, n = 90) {
  if (s == null) return null;
  const t = String(s).replace(/\s+/g, " ");
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}
function iso(ms) {
  return ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 19) : null;
}
function dur(a, b) {
  if (!a || !b) return null;
  const s = Math.round((b - a) / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

// Resolve the thread: exact id, then id-prefix (the 8-char short id the UI shows), then newest title match.
let thread = db.prepare("SELECT * FROM threads WHERE id = ?").get(arg);
if (!thread) {
  thread = db.prepare("SELECT * FROM threads WHERE id LIKE ? ORDER BY created_at DESC LIMIT 1").get(`${arg}%`);
}
if (!thread) {
  thread = db
    .prepare("SELECT * FROM threads WHERE title LIKE ? ORDER BY created_at DESC LIMIT 1")
    .get(`%${arg}%`);
}
if (!thread) {
  console.error(`No thread matches "${arg}" (by id or title).`);
  process.exit(1);
}

section(`db: ${dbPath}`);
section("thread");
console.log({
  id: thread.id,
  title: short(thread.title, 70),
  state: thread.state,
  lane: thread.lane,
  created: iso(thread.created_at),
  error: short(thread.error, 120),
});

const runs = db
  .prepare("SELECT * FROM agent_runs WHERE thread_id = ? ORDER BY started_at ASC")
  .all(thread.id);

section(`run trail (${runs.length} runs)`);
for (const r of runs) {
  console.log({
    role: r.role,
    model: r.model,
    state: r.state,
    cost: r.cost_usd != null ? Number(r.cost_usd.toFixed(3)) : null,
    turns: r.num_turns,
    dur: dur(r.started_at, r.ended_at),
    started: iso(r.started_at),
    error: short(r.error, 70) || undefined,
  });
}

section("totals by (role, model)");
const totals = db
  .prepare(
    `SELECT role, model, COUNT(*) n, ROUND(SUM(cost_usd), 3) cost, SUM(num_turns) turns
     FROM agent_runs WHERE thread_id = ? GROUP BY role, model ORDER BY role, cost DESC`,
  )
  .all(thread.id);
for (const t of totals) console.log(t);

section("state breakdown by role");
const byState = db
  .prepare(
    `SELECT role, state, COUNT(*) n FROM agent_runs WHERE thread_id = ? GROUP BY role, state ORDER BY role, n DESC`,
  )
  .all(thread.id);
for (const s of byState) console.log(s);

// QA-loop heuristic — the durable-budget drain signature.
section("QA-loop check");
{
  const capRow = db.prepare("SELECT value FROM kv WHERE key = 'setting_max_qa_rounds'").get();
  const cap = capRow ? Number(capRow.value) : null;
  const qa = runs.filter((r) => r.role === "qa");
  const verdicts = qa.filter((r) => r.state === "done").length;
  const interrupted = qa.filter((r) => r.state === "interrupted").length;
  const errored = qa.filter((r) => r.state === "error").length;
  console.log({
    maxQaRoundsSetting: cap,
    qaLaunches: qa.length,
    qaVerdicts: verdicts,
    qaKilledByRestart: interrupted,
    qaErrored: errored,
  });
  if (cap != null && qa.length > cap) {
    console.log(
      `  ⚠ ${qa.length} QA launches vs. a ${cap}-round cap — the loop exceeded its budget. With the ` +
        `durable-qaRoundsUsed fix (44f793b) this is bounded; a higher count on an OLD build is the drain bug.`,
    );
  } else {
    console.log("  ✓ QA launches within the maxQaRounds budget.");
  }
}

db.close();
