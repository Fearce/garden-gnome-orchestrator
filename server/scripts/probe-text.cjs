// "Which task was I doing X in?" / "did we ever touch Y?" — one word, every table that could hold it.
// Read-only. Safe while prod is up (WAL + busy_timeout). Grep semantics: exit 1 when nothing matched.
//
//   node scripts/probe-text.cjs milkshake
//   npm run probe:text --prefix server -- milkshake
//   npm run probe:text --prefix server -- "3mf" --limit 5
//
// Why it exists: triaging "I searched for milkshake and found nothing" (2026-08-25) started by writing a
// throwaway script to answer the only question that mattered — WHERE in the database does that word
// actually appear? Every recurring triage question here has a probe; that one didn't, so it got
// hand-written and thrown away. The answer it gave reframed the whole task: the word was in `messages`
// 886 times across 16 tasks and in `director_messages` zero times, which is exactly why the console's
// search (scoped to `director_messages`) returned nothing.
//
// It is deliberately WIDER than the console's own search (`db.searchTasks`, which answers the product
// question: ranked tasks, capped, snippets cut for a narrow rail). This answers the triage question —
// which TABLE holds it, how many rows, and in which tasks — including the tables nobody thinks to check
// (findings, office chat, the owner's notes, answered questions). Reach for this BEFORE deciding where a
// missing-text bug lives; reach for the console when you want the ranked answer.
//
// GOTCHAS:
//   • Open the live file with `better-sqlite3` directly and `readonly: true` — NEVER `new Db(path)`.
//     The `Db` constructor RUNS MIGRATIONS, so pointing it at prod to "just read something" writes to
//     the live database. (To run real `Db` code against real data, snapshot first with `VACUUM INTO` —
//     see .claude/rules/rehearse-a-data-migration.md.)
//   • Columns are discovered per table via `PRAGMA table_info`, not hardcoded, so a new text column is
//     searched the day it is added rather than silently skipped.
//   • The query is a LITERAL: `%` and `_` are escaped, because a path or an `id_like_this` is exactly
//     the sort of thing you paste in here.

const path = require("node:path");
const Database = require("better-sqlite3");

const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, "..", "data");
const DB_PATH = path.join(DATA_DIR, "orchestrator.sqlite");

// Columns that are ids, timestamps or JSON bookkeeping: searchable in principle, never the answer to
// "where did we talk about this", and noisy enough to bury it.
const SKIP_COLUMN = /^(id|seq|.*_id|.*_at|created|updated|attachments|stage_outputs|cost_usd|num_turns)$/;

// Where a hit means "a task worked on this", so the probe can roll rows up into the tasks that matter.
const TASK_SCOPED = new Set(["messages", "findings", "questions", "agent_runs", "chat_messages", "operator_notes"]);

const args = process.argv.slice(2);
const limitAt = args.indexOf("--limit");
const limit = limitAt >= 0 ? Number(args[limitAt + 1]) || 10 : 10;
// `limitAt + 1` is the value to drop — but only when the flag is actually present, else it is 0 and
// swallows the search term itself.
const valueAt = limitAt >= 0 ? limitAt + 1 : -1;
const term = args.filter((a, i) => !a.startsWith("--") && i !== valueAt).join(" ").trim();

if (!term) {
  console.error("usage: npm run probe:text --prefix server -- <text> [--limit N]");
  process.exit(2);
}

const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => "\\" + c);
const LIKE = `%${escapeLike(term)}%`;

/** A window around the first match, whitespace collapsed — a matching row is often a megabyte of tool
 *  output, and the point here is to read the hit, not the dump around it. */
function snippet(text, before = 70, after = 150) {
  const at = String(text).toLowerCase().indexOf(term.toLowerCase());
  const body = String(text);
  const anchor = at < 0 ? 0 : at;
  const start = Math.max(0, anchor - before);
  const end = Math.min(body.length, anchor + term.length + after);
  const slice = body.slice(start, end).replace(/\s+/g, " ").trim();
  return (start > 0 ? "…" : "") + slice + (end < body.length ? "…" : "");
}

const db = new Database(DB_PATH, { readonly: true });
db.pragma("busy_timeout = 5000");

