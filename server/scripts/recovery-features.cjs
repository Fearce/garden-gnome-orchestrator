// The closed registry of RECOVERY FEATURES — the bounded mechanisms that turn an involuntary stop (a
// turn-ceiling cutoff, an empty resume) into a handled one instead of a park. probe-parks uses it to flag
// a stalled QA/auto-review park as STALE — its last run predates the fix that would have recovered it — so
// a sweep stops re-deriving "when did qaCutoffResumes ship?" by hand from git (3-4 tool calls per stale
// park, the 2026-07-31 sweep's exact friction).
//
//   const { recoveryAnnotationFor } = require("./recovery-features.cjs");
//
// Why a registry and not a live probe of git: the ship date is a STABLE historical fact (the commit does
// not move), so recording the SHA once and resolving its date at runtime is both cheaper and self-checking
// — a SHA that no longer resolves (history rewrite, typo) makes the flag stay silent rather than lie, and
// the gate (recovery-features.test.cjs) pins that every SHA still resolves to the fix it claims.
//
// This mirrors PARK_CLASSES / CLASSES / ROLE_TURN_CEILING — a small closed table of source-of-truth facts
// the probes key off. Add a row when a NEW recovery mechanism ships (you are already editing threadManager
// and writing its gate); the ship SHA is the one fact to record.
//
// GOTCHAS:
//   • Only the ship SHA is recorded — NEVER hardcode the date. `resolveShipDate` reads it from git so a
//     rebased commit's new date flows through without a registry edit.
//   • `appliesToPark` keys off the PARK MESSAGE (threads.error), not the run's error: a silent run stamped
//     `done` pre-fix carries `error: NULL` on its row, so the run error is absent exactly when the park
//     text is the only place the cause survives.
//   • This flags STALE only. A post-fix park is left to the `continuationsSpent` path (the recovery ran
//     and gave up) or to a manual probe:task-runs — a "post-fix but no budget spent" soft-flag is
//     deliberately NOT emitted, since the spent marker differs per kind and the ship≠deploy window makes
//     it false-positive-prone. Add it only when a real post-fix gap actually surfaces.

const { spawnSync } = require("node:child_process");
const path = require("node:path");

// Inside the repo so `git show` finds the git root regardless of where the probe is invoked from.
const REPO_DIR = path.resolve(__dirname, "..", "..");

const RECOVERY_FEATURES = [
  {
    id: "qaCutoffResumes",
    label: "the QA turn-ceiling continuation (qaCutoffResumes)",
    commit: "a0f4a74", // fix(qa): continue a QA review cut off at its turn ceiling instead of parking it
    applies: (e, run) =>
      run?.role === "qa" &&
      (/per-session turn ceiling|error_max_turns/i.test(e) || /per-session turn ceiling|error_max_turns/i.test(String(run.error ?? ""))),
  },
  {
    id: "qaSilentRetries",
    label: "the QA empty-run fresh retry (qaSilentRetries)",
    commit: "af640b0", // fix(qa): re-run a QA review that came back empty instead of parking the task
    applies: (e, run) =>
      run?.role === "qa" &&
      (/produced no output/i.test(e) ||
        /produced no output/i.test(String(run.error ?? "")) ||
        // A QA run that ended with ZERO turns never reached the model — the silent signature. The park text
        // is then often just the generic "QA could not complete — needs your review.", so the run row is the
        // only place the cause survives (pre-fix rows carry error: NULL, stamped `done` not `error`).
        (run.num_turns === 0 && /QA could not complete/i.test(e))),
  },
  {
    id: "autoReviewRecovery",
    label: "the auto-review recovery (MAX_REVIEW_RECOVERIES)",
    commit: "bc7e87b", // fix(review): recover an auto-review that came back empty instead of re-parking
    applies: (e) => /could\s?n(?:o|['’])t reach a verdict/i.test(e),
  },
];

/** Resolve a commit's committer date as a Date, or null if the SHA is absent/unresolvable. Uses `%cI`
 *  (strict ISO 8601) so `new Date()` parses the offset reliably across locales. Never throws. */
function resolveShipDate(commit) {
  if (!commit) return null;
  const r = spawnSync("git", ["show", "-s", "--format=%cI", commit], { cwd: REPO_DIR, encoding: "utf8" });
  if (r.status !== 0 || !r.stdout || !r.stdout.trim()) return null;
  const d = new Date(r.stdout.trim());
  return Number.isNaN(d.getTime()) ? null : d;
}

const isoDate = (d) => (d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : "—");

/** For a stalled park, the "this predates the fix" annotation — or null when no recovery feature applies,
 *  its ship date can't be resolved, the run has no timestamp, or the run is already from after the fix
 *  (leave those to the continuationsSpent path). `run` is the last agent_runs row (epoch-ms timestamps). */
function recoveryAnnotationFor(parkError, run) {
  const e = String(parkError ?? "");
  const feat = RECOVERY_FEATURES.find((f) => f.applies(e, run));
  if (!feat) return null;
  const shipDate = resolveShipDate(feat.commit);
  if (!shipDate) return null; // commit missing/rewritten — can't judge, stay silent rather than mislead
  if (!run) return null;
  const ts = run.ended_at ?? run.started_at;
  if (ts == null) return null; // new Date(null) is the epoch, not Invalid Date — guard the raw value
  const runAt = new Date(ts);
  if (Number.isNaN(runAt.getTime())) return null;
  if (runAt < shipDate) {
    return (
      `stale — last run ${isoDate(runAt)} predates ${feat.label} (${feat.commit.slice(0, 7)}, ${isoDate(shipDate)}); ` +
      `a Resume exercises the fix, not a bug`
    );
  }
  return null;
}

module.exports = { RECOVERY_FEATURES, resolveShipDate, recoveryAnnotationFor };

if (require.main === module) {
  for (const f of RECOVERY_FEATURES) {
    const d = resolveShipDate(f.commit);
    console.log(`${f.id.padEnd(20)} ${f.commit.slice(0, 7)}  ${isoDate(d)}  ${d ? "" : "(UNRESOLVED)"}`);
  }
}
