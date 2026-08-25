// Name every task parked in `review` — and every task abandoned in `failed` — and say WHICH KIND it is:
// "the sweep says N threads are parked, what are they and does any need me?". Read-only. Safe while prod
// is up (WAL + busy_timeout).
//
//   node scripts/probe-parks.cjs
//   npm run probe:parks --prefix server
//
// Why it exists: `npm run health` ends most sweeps on `⚠ N thread(s) parked … read the thread error for
// the reason` — and then offers no way to read it, so every sweep hand-writes the same SQLite query
// (twice in the 2026-07-30 sweep alone) to recover ids the last handoff had already written down by hand.
// This is that query, with the classification health can't fit on one line.
//
// The distinction that matters is NOT "QA vs human". It is:
//   • the pipeline STOPPED mid-verification (QA couldn't complete, an auto-review reached no verdict, a
//     resume failed to start) — the work may well be finished; nothing is coming back for it on its own,
//     so a Resume or Auto-review is what clears it; and
//   • the pipeline FINISHED and is asking for a verdict (QA rounds exhausted, QA found issues it wouldn't
//     fix, an implementor handing off) — by design, and not a defect however long it sits.
// Health lumped every non-QA park into the second group, so a "Resume failed to start" read as a normal
// hand-off. `classifyPark` is exported and health imports it, so the two can never disagree again.
//
// GOTCHAS:
//   • The park text IS the classification input — these are `settleReview`/`setState` literals in
//     orchestrator/threadManager.ts. Rewording one silently demotes its class, which is why the gate
//     (scripts/parks-classify.test.cjs) pins the markers against that file.
//   • A park is NOT time-bounded: `review` threads sit until a human acts, so this window is all-time,
//     unlike probe:run-errors. Oldest first — the forgotten one is the one at the top.
//   • `⏳ Auto-resume pending` is the only class nobody should touch: the cap supervisor unparks it
//     within ~2m of any backend freeing up. Acting on it manually races that.
//   • `review` is not the only state that waits on a person. A restart leaves its casualties in `failed`,
//     and NO sweep step read that state until 2026-08-10 — nine of them had accumulated, two stranded
//     mid-work for two days (that night's own nightly sweep among them) because the auto-resume they were
//     promised died with the process that promised it. Same question, different state, so it is classified
//     here rather than in a probe of its own.

const path = require("node:path");
const Database = require("better-sqlite3");

const { recoveryAnnotationFor } = require("./recovery-features.cjs");

const DB_PATH = path.resolve(__dirname, "..", "data", "orchestrator.sqlite");

