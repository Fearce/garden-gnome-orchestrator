/**
 * Integration test — a restart's auto-resume promise survives a SECOND restart (real ThreadManager machinery).
 *
 * Regression guard for a bug seen in production (2026-08-08): `markInterrupted` persists state='failed' +
 * RESTART_AUTO_RESUME_MSG and then holds the actual resume only in an in-memory `setTimeout`. A second
 * bounce inside that window dropped it for good — the next boot only scans IN_FLIGHT states, and the thread
 * is 'failed' by then. Two real tasks (that night's own nightly sweep among them) sat for two days showing
 * the promise "auto-resuming…" with nothing ever coming back for them. The persisted marker outlives the
 * process, so it IS the record that a resume is still owed: the next boot re-arms from it.
 *
 * WHAT IS REAL vs. STUBBED
 *  - REAL: `markInterrupted` + `reviveStrandedAutoResumes` (both run in the ThreadManager constructor, so
 *    "reboot" == constructing another manager over the same Db), the fire path that keeps each promise
 *    (holds, token-safety park, honest hand-back), the owner-answer resume, the durable revival counter,
 *    the crash-loop guard, and the real `Db` + `EventHub` behind them.
 *  - STUBBED: `resumeThread` (a delivered auto-resume is RECORDED instead of spawning an agent; a test can
 *    make it refuse or throw) and `startPipeline` (the queued re-arm's start).
 *
 * Tests F–M cover the restart classes that used to be stranded by the generic click-Resume hand-back or by
 * a refused resume being dropped silently: a paused task (a pending Proceed became a deadlock), a task
 * waiting on an ask_user answer, an approval gate, a task caught in intake, a refused/throwing/held
 * auto-resume, and a lead or parent reading a restart-owed child as finished.
 *
 * Run:  npm run test:restart-revival   (from server/)
 * Exits non-zero if any assertion fails. Self-contained: creates a throwaway DB + workspace and removes them.
 */

process.env.CAP_RETRY_MS = "0"; // no cap-supervisor interval during the test
process.env.ACCOUNT_PING_MS = "3600000";
process.env.FAST_ACCOUNT_PING_MS = "3600000";

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountManager } from "../accounts/accountManager.js";
import type { Thread } from "../types.js";

const { Db } = await import("../db/db.js");
const { EventHub } = await import("../events.js");
const { FileMemoryService } = await import("../memory/memory.js");
const { ThreadManager } = await import("../orchestrator/threadManager.js");

// The literals the production code persists. Deliberately re-declared rather than imported: they are a
// cross-process CONTRACT (one process writes them, a later one reads them back), so a silent reword must
// fail here instead of both sides moving together.
const AUTO_RESUME_MSG = "interrupted by a server restart — auto-resuming…";
const COWORK_WAIT_MSG = "interrupted by a server restart — auto-resume is waiting for the Co-worker turn using this workspace to finish…";
const AWAITING_ANSWER_MSG =
  "interrupted by a server restart while it was waiting for your answer — answer the open question to resume it, or click Resume to continue without an answer.";
const TOKEN_SAFETY_PREFIX = "⏳ Auto-resume pending — token safety limit";
const MANUAL_RESUME_MSG = "interrupted by a server restart — click Resume to continue from where it left off (finished stages are reused)";
const AUTO_RESUME_DELAY_MS = 4_000;
const MAX_STRANDED_REVIVALS = 3;
const PLANNED_RESTART_KEY = "restart_coordinator_planned_at";
const PLANNED_RESTART_RUN_REASON = "interrupted by a server restart (a planned deploy)";

// ---- tiny assertion harness ------------------------------------------------------------------------
let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    failures.push(label + (detail ? ` — ${detail}` : ""));
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Must carry every method the ThreadManager constructor's boot-apply reaches. */
class StubAccounts {
  onUsageRefresh(_cb: () => void): void {}
  effectiveUtilization(): number | null {
    return null;
  }
  soonestResetAt(): number | null {
    return null;
  }
  hasHeadroom(): boolean {
    return true;
  }
  setPingInterval(_ms: number): void {}
  applyEnabled(_id: string, _enabled: boolean): void {}
  applyWeeklySafetyPct(_id: string, _pct: number): void {}
  setSpreadUsage(_on: boolean): void {}
  setProfileToken(_id: string, _token: string): void {}
  auxToken(): string | undefined {
    return undefined;
  }
}

interface Boot {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mgr: any;
  resumed: string[]; // thread ids this boot actually got as far as resuming
  notes: Map<string, string | undefined>; // the steering note each resume carried
  started: string[]; // thread ids the queued re-arm started
  stop(): void; // "the process dies" — drop its timers, keep the Db
}

type ResumeResult = { ok: boolean; error?: string; state?: string };

interface Bed {
  db: InstanceType<typeof Db>;
  dir: string;
  workspace: string;
  dispose(): void;
}

