#!/usr/bin/env node
// Snapshot a task's durable record to markdown BEFORE something destroys it. Read-only on the DB
// (WAL + busy_timeout), so it is safe while prod is up.
//
//   node scripts/archive-thread.cjs <id | id-prefix | title-substring> [more...] [--out <file>] [--force]
//   node scripts/archive-thread.cjs --cancelled            # every open cancelled task, oldest first
//   npm run archive:thread --prefix server -- 4f42e722
//
// WHY IT EXISTS. Retry is the ONLY way to continue a cancelled task, because `resumeThread` refuses one
// outright ("Task is cancelled. Retry it to start again."), and `db.resetThreadForRetry` DELETES that
// task's feed, findings and deliverables so the fresh attempt starts clean. On 2026-09-14 the
// token-limit guard cancelled five in-flight tasks mid-tool-call, and continuing them meant pressing
// Retry on all five: without this script that click would have destroyed the binding ball-conversion
// design rules, the measurement showing a "perf regression" was really a contended box, the real
// invisible-run mechanism (a Windows desktop object, not `--position`), and ten prototype captures.
// None of that is recoverable from git, since findings only ever lived in SQLite. So: archive, then retry.
//
// Nothing here talks to the server. Retry/Resume stay a console click (or `thread.retry` over the WS);
// this only makes pressing them non-destructive.
//
// GOTCHAS this encodes:
//   * A deliverable row is a PATH, not bytes. An agent's captures often sit in a temp dir or a verify
//     worktree that is long gone, so every path is stat'd and a missing one is marked MISSING. An
//     archive that silently lists dead paths is worse than no archive, because it reads as evidence.
//   * Retry preserves `stage_outputs.standingDirectives` (the owner's mid-task corrections) and the
//     reader-escalation record. Those survive, so they are noted rather than dumped in full.
//   * Never overwrite an existing archive without `--force`: the usual second run is a typo'd id, and
//     the first run is the only copy of what the retry is about to delete.

const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

const SERVER_DIR = path.resolve(__dirname, "..");
const DB_PATH = path.join(SERVER_DIR, "data", "orchestrator.sqlite");
const ARCHIVE_DIR = path.join(SERVER_DIR, "data", "archives");

const USAGE = [
  "usage: node scripts/archive-thread.cjs <id | id-prefix | title-substring> [more...] [--out <file>] [--force]",
  "       node scripts/archive-thread.cjs --cancelled [--out <file>] [--force]",
  "",
  "Writes a markdown snapshot (brief, findings with full detail, deliverables, run trail) of each task",
  "to data/archives/ so a destructive Retry can't take the record with it. Read-only on the database.",
].join("\n");

function parseArgs(argv) {
  const out = { targets: [], cancelled: false, force: false, out: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--cancelled") out.cancelled = true;
    else if (arg === "--force") out.force = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--out") {
      const value = argv[++i];
      if (!value) throw new Error("--out requires a path");
      out.out = value;
    } else if (arg.startsWith("--")) throw new Error(`unknown argument: ${arg}`);
    else out.targets.push(arg);
  }
  if (out.help) return out;
  if (!out.targets.length && !out.cancelled) throw new Error("name at least one task, or pass --cancelled");
  if (out.targets.length && out.cancelled) throw new Error("--cancelled takes no task arguments");
  return out;
}

/** Resolve one argument the way every probe in this directory does: exact id, then the 8-char short id
 *  the board shows, then the newest title match. Returns null rather than throwing so a batch run can
 *  report every miss at once instead of dying on the first typo. */
function resolveThread(db, arg) {
  return (
    db.prepare("SELECT * FROM threads WHERE id = ?").get(arg) ??
    db.prepare("SELECT * FROM threads WHERE id LIKE ? ORDER BY created_at DESC LIMIT 1").get(`${arg}%`) ??
    db.prepare("SELECT * FROM threads WHERE title LIKE ? ORDER BY created_at DESC LIMIT 1").get(`%${arg}%`) ??
    null
  );
}

function cancelledThreads(db) {
  return db.prepare("SELECT * FROM threads WHERE state = 'cancelled' AND closed_at IS NULL ORDER BY updated_at").all();
}

