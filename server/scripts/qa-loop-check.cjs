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
 * Every launch the loop's own bookkeeping can explain. Kept separate from the verdict
 * so an unexplained launch reads as "reconcile this", never as the drain signature.
 */
function accountedLaunches({ roundsUsed, cutoffResumes, silentRetries, capFailovers }) {
  return num(roundsUsed) + num(cutoffResumes) + num(silentRetries) + num(capFailovers);
}

/**
 * The QA-loop reading for one task. Returns the lines the probe prints plus `warn`,
 * which is true ONLY for the genuine drain signature — the durable round counter
 * exceeding maxQaRounds.
 */
function qaLoopReading(input) {
  const { cap, launches, roundsUsed, cutoffResumes, silentRetries, capFailovers, interrupted, appliesFixes } = input;
  const lines = [];
  const accounted = accountedLaunches(input);
  const parts = [
    `${num(roundsUsed)} round(s)`,
    `${num(cutoffResumes)} turn-ceiling continuation(s)`,
    `${num(silentRetries)} empty-run retry(ies)`,
    `${num(capFailovers)} cap failover(s)`,
  ];
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
    lines.push("  · setting_max_qa_rounds is unset, so there is no cap to check the rounds against.");
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

module.exports = { qaLoopReading, accountedLaunches };
