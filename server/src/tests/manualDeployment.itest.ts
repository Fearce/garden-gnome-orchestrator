/** Focused integration coverage for the strict manual-deployment terminal policy.
 * Run: npm run test:manual-deployment
 */

process.env.CAP_RETRY_MS = "0";
process.env.ACCOUNT_PING_MS = "3600000";
process.env.FAST_ACCOUNT_PING_MS = "3600000";

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountManager } from "../accounts/accountManager.js";
import type { ManualDeploymentClaim, ReviewerOutput, RouteDecision } from "../types.js";

const { Db } = await import("../db/db.js");
const { EventHub } = await import("../events.js");
const { FileMemoryService } = await import("../memory/memory.js");
const { config } = await import("../config.js");
const { declareManualDeployment, verifyManualDeployment, MANUAL_DEPLOYMENT_HANDOFF_SUMMARY } = await import("../orchestrator/manualDeployment.js");
const { ThreadManager } = await import("../orchestrator/threadManager.js");

class StubAccounts {
  onUsageRefresh(_cb: () => void): void {}
  effectiveUtilization(): number | null { return null; }
  soonestResetAt(): number | null { return null; }
  hasHeadroom(): boolean { return true; }
  dispatchPreview(): Record<string, unknown> {
    return { account: { id: "acct-a", label: "acct-a" }, hasHeadroom: true, fiveHour: 0, sevenDay: 0, fiveHourReset: null, sevenDayReset: null, weeklySafetyPct: 100 };
  }
  auxToken(): string | undefined { return undefined; }
  setPingInterval(_ms: number): void {}
  applyEnabled(_id: string, _enabled: boolean): void {}
  applyWeeklySafetyPct(_id: string, _pct: number): void {}
  setSpreadUsage(_on: boolean): void {}
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true }).trim();
}

function commit(cwd: string, file: string, content: string, subject: string): string {
  writeFileSync(join(cwd, file), content, "utf8");
  git(cwd, "add", file);
  git(cwd, "commit", "--quiet", "-m", subject);
  return git(cwd, "rev-parse", "HEAD").toLowerCase();
}

