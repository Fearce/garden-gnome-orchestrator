// What is actually IN the database, by BYTES — "it's 297 MB, what is that, and is any of it waste?".
// Read-only. Safe while prod is up (WAL + busy_timeout).
//
//   node scripts/probe-db-size.cjs
//   npm run probe:db-size --prefix server
//
// Why it exists: DB growth is the sweep's one standing watch-item that had no probe. Every other one
// does (probe:accounts, probe:parks, probe:run-errors), so growth was tracked in hand-written prose in
// project memory — and the prose drifted into being WRONG and stayed wrong across several sweeps. It
// claimed `messages` was "the bulk" because `messages` has by far the most ROWS. By bytes the bulk was
// `attachments`: 183 MB of a 291.7 MB file from 337 rows, 75 MB of which was the same pictures stored
// over and over (fixed 2026-08-05, `1cd7154`). Counting rows cannot find that. `dbstat` can.
//
// So this prints the composition by bytes, the growth rate, and then the checks that would have caught
// that defect on the day it appeared rather than months later:
//   • duplicate attachment blobs — keyed EXACTLY as db.ts `addAttachment` keys its dedupe
//     (sha256 + name + media_type). Any hit means content-addressing regressed. That is a code defect,
//     so it EXITS NON-ZERO.
//   • attachment rows with no sha256 — an insert path that bypassed `addAttachment` entirely.
//   • orphaned blobs nothing references — the pruning in deleteThread/resetThreadForRetry regressed, or
//     a crash landed between storing bytes and writing the message that points at them. Reported as a
//     warning, not a failure: the second case is a real (rare) possibility that no code change prevents.
//
// GOTCHAS:
//   • Free pages are NOT waste and NOT a leak. SQLite reuses them for new writes, so a file with free
//     space simply stops growing for a while — a VACUUM would only shrink the file on disk, and it needs
//     an exclusive lock on a live database to do it. Reported as headroom, never as something to fix.
//   • `dbstat` is a virtual table that must be compiled in. better-sqlite3 ships it, but degrade to the
//     row-count view rather than crashing the sweep if a future build drops it.

const path = require("node:path");
const Database = require("better-sqlite3");

const DB_PATH = path.resolve(__dirname, "..", "data", "orchestrator.sqlite");
const MB = 1048576;
const GROWTH_WINDOW_DAYS = 7;

const mb = (bytes) => +(bytes / MB).toFixed(1);
const num = (n) => n.toLocaleString("en-US");

/** Bytes per table, with each index folded into the table it serves — an index is that table's cost,
 *  and listing `idx_messages_thread` as its own line just hides where the weight really is. */
function tableSizes(db) {
  const rows = db.prepare("SELECT name, SUM(pgsize) bytes FROM dbstat GROUP BY name").all();
  const owners = new Map(
    db
      .prepare("SELECT name, tbl_name FROM sqlite_master WHERE type IN ('table','index')")
      .all()
      .map((r) => [r.name, r.tbl_name]),
  );
  const totals = new Map();
  for (const r of rows) {
    const owner = owners.get(r.name) ?? r.name;
    const cur = totals.get(owner) ?? { table: owner, bytes: 0, indexBytes: 0 };
    cur.bytes += r.bytes;
    if (r.name !== owner) cur.indexBytes += r.bytes;
    totals.set(owner, cur);
  }
  return [...totals.values()].sort((a, b) => b.bytes - a.bytes);
}

/** The three ways the attachment store can be wrong, each mapped to what it means. Duplicates are keyed
 *  the way `addAttachment` keys its dedupe, so a legitimately distinct row (same bytes deliberately kept
 *  under another filename, which is served back to the browser) is never miscounted as waste. */
function attachmentRedundancy(db) {
  const dup = db
    .prepare(
      `SELECT COALESCE(SUM(n - 1), 0) rows, COALESCE(SUM((n - 1) * bytes), 0) bytes FROM (
         SELECT COUNT(*) n, MAX(LENGTH(data)) bytes FROM attachments
         GROUP BY sha256, name, media_type HAVING COUNT(*) > 1)`,
    )
    .get();
  const unhashed = db.prepare("SELECT COUNT(*) n FROM attachments WHERE sha256 IS NULL").get();

  const referenced = new Set();
  for (const table of ["messages", "director_messages"]) {
    for (const r of db.prepare(`SELECT attachments FROM ${table} WHERE attachments != '[]'`).all()) {
      try {
        for (const a of JSON.parse(r.attachments)) if (a && a.id) referenced.add(a.id);
      } catch {
        /* a malformed JSON blob is not this probe's business */
      }
    }
  }
  let orphanRows = 0;
  let orphanBytes = 0;
  for (const r of db.prepare("SELECT id, LENGTH(data) bytes FROM attachments").all()) {
    if (!referenced.has(r.id)) {
      orphanRows++;
      orphanBytes += r.bytes;
    }
  }
  return {
    duplicateRows: dup.rows,
    duplicateBytes: dup.bytes,
    unhashedRows: unhashed.n,
    orphanRows,
    orphanBytes,
    referenced: referenced.size,
  };
}