/** Everything the retry is about to delete, for one thread. */
function collect(db, thread) {
  const findings = db.prepare("SELECT * FROM findings WHERE thread_id = ? ORDER BY created_at").all(thread.id);
  return {
    thread,
    notes: findings.filter((f) => f.kind !== "deliverable"),
    deliverables: findings.filter((f) => f.kind === "deliverable"),
    runs: db.prepare("SELECT * FROM agent_runs WHERE thread_id = ? ORDER BY started_at").all(thread.id),
    lastMessage: db
      .prepare("SELECT role, kind, content, created_at FROM messages WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(thread.id),
    messageCount: db.prepare("SELECT COUNT(*) AS c FROM messages WHERE thread_id = ?").get(thread.id).c,
  };
}

const stamp = (ms) => (ms ? `${new Date(ms).toISOString().replace("T", " ").slice(0, 19)} UTC` : "?");
const oneLine = (s, max = 200) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}...` : t;
};

function duration(run) {
  if (!run.started_at || !run.ended_at) return "live";
  const s = Math.round((run.ended_at - run.started_at) / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

/** A deliverable is only evidence while its file is still there. `exists` is injected so the renderer
 *  stays pure (and the test doesn't have to touch the filesystem). */
function deliverableLine(row, exists) {
  const file = row.path || "(no path recorded)";
  const mark = !row.path ? " -- **NO PATH**" : exists ? "" : " -- **MISSING on disk**";
  return `- **${oneLine(row.label || row.summary, 90)}** : \`${file}\`${mark} (${stamp(row.created_at)})`;
}

/** Fenced blocks must survive prose that itself contains a fence, and an agent finding routinely quotes
 *  one. Pick a fence longer than anything inside, per CommonMark. */
