/**
 * Durable implementor memo integration gate.
 *
 * REAL: SQLite schema/mappers/transactions, ThreadManager terminal + boundary writers, restart
 * reconciliation, EventHub publications, Retry deletion semantics, and late deliverable refresh.
 * STUBBED: agent/account processes only. No paid run or network access occurs.
 */

process.env.CAP_RETRY_MS = "0";
process.env.ACCOUNT_PING_MS = "3600000";
process.env.FAST_ACCOUNT_PING_MS = "3600000";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountManager } from "../accounts/accountManager.js";
import type { ResultEvent } from "../agents/runner.js";
import type { ImplementationMemo, ImplementationMemoHandoff } from "../types.js";

const { Db } = await import("../db/db.js");
const { EventHub } = await import("../events.js");
const { FileMemoryService } = await import("../memory/memory.js");
const { ThreadManager, implementationMemoEvidence } = await import("../orchestrator/threadManager.js");

let passed = 0;
const failures: string[] = [];
function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

class StubAccounts {
  onUsageRefresh(_cb: () => void): void {}
  effectiveUtilization(): number | null { return null; }
  soonestResetAt(): number | null { return null; }
  hasHeadroom(): boolean { return true; }
  setPingInterval(_ms: number): void {}
  applyEnabled(_id: string, _enabled: boolean): void {}
  applyWeeklySafetyPct(_id: string, _pct: number): void {}
  setSpreadUsage(_on: boolean): void {}
  auxToken(): string | undefined { return undefined; }
}

type Privates = {
  recordImplementationMemo(runId: string, result: ResultEvent | undefined, handoff?: ImplementationMemoHandoff): ImplementationMemo | null;
  markPendingImplementationMemoResumed(threadId: string): void;
  expireActiveDeadline(threadId: string, expectedDeadline?: number): Promise<void>;
  capSupervisor?: NodeJS.Timeout;
  tokenResumeTimer?: NodeJS.Timeout;
  capResumeWake?: NodeJS.Timeout;
};

const dir = mkdtempSync(join(tmpdir(), "implementation-memos-"));
const db = new Db(join(dir, "orchestrator.sqlite"));
const hub = new EventHub();
const published: ImplementationMemo[] = [];
hub.subscribe((event) => {
  if (event.type === "thread.memo") published.push(event.memo);
});

// Seed an orphan before manager construction: its boot reconciliation is a real restart path.
const restartThread = db.createThread({ title: "restart", workspace: dir, rawPrompt: "restart test" });
db.updateThread(restartThread.id, { state: "closed" });
const orphan = db.createRun({ threadId: restartThread.id, role: "implementor", model: "gpt-5.6-sol", account: "codex:gpt-5.6-sol" });
db.updateRun(orphan.id, { state: "running" });
db.addMessage({ threadId: restartThread.id, runId: orphan.id, role: "implementor", kind: "text", content: "Partial work before restart." });
const corruptThread = db.createThread({ title: "corrupt restart", workspace: dir, rawPrompt: "corrupt restart test" });
db.updateThread(corruptThread.id, { state: "closed" });
const corruptOrphan = db.createRun({ threadId: corruptThread.id, role: "implementor", model: "claude-opus-4-8", account: "subscription-b" });
db.updateRun(corruptOrphan.id, { state: "running", endedAt: Date.now() - 1 });

const manager = new ThreadManager(
  db,
  hub,
  new FileMemoryService(join(dir, "memory")),
  new StubAccounts() as unknown as AccountManager,
);
const priv = manager as unknown as Privates;

console.log("\nA. restart/interruption truthfulness and idempotency");
const interrupted = db.implementationMemoForRun(orphan.id);
check("boot reconciliation creates an interrupted memo", interrupted?.outcome === "interrupted", interrupted?.outcome);
check("partial output is preserved but not called completed", interrupted?.report === "Partial work before restart.");
check("restart diagnostic is durable", !!interrupted?.diagnostic);
priv.markPendingImplementationMemoResumed(restartThread.id);
priv.recordImplementationMemo(orphan.id, undefined); // duplicate/late reconciliation callback
const restartMemos = db.listImplementationMemos(restartThread.id);
check("restart + duplicate delivery converge on one row per run", restartMemos.length === 1, String(restartMemos.length));
check("auto-resume remains visible on the same revision", restartMemos[0]?.handoff === "resumed", restartMemos[0]?.handoff);
check("restart repairs an ended-but-live implementor with a truthful memo", db.implementationMemoForRun(corruptOrphan.id)?.outcome === "interrupted");