/** Every table, with the text columns worth searching in it — read from the schema, never hardcoded. */
function searchableTables() {
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name);
  return names
    .map((name) => ({
      name,
      columns: db
        .prepare(`PRAGMA table_info(${name})`)
        .all()
        .filter((c) => !SKIP_COLUMN.test(c.name) && /TEXT|CHAR|CLOB|BLOB|^$/i.test(c.type))
        .map((c) => c.name),
    }))
    .filter((t) => t.columns.length);
}

const where = (columns) => columns.map((c) => `${c} LIKE @q ESCAPE '\\'`).join(" OR ");

console.log(`\n=== "${term}" in ${DB_PATH} ===\n`);

// ---- 1. the shape of the answer: which tables hold it at all --------------------------------------
const tables = searchableTables();
const counts = [];
for (const t of tables) {
  let n = 0;
  try {
    n = db.prepare(`SELECT COUNT(*) n FROM ${t.name} WHERE ${where(t.columns)}`).get({ q: LIKE }).n;
  } catch {
    continue; // a column type this build can't compare — skip rather than abort the whole probe
  }
  if (n) counts.push({ table: t.name, rows: n, columns: t.columns });
}

if (!counts.length) {
  console.log("  no row in any table contains it.\n");
  db.close();
  process.exit(1);
}

const pad = Math.max(...counts.map((c) => c.table.length));
for (const c of counts) console.log(`  ${c.table.padEnd(pad)}  ${String(c.rows).padStart(7)} row(s)`);

// ---- 2. the question people actually ask: WHICH TASK ------------------------------------------------
const perTask = new Map();
for (const c of counts.filter((c) => TASK_SCOPED.has(c.table))) {
  const rows = db
    .prepare(`SELECT thread_id, COUNT(*) n FROM ${c.table} WHERE ${where(c.columns)} GROUP BY thread_id`)
    .all({ q: LIKE });
  for (const r of rows) {
    if (!r.thread_id) continue;
    const seen = perTask.get(r.thread_id) ?? { total: 0, tables: [] };
    seen.total += r.n;
    seen.tables.push(`${c.table}:${r.n}`);
    perTask.set(r.thread_id, seen);
  }
}

const tasks = [...perTask.entries()]
  .map(([id, hit]) => ({ id, ...hit, thread: db.prepare("SELECT * FROM threads WHERE id = ?").get(id) }))
  .filter((t) => t.thread)
  .sort((a, b) => b.total - a.total);

if (tasks.length) {
  console.log(`\n=== tasks that mention it (${tasks.length}, strongest first) ===\n`);
  for (const t of tasks.slice(0, limit)) {
    const when = new Date(t.thread.created_at).toISOString().slice(0, 10);
    console.log(`  [${t.thread.state}] ${t.thread.title}`);
    console.log(`     ${t.id.slice(0, 8)} · ${when} · ${t.thread.workspace} · ${t.tables.join(" ")}`);
    const best = db
      .prepare(
        `SELECT content FROM messages WHERE thread_id = ? AND content LIKE @q ESCAPE '\\'
         ORDER BY (kind = 'text') DESC, created_at ASC LIMIT 1`,
      )
      .get(t.id, { q: LIKE });
    const evidence = best?.content ?? t.thread.brief ?? t.thread.title;
    console.log(`     ${snippet(evidence)}`);
  }
  if (tasks.length > limit) console.log(`\n  … ${tasks.length - limit} more (raise with --limit)`);
}

// ---- 3. the director conversation, and anything task-less ------------------------------------------
const director = db
  .prepare("SELECT role, content, created_at FROM director_messages WHERE content LIKE @q ESCAPE '\\' ORDER BY created_at DESC")
  .all({ q: LIKE });
console.log(`\n=== director conversation (${director.length}) ===\n`);
if (!director.length) {
  console.log("  nothing — so this word is one an AGENT coined, not one the owner typed.");
  console.log("  (that asymmetry is the normal case here, and is why the console's search covers tasks)");
} else {
  for (const d of director.slice(0, limit)) {
    console.log(`  ${new Date(d.created_at).toISOString().slice(0, 16).replace("T", " ")}  ${d.role}`);
    console.log(`     ${snippet(d.content)}`);
  }
}

console.log("");
db.close();
