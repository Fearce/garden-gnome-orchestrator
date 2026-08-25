// The "did the QA loop stay inside its budget?" reading behind `probe:task-runs`.
//
// It lives here rather than inside probe-task-runs.cjs because that script runs
// top-to-bottom against the live DB, so a gate can't require it — and a hand-copied
// mirror of a classifier drifts (see the cap-classifier lesson in
// .claude/rules/nightly-quality-sweep.md). The probe and its gate load THIS.
//
// The distinction this module exists to keep straight: a QA **launch** is one
// agent_runs row; a QA **round** is one iteration of the implementor↔QA loop. Only
// rounds are charged to maxQaRounds. Three other things also spend a launch, each
// recovering one round rather than starting a new one, each with its own budget:
//
//   • a turn-ceiling continuation  (MAX_QA_CUTOFF_RESUMES = 2, durable qaCutoffResumes)
//   • an empty-run fresh retry     (MAX_QA_SILENT_RETRIES  = 1, durable qaSilentRetries)
//   • a usage-cap failover         (agent_runs.cap_flagged — relaunches on another backend)
//
// All three shipped AFTER the durable-budget fix (44f793b) this check was written to
// police, so `launches > maxQaRounds` quietly stopped meaning "the loop drained its
// budget" and started firing on healthy tasks — pointing the reader at a bug fixed a
// month earlier. The verdict therefore keys on the durable counter the loop actually
// enforces (threads.stage_outputs.qaRoundsUsed), and the launch arithmetic is reported
// for reconciliation rather than asserted on.
//
// A restart casualty (state='interrupted') is deliberately NOT a fourth term: the loop
// writes qaRoundsUsed BEFORE launching QA precisely so a killed run still costs its
// round (threadManager.ts, "Spend the round from the DURABLE budget BEFORE running QA"),
// so those launches are already inside roundsUsed. Adding them double-counts — which is
// what the live trail of 7295b2dc (10 launches, 10 rounds, 2 interrupted) proves.

const num = (v) => (Number.isFinite(v) ? v : 0);

/**
 * The rounds cap as the loop enforces it — the stored setting, or null when there is no
 * usable value. `Number(null) === 0` is FINITE, so a naive `Number.isFinite(Number(v))`
 * turns a MISSING setting row (or an empty-string one) into cap = 0 — and a task with
 * even one QA round then trips the drain alarm against a cap that was never set. The
 * row is only written when the operator saves settings (settingNum never seeds it), so
 * every fresh DB reads that way.
 */