console.log("\nB. successful implementation handoffs and exact report capture");
const work = db.createThread({ title: "normal", workspace: dir, rawPrompt: "normal test" });
db.updateThread(work.id, { state: "closed" });
const first = db.createRun({ threadId: work.id, role: "implementor", model: "claude-opus-4-8", account: "subscription-a" });
const firstReport = "Implemented memo persistence.\n\nValidation: `npm test` passed.\n\nCommit: abc123 pushed.\n\nLimitations: none. Remaining work: none.";
db.addMessage({ threadId: work.id, runId: first.id, role: "implementor", kind: "text", content: firstReport });
db.updateRun(first.id, { state: "done", endedAt: Date.now() });
const firstMemo = priv.recordImplementationMemo(first.id, { type: "result", subtype: "success", isError: false }, "qa");
check("success → QA creates completed revision 1", firstMemo?.outcome === "completed" && firstMemo.handoff === "qa" && firstMemo.revision === 1);
check("CLI-style text event is stored verbatim as the report", firstMemo?.report === firstReport);
check("model/account/run/work revision are tied to the memo", firstMemo?.model === "claude-opus-4-8" && firstMemo.account === "subscription-a" && firstMemo.runId === first.id && firstMemo.workRevision === "implementation:1");

// Late bridge output updates the same memo. A replayed semantic duplicate must not duplicate the file.
manager.postFinding({ threadId: work.id, fromRunId: first.id, fromRole: "implementor", kind: "deliverable", summary: "Owner report", label: "Owner report", path: join(dir, "report.md"), severity: "info" });
manager.postFinding({ threadId: work.id, fromRunId: first.id, fromRole: "implementor", kind: "deliverable", summary: "Owner report", label: "Owner report", path: join(dir, "report.md"), severity: "info" });
const withFile = db.implementationMemoForRun(first.id);
check("late deliverable bridge output refreshes the existing memo", withFile?.deliverables.length === 1, String(withFile?.deliverables.length));

const parked = db.createRun({ threadId: work.id, role: "implementor", model: "grok-4.6", account: "grok:grok-4.6" });
const parkedReport = "Implementation is complete, but deployment approval remains.";
db.updateRun(parked.id, { state: "done", endedAt: Date.now() });
const parkedMemo = priv.recordImplementationMemo(parked.id, { type: "result", subtype: "success", isError: false, result: parkedReport }, "review");
check("implementation → review records the real successful report", parkedMemo?.outcome === "completed" && parkedMemo.handoff === "review" && parkedMemo.report === parkedReport);

console.log("\nB2. real pipeline boundaries publish the expected handoff");
// Keep the orchestration loop real and replace only paid agent leaves, following the integration-test
// discipline used by qaRoundBudget.itest. This proves the route wiring rather than only the DB writer.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const routeInternals = manager as any;
let routeResult: ResultEvent = { type: "result", subtype: "success", isError: false };
let qaCalls = 0;
routeInternals.startResumedImplementor = async (thread: { id: string }) => {
  const run = db.createRun({ threadId: thread.id, role: "implementor", model: "gpt-5.6-sol", account: "codex:gpt-5.6-sol" });
  db.addMessage({
    threadId: thread.id,
    runId: run.id,
    role: "implementor",
    kind: "text",
    content: routeResult.isError ? "Partial route work before failure." : "Pipeline implementation completed. Tests passed. Commit and push completed. Remaining work: none.",
  });
  db.updateRun(run.id, {
    state: routeResult.isError ? "error" : "done",
    error: routeResult.isError ? "provider failed during implementation" : null,
    endedAt: Date.now(),
  });
  return { run: { send(): void {} }, runId: run.id, accountId: "codex" };
};
routeInternals.awaitImplementorCompletion = async () => routeResult;
routeInternals.drainQueuedImplementor = async (_thread: unknown, _effort: unknown, _kickoff: string, result: ResultEvent) => result;
routeInternals.stopLive = async () => {};
routeInternals.flushDirectorNotes = () => {};
routeInternals.runSelfImprovement = async () => {};
routeInternals.runQA = async () => {
  qaCalls++;
  return { pass: true, changed: false, summary: "QA passed" };
};

const qaRoute = db.createThread({ title: "pipeline to qa", workspace: dir, rawPrompt: "pipeline qa test" });
await routeInternals.runImplementorQaLoop(qaRoute, "test kickoff", undefined, undefined, undefined, {
  qaEnabled: true,
  maxQaRounds: 1,
  qaAppliesFixes: false,
  autoPush: true,
});
const qaRouteMemo = db.listImplementationMemos(qaRoute.id).at(-1);
check("successful real pipeline route records QA handoff", qaCalls === 1 && qaRouteMemo?.outcome === "completed" && qaRouteMemo.handoff === "qa");
check("QA traffic does not alter the captured implementor report", qaRouteMemo?.report?.startsWith("Pipeline implementation completed.") === true);

