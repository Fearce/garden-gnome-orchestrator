#!/usr/bin/env node
// Gate for scripts/archive-thread.cjs: the snapshot that has to be right BEFORE a Retry deletes the
// original. Drives the real command end to end against a scratch database, because the two failures
// that matter are both in main() rather than in the renderer: silently overwriting the previous archive
// (which is the only copy of what the last retry deleted) and picking the wrong set of tasks.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");

const {
  cancelledThreads,
  collect,
  deliverableLine,
  fence,
  main,
  parseArgs,
  renderDocument,
  renderThread,
  resolveThread,
} = require("./archive-thread.cjs");

// ---------------------------------------------------------------- argument parsing

assert.deepEqual(parseArgs(["4f42e722", "26dc15e4", "--force"]), {
  targets: ["4f42e722", "26dc15e4"],
  cancelled: false,
  force: true,
  out: null,
});
assert.deepEqual(parseArgs(["--cancelled", "--out", "x.md"]), { targets: [], cancelled: true, force: false, out: "x.md" });
assert.throws(() => parseArgs([]), /name at least one task/);
assert.throws(() => parseArgs(["--cancelled", "4f42e722"]), /takes no task arguments/);
assert.throws(() => parseArgs(["--out"]), /--out requires a path/);
assert.throws(() => parseArgs(["--wat"]), /unknown argument/);

// ---------------------------------------------------------------- renderer units

// A finding routinely quotes a fenced block; the archive must not be cut in half by it.
const quoted = "before\n```\ninner fence\n```\nafter";
assert.match(fence(quoted), /^````\n/, "a body containing ``` is wrapped in a longer fence");
assert.ok(fence(quoted).includes(quoted), "the quoted fence survives verbatim");
assert.match(fence("plain"), /^```\nplain\n```$/);

const at = Date.UTC(2026, 8, 14, 16, 42, 0);
assert.match(deliverableLine({ label: "Overview capture", path: "C:/gone.png", created_at: at }, false), /MISSING on disk/);
assert.doesNotMatch(deliverableLine({ label: "Overview capture", path: "C:/here.png", created_at: at }, true), /MISSING/);
assert.match(deliverableLine({ summary: "no path row", path: null, created_at: at }, false), /NO PATH/);

// ---------------------------------------------------------------- scratch database

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archive-thread-"));
const dbPath = path.join(dir, "orchestrator.sqlite");
const db = new Database(dbPath);
db.exec(`
  CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT NOT NULL, state TEXT NOT NULL, workspace TEXT NOT NULL,
    brief TEXT NOT NULL DEFAULT '', raw_prompt TEXT NOT NULL DEFAULT '', error TEXT, stage_outputs TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, closed_at INTEGER, model_request TEXT);
  CREATE TABLE findings (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, from_run_id TEXT, from_role TEXT,
    summary TEXT NOT NULL, detail TEXT, severity TEXT NOT NULL DEFAULT 'note', routed INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT 'finding', path TEXT, label TEXT);
  CREATE TABLE agent_runs (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, role TEXT NOT NULL, model TEXT NOT NULL,
    state TEXT NOT NULL, error TEXT, started_at INTEGER NOT NULL, ended_at INTEGER);
  CREATE TABLE messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, run_id TEXT, role TEXT NOT NULL,
    kind TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL);
`);

const CUT = "Ball elements polish + plain ball conversion";
const DETAIL =
  "AMENDMENT to the binding ball-conversion rules: Escort sits INSIDE the conversion subtraction, and Escort " +
  "is granted on TREE ownership only, so a conversion can never change swarm size. " +
  "x".repeat(400); // long enough that any accidental truncation shows up

const thread = {
  id: "8fe5c1bf-d37b-473d-81cf-74725c7306f0",
  title: CUT,
  state: "cancelled",
  workspace: "C:\\Users\\Mikkel\\projects",
  brief: "Tilebreaker ball polish round.\n\n```\nfenced brief\n```",
  stage_outputs: JSON.stringify({ standingDirectives: ["keep it on master", "no visible windows"] }),
  created_at: at - 90_000,
  updated_at: at,
};
db.prepare(
  "INSERT INTO threads (id,title,state,workspace,brief,stage_outputs,created_at,updated_at) VALUES (@id,@title,@state,@workspace,@brief,@stage_outputs,@created_at,@updated_at)",
).run(thread);
db.prepare(
  "INSERT INTO threads (id,title,state,workspace,brief,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
).run("5656462e-2f79-4b98-b488-1e063663302a", "Skill tree layout redesign prototype", "cancelled", "C:\\ws", "", at - 200_000, at - 100_000);
db.prepare(
  "INSERT INTO threads (id,title,state,workspace,brief,created_at,updated_at,closed_at) VALUES (?,?,?,?,?,?,?,?)",
).run("aaaaaaaa-0000-4000-8000-000000000000", "Closed cancelled task", "cancelled", "C:\\ws", "", at, at, at + 1);
db.prepare(
  "INSERT INTO threads (id,title,state,workspace,brief,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
).run("bbbbbbbb-0000-4000-8000-000000000000", "A finished one", "done", "C:\\ws", "", at, at);

