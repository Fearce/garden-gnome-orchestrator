/**
 * Integration test — ThreadManager's goal-continuation entry points (`continueGoalTask`, `goalTaskHold`),
 * the real methods the GoalRunner's host calls, so the goal loop's fake-host holds in `goalSession.test.ts`
 * are backed by what the manager actually decides.
 *
 * WHAT IS REAL vs. SIMULATED
 *  - REAL: `continueGoalTask`, `goalTaskHold`, `goalTurnHold`, the resume path (`resumeImplementorOnly` with
 *    `goalTurn`) and `settleGoalTurn`, over a real `Db` and `EventHub`.
 *  - SIMULATED: only the agent spawn and the model/route gates: `startResumedImplementor` records which
 *    session and message it was asked for, and `awaitImplementorCompletion` returns a scripted result.
 *
 * Run:  npm run test:goal-continuation   (from server/)
 */

process.env.CAP_RETRY_MS = "0";
process.env.ACCOUNT_PING_MS = "3600000";
process.env.FAST_ACCOUNT_PING_MS = "3600000";

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountManager } from "../accounts/accountManager.js";
import type { AgentRunLike, ResultEvent } from "../agents/runner.js";
import type { Thread, ThreadState } from "../types.js";

const { Db } = await import("../db/db.js");
const { EventHub } = await import("../events.js");
const { FileMemoryService } = await import("../memory/memory.js");
const { ThreadManager } = await import("../orchestrator/threadManager.js");

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
  auxToken(): undefined {
    return undefined;
  }
}

const SUCCESS: ResultEvent = { type: "result", subtype: "success", isError: false, result: "Turn done.\nGOAL STATUS: CONTINUE — more" };
const CRASH: ResultEvent = { type: "result", subtype: "error_during_execution", isError: true };
// Not the strings themselves: their prefixes, as the manager matches a persisted error.
const CAP_PARK = "⏳ Auto-resume pending — the subscription is at its usage limit until 14:00.";
const RESTART_RESUME = "interrupted by a server restart — auto-resuming…";
const MESSAGE = "GOAL CONTINUATION — turn 2. Do the remaining docs.";

function fakeRun(): AgentRunLike {
  const run = {
    emitter: { on() {}, off() {}, once() {}, emit() {} },
    sessionId: "sess-goal",
    finished: false,
    rateLimited: false,
    transientApiError: false,
    start: () => run,
    onEvent: () => () => {},
    onEnd: () => {},
    send() {},
    async interrupt() {},
    async setModel() {},
    async setPermissionMode() {},
    endInput() {},
    async stop() {},
    async result() {
      return SUCCESS;
    },
    async nextResult() {
      return SUCCESS;
    },
  };
  return run as unknown as AgentRunLike;
}

interface Harness {
  mgr: InstanceType<typeof ThreadManager>;
  db: InstanceType<typeof Db>;
  thread: Thread;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  internals: any;
  starts: { session: string | undefined; nudge: string; directorNote: string | undefined }[];
  /** The result each started turn ends with. */
  result: ResultEvent;
  /** Holds the turn open until released, so a test can act while it runs. */
  gate: Promise<void> | null;
  dispose(): void;
}

