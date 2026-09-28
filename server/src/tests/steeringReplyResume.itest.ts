/**
 * Integration test — an implementor that ends its turn right after being steered is not "done".
 *
 * The bug (task 499a4890, 2026-09-28): mid-task, the owner asked the implementor to set up a third RDP
 * session. It answered ("please try 127.0.0.4 again") and ended its turn. That voluntary success read as the
 * task's completion, so with QA off the task settled `done` while its real work was hours from finished.
 *
 * WHAT IS REAL vs. SIMULATED
 *  - REAL: `injectThread`'s live-delivery branch (which records the steering), and
 *    `awaitImplementorCompletion`'s continuation loop over a real `Db` and `EventHub`.
 *  - SIMULATED: only the agent spawn — a fake `AgentRunLike` returns a canned success, and
 *    `startResumedImplementor` is intercepted to record what the loop asked for.
 *
 * Run:  npm run test:steering-reply   (from server/)
 */

process.env.CAP_RETRY_MS = "0";
process.env.ACCOUNT_PING_MS = "3600000";
process.env.FAST_ACCOUNT_PING_MS = "3600000";

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountManager } from "../accounts/accountManager.js";
import type { AgentRunLike, ResultEvent } from "../agents/runner.js";
import type { Thread } from "../types.js";

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

const SUCCESS: ResultEvent = { type: "result", subtype: "success", isError: false, result: "ok" };

