/**
 * Gate — a stage kickoff finds a task's attachments without reading its whole feed.
 *
 * `message_attachment_index` holds the few messages that carry attachments. Its triggers keep it from the
 * first boot, a chunked walk adds the rows written before it, and until that walk finishes readers fall back
 * to the feed. Every answer must equal the feed's own, in feed order, through inserts, rewrites and deletes.
 *
 * Run: npm run test:attachment-index   (from server/)
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../db/db.js";
import { ATTACHMENT_INDEX_CURSOR_KEY, ATTACHMENT_INDEX_READY_KEY, startAttachmentIndexBackfill } from "../db/attachmentIndex.js";
import type { AttachmentRef } from "../types.js";

const dir = mkdtempSync(join(tmpdir(), "gg-attachment-index-"));
const db = new Db(join(dir, "orchestrator.sqlite"));

const ref = (id: string): AttachmentRef => ({ id, name: `${id}.png`, mediaType: "image/png" });

/** The answer straight from the feed, which the index must always match. */
function fromFeed(threadId: string, since: number): AttachmentRef[] {
  return db.listMessages(threadId).filter((m) => m.createdAt >= since).flatMap((m) => m.attachments ?? []);
}

function indexedRows(): number {
  return db.raw.prepare("SELECT COUNT(*) FROM message_attachment_index").pluck().get() as number;
}

try {
  const task = db.createThread({ title: "Pictures", workspace: dir, rawPrompt: "with pictures" });
  const other = db.createThread({ title: "Other", workspace: dir, rawPrompt: "other" });

  // Rows written before the table existed: drop the triggers' work to stand in for an older database.
  db.addMessage({ threadId: task.id, role: "director", kind: "system", content: "brief", attachments: [ref("a"), ref("b")] });
  for (let i = 0; i < 30; i++) db.addMessage({ threadId: task.id, role: "implementor", kind: "text", content: `line ${i}` });
  db.addMessage({ threadId: other.id, role: "director", kind: "system", content: "elsewhere", attachments: [ref("x")] });
  db.raw.exec("DELETE FROM message_attachment_index");
  db.raw.prepare("DELETE FROM kv WHERE key IN (?, ?)").run(ATTACHMENT_INDEX_CURSOR_KEY, ATTACHMENT_INDEX_READY_KEY);

  assert.equal(db.attachmentIndexReady(), false);
  assert.deepEqual(db.attachmentRefsSince(task.id, 0), fromFeed(task.id, 0), "before the walk, the feed answers");

  // Written while the walk runs: the trigger indexes it, and the walk passing over it changes nothing.
  db.addMessage({ threadId: task.id, role: "director", kind: "system", content: "injected", attachments: [ref("c")] });
  assert.equal(indexedRows(), 1, "an insert is indexed by its trigger from the first boot");

  await startAttachmentIndexBackfill(db, () => {}, 7, 0).done;
  assert.equal(db.attachmentIndexReady(), true, "the walk marks the index ready");
  assert.equal(indexedRows(), 3, "the walk adds every older row once");

  const plan = (db.raw.prepare("EXPLAIN QUERY PLAN SELECT attachments FROM message_attachment_index WHERE thread_id = ? AND created_at >= ? ORDER BY created_at ASC, message_rowid ASC").all(task.id, 0) as { detail: string }[]).map((row) => row.detail).join(" | ");
  assert.match(plan, /USING (COVERING )?INDEX idx_message_attachment_index_thread/, "the ready read is an index seek");
  assert.doesNotMatch(plan, /TEMP B-TREE/, "the ready read needs no sort");

  const expected = fromFeed(task.id, 0);
  assert.deepEqual(expected, [ref("a"), ref("b"), ref("c")]);
  const prepare = db.raw.prepare.bind(db.raw);
  const statements: string[] = [];
  db.raw.prepare = ((sql: string) => {
    statements.push(sql);
    return prepare(sql);
  }) as typeof db.raw.prepare;
  let answer: AttachmentRef[];
  try {
    answer = db.attachmentRefsSince(task.id, 0);
  } finally {
    db.raw.prepare = prepare;
  }
  assert.deepEqual(answer, expected, "the index answers what the feed would, in feed order");
  assert.ok(!statements.some((sql) => /FROM messages\b/.test(sql)), "once ready, the read never touches the feed");
  assert.deepEqual(db.attachmentRefsSince(other.id, 0), [ref("x")], "another task's pictures stay its own");

  const cutoff = db.listMessages(task.id).find((m) => m.content === "injected")!.createdAt;
  assert.deepEqual(db.attachmentRefsSince(task.id, cutoff), fromFeed(task.id, cutoff), "a since-bound keeps only later messages");

  const brief = db.listMessages(task.id).find((m) => m.content === "brief")!;
  db.raw.prepare("UPDATE messages SET attachments = replace(attachments, ?, ?) WHERE id = ?").run('"id":"a"', '"id":"a2"', brief.id);
  assert.deepEqual(db.attachmentRefsSince(task.id, 0).map((r) => r.id), ["a2", "b", "c"], "a rewritten reference is re-indexed");
  db.raw.prepare("UPDATE messages SET attachments = '[]' WHERE id = ?").run(brief.id);
  assert.deepEqual(db.attachmentRefsSince(task.id, 0), fromFeed(task.id, 0), "a cleared reference leaves the index");

  db.raw.prepare("DELETE FROM messages WHERE thread_id = ? AND content = 'injected'").run(task.id);
  assert.deepEqual(db.attachmentRefsSince(task.id, 0), [], "a deleted message leaves the index");
  db.deleteThread(other.id);
  assert.equal(indexedRows(), 0, "deleting a task leaves nothing indexed");

  console.log("attachment index: all checks passed");
} finally {
  db.raw.close();
  rmSync(dir, { recursive: true, force: true });
}
