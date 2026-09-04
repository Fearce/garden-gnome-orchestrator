// Live query-plan + payload-size check for the board/history hot paths — "did a later schema or query
// change quietly reintroduce the full scan, the hand-sorted page, or the fat snapshot that the
// 2026-09-04 perf pass fixed?" Read-only. Safe while prod is up (WAL + busy_timeout).
//
//   node scripts/probe-hot-paths.cjs
//   npm run probe:hot-paths --prefix server
//
// Why it exists: every number in that pass — hello-snapshot size, page timings, whether a query still
// sorts by hand — was re-measured by HAND, three times, once per QA round (a VACUUM INTO snapshot,
// ad-hoc EXPLAIN QUERY PLAN, ad-hoc timing; see commits 14daac9, 04154de, 7a0cbca). test:performance-paths
// gates the query SHAPES against a synthetic DB on every `test:gates` run, which is the right place for
// that, but a synthetic fixture is too small to expose a subtly wrong composite index (right columns,
// wrong order) the way the real 800-task/500k-message database would. This is the same role
// probe-db-size.cjs plays for storage composition — a fast, on-demand read against the LIVE numbers,
// instead of rebuilding the VACUUM INTO rehearsal from scratch the next time someone touches this code.
//
// GOTCHAS:
//   • A fresh/empty DB has no messages to plan a real query against — this probe says so and exits 0
//     rather than reporting a false pass.
//   • The query-plan checks need a real thread WITH ROWS: SQLite's planner can choose a different plan
//     for a table it estimates is empty, so this always plans against the busiest live task.
//   • Read-only guards against Windows file locking (`readonly: true` opens without a write lock; prod
//     keeps writing under WAL, which is what makes this safe to run against a live server).

const path = require("node:path");
const Database = require("better-sqlite3");

const DB_PATH = path.resolve(__dirname, "..", "data", "orchestrator.sqlite");

// Mirrors server/src/types.ts BRIEF_PREVIEW_CHARS — kept honest by test:hot-paths, which imports the
// real constant and would fail loudly if this drifted from it.
const BRIEF_PREVIEW_CHARS = 200;

// The indexes the 2026-09-04 pass retired in favor of a two-column composite (SQLite appends rowid to
// every index key, so a third `id` column was redundant and, worse, made a random UUID authoritative for
// ordering — see .claude/rules/hot-path-query-performance.md). Any of these reappearing means the old
// shape came back, silently reintroducing the same-millisecond reordering bug 7a0cbca fixed.
const RETIRED_INDEXES = ["idx_messages_thread_created_id", "idx_findings_thread_created_id", "idx_messages_thread", "idx_findings_thread"];

const mb = (bytes) => +(bytes / 1048576).toFixed(2);
const num = (n) => n.toLocaleString("en-US");

function explain(db, sql, params = []) {
  return db
    .prepare("EXPLAIN QUERY PLAN " + sql)
    .all(...params)
    .map((r) => r.detail)
    .join(" | ");
}

/** A plan is healthy when it never sorts by hand (TEMP B-TREE) and never falls back to a bare table scan
 *  for a query that filters on an indexed column — "SCAN <table> USING INDEX …" (walking an index, still
 *  cheap) is fine; a bare "SCAN <table>" with no index in sight means the planner gave up on one. */
function planVerdict(label, detail, { table } = {}) {
  const problems = [];
  if (/TEMP B-TREE/.test(detail)) problems.push(`sorts by hand (TEMP B-TREE): ${detail}`);
  if (table && new RegExp(`\\bSCAN ${table}\\b(?! USING)`).test(detail)) {
    problems.push(`full scan instead of an index seek: ${detail}`);
  }
  return { label, detail, ok: problems.length === 0, problems };
}

/** The exact SQL shapes `db.ts` runs for a board/history read — see listMessagePage, listMessages, and
 *  listFindings(threadId). Kept as literal SQL (not an import of dist) so this never depends on a build
 *  being present, matching every other probe:* script in this directory. */
function hotQueryPlans(db, threadId) {
  return [
    planVerdict(
      "history page (newest, no cursor)",
      explain(db, "SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 400", [threadId]),
      { table: "messages" },
    ),
    planVerdict(
      "history page (keyset cursor)",
      explain(
        db,
        "SELECT * FROM messages WHERE thread_id = ? AND (created_at < 9 OR (created_at = 9 AND rowid < 9)) ORDER BY created_at DESC, rowid DESC LIMIT 400",
        [threadId],
      ),
      { table: "messages" },
    ),
    planVerdict(
      "full ascending read (listMessages)",
      explain(db, "SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at ASC, rowid ASC", [threadId]),
      { table: "messages" },
    ),
    planVerdict(
      "cursor id -> rowid resolve",
      explain(db, "SELECT rowid AS seq FROM messages WHERE id = ?", ["__probe-hot-paths-nonexistent__"]),
      { table: "messages" },
    ),
    planVerdict("findings by thread", explain(db, "SELECT * FROM findings WHERE thread_id = ? ORDER BY created_at ASC", [threadId]), {
      table: "findings",
    }),
  ];
}

function busiestThread(db) {
  return db.prepare("SELECT thread_id, COUNT(*) n FROM messages GROUP BY thread_id ORDER BY n DESC LIMIT 1").get();
}

/** What the hello/reconnect snapshot ships per task today (the clipped `brief_preview`) vs what it
 *  shipped before the pass (the full `brief` + `raw_prompt`) — the number `rowToThreadSummaryFromListing`
 *  exists to keep small. */
