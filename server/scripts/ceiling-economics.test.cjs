#!/usr/bin/env node

// Gate for the turn-ceiling economics reading in ceiling-economics.cjs — the section that asks whether a
// role's maxTurns is the right size, which no check asked before 2026-08-17.
//
// The numbers below are the REAL ones this defect produced (read out of the live DB while fixing it), not
// invented ones. That matters for both directions: the check must fire on the shape that actually hid for
// six weeks, and must stay silent on the implementor's steady high rate, which is the design working and
// sits right next to it in the same output. A check that flagged both would have been ignored within a week.

const assert = require("node:assert/strict");
const { ceilingEconomics, verdictFor, MIN_RUNS } = require("./ceiling-economics.cjs");

const half = (runs, cutoffs, costUsd = 0) => ({ runs, cutoffs, costUsd });
const text = (r) => r.lines.join("\n");

// --- it fires on the defect it was written for ------------------------------------------------------
// QA's ceiling was 60, set while the role was read-only; `qaAppliesFixes` then made it edit, build, run the
// suite and commit on the same 60. Live, over windows straddling that change: 1% → 10%, and 3% → 10%.
{
  const r = ceilingEconomics({ hours: 400, roles: { qa: { recent: half(296, 29, 216.23), prior: half(430, 6) } } });
  assert.equal(r.warn, true, "a QA cutoff rate that multiplied is the signal this exists to catch");
  assert.match(text(r), /⚠ qa:/);
  assert.match(text(r), /1% → 10%/);
  assert.match(text(r), /outgrew its ceiling/);
  assert.match(text(r), /maxTurns in agents\/roles\.ts/, "name the file to edit, not just the diagnosis");
}

// A role that never hit its ceiling and now does is the STRONGEST form of the signal, not a missing one —
// dividing by a zero prior rate must not make it silent. (Live at a 600h window: 0% over 403 runs → 7%.)
{
  const r = ceilingEconomics({ hours: 600, roles: { qa: { recent: half(475, 35, 260.59), prior: half(403, 0) } } });
  assert.equal(r.warn, true, "0% → 7% must warn, not divide by zero into silence");
  assert.match(text(r), /did not hit its ceiling before/);
}

// --- and stays silent where a cutoff is the DESIGN --------------------------------------------------
// The implementor is meant to hit its ceiling and warm-resume; a steady 22% → 24% is that working. This is
// the cry-wolf case — it appears in the same output as the real one, so getting it wrong costs the reader.
{
  const r = ceilingEconomics({ hours: 168, roles: { implementor: { recent: half(362, 88, 1476.3), prior: half(340, 75) } } });
  assert.equal(r.warn, false, "a high but STEADY rate is the designed warm-resume cutoff, not a sizing problem");
  assert.match(text(r), /· implementor:/, "still listed — the cost is the point even when there's no verdict");
  assert.match(text(r), /\$1476\.30/, "the money must be visible; a count alone is what nobody read");
  assert.doesNotMatch(text(r), /outgrew its ceiling/);
}

// --- the suppressions, so the check keeps being read ------------------------------------------------
assert.equal(verdictFor(half(8, 4), half(200, 2)).warn, false, "a handful of runs can swing a rate to anything");
assert.match(verdictFor(half(8, 4), half(200, 2)).note, /too few/, "say WHY it was skipped rather than passing silently");
assert.equal(verdictFor(half(400, 8), half(400, 1)).warn, false, "2% is not worth anyone's attention however much it grew");
assert.equal(verdictFor(half(400, 80), half(5, 0)).warn, false, "a prior window too small to trust cannot prove a rise");
assert.match(verdictFor(half(400, 80), half(5, 0)).note, /trend unknown/, "an unknown trend must not read as a pass");
assert.equal(verdictFor(half(400, 80), half(400, 60)).warn, false, "20% → 15% is drift, not a multiplication");
assert.ok(verdictFor(half(400, 80), half(400, 40)).warn, "exactly 2× is the threshold, inclusive");
assert.equal(MIN_RUNS, 20, "the small-sample floor is load-bearing — changing it changes what the sweep reports");

// --- the totals line, and the empty case ------------------------------------------------------------
{
  const r = ceilingEconomics({
    hours: 168,
    roles: { qa: { recent: half(166, 20, 142.77), prior: half(150, 12) }, implementor: { recent: half(362, 88, 1476.3), prior: half(340, 75) } },
  });
  assert.match(text(r), /108 cutoff run\(s\) in the last 168h billed \$1619\.07/, "sum across roles, in one headline number");
}
{
  const r = ceilingEconomics({ hours: 24, roles: { qa: { recent: half(40, 0), prior: half(40, 0) } } });
  assert.equal(r.warn, false);
  assert.match(text(r), /no turn-ceiling cutoffs/, "a role with no cutoffs is not listed at all");
  assert.doesNotMatch(text(r), /qa:/);
}
assert.doesNotMatch(text(ceilingEconomics({ hours: 24, roles: {} })), /billed/, "no roles at all must not print a $0.00 headline");

console.log("ceilingEconomics: all assertions passed");
