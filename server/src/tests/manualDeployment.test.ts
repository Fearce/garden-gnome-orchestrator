import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ManualDeploymentClaim } from "../types.js";
import { isConfiguredCommitOnlyOrigin } from "../git/commitOnly.js";
import {
  declareManualDeployment,
  manualDeploymentHandoffDetail,
  manualDeploymentSummary,
  parseManualDeploymentClaim,
  qualifyManualDeployment,
  verifyManualDeployment,
} from "../orchestrator/manualDeployment.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true }).trim();
}

function commit(cwd: string, file: string, content: string, subject: string): string {
  writeFileSync(join(cwd, file), content, "utf8");
  git(cwd, "add", file);
  git(cwd, "commit", "--quiet", "-m", subject);
  return git(cwd, "rev-parse", "HEAD").toLowerCase();
}

function claim(commitSha: string): ManualDeploymentClaim {
  return {
    version: 1,
    commitSha,
    remoteRef: "origin/master",
    environment: "production",
    instructions: "Run the existing production release workflow for this commit.",
    verification: [{ command: "npm test", outcome: "passed" }],
    assertions: {
      implementationCommitted: true,
      requiredVerificationPassed: true,
      noUncommittedChanges: true,
      noMergeOrDivergence: true,
      credentialsAndDataReady: true,
      noOwnerDecisionRequired: true,
      noAdditionalBlockers: true,
      postDeployVerificationRequired: false,
    },
  };
}

const root = mkdtempSync(join(tmpdir(), "ggo-manual-deploy-"));
try {
  assert.equal(isConfiguredCommitOnlyOrigin("HTTPS://EXAMPLE.TEST/Commit-Only.git", "commit-only"), true);
  assert.equal(isConfiguredCommitOnlyOrigin("https://example.test/ordinary.git", "commit-only"), false);
  assert.equal(isConfiguredCommitOnlyOrigin("https://example.test/ordinary.git", ""), false);

  const origin = join(root, "commit-only-origin.git");
  const work = join(root, "work");
  git(root, "init", "--quiet", "--bare", origin);
  git(root, "clone", "--quiet", origin, work);
  git(work, "config", "user.email", "test@example.com");
  git(work, "config", "user.name", "GGO test");
  commit(work, "seed.txt", "seed\n", "chore: seed");
  git(work, "push", "--quiet", "-u", "origin", "master");

  const completed = commit(work, "change.txt", "verified change\n", "fix: verified change");
  const evidence = claim(completed);
  const qualified = qualifyManualDeployment(work, evidence, "commit-only");
  assert.equal(qualified.ok, true, qualified.reasons.join(" "));
  assert.equal(qualified.inspection?.ahead, 1, "a configured commit-only repository may be ahead of origin");
  assert.equal(qualified.inspection?.behind, 0);

  const parent = join(root, "vota");
  const sibling = join(parent, "vota-ios");
  const nested = join(parent, "vota-website");
  mkdirSync(parent);
  git(root, "clone", "--quiet", origin, sibling);
  git(root, "clone", "--quiet", origin, nested);
  git(nested, "config", "user.email", "test@example.com");
  git(nested, "config", "user.name", "GGO test");
  const nestedCompleted = commit(nested, "website.txt", "verified website change\n", "fix: verified website change");
  const nestedEvidence = claim(nestedCompleted);
  const nestedQualified = qualifyManualDeployment(parent, nestedEvidence, "commit-only");
  assert.equal(nestedQualified.ok, true, nestedQualified.reasons.join(" "));
  assert.equal(
    nestedQualified.inspection?.repoRoot,
    git(nested, "rev-parse", "--show-toplevel"),
    "a parent workspace with multiple nested repos resolves the checkout matching the claimed commit",
  );
  assert.equal(nestedQualified.inspection?.ahead, 1);

  const declared = declareManualDeployment(evidence, "implementor", "run-1", 10);
  const verified = verifyManualDeployment(declared, "qa", "run-qa", 20);
  assert.deepEqual(manualDeploymentSummary(verified), {
    status: "verified",
    commitSha: completed,
    environment: "production",
    instructions: evidence.instructions,
    verifiedAt: 20,
    invalidReason: null,
  });
  const handoff = manualDeploymentHandoffDetail(evidence, "the owner");
  assert.match(handoff, /work is complete at commit/i);
  assert.match(handoff, /pending external action for the owner/i);
  assert.match(handoff, /will not be auto-reviewed or resumed/i);

  const unsafe = structuredClone(evidence) as unknown as Record<string, unknown>;
  (unsafe.assertions as Record<string, unknown>).noAdditionalBlockers = false;
  assert.equal(parseManualDeploymentClaim(unsafe), null, "one false assertion makes the classification ambiguous");

  assert.equal(
    parseManualDeploymentClaim({ ...evidence, remoteRef: "HEAD" }),
    null,
    "the comparison ref must belong to the independently checked origin remote",
  );

  const wrongPolicy = qualifyManualDeployment(work, evidence, "unrelated-origin");
  assert.equal(wrongPolicy.ok, false);
  assert.match(wrongPolicy.reasons.join(" "), /configured commit-only repository rule/i);

  writeFileSync(join(work, "dirty.txt"), "not committed\n", "utf8");
  const dirty = qualifyManualDeployment(work, evidence, "commit-only");
  assert.equal(dirty.ok, false);
  assert.match(dirty.reasons.join(" "), /uncommitted or untracked/i);
  rmSync(join(work, "dirty.txt"));

  const other = join(root, "other");
  git(root, "clone", "--quiet", origin, other);
  git(other, "config", "user.email", "test@example.com");
  git(other, "config", "user.name", "GGO test");
  commit(other, "remote.txt", "remote work\n", "fix: remote work");
  git(other, "push", "--quiet", "origin", "master");
  git(work, "fetch", "--quiet", "origin");
  const diverged = qualifyManualDeployment(work, evidence, "commit-only");
  assert.equal(diverged.ok, false);
  assert.match(diverged.reasons.join(" "), /behind\/diverged/i, "remote-only work is an additional blocker");

  const blocked = qualifyManualDeployment(work, evidence, "commit-only", ["A required owner decision remains."]);
  assert.equal(blocked.ok, false);
  assert.match(blocked.reasons[0] ?? "", /owner decision/i);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("Manual deployment qualification checks passed.");
