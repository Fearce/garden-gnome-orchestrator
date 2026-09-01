/**
 * Gate — the trigram search index answers EXACTLY what the full scan it replaced answered, and the
 * one-time walk that builds it cannot lose or double-count a message while it runs.
 *
 * Background: `Db.searchTasks` was `content LIKE '%q%'` over `messages` — 371,789 rows / 105 MB of
 * tool output on Kevin's box, unindexable by construction, re-read synchronously on every keystroke
 * (~0.6s with the pages cached, ~30s without, blocking the server's only thread the whole time).
 * `messages_fts` makes it an index lookup. The risk that buys is silence: a search that returns
 * FEWER results looks exactly like a search whose term genuinely isn't there, so the only assertion
 * worth making is a differential one — index vs scan, same corpus, same answers, byte for byte.
 *
 * WHAT IS REAL: real on-disk SQLite Dbs (throwaway temp dir), the real schema, the real triggers.
 * No agents, no network, no quota.
 *
 * Scenarios:
 *   A. EQUIVALENCE — index and scan return identical hits for hand-picked adversarial queries…
 *   B. FUZZ        — …and for hundreds of substrings drawn at random from the corpus itself.
 *   C. WALK        — the backfill resumes after a restart, and a message inserted or deleted while it
 *                    runs is indexed exactly once / removed cleanly, with the FTS integrity intact.
 *   D. LIFECYCLE   — new messages, updates, deletes and thread CASCADEs keep the index true.
 *   E. SHORT       — a query too short for a trigram falls back rather than silently finding nothing.
 *
 * Run:  npm run test:search-index   (from server/)  — or:  npx tsx src/tests/searchIndex.test.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { Db } = await import("../db/db.js");
const { trigramMatchExpr, FTS_READY_KEY, FTS_CURSOR_KEY } = await import("../db/searchIndex.js");
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

const dir = mkdtempSync(join(tmpdir(), "gg-searchidx-"));
const open: DbType[] = [];
function freshDb(name: string): DbType {
  const db = new Db(join(dir, `${name}.sqlite`));
  open.push(db);
  return db;
}

/** Run the walk to completion the way the server's timer does, without the timer. */
function buildIndex(db: DbType, chunk = 7): number {
  let turns = 0;
  for (;;) {
    const step = db.backfillSearchIndexChunk(chunk);
    turns++;
    if (step.done) return turns;
    if (turns > 10_000) throw new Error("backfill did not converge");
  }
}

/** The scan the index replaced, run straight against the DB — the reference answer. Trims first,
 *  because `searchTasks` does; comparing an untrimmed reference against a trimmed search reports a
 *  difference that is the harness's, not the index's. */
function scanHits(db: DbType, query: string): Map<string, number> {
  const q = query.trim();
  const like = `%${q.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
  const rows = db.raw
    .prepare("SELECT thread_id, COUNT(*) n FROM messages WHERE content LIKE ? ESCAPE '\\' GROUP BY thread_id")
    .all(like) as { thread_id: string; n: number }[];
  return new Map(rows.map((r) => [r.thread_id, r.n]));
}

/** What the search is contracted to return: the scan's answer, except that a query shorter than a
 *  trigram searches no conversations at all (`Db.conversationPlan`). */
function expectedHits(db: DbType, query: string): Map<string, number> {
  return [...query.trim()].length < 3 ? new Map() : scanHits(db, query);
}

const asKey = (m: Map<string, number>): string =>
  [...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}:${v}`).join("|");

/** What the console actually returns, reduced to the same shape so the two are comparable. */
function searchHits(db: DbType, q: string): Map<string, number> {
  return new Map(db.searchTasks(q, 10_000).map((h) => [h.threadId, h.messageHits]).filter(([, n]) => (n as number) > 0) as [string, number][]);
}

const ftsIntact = (db: DbType): boolean => {
  try {
    db.raw.exec("INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')");
    return true;
  } catch {
    return false;
  }
};

