// Gate for the recovery-feature registry in recovery-features.cjs — the closed table probe-parks uses to
// flag a stalled QA/auto-review park as STALE (last run predates the fix that would recover it) rather than
// a real recovery gap. Without it every sweep re-derives "when did qaCutoffResumes ship?" by hand from git
// (3-4 tool calls per stale park) — the 2026-07-31 sweep's exact friction, which this registry ends.
//
// What is pinned: every registry commit RESOLVES in git and points at the fix it claims (a typo'd or
// history-rewritten SHA would silently disable the stale flag), and the flag fires for a pre-fix run and
// stays silent for a post-fix one. Mirror of parks-classify.test.cjs's drift-guard style.
//
// Run: node scripts/recovery-features.test.cjs

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { RECOVERY_FEATURES, recoveryAnnotationFor, resolveShipDate } = require("./recovery-features.cjs");

const REPO_DIR = path.resolve(__dirname, "..", "..");
const DAY = 86_400_000;

// --- the registry is complete and every entry's commit resolves to the fix it claims ----------------
assert.ok(
  RECOVERY_FEATURES.length >= 4,
  "registry should list the QA cutoff, QA silent, auto-review and reviewer-failover recoveries",
);
const ids = new Set();
for (const f of RECOVERY_FEATURES) {
  assert.ok(!ids.has(f.id), `duplicate registry id ${f.id}`);
  ids.add(f.id);

  const d = resolveShipDate(f.commit);
  assert.ok(d, `registry commit ${f.commit} (${f.id}) does not resolve in git — the stale flag cannot compute a ship date`);
  assert.ok(typeof f.applies === "function", `${f.id} needs an applies predicate`);

  // Catches a SHA that resolves but points at the WRONG commit (a rebase handed back a different fix):
  const subj = spawnSync("git", ["show", "-s", "--format=%s", f.commit], { cwd: REPO_DIR, encoding: "utf8" }).stdout.trim();
  assert.match(
    subj,
    /\b(?:qa|review\w*|failover|resum\w*|recover\w*)\b/i,
    `commit ${f.commit} (${f.id}) is "${subj}" — doesn't read like the recovery fix it claims to pin`,
  );
}

// --- the stale flag: a run BEFORE the fix shipped reads as stale; AFTER, it stays silent -------------
const cutoff = RECOVERY_FEATURES.find((f) => f.id === "qaCutoffResumes");
const cutoffShip = resolveShipDate(cutoff.commit);
const cutoffPark =
  "QA could not complete — Stopped at the per-session turn ceiling (error_max_turns) — an involuntary cutoff, not a crash.";

const staleNote = recoveryAnnotationFor(cutoffPark, { role: "qa", started_at: cutoffShip.getTime() - 7 * DAY, ended_at: null });
assert.ok(staleNote, "a run before the fix shipped should produce a stale annotation");
assert.match(staleNote, /stale/i);
assert.match(staleNote, /predates/);
assert.match(staleNote, /Resume exercises the fix/);
assert.match(staleNote, /a0f4a74/);

assert.equal(
  recoveryAnnotationFor(cutoffPark, { role: "qa", started_at: cutoffShip.getTime() + 7 * DAY, ended_at: null }),
  null,
  "a run after the fix shipped is not stale — leave it to the continuationsSpent path",
);

// --- a silent QA park maps to the empty-run retry feature, not the cutoff continuation ---------------
const silent = RECOVERY_FEATURES.find((f) => f.id === "qaSilentRetries");
const silentShip = resolveShipDate(silent.commit);
const silentPark =
  "QA could not complete — Resumed session produced no output — the run returned without ever reaching the model.";
const silentNote = recoveryAnnotationFor(silentPark, { role: "qa", started_at: silentShip.getTime() - 7 * DAY, ended_at: null });
assert.ok(silentNote, "a silent QA park before its fix should produce a stale annotation");
assert.match(silentNote, /qaSilentRetries/);
assert.match(silentNote, /af640b0/);

