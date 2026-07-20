// Diagnose CLI office-bridge (OFFICE[team|office]) failures against the live DB.
// Read-only. Safe while prod is up (WAL + busy_timeout).
//
//   node scripts/probe-office-chat.cjs
//   node scripts/probe-office-chat.cjs --thread <uuid>
//   node scripts/probe-office-chat.cjs --limit 60
//
// What to look for when Grok "can't post to team chat":
//   • project-scope bodies shorter than ~12 chars, or body === "\\n"  → mid-stream
//     openEnded harvest truncating a claim (see officeBridge openEnded gate).
//   • messages.content still containing OFFICE[                    → extractor
//     missed the marker (regex / glued-turn / stream path).
//   • auto 👋 announce rows only, no implementor project posts      → runner
//     never harvested (onOfficeChat not wired, or process died before flush).

const path = require("node:path");
const Database = require("better-sqlite3");

const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const LIMIT = Math.max(5, Math.min(200, Number(flag("--limit") || 40) || 40));
const THREAD = flag("--thread");
const dbPath = path.resolve(__dirname, "..", "data", "orchestrator.sqlite");

const db = new Database(dbPath, { readonly: true });
db.pragma("busy_timeout = 5000");

function section(title) {
  console.log(`\n=== ${title} ===`);
}

function short(s, n = 140) {
  if (s == null) return null;
  const t = String(s).replace(/\s+/g, " ");
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

section(`db: ${dbPath}`);

// 1) Recent chat_messages — project posts with short bodies are the smoking gun.
section(`recent chat_messages (last ${LIMIT})`);
{
  const rows = db
    .prepare(
      `SELECT id, room, scope, role, kind, body, sender_name, created_at, thread_id
       FROM chat_messages
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(LIMIT);
  for (const r of rows) {
    const len = r.body == null ? 0 : String(r.body).length;
    const flagShort = r.scope === "project" && len > 0 && len < 12 ? " ⚠SHORT" : "";
    const flagJunk = r.body === "\\n" || r.body === "\n" ? " ⚠JUNK" : "";
    console.log({
      at: r.created_at,
      scope: r.scope,
      room: r.room,
      who: r.sender_name || r.role,
      len,
      body: short(r.body, 100),
      thread: r.thread_id ? String(r.thread_id).slice(0, 8) : null,
      flags: (flagShort + flagJunk).trim() || undefined,
    });
  }
}

// 2) Short project bodies only (the Fen "claimi" class).
section("project-scope bodies with length < 20 (last 30)");
{
  const rows = db
    .prepare(
      `SELECT id, sender_name, body, length(body) AS n, created_at, thread_id
       FROM chat_messages
       WHERE scope = 'project' AND length(body) < 20
       ORDER BY created_at DESC
       LIMIT 30`,
    )
    .all();
  if (!rows.length) console.log("(none)");
  for (const r of rows) {
    console.log({
      at: r.created_at,
      who: r.sender_name,
      n: r.n,
      body_repr: JSON.stringify(r.body),
      thread: r.thread_id ? String(r.thread_id).slice(0, 8) : null,
    });
  }
}

// 3) Assistant text that still contains OFFICE[ — extractor miss.
section("messages still containing OFFICE[ (last 20)");
{
  const rows = db
    .prepare(
      `SELECT id, thread_id, run_id, role, kind, content, created_at
       FROM messages
       WHERE content LIKE '%OFFICE[%'
       ORDER BY created_at DESC
       LIMIT 20`,
    )
    .all();
  if (!rows.length) console.log("(none)");
  for (const r of rows) {
    console.log({
      at: r.created_at,
      role: r.role,
      kind: r.kind,
      thread: r.thread_id ? String(r.thread_id).slice(0, 8) : null,
      content: short(r.content, 160),
    });
  }
}

// 4) Optional per-thread deep dive.
if (THREAD) {
  section(`thread ${THREAD} — project chat`);
  const chats = db
    .prepare(
      `SELECT scope, role, kind, body, sender_name, created_at
       FROM chat_messages WHERE thread_id = ? ORDER BY created_at ASC`,
    )
    .all(THREAD);
  for (const r of chats) {
    console.log({
      at: r.created_at,
      scope: r.scope,
      who: r.sender_name || r.role,
      body_repr: JSON.stringify(r.body),
    });
  }

  section(`thread ${THREAD} — implementor text (first 30)`);
  const msgs = db
    .prepare(
      `SELECT kind, content, created_at FROM messages
       WHERE thread_id = ? AND role = 'implementor'
       ORDER BY created_at ASC LIMIT 30`,
    )
    .all(THREAD);
  for (const r of msgs) {
    const c = r.content || "";
    console.log({
      at: r.created_at,
      kind: r.kind,
      has_office: c.includes("OFFICE["),
      content: short(c, 180),
    });
  }
}

// 5) Recent Grok implementor runs (column is `account`, not account_id).
section("recent Grok implementor runs (last 12)");
{
  const rows = db
    .prepare(
      `SELECT id, thread_id, role, account, state, model, started_at, ended_at, error
       FROM agent_runs
       WHERE account LIKE 'grok:%' OR model LIKE '%grok%'
       ORDER BY started_at DESC
       LIMIT 12`,
    )
    .all();
  if (!rows.length) console.log("(none)");
  for (const r of rows) {
    console.log({
      at: r.started_at,
      state: r.state,
      model: r.model,
      account: r.account,
      thread: r.thread_id ? String(r.thread_id).slice(0, 8) : null,
      error: r.error ? short(r.error, 80) : null,
    });
  }
}

console.log("");
db.close();