routeResult = { type: "result", subtype: "error_during_execution", isError: true, errors: ["provider failed"] };
const reviewRoute = db.createThread({ title: "pipeline to review", workspace: dir, rawPrompt: "pipeline review test" });
await routeInternals.runImplementorQaLoop(reviewRoute, "test kickoff", undefined, undefined, undefined, {
  qaEnabled: true,
  maxQaRounds: 1,
  qaAppliesFixes: false,
  autoPush: true,
});
const reviewRouteMemo = db.listImplementationMemos(reviewRoute.id).at(-1);
check("failed real pipeline route records owner-review handoff", reviewRouteMemo?.outcome === "failed" && reviewRouteMemo.handoff === "review" && db.getThread(reviewRoute.id)?.state === "review");

console.log("\nC. bounced work creates a new current revision without losing prior revisions");
const bounced = db.createRun({ threadId: work.id, role: "implementor", model: "glm-4.7", account: "zai:glm-4.7" });
const bouncedReport = "Fixed every reviewer issue. Validation passed. Commit def456 pushed. Remaining work: none.";
db.updateRun(bounced.id, { state: "done", endedAt: Date.now() });
const bouncedMemo = priv.recordImplementationMemo(bounced.id, { type: "result", subtype: "success", isError: false, result: bouncedReport }, "reviewer");
const revisions = db.listImplementationMemos(work.id);
check("bounced pass is revision 3 and current", bouncedMemo?.revision === 3 && revisions.at(-1)?.id === bouncedMemo?.id);
check("both earlier revision memos remain auditable", revisions.length === 3 && revisions[0]?.report === firstReport && revisions[1]?.report === parkedReport);

console.log("\nD. failed and no-conclusion runs are never fabricated as success");
const failedRun = db.createRun({ threadId: work.id, role: "implementor", model: "gpt-5.6-sol", account: "codex:gpt-5.6-sol" });
db.updateRun(failedRun.id, { state: "error", error: "git hook rejected the commit", endedAt: Date.now() });
const failedMemo = priv.recordImplementationMemo(failedRun.id, { type: "result", subtype: "error_during_execution", isError: true, errors: ["hook failed"] }, "review");
check("failed run is labeled failed with its persisted diagnostic", failedMemo?.outcome === "failed" && failedMemo.diagnostic === "git hook rejected the commit");

const hollowRun = db.createRun({ threadId: work.id, role: "implementor", model: "claude-opus-4-8" });
db.updateRun(hollowRun.id, { state: "done", endedAt: Date.now() });
const hollowMemo = priv.recordImplementationMemo(hollowRun.id, { type: "result", subtype: "success", isError: false }, "review");
check("success envelope with no conclusion is labeled no-conclusion", hollowMemo?.outcome === "no_conclusion" && !hollowMemo.report && !!hollowMemo.diagnostic);
const aborted = implementationMemoEvidence(
  { state: "done", error: null },
  { type: "result", subtype: "success", isError: false, result: "unfinished", aborted: true, terminalReason: "aborted_tools" },
  undefined,
);
check("success-shaped aborted result is labeled interrupted", aborted.outcome === "interrupted");
const unconfirmed = implementationMemoEvidence(
  { state: "running", error: null },
  undefined,
  "I changed one file but have not validated or committed it.",
);
check("partial prose without a provider result is not called completed", unconfirmed.outcome === "no_conclusion" && !!unconfirmed.report);

const deadlineThread = db.createThread({ title: "deadline", workspace: dir, rawPrompt: "deadline test" });
db.updateThread(deadlineThread.id, { state: "implementing" });
db.setActiveDeadline(deadlineThread.id, Date.now() - 1);
const deadlineRun = db.createRun({ threadId: deadlineThread.id, role: "implementor", model: "gpt-5.6-sol", account: "codex:gpt-5.6-sol" });
db.updateRun(deadlineRun.id, { state: "running" });
db.addMessage({ threadId: deadlineThread.id, runId: deadlineRun.id, role: "implementor", kind: "text", content: "Partial deadline work." });
await priv.expireActiveDeadline(deadlineThread.id, db.getThread(deadlineThread.id)?.activeDeadlineAt ?? undefined);
const deadlineMemo = db.implementationMemoForRun(deadlineRun.id);
check("hard-deadline teardown persists interrupted evidence", deadlineMemo?.outcome === "interrupted" && deadlineMemo.handoff === "review" && !!deadlineMemo.diagnostic);