function makeHarness(state: ThreadState = "done", error?: string): Harness {
  const dir = mkdtempSync(join(tmpdir(), "goal-continuation-"));
  const workspace = join(dir, "workspace");
  mkdirSync(workspace, { recursive: true });
  const db = new Db(join(dir, "orchestrator.sqlite"));
  const mgr = new ThreadManager(db, new EventHub(), new FileMemoryService(join(dir, "memory")), new StubAccounts() as unknown as AccountManager);
  const created = db.createThread({ title: "Carry · step 1: Build it", workspace, rawPrompt: "p", brief: "b" });
  db.updateThread(created.id, { state, ...(error ? { error } : {}) });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = mgr as any;
  // A settled step's session lives only on its run row: `done` drops the in-memory session cache.
  const dispatched = db.createRun({ threadId: created.id, role: "implementor", model: "claude-opus-5-5", account: "a" });
  db.updateRun(dispatched.id, { sessionId: "sess-goal", state: "done", endedAt: Date.now() });
  const h: Harness = {
    mgr,
    db,
    thread: db.getThread(created.id)!,
    internals,
    starts: [],
    result: SUCCESS,
    gate: null,
    dispose() {
      if (internals.capSupervisor) clearInterval(internals.capSupervisor);
      if (internals.tokenResumeTimer) clearTimeout(internals.tokenResumeTimer);
      db.raw.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  internals.autoSelectModel = async () => ({});
  internals.gateImplementorProvider = () => true;
  internals.startResumedImplementor = async (t: Thread, _kickoff: string, session: string | undefined, opts: { resumeNudge: string; directorNote?: string }) => {
    h.starts.push({ session, nudge: opts.resumeNudge, directorNote: opts.directorNote });
    const run = db.createRun({ threadId: t.id, role: "implementor", model: "claude-opus-5-5", account: "a" });
    db.updateRun(run.id, { sessionId: session ?? "sess-new", state: "running" });
    const agent = fakeRun();
    // What the real run's onEnd does once `stopLive` ends it.
    agent.stop = async () => {
      if (internals.live.get(t.id)?.runId === run.id) internals.live.delete(t.id);
      db.updateRun(run.id, { state: "done", endedAt: Date.now() });
    };
    internals.live.set(t.id, { run: agent, runId: run.id, accountId: "a" });
    return { run: agent, runId: run.id, accountId: "a" };
  };
  internals.awaitImplementorCompletion = async (t: Thread) => {
    if (h.gate) await h.gate;
    db.addMessage({ threadId: t.id, role: "implementor", kind: "text", content: h.result.isError ? "Crashed." : String(h.result.result) });
    return h.result;
  };
  return h;
}

/** Lets the `void`ed resume run to its settle. */
async function settled(h: Harness): Promise<void> {
  for (let i = 0; i < 40 && (h.internals.activePipelines.has(h.thread.id) || h.db.getThread(h.thread.id)!.state === "implementing"); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

const stateOf = (h: Harness) => h.db.getThread(h.thread.id)!.state;

console.log("\n=== A. a goal turn reuses the task's own session and settles done without QA ===");
{
  const h = makeHarness();
  const r = h.mgr.continueGoalTask(h.thread.id, MESSAGE);
  check("the turn is admitted", r.ok === true, JSON.stringify(r));
  check("the reservation is synchronous: the task is implementing at once", stateOf(h) === "implementing");
  const again = h.mgr.continueGoalTask(h.thread.id, MESSAGE);
  check("a second admission while the first is reserved is held, not doubled", !again.ok && "hold" in again && again.hold.kind === "waiting", JSON.stringify(again));
  await settled(h);
  check("exactly one resumed implementor started", h.starts.length === 1, `${h.starts.length} start(s)`);
  check("it resumed the task's own session", h.starts[0]?.session === "sess-goal");
  check("the goal message goes in as written, not as owner steering", h.starts[0]?.nudge === MESSAGE, h.starts[0]?.nudge);
  check("a clean turn settles done", stateOf(h) === "done", stateOf(h));
  check("no QA run was started", h.db.listRuns(h.thread.id).every((run) => run.role !== "qa"));
  const note = h.db.listMessages(h.thread.id).find((m) => m.kind === "system" && m.content.startsWith("↪ goal continues"));
  check("the feed shows the goal continuing in this session", !!note);
  check("the slot is handed back", !h.internals.activePipelines.has(h.thread.id));
  const next = h.mgr.continueGoalTask(h.thread.id, MESSAGE);
  check("and the task is ready for the next turn", next.ok === true, JSON.stringify(next));
  await settled(h);
  check("the next turn resumes the same session again", h.starts.length === 2 && h.starts[1]?.session === "sess-goal");
  h.dispose();
}

console.log("\n=== B. an unclean goal turn parks for review ===");
{
  const h = makeHarness();
  h.result = CRASH;
  check("admitted", h.mgr.continueGoalTask(h.thread.id, MESSAGE).ok === true);
  await settled(h);
  check("an errored turn settles review, which the goal reads as unclean", stateOf(h) === "review", stateOf(h));
  const why = h.db.getThread(h.thread.id)!.error ?? "";
  check("its reason is the run's own failure, not a manual Resume's sign-off", /error_during_execution/.test(why) && !/Resume finished/.test(why), why);
  h.dispose();
}

console.log("\n=== C. pending owner input always goes first ===");
{
  const cases: [string, (h: Harness) => void][] = [
    ["an open question", (h) => h.db.addQuestion({ threadId: h.thread.id, header: "Key?", question: "Which key?", options: [], multiSelect: false })],
    ["a director note", (h) => h.internals.directorNotes.set(h.thread.id, ["use the staging key"])],
    ["a message queued for the implementor", (h) => h.internals.queuedForImplementor.set(h.thread.id, ["also fix the README"])],
    ["a message buffered for a resume", (h) => h.internals.pendingResumeMsgs.set(h.thread.id, ["and the CHANGELOG"])],
    ["an open review-lane instruction", (h) => h.internals.reviewInjections.create({ threadId: h.thread.id, lane: "reviewer", mode: "append", instruction: "split the commit" })],
  ];
  for (const [label, seed] of cases) {
    const h = makeHarness();
    seed(h);
    const r = h.mgr.continueGoalTask(h.thread.id, MESSAGE);
    check(`${label} holds the turn`, !r.ok && "hold" in r && /Owner input is pending/.test(r.hold.reason), JSON.stringify(r));
    check(`${label}: nothing started, the task untouched`, h.starts.length === 0 && stateOf(h) === "done");
    h.dispose();
  }
}

console.log("\n=== D. a task that is busy is never sent a turn ===");
{
  let h = makeHarness();
  h.internals.activeRuns.set(h.thread.id, new Set([fakeRun()]));
  let r = h.mgr.continueGoalTask(h.thread.id, MESSAGE);
  check("an active run holds the turn", !r.ok && "hold" in r && r.hold.kind === "waiting", JSON.stringify(r));
  check("and keeps the step's slot while it tears down", h.mgr.goalTaskHold(h.thread.id)?.settling === true);
  h.dispose();

  h = makeHarness();
  h.internals.resuming.add(h.thread.id);
  r = h.mgr.continueGoalTask(h.thread.id, MESSAGE);
  check("an owner Resume still materializing holds the turn", !r.ok && "hold" in r, JSON.stringify(r));
  check("nothing was started over it", h.starts.length === 0);
  h.dispose();

  h = makeHarness("implementing");
  r = h.mgr.continueGoalTask(h.thread.id, MESSAGE);
  check("a task already implementing holds the turn", !r.ok && "hold" in r && h.starts.length === 0, JSON.stringify(r));
  h.dispose();

  h = makeHarness();
  h.gate = new Promise(() => {});
  check("a running goal turn is admitted", h.mgr.continueGoalTask(h.thread.id, MESSAGE).ok === true);
  await new Promise((r2) => setTimeout(r2, 20));
  r = h.mgr.continueGoalTask(h.thread.id, MESSAGE);
  check("a second turn is held while the first runs", !r.ok && "hold" in r && h.starts.length === 1, JSON.stringify(r));
  h.internals.activePipelines.clear();
  h.internals.live.clear();
  h.dispose();
}

console.log("\n=== E. GGO's own pending resumes keep the step's slot ===");
{
  let h = makeHarness("review", CAP_PARK);
  let hold = h.mgr.goalTaskHold(h.thread.id);
  check("a cap park is usage_limited", hold?.kind === "usage_limited", JSON.stringify(hold));
  let r = h.mgr.continueGoalTask(h.thread.id, MESSAGE);
  check("and no goal turn is sent over it", !r.ok && "hold" in r && r.hold.kind === "usage_limited" && h.starts.length === 0, JSON.stringify(r));
  h.dispose();

  h = makeHarness("failed", RESTART_RESUME);
  hold = h.mgr.goalTaskHold(h.thread.id);
  check("a restart auto-resume keeps the slot", hold?.kind === "waiting" && /restart/.test(hold.reason), JSON.stringify(hold));
  r = h.mgr.continueGoalTask(h.thread.id, MESSAGE);
  check("and no goal turn is sent over it", !r.ok && "hold" in r && h.starts.length === 0, JSON.stringify(r));
  h.dispose();

  h = makeHarness("done");
  check("a finished task owes nothing", h.mgr.goalTaskHold(h.thread.id) === null);
  h.dispose();
}

console.log("\n=== F. a task that cannot take a turn asks for a fresh one ===");
{
  for (const state of ["closed", "cancelled"] as ThreadState[]) {
    const h = makeHarness(state);
    const r = h.mgr.continueGoalTask(h.thread.id, MESSAGE);
    check(`a ${state} task`, !r.ok && "fresh" in r, JSON.stringify(r));
    h.dispose();
  }
  const h = makeHarness();
  h.db.raw.prepare("UPDATE agent_runs SET session_id = NULL WHERE thread_id = ?").run(h.thread.id);
  const r = h.mgr.continueGoalTask(h.thread.id, MESSAGE);
  check("a task with no implementor session", !r.ok && "fresh" in r, JSON.stringify(r));
  const gone = h.mgr.continueGoalTask("no-such-thread", MESSAGE);
  check("a task that no longer exists", !gone.ok && "fresh" in gone);
  h.dispose();
}

console.log("\n=== G. a turn's git evidence is read where the task works ===");
{
  const h = makeHarness();
  const dir = mkdtempSync(join(tmpdir(), "goal-continuation-git-"));
  const main = join(dir, "repo");
  const worktree = join(dir, "repo.worktrees", "step");
  for (const repo of [main, worktree]) {
    mkdirSync(repo, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repo });
    writeFileSync(join(repo, "a.txt"), "a");
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "."], { cwd: repo });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });
  }
  h.db.setThreadWorktrees(h.thread.id, main, [{ repo: main, path: worktree, branch: "ggo/step", base: "master", baseSha: "x", createdAt: Date.now() }]);
  const before = await h.mgr.goalWorkspaceFingerprint(h.thread.id);
  writeFileSync(join(main, "a.txt"), "main changed");
  const mainOnly = await h.mgr.goalWorkspaceFingerprint(h.thread.id);
  writeFileSync(join(worktree, "a.txt"), "worktree changed");
  const afterWork = await h.mgr.goalWorkspaceFingerprint(h.thread.id);
  check("a change in the main checkout is not the task's work", before != null && mainOnly === before);
  check("a change in its claimed worktree is", afterWork != null && afterWork !== before);
  h.dispose();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n=== ${passed}/${passed + failed} checks passed ===`);
if (failed) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
process.exit(0);
