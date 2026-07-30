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
const { classifyPark, continuationsSpent, PARK_CLASSES } = require("./probe-parks.cjs");

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
  "accept it:",
  "cut off again each time",
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