function evidence(commitSha: string): ManualDeploymentClaim {
  return {
    version: 1,
    commitSha,
    remoteRef: "origin/master",
    environment: "production",
    instructions: "Run the approved release workflow for this verified commit.",
    verification: [
      { command: "npm run test:focused", outcome: "passed" },
      { command: "npm run typecheck", outcome: "passed" },
    ],
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

function disposeManager(manager: InstanceType<typeof ThreadManager>): void {
  const internals = manager as unknown as { capSupervisor?: NodeJS.Timeout; tokenResumeTimer?: NodeJS.Timeout; capResumeWake?: NodeJS.Timeout };
  if (internals.capSupervisor) clearInterval(internals.capSupervisor);
  if (internals.tokenResumeTimer) clearTimeout(internals.tokenResumeTimer);
  if (internals.capResumeWake) clearTimeout(internals.capResumeWake);
}

const routeWithQa: RouteDecision = {
  usePlanner: false,
  useQa: true,
  scope: "standard",
  reason: "test route",
  signals: ["test"],
};

const root = mkdtempSync(join(tmpdir(), "manual-deployment-integration-"));
const originalPattern = config.noPushRepoPattern;
try {
  const origin = join(root, "commit-only-origin.git");
  const workspace = join(root, "workspace");
  git(root, "init", "--quiet", "--bare", origin);
  git(root, "clone", "--quiet", origin, workspace);
  git(workspace, "config", "user.email", "test@example.com");
  git(workspace, "config", "user.name", "GGO test");
  commit(workspace, "seed.txt", "seed\n", "chore: seed");
  git(workspace, "push", "--quiet", "-u", "origin", "master");
  const completed = commit(workspace, "change.txt", "verified change\n", "fix: complete verified change");
  const claim = evidence(completed);
  const parentWorkspace = join(root, "vota");
  const siblingRepo = join(parentWorkspace, "vota-ios");
  const nestedRepo = join(parentWorkspace, "vota-website");
  mkdirSync(parentWorkspace);
  git(root, "clone", "--quiet", origin, siblingRepo);
  git(root, "clone", "--quiet", origin, nestedRepo);
  git(nestedRepo, "config", "user.email", "test@example.com");
  git(nestedRepo, "config", "user.name", "GGO test");
  const nestedCompleted = commit(nestedRepo, "website.txt", "verified website change\n", "fix: complete nested repo change");
  const nestedClaim = evidence(nestedCompleted);
  config.noPushRepoPattern = "commit-only";

  const db = new Db(join(root, "orchestrator.sqlite"));
  const hub = new EventHub();
  const memory = new FileMemoryService(join(root, "memory"));
  const manager = new ThreadManager(db, hub, memory, new StubAccounts() as unknown as AccountManager);
  const internals = manager as unknown as {
    verifyManualDeploymentAtBoundary(
      thread: ReturnType<InstanceType<typeof Db>["getThread"]> extends infer T ? NonNullable<T> : never,
      verifier: "qa" | "reviewer" | "owner" | "implementor_no_qa",
      rawClaim?: unknown,
      runId?: string | null,
      blockers?: readonly string[],
      settle?: boolean,
    ): { attempted: boolean; done: boolean; reason?: string };
    settleReview(threadId: string, reason: string): void;
  };

  // A Vota-style parent workspace with multiple nested checkouts still accepts the repo whose HEAD
  // matches the structured deployment claim. This is the live layout that triggered the rule.
  const nestedThread = db.createThread({ title: "nested Vota release", workspace: parentWorkspace, rawPrompt: "ship it", brief: "Ship the verified nested change." });
  db.updateThread(nestedThread.id, { state: "implementing" });
  db.updateThreadStageOutputs(nestedThread.id, { routeDecision: routeWithQa });
  const nestedImpl = db.createRun({ threadId: nestedThread.id, role: "implementor", model: "test-model", account: "acct-a" });
  assert.equal(manager.recordManualDeployment({ threadId: nestedThread.id, fromRole: "implementor", fromRunId: nestedImpl.id, claim: nestedClaim }).ok, true);
  db.updateRun(nestedImpl.id, { state: "done", endedAt: Date.now() });
  const nestedQa = db.createRun({ threadId: nestedThread.id, role: "qa", model: "test-reviewer", account: "acct-a" });
  db.updateRun(nestedQa.id, { state: "done", endedAt: Date.now() });
  db.updateThread(nestedThread.id, { state: "qa", error: null });
  const nestedAccepted = internals.verifyManualDeploymentAtBoundary(db.getThread(nestedThread.id)!, "qa", undefined, nestedQa.id);
  assert.deepEqual({ attempted: nestedAccepted.attempted, done: nestedAccepted.done }, { attempted: true, done: true });
  assert.equal(db.getThread(nestedThread.id)?.manualDeployment?.commitSha, nestedCompleted);

  // A current implementor declaration followed by a clean QA boundary becomes done and carries the
  // owner-visible API projection, finding, and feed handoff.
  const valid = db.createThread({ title: "verified release", workspace, rawPrompt: "ship it", brief: "Ship the verified change." });
  db.updateThread(valid.id, { state: "implementing" });
  db.updateThreadStageOutputs(valid.id, { routeDecision: routeWithQa });
  const implementor = db.createRun({ threadId: valid.id, role: "implementor", model: "test-model", account: "acct-a" });
  const recorded = manager.recordManualDeployment({ threadId: valid.id, fromRole: "implementor", fromRunId: implementor.id, claim });
  assert.equal(recorded.ok, true);
  db.updateRun(implementor.id, { state: "done", endedAt: Date.now() });
  const qa = db.createRun({ threadId: valid.id, role: "qa", model: "test-reviewer", account: "acct-a" });
  db.updateRun(qa.id, { state: "done", endedAt: Date.now() });
  db.updateThread(valid.id, { state: "qa", error: null });
  const accepted = internals.verifyManualDeploymentAtBoundary(db.getThread(valid.id)!, "qa", undefined, qa.id);
  assert.deepEqual({ attempted: accepted.attempted, done: accepted.done }, { attempted: true, done: true });
  const completedThread = db.getThread(valid.id)!;
  assert.equal(completedThread.state, "done");
  assert.equal(completedThread.error, null);
  assert.equal(completedThread.manualDeployment?.status, "verified");
  assert.equal(completedThread.manualDeployment?.commitSha, completed);
  assert.equal(db.listFindings(valid.id).filter((finding) => finding.summary === MANUAL_DEPLOYMENT_HANDOFF_SUMMARY).length, 1);
  assert.equal(db.listMessages(valid.id).filter((message) => /Complete in GGO\. Manual deployment remains pending/.test(message.content)).length, 1);

  // Every retry owner sees the durable fence before an agent can be claimed.
  const reviewClaim = db.claimAutoReview(valid.id, "supervisor");
  assert.equal(reviewClaim.ok, false);
  assert.match(reviewClaim.reason, /manual deployment|complete in GGO/i);
  const apiReview = await manager.autoReview(valid.id, "owner");
  assert.deepEqual({ ok: apiReview.ok, state: apiReview.state }, { ok: true, state: "done" });

  // If a task already has a parked auto-review episode, the later manual-deployment terminal
  // handoff consumes that episode without inventing an accepted reviewer verdict.
  const previouslyRejected = db.createThread({ title: "reviewed before deploy handoff", workspace, rawPrompt: "ship it", brief: "Ship the verified change." });
  db.updateThread(previouslyRejected.id, { state: "review", error: "old review handback" });
  const oldReviewClaim = db.claimAutoReview(previouslyRejected.id, "supervisor");
  assert.equal(oldReviewClaim.ok, true);
  const oldReviewer = db.createRun({ threadId: previouslyRejected.id, role: "reviewer", model: "test-reviewer", account: "acct-a" });
  db.updateRun(oldReviewer.id, { state: "done", endedAt: Date.now() });
  const rejectedVerdict: ReviewerOutput = {
    accept: false,
    summary: "Rejected before the deploy-only handoff existed.",
    issues: [{ severity: "major", description: "A previous blocker existed." }],
  };
  assert.equal(db.finishAutoReview({
    threadId: previouslyRejected.id,
    claimToken: oldReviewClaim.claimToken,
    status: "parked",
    reason: rejectedVerdict.summary,
    verdict: rejectedVerdict,
  }).ok, true);
  assert.equal(db.getAutoReviewEpisode(previouslyRejected.id)?.verdict?.accept, false);
  db.updateThread(previouslyRejected.id, { state: "implementing", error: null });
  const laterImplementor = db.createRun({ threadId: previouslyRejected.id, role: "implementor", model: "test-model", account: "acct-a" });
  assert.equal(manager.recordManualDeployment({ threadId: previouslyRejected.id, fromRole: "implementor", fromRunId: laterImplementor.id, claim }).ok, true);
  db.updateRun(laterImplementor.id, { state: "done", endedAt: Date.now() });
  const laterQa = db.createRun({ threadId: previouslyRejected.id, role: "qa", model: "test-reviewer", account: "acct-a" });
  db.updateRun(laterQa.id, { state: "done", endedAt: Date.now() });
  db.updateThread(previouslyRejected.id, { state: "qa", error: null });
  const laterAccepted = internals.verifyManualDeploymentAtBoundary(db.getThread(previouslyRejected.id)!, "qa", undefined, laterQa.id);
  assert.deepEqual({ attempted: laterAccepted.attempted, done: laterAccepted.done }, { attempted: true, done: true });
  const terminalEpisode = db.getAutoReviewEpisode(previouslyRejected.id)!;
  assert.equal(terminalEpisode.status, "parked");
  assert.equal(terminalEpisode.claimToken, null);
  assert.equal(terminalEpisode.verdict, null);
  assert.match(terminalEpisode.reason ?? "", /manual deployment|Complete in GGO/i);

  // Reconciliation is idempotent: a second manager/boot retains done and emits no duplicate handoff.
  const findingsBeforeRestart = db.listFindings(valid.id).length;
  const messagesBeforeRestart = db.listMessages(valid.id).length;
  const restarted = new ThreadManager(db, hub, memory, new StubAccounts() as unknown as AccountManager);
  assert.equal(db.getThread(valid.id)?.state, "done");
  assert.equal(db.listFindings(valid.id).length, findingsBeforeRestart);
  assert.equal(db.listMessages(valid.id).length, messagesBeforeRestart);
  assert.equal(restarted.settleManualDeployment(valid.id), true);
  assert.equal(db.listFindings(valid.id).length, findingsBeforeRestart);
  assert.equal(db.listMessages(valid.id).length, messagesBeforeRestart);

  // A single extra blocker fails closed and stays visible in review.
  const blocked = db.createThread({ title: "blocked release", workspace, rawPrompt: "ship it", brief: "Ship only when safe." });
  db.updateThread(blocked.id, { state: "implementing" });
  const blockedRun = db.createRun({ threadId: blocked.id, role: "implementor", model: "test-model", account: "acct-a" });
  assert.equal(manager.recordManualDeployment({ threadId: blocked.id, fromRole: "implementor", fromRunId: blockedRun.id, claim }).ok, true);
  db.updateRun(blockedRun.id, { state: "done", endedAt: Date.now() });
  const blockedQa = db.createRun({ threadId: blocked.id, role: "qa", model: "test-reviewer", account: "acct-a" });
  db.updateRun(blockedQa.id, { state: "done", endedAt: Date.now() });
  db.updateThread(blocked.id, { state: "qa" });
  const rejected = internals.verifyManualDeploymentAtBoundary(
    db.getThread(blocked.id)!,
    "qa",
    undefined,
    blockedQa.id,
    ["Deployment credentials or required data are still missing."],
  );
  assert.equal(rejected.attempted, true);
  assert.equal(rejected.done, false);
  assert.match(rejected.reason ?? "", /credentials|required data/i);
  internals.settleReview(blocked.id, rejected.reason ?? "Manual deployment evidence was rejected.");
  assert.equal(db.getThread(blocked.id)?.state, "review");
  assert.equal(db.getThread(blocked.id)?.manualDeployment?.status, "invalidated");

  // A later malformed claim revokes an older declaration. It cannot leave stale positive evidence
  // available for QA, owner actions, or restart reconciliation to accept.
  const replaced = db.createThread({ title: "replaced declaration", workspace, rawPrompt: "ship it", brief: "Ship only when safe." });
  db.updateThread(replaced.id, { state: "implementing" });
  const replacedRun = db.createRun({ threadId: replaced.id, role: "implementor", model: "test-model", account: "acct-a" });
  assert.equal(manager.recordManualDeployment({ threadId: replaced.id, fromRole: "implementor", fromRunId: replacedRun.id, claim }).ok, true);
  const malformed = manager.recordManualDeployment({
    threadId: replaced.id,
    fromRole: "implementor",
    fromRunId: replacedRun.id,
    claim: {} as ManualDeploymentClaim,
  });
  assert.equal(malformed.ok, false);
  assert.equal(db.getThread(replaced.id)?.manualDeployment?.status, "invalidated");
  db.updateRun(replacedRun.id, { state: "done", endedAt: Date.now() });
  db.updateThread(replaced.id, { state: "review", error: malformed.error ?? "Malformed deployment evidence." });

  // Code-native repair accepts an already-persisted structured reviewer verdict, but never prose or an
  // unverified QA-enabled declaration.
  const legacy = db.createThread({ title: "structured stale review", workspace, rawPrompt: "ship", brief: "Ship." });
  db.updateThread(legacy.id, { state: "review" });
  const lock = db.claimAutoReview(legacy.id, "owner");
  assert.equal(lock.ok, true);
  const reviewer = db.createRun({ threadId: legacy.id, role: "reviewer", model: "test-reviewer", account: "acct-a" });
  db.updateRun(reviewer.id, { state: "done", endedAt: Date.now() });
  const verdict: ReviewerOutput = { accept: true, summary: "Verified and ready for external deployment.", manualDeployment: claim };
  assert.equal(db.finishAutoReview({ threadId: legacy.id, claimToken: lock.claimToken, status: "accepted", reason: verdict.summary, verdict }).ok, true);
  db.updateThread(legacy.id, { state: "review", error: "stale terminal state" });

  const proseOnly = db.createThread({ title: "ambiguous prose", workspace, rawPrompt: "ship", brief: "Ship." });
  db.updateThread(proseOnly.id, { state: "review", error: "Everything is done; manual deployment is pending." });

  const declaredOnly = db.createThread({ title: "declaration awaiting QA", workspace, rawPrompt: "ship", brief: "Ship." });
  const declarationRun = db.createRun({ threadId: declaredOnly.id, role: "implementor", model: "test-model", account: "acct-a" });
  db.updateRun(declarationRun.id, { state: "done", endedAt: Date.now() });
  db.updateThreadStageOutputs(declaredOnly.id, {
    routeDecision: routeWithQa,
    manualDeployment: declareManualDeployment(claim, "implementor", declarationRun.id),
  });
  db.updateThread(declaredOnly.id, { state: "review", error: "QA did not complete." });

  const repaired = new ThreadManager(db, hub, memory, new StubAccounts() as unknown as AccountManager);
  assert.equal(db.getThread(legacy.id)?.state, "done", "structured accepted reviewer evidence is unequivocal");
  assert.equal(db.getThread(legacy.id)?.manualDeployment?.status, "verified");
  assert.equal(db.getThread(proseOnly.id)?.state, "review", "prose alone is never migration authority");
  assert.equal(db.getThread(proseOnly.id)?.manualDeployment, null);
  assert.equal(db.getThread(declaredOnly.id)?.state, "review", "QA-enabled declarations still require a verifier");
  assert.equal(db.getThread(declaredOnly.id)?.manualDeployment?.status, "declared");

  // A previously verified marker is also repairable and remains idempotent.
  const fenced = db.createThread({ title: "verified crash gap", workspace, rawPrompt: "ship", brief: "Ship." });
  const fencedQa = db.createRun({ threadId: fenced.id, role: "qa", model: "test-reviewer", account: "acct-a" });
  db.updateRun(fencedQa.id, { state: "done", endedAt: Date.now() });
  const marker = verifyManualDeployment(declareManualDeployment(claim, "qa", fencedQa.id), "qa", fencedQa.id);
  db.updateThreadStageOutputs(fenced.id, { manualDeployment: marker });
  db.updateThread(fenced.id, { state: "review", error: "restart interrupted the terminal transition" });
  const repairedAgain = new ThreadManager(db, hub, memory, new StubAccounts() as unknown as AccountManager);
  assert.equal(db.getThread(fenced.id)?.state, "done");
  const fencedNotes = db.listMessages(fenced.id).length;
  assert.equal(repairedAgain.settleManualDeployment(fenced.id), true);
  assert.equal(db.listMessages(fenced.id).length, fencedNotes);

  for (const item of [manager, restarted, repaired, repairedAgain]) disposeManager(item);
  db.raw.close();
} finally {
  config.noPushRepoPattern = originalPattern;
  rmSync(root, { recursive: true, force: true });
}

console.log("Manual-deployment integration gate passed - strict completion, blockers, retries, restart, repair, API state, and copy are covered.");
