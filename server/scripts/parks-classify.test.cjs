// Gate for the park classification in probe-parks.cjs — shared with nightly-health.cjs, so this decides
// what the sweep's first command reports as "needs a nudge" versus "awaiting your verdict, by design".
//
// The failure mode it guards is silent in both directions: a reworded park message stops matching its
// class and demotes to `unknown` (or worse, to the by-design bucket, where a stalled task can sit
// unnoticed for days). That is not hypothetical — the probe's very first run against live data turned up
// "QA made changes in the final allowed round (10) and needs an independent re-check", which the initial
// hand-written matcher didn't recognise at all.
//
// So every case below is a REAL literal from orchestrator/threadManager.ts, and the last section pins
// those literals against that file: change the wording there and this goes red, instead of the sweep
// quietly miscounting.
//
// Run: node scripts/parks-classify.test.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { classifyPark, classifyAbandoned, spentRecoveryBudget, recoveryLineFor, isDeadEndLine, PARK_CLASSES, ABANDON_CLASSES } = require("./probe-parks.cjs");
const { resolveShipDate } = require("./recovery-features.cjs");

const cls = (err) => classifyPark(err).key;

// --- the cap park: the one class nobody should act on ------------------------------------------------
assert.equal(cls("⏳ Auto-resume pending — every backend is capped."), "capWait", "the cap marker outranks everything");
assert.equal(
  cls("⏳ Auto-resume pending (QA runs on Claude) — needs your review."),
  "capWait",
  "a cap park carrying the generic review tail is still a cap park — the supervisor owns it, not Kevin",
);

// --- the operator hard-deadline park: a deliberate stop, parked via setState not settleReview -------
// expireActiveDeadline APPENDS whatever the task was previously reporting, so the ordering check below
// is the load-bearing one: a deadline stop interrupting a QA park must not inherit the QA park's class.
assert.equal(
  cls("⏰ Hard deadline reached at 30/08/2026, 23.35.00. All live agents were stopped and automatic dispatch/resume is blocked. The run trail, saved session, handoff, partial files and commits are preserved. Extend or clear the deadline, then click Resume to continue deliberately."),
  "deadline",
  "the operator's hard stop is its own by-design class",
);
assert.equal(
  cls("⏰ Hard deadline reached at 30/08/2026, 23.35.00. All live agents were stopped and automatic dispatch/resume is blocked.\n\nThe task was previously reporting: QA found unresolved issues it could not safely fix - needs your review."),
  "deadline",
  "the deadline marker outranks the prior park's verdict tail appended beneath it",
);
assert.equal(
  recoveryLineFor("deadline", "⏰ Hard deadline reached at 30/08/2026, 23.35.00.", null),
  null,
  "a deliberate stop gets no stale-recovery flag — nothing was supposed to resume it",
);

// --- stalled: the pipeline stopped mid-verification --------------------------------------------------
for (const err of [
  "QA could not complete — needs your review.",
  "QA could not complete — Stopped at the per-session turn ceiling (error_max_turns) — an involuntary cutoff, not a crash.",
  "Reader could not complete — needs your review (or a full re-dispatch).",
  "Reader completed but its disposition was lost to a restart — re-dispatch to re-run it.",
  "Resume failed to start — needs your review.",
  "Auto-review failed to run: Error: spawn ENOENT",
  "Auto-review couldn't reach a verdict — the review run came back empty — still needs your review.",
  "Auto-review couldn’t reach a verdict — still needs your review.",
  // The auto-review fix round: the implementor it sent in never finished, so the reviewer never got to
  // re-check. The lane owes this task a run that nothing but a click will start.
  "The auto-review's fix round didn't finish — Run failed (error_during_execution). The issues it was sent to fix are still open, so this needs your review.",
  "Auto-review was interrupted by a server restart — click “Auto-review & mark done” to run it again.",
  "Auto-review was fixing the issues it found when a server restart interrupted it — whatever the implementor had already changed is still in the working tree. Click “Auto-review & mark done” to re-review from there.",
]) {
  assert.equal(cls(err), "stalled", `should be a stall: ${err}`);
}