const racedRun = db.createRun({ threadId: deadlineThread.id, role: "implementor", model: "gpt-5.6-sol", account: "codex:gpt-5.6-sol" });
db.addMessage({ threadId: deadlineThread.id, runId: racedRun.id, role: "implementor", kind: "text", content: "Success-shaped output raced the deadline." });
db.updateRun(racedRun.id, { state: "done", endedAt: Date.now() });
priv.recordImplementationMemo(racedRun.id, { type: "result", subtype: "success", isError: false }, "pending");
db.updateRun(racedRun.id, { state: "interrupted", error: "deadline won the boundary race" });
const correctedRace = priv.recordImplementationMemo(racedRun.id, undefined, "review");
check("authoritative interruption corrects an optimistic same-run memo", correctedRace?.outcome === "interrupted" && correctedRace.handoff === "review");

console.log("\nE. Retry and post-task self-improvement semantics");
db.resetThreadForRetry(work.id);
const afterRetry = db.listImplementationMemos(work.id);
check("Retry retains every prior memo even after deleting runs/feed/findings", afterRetry.length === 5, String(afterRetry.length));
check("deleted deliverable finding becomes an archived snapshot, not lost", afterRetry[0]?.deliverables[0]?.available === false);

const afterRetryRun = db.createRun({ threadId: work.id, role: "implementor", model: "gpt-5.6-sol", account: "codex:gpt-5.6-sol" });
db.updateRun(afterRetryRun.id, { state: "done", endedAt: Date.now() });
const next = priv.recordImplementationMemo(afterRetryRun.id, { type: "result", subtype: "success", isError: false, result: "Retry completed and validated." }, "qa");
check("new retry pass appends the next revision", next?.revision === 6);

const bonus = db.createThread({ title: "bonus", workspace: dir, rawPrompt: "bonus" });
db.updateThread(bonus.id, { state: "closed" });
db.updateThreadStageOutputs(bonus.id, { selfImproving: true });
const bonusRun = db.createRun({ threadId: bonus.id, role: "implementor", model: "claude-opus-4-8" });
db.addMessage({ threadId: bonus.id, runId: bonusRun.id, role: "implementor", kind: "text", content: "Built an optional skill." });
db.updateRun(bonusRun.id, { state: "done", endedAt: Date.now() });
check("post-task self-improvement noise does not become a work memo", priv.recordImplementationMemo(bonusRun.id, { type: "result", subtype: "success", isError: false }, "done") === null);
check("memo events carry stable ids so live duplicates are mergeable", published.length > 0 && new Set(published.map((memo) => memo.id)).size < published.length);

console.log("\nF. One-time backfill of work that predates durable memos");
// A legacy database: real run/message history, no memo rows, and the backfill flag cleared so the very
// next open replays the migration exactly as a production deploy would.
const legacyPath = join(dir, "legacy.sqlite");
const seed = new Db(legacyPath);
const doneTask = seed.createThread({ title: "legacy done", workspace: dir, rawPrompt: "legacy done" });
seed.updateThread(doneTask.id, { state: "done" });
const legacyFirst = seed.createRun({ threadId: doneTask.id, role: "implementor", model: "claude-opus-4-8", account: "subscription-a" });
seed.addMessage({ threadId: doneTask.id, runId: legacyFirst.id, role: "implementor", kind: "text", content: "First attempt hit the turn ceiling." });
seed.updateRun(legacyFirst.id, { state: "error", error: "Stopped at the per-session turn ceiling", endedAt: Date.now() - 5000 });
const legacySecond = seed.createRun({ threadId: doneTask.id, role: "implementor", model: "claude-opus-4-8", account: "subscription-a" });
const legacyReport = "Legacy work: shipped the parser fix, `npm test` passed, commit abc123 pushed.";
seed.addMessage({ threadId: doneTask.id, runId: legacySecond.id, role: "implementor", kind: "text", content: legacyReport });
const legacyFile = seed.addFinding({ threadId: doneTask.id, fromRunId: legacySecond.id, fromRole: "implementor", kind: "deliverable", summary: "Legacy report", label: "Legacy report", path: join(dir, "legacy.md"), severity: "info" });
seed.updateRun(legacySecond.id, { state: "done", endedAt: Date.now() - 4000 });
// The reflection round the feature must never present as a work revision.
seed.addMessage({ threadId: doneTask.id, role: "implementor", kind: "system", content: "🛠 Task accepted — running the opt-in self-improvement round before settling to done." });
const legacyBonus = seed.createRun({ threadId: doneTask.id, role: "implementor", model: "claude-opus-4-8", account: "subscription-a" });
seed.addMessage({ threadId: doneTask.id, runId: legacyBonus.id, role: "implementor", kind: "text", content: "Wrote an optional skill nobody asked for." });
seed.updateRun(legacyBonus.id, { state: "done", endedAt: Date.now() - 3000 });

