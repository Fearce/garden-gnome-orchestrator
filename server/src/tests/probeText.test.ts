/**
 * Gate — `probe:text` answers "where in the database does this word live?" without writing to the
 * database it is answering about (`scripts/probe-text.cjs`).
 *
 * Background: triage for "I searched for milkshake and found nothing" began by hand-writing a throwaway
 * script to find which TABLE held the word — and the answer (886 rows in `messages`, zero in
 * `director_messages`) is what reframed the task. The probe exists so the next agent reads that in one
 * command. Two of its properties are easy to break and invisible when broken:
 *   • it must open the live file READ-ONLY. `new Db(path)` runs migrations, so a probe written the
 *     obvious way writes to Kevin's production database just by looking at it.
 *   • it must discover columns from the schema. Hardcoding them means a column added later is silently
 *     never searched, and the probe reports a confident "not here".
 *
 * WHAT IS REAL: a real on-disk SQLite Db (throwaway temp dir) and the real probe, spawned as a child
 * process so its argv parsing and exit codes are exercised as a caller sees them. No agents, no quota.
 *
 * Scenarios:
 *   A. ARGV      — a bare term works, `--limit` works, and neither eats the other (the `--limit` index
 *                  math swallowed a bare term when this shipped).
 *   B. ROLLUP    — a word only ever said inside a task's conversation is found and attributed to that
 *                  task, strongest first, and the tables nobody checks by hand are covered.
 *   C. VERDICT   — no director hit says so in the words that matter (the word was the AGENT's), and a
 *                  word nobody said anywhere exits 1 like grep.
 *   D. READ-ONLY — running it leaves the database byte-for-byte untouched.
 *   E. NO ROT    — a text column added after the probe was written is searched anyway.
 *
 * Run:  npm run test:probe-text   (from server/)   — or:  npx tsx src/tests/probeText.test.ts
 * Exits non-zero if any assertion fails. Self-contained: throwaway DB in a temp dir, removed on exit.
 */

import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const { Db } = await import("../db/db.js");

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

const dir = mkdtempSync(join(tmpdir(), "gg-probetext-"));
const dbPath = join(dir, "orchestrator.sqlite");
const PROBE = resolve(import.meta.dirname, "..", "..", "scripts", "probe-text.cjs");

/** Run the probe exactly as a caller does, and report what it printed AND how it exited. */
function probe(...args: string[]): { out: string; code: number } {
  try {
    const out = execFileSync(process.execPath, [PROBE, ...args], {
      env: { ...process.env, DATA_DIR: dir },
      encoding: "utf8",
      windowsHide: true,
    });
    return { out, code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; status?: number };
    return { out: err.stdout ?? "", code: err.status ?? -1 };
  }
}

// A task the owner described without ever using the word the agent went on to coin.
const db = new Db(dbPath);
const monster = db.createThread({
  title: "Adjust colors to purple black red white palette",
  workspace: "C:\\3d",
  rawPrompt: "Can u make a 3d model of this i can print? 3mf file",
  brief: "Can u make a 3d model of this i can print? 3mf file",
}).id;
db.addMessage({ threadId: monster, role: "implementor", kind: "text", content: "The image is a cute purple furry creature drinking a milkshake." });
for (let i = 0; i < 9; i++) {
  db.addMessage({ threadId: monster, role: "implementor", kind: "tool", content: `wrote C:\\3d\\milkshake-monster\\p${i}.py` });
}
db.addFinding({ threadId: monster, fromRole: "implementor", severity: "note", summary: "milkshake-monster is 4-colour" });

// A second task that name-drops it once — must not outrank the one that did the work.
const crawl = db.createThread({ title: "Nightly crawl", workspace: "C:\\workspace", rawPrompt: "crawl", brief: "run a crawl" }).id;
db.addMessage({ threadId: crawl, role: "implementor", kind: "result", content: "fetched /menu/milkshakes-and-cold-drinks.html" });

// A word the OWNER typed, so the director half has something to report.
db.addDirectorMessage({ role: "user", kind: "text", content: "please fix the crawler tonight" });
// And a literal wildcard, to prove the query is escaped.
db.createThread({ title: "Discount banner", workspace: "C:\\web", rawPrompt: "p", brief: "show 20% off in the header" });
db.raw.close();