// --- verdict: finished, waiting on the owner — by design ---------------------------------------------
for (const err of [
  "QA still not satisfied after 7 rounds — needs your review.",
  "QA found unresolved issues it could not safely fix - needs your review.",
  "QA made changes in the final allowed round (10) and needs an independent re-check.",
  "Resume finished — needs your review.",
  "Auto-review didn't accept it: the CSV export is still missing a header row",
  "Auto-review didn’t accept it: the CSV export is still missing a header row",
  // Same hand-off after the lane already spent a fix round on it — still the owner's call, not a stall.
  "Auto-review didn't accept it (after 1 fix round): the CSV export is still missing a header row",
  "Stopped at the per-session turn ceiling — needs your review (QA is disabled for this task).",
]) {
  assert.equal(cls(err), "verdict", `should be an owner hand-off: ${err}`);
}

// A stall marker plus the generic review tail must read as the STALL — the ordering that keeps a task
// nothing will resume out of the "by design, ignore it" bucket.
assert.equal(cls("QA could not complete — needs your review."), "stalled", "stall markers outrank the generic tail");

// Reader escalation no longer parks. It is promoted in place into the normal pipeline, so keeping the
// former dead-end wording in this classifier would make the health sweep prescribe a manual re-dispatch
// for a task that is already running again.
assert.equal(
  cls("Reader escalated — needs the full pipeline: needs an edit"),
  "unknown",
  "an in-place reader escalation is not a parked task needing a human nudge",
);

// --- unknown is a signal, not a dumping ground -------------------------------------------------------
assert.equal(cls(""), "unknown", "an empty park message classifies rather than throwing");
assert.equal(cls(null), "unknown", "a NULL error column (the schema allows it) classifies rather than throwing");
assert.equal(cls("Something nobody has written yet"), "unknown", "unrecognized text surfaces instead of being guessed");
assert.equal(PARK_CLASSES.at(-1).key, "unknown", "the catch-all must stay last, or it swallows the real classes");
assert.equal(PARK_CLASSES.filter((c) => !c.human).length, 1, "capWait is the only class not waiting on a human");

// --- the spent-budget flag health prints alongside a QA park -----------------------------------------
// QA has TWO exhaustible recovery budgets and this predicate knew only the turn-ceiling one, so an
// empty-run dead end got no `↳` line and read as an unread reason worth hand-drilling (7d776461).
assert.equal(
  spentRecoveryBudget("QA could not complete — It was woken 2 more times and cut off again each time."),
  "cutoff",
  "a spent continuation budget means the mechanism ran and gave up — a real hand-off, not a retry candidate",
);
assert.equal(
  spentRecoveryBudget("QA could not complete — This review also came back empty without reaching the model, and was already restarted on a fresh session."),
  "silent",
  "a spent empty-run budget is a hand-off for the same reason",
);
assert.equal(
  spentRecoveryBudget("QA could not complete — A review in this task also came back empty without reaching the model, and was already restarted on a fresh session."),
  "silent",
  "the pre-f693278 wording is still in the table — a classifier that only knows today's sentence re-opens the hole",
);
assert.equal(
  spentRecoveryBudget("QA could not complete — It was woken 2 more times and cut off again each time. This review also came back empty … restarted on a fresh session."),
  "cutoff",
  "a park that spent both reports the continuations, matching the order qaRecoveryNotes writes them",
);
assert.equal(spentRecoveryBudget("QA could not complete — needs your review."), null);
assert.equal(spentRecoveryBudget(null), null, "a NULL error must not throw");
assert.equal(isDeadEndLine("something else entirely"), false, "only the exported verdicts count as dead ends");
assert.equal(isDeadEndLine(null), false, "a park with no `↳` line at all is not a dead end");

// --- the `↳` recovery line, and the class it is scoped to --------------------------------------------
// A cap-parked QA task can carry a turn-ceiling run (cut off, then capped before the continuation ran).
// Annotating it "a Resume exercises the fix" would send a sweep to hand-resume a task the cap supervisor
// already owns — the race capWait exists to prevent. So the stale flag is stalled-only.
const preFix = { role: "qa", num_turns: 61, started_at: resolveShipDate("a0f4a74").getTime() - 7 * 86_400_000, ended_at: null };
const ceilingPark = "QA could not complete — Stopped at the per-session turn ceiling (error_max_turns) — an involuntary cutoff, not a crash.";

