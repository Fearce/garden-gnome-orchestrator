// Deterministic test for the operator note list. Temp DB + a real EventHub, no accounts, no agents.
// Run: `npm run test:notes`.
//
// The list exists because the owner asked for somewhere agents can leave a branch/PR link WITHOUT
// being able to bury them in prose, so the anti-spam properties are the contract, not a detail: the
// 255-char truncation, the same-link dedupe, the per-task cap, and the http(s)-only link guard (the
// note's url is agent-supplied and rendered as a real <a> in the console).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../db/db.js";
import { EventHub } from "../events.js";
import { OperatorNotes } from "../orchestrator/notes.js";
import { NOTE_MAX_CHARS } from "../types.js";
import type { ServerEvent } from "../ws/protocol.js";

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}`);
  }
}

const dir = mkdtempSync(join(tmpdir(), "notes-test-"));
const db = new Db(join(dir, "t.sqlite"));
const hub = new EventHub();

let broadcasts = 0;
let lastBroadcast: { notes: unknown[] } | null = null;
hub.subscribe((e: ServerEvent) => {
  if (e.type === "notes") {
    broadcasts++;
    lastBroadcast = e as { notes: unknown[] };
  }
});

const notes = new OperatorNotes(db, hub);
const fromTask = (body: string, url?: string | null, threadId = "task-1") =>
  notes.add({ body, url, threadId, threadTitle: "Fix the crawler", workspace: "C:\\vota", fromRole: "implementor", fromName: "Liv" });

function main(): void {
  console.log("notes: post");
  const first = notes.add({
    body: "PR #412: menu photo ingest — ready to merge",
    url: "https://github.com/acme/vota/pull/412",
    threadId: "task-1",
    threadTitle: "Fix the crawler",
    workspace: "C:\\vota",
    fromRole: "implementor",
    fromName: "Liv",
  });
  check("post ok", first.ok && !!first.note);
  check("post broadcasts the whole list", broadcasts === 1 && lastBroadcast!.notes.length === 1);
  check("keeps the poster's identity", first.note!.fromName === "Liv" && first.note!.fromRole === "implementor");
  check("snapshots the task title + repo", first.note!.threadTitle === "Fix the crawler" && first.note!.workspace === "C:\\vota");

  console.log("notes: the 255-char cap");
  const long = notes.add({ body: "x".repeat(400), threadId: "task-2" });
  check("a long body is truncated, never rejected", long.ok && long.note!.body.length === NOTE_MAX_CHARS);
  check("truncation is reported back to the poster", long.truncated === true);
  check("a body at the limit is untouched", notes.add({ body: "y".repeat(NOTE_MAX_CHARS), threadId: "task-2" }).note!.body.length === NOTE_MAX_CHARS);
  check("a body inside the limit isn't reported as truncated", notes.add({ body: "short", threadId: "task-2" }).truncated === false);
  const bare = notes.add({ body: "", url: "https://example.com/only-a-link", threadId: "task-2" });
  check("a note that falls back to its bare link lost nothing", bare.ok && bare.note!.body === "https://example.com/only-a-link" && bare.truncated === false);
  const multiline = notes.add({ body: "Branch pushed.\n\nIt does the thing.\n  Really.", threadId: "task-2" });
  check("newlines are folded to one line", !multiline.note!.body.includes("\n") && multiline.note!.body === "Branch pushed. It does the thing. Really.");
  notes.clear();
  broadcasts = 0;

  console.log("notes: same link posted twice refreshes one row");
  const a = fromTask("branch pushed", "https://github.com/acme/vota/tree/fix-crawler");
  const b = fromTask("branch pushed, tests green now", "https://github.com/acme/vota/tree/fix-crawler");
  check("the second post reuses the first note", b.outcome === "refreshed" && b.note!.id === a.note!.id);
  check("and the list still holds one line", notes.list().length === 1);
  check("with the newer text", notes.list()[0]!.body === "branch pushed, tests green now");
  const other = fromTask("different PR", "https://github.com/acme/vota/pull/9");
  check("a different link is a new note", other.outcome === "created" && notes.list().length === 2);
  // One PR is one thing the owner clicks, reviews and deletes. Three tasks that all touched it must not
  // cost three rows and three deletions — the row is about the LINK, so the newest poster takes it over.
  const otherTask = notes.add({ body: "same link, other task", url: "https://github.com/acme/vota/pull/9", threadId: "task-9", fromName: "Pax", fromRole: "implementor" });
  check("the same link from ANOTHER task refreshes the one row", otherTask.outcome === "refreshed" && notes.list().length === 2);
  check("...and the row now names the newest poster", otherTask.note!.threadId === "task-9" && otherTask.note!.fromName === "Pax");
  check("...with the newest text", notes.list()[0]!.body === "same link, other task");
  notes.clear();

  console.log("notes: rows left by the old per-task dedupe fold together on the next post");
  // Written straight to the Db so they bypass the service — the shape prod already had before the
  // dedupe went global. Touching that link again must leave ONE row, not heal only the newest pair.
  const dupUrl = "https://github.com/acme/vota/pull/81";
  for (const who of ["Vik", "Pax", "Sif"]) {
    db.createOperatorNote({ body: `${who} on PR 81`, url: dupUrl, threadId: `task-${who}`, threadTitle: null, workspace: null, fromRole: "implementor", fromName: who });
  }
  check("three legacy rows for one link", notes.list().length === 3);
  const healed = notes.add({ body: "PR 81 is ready", url: dupUrl, threadId: "task-new", fromName: "Liv", fromRole: "implementor" });
  check("a later post collapses them to one row", healed.outcome === "refreshed" && notes.list().length === 1);
  check("...reporting what it folded away", healed.evicted === 2);
  check("...and the survivor is the newest note", notes.list()[0]!.body === "PR 81 is ready" && notes.list()[0]!.fromName === "Liv");
  notes.clear();

  console.log("notes: a task can't flood the list");
  for (let i = 1; i <= 8; i++) fromTask(`note ${i}`, `https://example.com/p/${i}`);
  const mine = notes.list().filter((n) => n.threadId === "task-1");
  check("one task keeps at most 5 notes", mine.length === 5);
  check("it keeps the NEWEST five", mine.map((n) => n.body).join(",") === "note 8,note 7,note 6,note 5,note 4");
  check("eviction is reported back to the poster", fromTask("note 9", "https://example.com/p/9").evicted === 1);
  check("another task is unaffected by that cap", notes.add({ body: "elsewhere", threadId: "task-2" }).ok && notes.list().length === 6);
  notes.clear();

  console.log("notes: only http(s) links (they render as a real <a>)");
  check("javascript: is refused", !notes.add({ body: "click me", url: "javascript:alert(1)" }).ok);
  check("data: is refused", !notes.add({ body: "click me", url: "data:text/html,<script>x</script>" }).ok);
  check("file: is refused", !notes.add({ body: "click me", url: "file:///C:/Windows/System32" }).ok);
  check("a bare branch name is refused as a url", !notes.add({ body: "check it", url: "feature/foo" }).ok);
  check("nothing landed from any of those", notes.list().length === 0);
  check("https is accepted", notes.add({ body: "ok", url: "https://github.com/acme/vota/pull/1" }).ok);
  check("http is accepted", notes.add({ body: "ok", url: "http://192.168.0.122:4317/" }).ok);
  notes.clear();

  console.log("notes: a link written into the sentence still becomes the click target");
  // The only shape a CLI backend's text bridge can produce — and how a model writes one unprompted.
  const inline = notes.add({ body: "PR is up: https://github.com/acme/vota/pull/77. Please merge.", threadId: "task-3" });
  check("the url is lifted out of the body", inline.note!.url === "https://github.com/acme/vota/pull/77");
  check("an explicit url still wins over one in the text", notes.add({ body: "see https://a.example/1", url: "https://b.example/2" }).note!.url === "https://b.example/2");
  check("prose with no link stays a plain note", notes.add({ body: "remember to review the deploy" }).note!.url === null);
  notes.clear();

  console.log("notes: the owner clears them");
  const own = notes.add({ body: "my own reminder" });
  check("a note with no task has no agent attached", own.note!.threadId === null && own.note!.fromRole === null);
  const before = broadcasts;
  check("delete ok", notes.remove(own.note!.id).ok);
  check("delete broadcasts", broadcasts === before + 1);
  check("delete of a missing id fails", !notes.remove(own.note!.id).ok);
  check("an empty note is refused", !notes.add({ body: "   " }).ok);
  fromTask("one", "https://example.com/a");
  fromTask("two", "https://example.com/b");
  notes.clear();
  check("clear empties the list", notes.list().length === 0);

  console.log("notes: newest first (the list is an inbox)");
  // Same-millisecond posts are the normal case for a burst, so the order must not depend on the clock
  // ticking between them — it breaks on insertion order, never on the random id.
  notes.add({ body: "older" });
  const newer = notes.add({ body: "newer" }).note!;
  check("the newest note reads at the top", notes.list()[0]!.id === newer.id);
  const refreshed = notes.add({ body: "older, updated", url: "https://example.com/x" }).note!;
  notes.add({ body: "newest" });
  check("a refreshed note floats back to the top", notes.add({ body: "older, again", url: "https://example.com/x" }).note!.id === refreshed.id && notes.list()[0]!.id === refreshed.id);
  const reopened = new Db(join(dir, "t.sqlite"));
  check("the list survives a reopen of the same DB", new OperatorNotes(reopened, hub).list().length === 4);
  reopened.raw.close();
}

try {
  main();
} finally {
  try {
    db.raw.close();
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows can hold the sqlite file briefly; the temp dir is disposable either way. */
  }
}

if (failures) {
  console.error(`\n${failures} operator-note check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll operator-note checks passed.");
