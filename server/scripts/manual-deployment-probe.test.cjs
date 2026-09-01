// Gate for probe-manual-deployment.cjs — the list of work GGO finished that still waits on the owner's
// own deploy, and the two settle-path defects it exits non-zero on.
//
// The failure modes it guards are both silent:
//   • The classifier decides what lands on the owner's deploy queue. Promote `declared` into it and the
//     owner is told to deploy a commit no verification boundary ever accepted; demote `verified` out of
//     it and the queue that only this probe reports goes empty while work waits.
//   • The invariant check keys on the exact handoff-note text in orchestrator/manualDeployment.ts.
//     Reword that constant and every settled task reads as "settled without the owner's note" — the
//     probe would then fail the sweep forever, on healthy data. So the literal is pinned against source.
//
// The repository resolution is tested against a REAL nested checkout because that is the shape that
// actually bit: a task workspace is often the PARENT of the repo (workspace `…\project`, repo
// `…\project\service`), and the server's first Git verification rejected valid handoffs by
// running git on the parent. Local git only — no network, no quota.
//
// Run: node scripts/manual-deployment-probe.test.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  classifyManualDeployment,
  invariantFailures,
  resolveRepo,
  pushState,
  humanAge,
  HANDOFF_SUMMARY,
} = require("./probe-manual-deployment.cjs");

const SHA = "a".repeat(40);
const claim = (over = {}) => ({
  version: 1,
  commitSha: SHA,
  remoteRef: "origin/master",
  environment: "production",
  instructions: "Deploy the committed change.",
  ...over,
});
const verified = (over = {}) => ({ kind: "manual_deployment", version: 1, status: "verified", claim: claim(), verifiedBy: "qa", ...over });

// --- classification: what reaches the owner's deploy queue -------------------------------------------
assert.equal(
  classifyManualDeployment(verified(), null, "done", { key: "local" }).key,
  "waiting",
  "a verified handoff whose commit is still local is what the owner has to deploy",
);
assert.equal(
  classifyManualDeployment(verified(), null, "done", { key: "pushed" }).key,
  "discharged",
  "once the declared commit is on its remote ref the owner already acted — it must leave the queue",
);
assert.equal(
  classifyManualDeployment(verified(), null, "done", { key: "unknown" }).key,
  "waiting",
  "an unresolvable checkout must NOT be read as discharged — unknown keeps the item on the queue",
);
assert.equal(
  classifyManualDeployment({ status: "declared", claim: claim() }, null, "review").key,
  "declared",
  "a declaration no verification boundary has crossed is not owner-actionable",
);
assert.equal(
  classifyManualDeployment({ status: "invalidated", claim: claim(), invalidReason: "HEAD moved" }, null, "review").reason,
  "HEAD moved",
  "a refused handoff must carry its reason — that is the answer to 'why did my task not settle done?'",
);
assert.equal(
  classifyManualDeployment(null, { runId: "r1", at: Date.now(), reason: "uncommitted changes" }, "review").key,
  "refused",
  "a rejected attempt leaves only the attempt record, and it still has to be reported",
);
assert.equal(classifyManualDeployment(null, null, "done"), null, "an ordinary task must not appear at all");

// --- the two defects the probe exits non-zero on -----------------------------------------------------
const entry = (over = {}) => ({ state: "done", marker: verified(), hasHandoffNote: true, ...over });

assert.deepEqual(invariantFailures(entry()), [], "a settled handoff carrying its note is healthy");
assert.match(
  invariantFailures(entry({ state: "review" }))[0],
  /settle path did not complete/,
  "a verified marker on a task still parked in review means the settle path failed — that is a bug",
);
assert.match(
  invariantFailures(entry({ hasHandoffNote: false }))[0],
  /silent deployment/,
  "settling done without the owner-visible note is the exact failure the feature exists to prevent",
);
assert.deepEqual(
  invariantFailures(entry({ state: "cancelled" })),
  [],
  "a cancelled task is a legitimate terminal state, not a failed settle",
);
assert.deepEqual(
  invariantFailures({ state: "review", marker: { status: "declared", claim: claim() }, hasHandoffNote: false }),
  [],
  "an unverified declaration owes no note and no done state",
);

