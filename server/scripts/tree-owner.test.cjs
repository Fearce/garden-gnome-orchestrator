// Gate for `probe-tree-owner.cjs`'s two judgements. Run: `npm run test:tree-owner`.
//
// Both fail SILENTLY — a broken predicate here doesn't error, it attributes nothing, and "no agent run
// covers these" reads exactly like a true answer. That is the dangerous shape: the probe exists to stop
// an agent committing a sibling's half-finished file or abandoning its own, and a probe that shrugs
// sends them back to guessing from the diff.
const assert = require("node:assert/strict");
const path = require("node:path");
const { coversRepo, whoWrote, SLACK_MS } = require("./probe-tree-owner.cjs");

let checks = 0;
const check = (name, cond) => {
  checks++;
  if (!cond) {
    console.error(`  ✗ ${name}`);
    process.exitCode = 1;
  } else console.log(`  ✓ ${name}`);
};

const REPO = path.resolve("C:", "work", "gg", "claude-orchestrator");

console.log("tree-owner: which tasks are even working in this checkout");
{
  // The trap that would zero the whole probe: a task's workspace is routinely the directory ABOVE the
  // git repo (the console resolves a repo from its parent), so equality alone matches almost nobody.
  check("the repo itself counts", coversRepo(REPO, REPO));
  check("the PARENT workspace counts", coversRepo(path.resolve("C:", "work", "gg"), REPO));
  check("a grandparent counts", coversRepo(path.resolve("C:", "work"), REPO));
  check("a trailing separator doesn't break it", coversRepo(path.resolve("C:", "work", "gg") + path.sep, REPO));
  check("case doesn't matter on Windows", coversRepo(path.resolve("c:", "WORK", "gg"), REPO));
  check("a sibling checkout does NOT count", !coversRepo(path.resolve("C:", "work", "gg", "other-repo"), REPO));
  check("a prefix that isn't a path boundary does NOT count", !coversRepo(path.resolve("C:", "work", "gg2"), REPO));
  check("a child of the repo does NOT count", !coversRepo(path.resolve("C:", "work", "gg", "claude-orchestrator", "server"), REPO));
  check("no workspace is not a match", !coversRepo(null, REPO) && !coversRepo("", REPO));
}

console.log("tree-owner: which run was writing when the file was touched");
{
  const NOW = 1_700_000_000_000;
  const finished = { id: "done", started_at: NOW - 600_000, ended_at: NOW - 300_000 };
  const live = { id: "live", started_at: NOW - 120_000, ended_at: null };
  const runs = [finished, live];
  const ids = (at) => whoWrote(runs, at, NOW).map((r) => r.id);

  check("an edit inside a finished run is attributed", ids(NOW - 400_000).join() === "done");
  check("an edit during the live run is attributed", ids(NOW - 60_000).join() === "live");
  // A run's row is finalized by its own onEnd, which races the settle — an edit can land just outside.
  check("an edit just after a run ended still lands on it", ids(NOW - 300_000 + SLACK_MS / 2).join() === "done");
  check("an edit far after it does not", ids(NOW - 300_000 + SLACK_MS * 3).join() !== "done");
  check("an UNFINISHED run is open to now, not treated as zero-length", ids(NOW).join() === "live");
  check("an edit before everything is unexplained", ids(NOW - 5_000_000).length === 0);
  check("overlapping runs both match, so the caller can say so", whoWrote([finished, { id: "b", started_at: NOW - 600_000, ended_at: NOW }], NOW - 400_000, NOW).length === 2);
}

if (process.exitCode) console.error(`\ntree-owner: FAILED (${checks} checks run)`);
else console.log(`\nAll ${checks} tree-owner checks passed.`);
