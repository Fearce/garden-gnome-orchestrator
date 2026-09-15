#!/usr/bin/env node
// Collapse deliverable finding rows that resolve to the same real file. Companion to the emission-side
// dedup in ThreadManager.postFinding: that fix stops a NEW duplicate from being created, but it can't
// touch rows a task already accumulated before the fix landed (a restore-script pass and a live re-post
// both racing to recover the same file, exactly what happened to the skill-tree prototype task on
// 2026-09-15 -- 20 rows for 10 real files).
//
//   node scripts/dedupe-deliverable-findings.cjs [<task-id>]
//
// Without a task id it scans every task holding at least one deliverable finding. Safe to rerun: once a
// task has no duplicates left it reports 0 removed. Never touches a row whose path does not resolve to a
// real file inside the task workspace -- there is nothing to prove two such rows are the same artifact,
// and deleting an already-dead card is a different repair (the deliverables probe's job) than this one.

const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

const SERVER_DIR = path.resolve(__dirname, "..");
const DB_PATH = path.join(SERVER_DIR, "data", "orchestrator.sqlite");

/** Mirrors GET /api/deliverable/:id's containment check (symlinks resolved on both sides, no
 * `..`/absolute/cross-drive escape, files only) and ThreadManager.resolveDeliverablePath. */
function resolveDeliverablePath(workspace, artifactPath) {
  const candidate = path.isAbsolute(artifactPath) ? artifactPath : path.join(workspace, artifactPath);
  let realWorkspace;
  let realFile;
  try {
    realWorkspace = fs.realpathSync(workspace);
    realFile = fs.realpathSync(candidate);
  } catch {
    return null;
  }
  const rel = path.relative(realWorkspace, realFile);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  try {
    if (!fs.statSync(realFile).isFile()) return null;
  } catch {
    return null;
  }
  return realFile;
}

function pathKey(realFile) {
  return process.platform === "win32" ? realFile.toLowerCase() : realFile;
}

/** One task's dedup pass: group its deliverable rows by resolved real file, keep the EARLIEST row per
 * group (closest to the original emission), delete the rest. */
function dedupeTask(db, threadId, log = console.log) {
  const thread = db.prepare("SELECT id, workspace FROM threads WHERE id=?").get(threadId);
  if (!thread) throw new Error(`no task found with id ${threadId}`);
  const rows = db
    .prepare("SELECT id, path, created_at FROM findings WHERE thread_id=? AND kind='deliverable' AND path IS NOT NULL ORDER BY created_at ASC")
    .all(threadId);
  const groups = new Map();
  for (const row of rows) {
    const real = resolveDeliverablePath(thread.workspace, row.path);
    if (!real) continue;
    const key = pathKey(real);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const toDelete = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (const row of group.slice(1)) toDelete.push(row.id);
  }
  if (toDelete.length) {
    const del = db.prepare("DELETE FROM findings WHERE id=?");
    db.transaction(() => {
      for (const id of toDelete) del.run(id);
    })();
  }
  log(`${threadId.slice(0, 8)}: removed ${toDelete.length} duplicate deliverable card(s) across ${groups.size} distinct file(s), ${rows.length} row(s) inspected.`);
  return { removed: toDelete.length, distinctFiles: groups.size, inspected: rows.length };
}

function main(argv = process.argv.slice(2), { dbPath = DB_PATH, log = console.log, warn = console.error } = {}) {
  if (!fs.existsSync(dbPath)) {
    warn(`error: no database at ${dbPath}`);
    return 1;
  }
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 5000");
  try {
    const taskIds = argv[0]
      ? [argv[0]]
      : db.prepare("SELECT DISTINCT thread_id AS id FROM findings WHERE kind='deliverable'").all().map((r) => r.id);
    let totalRemoved = 0;
    for (const id of taskIds) {
      const result = dedupeTask(db, id, log);
      totalRemoved += result.removed;
    }
    log(`done: ${totalRemoved} duplicate deliverable card(s) removed across ${taskIds.length} task(s).`);
    return 0;
  } catch (error) {
    warn(`error: ${error.message}`);
    return 1;
  } finally {
    db.close();
  }
}

module.exports = { dedupeTask, resolveDeliverablePath, pathKey, main };

if (require.main === module) process.exit(main());