assert.match(
  recoveryLineFor("stalled", ceilingPark, preFix) ?? "",
  /stale — .*predates/,
  "a stalled park whose last run predates its recovery fix should say so",
);
assert.equal(
  recoveryLineFor("capWait", `⏳ Auto-resume pending (QA stage) — ${ceilingPark}`, preFix),
  null,
  "a cap park is the supervisor's — never tell the sweep to Resume it",
);
assert.equal(recoveryLineFor("verdict", ceilingPark, preFix), null, "an owner hand-off gets no stale flag either");

// The spent-budget line is class-agnostic on purpose: it reports what already happened rather than
// prescribing an action, so it stays true wherever the park landed.
assert.match(
  recoveryLineFor("capWait", "QA could not complete — It was woken 2 more times and cut off again each time.", preFix) ?? "",
  /continuations were already spent/,
);

// ...but it must not OUTRANK the stale flag on a stalled park, which is what hid three tasks. Before
// 748633a the allowance was the task's, so a park could report "the mechanism ran and gave up" about a
// review the mechanism had never once woken — a dead-end verdict on recoverable work.
const spentPark = "QA could not complete — Stopped at the per-session turn ceiling (error_max_turns). It was woken 2 more times and cut off again each time.";
const perReviewShip = resolveShipDate("748633a").getTime();
assert.match(
  recoveryLineFor("stalled", spentPark, { role: "qa", num_turns: 61, started_at: perReviewShip - 86_400_000, ended_at: null }) ?? "",
  /stale — .*predates/,
  "a spent allowance from before the per-review fix is stale, not a dead end",
);
assert.match(
  recoveryLineFor("stalled", spentPark, { role: "qa", num_turns: 61, started_at: perReviewShip + 86_400_000, ended_at: null }) ?? "",
  /continuations were already spent/,
  "after the fix it really is exhausted — the hand-off line must still be reachable",
);

// The empty-run budget has the same two-sided story, and it is one release behind: its per-review fix is
// f693278, so a park from before that spent an allowance an EARLIER round had drained. Same precedence.
const silentPark =
  "QA could not complete — Resumed session produced no output. A review in this task also came back empty without reaching the model, and was already restarted on a fresh session.";
const silentShip = resolveShipDate("f693278").getTime();
assert.match(
  recoveryLineFor("stalled", silentPark, { role: "qa", num_turns: 0, started_at: silentShip - 86_400_000, ended_at: null }) ?? "",
  /stale — .*predates/,
  "a spent empty-run allowance from before the per-review fix is stale, not a dead end",
);
assert.match(
  recoveryLineFor("stalled", silentPark, { role: "qa", num_turns: 0, started_at: silentShip + 86_400_000, ended_at: null }) ?? "",
  /empty-run retry was already spent/,
  "after the fix it really is exhausted — this hand-off line must be reachable too",
);