// Every marker below is a literal `settleReview`/`setState(…,"review")` message in
// orchestrator/threadManager.ts — the park texts, not invented phrasings. Apostrophes are matched both
// ways because the source mixes ASCII and typographic ones.
const STALL_MARKERS = [
  /QA could not complete/i, // the QA round itself never produced a verdict
  /Reader could not complete/i,
  /disposition was lost to a restart/i, // a reader answer that a bounce ate — re-dispatch
  /Reader escalated to the full pipeline/i, // read lane refused it; nothing re-dispatches on its own
  /Resume failed to start/i,
  /Auto-review failed to run/i,
  /could\s?n(?:o|['’])t reach a verdict/i, // auto-review ran but settled nothing
  /fix round did\s?n(?:o|['’])t finish/i, // the implementor round an auto-review hand-back started never completed
  // A bounce during an auto-review or its fix round. The lane is in-process by design, so nothing resumes
  // it on its own — only a fresh Auto-review click does, which is exactly what `stalled` means.
  /Auto-review was (?:interrupted by a server restart|fixing the issues it found)/i,
];

// The pipeline finished and handed the call to the owner. Long-lived by design; never a defect.
const VERDICT_MARKERS = [
  /needs your review/i, // the generic tail on most owner hand-offs
  /still not satisfied/i,
  /unresolved issues/i,
  /needs an independent re-check/i, // QA edited in its final round, so QA can't be its own reviewer
  /Auto-review did\s?n(?:o|['’])t accept/i,
];

/**
 * How a park reads, in priority order — first match wins, so a message carrying both a stall marker and
 * the generic "needs your review" tail classifies as the stall it actually is.
 *
 * `human: false` means something automated still owes this task a run; the rest are waiting on the owner,
 * and only `stalled` is waiting on the owner *unexpectedly*.
 */
const PARK_CLASSES = [
  {
    key: "capWait",
    human: false,
    title: "waiting on a free backend — leave it alone",
    match: (err) => err.includes("⏳ Auto-resume pending"),
    action: "the cap supervisor resumes it within ~2m of any backend freeing up (probe:accounts shows the ladder)",
  },
  {
    key: "stalled",
    human: true,
    title: "the pipeline could not finish verifying — needs a nudge",
    match: (err) => STALL_MARKERS.some((re) => re.test(err)),
    action: "read the reason below, then Resume (or Auto-review) — the work itself is often complete",
  },
  {
    key: "verdict",
    human: true,
    title: "finished, awaiting your verdict — by design",
    match: (err) => VERDICT_MARKERS.some((re) => re.test(err)),
    action: "yours to call: Mark done, Auto-review, or send it back with a note",
  },
  {
    key: "unknown",
    human: true,
    title: "unrecognized park text — classification may have drifted",
    match: () => true,
    action: "if this is a normal park, add its marker to PARK_CLASSES so health can count it correctly",
  },
];

/** The class a park message falls into. Never throws: a null/empty error still classifies (as unknown). */
function classifyPark(error) {
  const err = error ?? "";
  return PARK_CLASSES.find((c) => c.match(err)) ?? PARK_CLASSES[PARK_CLASSES.length - 1];
}

/**
 * The same question for a thread left in `failed`: is something still owed, or is this the owner's?
 *
 * `markInterrupted` is what writes almost all of them — a restart either promises an auto-resume or hands
 * the task back for a click. The promise is the one that matters: it is the only state that claims a run
 * is COMING, so one still sitting here means it never arrived.
 */
const ABANDON_CLASSES = [
  {
    key: "promised",
    human: true,
    title: "promised an auto-resume that never arrived — needs a nudge",
    match: (err) => /interrupted by a server restart\s+—\s+auto-resuming/i.test(err),
    action: "a bounce landed inside the 4s resume window; the next boot re-arms it (3 attempts) — if one is still here, Resume it",
  },
  {
    key: "clickResume",
    human: true,
    title: "a restart handed it back for a click — by design",
    match: (err) => /interrupted by (?:a )?server restart/i.test(err) || /Auto-resume stopped/i.test(err),
    action: "yours to call: Resume to continue from where it left off (finished stages are reused), or dismiss it",
  },
  {
    key: "otherFailure",
    human: true,
    title: "failed for some other reason — unclassified",
    match: () => true,
    action: "read the reason below; if it is a normal outcome, add its marker to ABANDON_CLASSES",
  },
];

/** How an abandoned (`failed`) thread reads. Never throws: a null/empty error classifies as otherFailure. */
function classifyAbandoned(error) {
  const err = error ?? "";
  return ABANDON_CLASSES.find((c) => c.match(err)) ?? ABANDON_CLASSES[ABANDON_CLASSES.length - 1];
}

/** Which QA recovery budget a park says was exhausted — i.e. the mechanism ran and still couldn't finish,
 *  a genuine hand-off rather than a reason to just retry it — or null when it names neither. QA has TWO
 *  such budgets and this only knew the turn-ceiling one, so an empty-run exhaustion got no `↳` line at all
 *  and cost the sweep a hand-drill (7d776461, 2026-08-25). Checked in the order `qaRecoveryNotes` writes
 *  them, so a park that spent both reports the continuations. */
function spentRecoveryBudget(error) {
  const e = error ?? "";
  if (/cut off again each time/i.test(e)) return "cutoff";
  // Matches the pre-f693278 wording too ("A review in this task also came back empty …"): those parks are
  // still in the table, and a classifier that only knows the current sentence re-opens the same hole.
  if (/restarted on a fresh session/i.test(e)) return "silent";
  return null;
}

/** The `↳` verdicts a sweep acts on by NOT acting — one per exhaustible budget, because WHICH mechanism
 *  gave up is the part a reader acts on. Named constants rather than literals: `nightly-health.cjs` counts
 *  these parks and must decide identically to this file. Comparing against the exported strings keeps the
 *  PRECEDENCE in `recoveryLineFor` the single source of truth — health used to test the park wording
 *  directly, so it kept reporting a dead end for the three stale parks this file had already cleared. */
const DEAD_END_LINES = Object.freeze({
  cutoff: "its turn-ceiling continuations were already spent — the recovery mechanism ran and gave up",
  silent: "its empty-run retry was already spent — the review was restarted fresh and came back empty again",
});

const isDeadEndLine = (line) => line != null && Object.values(DEAD_END_LINES).includes(line);

const hoursAgo = (t) => (t == null ? null : (Date.now() - t) / 3_600_000);

function age(t) {
  const h = hoursAgo(t);
  if (h == null) return "—";
  return h >= 48 ? `${(h / 24).toFixed(1)}d ago` : `${h.toFixed(1)}h ago`;
}

function short(s, n) {
  const one = String(s ?? "").replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

/** The last run of a parked task — the park message says what the pipeline decided, this says what the
 *  agent actually did just before it. A park with no run at all is itself worth seeing. */
function lastRun(db, threadId) {
  return db
    .prepare(
      `SELECT role, model, state, error, num_turns, cost_usd, started_at, ended_at, cap_flagged
       FROM agent_runs WHERE thread_id = ? ORDER BY started_at DESC LIMIT 1`,
    )
    .get(threadId);
}

/**
 * The `↳` line answering "is this stall a bug?" for one park — the recovery mechanism ran and gave up, or
 * the park predates the fix that would have handled it — else null.
 *
 * The stale half is scoped to `stalled` on purpose. A capWait park belongs to the cap supervisor, and its
 * last run can carry a turn-ceiling error (cut off, then capped before the continuation), so an unscoped
 * annotation would tell a sweep to "Resume — it exercises the fix" on a task that resumes itself, which is
 * exactly the race the capWait guidance warns against.
 */
function recoveryLineFor(parkClass, error, run) {
  // Stale is asked FIRST, because "the mechanism ran and gave up" was routinely untrue of a spent
  // allowance: until 748633a the budget was the TASK's, so earlier unrelated reviews spent it and the
  // round that actually parked was never woken once. That is the one annotation a sweep acts on by NOT
  // acting, and it stranded three tasks. `recoveryAnnotationFor` returns null once the run postdates the
  // fix, so a genuinely exhausted park still falls through to the hand-off line below.
  if (parkClass === "stalled") {
    const stale = recoveryAnnotationFor(error, run);
    if (stale) return stale;
  }
  const spent = spentRecoveryBudget(error);
  return spent ? DEAD_END_LINES[spent] : null;
}

function reportThread(db, t, parkClass) {
  console.log(`- ${t.id.slice(0, 8)}  ${short(t.title, 58)}`);
  console.log(`    parked ${age(t.updated_at)} · ${t.workspace}`);
  console.log(`    reason: ${short(t.error, 200) || "(no park message recorded)"}`);
  const run = lastRun(db, t.id);
  const recovery = recoveryLineFor(parkClass, t.error, run);
  if (recovery) console.log(`    ↳ ${recovery}`);
  if (!run) {
    console.log("    last run: none recorded — the task parked before any agent ran");
    return;
  }
  const turns = run.num_turns == null ? "?" : run.num_turns;
  const cost = run.cost_usd == null ? "$?" : `$${run.cost_usd.toFixed(2)}`;
  console.log(`    last run: ${run.role} on ${run.model} [${run.state}] ${age(run.ended_at ?? run.started_at)} · ${turns} turns · ${cost}`);
  if (run.error) console.log(`              ${short(run.error, 160)}`);
}

/** Which classes read as "something went wrong here", so they get the ⚠ and land in the summary count. */
const ALARM_KEYS = new Set(["stalled", "unknown", "promised", "otherFailure"]);
const markFor = (key) => (ALARM_KEYS.has(key) ? "⚠" : key === "capWait" ? "⏳" : "·");

function threadsInState(db, state) {
  return db
    .prepare("SELECT id, title, error, workspace, updated_at FROM threads WHERE state = ? ORDER BY updated_at ASC")
    .all(state);
}

/** Group one state's threads by class and print each group. Returns the per-class counts. */
function reportSection(db, rows, classes, classify) {
  const buckets = new Map(classes.map((c) => [c.key, []]));
  for (const t of rows) buckets.get(classify(t.error).key).push(t);
  for (const cls of classes) {
    const group = buckets.get(cls.key);
    if (!group.length) continue;
    console.log(`\n${markFor(cls.key)} ${cls.title} (${group.length})`);
    console.log(`  ↳ ${cls.action}`);
    for (const t of group) reportThread(db, t, cls.key);
  }
  return (key) => buckets.get(key).length;
}

function main() {
  const db = new Database(DB_PATH, { readonly: true });
  db.pragma("busy_timeout = 5000");

  const parked = threadsInState(db, "review");
  console.log(`\n=== parked in review (${parked.length}) ===`);
  if (!parked.length) console.log("  ✓ nothing parked — no task is waiting on you or on a backend.");
  const parks = reportSection(db, parked, PARK_CLASSES, classifyPark);

  // Same question, other state: a restart's casualties sit in `failed`, and nothing ever resumes one on
  // its own once the boot that promised it is gone.
  const abandoned = threadsInState(db, "failed");
  console.log(`\n=== abandoned in failed (${abandoned.length}) ===`);
  if (!abandoned.length) console.log("  ✓ nothing abandoned — no task was left behind by a restart.");
  const lost = reportSection(db, abandoned, ABANDON_CLASSES, classifyAbandoned);

  const needsKevin = parks("stalled") + parks("unknown") + lost("promised") + lost("otherFailure");
  console.log(
    `\n  ${needsKevin ? "⚠" : "✓"} ${parks("stalled") + parks("unknown")} park(s) stopped mid-pipeline, ` +
      `${parks("verdict")} awaiting a verdict by design, ${parks("capWait")} on the supervisor.`,
  );
  console.log(
    `  ${lost("promised") + lost("otherFailure") ? "⚠" : "·"} ${lost("promised")} abandoned task(s) still promising a resume, ` +
      `${lost("clickResume")} handed back for a click, ${lost("otherFailure")} unclassified.`,
  );
  console.log("  ↳ full run trail for any one: npm run probe:task-runs --prefix server -- <id>");
  db.close();
}

if (require.main === module) main();

module.exports = { classifyPark, classifyAbandoned, spentRecoveryBudget, recoveryLineFor, lastRun, isDeadEndLine, DEAD_END_LINES, PARK_CLASSES, ABANDON_CLASSES, STALL_MARKERS, VERDICT_MARKERS };