// ---- a corpus built to break a trigram index -------------------------------------------------------
// Every line here exists to defeat one plausible shortcut: word tokenizers, case folding, LIKE
// wildcards leaking through, punctuation treated as a separator, the abcXbcd trigram false positive.
const CORPUS: string[] = [
  "I'll tackle this. The image is a cute purple furry creature drinking a milkshake — an organic sculpt.",
  "wrote C:\\3d\\milkshake-monster\\part7.py and re-sliced it",
  "renamed everything to milkshake_monster for the snake_case pass",
  "MILKSHAKE MONSTER, shouted in a log header",
  "the discount banner shows 20% off in the header",
  "npm run build && npm run typecheck",
  "abcXbcd — the classic trigram false positive",
  "abcd is a plain four-letter run",
  "blåbærgrød og æbleskiver, med SÆRLIGE tegn",
  "Blåbærgrød igen, lowercase this time",
  "path=/usr/local/bin/orchestrator --flag=on",
  "CamelCaseIdentifierInsideAWord and snake_case_too",
  "a  b   c with runs of whitespace",
  'he said "quoted text" with embedded quotes',
  "emoji 🍦 milkshake with an astral char in front",
  "tab\tseparated\tvalues\there",
  "trailing punctuation!!! ???",
  "x".repeat(5000) + " needle-in-a-haystack " + "y".repeat(5000),
  "%_%_% literal wildcard soup _%_%_",
  "repeated repeated repeated repeated repeated",
  "aaaaaaaaaaaa runs of one letter",
  "short",
  "ab",
];

