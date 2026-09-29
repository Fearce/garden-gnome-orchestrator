/**
 * Integration test — a task stopped at its turn ceiling wraps up instead of continuing when the
 * continuation guard says so.
 *
 * The problem (2026-09-29): goal steps run for hours and auto-continue through ~10 turn ceilings each,
 * so the goal's burn-rate guard, checked only before a step starts, never saw a running step, and a goal
 * the owner paused kept spending until its step ended. `setContinuationGuard` (installed by `index.ts`
 * as `goals.wrapUpReason`) is now asked at every turn-ceiling continuation.
 *
 * WHAT IS REAL vs. SIMULATED
 *  - REAL: `awaitImplementorCompletion`'s continuation loop over a real `Db` and `EventHub`.
 *  - SIMULATED: only the agent spawn — a fake `AgentRunLike` returns a scripted result, and
 *    `startResumedImplementor` is intercepted to record what the loop asked for.
 *
 * Run:  npm run test:continuation-guard   (from server/)
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
const TURN_LIMIT: ResultEvent = { type: "result", subtype: "error_max_turns", isError: true };
// Reads as a stall ("I'll … once … finishes"), so without the wrap-up break the loop would continue it.
const WRAP_UP_REPORT = "Committed the exit fix. Remaining: lane C. I'll report back once the lane run finishes.";
const REASON = 'the goal "Night" is spending faster than its burn rate: Claude has used 70% of its weekly window, 55% allowed by now at 100% pace';

function fakeRun(result: ResultEvent): AgentRunLike {
  const run = {
    emitter: { on() {}, off() {}, once() {}, emit() {} },
    sessionId: "sess-1",
    finished: false,
    lastResult: result,
    rateLimited: false,
    rateLimitInfo: undefined,
    transientApiError: false,
    transientApiErrorMessage: undefined,
    start() {
      return run;
    },
    onEvent: () => () => {},
    onEnd: () => {},
    send() {},
    async interrupt() {},
    async setModel() {},
    async setPermissionMode() {},
    endInput() {},
    async stop() {},
    async result() {
      return result;
    },
    async nextResult() {
      return result;
    },
  };
  return run as unknown as AgentRunLike;
}

interface Harness {
  mgr: InstanceType<typeof ThreadManager>;
  db: InstanceType<typeof Db>;
  thread: Thread;
  nudges: string[];
  guardCalls: number;
  dispose(): void;
}

/** `resumed` scripts each continuation's result; every attempt writes a message, so each counts as progress. */
function makeHarness(guard: (() => string | null) | null, resumed: ResultEvent[]): Harness {
  const dir = mkdtempSync(join(tmpdir(), "continuation-guard-"));
  const workspace = join(dir, "workspace");
  mkdirSync(workspace, { recursive: true });
  const db = new Db(join(dir, "orchestrator.sqlite"));
  const mgr = new ThreadManager(db, new EventHub(), new FileMemoryService(join(dir, "memory")), new StubAccounts() as unknown as AccountManager);
  const created = db.createThread({ title: "Night · step 14", workspace, rawPrompt: "p", brief: "b" });
  db.updateThread(created.id, { state: "implementing" });
  const thread = db.getThread(created.id)!;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = mgr as any;
  internals.lastImplementorSession.set(thread.id, "sess-1");
  const h: Harness = {
    mgr,
    db,
    thread,
    nudges: [],
    guardCalls: 0,
    dispose() {
      if (internals.capSupervisor) clearInterval(internals.capSupervisor);
      if (internals.tokenResumeTimer) clearTimeout(internals.tokenResumeTimer);
      db.raw.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  if (guard) {
    mgr.setContinuationGuard((id) => {
      h.guardCalls++;
      return id === thread.id ? guard() : null;
    });
  }
  internals.startResumedImplementor = async (t: Thread, _kickoff: string, _session: string | undefined, opts: { resumeNudge: string }) => {
    h.nudges.push(opts.resumeNudge);
    const result = resumed.shift() ?? SUCCESS;
    const run = db.createRun({ threadId: t.id, role: "implementor", model: "claude-opus-5-5", account: "a" });
    const agent = fakeRun(result);
    internals.live.set(t.id, { run: agent, runId: run.id, accountId: "a" });
    db.addMessage({ threadId: t.id, runId: run.id, role: "implementor", kind: "text", content: result.isError ? `Still on it (${h.nudges.length}).` : WRAP_UP_REPORT });
    return { run: agent, runId: run.id, accountId: "a" };
  };
  return h;
}

/** The pipeline's first implementor run stops at its turn ceiling; await completion the way the pipeline does. */
async function drive(h: Harness): Promise<ResultEvent | undefined> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = h.mgr as any;
  const run = h.db.createRun({ threadId: h.thread.id, role: "implementor", model: "claude-opus-5-5", account: "a" });
  const agent = fakeRun(TURN_LIMIT);
  internals.live.set(h.thread.id, { run: agent, runId: run.id, accountId: "a" });
  h.db.addMessage({ threadId: h.thread.id, runId: run.id, role: "implementor", kind: "text", content: "Working on lane B exits." });
  return internals.awaitImplementorCompletion(h.thread, undefined, "kickoff", agent, "a", false, "continue", false);
}

const wrapUpFindings = (h: Harness) => h.db.listFindings(h.thread.id).filter((f) => /Wrapping up at the turn limit/.test(f.summary));

console.log("\n=== A. the guard answers: the continuation asks for a wrap-up, and its report ends the task ===");
{
  const h = makeHarness(() => REASON, []);
  const res = await drive(h);
  check("exactly one continuation was started", h.nudges.length === 1, `${h.nudges.length} resume(s)`);
  check("its nudge asks for a wrap-up, not more work", /wrap up rather than continue/.test(h.nudges[0] ?? "") && /commit it/.test(h.nudges[0] ?? ""), h.nudges[0]);
  check("the nudge carries the guard's reason", (h.nudges[0] ?? "").includes(REASON));
  check("the wrap-up report ends the task even though it reads like a stall", res?.isError === false);
  check("the owner is told why, once", wrapUpFindings(h).length === 1 && (wrapUpFindings(h)[0]?.detail ?? "").includes(REASON));
  const log = h.db.listMessages(h.thread.id).find((m) => m.kind === "system" && m.content.startsWith("↻ Auto-resuming"));
  check("the feed says it is wrapping up", /wrapping up/.test(log?.content ?? ""), log?.content);
  h.dispose();
}

console.log("\n=== B. no guard answer: the ordinary continuation ===");
{
  const h = makeHarness(() => null, []);
  await drive(h);
  check("the guard was asked", h.guardCalls === 1);
  check("the nudge is the ordinary continue", /You haven't finished/.test(h.nudges[0] ?? "") && !/wrap up/.test(h.nudges[0] ?? ""), h.nudges[0]);
  check("no wrap-up finding", wrapUpFindings(h).length === 0);
  h.dispose();
}

console.log("\n=== C. a wrap-up that hits the ceiling again is asked to wrap up again, and the guard is asked once ===");
{
  const h = makeHarness(() => REASON, [TURN_LIMIT, SUCCESS]);
  const res = await drive(h);
  check("two continuations", h.nudges.length === 2, `${h.nudges.length} resume(s)`);
  check("both ask for a wrap-up", h.nudges.every((n) => /wrap up rather than continue/.test(n)));
  check("the guard was asked once", h.guardCalls === 1, `${h.guardCalls} call(s)`);
  check("one finding", wrapUpFindings(h).length === 1);
  check("it settles on the wrap-up report", res?.isError === false);
  h.dispose();
}

console.log("\n=== D. a guard that throws never stops a task ===");
{
  const h = makeHarness(() => {
    throw new Error("goal row unreadable");
  }, []);
  await drive(h);
  check("the ordinary continuation still runs", /You haven't finished/.test(h.nudges[0] ?? ""), h.nudges[0]);
  h.dispose();
}

console.log("\n=== E. without a guard installed nothing changes ===");
{
  const h = makeHarness(null, []);
  await drive(h);
  check("the ordinary continuation", h.nudges.length >= 1 && /You haven't finished/.test(h.nudges[0] ?? ""), h.nudges[0]);
  h.dispose();
}

console.log(`\n=== ${passed}/${passed + failed} checks passed ===`);
if (failed) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
process.exit(0);