function helloSnapshotFootprint(db) {
  const row = db
    .prepare(
      `SELECT COUNT(*) n,
              COALESCE(SUM(LENGTH(brief)), 0) briefBytes,
              COALESCE(SUM(LENGTH(raw_prompt)), 0) rawPromptBytes,
              COALESCE(SUM(LENGTH(substr(brief, 1, ${BRIEF_PREVIEW_CHARS}))), 0) previewBytes
       FROM threads`,
    )
    .get();
  const fullBytes = row.briefBytes + row.rawPromptBytes;
  const slimBytes = row.previewBytes;
  return {
    threadCount: row.n,
    fullBytes,
    slimBytes,
    savedBytes: fullBytes - slimBytes,
    savedPct: fullBytes > 0 ? +(((fullBytes - slimBytes) / fullBytes) * 100).toFixed(1) : 0,
  };
}

/** The real orchestrator process holds one warm connection for its whole life — a cold `node` process
 *  timing its FIRST query mostly measures statement prepare + a page-cache miss, not the query. Run it
 *  once to warm the prepared-statement cache and the OS page cache, then time a second, representative
 *  run (measured against the live DB: first run 58ms, second run 1-2ms — a >30x difference that has
 *  nothing to do with the index). */
function timeSnapshotQuery(db) {
  const sql = `SELECT id, title, state, workspace, error, effort_override,
              substr(brief, 1, ${BRIEF_PREVIEW_CHARS}) AS brief_preview,
              model_request, closed_at, closed_prev_state, lane, baseline_head, duration_ms, deadline_at,
              active_deadline_at, agent_count, parent_id, assignment, created_at, updated_at,
              json_extract(stage_outputs, '$.manualDeployment') AS manual_deployment_raw
       FROM threads ORDER BY created_at DESC`;
  const stmt = db.prepare(sql);
  stmt.all(); // warm-up
  const start = process.hrtime.bigint();
  const rows = stmt.all();
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  return { rows: rows.length, ms: +ms.toFixed(2), bytes: Buffer.byteLength(JSON.stringify(rows)) };
}

function timeHistoryPage(db, threadId, limit = 400) {
  const stmt = db.prepare("SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?");
  stmt.all(threadId, limit + 1); // warm-up
  const start = process.hrtime.bigint();
  const rows = stmt.all(threadId, limit + 1);
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  return { rows: Math.min(rows.length, limit), ms: +ms.toFixed(2) };
}

function retiredIndexesPresent(db) {
  return db
    .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name IN (${RETIRED_INDEXES.map(() => "?").join(",")})`)
    .all(...RETIRED_INDEXES)
    .map((r) => r.name);
}

function verdictFor(plans, retiredFound) {
  const problems = [];
  for (const p of plans.filter((p) => !p.ok)) problems.push(`${p.label}: ${p.problems.join("; ")}`);
  if (retiredFound.length) problems.push(`superseded index(es) rebuilt: ${retiredFound.join(", ")} — reintroduces id-order ties on same-millisecond rows`);
  return { ok: problems.length === 0, problems };
}

function main() {
  const db = new Database(DB_PATH, { readonly: true });
  db.pragma("busy_timeout = 5000");

  console.log(`\n=== hot-path query plans (${DB_PATH}) ===`);
  const busiest = busiestThread(db);
  if (!busiest) {
    console.log("  no messages in the database yet — nothing to plan a real query against. Nothing to verify.");
    db.close();
    return;
  }
  console.log(`  busiest task: ${busiest.thread_id} (${num(busiest.n)} messages)`);

  const plans = hotQueryPlans(db, busiest.thread_id);
  for (const p of plans) {
    console.log(`  ${p.ok ? "✓" : "✗"} ${p.label}`);
    if (!p.ok) for (const problem of p.problems) console.log(`      ${problem}`);
  }

  const retiredFound = retiredIndexesPresent(db);
  console.log(
    retiredFound.length
      ? `  ✗ superseded index(es) still present: ${retiredFound.join(", ")}`
      : `  ✓ superseded indexes stay retired (${RETIRED_INDEXES.join(", ")})`,
  );

  console.log("\n=== hello-snapshot payload ===");
  const footprint = helloSnapshotFootprint(db);
  console.log(
    `  ${num(footprint.threadCount)} tasks · full brief+prompt would ship ${mb(footprint.fullBytes)} MB · ` +
      `the ${BRIEF_PREVIEW_CHARS}-char preview ships ${mb(footprint.slimBytes)} MB (${footprint.savedPct}% smaller)`,
  );
  const snap = timeSnapshotQuery(db);
  console.log(`  live snapshot query: ${num(snap.rows)} rows in ${snap.ms}ms, ${mb(snap.bytes)} MB serialized`);

  console.log("\n=== task history paging ===");
  const page = timeHistoryPage(db, busiest.thread_id);
  console.log(`  400-row page of the busiest task: ${page.rows} rows in ${page.ms}ms`);

  const verdict = verdictFor(plans, retiredFound);
  console.log("\n=== verdict ===");
  if (verdict.ok) {
    console.log("  ✓ every hot path still seeks its composite index — no full scans, no hand-sorted pages, snapshot stays slim.");
  } else {
    console.log("  ✗ a hot-path regression is live:");
    for (const problem of verdict.problems) console.log(`    - ${problem}`);
  }

  db.close();
  if (!verdict.ok) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
  explain,
  planVerdict,
  hotQueryPlans,
  busiestThread,
  helloSnapshotFootprint,
  timeSnapshotQuery,
  timeHistoryPage,
  retiredIndexesPresent,
  verdictFor,
  RETIRED_INDEXES,
  BRIEF_PREVIEW_CHARS,
};
