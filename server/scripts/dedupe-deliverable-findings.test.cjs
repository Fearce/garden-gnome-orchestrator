#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { main, dedupeTask } = require("./dedupe-deliverable-findings.cjs");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dedupe-deliverables-"));
const workspace = path.join(dir, "workspace");
fs.mkdirSync(workspace);
const overview = path.join(workspace, "overview.png");
const fogged = path.join(workspace, "fogged.png");
const ghost = path.join(workspace, "never-written.png");
fs.writeFileSync(overview, Buffer.from([137, 80, 78, 71]));
fs.writeFileSync(fogged, Buffer.from([137, 80, 78, 71]));

const dbPath = path.join(dir, "orchestrator.sqlite");
const db = new Database(dbPath);
db.exec(
  "CREATE TABLE threads (id TEXT PRIMARY KEY, workspace TEXT NOT NULL); CREATE TABLE findings (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, from_run_id TEXT, from_role TEXT, kind TEXT NOT NULL, summary TEXT NOT NULL, detail TEXT, path TEXT, label TEXT, severity TEXT NOT NULL, routed INTEGER NOT NULL, created_at INTEGER NOT NULL);",
);
db.prepare("INSERT INTO threads(id, workspace) VALUES (?, ?)").run("task-1", workspace);

const insert = db.prepare(
  "INSERT INTO findings(id,thread_id,kind,summary,path,label,severity,routed,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
);
// Three rows for the SAME real file (two restore-script style forward-slash inserts plus a later
// backslash-path direct re-post), one row for a genuinely different file, and one row whose path was
// never written -- exactly the shape the skill-tree prototype task ended up with.
insert.run("original", "task-1", "deliverable", "Overview", overview, "Overview", "info", 0, 1000);
insert.run("restore-1", "task-1", "deliverable", "HQ tree overview", overview.split(path.sep).join("/"), "HQ tree overview", "info", 0, 2000);
insert.run("repost-1", "task-1", "deliverable", "HQ tree overview (redone)", overview, "HQ tree overview (redone)", "info", 0, 3000);
insert.run("fogged", "task-1", "deliverable", "Fogged", fogged, "Fogged", "info", 0, 4000);
insert.run("ghost", "task-1", "deliverable", "Ghost", ghost, "Ghost", "info", 0, 5000);
db.close();

const logs = [];
assert.equal(main(["task-1"], { dbPath, log: (l) => logs.push(l), warn: () => {} }), 0);
assert.match(logs[0], /removed 2 duplicate deliverable card\(s\)/, "two of the three overview rows are removed");

let verify = new Database(dbPath, { readonly: true });
let rows = verify.prepare("SELECT id FROM findings ORDER BY created_at ASC").all().map((r) => r.id);
assert.deepEqual(rows, ["original", "fogged", "ghost"], "keeps the EARLIEST row per real file, the different file, and the unresolvable ghost");
verify.close();

// Idempotent: a second pass over an already-clean task removes nothing.
const rerunLogs = [];
assert.equal(main(["task-1"], { dbPath, log: (l) => rerunLogs.push(l), warn: () => {} }), 0);
assert.match(rerunLogs[0], /removed 0 duplicate deliverable card\(s\)/, "rerun on a clean task is a no-op");
verify = new Database(dbPath, { readonly: true });
assert.equal(verify.prepare("SELECT COUNT(*) AS n FROM findings").get().n, 3, "no rows lost on rerun");
verify.close();

// dedupeTask direct call, and an unknown task id fails loudly instead of silently doing nothing.
// Named, so it can be closed: an inline handle here stays open for the rest of the process, and on
// Windows that makes the final rmSync throw EBUSY on the sqlite file — which killed this gate before it
// could print its own success line, taking every assertion below it with it.
const unknownTaskDb = new Database(dbPath, { readonly: true });
try {
  assert.throws(() => dedupeTask(unknownTaskDb, "does-not-exist"), /no task found/);
} finally {
  unknownTaskDb.close();
}

// A duplicate that escapes the workspace is never grouped with the safe rows (each is resolved with
// the same containment check the serving route uses; an escape resolves to null and is left alone).
const db2 = new Database(dbPath);
const outside = path.join(dir, "outside.png");
fs.writeFileSync(outside, "must never be admitted");
db2.prepare(
  "INSERT INTO findings(id,thread_id,kind,summary,path,label,severity,routed,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
).run("escaped", "task-1", "deliverable", "Escaped", outside, "Escaped", "info", 0, 6000);
db2.close();
assert.equal(main(["task-1"], { dbPath, log: () => {}, warn: () => {} }), 0);
verify = new Database(dbPath, { readonly: true });
assert.equal(verify.prepare("SELECT COUNT(*) AS n FROM findings WHERE id='escaped'").get().n, 1, "an escaped path is never deleted as a false-positive duplicate");
verify.close();

fs.rmSync(dir, { recursive: true, force: true });
console.log("dedupe-deliverable-findings: groups by resolved real file, keeps the earliest card, leaves unresolvable/escaped rows untouched, idempotent on rerun");