/** Rows and content bytes added per day over the window, from the tables that actually grow. */
function growthPerDay(db, days = GROWTH_WINDOW_DAYS) {
  const since = Date.now() - days * 86400_000;
  const per = (table) =>
    db.prepare(`SELECT COUNT(*) rows, COALESCE(SUM(LENGTH(content)), 0) bytes FROM ${table} WHERE created_at >= ?`).get(since);
  const messages = per("messages");
  const attachments = db
    .prepare("SELECT COUNT(*) rows, COALESCE(SUM(LENGTH(data)), 0) bytes FROM attachments WHERE created_at >= ?")
    .get(since);
  return {
    days,
    messagesPerDay: Math.round(messages.rows / days),
    bytesPerDay: Math.round((messages.bytes + attachments.bytes) / days),
    attachmentsPerDay: +(attachments.rows / days).toFixed(1),
  };
}

/** How long the free pages absorb new writes before the FILE grows again. Null when nothing is growing
 *  (a fresh or idle DB) — printing "Infinity days of headroom" would read as a measurement. */
function headroomDays(freeBytes, bytesPerDay) {
  if (!bytesPerDay || bytesPerDay <= 0) return null;
  return Math.floor(freeBytes / bytesPerDay);
}

/** Only a regression in code is a failure. Growth is information, and an orphan can be a crash artifact. */
function verdictFor(redundancy) {
  const problems = [];
  if (redundancy.duplicateRows > 0) {
    problems.push({
      fatal: true,
      text:
        `${num(redundancy.duplicateRows)} duplicate attachment row(s) holding ${mb(redundancy.duplicateBytes)} MB — ` +
        "content-addressing in db.ts addAttachment has regressed (gate: test:attachment-dedupe)",
    });
  }
  if (redundancy.unhashedRows > 0) {
    problems.push({
      fatal: true,
      text: `${num(redundancy.unhashedRows)} attachment row(s) with no sha256 — something inserted bytes without going through addAttachment`,
    });
  }
  if (redundancy.orphanRows > 0) {
    problems.push({
      fatal: false,
      text:
        `${num(redundancy.orphanRows)} orphaned blob(s) holding ${mb(redundancy.orphanBytes)} MB — nothing references them; ` +
        "either the prune in deleteThread/resetThreadForRetry regressed, or a crash landed mid-write",
    });
  }
  return { problems, ok: problems.length === 0, fatal: problems.some((p) => p.fatal) };
}

function main() {
  const db = new Database(DB_PATH, { readonly: true });
  db.pragma("busy_timeout = 5000");

  const pageSize = db.pragma("page_size", { simple: true });
  const pageCount = db.pragma("page_count", { simple: true });
  const freelist = db.pragma("freelist_count", { simple: true });
  const fileBytes = pageSize * pageCount;
  const freeBytes = pageSize * freelist;

  console.log(`\n=== database (${DB_PATH}) ===`);
  console.log(`  ${mb(fileBytes)} MB on disk · ${mb(freeBytes)} MB free inside it`);
  console.log("  ↳ free pages are reused by new writes, so they are headroom, not waste — nothing to reclaim");

  console.log("\n=== what is in it, by BYTES (row count hides the answer) ===");
  let sizes = [];
  try {
    sizes = tableSizes(db);
  } catch (err) {
    console.log(`  ⚠ dbstat unavailable (${err.message}) — falling back to row counts, which cannot see blob weight`);
  }
  for (const t of sizes.slice(0, 8)) {
    let rows = "";
    try {
      rows = `${num(db.prepare(`SELECT COUNT(*) n FROM ${t.table}`).get().n)} rows`;
    } catch {
      rows = "—";
    }
    const idx = t.indexBytes ? ` (incl. ${mb(t.indexBytes)} MB of indexes)` : "";
    console.log(`  ${String(mb(t.bytes)).padStart(7)} MB  ${t.table.padEnd(20)} ${rows}${idx}`);
  }

  const growth = growthPerDay(db);
  const days = headroomDays(freeBytes, growth.bytesPerDay);
  console.log(`\n=== growth (last ${growth.days}d) ===`);
  console.log(`  ${num(growth.messagesPerDay)} messages/day · ${growth.attachmentsPerDay} attachments/day · ~${mb(growth.bytesPerDay)} MB/day of content`);
  console.log(
    days === null
      ? "  nothing is being written — no growth to project"
      : `  the free space absorbs ~${num(days)} more day(s) of that before the file itself grows`,
  );

  const redundancy = attachmentRedundancy(db);
  const verdict = verdictFor(redundancy);
  console.log("\n=== stored-image integrity ===");
  console.log(`  ${num(redundancy.referenced)} distinct picture(s) referenced from messages + director messages`);
  if (verdict.ok) {
    console.log("  ✓ every picture stored once, all hashed, none orphaned");
  } else {
    for (const p of verdict.problems) console.log(`  ${p.fatal ? "✗" : "⚠"} ${p.text}`);
  }

  console.log("\n=== verdict ===");
  if (verdict.fatal) {
    console.log("  ✗ a storage regression is live — the numbers above are a code defect, not growth.");
  } else if (!verdict.ok) {
    console.log("  ⚠ nothing is broken, but see the warning above.");
  } else {
    console.log("  ✓ nothing wasted. Any further reduction is a retention DECISION for the owner, not a bug.");
  }

  db.close();
  if (verdict.fatal) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { tableSizes, attachmentRedundancy, growthPerDay, headroomDays, verdictFor };