const parkedTask = seed.createThread({ title: "legacy parked", workspace: dir, rawPrompt: "legacy parked" });
seed.updateThread(parkedTask.id, { state: "review" });
const legacyParked = seed.createRun({ threadId: parkedTask.id, role: "implementor", model: "gpt-5.6-sol", account: "codex:gpt-5.6-sol" });
seed.updateRun(legacyParked.id, { state: "done", endedAt: Date.now() - 2000 });

const liveTask = seed.createThread({ title: "legacy live", workspace: dir, rawPrompt: "legacy live" });
seed.updateThread(liveTask.id, { state: "implementing" });
const legacyLive = seed.createRun({ threadId: liveTask.id, role: "implementor", model: "grok-4.6", account: "grok:grok-4.6" });
seed.raw.prepare("DELETE FROM kv WHERE key = ?").run("implementation_memo_backfill_v1");
seed.raw.close();

const started = Date.now();
const migrated = new Db(legacyPath);
const elapsed = Date.now() - started;
console.log(`  · backfill migration took ${elapsed}ms on the fixture`);
const doneMemos = migrated.listImplementationMemos(doneTask.id);
check("backfill imports every prior implementor run as its own revision", doneMemos.length === 2, String(doneMemos.length));
check("the reflection round is excluded from the work revisions", !doneMemos.some((memo) => memo.runId === legacyBonus.id));
check("a turn-ceiling run is imported truthfully, not as a completion", doneMemos[0]?.outcome === "failed" && doneMemos[0]?.diagnostic === "Stopped at the per-session turn ceiling");
check("the last durable prose of the run becomes its report", doneMemos[1]?.report === legacyReport && doneMemos[1]?.outcome === "completed");
check("a superseded revision reads as resumed, the newest takes the task's state", doneMemos[0]?.handoff === "resumed" && doneMemos[1]?.handoff === "done");
check("reconstructed rows are labeled as such", doneMemos.every((memo) => memo.source === "backfill"));
check("backfilled deliverables keep their live download identity", doneMemos[1]?.deliverables[0]?.findingId === legacyFile.id && doneMemos[1]?.deliverables[0]?.available === true);
check("a parked task's newest run reads as needing owner review", migrated.listImplementationMemos(parkedTask.id).at(-1)?.handoff === "review");
check("a run still live at the deploy boundary is left to boot reconciliation", migrated.listImplementationMemos(liveTask.id).length === 0 && !migrated.implementationMemoForRun(legacyLive.id));
migrated.raw.close();

// Reopening must be a no-op: the flag holds, and nothing is imported twice.
const reopened = new Db(legacyPath);
check("reopening does not re-import (the kv flag holds)", reopened.listImplementationMemos(doneTask.id).length === 2, String(reopened.listImplementationMemos(doneTask.id).length));
check("a post-backfill run appends after the imported revisions", (() => {
  const fresh = reopened.createRun({ threadId: doneTask.id, role: "implementor", model: "claude-opus-5", account: "subscription-a" });
  reopened.updateRun(fresh.id, { state: "done", endedAt: Date.now() });
  return reopened.upsertImplementationMemo({
    threadId: doneTask.id,
    runId: fresh.id,
    outcome: "completed",
    handoff: "qa",
    report: "New work after the deploy.",
    model: "claude-opus-5",
    startedAt: Date.now(),
    completedAt: Date.now(),
  }).revision === 3;
})());
check("a memo captured live is not labeled reconstructed", reopened.listImplementationMemos(doneTask.id).at(-1)?.source === "run");
reopened.raw.close();


try {
  if (priv.capSupervisor) clearInterval(priv.capSupervisor);
  if (priv.tokenResumeTimer) clearTimeout(priv.tokenResumeTimer);
  if (priv.capResumeWake) clearTimeout(priv.capResumeWake);
  db.raw.close();
  rmSync(dir, { recursive: true, force: true });
} catch {
  // The process exits below; Windows releases a transient SQLite/temp-dir handle with it.
}

console.log(`\n${failures.length ? "FAIL" : "PASS"} — ${passed} checks passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  ✗ ${failure}`);
process.exit(failures.length ? 1 : 0);
