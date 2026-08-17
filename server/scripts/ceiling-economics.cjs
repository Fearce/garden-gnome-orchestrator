// "218 turn-ceiling cutoffs, $3,281 — is that a lot?" — the question the sweep could not ask.
//
// probe:run-errors classifies each non-done run and files a turn-ceiling cutoff as BENIGN, which it is:
// the orchestrator warm-resumes it and the work continues. Every one of those verdicts is individually
// correct. But that makes the whole class a single green ✓ line, and a ceiling that is too small for what
// a role does produces nothing except more of those green lines — real money converted into re-orientation,
// forever, with no check anywhere that goes red.
//
// That is exactly how it happened. QA's ceiling was 60, chosen while QA was READ-ONLY; six weeks later the
// editing mode (`qaAppliesFixes`) made it edit files, run builds, run the suite and commit, on the same 60.
// Cutoffs went 1% of QA runs → 10%, a pile-up at exactly ceiling+1 turns, and one measured task was cut off
// TEN turns short of a verdict after $6.70 of work. Nothing failed. Nothing turned red. It was found six
// weeks later because a human looked at one task and said "that was fast".
//
// So this reads the same rows as a RATE and a TREND rather than a count:
//   • rate, because 218 cutoffs is meaningless without the denominator of runs that didn't;
//   • trend, because the level alone is not diagnostic — a long implementor task is SUPPOSED to hit its
//     ceiling and warm-resume (that is the design), while QA at a steady 10% is a defect. What separates
//     them is that the defect's rate MULTIPLIED when the role's work grew, and the design's did not.
//
// The trend is what makes this generalize past the bug that motivated it: any role whose capabilities are
// widened without revisiting its ceiling shows up here the same way, in the window it happens.
//
// Consumed by probe-run-errors.cjs; gated by ceiling-economics.test.cjs. Pure — no DB, no clock — so the
// gate can drive it with the real numbers this defect actually produced.

// A role needs this many finished runs in a half-window before its rate means anything. Below it, one
// unlucky task swings the percentage far enough to make the trend check pure noise.
const MIN_RUNS = 20;
// A recent rate under this is not worth anyone's attention however much it grew — 1 cutoff in 40 runs
// doubling to 2 in 40 is not a signal, and reporting it is how a check trains its reader to skip it.
const MIN_RATE = 0.05;
// How much the rate must have multiplied to read as "the work outgrew the ceiling" rather than drift.
const GROWTH = 2;

const pct = (n) => `${(n * 100).toFixed(0)}%`;
const usd = (n) => `$${(n ?? 0).toFixed(2)}`;
const rateOf = (half) => (half.runs > 0 ? half.cutoffs / half.runs : 0);

/**
 * Whether one role's cutoff rate reads as a mis-sized ceiling, with the reason in plain words.
 *
 * A zero prior rate is the STRONGEST version of the signal, not a missing one — a role that never hit its
 * ceiling and now does is precisely the shape of a role whose work grew — so it warns rather than dividing
 * by zero, but only once the prior half has enough runs to prove the zero meant something.
 */
function verdictFor(recent, prior) {
  if (recent.runs < MIN_RUNS) return { warn: false, note: `only ${recent.runs} run(s) — too few to read a rate` };
  const now = rateOf(recent);
  if (now < MIN_RATE) return { warn: false, note: null };
  const before = rateOf(prior);
  if (prior.runs < MIN_RUNS) return { warn: false, note: "no comparable prior window — level noted, trend unknown" };
  if (before === 0) return { warn: true, note: `was 0% over ${prior.runs} run(s) — this role did not hit its ceiling before` };
  if (now >= GROWTH * before) return { warn: true, note: `${pct(before)} → ${pct(now)}, a ${(now / before).toFixed(1)}× rise` };
  return { warn: false, note: null };
}

/**
 * The turn-ceiling economics reading. `roles` maps a role name to `{ recent, prior }`, each
 * `{ runs, cutoffs, costUsd }` where `runs` counts every FINISHED run of that role in the half-window
 * (the denominator) and `costUsd` is what the cutoff runs alone billed.
 *
 * Returns the lines to print plus `warn`. Always lists every role that had a cutoff — making the number
 * visible at all is most of the point — and reserves the ⚠ for the trend above.
 */
function ceilingEconomics({ roles, hours }) {
  const lines = [];
  const entries = Object.entries(roles ?? {})
    .filter(([, r]) => (r?.recent?.cutoffs ?? 0) > 0 || (r?.prior?.cutoffs ?? 0) > 0)
    .sort((a, b) => rateOf(b[1].recent) - rateOf(a[1].recent));

  if (!entries.length) {
    lines.push("  ✓ no turn-ceiling cutoffs in the window — nothing to size.");
    return { lines, warn: false };
  }

  const spent = entries.reduce((t, [, r]) => t + (r.recent.costUsd ?? 0), 0);
  const hit = entries.reduce((t, [, r]) => t + r.recent.cutoffs, 0);
  lines.push(`  ${hit} cutoff run(s) in the last ${hours}h billed ${usd(spent)} before being cut off mid-work.`);

  let warn = false;
  for (const [role, r] of entries) {
    const v = verdictFor(r.recent, r.prior);
    warn = warn || v.warn;
    const mark = v.warn ? "⚠" : "·";
    const trend = r.prior.runs >= MIN_RUNS ? ` (prior ${hours}h: ${pct(rateOf(r.prior))})` : "";
    lines.push(
      `  ${mark} ${role}: ${r.recent.cutoffs}/${r.recent.runs} runs cut off = ${pct(rateOf(r.recent))}${trend}, ${usd(r.recent.costUsd)}` +
        (v.note ? ` — ${v.note}` : ""),
    );
  }

  if (warn) {
    lines.push(
      "  ↳ a rate that MULTIPLIED means the role's work outgrew its ceiling — check whether that role gained " +
        "capabilities (tools, an editing mode, a bigger brief) without its maxTurns in agents/roles.ts being " +
        "revisited. That is the whole defect: nothing fails, the cutoffs are all correctly benign, and the " +
        "task just pays for a second agent to re-read what the first one already knew.",
    );
  } else {
    lines.push("  ↳ no role's cutoff rate has grown — these are the designed warm-resume cutoffs, not a sizing problem.");
  }
  return { lines, warn };
}

module.exports = { ceilingEconomics, verdictFor, MIN_RUNS, MIN_RATE, GROWTH };