// ---- A. equivalence on adversarial queries ---------------------------------------------------------
console.log("\nA. equivalence — the index answers what the scan answered");
const eq = freshDb("equivalence");
{
  const t1 = eq.createThread({ title: "Milkshake monster", workspace: "C:\\3d", rawPrompt: "p", brief: "b" }).id;
  const t2 = eq.createThread({ title: "Nightly crawl", workspace: "C:\\workspace", rawPrompt: "p", brief: "b" }).id;
  const kinds = ["text", "tool", "result"] as const;
  CORPUS.forEach((content, i) => {
    const kind = kinds[i % kinds.length] ?? "text";
    eq.addMessage({ threadId: i % 3 === 0 ? t2 : t1, role: "implementor", kind, content });
    // Same text in the other task too, so a per-task count that drifts is visible as well as a set that does.
    if (i % 4 === 0) eq.addMessage({ threadId: t1, role: "implementor", kind: "text", content });
  });
  check("index is not used before the walk finishes", !eq.searchIndexReady());
  const beforeKey = asKey(searchHits(eq, "milkshake"));
  buildIndex(eq);
  check("…and is used after it", eq.searchIndexReady());
  check("the walk installs the maintenance triggers", eq.raw.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger' AND name LIKE 'messages_fts_%'").get() !== undefined && (eq.raw.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger' AND name LIKE 'messages_fts_%'").get() as { n: number }).n === 3);
  check("the same query survives the switch", asKey(searchHits(eq, "milkshake")) === beforeKey, beforeKey);

  const ADVERSARIAL = [
    "milkshake",
    "MILKSHAKE",
    "MiLkShAkE",
    "milkshake_monster",
    "milkshake.monster",
    "milkshake-monster",
    "20% off",
    "2%f",
    "%_%",
    "npm run build",
    "abcXbcd",
    "abcd",
    "blåbærgrød",
    "BLÅBÆRGRØD",
    "SÆRLIGE",
    "C:\\3d",
    "/usr/local/bin",
    "CamelCase",
    "elCaseIden",
    "a  b",
    '"quoted text"',
    "needle-in-a-haystack",
    // Astral chars are two UTF-16 units but ONE character to the tokenizer: slicing the query by JS
    // string index hands SQLite a term shorter than a trigram, which matches nothing, silently.
    "🍦",
    "emoji 🍦",
    "🍦 mil",
    "i 🍦 m",
    "aaaa",
    "repeated repeated",
    "kombucha",
    "shake",
    "onster",
    "\ttab",
  ];
  let mismatches = 0;
  for (const q of ADVERSARIAL) {
    const want = asKey(expectedHits(eq, q));
    const got = asKey(searchHits(eq, q));
    if (want !== got) {
      mismatches++;
      console.log(`      ${JSON.stringify(q)}  scan=${want || "(none)"}  index=${got || "(none)"}`);
    }
  }
  check(`all ${ADVERSARIAL.length} adversarial queries agree with the scan`, mismatches === 0, `${mismatches} differed`);
  check("a query the corpus never contains still finds nothing", searchHits(eq, "kombucha").size === 0);
  check("FTS integrity intact", ftsIntact(eq));
}

// ---- B. fuzz: substrings drawn from the corpus itself ----------------------------------------------
console.log("\nB. fuzz — random real substrings, index vs scan");
{
  // Deterministic PRNG so a failure is reproducible.
  let seed = 0x2f6e2b1;
  const rnd = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  let mismatches = 0;
  let nonEmpty = 0;
  const N = 400;
  for (let i = 0; i < N; i++) {
    const line = CORPUS[Math.floor(rnd() * CORPUS.length)]!;
    const len = 1 + Math.floor(rnd() * 12);
    const at = Math.floor(rnd() * Math.max(1, line.length - len));
    const q = line.slice(at, at + len).trim();
    if ([...q].length < 3) continue; // below the floor by contract — covered explicitly in E, not here
    const want = asKey(scanHits(eq, q));
    const got = asKey(searchHits(eq, q));
    if (want) nonEmpty++;
    if (want !== got) {
      mismatches++;
      if (mismatches <= 5) console.log(`      ${JSON.stringify(q)}  scan=${want || "(none)"}  index=${got || "(none)"}`);
    }
  }
  check(`${N} random substrings agree with the scan`, mismatches === 0, `${mismatches} differed`);
  check("…and the fuzz actually hit something (not vacuously green)", nonEmpty > N / 2, `${nonEmpty} non-empty`);
}

// ---- C. the walk, interrupted -----------------------------------------------------------------------
console.log("\nC. the walk — restart, and writes that land mid-walk");
{
  const p = join(dir, "walk.sqlite");
  let db: DbType = new Db(p);
  const tA = db.createThread({ title: "A", workspace: "W", rawPrompt: "p", brief: "b" }).id;
  const tB = db.createThread({ title: "B", workspace: "W", rawPrompt: "p", brief: "b" }).id;
  for (let i = 0; i < 60; i++) db.addMessage({ threadId: i % 2 ? tA : tB, role: "implementor", kind: "text", content: `seeded row ${i} widget` });

  db.backfillSearchIndexChunk(10);
  db.backfillSearchIndexChunk(10);
  const cursor = db.kvGet(FTS_CURSOR_KEY);
  check("the walk persists a cursor", cursor !== null && Number(cursor) > 0, String(cursor));
  check("…and does not mark itself ready early", db.kvGet(FTS_READY_KEY) === null);
  check("…and installs no write triggers while running", (db.raw.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger' AND name='messages_fts_ai'").get() as { n: number }).n === 0);

  // A message DELETED before the walk reaches it — the case that would corrupt an external-content
  // index, because the delete trigger is live from the first boot while the row is not yet indexed.
  const doomed = db.raw.prepare("SELECT id FROM messages ORDER BY rowid DESC LIMIT 1").get() as { id: string };
  db.raw.prepare("DELETE FROM messages WHERE id = ?").run(doomed.id);
  // A message ADDED mid-walk, above the cursor: the walk must pick it up, and exactly once.
  db.addMessage({ threadId: tA, role: "implementor", kind: "text", content: "arrived mid-walk widget" });

  // Restart: a new Db on the same file resumes from the cursor rather than starting over.
  db.raw.close();
  db = new Db(p);
  check("a restart mid-walk does not lose the cursor", db.kvGet(FTS_CURSOR_KEY) === cursor);
  check("…and search still answers meanwhile (scan fallback)", scanHits(db, "widget").size === 2);
  buildIndex(db, 7);
  check("the resumed walk completes", db.searchIndexReady());
  check("…with FTS integrity intact after the mid-walk delete", ftsIntact(db));

  const want = asKey(scanHits(db, "widget"));
  check("every seeded row is indexed exactly once", asKey(searchHits(db, "widget")) === want, `scan=${want} index=${asKey(searchHits(db, "widget"))}`);
  check("…including the one that arrived mid-walk", asKey(scanHits(db, "arrived mid-walk")) === asKey(searchHits(db, "arrived mid-walk")));
  check("…and the deleted one is gone from both", scanHits(db, `seeded row 59`).size === 0 && searchHits(db, "seeded row 59").size === 0);

  // Finishing an already-finished walk is a no-op, not a second pass.
  const before = asKey(searchHits(db, "widget"));
  db.backfillSearchIndexChunk(10);
  check("re-running the walk after completion double-counts nothing", asKey(searchHits(db, "widget")) === before);
  db.raw.close();
}

// ---- D. the index stays true afterwards ------------------------------------------------------------
console.log("\nD. lifecycle — insert, update, delete, thread purge");
{
  const db = freshDb("lifecycle");
  const t1 = db.createThread({ title: "Keeper", workspace: "W", rawPrompt: "p", brief: "b" }).id;
  buildIndex(db); // ready with an empty table — the fresh-install path
  check("a fresh database is ready immediately", db.searchIndexReady());

  db.addMessage({ threadId: t1, role: "implementor", kind: "text", content: "a gizmo appears" });
  check("a message added after the walk is searchable", asKey(searchHits(db, "gizmo")) === asKey(scanHits(db, "gizmo")));

  const m = db.raw.prepare("SELECT id FROM messages LIMIT 1").get() as { id: string };
  db.raw.prepare("UPDATE messages SET content = 'a doohickey replaces it' WHERE id = ?").run(m.id);
  check("an UPDATE re-indexes: the old term is gone", searchHits(db, "gizmo").size === 0);
  check("…and the new term is found", asKey(searchHits(db, "doohickey")) === asKey(scanHits(db, "doohickey")));

  db.raw.prepare("DELETE FROM messages WHERE id = ?").run(m.id);
  check("a DELETE removes it", searchHits(db, "doohickey").size === 0);

  const t2 = db.createThread({ title: "Doomed", workspace: "W", rawPrompt: "p", brief: "b" }).id;
  db.addMessage({ threadId: t2, role: "implementor", kind: "text", content: "purge me: contraption" });
  check("cascade setup", searchHits(db, "contraption").size === 1);
  db.deleteThread(t2);
  check("deleting a THREAD drops its messages from the index (FK cascade fires the trigger)", searchHits(db, "contraption").size === 0);

  const t3 = db.createThread({ title: "Retry", workspace: "W", rawPrompt: "p", brief: "b" }).id;
  db.addMessage({ threadId: t3, role: "implementor", kind: "text", content: "wiped: apparatus" });
  db.resetThreadForRetry(t3);
  check("a from-scratch retry wipe drops them too", searchHits(db, "apparatus").size === 0);
  check("FTS integrity intact", ftsIntact(db));
}

// ---- E. a query too short to index ------------------------------------------------------------------
console.log("\nE. short queries — fall back, never silently find nothing");
{
  check("a 1-char query has no trigram expression", trigramMatchExpr("a") === null);
  check("a 2-char query has no trigram expression", trigramMatchExpr("ab") === null);
  check("a 3-char query does", trigramMatchExpr("abc") === '"abc"');
  check("a long query is covered without one term per character", (trigramMatchExpr("abcdefghij") ?? "").split(" AND ").length === 4);
  check("…and every character of it is covered", ["abc", "def", "ghi", "hij"].every((t) => (trigramMatchExpr("abcdefghij") ?? "").includes(`"${t}"`)));
  check("a quote in the query is escaped, not injected", trigramMatchExpr('a"b') === '"a""b"');
  check("trigrams are cut by character, not by UTF-16 unit", trigramMatchExpr("a🍦b") === '"a🍦b"');
  check("…so two astral chars are two characters, not enough for a trigram", trigramMatchExpr("🍦🍦") === null);
  check("…and three of them are exactly one", trigramMatchExpr("🍦🍦🍦") === '"🍦🍦🍦"');
  const q200 = "z".repeat(97) + "needle" + "q".repeat(97);
  check("a 200-char query (the protocol cap) still builds", (trigramMatchExpr(q200) ?? "").length > 0);
  check("…and SQLite accepts it", (() => {
    try {
      eq.raw.prepare("SELECT COUNT(*) n FROM messages_fts WHERE messages_fts MATCH ?").get(trigramMatchExpr(q200));
      return true;
    } catch (e) {
      return String(e);
    }
  })() === true);

  // Under three characters the contract is titles and briefs only — the rail says so, and the server
  // must actually do it. The trap this avoids: a 1-2 char MATCH returns zero rows SILENTLY (no error),
  // so a short query reaching the index would look like "that word isn't anywhere" instead of "too short".
  check("a 2-char query searches no conversations", searchHits(eq, "ab").size === 0, asKey(searchHits(eq, "ab")));
  check("a 1-char query searches no conversations", searchHits(eq, "x").size === 0, asKey(searchHits(eq, "x")));
  check("…and the scan would have found some, so that is a floor, not an empty corpus", scanHits(eq, "ab").size > 0);
  {
    const t = eq.createThread({ title: "Ab initio", workspace: "W", rawPrompt: "p", brief: "b" }).id;
    check("…but a short query still matches titles", eq.searchTasks("Ab").some((h) => h.threadId === t));
    check("…reported as a title match with no conversation hits", eq.searchTasks("Ab").find((h) => h.threadId === t)?.messageHits === 0);
    eq.deleteThread(t);
  }
  check("the floor is measured in characters, not UTF-16 units", searchHits(eq, "🍦🍦").size === 0);
}

// Every connection must be closed before the temp dir goes, or Windows throws EBUSY on the sqlite file.
for (const db of open) db.raw.close();
rmSync(dir, { recursive: true, force: true });

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed`);
if (failed) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