function fakeRun(): AgentRunLike & { sent: unknown[] } {
  const run = {
    sent: [] as unknown[],
    emitter: { on() {}, off() {}, once() {}, emit() {} },
    sessionId: "sess-1",
    finished: false,
    lastResult: SUCCESS,
    rateLimited: false,
    rateLimitInfo: undefined,
    transientApiError: false,
    transientApiErrorMessage: undefined,
    start() {
      return run;
    },
    onEvent: () => () => {},
    onEnd: () => {},
    send(content: unknown) {
      run.sent.push(content);
    },
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
  return run as unknown as AgentRunLike & { sent: unknown[] };
}

interface Harness {
  mgr: InstanceType<typeof ThreadManager>;
  db: InstanceType<typeof Db>;
  thread: Thread;
  nudges: string[];
  dispose(): void;
}

function makeHarness(lane?: "vanilla"): Harness {
  const dir = mkdtempSync(join(tmpdir(), "steering-reply-"));
  const workspace = join(dir, "workspace");
  mkdirSync(workspace, { recursive: true });
  const db = new Db(join(dir, "orchestrator.sqlite"));
  const mgr = new ThreadManager(db, new EventHub(), new FileMemoryService(join(dir, "memory")), new StubAccounts() as unknown as AccountManager);
  const created = db.createThread({ title: "steering reply", workspace, rawPrompt: "p", brief: "b", ...(lane ? { lane } : {}) });
  db.updateThread(created.id, { state: "implementing" });
  const thread = db.getThread(created.id)!;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = mgr as any;
  internals.lastImplementorSession.set(thread.id, "sess-1");
  const nudges: string[] = [];
  internals.startResumedImplementor = async (t: Thread, _kickoff: string, _session: string | undefined, opts: { resumeNudge: string }) => {
    nudges.push(opts.resumeNudge);
    const run = db.createRun({ threadId: t.id, role: "implementor", model: "claude-opus-5-5", account: "a" });
    internals.live.set(t.id, { run: fakeRun(), runId: run.id, accountId: "a" });
    db.addMessage({ threadId: t.id, runId: run.id, role: "implementor", kind: "text", content: "Lane B reached 100% Hell; final report above." });
    return { run: internals.live.get(t.id).run, runId: run.id, accountId: "a" };
  };
  return {
    mgr,
    db,
    thread,
    nudges,
    dispose() {
      if (internals.capSupervisor) clearInterval(internals.capSupervisor);
      if (internals.tokenResumeTimer) clearTimeout(internals.tokenResumeTimer);
      db.raw.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

interface DriveOpts {
  steer?: boolean;
  reply: string;
  /** Start the awaited attempt AFTER the steering landed, as a later continuation would. */
  attemptStartsAfterSteer?: boolean;
}

/** Launch the pipeline's implementor run, optionally steer it through the real inject path, let it reply,
 *  then await completion the way the pipeline does. */
async function drive(h: Harness, o: DriveOpts): Promise<ResultEvent | undefined> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = h.mgr as any;
  const run = h.db.createRun({ threadId: h.thread.id, role: "implementor", model: "claude-opus-5-5", account: "a" });
  const agent = fakeRun();
  internals.live.set(h.thread.id, { run: agent, runId: run.id, accountId: "a" });
  h.db.addMessage({ threadId: h.thread.id, runId: run.id, role: "implementor", kind: "text", content: "Working on lane B." });
  if (o.steer) {
    const r = await h.mgr.injectThread(h.thread.id, "can u set up a third RDP session as well?", "append");
    check("the steering was delivered to the live implementor", r.ok && agent.sent.length === 1, JSON.stringify(r));
  }
  let awaited = { run, agent };
  if (o.attemptStartsAfterSteer) {
    // A later attempt (e.g. a turn-ceiling continuation) that began after the steering was answered.
    await new Promise((r) => setTimeout(r, 5));
    awaited = { run: h.db.createRun({ threadId: h.thread.id, role: "implementor", model: "claude-opus-5-5", account: "a" }), agent: fakeRun() };
    internals.live.set(h.thread.id, { run: awaited.agent, runId: awaited.run.id, accountId: "a" });
  }
  h.db.addMessage({ threadId: h.thread.id, runId: awaited.run.id, role: "implementor", kind: "text", content: o.reply });
  return internals.awaitImplementorCompletion(h.thread, undefined, "kickoff", awaited.agent, "a", false, "continue", false);
}

const SIDE_ANSWER = "I found why the third session was refused and fixed it. Please try 127.0.0.4 again.";

console.log("\n=== A. a turn that ends on the answer to mid-task steering is continued, not accepted ===");
{
  const h = makeHarness();
  const res = await drive(h, { steer: true, reply: SIDE_ANSWER });
  check("exactly one continuation was started", h.nudges.length === 1, `${h.nudges.length} resume(s)`);
  check("its nudge sends the agent back to the original task", /go back to the original task/i.test(h.nudges[0] ?? ""), h.nudges[0]);
  check("the continuation's own finish is accepted", res?.isError === false && h.nudges.length === 1);
  const log = h.db.listMessages(h.thread.id).find((m) => m.kind === "system" && m.content.startsWith("↻ Auto-resuming"));
  check("the feed says why it continued", /answered a mid-task message/.test(log?.content ?? ""), log?.content);
  h.dispose();
}

console.log("\n=== B. an unsteered finish is accepted as before ===");
{
  const h = makeHarness();
  const res = await drive(h, { reply: SIDE_ANSWER });
  check("no continuation", h.nudges.length === 0, `${h.nudges.length} resume(s)`);
  check("the success passes through", res?.isError === false);
  h.dispose();
}

console.log("\n=== C. a steered turn whose last words are a real sign-off is accepted ===");
{
  const h = makeHarness();
  await drive(h, { steer: true, reply: "Set up 127.0.0.4, and lane B reached 100% — the task is complete." });
  check("no continuation", h.nudges.length === 0, `${h.nudges.length} resume(s)`);
  h.dispose();
}

console.log("\n=== D. steering from before the awaited attempt doesn't count against it ===");
{
  const h = makeHarness();
  await drive(h, { steer: true, reply: SIDE_ANSWER, attemptStartsAfterSteer: true });
  check("no continuation", h.nudges.length === 0, `${h.nudges.length} resume(s)`);
  h.dispose();
}

console.log("\n=== E. Default mode (a stock conversation) ends on a reply by design ===");
{
  const h = makeHarness("vanilla");
  await drive(h, { steer: true, reply: SIDE_ANSWER });
  check("no continuation", h.nudges.length === 0, `${h.nudges.length} resume(s)`);
  h.dispose();
}

console.log(`\n=== ${passed}/${passed + failed} checks passed ===`);
if (failed) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
process.exit(0);