function fence(body) {
  const longest = (String(body).match(/^ {0,3}(`{3,})/gm) ?? []).reduce((n, m) => Math.max(n, m.trim().length), 0);
  const ticks = "`".repeat(Math.max(3, longest + 1));
  return `${ticks}\n${String(body).trim()}\n${ticks}`;
}

function renderThread(record, exists = (p) => fs.existsSync(p)) {
  const { thread, notes, deliverables, runs, lastMessage, messageCount } = record;
  const lines = [`## ${thread.title}`, "", `- **id**: \`${thread.id}\``, `- **state**: ${thread.state}`];
  lines.push(`- **workspace**: \`${thread.workspace}\``);
  lines.push(`- **created**: ${stamp(thread.created_at)} | **last update**: ${stamp(thread.updated_at)}`);
  if (thread.model_request) lines.push(`- **model pin**: \`${oneLine(thread.model_request, 160)}\``);
  if (thread.error) lines.push(`- **error**: ${oneLine(thread.error, 300)}`);

  // Retry keeps these, so record that they exist instead of duplicating them here.
  let stageOutputs = {};
  try {
    stageOutputs = JSON.parse(thread.stage_outputs || "{}") ?? {};
  } catch {
    stageOutputs = {};
  }
  const directives = Array.isArray(stageOutputs.standingDirectives) ? stageOutputs.standingDirectives.length : 0;
  if (directives) lines.push(`- **standing owner directives**: ${directives} (preserved by Retry, not re-listed here)`);

  lines.push("", "### Brief", "", fence(thread.brief || "(empty)"), "");

  lines.push(`### Findings (${notes.length})`, "");
  if (!notes.length) lines.push("_None._", "");
  for (const f of notes) {
    lines.push(`#### [${f.severity}] ${oneLine(f.summary, 300)}`, "", `_${stamp(f.created_at)} | ${f.from_role || "?"}_`, "");
    if (f.detail?.trim()) lines.push(f.detail.trim(), "");
  }

  lines.push(`### Deliverables (${deliverables.length})`, "");
  if (!deliverables.length) lines.push("_None._", "");
  for (const d of deliverables) lines.push(deliverableLine(d, d.path ? exists(d.path) : false));
  if (deliverables.length) lines.push("");

  lines.push(`### Run trail (${runs.length})`, "");
  if (!runs.length) lines.push("_None._", "");
  for (const r of runs) {
    const err = r.error ? ` : ${oneLine(r.error, 160)}` : "";
    lines.push(`- ${stamp(r.started_at)} | **${r.role}** | ${r.state} | ${r.model} | ${duration(r)}${err}`);
  }
  if (runs.length) lines.push("");

  lines.push(`### Feed (${messageCount} entries, last one below)`, "");
  if (!lastMessage) lines.push("_Empty._", "");
  else lines.push(`_${stamp(lastMessage.created_at)} | ${lastMessage.role}/${lastMessage.kind}_`, "", fence(oneLine(lastMessage.content, 1500)), "");

  return lines.join("\n");
}

function renderDocument(records, now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  const head = [
    `# Task archive ${day}`,
    "",
    `Snapshot of ${records.length} task(s) taken from \`server/data/orchestrator.sqlite\` before a destructive`,
    "action. Retry (`resetThreadForRetry`) deletes a task's feed, findings and deliverables; everything below",
    "only ever lived in that database, so this file is the only copy once the button is pressed.",
    "",
    `Written by \`server/scripts/archive-thread.cjs\` at ${stamp(now.getTime())}.`,
    "",
  ];
  return [...head, ...records.map((r) => `---\n\n${renderThread(r)}`)].join("\n");
}

function defaultOutPath(now = new Date()) {
  const slug = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return path.join(ARCHIVE_DIR, `task-archive-${slug}.md`);
}

// `dbPath` is injectable so the gate can drive the whole command against a scratch database instead of
// the live one. Everything else stays on the real defaults.
function main(argv = process.argv.slice(2), { dbPath = DB_PATH, log = console.log, warn = console.error } = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    warn(`error: ${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    log(USAGE);
    return 0;
  }
  if (!fs.existsSync(dbPath)) {
    warn(`error: no database at ${dbPath}`);
    return 1;
  }

  // Close the handle on EVERY exit: Windows keeps the sqlite file locked while it is open, so a
  // caller (the gate) can't clean up its own scratch directory after a run that returned early.
  const db = new Database(dbPath, { readonly: true });
  db.pragma("busy_timeout = 5000");
  try {
    return archive(db, args, log, warn);
  } finally {
    db.close();
  }
}

function archive(db, args, log, warn) {
  let threads;
  if (args.cancelled) {
    threads = cancelledThreads(db);
    if (!threads.length) {
      warn("error: no open cancelled tasks to archive");
      return 1;
    }
  } else {
    const misses = [];
    threads = [];
    for (const target of args.targets) {
      const thread = resolveThread(db, target);
      if (!thread) misses.push(target);
      else if (!threads.some((t) => t.id === thread.id)) threads.push(thread);
    }
    if (misses.length) {
      warn(`error: no task matches ${misses.map((m) => `"${m}"`).join(", ")} (by id, id-prefix or title)`);
      return 1;
    }
  }

  const outPath = path.resolve(args.out ?? defaultOutPath());
  if (fs.existsSync(outPath) && !args.force) {
    warn(`error: ${outPath} already exists, pass --force to overwrite (the existing file may be the only copy)`);
    return 1;
  }

  const records = threads.map((t) => collect(db, t));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, renderDocument(records), "utf8");

  for (const r of records) {
    const missing = r.deliverables.filter((d) => !d.path || !fs.existsSync(d.path)).length;
    log(
      `${r.thread.id.slice(0, 8)} ${r.thread.state.padEnd(12)} ${r.notes.length} finding(s), ` +
        `${r.deliverables.length} deliverable(s)${missing ? ` (${missing} MISSING on disk)` : ""}, ${r.runs.length} run(s): ${oneLine(r.thread.title, 60)}`,
    );
  }
  log(`\nwrote ${outPath} (${fs.statSync(outPath).size} bytes). Safe to Retry now.`);
  return 0;
}

module.exports = { USAGE, cancelledThreads, collect, deliverableLine, defaultOutPath, fence, main, parseArgs, renderDocument, renderThread, resolveThread };

if (require.main === module) process.exit(main());