// The sweep asks this question TWICE — `probe:parks` (step 4) names each park, `nightly-health` (step 1)
// counts them — and step 1 is the one read first. When health tested the park wording itself it kept
// reporting the three stale tasks above as dead ends after probe:parks had already cleared them, so the
// two steps gave opposite verdicts on the same task. Pin health to the shared predicate, the same way
// `test:failover-ladder` pins probe:accounts to the live headroom terms.
const healthSrc = fs.readFileSync(path.join(__dirname, "nightly-health.cjs"), "utf8");
assert.equal(
  isDeadEndLine(recoveryLineFor("stalled", spentPark, { role: "qa", num_turns: 61, started_at: perReviewShip + 86_400_000, ended_at: null })),
  true,
  "DEAD_END_LINES must hold the very strings recoveryLineFor returns — health recognizes them by identity",
);
assert.match(
  healthSrc,
  /isDeadEndLine\(\s*recoveryLineFor\(/,
  "nightly-health must route its dead-end count through recoveryLineFor, not re-derive it",
);
assert.doesNotMatch(
  healthSrc,
  /spentRecoveryBudget\s*\(/,
  "nightly-health calling spentRecoveryBudget directly is the pre-65c20d0 precedence — it ignores the stale registry",
);

// --- the other state that waits on a person: threads abandoned in `failed` ---------------------------
// `promised` is the load-bearing one. It is the only message claiming a run is COMING, so demoting it to
// the by-design bucket would re-hide exactly the two tasks (2026-08-08) that motivated this section.
const abandoned = (err) => classifyAbandoned(err).key;

assert.equal(abandoned("interrupted by a server restart — auto-resuming…"), "promised", "an undelivered promise must stay visible");
for (const err of [
  "interrupted by a server restart — click Resume to continue from where it left off (finished stages are reused)",
  // The revival budget spent, and the crash-loop guard — both stop promising and ask for a click.
  "interrupted by a server restart — auto-resume was re-armed 3× across restarts and never got this task running again. Click Resume to continue from where it left off (finished stages are reused).",
  "interrupted by a server restart — the auto-resume it was promised never fired, and the task is now too old to pick up on its own. Click Resume to continue from where it left off (finished stages are reused).",
  "Auto-resume stopped — this task kept getting interrupted within seconds of resuming 3× (likely a crash loop, not progress). Click Resume to retry once the cause is fixed.",
  // Historical wording from the June builds, still on real rows — threadManager no longer writes it, so
  // it is matched by shape rather than pinned below.
  "interrupted by server restart — re-dispatch to retry",
]) {
  assert.equal(abandoned(err), "clickResume", `should be an owner hand-off: ${err}`);
}
assert.equal(abandoned("Workspace \"C:\\gone\" does not exist on disk — agents can't run there."), "otherFailure");
assert.equal(abandoned(""), "otherFailure", "an empty error classifies rather than throwing");
assert.equal(abandoned(null), "otherFailure", "a NULL error column classifies rather than throwing");
assert.equal(ABANDON_CLASSES.at(-1).key, "otherFailure", "the catch-all must stay last, or it swallows the real classes");

// --- drift guard: these are threadManager's own words ------------------------------------------------
// The load-bearing check. Classification keys off text the server writes, so a rename there without a
// change here leaves the sweep reporting a stalled task as a normal hand-off — invisible, and exactly
// the miscount this probe was built to end.
const tm = fs.readFileSync(path.resolve(__dirname, "..", "src", "orchestrator", "threadManager.ts"), "utf8");
const LITERALS = [
  "⏳ Auto-resume pending",
  "⏰ Hard deadline reached",
  "QA could not complete",
  "Reader could not complete",
  "disposition was lost to a restart",
  "Resume failed to start",
  "Auto-review failed to run",
  "reach a verdict",
  "needs your review",
  "still not satisfied",
  "unresolved issues",
  "needs an independent re-check",
  "Auto-review didn't accept it",
  "fix round didn't finish",
  "Auto-review was interrupted by a server restart",
  "Auto-review was fixing the issues it found",
  "cut off again each time",
  // The `failed`-state messages. The promise is the one that must not drift: it is written by one process
  // and read back by the next boot's revival scan, so a reword there is a cross-process contract break.
  "auto-resuming…",
  "click Resume to continue from where it left off",
  "auto-resume was re-armed",
  "too old to pick up on its own",
  "Auto-resume stopped",
];
for (const lit of LITERALS) {
  assert.ok(
    tm.includes(lit),
    `park classification keys off "${lit}", which threadManager.ts no longer writes — reclassify it in probe-parks.cjs`,
  );
}

// And the reverse door: every park message the server can write must land in a real class. Pulled from
// the source so a NEW settleReview call shows up here as a failure rather than as a silent `unknown`.
const parkCalls = [...tm.matchAll(/settleReview\(\s*[^,]+,\s*(`[^`]*`|"[^"]*")/g)].map((m) =>
  m[1].slice(1, -1).replace(/\$\{[^}]*\}/g, "7"),
);
assert.ok(parkCalls.length >= 8, `expected to find the settleReview park literals, found ${parkCalls.length}`);
for (const msg of parkCalls) {
  assert.notEqual(
    cls(msg),
    "unknown",
    `threadManager parks with "${msg}" but no PARK_CLASS matches it — the sweep would report it as unrecognized`,
  );
}

console.log(`parksClassify: all assertions passed (${parkCalls.length} live park literals classified)`);
