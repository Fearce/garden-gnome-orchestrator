// Whose uncommitted files are these? Run: `npm run probe:tree-owner --prefix server`
//
// Every implementor, QA and reviewer the orchestrator spawns runs in THIS ONE checkout — there are no
// per-task worktrees — so `git status` is a mix of several agents' work in progress, and the two ways to
// read it wrong are both expensive. Commit a file you didn't write and you have absorbed a sibling's
// half-finished change into your commit (or handed their un-QA'd code to a deploy). Leave a file alone
// because it "looks like someone else's" and you strand your OWN work — which is exactly what happens
// after a restart kills a QA fix round mid-edit under `qaAppliesFixes`: its edits are sitting right
// there in the tree, indistinguishable from a stranger's, and on 2026-08-24 they were nearly abandoned.
//
// The tree itself cannot answer it, but the database can: a file's mtime falls inside some agent run's
// window, and that run belongs to a task with a title. This joins the two and prints the answer.
//
// Read-only (opens the live DB read-only, only ever runs `git status`), safe while prod is up.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const SERVER_DIR = path.resolve(__dirname, "..");
const REPO = path.resolve(SERVER_DIR, "..");
const DB_PATH = path.join(SERVER_DIR, "data", "orchestrator.sqlite");

/** Widen each run's window by this much: a file is written DURING a run, but a run's row is finalized by
 *  its own `onEnd`, which races the settle — so an edit can land a few seconds outside the recorded end. */
const SLACK_MS = 90_000;

function dirtyFiles() {
  const out = execFileSync("git", ["status", "--porcelain"], { cwd: REPO, encoding: "utf8" });
  return out
    .split("\n")
    .map((l) => l.trimEnd())
    .filter(Boolean)
    .map((line) => {
      let p = line.slice(3).trim();
      const arrow = p.indexOf(" -> ");
      if (arrow >= 0) p = p.slice(arrow + 4);
      if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
      return { status: line.slice(0, 2), path: p.replace(/\\/g, "/") };
    })
    .filter((f) => !f.path.endsWith("/"));
}

function mtimeOf(rel) {
  try {
    return fs.statSync(path.join(REPO, rel)).mtimeMs;
  } catch {
    return null; // a deletion — nothing on disk to date
  }
}

/** Runs that could have written into this checkout, newest first. */
function candidateRuns(db) {
  return db
    .prepare(
      `SELECT r.thread_id, r.role, r.started_at, r.ended_at, r.state, r.model, t.title, t.workspace, t.state AS thread_state
         FROM agent_runs r JOIN threads t ON t.id = r.thread_id
        WHERE r.started_at > ?
        ORDER BY r.started_at DESC`,
    )
    .all(Date.now() - 7 * 24 * 3600_000);
}

/** A workspace "covers" the repo when it IS the repo or an ancestor — a task's workspace is often the
 *  directory ABOVE the checkout, which is why a naive equality test attributes nothing to anybody. */
function coversRepo(workspace, repo = REPO) {
  if (!workspace) return false;
  const norm = (p) => path.resolve(p).toLowerCase().replace(/[\\/]+$/, "");
  const w = norm(workspace);
  const r = norm(repo);
  return r === w || r.startsWith(w + path.sep);
}

function officeNames(db) {
  try {
    const row = db.prepare("SELECT value FROM kv WHERE key = 'office_names'").get();
    return row && row.value ? JSON.parse(row.value) : {};
  } catch {
    return {};
  }
}

/** Runs whose window contains `at`. An unfinished run (`ended_at` null) is open to now — that is the
 *  live agent beside you, and the case the answer usually turns on. */
function whoWrote(runs, at, now = Date.now()) {
  return runs.filter((r) => at >= r.started_at - SLACK_MS && at <= (r.ended_at ?? now) + SLACK_MS);
}

function label(run, names) {
  const who = names[`${run.thread_id}::${run.role}`];
  const live = run.ended_at ? "" : " ← STILL RUNNING";
  return `${who ? who + " " : ""}(${run.role}) “${run.title.slice(0, 52)}” ${run.thread_id.slice(0, 8)}${live}`;
}

function main() {
  const files = dirtyFiles();
  if (!files.length) {
    console.log("working tree is clean — nothing to attribute.");
    return;
  }
  let Database;
  try {
    Database = require(path.join(SERVER_DIR, "node_modules", "better-sqlite3"));
  } catch {
    console.log(`cannot open ${DB_PATH} (better-sqlite3 missing — run: npm install --prefix server)`);
    return;
  }
  const db = new Database(DB_PATH, { readonly: true });
  const runs = candidateRuns(db).filter((r) => coversRepo(r.workspace));
  const names = officeNames(db);
  db.close();

  const byTask = new Map();
  const unexplained = [];
  for (const f of files) {
    const at = mtimeOf(f.path);
    const hits = at === null ? [] : whoWrote(runs, at);
    if (!hits.length) {
      unexplained.push({ ...f, at });
      continue;
    }
    // Newest overlapping run first — with several agents live, the one that started last is the one
    // whose kickoff most likely claimed this area, and every candidate is printed anyway.
    for (const run of hits.slice(0, 3)) {
      const key = `${run.thread_id}::${run.role}`;
      if (!byTask.has(key)) byTask.set(key, { run, files: [] });
      byTask.get(key).files.push({ ...f, shared: hits.length > 1 });
    }
  }

  console.log(`\n${files.length} uncommitted path(s), against ${runs.length} agent run(s) in this workspace over 7 days\n`);
  for (const { run, files: owned } of [...byTask.values()].sort((a, b) => b.run.started_at - a.run.started_at)) {
    console.log(label(run, names));
    for (const f of owned) console.log(`   ${f.status} ${f.path}${f.shared ? "   (also matches another run — read the diff)" : ""}`);
    console.log("");
  }
  if (unexplained.length) {
    console.log("no agent run covers these — an earlier session of yours, a human edit, or a build artifact:");
    for (const f of unexplained) console.log(`   ${f.status} ${f.path}`);
    console.log("");
  }
  console.log("A match is evidence, not proof: two agents editing one file both match it. Confirm with the diff,");
  console.log("and claim your area in the office chat before editing. Stage with a pathspec, never `git add -A`.");
}

module.exports = { coversRepo, whoWrote, SLACK_MS };

if (require.main === module) main();
