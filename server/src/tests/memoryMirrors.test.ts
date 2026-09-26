/**
 * Gate — the in-memory thread listing and kv mirrors answer exactly what SQLite would, and stop
 * re-reading the table when nothing changed.
 *
 * Run: npm run test:memory-mirrors (from server/)
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Db } from "../db/db.js";
import type { ManualDeployment } from "../types.js";

const dir = mkdtempSync(join(tmpdir(), "gg-memory-mirrors-"));
const path = join(dir, "orchestrator.sqlite");
const db = new Db(path);
let other: Database.Database | undefined;

/** Inside a transaction the mirrors step aside, so this is SQLite's own answer. */
const fromSqlite = <T>(read: () => T): T => db.raw.transaction(read)();

function assertMirrorsMatchSqlite(label: string): void {
  assert.deepEqual(db.listThreads(), fromSqlite(() => db.listThreads()), `${label}: listThreads`);
  assert.deepEqual(db.listThreadSummaries(), fromSqlite(() => db.listThreadSummaries()), `${label}: listThreadSummaries`);
  assert.deepEqual(
    db.listThreadsByStates(["review", "queued"]),
    fromSqlite(() => db.listThreadsByStates(["review", "queued"])),
    `${label}: listThreadsByStates`,
  );
}

/** Counts listing reads of `threads` (not `getThread`'s `SELECT *`), by wrapping prepare on this connection. */
function countThreadReads(action: () => void): { full: number; single: number } {
  const counts = { full: 0, single: 0 };
  const original = db.raw.prepare.bind(db.raw);
  db.raw.prepare = ((sql: string) => {
    if (/^SELECT (?!\*)[\s\S]*FROM threads\b/.test(sql)) {
      if (/WHERE id = \?/.test(sql)) counts.single++;
      else counts.full++;
    }
    return original(sql);
  }) as typeof db.raw.prepare;
  try {
    action();
  } finally {
    db.raw.prepare = original;
  }
  return counts;
}

try {
  const a = db.createThread({ title: "A", workspace: dir, rawPrompt: "raw a", brief: "brief a\nsecond line" });
  const b = db.createThread({ title: "B", workspace: dir, rawPrompt: "raw b", brief: "brief b" });
  // Same millisecond as `b`: ties must come back newest-insert first, exactly like the SQL.
  db.raw.prepare("UPDATE threads SET created_at = ? WHERE id = ?").run(b.createdAt, a.id);
  assertMirrorsMatchSqlite("after create");

  const quiet = countThreadReads(() => {
    db.listThreads();
    db.listThreadSummaries();
    db.listThreadsByStates(["review"]);
  });
  assert.deepEqual(quiet, { full: 0, single: 0 }, "an unchanged table is served from memory");

  const oneWrite = countThreadReads(() => {
    db.updateThread(a.id, { state: "review", error: "parked" });
    db.listThreads();
    db.listThreadSummaries();
  });
  assert.deepEqual(oneWrite, { full: 0, single: 1 }, "one changed task costs one single-row read");
  assertMirrorsMatchSqlite("after updateThread");

  db.raw.prepare("UPDATE threads SET title = 'raw title' WHERE id = ?").run(b.id);
  assert.equal(db.listThreads().find((t) => t.id === b.id)?.title, "raw title", "a raw UPDATE is seen");

  db.addMessage({ threadId: b.id, role: "implementor", kind: "text", content: "newest words" });
  assert.equal(
    db.listThreadSummaries().find((t) => t.id === b.id)?.latestMessagePreview,
    "newest words",
    "the messages trigger's write to threads reaches the mirror",
  );

  const manualDeployment: ManualDeployment = {
    kind: "manual_deployment",
    version: 1,
    status: "declared",
    declaredBy: "implementor",
    declaredRunId: "run-1",
    declaredAt: 1,
    claim: {
      version: 1,
      commitSha: "a".repeat(40),
      remoteRef: "origin/master",
      environment: "prod",
      instructions: "deploy it",
      verification: [{ command: "npm test", outcome: "passed" }],
      assertions: {
        implementationCommitted: true,
        requiredVerificationPassed: true,
        noUncommittedChanges: true,
        noMergeOrDivergence: true,
        credentialsAndDataReady: true,
        noOwnerDecisionRequired: true,
        noAdditionalBlockers: true,
        postDeployVerificationRequired: false,
      },
    },
  };
  db.updateThreadStageOutputs(a.id, { manualDeployment });
  assert.equal(db.listThreads().find((t) => t.id === a.id)?.manualDeployment?.environment, "prod", "a stage_outputs write is seen");
  assertMirrorsMatchSqlite("after a stage_outputs write");

  const leaked = db.listThreads()[0]!;
  leaked.title = "mutated by a caller";
  assert.notEqual(db.listThreads()[0]!.title, "mutated by a caller", "a caller's mutation never reaches the mirror");
  const shared = db.listThreads().find((t) => t.id === a.id)!.manualDeployment!;
  assert.throws(() => {
    (shared as { environment: string }).environment = "edited";
  }, TypeError, "a shared nested object refuses edits instead of changing every later listing");

  assert.throws(
    () =>
      db.raw.transaction(() => {
        const ghost = db.createThread({ title: "rolled back", workspace: dir, rawPrompt: "", brief: "" });
        assert.ok(db.listThreads().some((t) => t.id === ghost.id), "inside the transaction the new row is visible");
        throw new Error("roll back");
      })(),
    /roll back/,
  );
  assert.equal(db.listThreads().some((t) => t.title === "rolled back"), false, "a rolled-back insert never reaches the mirror");
  assertMirrorsMatchSqlite("after a rollback");

  assert.equal(db.kvGet("shared"), null, "the miss is now remembered");
  other = new Database(path);
  other.prepare("UPDATE threads SET title = 'other connection' WHERE id = ?").run(a.id);
  other.prepare("INSERT INTO kv(key, value) VALUES('shared', 'from other') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  assert.equal(db.listThreads().find((t) => t.id === a.id)?.title, "other connection", "another connection's commit is seen");
  assert.equal(db.kvGet("shared"), "from other", "another connection's kv commit is seen");
  assertMirrorsMatchSqlite("after a foreign commit");

  db.deleteThread(b.id);
  assert.equal(db.listThreads().some((t) => t.id === b.id), false, "a deleted task leaves the listing");
  assertMirrorsMatchSqlite("after delete");

  assert.equal(db.kvGet("missing"), null, "a missing key reads null");
  db.kvSet("missing", "now present");
  assert.equal(db.kvGet("missing"), "now present", "a remembered miss is forgotten on insert");
  db.raw.prepare("UPDATE kv SET value = 'raw' WHERE key = 'missing'").run();
  assert.equal(db.kvGet("missing"), "raw", "a raw kv UPDATE is seen");
  assert.throws(
    () =>
      db.raw.transaction(() => {
        db.kvSet("missing", "uncommitted");
        assert.equal(db.kvGet("missing"), "uncommitted", "inside the transaction the new value is visible");
        throw new Error("roll back");
      })(),
    /roll back/,
  );
  assert.equal(db.kvGet("missing"), "raw", "a rolled-back kv write never reaches the mirror");
  db.kvDelete("missing");
  assert.equal(db.kvGet("missing"), null, "a kv delete is seen");

  console.log("memory mirrors: all checks passed");
} finally {
  other?.close();
  db.raw.close();
  rmSync(dir, { recursive: true, force: true });
}
