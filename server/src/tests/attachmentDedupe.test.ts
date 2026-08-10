/**
 * Gate — attachment blobs are stored once and freed when nothing points at them (`Db`).
 *
 * Background: `attachments` is where the image bytes live (base64 TEXT), referenced by id from the
 * `attachments` JSON column of `messages` and `director_messages`. Two things made it the biggest table
 * in the DB — 183 MB of a 291.7 MB file when this shipped, 75 MB of that provably redundant:
 *   1. `addAttachment` was insert-only, so an image dropped into the director was stored TWICE — once for
 *      the director message, then again when the dispatch copied it onto the task's own message.
 *   2. Nothing ever DELETEd a row. `deleteThread` cascades messages via FK and `resetThreadForRetry`
 *      deletes them outright, but the blobs those messages referenced stayed behind forever.
 * The fix content-addresses inserts, prunes blobs that lose their last reference, and compacts the
 * history once via a kv-flagged migration.
 *
 * WHAT IS REAL: a real on-disk SQLite Db (throwaway temp dir). No agents, no network, no quota.
 *
 * Scenarios:
 *   A. DEDUPE    — identical bytes+name reuse the stored row; a different name keeps its own (the served
 *                  filename comes from the row, so sharing across names would rename someone's download).
 *   B. SHARING   — a blob referenced by two threads survives one of them being deleted, and the surviving
 *                  reference still resolves to the bytes.
 *   C. GC        — deleteThread and resetThreadForRetry free the blobs they held the LAST reference to.
 *   D. MIGRATION — a legacy DB (duplicate rows, refs spread over both tables, an orphan) is compacted on
 *                  open: refs rewritten to the survivor, redundant rows and the orphan gone, bytes intact.
 *                  Runs once — the flag stops it re-scanning every boot.
 *
 * Run:  npm run test:attachment-dedupe   (from server/)   — or:  npx tsx src/tests/attachmentDedupe.test.ts
 * Exits non-zero if any assertion fails. Self-contained: throwaway DB in a temp dir, removed on exit.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { Db } = await import("../db/db.js");
type DbType = InstanceType<typeof Db>;

// ---- tiny assertion harness ------------------------------------------------------------------------
let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    failures.push(label + (detail ? ` — ${detail}` : ""));
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const dir = mkdtempSync(join(tmpdir(), "gg-attach-"));
const dbPath = join(dir, "orchestrator.sqlite");
const PNG = "iVBORw0KGgoAAAANSUhEUg" + "A".repeat(512);
const OTHER = "R0lGODlhAQABAIAAAP" + "B".repeat(512);

function open(): DbType {
  return new Db(dbPath);
}
function countBlobs(db: DbType): number {
  return (db.raw.prepare("SELECT COUNT(*) c FROM attachments").get() as { c: number }).c;
}
function newThread(db: DbType, title: string): string {
  return db.createThread({ title, workspace: dir, rawPrompt: "p" }).id;
}
function attach(db: DbType, threadId: string, name: string, data: string): string {
  const ref = db.addAttachment({ name, mediaType: "image/png", data });
  db.addMessage({ threadId, role: "user", kind: "text", content: "see image", attachments: [ref] });
  return ref.id;
}

let db = open();

// ---- A. identical bytes are stored once ------------------------------------------------------------
console.log("\nA. dedupe on insert");
{
  const first = db.addAttachment({ name: "image.png", mediaType: "image/png", data: PNG });
  const again = db.addAttachment({ name: "image.png", mediaType: "image/png", data: PNG });
  check("same bytes + name reuse the stored row", again.id === first.id, `${first.id} vs ${again.id}`);
  check("only one blob row exists", countBlobs(db) === 1, `${countBlobs(db)} rows`);

  const renamed = db.addAttachment({ name: "screenshot.png", mediaType: "image/png", data: PNG });
  check("same bytes under a different name keep their own row", renamed.id !== first.id);
  check("…so the filename served back is the uploaded one", db.getAttachment(renamed.id)?.name === "screenshot.png");

  const different = db.addAttachment({ name: "image.png", mediaType: "image/png", data: OTHER });
  check("different bytes are never merged", different.id !== first.id);
  check("bytes survive the reuse", db.getAttachment(first.id)?.data === PNG);
  db.raw.prepare("DELETE FROM attachments").run();
}

// ---- B/C. a blob is freed only when its LAST reference goes ----------------------------------------
console.log("\nB. a shared blob outlives one of its holders");
{
  const keeper = newThread(db, "keeps the image");
  const doomed = newThread(db, "gets deleted");
  const shared = attach(db, keeper, "image.png", PNG);
  const alsoShared = attach(db, doomed, "image.png", PNG);
  const only = attach(db, doomed, "solo.png", OTHER);
  check("the two threads share one blob row", shared === alsoShared);
  check("two distinct blobs stored", countBlobs(db) === 2, `${countBlobs(db)} rows`);

  db.deleteThread(doomed);
  check("the shared blob survives — the other thread still holds it", db.getAttachment(shared)?.data === PNG);
  check("the blob only the deleted thread held is freed", db.getAttachment(only) === null);
  check("one blob row left", countBlobs(db) === 1, `${countBlobs(db)} rows`);

  db.deleteThread(keeper);
  check("the last holder going away frees it too", countBlobs(db) === 0, `${countBlobs(db)} rows`);
}

console.log("\nC. a retry wipe frees its blobs, and a director reference protects one");
{
  const t = newThread(db, "retried");
  const wiped = attach(db, t, "image.png", PNG);
  const held = db.addAttachment({ name: "held.png", mediaType: "image/png", data: OTHER });
  db.addMessage({ threadId: t, role: "user", kind: "text", content: "x", attachments: [held] });
  db.addDirectorMessage({ role: "user", kind: "text", content: "the original drop", attachments: [held] });

  db.resetThreadForRetry(t);
  check("a blob only the wiped feed referenced is freed", db.getAttachment(wiped) === null);
  check("a blob the director conversation still shows is kept", db.getAttachment(held.id)?.data === OTHER);
  db.raw.prepare("DELETE FROM attachments").run();
  db.raw.prepare("DELETE FROM director_messages").run();
}

// ---- D. the one-time compaction of an existing DB ---------------------------------------------------
console.log("\nD. legacy duplicates are compacted on open");
{
  const t = newThread(db, "legacy");
  // Reproduce the pre-fix shape by hand: addAttachment now dedupes, so the duplicate rows and the
  // NULL sha256 of a pre-migration DB can only be created through raw SQL.
  const legacy = (id: string, name: string, data: string, at: number): string => {
    db.raw
      .prepare("INSERT INTO attachments(id, name, media_type, data, sha256, created_at) VALUES(?,?,?,?,NULL,?)")
      .run(id, name, "image/png", data, at);
    return id;
  };
  const kept = legacy("blob-first", "image.png", PNG, 1000);
  const dupA = legacy("blob-dup-a", "image.png", PNG, 2000);
  const dupB = legacy("blob-dup-b", "image.png", PNG, 3000);
  const orphan = legacy("blob-orphan", "image.png", OTHER, 4000);
  // A DIFFERENT image that shares the duplicates' name and type. Every legacy row has a NULL hash, and
  // SQLite groups NULLs together — so a compaction that skipped the hash backfill would sweep this into
  // the same group and silently serve the wrong picture under a live reference.
  const distinct = legacy("blob-distinct", "image.png", OTHER + "tail", 5000);
  const ref = (id: string) => [{ id, name: "image.png", mediaType: "image/png" }];
  db.addDirectorMessage({ role: "user", kind: "text", content: "drop", attachments: ref(kept) });
  const msg = db.addMessage({ threadId: t, role: "user", kind: "text", content: "dispatch", attachments: ref(dupA) });
  db.addDirectorMessage({ role: "user", kind: "text", content: "again", attachments: ref(dupB) });
  db.addMessage({ threadId: t, role: "user", kind: "text", content: "other picture", attachments: ref(distinct) });
  check("legacy state built: 5 blob rows", countBlobs(db) === 5, `${countBlobs(db)} rows`);
  check("…referenced by id, not by content", db.listMessages(t)[0]?.attachments?.[0]?.id === dupA);

  // A DB that predates the fix has no compaction flag; clearing it makes the reopen replay the migration.
  db.raw.prepare("DELETE FROM kv WHERE key = 'attachment_dedupe_v1'").run();
  db.raw.close();
  db = open();

  check("the duplicate rows are gone", countBlobs(db) === 2, `${countBlobs(db)} rows`);
  check("the survivor is the original row", db.getAttachment(kept)?.data === PNG);
  check("the unreferenced orphan is gone", db.getAttachment(orphan) === null);
  check("a same-named picture with different bytes is NOT merged away", db.getAttachment(distinct)?.data === OTHER + "tail");
  const rewritten = db.listMessages(t).find((m) => m.id === msg.id)?.attachments?.[0]?.id;
  check("a feed reference to a dropped row was rewritten to the survivor", rewritten === kept, `got ${rewritten}`);
  const dirRefs = db.listDirectorMessages().flatMap((m) => m.attachments?.map((a) => a.id) ?? []);
  check("every director reference points at the survivor", dirRefs.every((id) => id === kept), dirRefs.join(","));
  check("no reference dangles", dirRefs.concat(rewritten ?? "").every((id) => !id || !!db.getAttachment(id)));
  check(
    "the surviving row carries its content hash, so new uploads dedupe against it",
    !!(db.raw.prepare("SELECT sha256 FROM attachments WHERE id = ?").get(kept) as { sha256: string | null }).sha256,
  );
  check(
    "an identical re-upload now reuses it",
    db.addAttachment({ name: "image.png", mediaType: "image/png", data: PNG }).id === kept,
  );

  // Idempotence: the flag must stop the scan re-running, and a second open must not disturb the result.
  check("the compaction is flagged done", db.kvGet("attachment_dedupe_v1") === "1");
  db.raw.close();
  db = open();
  check("reopening leaves the compacted state alone", countBlobs(db) === 2 && db.getAttachment(kept)?.data === PNG);
}

db.raw.close();
rmSync(dir, { recursive: true, force: true });

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed`);
if (failed) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
