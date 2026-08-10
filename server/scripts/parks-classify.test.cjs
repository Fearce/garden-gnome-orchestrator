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
const { classifyPark, classifyAbandoned, continuationsSpent, recoveryLineFor, PARK_CLASSES, ABANDON_CLASSES } = require("./probe-parks.cjs");
const { resolveShipDate } = require("./recovery-features.cjs");

const cls = (err) => classifyPark(err).key;

// --- the cap park: the one class nobody should act on ------------------------------------------------
assert.equal(cls("⏳ Auto-resume pending — every backend is capped."), "capWait", "the cap marker outranks everything");
assert.equal(
  cls("⏳ Auto-resume pending (QA runs on Claude) — needs your review."),
  "capWait",
  "a cap park carrying the generic review tail is still a cap park — the supervisor owns it, not Kevin",
);

// --- stalled: the pipeline stopped mid-verification --------------------------------------------------
for (const err of [
  "QA could not complete — needs your review.",
  "QA could not complete — Stopped at the per-session turn ceiling (error_max_turns) — an involuntary cutoff, not a crash.",
  "Reader could not complete — needs your review (or a full re-dispatch).",
  "Reader completed but its disposition was lost to a restart — re-dispatch to re-run it.",
  "Reader escalated to the full pipeline: needs an edit — re-dispatch with the normal `dispatch`.",
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

// --- unknown is a signal, not a dumping ground -------------------------------------------------------
assert.equal(cls(""), "unknown", "an empty park message classifies rather than throwing");
assert.equal(cls(null), "unknown", "a NULL error column (the schema allows it) classifies rather than throwing");
assert.equal(cls("Something nobody has written yet"), "unknown", "unrecognized text surfaces instead of being guessed");
assert.equal(PARK_CLASSES.at(-1).key, "unknown", "the catch-all must stay last, or it swallows the real classes");
assert.equal(PARK_CLASSES.filter((c) => !c.human).length, 1, "capWait is the only class not waiting on a human");

// --- the continuation-budget flag health prints alongside a QA park ----------------------------------
assert.equal(
  continuationsSpent("QA could not complete — It was woken 2 more times and cut off again each time."),
  true,
  "a spent continuation budget means the mechanism ran and gave up — a real hand-off, not a retry candidate",
);
assert.equal(continuationsSpent("QA could not complete — needs your review."), false);
assert.equal(continuationsSpent(null), false, "a NULL error must not throw");

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
  "QA could not complete",
  "Reader could not complete",
  "disposition was lost to a restart",
  "Reader escalated to the full pipeline",
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
