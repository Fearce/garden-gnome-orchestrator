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
import { startLatestMessagePreviewBackfill } from "../db/previewBackfill.js";
import { EventHub } from "../events.js";
import { BRIEF_PREVIEW_CHARS } from "../types.js";
import { createHelloCache } from "../ws/hub.js";
import type { ServerEvent } from "../ws/protocol.js";

const dir = mkdtempSync(join(tmpdir(), "gg-performance-paths-"));
const db = new Db(join(dir, "orchestrator.sqlite"));

// This gate `await`s a background walk, and the failure mode of such a walk is not an exception: an
// unref'd timer stops holding the event loop, Node drains it, and the process exits 0 with the awaited
// promise unsettled and every assertion after it silently skipped — a green gate that ran half of
// itself. Turn that into a red one.
let finished = false;
process.on("exit", (code) => {
  if (finished || code !== 0) return;
  console.error("performance paths: exited before the gate finished — an awaited background walk was abandoned mid-run");
  process.exitCode = 1;
});

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

  const messageSummary = db.listThreadSummaries().find((item) => item.id === thread.id);
  assert.equal(messageSummary?.latestMessagePreview, "m-e", "board summary carries the newest readable task message");

  // ---- that preview is STORED, not derived per task --------------------------------------------------
  //
  // 2026-09-16: deriving it was a correlated seek into `messages`, and the snapshot reads every task —
  // 2,773 of the query's 3,312 random page reads on the live 907-task database, at a measured ~8ms per
  // read while the disk is busy. That is where "I click a task and wait 30 seconds" came from: the click
  // arrives at an event loop already inside that query. The invariant is the table's, not any one
  // writer's, so it is kept by a trigger — which is why the assertion above still passes even though
  // those rows were inserted with raw SQL rather than through addMessage.
  const preview = (id: string): unknown =>
    (db.raw.prepare("SELECT latest_message_preview AS p FROM threads WHERE id = ?").get(id) as { p: unknown }).p;
  assert.equal(preview(thread.id), "m-e", "the preview is a stored column, kept current by the insert trigger");

  const noisy = db.createThread({ title: "Tool traffic", workspace: dir, rawPrompt: "p", brief: "b" });
  assert.equal(preview(noisy.id), "", "a task that has said nothing stores the empty string, never NULL");
  db.addMessage({ threadId: noisy.id, role: "implementor", kind: "text", content: "the readable line" });
  for (const kind of ["tool", "result", "thinking"] as const) {
    db.addMessage({ threadId: noisy.id, role: "implementor", kind, content: `a ${kind} row` });
  }
  assert.equal(
    preview(noisy.id),
    "the readable line",
    "tool calls, tool results and reasoning are not readable lines and must not overwrite the card's",
  );
  db.addMessage({ threadId: noisy.id, role: "implementor", kind: "text", content: "x".repeat(BRIEF_PREVIEW_CHARS + 50) });
  assert.equal(
    (preview(noisy.id) as string).length,
    BRIEF_PREVIEW_CHARS,
    "the stored line is clipped to the card's width, not the whole message",
  );

  // A retry deletes the feed the card was quoting, and an insert trigger cannot see a delete.
  db.resetThreadForRetry(noisy.id);
  assert.equal(preview(noisy.id), "", "a retry clears the line it deleted, and leaves a live task out of the backfill set");

  // ---- rows older than the column are seeded off the boot path ----------------------------------------
  //
  // NULL means exactly "predates the column": createThread writes '' and the trigger writes real text,
  // so the walk's set only shrinks and a restart mid-walk resumes without a cursor to persist.
  const legacy = [thread.id, multiline.id, noisy.id];
  for (const id of legacy) db.raw.prepare("UPDATE threads SET latest_message_preview = NULL WHERE id = ?").run(id);
  const unseeded = (): number =>
    (db.raw.prepare("SELECT COUNT(*) AS n FROM threads WHERE latest_message_preview IS NULL").get() as { n: number }).n;
  assert.equal(unseeded(), legacy.length, "every legacy row is a backfill candidate");

  const firstChunk = db.backfillLatestMessagePreviews(2);
  assert.equal(firstChunk.filled, 2, "a chunk seeds exactly its limit while more remain");
  assert.equal(firstChunk.done, false, "…and says so, rather than stopping half way through the board");
  let turns = 1;
  while (!db.backfillLatestMessagePreviews(2).done) {
    assert.ok(++turns < 50, "the backfill walk must terminate");
  }
  assert.equal(unseeded(), 0, "the walk seeds every legacy row");
  assert.equal(preview(thread.id), "m-e", "a seeded row gets the same line the derived query would have returned");
  assert.equal(preview(noisy.id), "", "a seeded row with no readable message gets '' — never NULL, or the walk never ends");
  assert.equal(db.backfillLatestMessagePreviews(2).filled, 0, "a completed walk is a no-op, not a rescan");

  // The driver has to be given MORE THAN ONE CHUNK of work, or it never reaches the timer it exists
  // to drive: with fewer unseeded rows than the chunk size it finishes on its own first, synchronous
  // tick and this assertion passes without a `setTimeout` ever being scheduled. Seed past the default
  // chunk (12) so the between-chunk hop is the thing under test.
  for (let i = 0; i < 20; i++) {
    const extra = db.createThread({ title: `legacy ${i}`, workspace: dir, rawPrompt: "p", brief: "b" });
    db.addMessage({ threadId: extra.id, role: "implementor", kind: "text", content: `line ${i}` });
  }
  db.raw.prepare("UPDATE threads SET latest_message_preview = NULL").run();
  const timers = (): number => process.getActiveResourcesInfo().filter((resource) => resource === "Timeout").length;
  const idle = timers();
  const walk = startLatestMessagePreviewBackfill(db, () => {}, 1);
  // The between-chunk timer must HOLD the event loop. An unref'd one does not, so in any process whose
  // only pending work is this walk the loop drains, `done` never settles, and everything awaiting it is
  // silently skipped — reproduced at exit code 13 against a bare harness, and it abandoned the live-DB
  // migration rehearsal after one chunk. `getActiveResourcesInfo()` lists only resources that keep the
  // loop alive, which is the exact property under test; asserting on completion instead cannot see it,
  // because whether an abandoned timer still fires depends on what else the test process happens to hold.
  assert.equal(timers(), idle + 1, "the walk's between-chunk timer must keep the event loop alive until the walk is done");
  await walk.done;
  assert.equal(unseeded(), 0, "the driver runs the walk to completion on its own, across chunk boundaries");

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

  // ---- the connect snapshot is not rebuilt per reconnect ----
  //
  // 2026-09-16: the console's watchdog force-closes a socket after 35s of server silence, so a stall
  // long enough to trip it reconnects every open console at once, and each reconnect rebuilt the full
  // ~900-thread hello — which lengthened the stall, which tripped the watchdog again. Measured: 7
  // distinct client sockets in 30s against 3 concurrent connections, with 72% of stall-profile busy
  // time in `listThreadSummaries -> all`. Reuse has to be invalidated by EVENTS, not by a timer, or a
  // reconnecting client silently receives a board that is already wrong.
  const hub = new EventHub();
  let builds = 0;
  const makeCache = (ttlMs: number) =>
    createHelloCache(() => {
      builds++;
      return { type: "hello", builds } as unknown as ServerEvent;
    }, hub, ttlMs);

  // 1. A quiet board reuses one snapshot however many sockets ask for it.
  const quiet = makeCache(0);
  quiet();
  quiet();
  quiet();
  assert.equal(builds, 1, "a reconnect storm with no state change must build the snapshot once, not once per socket");

  // 2. A durable event makes it stale, so the next connect gets fresh state.
  hub.publish({ type: "log", level: "info", message: "something changed" });
  quiet();
  assert.equal(builds, 2, "a durable event must make the snapshot stale — a reused one would be a wrong board");
  quiet();
  assert.equal(builds, 2, "and it is reusable again once the board is quiet");

  // 3. Streaming deltas are not durable board state. They are also almost all of the traffic, so
  //    letting them dirty the snapshot is exactly why invalidation alone fixed nothing: while agents
  //    run, the snapshot was never clean and every reconnect rebuilt it.
  for (let i = 0; i < 50; i++) hub.publish({ type: "agent.delta", threadId: "t", runId: "r", role: "implementor", text: "x" } as never);
  quiet();
  assert.equal(builds, 2, "streaming deltas must not dirty the snapshot");

  // 4. Even while durable events never stop, rebuilds are rate-limited — that is what makes a
  //    reconnect burst cost one build instead of one per socket.
  const busy = makeCache(10_000);
  busy();
  const afterFirst = builds;
  for (let i = 0; i < 5; i++) {
    hub.publish({ type: "log", level: "info", message: "still working" });
    busy();
  }
  assert.equal(builds, afterFirst, "a dirty snapshot is rebuilt at most once per interval, however many events and sockets arrive");

  finished = true;
  console.log("Performance paths OK — board summary is slim, task history keyset-pages through its composite index, and the connect snapshot survives a reconnect storm.");
} finally {
  db.raw.close();
  rmSync(dir, { recursive: true, force: true });
}
