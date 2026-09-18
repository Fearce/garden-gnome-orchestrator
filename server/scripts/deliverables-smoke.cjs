// "Can I see my deliverables?": the one command to run when the answer feels like no.
//
//   npm run smoke:deliverables --prefix server
//   npm run smoke:deliverables --prefix server -- --task 6cf6f87c     # one task, by id prefix or title
//   npm run smoke:deliverables --prefix server -- --data-only         # skip the browser half
//
// WHY IT EXISTS. "I cannot see deliverables" was reported three times, and each round answered a
// DIFFERENT half of the question, which is why each fix felt complete and the owner kept reporting it:
//   2026-09-14  the cards were being computed from the capped feed, so long tasks evicted their own.
//               Fixed in the store. The data half became healthy and stayed healthy.
//   2026-09-18  the strip was rendering thousands of pixels above the viewport (y=-13347px on a real
//               task), because it sat inside the panel's autoscrolling scrollport. Nothing in the data
//               was wrong, so every check that existed stayed green through the entire regression.
// The lesson is that the question has two halves and a probe for one of them cannot see the other:
//   1. DATA:      does this task have deliverable rows, and would the route actually serve them?
//   2. PLACEMENT: does the console put the strip somewhere a human can see it?
// This script asks both and prints one verdict, so the owner never has to know which half broke.
//
// Half 1 is read-only against the LIVE store and reuses `probe-deliverables.cjs`'s classifier rather
// than restating it, so its verdict stays the HTTP status the owner would really get. For the full
// per-card census (every dead card, every reason) run `npm run probe:deliverables` instead; this only
// reports the totals plus anything born broken.
//
// Half 2 shells out to `panel-scroll-lab.cjs`, which boots its OWN throwaway instance and measures the
// strip's real geometry in a real browser. It is deliberately NOT a second copy of that measurement:
// one place owns "where does the strip land", and this reads its answer. It filters to the deliverables
// checks on purpose, so an unrelated red elsewhere in that lab cannot make this read as "your files are
// gone" (the director-rail check, for one, is its own long-standing question about another panel).
//
// Safe against prod: half 1 opens the database read-only, half 2 touches a throwaway instance on its
// own port and never the live one. Neither writes anything, and no browser is pointed at :4317.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const Database = require("better-sqlite3");
const { classifyDeliverable, verdictFor } = require("./probe-deliverables.cjs");

const SERVER_ROOT = path.resolve(__dirname, "..");
const DB_PATH = path.join(SERVER_ROOT, "data", "orchestrator.sqlite");

/** The width half 2 measures at. One desktop band is enough for a smoke check; the full five-viewport
 *  sweep is the gate (`npm run panel-scroll-lab --prefix server`), which this deliberately is not. */
const SMOKE_WIDTH = 1280;

/** How many recent card-carrying tasks to name when no `--task` was given. Enough to recognise the one
 *  you are looking for, short enough that the verdict stays the thing you read. */
const RECENT_TASKS = 8;

function parseArgs(argv) {
  const args = { task: null, dataOnly: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--task") args.task = argv[++i];
    else if (argv[i] === "--data-only") args.dataOnly = true;
  }
  return args;
}

/** Every deliverable row, with the owning task, newest first. Matches `--task` against the id PREFIX or
 *  a title substring, which is how every other probe here is addressed. */
function loadRows(db, taskQuery) {
  const rows = db
    .prepare(
      `SELECT f.id, f.thread_id, f.label, f.summary, f.path, f.created_at,
              t.title, t.state, t.workspace
         FROM findings f JOIN threads t ON t.id = f.thread_id
        WHERE f.kind = 'deliverable'
        ORDER BY f.created_at DESC`,
    )
    .all();
  if (!taskQuery) return rows;
  const q = taskQuery.toLowerCase();
  return rows.filter((r) => r.thread_id.toLowerCase().startsWith(q) || (r.title ?? "").toLowerCase().includes(q));
}

/** Half 1: do the cards exist, and would the route serve them? Returns a summary plus the born-broken
 *  ones, which are the only class this smoke check treats as a failure (a file the owner has since
 *  deleted is housekeeping, exactly as `probe:deliverables` decides it). */
