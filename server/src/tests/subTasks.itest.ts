/**
 * Integration test — SUB-TASKS (orchestrator/subTasks.ts) against the real ThreadManager.
 *
 * REAL: the Db (temp file), EventHub, dispatch/enqueueOrRun, the spawn validation + bounds, the Jev
 * pipeline short-circuit (runPipeline → runJev → evaluateJev), the owner-inject/resume gates, the result
 * hand-back (wait_for_subtasks and the barrier in drainQueuedImplementor), cancel cascade, retry.
 * STUBBED: the agent-spawning leaves (startResumedImplementor / awaitImplementorCompletion / stopLive, and
 * startPipeline for CODING sub-tasks only) and the network — `fetch` answers like TypeSafe's API.
 *
 * Run:  npm run test:subtasks   (from server/)
 */

process.env.CAP_RETRY_MS = "0";
process.env.ACCOUNT_PING_MS = "3600000";
process.env.FAST_ACCOUNT_PING_MS = "3600000";
process.env.SUBTASK_BARRIER_POLL_MS = "50";
process.env.SUBTASK_BARRIER_TIMEOUT_MS = "1500";
// The operator's .env may hold a real TypeSafe key; an own empty value keeps dotenv from loading it, so
// the "no key" behaviour and every Jev call below are decided by this test alone.
process.env.TYPESAFE_API_KEY = "";
process.env.JEV_API_KEY = "";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountManager } from "../accounts/accountManager.js";
import type { ResultEvent } from "../agents/runner.js";
import type { Thread } from "../types.js";

const { Db } = await import("../db/db.js");
const { EventHub } = await import("../events.js");
const { FileMemoryService } = await import("../memory/memory.js");
const { ThreadManager } = await import("../orchestrator/threadManager.js");
const { implementorConfig } = await import("../agents/roles.js");
const sub = await import("../orchestrator/subTasks.js");

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

const ACCOUNT = { id: "acct1", label: "Test sub", enabled: true, active: true, rateLimited: false, fiveHour: 10, sevenDay: 10 };
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
  dto() {
    return [ACCOUNT];
  }
  dispatchPreview() {
    return { account: ACCOUNT };
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

const OK: ResultEvent = { type: "result", subtype: "success", isError: false };
const REPO = process.cwd();
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

// ---- a fake TypeSafe endpoint --------------------------------------------------------------------
interface JevCall {
  auth: string | null;
  body: { model: string; state: unknown; questions: Record<string, { type: string }> };
}
const jevCalls: JevCall[] = [];
let jevStatusQueue: number[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
  if (!String(url).startsWith("https://api.typesafe.ai/")) return realFetch(url, init);
  const body = JSON.parse(String(init?.body)) as JevCall["body"];
  jevCalls.push({ auth: new Headers(init?.headers).get("authorization"), body });
  const status = jevStatusQueue.shift() ?? 200;
  if (status !== 200) return new Response("busy", { status });
  const answers: Record<string, unknown> = {};
  for (const [id, q] of Object.entries(body.questions)) {
    answers[id] =
      q.type === "noul"
        ? { type: "noul", noul: 0.91 }
        : q.type === "choice"
          ? { type: "choice", choice: "b", probabilities: { a: 0.2, b: 0.8 }, confidence: 0.7 }
          : { type: "score", score: 1.2, legend: { "0": "low", "1": "mid", "2": "high" }, probabilities: { "0": 0, "1": 0.8, "2": 0.2 }, confidence: 0.6 };
  }
  return new Response(JSON.stringify({ model: "jev-1.13.0", answers, usage: { input_tokens: 1000, output_tokens: 20 } }), { status: 200 });
}) as typeof fetch;