// ---- A. argv ---------------------------------------------------------------------------------------
console.log("\nA. argv — a bare term and a --limit must not eat each other");
{
  const bare = probe("milkshake");
  check("a bare term searches for that term", /"milkshake" in/.test(bare.out) && bare.code === 0, bare.out.slice(0, 120));
  check("...and is not swallowed by the --limit index math", bare.code !== 2, `exit ${bare.code}`);

  const limited = probe("milkshake", "--limit", "1");
  check("--limit still leaves the term intact", /"milkshake" in/.test(limited.out));
  check("...and caps the task list", /1 more \(raise with --limit\)/.test(limited.out), limited.out.slice(-200));
  check("no argument at all is a usage error", probe().code === 2);
}

// ---- B. the roll-up that answers "which task" ------------------------------------------------------
console.log("\nB. rollup — a word said only inside a task is attributed to that task");
{
  const { out } = probe("milkshake");
  // 11 = the ten in the monster task plus the crawl task's one URL, which contains "milkshakes".
  check("it is found in the task conversation", /messages\s+11 row\(s\)/.test(out), out.slice(0, 400));
  check("...and in findings, which nobody checks by hand", /findings\s+1 row\(s\)/.test(out), out.slice(0, 400));
  check("both tasks are rolled up", /tasks that mention it \(2, strongest first\)/.test(out), out.slice(0, 500));

  const deep = out.indexOf("Adjust colors");
  const shallow = out.indexOf("Nightly crawl");
  check("the task that did the work is listed first", deep > 0 && deep < shallow, `${deep} vs ${shallow}`);
  check("...with prose as its evidence, not tool traffic", /cute purple furry creature/.test(out));
  check("...and it names which tables held the hits", /findings:1 messages:10/.test(out), out.slice(deep, deep + 300));
}

// ---- C. the verdict a triager needs ----------------------------------------------------------------
console.log("\nC. verdict — whose word was it, and grep semantics when it is nobody's");
{
  const { out } = probe("milkshake");
  check("no director hit says the word was an AGENT's", /this word is one an AGENT coined/.test(out), out.slice(-300));

  const owner = probe("crawler tonight");
  check("a word the owner typed shows in the director section", /director conversation \(1\)/.test(owner.out), owner.out.slice(-300));

  const absent = probe("kombucha");
  check("a word nobody said reports so", /no row in any table contains it/.test(absent.out), absent.out.slice(0, 200));
  check("...and exits 1, like grep", absent.code === 1, String(absent.code));

  check("a typed % is a literal, not a wildcard", /threads\s+1 row\(s\)/.test(probe("20% off").out));
  check("...so it cannot match across the gap", probe("2%f").code === 1);
}

// ---- D. it must not write to the database it is reporting on ---------------------------------------
console.log("\nD. read-only — looking at prod must never migrate prod");
{
  // File size and mtime prove NOTHING here, and a first attempt at this check passed happily against a
  // probe rewritten to use `new Db(path)`: on an already-migrated database `CREATE TABLE IF NOT EXISTS`
  // writes no pages at all. So stage the case that actually bites — a database with a migration still
  // OUTSTANDING — and require the probe to leave it outstanding. `new Db()` re-adds the column.
  const staged = new Db(dbPath);
  staged.raw.exec("ALTER TABLE threads DROP COLUMN baseline_head");
  staged.raw.close();

  const threadColumns = (): string[] => {
    const d = new Database(dbPath, { readonly: true });
    const names = (d.prepare("PRAGMA table_info(threads)").all() as { name: string }[]).map((c) => c.name);
    d.close();
    return names;
  };
  check("precondition: a migration is pending on this database", !threadColumns().includes("baseline_head"));

  const before = statSync(dbPath);
  probe("milkshake");
  probe("kombucha");
  check("the probe does not migrate the database it reads", !threadColumns().includes("baseline_head"), threadColumns().join(","));
  check("...and leaves the file byte-for-byte alone", statSync(dbPath).size === before.size);
}

// ---- E. a column added later is searched, because columns are discovered ---------------------------
console.log("\nE. no rot — a text column added after this probe was written is still searched");
{
  const db2 = new Db(dbPath);
  db2.raw.exec("ALTER TABLE threads ADD COLUMN owner_note TEXT");
  db2.raw.prepare("UPDATE threads SET owner_note = 'remember the tamarind glaze' WHERE title = ?").run("Nightly crawl");
  db2.raw.close();
  const { out, code } = probe("tamarind");
  check("a brand-new column is searched without touching the probe", code === 0 && /threads\s+1 row\(s\)/.test(out), out.slice(0, 300));
}

rmSync(dir, { recursive: true, force: true });

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed`);
if (failed) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