const finding = db.prepare(
  "INSERT INTO findings (id,thread_id,from_role,summary,detail,severity,created_at,kind,path,label) VALUES (?,?,?,?,?,?,?,?,?,?)",
);
finding.run("f1", thread.id, "implementor", "FINAL ball-conversion rules", DETAIL, "warning", at - 60_000, "finding", null, null);
finding.run("f2", thread.id, "qa", "Evidence rule: docs/feedback is regenerated by gate 6", "pin a copy instead", "note", at - 30_000, "finding", null, null);
finding.run("d1", thread.id, "implementor", "capture", null, "info", at - 20_000, "deliverable", __filename, "Ice branch capture");
finding.run("d2", thread.id, "implementor", "capture", null, "info", at - 10_000, "deliverable", path.join(dir, "gone.png"), "Overview capture");

const run = db.prepare("INSERT INTO agent_runs (id,thread_id,role,model,state,error,started_at,ended_at) VALUES (?,?,?,?,?,?,?,?)");
run.run("r1", thread.id, "implementor", "claude-opus-5-5", "error", "You've hit your session limit", at - 80_000, at - 70_000);
run.run("r2", thread.id, "implementor", "claude-opus-5-5", "interrupted", null, at - 60_000, at);

const msg = db.prepare("INSERT INTO messages (id,thread_id,role,kind,content,created_at) VALUES (?,?,?,?,?,?)");
msg.run("m1", thread.id, "implementor", "text", "first", at - 50_000);
msg.run("m2", thread.id, "implementor", "tool", "middle", at - 40_000);
msg.run("m3", thread.id, "implementor", "text", "the last thing it said", at - 5_000);

// ---------------------------------------------------------------- lookup + collect

assert.equal(resolveThread(db, thread.id).title, CUT, "exact id");
assert.equal(resolveThread(db, "8fe5c1bf").title, CUT, "the 8-char short id the board shows");
assert.equal(resolveThread(db, "plain ball").title, CUT, "title substring");
assert.equal(resolveThread(db, "no-such-task"), null, "a miss returns null instead of throwing");

assert.deepEqual(
  cancelledThreads(db).map((t) => t.id.slice(0, 8)),
  ["5656462e", "8fe5c1bf"],
  "open cancelled tasks only, oldest first (the closed one is out of the way, the done one isn't cancelled)",
);

const record = collect(db, resolveThread(db, "8fe5c1bf"));
assert.equal(record.notes.length, 2, "deliverable rows are not counted as findings");
assert.equal(record.deliverables.length, 2);
assert.equal(record.runs.length, 2);
assert.equal(record.messageCount, 3);
assert.equal(record.lastMessage.content, "the last thing it said", "the newest feed entry, not the oldest");

// ---------------------------------------------------------------- rendering

const markdown = renderThread(record);
assert.ok(markdown.includes(DETAIL), "a finding's full detail is preserved verbatim, never summarised");
assert.match(markdown, /standing owner directives\*\*: 2 \(preserved by Retry/);
assert.match(markdown, /Ice branch capture\*\* : `[^`]+archive-thread\.test\.cjs`[^\n]*$/m);
assert.doesNotMatch(markdown.split("Ice branch capture")[1].split("\n")[0], /MISSING/, "a file still on disk is not flagged");
assert.match(markdown, /Overview capture[^\n]*MISSING on disk/, "a deliverable whose file is gone is flagged");
assert.match(markdown, /\*\*implementor\*\* \| error \| claude-opus-5-5 \| 10s : You've hit your session limit/);
assert.match(markdown, /Feed \(3 entries, last one below\)/);
assert.ok(markdown.includes("fenced brief"), "the brief survives even though it contains its own fence");

const doc = renderDocument([record], new Date(at));
assert.match(doc, /^# Task archive 2026-09-14/);
assert.match(doc, /Snapshot of 1 task\(s\)/);

// ---------------------------------------------------------------- the command itself

const quiet = { dbPath, log: () => {}, warn: () => {} };
const out = path.join(dir, "archive.md");

assert.equal(main(["--wat"], quiet), 2, "a bad argument exits 2 without touching the database");
assert.equal(main(["no-such-task"], quiet), 1, "an unmatched target exits 1");
assert.equal(fs.existsSync(out), false);

assert.equal(main(["8fe5c1bf", "--out", out], quiet), 0);
const first = fs.readFileSync(out, "utf8");
assert.ok(first.includes(DETAIL));

assert.equal(main(["8fe5c1bf", "--out", out], quiet), 1, "refuses to overwrite: the existing file may be the only copy");
assert.equal(fs.readFileSync(out, "utf8"), first, "and leaves it byte-identical");

assert.equal(main(["8fe5c1bf", "--out", out, "--force"], quiet), 0, "--force is the explicit way through");

const both = path.join(dir, "both.md");
assert.equal(main(["--cancelled", "--out", both], quiet), 0);
const sweep = fs.readFileSync(both, "utf8");
assert.ok(sweep.includes("Skill tree layout redesign prototype") && sweep.includes(CUT), "--cancelled takes every open cancelled task");
assert.ok(!sweep.includes("A finished one") && !sweep.includes("Closed cancelled task"), "and nothing else");

const deduped = path.join(dir, "deduped.md");
assert.equal(main(["8fe5c1bf", thread.id, "--out", deduped], quiet), 0);
assert.equal(fs.readFileSync(deduped, "utf8").split("- **id**:").length - 1, 1, "the same task named twice is archived once");

db.close();
fs.rmSync(dir, { recursive: true, force: true });

console.log("archive-thread: parsing, lookup, full-detail rendering, missing-deliverable flagging and the overwrite guard verified");
