/**
 * Gate: every SQLite call is timed, a slow one is named in crash.log and blamed for the stall it caused,
 * and the timing never changes what a statement returns.
 *
 * Why this exists (2026-10-04): crash.log reported "event loop blocked 6x (worst 45.8s) — no tracked
 * operation was in flight" while an owner's injected message sat on "Sending…". Every SQLite call runs on
 * the server's only thread, and nothing named which one was slow. Both halves fail silently if dropped:
 * a wrapper that loses `this` or a return value breaks the whole Db, and one that never records leaves the
 * next stall as anonymous as the last.
 *
 * Run: npm run test:slow-statements   (free, no agent, no quota)
 */

import Database from "better-sqlite3";

const { instrumentStatements, drainSlowStatementReport } = await import("../db/slowStatements.js");
const { eventLoopHealth, recordBlockForTest, resetEventLoopMonitor } = await import("../eventLoopMonitor.js");
const { performance } = await import("node:perf_hooks");

let failures = 0;
function check(name: string, condition: unknown, detail?: string): void {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function countTools(db: Database.Database): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM t WHERE kind = 'tool'").get() as { n: number }).n;
}

console.log("\nresults pass through untouched");
const db = new Database(":memory:");
instrumentStatements(db, 0);
db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, kind TEXT)");
const insert = db.prepare("INSERT INTO t (kind) VALUES (?)");
const info = insert.run("tool");
check("run returns its RunResult", info.changes === 1 && info.lastInsertRowid === 1, JSON.stringify(info));
const addMany = db.transaction((kinds: string[]) => {
  for (const k of kinds) insert.run(k);
  return kinds.length;
});
check("a transaction returns its function's value", addMany(["tool", "text", "tool"]) === 3);
check("immediate transactions still work", addMany.immediate(["tool"]) === 1);
check("get reads through the wrapper", countTools(db) === 4, String(countTools(db)));
check("all reads through the wrapper", (db.prepare("SELECT kind FROM t ORDER BY id").all() as unknown[]).length === 5);
check("pluck and other statement modifiers survive", db.prepare("SELECT COUNT(*) FROM t").pluck().get() === 5);
check("pragma returns its value", db.pragma("user_version", { simple: true }) === 0);
let threw = false;
try {
  db.prepare("INSERT INTO missing VALUES (1)");
} catch {
  threw = true;
}
check("a statement error still throws", threw);
const rolledBack = db.transaction(() => {
  insert.run("rolled back");
  throw new Error("abort");
});
try {
  rolledBack();
} catch {
  /* expected */
}
check("a throwing transaction still rolls back", (db.prepare("SELECT COUNT(*) AS n FROM t").get() as { n: number }).n === 5);

console.log("\na slow statement is reported with its SQL and caller");
drainSlowStatementReport();
countTools(db);
const report = drainSlowStatementReport() ?? "";
check("the period report names the statement", report.includes("SELECT COUNT(*) AS n FROM t WHERE kind = 'tool'"), report);
check("the period report names the calling function", report.includes("countTools"), report);
check("the report drains, so a quiet period logs nothing", drainSlowStatementReport() === null);

console.log("\na stall overlapping a slow statement is blamed on it");
resetEventLoopMonitor();
const slow = new Database(":memory:");
instrumentStatements(slow, 50);
const started = performance.now();
slow.prepare("WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 20000000) SELECT COUNT(*) FROM c").get();
const took = performance.now() - started;
if (took < 50) {
  check("the busy statement took long enough to measure", false, `${took.toFixed(0)}ms`);
} else {
  recordBlockForTest(took, performance.now());
  const blame = eventLoopHealth().worstBlame ?? "";
  check("the stall's blame names the slow statement", blame.includes("WITH RECURSIVE c(x)"), blame);
}
drainSlowStatementReport();

console.log("\na fast statement stays out of the report");
const quiet = new Database(":memory:");
instrumentStatements(quiet);
quiet.prepare("SELECT 1").get();
check("nothing is reported for a sub-threshold call", drainSlowStatementReport() === null);

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nslow-statements: all checks passed");
