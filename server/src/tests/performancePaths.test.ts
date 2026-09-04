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

  // Messages written inside one millisecond must read back in the order they were WRITTEN. The feed
  // renders a tool call and its result as separate rows, so an id-keyed tie-break (random UUIDs) puts
  // the result above the call it came from. `w-*` are inserted deliberately against UUID order.
  const sameMs = db.createThread({ title: "Same millisecond", workspace: dir, rawPrompt: "p", brief: "b" });
  const written = ["w-c", "w-a", "w-b"] as const; // insert order, which is NOT ascending id order
  for (const id of written) insert.run({ id, threadId: sameMs.id, content: id, createdAt: 5_000 });
  assert.deepEqual(
    db.listMessages(sameMs.id).map((message) => message.id),
    [...written],
    "same-millisecond messages read back in write order, not random-UUID order",
  );
  assert.deepEqual(
    db.listMessagePage(sameMs.id, 400).messages.map((message) => message.id),
    [...written],
    "the feed page keeps that write order too",
  );
  // …and paging through them stays exact: the cursor is a message id, resolved server-side to its
  // insert position, so a same-millisecond group splits across pages without overlap or loss.
  const msNewest = db.listMessagePage(sameMs.id, 2);
  assert.deepEqual(msNewest.messages.map((m) => m.id), ["w-a", "w-b"], "newest page of one millisecond");
  assert.equal(msNewest.hasMore, true, "the split group advertises its remainder");
  const msOlder = db.listMessagePage(sameMs.id, 2, { createdAt: 5_000, id: msNewest.messages[0]!.id });
  assert.deepEqual(msOlder.messages.map((m) => m.id), ["w-c"], "rowid keyset resumes inside the same millisecond");
  assert.equal(msOlder.hasMore, false, "…and then stops");
  // A cursor whose row is gone (a retry reset the feed under an open console) must not silently drop
  // that millisecond's other rows; re-showing them is deduped by the client's id-keyed merge.
  const msMissing = db.listMessagePage(sameMs.id, 400, { createdAt: 5_000, id: "deleted-row" });
  assert.deepEqual(msMissing.messages.map((m) => m.id), [...written], "a vanished cursor re-shows its millisecond");

  for (const [label, sql] of [
    ["descending page", "SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 400"],
    ["ascending read", "SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at ASC, rowid ASC"],
    [
      "keyset page",
      "SELECT * FROM messages WHERE thread_id = ? AND (created_at < 9 OR (created_at = 9 AND rowid < 9)) ORDER BY created_at DESC, rowid DESC LIMIT 400",
    ],
  ] as const) {
    const plan = db.raw.prepare("EXPLAIN QUERY PLAN " + sql).all(thread.id) as Array<{ detail: string }>;
    const detail = plan.map((row) => row.detail).join(" | ");
    assert.ok(detail.includes("idx_messages_thread_time"), `${label} did not use its index: ${detail}`);
    // The whole point of the composite is that the index already yields the needed order.
    assert.ok(!/TEMP B-TREE/.test(detail), `${label} still sorts by hand: ${detail}`);
  }
  const findingsPlan = (
    db.raw.prepare("EXPLAIN QUERY PLAN SELECT * FROM findings WHERE thread_id = ? ORDER BY created_at ASC").all(thread.id) as Array<{
      detail: string;
    }>
  )
    .map((row) => row.detail)
    .join(" | ");
  assert.ok(findingsPlan.includes("idx_findings_thread_time"), `findings read did not use its index: ${findingsPlan}`);
  assert.ok(!/TEMP B-TREE/.test(findingsPlan), `findings read still sorts by hand: ${findingsPlan}`);

  // The superseded indexes must be gone, not merely unused — they are the largest objects in the DB
  // after the tables themselves, and a rebuilt one silently reintroduces the id ordering above.
  const retired = db.raw
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_messages_thread_created_id','idx_findings_thread_created_id','idx_messages_thread','idx_findings_thread')")
    .all() as Array<{ name: string }>;
  assert.deepEqual(retired, [], `superseded indexes were not retired: ${JSON.stringify(retired)}`);

  console.log("Performance paths OK — board summary is slim and task history keyset-pages through its composite index.");
} finally {
  db.raw.close();
  rmSync(dir, { recursive: true, force: true });
}
