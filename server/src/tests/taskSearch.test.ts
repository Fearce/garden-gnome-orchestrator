/**
 * Gate — the console's search finds a task by what HAPPENED in it, not only by what it was called
 * (`Db.searchTasks`).
 *
 * Background: the search box searched `director_messages` and nothing else. That is exactly the wrong
 * scope for the question people bring to it. Kevin dispatched "Can u make a 3d model of this i can
 * print? 3mf file" with a photo attached; the implementor looked at the picture, named the project
 * `milkshake-monster`, and said the word 833 times over the run. Months later "milkshake" returned
 * nothing — the term was never in his prompt, never in the auto-generated title ("Adjust colors to
 * purple black red white palette"), and never in the brief. It lived only in the task's conversation,
 * which nothing searched.
 *
 * WHAT IS REAL: a real on-disk SQLite Db (throwaway temp dir). No agents, no network, no quota.
 *
 * Scenarios:
 *   A. SCOPE     — a task whose title and brief are silent about the term is still found through its
 *                  conversation; the director-conversation search beside it stays independent.
 *   B. RANKING   — the task that did the work outranks the log dump that name-drops the term once, even
 *                  though the log dump is newer; a title/brief match outranks both.
 *   C. EVIDENCE  — `where`/`messageHits` describe why it matched, and the snippet is cut and collapsed
 *                  server-side (a matching tool-output message is routinely megabytes).
 *   D. LITERALS  — LIKE wildcards typed into the box match themselves; an empty query matches nothing.
 *
 * Run:  npm run test:task-search   (from server/)   — or:  npx tsx src/tests/taskSearch.test.ts
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

const dir = mkdtempSync(join(tmpdir(), "gg-search-"));
const db: DbType = new Db(join(dir, "orchestrator.sqlite"));

function newTask(title: string, brief: string, workspace = "C:\\3d"): string {
  return db.createThread({ title, workspace, rawPrompt: brief, brief }).id;
}
function say(threadId: string, content: string, kind: "text" | "tool" | "result" = "text"): void {
  db.addMessage({ threadId, role: "implementor", kind, content });
}
const titles = (q: string): string[] => db.searchTasks(q).map((h) => h.title);
const hitFor = (q: string, title: string) => db.searchTasks(q).find((h) => h.title === title);

// The real shape of the bug: the owner's words never contain the term, the agent's do.
const monster = newTask("Adjust colors to purple black red white palette", "Can u make a 3d model of this i can print? 3mf file");
say(monster, "I'll tackle this. The image is a cute purple furry creature drinking a milkshake — an organic sculpt.");
for (let i = 0; i < 20; i++) say(monster, `wrote C:\\3d\\milkshake-monster\\part${i}.py`, "tool");

// ---- A. the search reaches into a task's conversation ----------------------------------------------
console.log("\nA. scope — a task is findable by what happened in it");
{
  check("a conversation-only mention is found", titles("milkshake").includes("Adjust colors to purple black red white palette"));
  check("…and its title, which never says it, is not why", !"Adjust colors to purple black red white palette".toLowerCase().includes("milkshake"));
  check("…nor its brief", !(db.getThread(monster)?.brief ?? "").toLowerCase().includes("milkshake"));
  check("a term nobody ever said finds nothing", db.searchTasks("kombucha").length === 0);
  check("matching is case-insensitive", titles("MILKSHAKE").length === titles("milkshake").length);

  db.addDirectorMessage({ role: "user", kind: "text", content: "make me a milkshake please" });
  check("the director-conversation search is unaffected", db.searchDirectorMessages("milkshake").length === 1);
  check("…and finding a director message does not invent a task", db.searchTasks("milkshake").length === 1);
}

// ---- B. the task that did the work sorts above the one that name-dropped it ------------------------
console.log("\nB. ranking — depth beats recency, metadata beats both");
{
  const crawl = newTask("Nightly crawl of the menu sites", "run a crawl and fix failures", "C:\\vota");
  say(crawl, "fetched https://example.com/menu/milkshakes-and-cold-drinks.html — 57 dishes", "result");
  // Backdated to the oldest task in the DB, so "it sorts first" can only be the title/brief rule
  // talking — with a recency sort it would land last, which is what makes the next check load-bearing.
  const named = newTask("Milkshake monster rescale", "make the milkshake print 20% larger");
  db.raw.prepare("UPDATE threads SET created_at = 1 WHERE id = ?").run(named);

  const order = titles("milkshake");
  check("the deep worker outranks the incidental log dump", order.indexOf("Adjust colors to purple black red white palette") < order.indexOf("Nightly crawl of the menu sites"));
  check("…even though the log dump is the newer task", db.getThread(crawl)!.createdAt >= db.getThread(monster)!.createdAt);
  check("a task whose own title says it comes first", order[0] === "Milkshake monster rescale", order.join(" | "));
  check("all three are returned", order.length === 3, order.join(" | "));

  const capped = db.searchTasks("milkshake", 2);
  check("the limit cuts the weakest, not the strongest", capped.length === 2 && capped[0]?.title === "Milkshake monster rescale");
  db.deleteThread(crawl);
  db.deleteThread(named);
}

// ---- C. why it matched, and a snippet small enough to send -----------------------------------------
console.log("\nC. evidence — the label and the windowed snippet");
{
  const hit = hitFor("milkshake", "Adjust colors to purple black red white palette");
  check("labelled as a conversation match", hit?.where === "conversation", hit?.where ?? "no hit");
  check("counts every matching message", hit?.messageHits === 21, String(hit?.messageHits));
  check("the snippet prefers prose over tool traffic", !!hit?.snippet.includes("cute purple furry creature"), hit?.snippet);
  check("carries the task's state and repo for the card", hit?.state === "intake" && hit?.workspace === "C:\\3d");

  const briefed = newTask("Chair arms", "the chair arms are 2x2cm, print in milkshake purple");
  const briefHit = hitFor("milkshake", "Chair arms");
  check("the owner's own brief outranks agent chatter as evidence", briefHit?.where === "brief", briefHit?.where ?? "no hit");
  check("a brief-only match reports no conversation hits", briefHit?.messageHits === 0, String(briefHit?.messageHits));

  const titled = newTask("Milkshake", "no mention here");
  const titleHit = hitFor("milkshake", "Milkshake");
  check("a title-only match carries no snippet — the highlighted title is the evidence", titleHit?.where === "title" && titleHit?.snippet === "");

  // A `result` message holding a screenful of tool output must never reach the socket whole.
  const noisy = newTask("Slicer run", "slice it");
  say(noisy, "x".repeat(200_000) + "\n\n  milkshake \t layer 4\n" + "y".repeat(200_000), "result");
  const noisySnippet = hitFor("milkshake", "Slicer run")?.snippet ?? "";
  check("a huge message is windowed, not shipped", noisySnippet.length > 0 && noisySnippet.length < 500, `${noisySnippet.length} chars`);
  check("…the window keeps the match", noisySnippet.includes("milkshake"));
  check("…and collapses whitespace so it reads as one line", noisySnippet.includes("milkshake layer 4"), noisySnippet.slice(0, 120));
  check("…marked as elided at both ends", noisySnippet.startsWith("…") && noisySnippet.endsWith("…"));

  db.deleteThread(briefed);
  db.deleteThread(titled);
  db.deleteThread(noisy);
}

// ---- D. a query is a literal, not a pattern --------------------------------------------------------
console.log("\nD. literals — a typed wildcard matches itself");
{
  const pct = newTask("Discount banner", "show 20% off in the header");
  const under = newTask("Snake case rename", "rename to milkshake_monster everywhere");

  check("a % in the query is a literal percent", titles("20% off").length === 1);
  check("…and does not turn into a wildcard", db.searchTasks("2%f").length === 0);
  check("an _ in the query is a literal underscore", titles("milkshake_monster").includes("Snake case rename"));
  check("…and does not match any single char", db.searchTasks("milkshake.monster").length === 0);
  check("an empty query matches nothing", db.searchTasks("   ").length === 0);

  db.deleteThread(pct);
  db.deleteThread(under);
}

db.raw.close();
rmSync(dir, { recursive: true, force: true });

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed`);
if (failed) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
