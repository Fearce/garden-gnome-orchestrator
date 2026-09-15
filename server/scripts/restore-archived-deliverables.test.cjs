#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { main, parseArgs, parseDeliverables } = require("./restore-archived-deliverables.cjs");

assert.deepEqual(parseArgs(["task-1", "--archive", "snapshot.md"]), { taskId: "task-1", archive: "snapshot.md" });
assert.throws(() => parseArgs(["task-1"]), /required/);
assert.throws(() => parseArgs(["task-1", "--archive"]), /requires a file/);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-deliverables-"));
const workspace = path.join(dir, "workspace");
const outside = path.join(dir, "outside.png");
fs.mkdirSync(workspace);
const report = path.join(workspace, "report.md");
const shot = path.join(workspace, "overview.png");
fs.writeFileSync(report, "# restored report\n");
fs.writeFileSync(shot, Buffer.from([137, 80, 78, 71]));
fs.writeFileSync(outside, "must never be admitted");

const dbPath = path.join(dir, "orchestrator.sqlite");
const db = new Database(dbPath);
db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, workspace TEXT NOT NULL); CREATE TABLE findings (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, from_run_id TEXT, from_role TEXT, kind TEXT NOT NULL, summary TEXT NOT NULL, detail TEXT, path TEXT, label TEXT, severity TEXT NOT NULL, routed INTEGER NOT NULL, created_at INTEGER NOT NULL);");
db.prepare("INSERT INTO threads(id, workspace) VALUES (?, ?)").run("task-1", workspace);
db.prepare("INSERT INTO findings(id,thread_id,kind,summary,path,label,severity,routed,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
  .run("existing-report", "task-1", "deliverable", "Newer rationale label", report, "Newer rationale label", "info", 0, Date.now());
db.close();

const archive = path.join(dir, "archive.md");
const body = `# archive\n\n## Prototype\n\n- **id**: \`task-1\`\n\n### Deliverables (2)\n\n- **Design rationale** : \`${report}\` (2026-09-13 18:43:38 UTC)\n- **Overview** : \`${shot}\` (2026-09-13 18:43:44 UTC)\n\n### Run trail (0)\n`;
fs.writeFileSync(archive, body);
assert.equal(parseDeliverables(body, "task-1").length, 2, "parses only the named task's structured block");
const logs = [];
assert.equal(main(["task-1", "--archive", archive], { dbPath, log: (line) => logs.push(line), warn: () => {} }), 0);
assert.match(logs[0], /restored 1 deliverable card\(s\), 1 already present/, "same file under a newer label is not duplicated");
let verify = new Database(dbPath, { readonly: true });
assert.deepEqual(verify.prepare("SELECT label, path FROM findings ORDER BY created_at").all(), [
  { label: "Overview", path: shot },
  { label: "Newer rationale label", path: report },
]);
verify.close();
assert.equal(main(["task-1", "--archive", archive], { dbPath, log: () => {}, warn: () => {} }), 0, "rerun is idempotent");
verify = new Database(dbPath, { readonly: true });
assert.equal(verify.prepare("SELECT COUNT(*) AS n FROM findings").get().n, 2, "idempotent rerun inserts no duplicate cards");
verify.close();

const hostile = path.join(dir, "hostile.md");
fs.writeFileSync(hostile, `## Prototype\n\n- **id**: \`task-1\`\n\n### Deliverables (1)\n\n- **Escaped** : \`${outside}\` (2026-09-13 18:43:44 UTC)\n\n### Run trail (0)\n`);
assert.equal(main(["task-1", "--archive", hostile], { dbPath, log: () => {}, warn: () => {} }), 1, "an escaped archived path is rejected");
verify = new Database(dbPath, { readonly: true });
assert.equal(verify.prepare("SELECT COUNT(*) AS n FROM findings").get().n, 2, "a rejected archive makes no partial write");
verify.close();

fs.rmSync(dir, { recursive: true, force: true });
console.log("restore-archived-deliverables: validates every archived path, restores owner cards idempotently, and rejects escapes atomically");