function makeBed(prefix: string): Bed {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const workspace = join(dir, "workspace");
  mkdirSync(workspace, { recursive: true });
  const db = new Db(join(dir, "orchestrator.sqlite"));
  return {
    db,
    dir,
    workspace,
    dispose() {
      db.raw.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Boot the server over an existing Db. The constructor runs markInterrupted(), so everything this test
 *  asserts about a restart has already happened by the time this returns — except the deferred resume,
 *  which lands AUTO_RESUME_DELAY_MS later into the recorder installed here (synchronously, so it always
 *  wins that race). */
function boot(bed: Bed, resume: (id: string) => Promise<ResumeResult> = async () => ({ ok: true })): Boot {
  const hub = new EventHub();
  const memory = new FileMemoryService(join(bed.dir, "memory"));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mgr = new ThreadManager(bed.db, hub, memory, new StubAccounts() as unknown as AccountManager) as any;
  const resumed: string[] = [];
  const notes = new Map<string, string | undefined>();
  const started: string[] = [];
  mgr.resumeThread = async (id: string, message?: string): Promise<ResumeResult> => {
    resumed.push(id);
    notes.set(id, message);
    return resume(id);
  };
  mgr.startPipeline = (id: string): void => {
    started.push(id);
  };
  return {
    mgr,
    resumed,
    notes,
    started,
    stop() {
      if (mgr.capSupervisor) clearInterval(mgr.capSupervisor);
      if (mgr.tokenResumeTimer) clearTimeout(mgr.tokenResumeTimer);
      // A dead process resumes nothing — its pending setTimeouts die with it. Neutralising what they call
      // is how this test reproduces the second bounce landing inside the auto-resume window.
      mgr.fireRestartResume = async (): Promise<void> => {};
      mgr.resumeThread = async (): Promise<ResumeResult> => ({ ok: false, error: "process is gone" });
      mgr.startPipeline = (): void => {};
    },
  };
}

/** A task the restart caught mid-flight: an implementor live in an AUTO_RESUME state. */
function seedLiveTask(bed: Bed, state: Thread["state"] = "implementing"): string {
  const t = bed.db.createThread({ title: "mock live task", workspace: bed.workspace, rawPrompt: "do the thing" });
  bed.db.updateThreadStageOutputs(t.id, { kickoff: "KICKOFF: mock", planDone: true, approved: true });
  bed.db.updateThread(t.id, { state });
  bed.db.createRun({ threadId: t.id, role: "implementor", model: "claude-opus-5-5" });
  return t.id;
}

/** A task already left stranded by an earlier boot: the promise persisted, the resume never fired. */
function seedStrandedTask(bed: Bed, opts: { error?: string; revivals?: number; ageMs?: number } = {}): string {
  const t = bed.db.createThread({ title: "mock stranded task", workspace: bed.workspace, rawPrompt: "do the thing" });
  bed.db.updateThreadStageOutputs(t.id, {
    kickoff: "KICKOFF: mock",
    planDone: true,
    approved: true,
    ...(opts.revivals == null ? {} : { autoResumeRevivals: opts.revivals }),
  });
  bed.db.updateThread(t.id, { state: "failed", error: opts.error ?? AUTO_RESUME_MSG });
  // `updated_at` is when the promise was stamped — nothing touches it while the task sits stranded, so it
  // is what the staleness bound reads. Set it directly; there is no API for backdating a thread.
  if (opts.ageMs) bed.db.raw.prepare("UPDATE threads SET updated_at = ? WHERE id = ?").run(Date.now() - opts.ageMs, t.id);
  return t.id;
}

/** Interrupted implementor runs that died within seconds of starting — what the crash-loop guard counts. */
function seedFastInterrupts(bed: Bed, threadId: string, n: number): void {
  const at = Date.now();
  for (let i = 0; i < n; i++) {
    const r = bed.db.createRun({ threadId, role: "implementor", model: "claude-opus-5-5" });
    bed.db.updateRun(r.id, { state: "interrupted", endedAt: at - 1_000 });
  }
}

async function testStrandedPromiseIsRevived(): Promise<void> {
  console.log("\nTest A — a second bounce inside the auto-resume window doesn't lose the resume\n");
  const bed = makeBed("restart-revive-");
  const id = seedLiveTask(bed);

  // Boot 1: the restart that killed the task. It promises an auto-resume 4s out…
  const first = boot(bed);
  const afterFirst = bed.db.getThread(id)!;
  check("boot 1 flips the live task to 'failed' with the durable auto-resume promise", afterFirst.state === "failed" && afterFirst.error === AUTO_RESUME_MSG, `state=${afterFirst.state} error=${afterFirst.error}`);
  check("…and starts it on a fresh revival budget", bed.db.getThreadStageOutputs(id).autoResumeRevivals === 0, JSON.stringify(bed.db.getThreadStageOutputs(id).autoResumeRevivals));

  // …and dies before the timer fires. This is the production sequence: the 08-08 boot at 01:06:59 was
  // followed by another at ~01:07:17, and the promise was never kept.
  first.stop();
  check("the dead boot resumed nothing", first.resumed.length === 0);

  // Boot 2 sees only what is on disk: 'failed' — a state markInterrupted's IN_FLIGHT scan skips.
  const second = boot(bed);
  check("the promise is still on disk for boot 2 to find", bed.db.getThread(id)?.error === AUTO_RESUME_MSG);
  await sleep(AUTO_RESUME_DELAY_MS + 800);
  check("boot 2 re-arms the lost auto-resume", second.resumed.includes(id), `resumed=[${second.resumed.join(",")}]`);
  check("…and charges the attempt durably once it fires, so it can't loop forever", bed.db.getThreadStageOutputs(id).autoResumeRevivals === 1, String(bed.db.getThreadStageOutputs(id).autoResumeRevivals));
  // The forensic trail: index.ts writes this to crash.log, which is what makes a restart's effect on
  // in-flight work greppable rather than a cross-table reconstruction after the fact.
  check("boot 1 reports what it interrupted", (first.mgr.bootReconcile ?? "").includes("resumed=1"), String(first.mgr.bootReconcile));
  check("boot 2 reports the revival", (second.mgr.bootReconcile ?? "").includes("revived=1"), String(second.mgr.bootReconcile));

  second.stop();
  bed.dispose();
}

async function testOnlyTheOwedOnesAreRevived(): Promise<void> {
  console.log("\nTest B — only a thread that is actually owed a resume is touched\n");
  const bed = makeBed("restart-revive-controls-");
  const owed = seedStrandedTask(bed);
  // The human-gated twin: a restart during a question/approval leaves THIS message and must stay put —
  // reviving it would spawn an agent on work that was deliberately waiting for a person.
  const manual = seedStrandedTask(bed, { error: MANUAL_RESUME_MSG });
  // An ordinary failure, and a failure with no error text at all.
  const ordinary = seedStrandedTask(bed, { error: "Workspace \"C:\\gone\" does not exist on disk — agents can't run there." });
  const blank = seedStrandedTask(bed, { error: "" });
  // Budget spent: attempts that never got the task running again belong to a person now.
  const spent = seedStrandedTask(bed, { revivals: MAX_STRANDED_REVIVALS });
  // Crash-looping: the resumes DO start and die within seconds — the pre-existing guard must still bind.
  const looping = seedStrandedTask(bed);
  seedFastInterrupts(bed, looping, 3);
  // Too old to pick up: the promise meant "in 4 seconds". Waking a day-old session onto a workspace other
  // agents have since committed to is a surprise, not a recovery — a person decides that one.
  const stale = seedStrandedTask(bed, { ageMs: 25 * 3600_000 });
  const justInside = seedStrandedTask(bed, { ageMs: 23 * 3600_000 });

  const b = boot(bed);
  await sleep(AUTO_RESUME_DELAY_MS + 800);

  check("the owed task is revived", b.resumed.includes(owed), `resumed=[${b.resumed.join(",")}]`);
  check("a restart that was waiting on a person is left alone", !b.resumed.includes(manual));
  check("…and keeps its click-Resume message", bed.db.getThread(manual)?.error === MANUAL_RESUME_MSG);
  check("an ordinary failure is not revived", !b.resumed.includes(ordinary));
  check("a failure with no error text is not revived", !b.resumed.includes(blank));

  check("a task whose revival budget is spent is not revived", !b.resumed.includes(spent));
  const spentErr = bed.db.getThread(spent)?.error ?? "";
  check("…and it stops claiming it is auto-resuming", spentErr !== AUTO_RESUME_MSG, spentErr);
  check("…and says a click is needed now", /Resume/.test(spentErr), spentErr);
  check("…while still reading as a restart interruption for the resume seed", spentErr.startsWith("interrupted by a server restart"), spentErr);

  check("a crash-looping task is not revived either", !b.resumed.includes(looping));
  check("…and says so rather than promising a resume", (bed.db.getThread(looping)?.error ?? "") !== AUTO_RESUME_MSG, bed.db.getThread(looping)?.error ?? "");

  check("a promise older than the staleness bound is not revived", !b.resumed.includes(stale));
  check("…and says it is too old rather than still promising", /too old to pick up/.test(bed.db.getThread(stale)?.error ?? ""), bed.db.getThread(stale)?.error ?? "");
  check("…while one just inside the bound still is", b.resumed.includes(justInside), `resumed=[${b.resumed.join(",")}]`);

  b.stop();
  bed.dispose();
}

async function testRevivalIsBoundedThenReleased(): Promise<void> {
  console.log("\nTest C — the budget counts resumes that fired, and a fresh interruption clears it\n");
  const bed = makeBed("restart-revive-budget-");
  const id = seedStrandedTask(bed);

  // Boot after boot, each resume FIRING but the process dying before it got the task running — the stub
  // leaves the promise on disk exactly as a pipeline killed before its first stage would. The attempts
  // accumulate and then stop.
  const armed: number[] = [];
  for (let i = 0; i < MAX_STRANDED_REVIVALS + 1; i++) {
    const b = boot(bed);
    await sleep(AUTO_RESUME_DELAY_MS + 400);
    armed.push(b.resumed.length);
    b.stop();
  }
  check(`the resume fires ${MAX_STRANDED_REVIVALS}× and then stops`, armed.join(",") === [...Array(MAX_STRANDED_REVIVALS).fill(1), 0].join(","), armed.join(","));
  check("the counter records every attempt that fired", bed.db.getThreadStageOutputs(id).autoResumeRevivals === MAX_STRANDED_REVIVALS, String(bed.db.getThreadStageOutputs(id).autoResumeRevivals));
  check("…and the spent promise is handed back for a click", /re-armed and started 3×/.test(bed.db.getThread(id)?.error ?? ""), bed.db.getThread(id)?.error ?? "");

  // A LATER genuine interruption is a new episode — it must get the full budget again, or a long-lived
  // task that survived three strandings over its lifetime could never be auto-resumed again.
  bed.db.updateThread(id, { state: "implementing", error: null });
  bed.db.createRun({ threadId: id, role: "implementor", model: "claude-opus-5-5" });
  const fresh = boot(bed);
  check("a fresh interruption resets the budget", bed.db.getThreadStageOutputs(id).autoResumeRevivals === 0, String(bed.db.getThreadStageOutputs(id).autoResumeRevivals));
  await sleep(AUTO_RESUME_DELAY_MS + 400);
  check("…and that interruption's own resume still fires", fresh.resumed.includes(id));

  fresh.stop();
  bed.dispose();
}

async function testQaRestartRetriesOnlyQa(): Promise<void> {
  console.log("\nTest D — a restart during QA preserves the completed implementation and retries only QA\n");
  const bed = makeBed("restart-qa-direct-");
  const id = seedLiveTask(bed, "qa");
  bed.db.updateThreadStageOutputs(id, { qaRoundsUsed: 2 });
  const b = boot(bed);
  const stage = bed.db.getThreadStageOutputs(id);
  const thread = bed.db.getThread(id);
  check("the restart records the interrupted QA round", stage.qaInterruptedRetryRound === 2, JSON.stringify(stage));
  check("the restart still persists its normal auto-resume promise", thread?.state === "failed" && thread.error === AUTO_RESUME_MSG, `${thread?.state} ${thread?.error}`);
  b.stop();
  bed.dispose();
}

async function testPlannedDeploysAreNotACrashLoop(): Promise<void> {
  console.log("\nTest E — back-to-back planned deploys never trip the crash-loop guard\n");
  // Deploys restart GGO immediately, so a busy repo can bounce a task three times inside the guard's
  // window, each time while its resumed CLI is still booting. That is deploy traffic, not a crash loop.
  const bed = makeBed("restart-planned-");
  const id = seedLiveTask(bed);
  const earlier = Date.now() - 1_000;
  for (let i = 0; i < 2; i++) {
    const r = bed.db.createRun({ threadId: id, role: "implementor", model: "claude-opus-5-5" });
    bed.db.updateRun(r.id, { state: "interrupted", endedAt: earlier, error: PLANNED_RESTART_RUN_REASON });
  }
  bed.db.kvSet(PLANNED_RESTART_KEY, String(Date.now() - 5_000));
  const b = boot(bed);
  const killed = bed.db.listRuns(id).filter((r) => r.error === PLANNED_RESTART_RUN_REASON);
  check("the run this deploy killed is stamped as a planned restart", killed.length === 3, String(killed.length));
  check("the marker is consumed, so a later crash is judged on its own", !bed.db.kvGet(PLANNED_RESTART_KEY));
  check("the task still gets its auto-resume promise", bed.db.getThread(id)?.error === AUTO_RESUME_MSG, bed.db.getThread(id)?.error ?? "");
  await sleep(AUTO_RESUME_DELAY_MS + 800);
  check("…and is resumed onto the new build", b.resumed.includes(id), `resumed=[${b.resumed.join(",")}]`);
  b.stop();
  bed.dispose();

  // Control: without a fresh marker the same shape is a genuine crash loop and must still be caught.
  const crashBed = makeBed("restart-crash-");
  const crashing = seedLiveTask(crashBed);
  seedFastInterrupts(crashBed, crashing, 2);
  crashBed.db.kvSet(PLANNED_RESTART_KEY, String(Date.now() - 60 * 60_000));
  const c = boot(crashBed);
  await sleep(AUTO_RESUME_DELAY_MS + 800);
  check("a stale marker does not excuse a crash", !c.resumed.includes(crashing), `resumed=[${c.resumed.join(",")}]`);
  check("…so the crash loop is still handed to a person", /crash loop/.test(crashBed.db.getThread(crashing)?.error ?? ""), crashBed.db.getThread(crashing)?.error ?? "");
  c.stop();
  crashBed.dispose();
}

async function testBootsThatDieBeforeFiringSpendNothing(): Promise<void> {
  console.log("\nTest F — a bounce loop that never lets the timer fire does not spend the budget\n");
  // A deploy storm can bounce GGO every few seconds. None of those boots spawned anything, so none of
  // them may count against the task: the old per-boot charge gave up on it after three such bounces.
  const bed = makeBed("restart-unfired-");
  const id = seedStrandedTask(bed);
  for (let i = 0; i < MAX_STRANDED_REVIVALS + 2; i++) boot(bed).stop();
  check("five boots that died inside the window charged nothing", (bed.db.getThreadStageOutputs(id).autoResumeRevivals ?? 0) === 0, String(bed.db.getThreadStageOutputs(id).autoResumeRevivals));
  check("…and the promise is still owed", bed.db.getThread(id)?.error === AUTO_RESUME_MSG, bed.db.getThread(id)?.error ?? "");
  const survivor = boot(bed);
  await sleep(AUTO_RESUME_DELAY_MS + 800);
  check("the first boot that survives delivers it", survivor.resumed.includes(id), `resumed=[${survivor.resumed.join(",")}]`);
  survivor.stop();
  bed.dispose();
}

/** A task stopped with nothing running — the restart has nothing to undo. */
function seedPausedTask(bed: Bed, opts: { proceedTo?: string; error?: string | null } = {}): string {
  const t = bed.db.createThread({ title: "mock paused task", workspace: bed.workspace, rawPrompt: "do the thing" });
  bed.db.updateThreadStageOutputs(t.id, {
    kickoff: "KICKOFF: mock",
    planDone: true,
    approved: true,
    ...(opts.proceedTo ? { manualProceed: { to: opts.proceedTo, granted: false } } : {}),
  });
  bed.db.updateThread(t.id, { state: "paused", error: opts.error ?? null });
  return t.id;
}

async function testPausedTasksStayPaused(): Promise<void> {
  console.log("\nTest G — a paused task survives a restart with its controls working\n");
  const bed = makeBed("restart-paused-");
  // Stopped at a Proceed gate. As 'failed' this was a deadlock: Resume refuses while a Proceed is pending,
  // and Proceed refuses outside 'paused' — only a from-scratch Retry got it out.
  const gated = seedPausedTask(bed, { proceedTo: "QA", error: "Awaiting Proceed to QA." });
  const ownerPaused = seedPausedTask(bed);
  const b = boot(bed);
  const g = bed.db.getThread(gated)!;
  check("a task waiting for Proceed is still paused", g.state === "paused" && g.error === "Awaiting Proceed to QA.", `${g.state} ${g.error}`);
  check("…with its Proceed gate intact", bed.db.getThreadStageOutputs(gated).manualProceed?.to === "QA");
  check("an owner-paused task is still paused", bed.db.getThread(ownerPaused)?.state === "paused", bed.db.getThread(ownerPaused)?.state);
  const proceed = await b.mgr.proceedThread(gated);
  check("Proceed works after the restart", proceed.ok === true && proceed.state === "queued", JSON.stringify(proceed));
  await sleep(AUTO_RESUME_DELAY_MS + 800);
  check("neither paused task is auto-resumed", !b.resumed.includes(gated) && !b.resumed.includes(ownerPaused), `resumed=[${b.resumed.join(",")}]`);
  check("the boot reports them as kept", (b.mgr.bootReconcile ?? "").includes("kept=2"), String(b.mgr.bootReconcile));
  b.stop();
  bed.dispose();
}

/** A task blocked inside ask_user: the asking run is live and the question is open. */
function seedAskingTask(bed: Bed, role: "implementor" | "qa", questions = 1): { id: string; questionIds: string[] } {
  const t = bed.db.createThread({ title: `mock ${role} asking`, workspace: bed.workspace, rawPrompt: "do the thing" });
  bed.db.updateThreadStageOutputs(t.id, { kickoff: "KICKOFF: mock", planDone: true, approved: true, ...(role === "qa" ? { qaRoundsUsed: 2 } : {}) });
  bed.db.updateThread(t.id, { state: "awaiting_user" });
  const run = bed.db.createRun({ threadId: t.id, role, model: "claude-opus-5-5" });
  const questionIds: string[] = [];
  for (let i = 0; i < questions; i++) {
    questionIds.push(
      bed.db.addQuestion({ threadId: t.id, runId: run.id, header: "Colour", question: `Which colour should button ${i + 1} be?`, options: [], multiSelect: false }).id,
    );
  }
  return { id: t.id, questionIds };
}

async function testQuestionsSurviveAndTheAnswerResumes(): Promise<void> {
  console.log("\nTest H — a task waiting on the owner's answer stays waiting, and the answer resumes it\n");
  const bed = makeBed("restart-question-");
  const asking = seedAskingTask(bed, "implementor");
  const qaAsking = seedAskingTask(bed, "qa");
  const twoQuestions = seedAskingTask(bed, "implementor", 2);
  const closedBySystem = seedAskingTask(bed, "implementor");
  // awaiting_user with no open question left: whatever it was waiting for is gone, so it was working.
  const noQuestion = seedLiveTask(bed, "awaiting_user");

  const first = boot(bed);
  const held = bed.db.getThread(asking.id)!;
  check("the asking task is held for the answer, not handed a generic click-Resume", held.state === "failed" && held.error === AWAITING_ANSWER_MSG, `${held.state} ${held.error}`);
  check("…its question is still open", bed.db.getQuestion(asking.questionIds[0]!)?.answeredAt == null, JSON.stringify(bed.db.getQuestion(asking.questionIds[0]!)));
  check(
    "…and its history says why it is waiting",
    bed.db.listMessages(asking.id).some((m) => m.content.includes("answering it resumes the task")),
  );
  check("a question QA asked keeps the completed implementation: QA is retried on the answer", bed.db.getThreadStageOutputs(qaAsking.id).qaInterruptedRetryRound === 2, JSON.stringify(bed.db.getThreadStageOutputs(qaAsking.id)));
  check("awaiting_user with no open question auto-resumes like the work it was", bed.db.getThread(noQuestion)?.error === AUTO_RESUME_MSG, bed.db.getThread(noQuestion)?.error ?? "");
  check("the boot reports the held tasks", (first.mgr.bootReconcile ?? "").includes("awaitingAnswer=4"), String(first.mgr.bootReconcile));
  await sleep(AUTO_RESUME_DELAY_MS + 800);
  check("a task waiting on a person is not auto-resumed", !first.resumed.includes(asking.id) && !first.resumed.includes(qaAsking.id), `resumed=[${first.resumed.join(",")}]`);
  first.stop();

  // Another restart before the owner answers changes nothing.
  const second = boot(bed);
  check("a second restart leaves the held task exactly as it was", bed.db.getThread(asking.id)?.error === AWAITING_ANSWER_MSG);
  await sleep(AUTO_RESUME_DELAY_MS + 800);
  check("…and does not revive it", !second.resumed.includes(asking.id), `resumed=[${second.resumed.join(",")}]`);

  second.mgr.answerOwnerQuestion(asking.questionIds[0], "blue");
  await sleep(50);
  check("the owner's answer resumes the task", second.resumed.includes(asking.id), `resumed=[${second.resumed.join(",")}]`);
  const note = second.notes.get(asking.id) ?? "";
  check("…carrying the question and the answer to the resumed run", note.includes("Which colour should button 1 be?") && note.includes("blue"), note);

  second.mgr.answerOwnerQuestion(twoQuestions.questionIds[0], "red");
  await sleep(50);
  check("with a second question still open, the first answer does not resume yet", !second.resumed.includes(twoQuestions.id));
  second.mgr.answerOwnerQuestion(twoQuestions.questionIds[1], "green");
  await sleep(50);
  check("…the last answer does", second.resumed.includes(twoQuestions.id));

  // Cancel, dismiss and the deadline close a task's questions through resolveQuestion — never a resume.
  second.mgr.resolveQuestion(closedBySystem.questionIds[0], "(task cancelled)");
  await sleep(50);
  check("a question closed by the system does not resume the task", !second.resumed.includes(closedBySystem.id), `resumed=[${second.resumed.join(",")}]`);
  second.stop();

  // A refused resume on the answer must say so rather than keep promising the answer will resume it.
  const refusing = seedAskingTask(bed, "implementor");
  const third = boot(bed, async () => ({ ok: false, error: "A Co-worker turn is using this workspace." }));
  third.mgr.answerOwnerQuestion(refusing.questionIds[0], "yes");
  await sleep(50);
  const refused = bed.db.getThread(refusing.id)?.error ?? "";
  check("an answer whose resume is refused says so", /your answer was saved, but the task could not resume: A Co-worker turn/.test(refused), refused);
  third.stop();

  // The owner clicks Resume instead of answering. The real resumeThread runs here (only the pipeline it
  // launches is stubbed): the dead asker's question must not stay open, unanswerable, in the console.
  const skipped = seedAskingTask(bed, "implementor");
  const fourth = boot(bed);
  check("a task resumed without its answer is held first", bed.db.getThread(skipped.id)?.error === AWAITING_ANSWER_MSG);
  const pipelines: string[] = [];
  fourth.mgr.runPipeline = async (id: string): Promise<void> => {
    pipelines.push(id);
  };
  const bare = await (ThreadManager.prototype.resumeThread as (id: string) => Promise<ResumeResult>).call(fourth.mgr, skipped.id);
  check("a bare Resume of a task held for its answer starts it", bare.ok === true && pipelines.includes(skipped.id), JSON.stringify(bare));
  const closed = bed.db.getQuestion(skipped.questionIds[0]!);
  check(
    "…and closes the dead asker's question, saying why",
    closed?.answeredAt != null && /resumed without one after a server restart/.test(closed?.answer ?? ""),
    JSON.stringify(closed),
  );
  fourth.stop();
  bed.dispose();
}

async function testApprovalGateResumes(): Promise<void> {
  console.log("\nTest I — an approval gate is re-raised by an auto-resume, not handed back\n");
  const bed = makeBed("restart-approval-");
  const id = seedLiveTask(bed, "awaiting_approval");
  bed.db.updateThreadStageOutputs(id, { approved: false });
  const b = boot(bed);
  check("the approval gate gets the auto-resume promise", bed.db.getThread(id)?.error === AUTO_RESUME_MSG, bed.db.getThread(id)?.error ?? "");
  await sleep(AUTO_RESUME_DELAY_MS + 800);
  check("…and is resumed, which asks for approval again", b.resumed.includes(id), `resumed=[${b.resumed.join(",")}]`);
  b.stop();
  bed.dispose();
}

async function testIntakeIsRequeued(): Promise<void> {
  console.log("\nTest J — a task caught in intake is re-queued; a shotgun child is left to its lead\n");
  const bed = makeBed("restart-intake-");
  const plain = bed.db.createThread({ title: "mock new task", workspace: bed.workspace, rawPrompt: "do the thing" }).id;
  const lead = seedLiveTask(bed);
  const share = { title: "share", objective: "do part", files: ["a.ts"] };
  const child = bed.db.createThread({ title: "mock collaborator", workspace: bed.workspace, rawPrompt: "part", parentId: lead, assignment: share }).id;
  const finishedLead = bed.db.createThread({ title: "mock finished lead", workspace: bed.workspace, rawPrompt: "x" }).id;
  bed.db.updateThread(finishedLead, { state: "done" });
  const orphan = bed.db.createThread({ title: "mock orphan collaborator", workspace: bed.workspace, rawPrompt: "part", parentId: finishedLead, assignment: share }).id;
  // A lead an EARLIER boot held for the owner's answer: its answer (or a Resume) resumes it, and its
  // reconcile then launches the child. Before, the outcome depended on which of the two the scan met first.
  const askingLead = seedAskingTask(bed, "implementor").id;
  bed.db.updateThread(askingLead, { state: "failed", error: AWAITING_ANSWER_MSG });
  const heldChild = bed.db.createThread({ title: "mock collaborator of a held lead", workspace: bed.workspace, rawPrompt: "part", parentId: askingLead, assignment: share }).id;

  const b = boot(bed);
  check("a plain intake task is queued, not failed", bed.db.getThread(plain)?.state === "queued", bed.db.getThread(plain)?.state);
  check("a collaborator whose lead is resuming stays in intake for the lead to launch", bed.db.getThread(child)?.state === "intake", bed.db.getThread(child)?.state);
  check("a collaborator whose lead is held for an answer stays in intake for that lead", bed.db.getThread(heldChild)?.state === "intake", `${bed.db.getThread(heldChild)?.state} ${bed.db.getThread(heldChild)?.error}`);
  check("a collaborator whose lead is not coming back is handed to a person", bed.db.getThread(orphan)?.error === MANUAL_RESUME_MSG, bed.db.getThread(orphan)?.error ?? "");
  await sleep(AUTO_RESUME_DELAY_MS + 800);
  check("the queued task starts through the normal queue", b.started.includes(plain), `started=[${b.started.join(",")}]`);
  check("the collaborator is not started ahead of its lead", !b.started.includes(child) && !b.resumed.includes(child));
  check("…nor ahead of a lead waiting on its answer", !b.started.includes(heldChild) && !b.resumed.includes(heldChild) && !b.resumed.includes(askingLead));
  b.stop();
  bed.dispose();
}

async function testRefusedResumeIsHandedBackHonestly(): Promise<void> {
  console.log("\nTest K — a refused or throwing auto-resume stops promising and says why\n");
  const bed = makeBed("restart-refused-");
  const refused = seedLiveTask(bed);
  const b = boot(bed, async () => ({ ok: false, error: "This task is waiting for the owner to click Proceed." }));
  await sleep(AUTO_RESUME_DELAY_MS + 800);
  const err = bed.db.getThread(refused)?.error ?? "";
  check("the task no longer claims it is auto-resuming", err !== AUTO_RESUME_MSG, err);
  check("…and names the refusal", /automatic resume could not start: This task is waiting for the owner to click Proceed/.test(err), err);
  check("…and asks for a click", /Click Resume/.test(err), err);
  check("…and the board's finding says so too", bed.db.listFindings(refused).some((f) => /could not start/.test(f.summary)));
  b.stop();
  bed.dispose();

  const throwBed = makeBed("restart-throw-");
  const thrown = seedLiveTask(throwBed);
  const t = boot(throwBed, async () => {
    throw new Error("route resolution exploded");
  });
  await sleep(AUTO_RESUME_DELAY_MS + 800);
  check("a resume that throws is handed back the same way", /could not start: Error: route resolution exploded/.test(throwBed.db.getThread(thrown)?.error ?? ""), throwBed.db.getThread(thrown)?.error ?? "");
  t.stop();
  throwBed.dispose();
}

async function testHeldResumesWaitAndThenFire(): Promise<void> {
  console.log("\nTest L — a resume held by token safety, a Co-worker turn or another restart is kept, not lost\n");
  const safetyBed = makeBed("restart-safety-");
  const frozen = seedLiveTask(safetyBed);
  const s = boot(safetyBed);
  s.mgr.tokenLimitTripped = true;
  await sleep(AUTO_RESUME_DELAY_MS + 800);
  const parked = safetyBed.db.getThread(frozen)!;
  check("under the token-safety freeze it is parked for the reset wake", parked.state === "review" && (parked.error ?? "").startsWith(TOKEN_SAFETY_PREFIX), `${parked.state} ${parked.error}`);
  check("…without starting anything or spending an attempt", !s.resumed.includes(frozen) && (safetyBed.db.getThreadStageOutputs(frozen).autoResumeRevivals ?? 0) === 0);
  s.stop();
  safetyBed.dispose();

  const coworkBed = makeBed("restart-cowork-");
  const shared = seedLiveTask(coworkBed);
  let busy = true;
  const c = boot(coworkBed);
  c.mgr.coworkWorkspaceBusy = (): boolean => busy;
  await sleep(AUTO_RESUME_DELAY_MS + 800);
  check("while a Co-worker turn holds the workspace it waits, visibly", coworkBed.db.getThread(shared)?.error === COWORK_WAIT_MSG, coworkBed.db.getThread(shared)?.error ?? "");
  check("…without starting or spending an attempt", !c.resumed.includes(shared) && (coworkBed.db.getThreadStageOutputs(shared).autoResumeRevivals ?? 0) === 0);
  busy = false;
  c.mgr.coworkReleasedWorkspace();
  await sleep(100);
  check("the Co-worker turn ending delivers the resume", c.resumed.includes(shared), `resumed=[${c.resumed.join(",")}]`);
  c.stop();
  coworkBed.dispose();

  const drainBed = makeBed("restart-drain-");
  const draining = seedLiveTask(drainBed);
  let drainingNow = true;
  const d = boot(drainBed);
  d.mgr.restartDraining = (): boolean => drainingNow;
  await sleep(AUTO_RESUME_DELAY_MS + 800);
  check("while another restart is landing the promise stays owed", drainBed.db.getThread(draining)?.error === AUTO_RESUME_MSG && !d.resumed.includes(draining));
  check("…uncharged, so the next boot has the full budget", (drainBed.db.getThreadStageOutputs(draining).autoResumeRevivals ?? 0) === 0);
  drainingNow = false;
  d.mgr.restartDrainReleased();
  await sleep(100);
  check("a restart that is called off delivers it", d.resumed.includes(draining), `resumed=[${d.resumed.join(",")}]`);
  d.stop();
  drainBed.dispose();

  // A promise held by a Co-worker turn is still owed across another restart.
  const carriedBed = makeBed("restart-cowork-carried-");
  const carried = seedStrandedTask(carriedBed, { error: COWORK_WAIT_MSG });
  const e = boot(carriedBed);
  await sleep(AUTO_RESUME_DELAY_MS + 800);
  check("the next boot revives a Co-worker-held promise", e.resumed.includes(carried), `resumed=[${e.resumed.join(",")}]`);
  e.stop();
  carriedBed.dispose();
}

async function testWaitersSeeAComebackNotAFailure(): Promise<void> {
  console.log("\nTest M — a lead or parent does not read a restart-owed child as finished\n");
  const { collaboratorSettled } = await import("../orchestrator/shotgun.js");
  const { subTaskSettled } = await import("../orchestrator/subTasks.js");
  for (const error of [AUTO_RESUME_MSG, COWORK_WAIT_MSG, AWAITING_ANSWER_MSG]) {
    check(`a collaborator still owed its resume is pending (${error.slice(34, 60)}…)`, !collaboratorSettled({ state: "failed", error }));
    check(`a sub-task still owed its resume is pending (${error.slice(34, 60)}…)`, !subTaskSettled({ state: "failed", error }));
  }
  check("a restart hand-off is a finished share", collaboratorSettled({ state: "failed", error: MANUAL_RESUME_MSG }));
  check("…and a finished sub-task", subTaskSettled({ state: "failed", error: MANUAL_RESUME_MSG }));
}

async function main(): Promise<void> {
  console.log("\n=== A restart's auto-resume promise survives a second restart — integration test ===");
  await testStrandedPromiseIsRevived();
  await testOnlyTheOwedOnesAreRevived();
  await testRevivalIsBoundedThenReleased();
  await testQaRestartRetriesOnlyQa();
  await testPlannedDeploysAreNotACrashLoop();
  await testBootsThatDieBeforeFiringSpendNothing();
  await testPausedTasksStayPaused();
  await testQuestionsSurviveAndTheAnswerResumes();
  await testApprovalGateResumes();
  await testIntakeIsRequeued();
  await testRefusedResumeIsHandedBackHonestly();
  await testHeldResumesWaitAndThenFire();
  await testWaitersSeeAComebackNotAFailure();

  console.log(`\n${failed === 0 ? "✅ ALL PASSED" : "❌ FAILURES"} — ${passed} passed, ${failed} failed`);
  if (failed) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

await main();