// --- the handoff note literal, pinned against the source it mirrors ----------------------------------
const source = fs.readFileSync(path.resolve(__dirname, "..", "src", "orchestrator", "manualDeployment.ts"), "utf8");
assert.ok(
  source.includes(`= ${JSON.stringify(HANDOFF_SUMMARY)}`),
  `MANUAL_DEPLOYMENT_HANDOFF_SUMMARY changed in manualDeployment.ts but not in the probe — every settled ` +
    `task would then read as missing its owner note. Expected the source to define ${JSON.stringify(HANDOFF_SUMMARY)}.`,
);

// --- real nested checkout: the shape that rejected valid handoffs ------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gg-md-probe-"));
const run = (cwd, ...args) => {
  const result = spawnSync("git", ["-C", cwd, "-c", "user.email=gate@example.com", "-c", "user.name=gate", ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return String(result.stdout ?? "").trim();
};

try {
  // workspace/ is NOT a repo; workspace/service/ is. That is the production shape.
  const workspace = path.join(tmp, "workspace");
  const repo = path.join(workspace, "service");
  const origin = path.join(tmp, "origin.git");
  fs.mkdirSync(repo, { recursive: true });
  spawnSync("git", ["init", "--bare", "--initial-branch=master", origin], { windowsHide: true });
  run(repo, "init", "--initial-branch=master");
  fs.writeFileSync(path.join(repo, "file.txt"), "one\n");
  run(repo, "add", "file.txt");
  run(repo, "commit", "-m", "first");
  run(repo, "remote", "add", "origin", origin);
  run(repo, "push", "--quiet", "origin", "master");

  const pushedSha = run(repo, "rev-parse", "HEAD");
  assert.equal(
    resolveRepo(workspace, pushedSha),
    run(repo, "rev-parse", "--show-toplevel"),
    "the checkout must be found from the PARENT workspace — running git on the parent alone rejects valid handoffs",
  );
  assert.equal(
    pushState(resolveRepo(workspace, pushedSha), claim({ commitSha: pushedSha }), false).key,
    "pushed",
    "a commit already on origin/master is discharged, not still on the owner's desk",
  );

  // A second local commit is the real WAITING case: committed, verified, never pushed.
  fs.writeFileSync(path.join(repo, "file.txt"), "two\n");
  run(repo, "commit", "-am", "second");
  const localSha = run(repo, "rev-parse", "HEAD");
  assert.equal(
    pushState(resolveRepo(workspace, localSha), claim({ commitSha: localSha }), false).key,
    "local",
    "a commit-only repo's whole point is a local commit awaiting the owner's push — it must read as waiting",
  );
  assert.equal(
    pushState(resolveRepo(workspace, localSha), claim({ commitSha: localSha, remoteRef: "origin/nope" }), false).key,
    "unknown",
    "an unresolvable remote ref must be unknown, never silently 'pushed'",
  );

  // A sibling repo in the same workspace must not be mistaken for the owner of the commit.
  const sibling = path.join(workspace, "unrelated");
  fs.mkdirSync(sibling, { recursive: true });
  run(sibling, "init", "--initial-branch=master");
  fs.writeFileSync(path.join(sibling, "other.txt"), "x\n");
  run(sibling, "add", "other.txt");
  run(sibling, "commit", "-m", "sibling");
  assert.equal(
    resolveRepo(workspace, localSha),
    run(repo, "rev-parse", "--show-toplevel"),
    "with several checkouts under one workspace the claimed COMMIT picks the repo — never the directory name",
  );
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// --- age formatting: the column the owner scans for the forgotten one --------------------------------
assert.equal(humanAge(5 * 60_000), "5m");
assert.equal(humanAge(3 * 3_600_000), "3h");
assert.equal(humanAge(5 * 86_400_000), "5d");
assert.equal(humanAge(-1), "unknown", "a clock skew must not render as a negative age");

console.log("manual-deployment probe gate: all checks passed");