interface Harness {
  mgr: InstanceType<typeof ThreadManager>;
  db: InstanceType<typeof Db>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  internals: any;
  rounds: string[];
  codingStarted: string[];
  dispose(): Promise<void>;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "subtasks-"));
  const db = new Db(join(dir, "orchestrator.sqlite"));
  const hub = new EventHub();
  const memory = new FileMemoryService(join(dir, "memory"));
  const mgr = new ThreadManager(db, hub, memory, new StubAccounts() as unknown as AccountManager);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = mgr as any;
  const rounds: string[] = [];
  const codingStarted: string[] = [];
  internals.stopLive = async (): Promise<void> => {};
  internals.startResumedImplementor = async (): Promise<{ run: unknown; accountId: string }> => ({ run: { send() {} }, accountId: "acct1" });
  internals.flushDirectorNotes = (): void => {};
  internals.awaitImplementorCompletion = async (_t: Thread, _e: unknown, _k: string, _r: unknown, _a: string, _u: boolean, msg: string): Promise<ResultEvent> => {
    rounds.push(msg);
    return OK;
  };
  const realStart = internals.startPipeline.bind(internals);
  internals.startPipeline = (id: string): void => {
    const t = db.getThread(id);
    if (t?.subTask?.provider === "jev") return realStart(id); // Jev runs for real against the fake endpoint
    codingStarted.push(id);
  };
  return {
    mgr,
    db,
    internals,
    rounds,
    codingStarted,
    async dispose() {
      await tick(30);
      if (internals.capSupervisor) clearInterval(internals.capSupervisor);
      if (internals.tokenResumeTimer) clearTimeout(internals.tokenResumeTimer);
      if (internals.capResumeWake) clearTimeout(internals.capResumeWake);
      db.raw.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A parent task sitting in its implementor, as the spawning agent would be. */
async function parentTask(h: Harness, title = "parent"): Promise<Thread> {
  const id = await h.mgr.dispatch({ title, workspace: REPO, brief: "the parent job" });
  h.internals.setState(id, "implementing");
  return h.db.getThread(id)!;
}

/** Finish a coding sub-task the way its implementor would: a run, a final report, then `done`. */
function finishCoding(h: Harness, childId: string, report: string, state: Thread["state"] = "done"): void {
  const run = h.db.createRun({ threadId: childId, role: "implementor", model: "claude-sonnet-5", account: "acct1" });
  h.db.addMessage({ threadId: childId, runId: run.id, role: "implementor", kind: "text", content: report });
  h.db.updateRun(run.id, { state: "done", endedAt: Date.now() });
  h.internals.setState(childId, state);
}

const JEV_Q = { green: { type: "noul", instructions: "Did every test pass?" }, pick: { type: "choice", instructions: "Which?", criteria: { a: "first", b: "second" } } };

async function main(): Promise<void> {
  console.log("\n=== sub-tasks — spawn, Jev, hand-back, barrier (real ThreadManager) ===\n");

  console.log("A — the implementor's built-in Agent tool is replaced, Default mode keeps stock Claude Code");
  {
    const bus = {} as never;
    const cfg = implementorConfig(REPO, { bus, office: bus });
    const vanilla = implementorConfig(REPO, { bus, office: bus }, { vanilla: true });
    check("implementor blocks the SDK Agent/Task tools", !!cfg.disallowedTools?.includes("Agent") && !!cfg.disallowedTools?.includes("Task"));
    check("Default mode keeps them", !vanilla.disallowedTools?.includes("Agent"));
  }

  console.log("\nB — spawning a coding sub-agent pins the exact provider/model and hides it under the parent");
  {
    const h = makeHarness();
    try {
      const parent = await parentTask(h);
      const claude = h.mgr.subTasks.roster().find((p) => p.provider === "claude")!;
      const model = claude.models.at(-1)!.id;
      const res = await h.mgr.subTasks.spawn({ threadId: parent.id, role: "implementor", runId: null }, { provider: "claude", model, title: "Port tests", brief: "port the parser tests" });
      check("spawn succeeds", res.ok, res.message);
      const child = h.db.getThread(res.thread!.id)!;
      check("child points at the parent", child.parentId === parent.id);
      check("child carries the sub-task spec", child.subTask?.provider === "claude" && child.subTask?.model === model && child.subTask?.spawnedByRole === "implementor");
      check("the model is a strict exact pin", child.modelRequest?.provider === "claude" && child.modelRequest?.model === model && child.modelRequest?.strict === true);
      check("it bypasses the queue and starts at once", h.codingStarted.includes(child.id));
      check("it is a sub-task, not a shotgun collaborator", h.db.listCollaborators(parent.id).length === 0 && h.db.listSubTasks(parent.id).length === 1);
      check("the parent's feed says so", h.db.listMessages(parent.id).some((m) => m.content.includes('spawned sub-task "Port tests"')));

      const unknown = await h.mgr.subTasks.spawn({ threadId: parent.id, role: "implementor", runId: null }, { provider: "claude", model: "no-such-model", title: "x", brief: "y" });
      check("an unknown model is refused with the roster", !unknown.ok && unknown.message.includes("Available now"));
      const off = await h.mgr.subTasks.spawn({ threadId: parent.id, role: "implementor", runId: null }, { provider: "codex", title: "x", brief: "y" });
      check("a switched-off provider is refused with why", !off.ok && /Codex is not available/.test(off.message));
      const noBrief = await h.mgr.subTasks.spawn({ threadId: parent.id, role: "implementor", runId: null }, { provider: "claude", title: "x" });
      check("a coding sub-agent without a brief is refused", !noBrief.ok && noBrief.message.includes("brief"));
      const noKey = await h.mgr.subTasks.spawn({ threadId: parent.id, role: "implementor", runId: null }, { provider: "jev", title: "j", state: "s", questions: JEV_Q });
      check("Jev without a key is refused", !noKey.ok && noKey.message.includes("TypeSafe"));
    } finally {
      await h.dispose();
    }
  }

  console.log("\nC — the kickoff contract, the depth limit and the live cap");
  {
    const h = makeHarness();
    try {
      const parent = await parentTask(h);
      const model = h.mgr.subTasks.roster().find((p) => p.provider === "claude")!.defaultModel!;
      const first = await h.mgr.subTasks.spawn({ threadId: parent.id, role: "implementor", runId: null }, { provider: "claude", model, title: "depth 1", brief: "b" });
      const child = h.db.getThread(first.thread!.id)!;
      const block = sub.subTaskContractBlock({ spec: child.subTask!, parentTitle: parent.title, canSpawn: sub.subTaskDepth(h.db, child) < sub.MAX_SUBTASK_DEPTH });
      check("the contract names the parent and forbids an unasked commit", block.includes('"parent"') && block.includes("Do NOT commit or push unless your brief"));
      check("a depth-1 sub-agent may spawn", block.includes("You may spawn sub-agents"));
      const second = await h.mgr.subTasks.spawn({ threadId: child.id, role: "implementor", runId: null }, { provider: "claude", model, title: "depth 2", brief: "b" });
      check("a sub-agent can spawn its own", second.ok, second.message);
      const grand = h.db.getThread(second.thread!.id)!;
      const third = await h.mgr.subTasks.spawn({ threadId: grand.id, role: "implementor", runId: null }, { provider: "claude", model, title: "depth 3", brief: "b" });
      check("depth 3 is refused", !third.ok && third.message.includes("levels deep"));
      for (let i = 0; i < sub.MAX_ACTIVE_SUBTASKS - 1; i++) {
        await h.mgr.subTasks.spawn({ threadId: parent.id, role: "implementor", runId: null }, { provider: "claude", model, title: `n${i}`, brief: "b" });
      }
      const over = await h.mgr.subTasks.spawn({ threadId: parent.id, role: "implementor", runId: null }, { provider: "claude", model, title: "one too many", brief: "b" });
      check("the live cap holds", !over.ok && over.message.includes("still running"));
    } finally {
      await h.dispose();
    }
  }

  console.log("\nD — a Jev sub-agent answers in the same tool result, as a real sub-task");
  {
    const h = makeHarness();
    try {
      h.db.kvSet("jev_api_key", "apikey_test_1234");
      const parent = await parentTask(h);
      jevCalls.length = 0;
      jevStatusQueue = [429]; // one rate-limit first: the client must back off and retry
      const res = await h.mgr.subTasks.spawn({ threadId: parent.id, role: "implementor", runId: "run-p" }, { provider: "jev", title: "Judge", state: { log: "12 passed" }, questions: JEV_Q });
      check("the spawn returns Jev's answers", res.ok && res.message.includes("91% yes") && res.message.includes("**b**"), res.message);
      check("it retried the 429 and sent the key as a bearer token", jevCalls.length === 2 && jevCalls[1]!.auth === "Bearer apikey_test_1234");
      const child = h.db.getThread(res.thread!.id)!;
      check("the Jev sub-task settled done", child.state === "done", child.state);
      const run = h.db.listRuns(child.id)[0];
      check("its run is recorded with cost and model", run?.model === "jev-latest" && run?.account === "jev" && Math.abs((run?.costUsd ?? 0) - 0.000042) < 1e-9);
      check("its answers are in its feed", h.db.listMessages(child.id).some((m) => m.kind === "text" && m.content.includes("Jev answered")));
      check("its memo pins the answers", (h.db.listImplementationMemos(child.id)[0]?.report ?? "").includes("91% yes"));
      check("its result counts as delivered", h.db.getThreadStageOutputs(child.id).subTaskReported === true);

      jevCalls.length = 0;
      const follow = await h.mgr.subTasks.message(parent.id, child.id.slice(0, 8), "Is the log from CI?");
      check("the parent's follow-up re-asks the SAME state", jevCalls.length === 1 && JSON.stringify(jevCalls[0]!.body.state) === JSON.stringify({ log: "12 passed" }));
      check("plain text became one yes/no question", jevCalls[0]!.body.questions.answer?.type === "noul" && follow.includes("91% yes"));

      jevCalls.length = 0;
      const startsBefore = h.codingStarted.length;
      const owner = await h.mgr.injectThread(child.id, "Is it safe to ship?", "append");
      await tick(30);
      check(
        "the owner's inject is a question to Jev, not an agent spawn",
        owner.ok && jevCalls.length === 1 && h.codingStarted.length === startsBefore && h.internals.live.size === 0,
        JSON.stringify({ owner, calls: jevCalls.length }),
      );
      check("the owner's answer lands in the feed", h.db.getThreadStageOutputs(child.id).jevEvaluations?.at(-1)?.askedBy === "owner");
      const steer = await h.mgr.injectThread(child.id, "critical finding", "interrupt", undefined, { standing: false });
      check("non-owner steering is refused", !steer.ok);

      // Retry keeps the state and the spawn questions.
      await h.mgr.cancelThread(child.id);
      jevCalls.length = 0;
      await h.mgr.retryThread(child.id);
      await tick(50);
      check("a retry re-asks the original questions", jevCalls.length === 1 && "green" in jevCalls[0]!.body.questions && h.db.getThread(child.id)?.state === "done");
    } finally {
      await h.dispose();
    }
  }

  console.log("\nE — wait_for_subtasks hands each result back exactly once");
  {
    const h = makeHarness();
    try {
      const parent = await parentTask(h);
      const model = h.mgr.subTasks.roster().find((p) => p.provider === "claude")!.defaultModel!;
      const a = (await h.mgr.subTasks.spawn({ threadId: parent.id, role: "implementor", runId: null }, { provider: "claude", model, title: "A", brief: "b" })).thread!;
      setTimeout(() => finishCoding(h, a.id, "REPORT-A: parser ported, tests green"), 80);
      const first = await h.mgr.subTasks.wait(parent.id, undefined, 5);
      check("the wait wakes on the settle and returns the report", first.includes("REPORT-A") && first.includes("finished"), first);
      const second = await h.mgr.subTasks.wait(parent.id, undefined, 1);
      check("a second wait does not re-deliver it", !second.includes("REPORT-A"));
      check("list shows the settled state", h.mgr.subTasks.listText(parent.id).includes("— done"));
    } finally {
      await h.dispose();
    }
  }

  console.log("\nF — the barrier: a parent that ends its turn waits and is resumed with every unreported result");
  {
    const h = makeHarness();
    try {
      const parent = await parentTask(h);
      const model = h.mgr.subTasks.roster().find((p) => p.provider === "claude")!.defaultModel!;
      const a = (await h.mgr.subTasks.spawn({ threadId: parent.id, role: "implementor", runId: null }, { provider: "claude", model, title: "A", brief: "b" })).thread!;
      const b = (await h.mgr.subTasks.spawn({ threadId: parent.id, role: "implementor", runId: null }, { provider: "claude", model, title: "B", brief: "b" })).thread!;
      finishCoding(h, a.id, "REPORT-A");
      setTimeout(() => finishCoding(h, b.id, "REPORT-B stopped early", "review"), 150);
      const res = await h.internals.drainQueuedImplementor(parent, undefined, "kickoff", OK, false);
      check("the hand-off boundary waited and resumed the parent once", h.rounds.length === 1, String(h.rounds.length));
      check("the resume carries both reports", (h.rounds[0] ?? "").includes("REPORT-A") && (h.rounds[0] ?? "").includes("REPORT-B"));
      check("a review park is reported as such", (h.rounds[0] ?? "").includes("stopped and wants review"));
      check("both are marked delivered", [a.id, b.id].every((id) => h.db.getThreadStageOutputs(id).subTaskReported));
      check("the round is counted", h.db.getThreadStageOutputs(parent.id).subTaskRounds === 1);
      check("the result passes through", res === OK);
      const again = await h.internals.drainQueuedImplementor(parent, undefined, "kickoff", OK, false);
      check("nothing left means no extra round", h.rounds.length === 1 && again === OK);
    } finally {
      await h.dispose();
    }
  }

  console.log("\nG — the barrier gives up visibly: timeout and a failed parent run");
  {
    const h = makeHarness();
    try {
      const parent = await parentTask(h);
      const model = h.mgr.subTasks.roster().find((p) => p.provider === "claude")!.defaultModel!;
      await h.mgr.subTasks.spawn({ threadId: parent.id, role: "implementor", runId: null }, { provider: "claude", model, title: "Wedged", brief: "b" });
      const started = Date.now();
      await h.internals.integrateSubTasks(parent, undefined, "kickoff", OK, false);
      check("a wedged sub-agent cannot strand the parent past the timeout", Date.now() - started < 5000 && h.rounds.length === 0);
      check("the timeout is posted on the parent", h.db.listFindings(parent.id).some((f) => f.summary.includes("Stopped waiting")));

      const p2 = await parentTask(h, "p2");
      const done = (await h.mgr.subTasks.spawn({ threadId: p2.id, role: "implementor", runId: null }, { provider: "claude", model, title: "Done", brief: "b" })).thread!;
      finishCoding(h, done.id, "REPORT");
      const err: ResultEvent = { type: "result", subtype: "error_during_execution", isError: true };
      await h.internals.integrateSubTasks(p2, undefined, "kickoff", err, false);
      check("a failed parent run is not resumed, and the owner is told", h.rounds.length === 0 && h.db.listFindings(p2.id).some((f) => f.summary.includes("not handed back")));
    } finally {
      await h.dispose();
    }
  }

  console.log("\nH — cancelling the parent cancels its running sub-agents; the owner is not paged per sub-task");
  {
    const h = makeHarness();
    try {
      const parent = await parentTask(h);
      const model = h.mgr.subTasks.roster().find((p) => p.provider === "claude")!.defaultModel!;
      const a = (await h.mgr.subTasks.spawn({ threadId: parent.id, role: "implementor", runId: null }, { provider: "claude", model, title: "A", brief: "b" })).thread!;
      h.internals.setState(a.id, "implementing");
      const notices: string[] = [];
      h.internals.notifyOwner = (text: string) => notices.push(text);
      finishCoding(h, (await h.mgr.subTasks.spawn({ threadId: parent.id, role: "implementor", runId: null }, { provider: "claude", model, title: "B", brief: "b" })).thread!.id, "r");
      check("a sub-task settling sends no phone notice", notices.length === 0, notices.join(" | "));
      await h.mgr.cancelThread(parent.id);
      check("the running sub-task was cancelled with its parent", h.db.getThread(a.id)?.state === "cancelled");
    } finally {
      await h.dispose();
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