function checkData(args) {
  if (!fs.existsSync(DB_PATH)) {
    console.log(`  x no database at ${DB_PATH}`);
    return { ok: false, cards: 0, tasks: 0 };
  }
  const db = new Database(DB_PATH, { readonly: true });
  db.pragma("busy_timeout = 4000");
  let rows;
  try {
    rows = loadRows(db, args.task);
  } finally {
    db.close();
  }

  if (!rows.length) {
    const scope = args.task ? `task matching "${args.task}"` : "the whole store";
    console.log(`  ! no deliverable cards on ${scope}.`);
    console.log("    Nothing is broken here: that task's agents never surfaced a file. A task whose");
    console.log("    implementor errored or was interrupted usually never reached its deliverables pass.");
    return { ok: true, cards: 0, tasks: 0, empty: true };
  }

  // `createdAt` is what `verdictFor` ages a card by, and the column is snake_case.
  const classified = rows.map((r) => ({ ...r, createdAt: r.created_at, ...classifyDeliverable(r) }));
  const tasks = new Set(classified.map((c) => c.thread_id));

  // The red/amber policy is NOT restated here. `probe:deliverables` owns it, and it is deliberate: a
  // card born broken in the last week is a defect still happening, while an old escape or a file the
  // owner has since deleted is history or housekeeping. Deciding that again locally is how a check
  // ends up permanently red over years of history and stops being read.
  const verdict = verdictFor(classified);

  console.log(
    `  ${verdict.fatal ? "x" : "OK"} ${verdict.total} card(s) across ${tasks.size} task(s): ` +
      `${verdict.servable} serve, ${verdict.broken} do not`,
  );
  for (const p of verdict.problems) console.log(`    ${p.fatal ? "x" : "!"} ${p.text}`);
  if (verdict.problems.length) {
    console.log("      Per-card detail: `npm run probe:deliverables --prefix server`.");
  }

  // Name the tasks, so the owner can match what this says against what the console shows them.
  const perTask = new Map();
  for (const c of classified) {
    if (!perTask.has(c.thread_id)) perTask.set(c.thread_id, { title: c.title, state: c.state, n: 0, ok: 0 });
    const e = perTask.get(c.thread_id);
    e.n++;
    if (c.class === "ok") e.ok++;
  }
  const listed = [...perTask.entries()].slice(0, args.task ? perTask.size : RECENT_TASKS);
  console.log(`\n  ${args.task ? "Matching" : `Most recent ${listed.length}`} task(s) with cards:`);
  for (const [id, e] of listed) {
    console.log(
      `    ${id.slice(0, 8)}  ${String(e.ok + "/" + e.n).padStart(6)} serve  ${(e.state ?? "?").padEnd(10)} ${(e.title ?? "").slice(0, 52)}`,
    );
  }
  return { ok: !verdict.fatal, cards: verdict.total, tasks: tasks.size };
}

/** Half 2: does the console actually put the strip on screen? Delegates the measurement to the lab and
 *  reads back only its deliverables verdicts, so this never becomes a second, drifting copy of them. */
function checkPlacement() {
  const lab = path.join(__dirname, "panel-scroll-lab.cjs");
  const res = spawnSync(process.execPath, [lab, "--width", String(SMOKE_WIDTH)], {
    cwd: SERVER_ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  const lines = out.split(/\r?\n/).filter((l) => /deliverab|the strip /i.test(l) && /[✓✗]/.test(l));

  if (!lines.length) {
    console.log("  x the placement lab produced no deliverables verdicts. Its own output:");
    console.log(
      out
        .split(/\r?\n/)
        .slice(-15)
        .map((l) => `      ${l}`)
        .join("\n"),
    );
    return { ok: false, passed: 0, failed: 0 };
  }
  const failed = lines.filter((l) => l.includes("✗"));
  const passed = lines.length - failed.length;
  console.log(`  ${failed.length ? "x" : "OK"} ${passed}/${lines.length} placement check(s) pass at ${SMOKE_WIDTH}px`);
  for (const f of failed) console.log(`    ${f.trim()}`);
  if (!failed.length) {
    // Echo the measured position: a bare tick is what the last three rounds all produced.
    const onScreen = lines.find((l) => /is on screen when the panel opens/.test(l));
    if (onScreen) console.log(`    ${onScreen.trim()}`);
  }
  return { ok: failed.length === 0, passed, failed: failed.length };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log("deliverables smoke check\n");

  console.log("1. DATA: do the cards exist, and would the server serve them?");
  const data = checkData(args);

  let placement = { ok: true, skipped: true };
  if (!args.dataOnly) {
    console.log("\n2. PLACEMENT: does the console put the strip where a human can see it?");
    console.log("   (boots a throwaway instance and drives a real browser; ~1 minute, never touches :4317)");
    placement = checkPlacement();
  }

  console.log("\n=== verdict ===");
  if (!data.ok) {
    console.log("  x A card was born broken RECENTLY: the path an agent posted can never be served.");
    console.log("    That is an emission bug, not a console one. `npm run probe:deliverables --prefix server`.");
  } else if (!placement.ok) {
    console.log("  x The data is fine and the console is hiding it. That is the 2026-09-18 class of bug:");
    console.log("    the strip renders but lands off screen. See `.claude/rules/deliverables.md`.");
  } else if (data.empty) {
    console.log("  ! Nothing to show for that query, and nothing broken. The task surfaced no files.");
  } else if (placement.skipped) {
    console.log(`  OK ${data.cards} card(s) across ${data.tasks} task(s) are serveable. Placement not checked (--data-only).`);
  } else {
    console.log(`  OK ${data.cards} card(s) across ${data.tasks} task(s) are serveable, and the console shows the strip.`);
  }
  process.exitCode = data.ok && placement.ok ? 0 : 1;
}

if (require.main === module) main();

module.exports = { checkData, checkPlacement, SMOKE_WIDTH };
