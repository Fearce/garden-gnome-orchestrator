/**
 * Gate — the board stays bounded at a large task count and long task feeds load by page.
 *
 * Run: npm run test:performance-paths (from server/)
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../db/db.js";

const dir = mkdtempSync(join(tmpdir(), "gg-performance-paths-"));
const db = new Db(join(dir, "orchestrator.sqlite"));

try {
  const thread = db.createThread({
    title: "A deliberately long task",
    workspace: dir,
    rawPrompt: "owner context ".repeat(300),
    brief: "enriched brief ".repeat(500),
  });

  const full = db.listThreads().find((item) => item.id === thread.id);
  assert.equal(full?.rawPrompt, "owner context ".repeat(300), "internal full-thread reads retain the raw prompt");
  assert.equal(full?.brief, "enriched brief ".repeat(500), "internal full-thread reads retain the enriched brief");

  const summary = db.listThreadSummaries().find((item) => item.id === thread.id) as Record<string, unknown> | undefined;
  assert.ok(summary, "board summary exists");
  assert.equal("rawPrompt" in summary, false, "board summary omits the raw prompt");
  assert.equal("brief" in summary, false, "board summary omits the enriched brief");
  assert.equal(summary.title, thread.title, "board summary keeps card data");
  // The board card's activity strip falls back to the brief's first line whenever a task isn't
  // streaming, which is most cards on a reconnect. Dropping the brief without this preview blanked
  // every one of them to "-", so the summary must still carry a clipped first line.
  assert.equal(typeof summary.briefPreview, "string", "board summary carries a brief preview");
  assert.ok((summary.briefPreview as string).startsWith("enriched brief"), "preview is the brief's own text");
  assert.ok((summary.briefPreview as string).length <= 200, "preview is clipped, not the whole brief");

  const multiline = db.createThread({
    title: "Multi-line brief",
    workspace: dir,
    rawPrompt: "p",
    brief: ["first line of the brief", "second line that must not reach the card"].join("\n"),
  });
  const multiSummary = db.listThreadSummaries().find((item) => item.id === multiline.id);
  assert.equal(multiSummary?.briefPreview, "first line of the brief", "preview stops at the first line");

  const insert = db.raw.prepare(
    `INSERT INTO messages(id, thread_id, role, kind, content, attachments, created_at)
     VALUES(@id, @threadId, 'implementor', 'text', @content, '[]', @createdAt)`,
  );
  for (const [id, createdAt] of [
    ["m-a", 1_000],
    ["m-b", 1_000],
    ["m-c", 2_000],
    ["m-d", 3_000],
    ["m-e", 3_000],
  ] as const) {
    insert.run({ id, threadId: thread.id, content: id, createdAt });
  }

  const newest = db.listMessagePage(thread.id, 2);
  assert.deepEqual(newest.messages.map((message) => message.id), ["m-d", "m-e"], "newest page is chronological");
  assert.equal(newest.hasMore, true, "newest page advertises older history");

  const middle = db.listMessagePage(thread.id, 2, { createdAt: newest.messages[0]!.createdAt, id: newest.messages[0]!.id });
  assert.deepEqual(middle.messages.map((message) => message.id), ["m-b", "m-c"], "same-millisecond keyset cursor has no overlap");
  assert.equal(middle.hasMore, true, "middle page still advertises the oldest entry");

  const oldest = db.listMessagePage(thread.id, 2, { createdAt: middle.messages[0]!.createdAt, id: middle.messages[0]!.id });
  assert.deepEqual(oldest.messages.map((message) => message.id), ["m-a"], "last page returns the remaining oldest entry");
  assert.equal(oldest.hasMore, false, "last page stops cleanly");

  const plan = db.raw
    .prepare("EXPLAIN QUERY PLAN SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at DESC, id DESC LIMIT ?")
    .all(thread.id, 400) as Array<{ detail: string }>;
  assert.ok(plan.some((row) => row.detail.includes("idx_messages_thread_created_id")), `message page did not use its index: ${JSON.stringify(plan)}`);

  console.log("Performance paths OK — board summary is slim and task history keyset-pages through its composite index.");
} finally {
  db.raw.close();
  rmSync(dir, { recursive: true, force: true });
}