function roundsCap(raw) {
  if (raw == null) return null;
  if (typeof raw === "string" && raw.trim() === "") return null; // Number("") is 0 — unset, not a 0-round cap
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * The durable per-episode QA counters in `StageOutputs`, and what each means for the launch
 * arithmetic. `recoversRound: true` = it spends a QA launch while RECOVERING a round instead of
 * starting one, so the reconciliation has to add it on top of roundsUsed.
 *
 * This map is the whole reason the 2026-08-17 defect happened: the original check assumed
 * launches ≈ rounds, and three recovery mechanisms then shipped that quietly broke it. So the
 * map drives both the sum and the printed arithmetic below (a decorative declaration would rot),
 * and `test:qa-loop-check` diffs it BOTH WAYS against the live StageOutputs type — a new
 * `qa*` counter that ships without a row here fails the gate the same day, rather than silently
 * turning every task using it into an "unexplained launch".
 */
const QA_DURABLE_COUNTERS = {
  qaRoundsUsed: { input: "roundsUsed", recoversRound: false, label: "round(s)" },
  qaCutoffResumes: { input: "cutoffResumes", recoversRound: true, label: "turn-ceiling continuation(s)" },
  qaSilentRetries: { input: "silentRetries", recoversRound: true, label: "empty-run retry(ies)" },
  // Spends no launch of its OWN: it re-counts the subset of qaCutoffResumes charged to the review running
  // right now, because the cutoff allowance is per review and zeroes whenever one reaches a verdict. It is
  // the budget the loop enforces; qaCutoffResumes above is the lifetime tally the arithmetic reconciles
  // against. Adding both would invent a launch for every continuation.
  qaCutoffResumesThisRound: { input: "cutoffResumesThisRound", recoversRound: false, label: "continuation(s) on the current review" },
  // The same relationship for the empty-run budget: a subset of qaSilentRetries, re-counted for the review
  // running right now and zeroed when one reaches a verdict. Counting it would invent a launch per retry.
  qaSilentRetriesThisRound: { input: "silentRetriesThisRound", recoversRound: false, label: "empty-run retry(ies) on the current review" },
};

/**
 * A cap failover relaunches QA on another backend without touching any durable counter, so it is
 * read off the run rows (`agent_runs.cap_flagged`) rather than StageOutputs — hence not in the map.
 */
const CAP_FAILOVER_TERM = { input: "capFailovers", label: "cap failover(s)" };

/** Each term of the launch arithmetic, in print order: rounds, then everything that recovers one. */
function launchTerms() {
  return [
    QA_DURABLE_COUNTERS.qaRoundsUsed,
    ...Object.values(QA_DURABLE_COUNTERS).filter((c) => c.recoversRound),
    CAP_FAILOVER_TERM,
  ];
}

/**
 * Every launch the loop's own bookkeeping can explain. Kept separate from the verdict
 * so an unexplained launch reads as "reconcile this", never as the drain signature.
 */
function accountedLaunches(input) {
  return launchTerms().reduce((total, term) => total + num(input[term.input]), 0);
}

/**
 * The QA-loop reading for one task. Returns the lines the probe prints plus `warn`,
 * which is true ONLY for the genuine drain signature — the durable round counter
 * exceeding maxQaRounds.
 */
function qaLoopReading(input) {
  const { cap, launches, roundsUsed, interrupted, appliesFixes } = input;
  const lines = [];
  const accounted = accountedLaunches(input);
  const parts = launchTerms().map((term) => `${num(input[term.input])} ${term.label}`);
  lines.push(`  ${launches} QA launch(es) = ${parts.join(" + ")}`);
  if (num(interrupted) > 0) {
    lines.push(
      `  · ${interrupted} of those round(s) went to a run a restart killed before it reached a verdict — ` +
        "the round was charged before the launch, so they are already counted above, not extra.",
    );
  }

  // The durable counter is the only thing maxQaRounds is enforced against. A task
  // predating stage_outputs has none, and saying nothing there would read as a pass.
  if (roundsUsed == null) {
    lines.push("  · no durable qaRoundsUsed on this thread (a pre-stage_outputs task, or a retry cleared it) — the round budget can't be checked from here.");
  } else if (cap == null) {
    lines.push("  · setting_max_qa_rounds is unset or unreadable, so there is no cap to check the rounds against.");
  } else if (roundsUsed > cap) {
    lines.push(
      `  ⚠ ${roundsUsed} durable QA round(s) against a ${cap}-round cap — the loop exceeded its budget. ` +
        "That is the drain signature (a round counter that resets on resume, 44f793b); the launch count above is NOT.",
    );
    return { lines, warn: true };
  } else {
    lines.push(`  ✓ ${roundsUsed} durable QA round(s) within the ${cap}-round cap.`);
  }

  const unexplained = launches - accounted;
  if (unexplained > 0) {
    lines.push(
      `  · ${unexplained} launch(es) the counters don't account for — reconcile before assuming a loop bug: ` +
        "cap_flagged is null on rows predating 93d39d4 (so an old cap failover isn't counted), and a retry " +
        "nulls stage_outputs while the run rows survive.",
    );
  }
  if (appliesFixes) {
    lines.push(
      "  · QA-fixes mode is ON (setting_qa_applies_fixes): QA edits the tree itself and each changed pass is " +
        "handed to a VERIFIER QA pass, so the implementor is not relaunched between rounds. Many QA runs against " +
        "one implementor run is the designed shape here, not a stuck loop.",
    );
  }
  return { lines, warn: false };
}

module.exports = { qaLoopReading, accountedLaunches, roundsCap, QA_DURABLE_COUNTERS };