// The 8826201c shape (2026-07-31 sweep): a GENERIC QA park ("needs your review") whose silent cause
// survives only in the run row — 0 turns, done, no error text. The predicate must read the run, not just
// the park text, or this real case is missed and the sweep re-derives the ship date by hand.
const genericSilent = recoveryAnnotationFor("QA could not complete — needs your review.", {
  role: "qa", num_turns: 0, state: "done", started_at: silentShip.getTime() - 7 * DAY, ended_at: null,
});
assert.ok(genericSilent, "a generic QA park over a 0-turn run should still map to the silent-retry fix");
assert.match(genericSilent, /qaSilentRetries/);

// --- a CAPPED auto-review maps to the failover fix, not the older empty-run recovery ----------------
// The e870c68e shape (2026-08-13): the reviewer died on "You've hit your session limit" in 4s while z.ai
// was up, and `providerServesRole` (49960f7) is what lets that click fail over instead of parking. Both
// features match the park text, so the annotation must name the LATER one — and must not depend on where
// either row sits in the array.
const failover = RECOVERY_FEATURES.find((f) => f.id === "reviewerProviderFailover");
assert.ok(failover, "the auto-reviewer's provider-failover recovery should be registered");
const failoverShip = resolveShipDate(failover.commit);
const cappedPark =
  "Auto-review couldn't reach a verdict — You've hit your session limit · resets 2am (Europe/Copenhagen) — still needs your review.";
const cappedRun = { role: "reviewer", cap_flagged: 1, started_at: failoverShip.getTime() - DAY / 2, ended_at: null };

const cappedNote = recoveryAnnotationFor(cappedPark, cappedRun);
assert.ok(cappedNote, "a capped auto-review from before the failover fix should read as stale");
assert.match(cappedNote, /49960f7/);
assert.doesNotMatch(cappedNote, /bc7e87b/, "the earlier applicable fix must not outrank the one that would have recovered it");

assert.equal(
  recoveryAnnotationFor(cappedPark, { ...cappedRun, started_at: failoverShip.getTime() + DAY }),
  null,
  "a capped auto-review after the failover fix is not stale — drill it",
);

// The tight half: the predicate keys off the RUNNER's cap verdict, never the park's wording. Without one
// this is an ordinary no-verdict park that the empty-run recovery answers — and this run postdates it, so
// the sweep is told nothing rather than told "not a bug".
assert.equal(
  recoveryAnnotationFor(cappedPark, { ...cappedRun, cap_flagged: null }),
  null,
  "no cap verdict on the run ⇒ fall back to the empty-run recovery, which this run postdates",
);

// …and the empty-run auto-review park it must still cover, unchanged.
const emptyReviewShip = resolveShipDate(RECOVERY_FEATURES.find((f) => f.id === "autoReviewRecovery").commit);
const emptyReviewNote = recoveryAnnotationFor(
  "Auto-review couldn't reach a verdict — Resumed session produced no output — still needs your review.",
  { role: "reviewer", started_at: emptyReviewShip.getTime() - 7 * DAY, ended_at: null },
);
assert.ok(emptyReviewNote, "an empty auto-review before its own fix should still read as stale");
assert.match(emptyReviewNote, /bc7e87b/);

// --- a park no recovery feature covers produces no annotation (e.g. a reader stall) -----------------
const beforeAny = Math.min(...RECOVERY_FEATURES.map((f) => resolveShipDate(f.commit).getTime())) - 7 * DAY;
assert.equal(
  recoveryAnnotationFor("Reader could not complete — needs your review.", { started_at: beforeAny, ended_at: null }),
  null,
  "no recovery feature applies to a reader stall — stay silent",
);

// --- graceful: no usable timestamp, no run, or an unresolvable commit all stay silent rather than throwing ---
assert.equal(recoveryAnnotationFor(cutoffPark, { started_at: null, ended_at: null }), null, "a run with no timestamp stays silent");
assert.equal(recoveryAnnotationFor(cutoffPark, null), null, "a park with no last run stays silent");
assert.equal(recoveryAnnotationFor(null, { started_at: beforeAny, ended_at: null }), null, "a null park message stays silent");

console.log(`recoveryFeatures: all assertions passed (${RECOVERY_FEATURES.length} features pinned)`);
