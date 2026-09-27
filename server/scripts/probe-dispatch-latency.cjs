// "GGO is slow: I send something and wait minutes." Splits each recent owner message that became a task
// into the phases a human waits through. Read-only, safe while prod runs.
//
//   npm run probe:dispatch-latency --prefix server [-- --limit 20]
//
// Columns, in seconds after the owner's message was stored:
//   task   the thread row exists
//   note   the "dispatched" confirmation (a skip-director send) — a gap between task and note is dispatch
//          awaiting something before it publishes (2026-09-27: the baseline git read, 52-272s)
//   run    the first agent run was created (queue + model/account selection)
//   first  the first agent output — run -> first is CLI boot plus hooks, outside GGO's own code
// A dash means that phase never happened (director reply only, cancelled, still queued).

const path = require("node:path");
const Database = require("better-sqlite3");

const limitArg = process.argv.indexOf("--limit");
const LIMIT = limitArg > 0 ? Math.max(1, Number(process.argv[limitArg + 1]) || 12) : 12;
const db = new Database(path.resolve(__dirname, "..", "data", "orchestrator.sqlite"), { readonly: true });

const owner = db
  .prepare("SELECT created_at, thread_id, substr(content, 1, 50) AS c FROM director_messages WHERE role = 'user' ORDER BY rowid DESC LIMIT ?")
  .all(LIMIT);
const thread = db.prepare("SELECT created_at FROM threads WHERE id = ?");
const note = db.prepare("SELECT created_at FROM director_messages WHERE thread_id = ? AND role = 'director' ORDER BY rowid LIMIT 1");
const run = db.prepare("SELECT min(started_at) AS at FROM agent_runs WHERE thread_id = ?");
// Indexed on (thread_id, created_at), so this never scans the whole messages table.
const first = db.prepare("SELECT created_at AS at FROM messages WHERE thread_id = ? AND role NOT IN ('director', 'user') ORDER BY created_at LIMIT 1");

const secs = (at, from) => (at == null ? "-" : `${((at - from) / 1000).toFixed(1)}s`);
console.log("sent      task    note    run     first    message");
for (const m of owner) {
  const time = new Date(m.created_at).toISOString().slice(11, 19);
  const text = m.c.replace(/\s+/g, " ");
  if (!m.thread_id) {
    console.log(`${time}  (no task linked)                  ${text}`);
    continue;
  }
  const cols = [thread.get(m.thread_id)?.created_at, note.get(m.thread_id)?.created_at, run.get(m.thread_id)?.at, first.get(m.thread_id)?.at];
  console.log(`${time}  ${cols.map((c) => secs(c, m.created_at).padEnd(7)).join(" ")}  ${text}`);
}
