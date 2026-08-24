/**
 * Integration test — steering a LIVE implementor must not end its stage.
 *
 * Regression guard for: one message posted in a repo's office chatroom finished off every implementor in
 * that repo at once and shoved all of their tasks straight into QA half-done (2026-08-24, four tasks in
 * C:\vota inside five seconds of the post).
 *
 * `directorChatPost` fans the owner's line out to every live implementor in the room at `priority: "now"`,
 * and "now" IS an interrupt — the CLI aborts the turn in flight. The abort then comes back as a result
 * with subtype "success", `is_error` false and an EMPTY `result`: identical, in every field the pipeline
 * reads, to a turn that finished. `awaitImplementorResult` accepted it, so the implementor stage was over.
 * Only `terminal_reason` ("aborted_tools" / "aborted_streaming", verified against the real CLI) tells the
 * two apart. The same abort reaches an implementor from "Interrupt & inject" and from the Pause button.
 *
 * WHAT IS REAL vs. STUBBED
 *  - REAL: `AgentRun`'s result handling, `directorChatPost`, `interruptThread`, `awaitImplementorResult` /
 *    `awaitImplementorCompletion` and the QA hand-off in `runImplementorQaLoop`, plus a real `Db`+`EventHub`.
 *  - STUBBED: only the agent-spawning leaves — `startResumedImplementor` (which stands up a fake run and
 *    registers it in `this.live` exactly as `startImplementor` does) and `runQA`.
 *  - The fake run models the CLI on the one axis this is about: a `priority: "now"` send and an
 *    `interrupt()` each abort the turn, and an aborted turn emits the success-shaped, empty result. That is
 *    what makes a reverted fix show up as a task in QA rather than as a failed flag assertion.
 *
 * Run:  npm run test:chat-steering   (from server/)   — or:  npx tsx src/tests/chatSteering.itest.ts
 * Exits non-zero if any assertion fails. Self-contained: creates a throwaway DB + workspace and removes them.
 */

process.env.CAP_RETRY_MS = "0"; // no cap-supervisor interval during the test
process.env.ACCOUNT_PING_MS = "3600000";
process.env.FAST_ACCOUNT_PING_MS = "3600000";

import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountManager } from "../accounts/accountManager.js";
import type { AgentRunLike, ResultEvent, SendOpts } from "../agents/runner.js";
import type { AgentEvent, Thread } from "../types.js";

const { AgentRun } = await import("../agents/runner.js");
const { Db } = await import("../db/db.js");
const { EventHub } = await import("../events.js");
const { FileMemoryService } = await import("../memory/memory.js");
const { ThreadManager } = await import("../orchestrator/threadManager.js");
const { normalizeWorkspace } = await import("../types.js");

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
  updateFromRateLimit(): void {}
  auxToken(): undefined {
    return undefined;
  }
}

/** Text out of whatever shape `send` was handed (a string, or content blocks with images). */
function sendText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text" ? String((b as { text?: string }).text ?? "") : ""))
    .join("\n");
}

/**
 * A live implementor run, faithful on the one axis this test is about: what steering does to its turn.
 * Both `priority: "now"` and `interrupt()` abort the turn in flight and emit the aborted-turn result the
 * real CLI emits. `finishTurn` is the test's hand on the continuation turn that follows the steering.
 */
class FakeRun implements AgentRunLike {
  readonly emitter = new EventEmitter();
  sessionId: string | undefined = "impl-session";
  finished = false;
  lastResult: ResultEvent | undefined;
  rateLimited = false;
  rateLimitInfo = undefined;
  transientApiError = false;
  transientApiErrorMessage: string | undefined;
  readonly sends: { text: string; opts?: SendOpts }[] = [];
  interrupts = 0;
  aborts = 0;

  start(): this {
    return this;
  }
  onEvent(cb: (e: AgentEvent) => void): () => void {
    this.emitter.on("event", cb);
    return () => this.emitter.off("event", cb);
  }
  onEnd(cb: () => void): void {
    if (this.finished) cb();
    else this.emitter.once("end", cb);
  }
  send(content: unknown, opts?: SendOpts): void {
    this.sends.push({ text: sendText(content), opts });
    if (opts?.priority === "now") this.abortTurn();
  }
  async interrupt(): Promise<void> {
    this.interrupts++;
    this.abortTurn();
  }
  async setModel(): Promise<void> {}
  async setPermissionMode(): Promise<void> {}
  endInput(): void {}
  async stop(): Promise<void> {
    this.finished = true;
    this.emitter.emit("end");
  }
  result(): Promise<ResultEvent | undefined> {
    if (this.lastResult) return Promise.resolve(this.lastResult);
    return this.nextResult();
  }
  nextResult(): Promise<ResultEvent | undefined> {
    return new Promise((resolve) => {
      const off = this.onEvent((e) => {
        if (e.type === "result") {
          off();
          resolve(e);
        }
      });
      this.emitter.once("end", () => {
        off();
        resolve(this.lastResult);
      });
    });
  }

  /** What the CLI emits for a turn its abort controller killed — success-shaped, empty, never cached. */
  private abortTurn(): void {
    this.aborts++;
    this.emitter.emit("event", { type: "result", subtype: "success", isError: false, result: "", aborted: true } as ResultEvent);
  }
  /** Assistant text, which `wireRun` persists as an implementor message. A turn that produced nothing
   *  is a SILENT run to the pipeline (`ranSilently`), which takes a different branch entirely. */
  emitText(text: string): void {
    this.emitter.emit("event", { type: "text", text } as AgentEvent);
  }
  /** The continuation turn actually finishing — the result that IS the implementor's outcome. */
  finishTurn(): void {
    const evt: ResultEvent = { type: "result", subtype: "success", isError: false, result: "done", numTurns: 9 };
    this.lastResult = evt;
    this.emitter.emit("event", evt);
  }
}

interface Harness {
  mgr: InstanceType<typeof ThreadManager>;
  db: InstanceType<typeof Db>;
  workspace: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  internals: any;
  qaRounds: number[];
  dispose(): void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "chat-steer-"));
  const workspace = join(dir, "workspace");
  mkdirSync(workspace, { recursive: true });
  const db = new Db(join(dir, "orchestrator.sqlite"));
  const hub = new EventHub();
  const memory = new FileMemoryService(join(dir, "memory"));
  const mgr = new ThreadManager(db, hub, memory, new StubAccounts() as unknown as AccountManager);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = mgr as any;
  const qaRounds: number[] = [];
  internals.runQA = async (_t: Thread, opts: { round: number }): Promise<{ pass: boolean; summary: string; changed: boolean }> => {
    qaRounds.push(opts.round);
    return { pass: true, summary: "verified", changed: false };
  };
  internals.runSelfImprovement = async (): Promise<void> => {};

  return {
    mgr,
    db,
    workspace,
    internals,
    qaRounds,
    dispose() {
      if (internals.capSupervisor) clearInterval(internals.capSupervisor);
      if (internals.tokenResumeTimer) clearTimeout(internals.tokenResumeTimer);
      db.raw.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Stand up the fake implementor the way `startImplementor` does — a real run row, `this.live`, `track` —
 *  so `directorChatPost` and `interruptThread` find it exactly as they find a real one. */
function stubImplementorStart(h: Harness): FakeRun {
  const run = new FakeRun();
  h.internals.startResumedImplementor = async (t: Thread): Promise<{ run: FakeRun; runId: string; accountId: string }> => {
    const row = h.db.createRun({ threadId: t.id, role: "implementor", model: "claude-opus-5", account: "acct-a" });
    h.internals.setState(t.id, "implementing");
    h.internals.wireRun(run, t.id, row.id, "implementor", "acct-a");
    h.internals.live.set(t.id, { run, runId: row.id, accountId: "acct-a" });
    h.internals.track(t.id, run);
    run.emitText("Working on the task.");
    return { run, runId: row.id, accountId: "acct-a" };
  };
  return run;
}

function seedTask(h: Harness): string {
  const t = h.db.createThread({ title: "mock steering task", workspace: h.workspace, rawPrompt: "do the thing" });
  h.db.updateThreadStageOutputs(t.id, { kickoff: "KICKOFF: mock", planDone: true, approved: true });
  return t.id;
}

const runLoop = (h: Harness, id: string): Promise<void> =>
  h.internals.runImplementorQaLoop(h.db.getThread(id)!, "KICKOFF: mock", undefined, undefined, undefined, {
    qaEnabled: true,
    maxQaRounds: 3,
    qaAppliesFixes: false,
    autoPush: true,
  });

/** Yield enough macrotask turns for any un-awaited settle work to land before we assert on it. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 10));
};

/** Wait until the implementor is registered live (the loop starts it asynchronously). */
async function waitLive(h: Harness, id: string): Promise<void> {
  for (let i = 0; i < 100 && !h.internals.live.has(id); i++) await new Promise((r) => setTimeout(r, 10));
}

async function main(): Promise<void> {
  console.log("\n=== Steering a live implementor must not end its stage — integration test ===\n");

  // -- Test A: the runner tells an aborted turn from a finished one ------------------------------------
  console.log("Test A — AgentRun reads `terminal_reason`, the only field that distinguishes the two");
  {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const agent = new AgentRun({ model: "claude-opus-5", cwd: process.cwd() }) as any;
    const seen: ResultEvent[] = [];
    agent.onEvent((e: AgentEvent) => {
      if (e.type === "result") seen.push(e);
    });
    // Exactly the payload the real CLI emits for a turn a `priority: "now"` message aborted.
    agent.handle({ type: "result", subtype: "success", is_error: false, result: "", terminal_reason: "aborted_tools", num_turns: 3, total_cost_usd: 0.008 });
    check("an aborted turn is flagged `aborted`", seen[0]?.aborted === true, JSON.stringify(seen[0]));
    check("an aborted turn is NOT cached as the run's result", agent.lastResult === undefined, JSON.stringify(agent.lastResult));
    check("it still carries cost/turns for the run row", seen[0]?.costUsd === 0.008 && seen[0]?.numTurns === 3);

    agent.handle({ type: "result", subtype: "success", is_error: false, result: "BANANA", terminal_reason: "aborted_streaming" });
    check("the streaming abort reason is covered too", seen[1]?.aborted === true);

    agent.handle({ type: "result", subtype: "success", is_error: false, result: "BANANA", terminal_reason: "completed" });
    check("a completed turn is not flagged", !seen[2]?.aborted);
    check("a completed turn IS cached as the run's result", agent.lastResult?.result === "BANANA");

    // `awaitTurnResult` discards an aborted event and waits for the continuation turn. If the owner
    // instead stops the run in that tiny interval, `nextResult` must notice the already-fired end rather
    // than wait forever for another result event.
    const stoppedAfterAbort = new AgentRun({ model: "claude-opus-5", cwd: process.cwd() }) as any;
    stoppedAfterAbort.handle({ type: "result", subtype: "success", is_error: false, result: "", terminal_reason: "aborted_tools" });
    stoppedAfterAbort.finished = true;
    const stoppedResult = await Promise.race([
      stoppedAfterAbort.nextResult(),
      new Promise<"timed out">((resolve) => setTimeout(() => resolve("timed out"), 50)),
    ]);
    check("an already-ended aborted run does not leave the pipeline waiting forever", stoppedResult === undefined, String(stoppedResult));
  }

  // -- Test B (the bug): a chatroom post must not settle the implementor stage -------------------------
  console.log("\nTest B — an office-chat post steers the live implementor without ending its stage");
  {
    const h = makeHarness();
    try {
      const id = seedTask(h);
      const impl = stubImplementorStart(h);
      const loop = runLoop(h, id);
      await waitLive(h, id);

      const room = `repo:${normalizeWorkspace(h.workspace)}`;
      h.mgr.directorChatPost(room, "guys pls keep all your changes in 1 branch");
      await settle();

      check("the live implementor was steered", impl.sends.length === 1, JSON.stringify(impl.sends.map((s) => s.opts)));
      check("the post aborted its turn, as a 'now' message does", impl.aborts === 1);
      check("the message says to carry on rather than hand off", /carry straight on/.test(impl.sends[0]?.text ?? ""));
      check("QA was NOT started off the aborted turn", h.qaRounds.length === 0, JSON.stringify(h.qaRounds));
      check("the task is still implementing", h.db.getThread(id)?.state === "implementing", h.db.getThread(id)?.state);

      // The steering's own turn finishes — THAT is the implementor's outcome, and the stage ends on it.
      impl.finishTurn();
      await loop;
      await settle();
      check("QA ran once the continuation turn finished", h.qaRounds.length === 1, JSON.stringify(h.qaRounds));
      check("the task settled done", h.db.getThread(id)?.state === "done", h.db.getThread(id)?.state);
    } finally {
      await settle();
      h.dispose();
    }
  }

  // -- Test C: the same abort reaches the implementor from Pause --------------------------------------
  console.log("\nTest C — Pause holds the task at 'paused' instead of pushing it into QA");
  {
    const h = makeHarness();
    try {
      const id = seedTask(h);
      const impl = stubImplementorStart(h);
      const loop = runLoop(h, id);
      await waitLive(h, id);

      await h.mgr.interruptThread(id);
      await settle();
      check("the run was interrupted", impl.interrupts === 1);
      check("QA was NOT started off the paused turn", h.qaRounds.length === 0, JSON.stringify(h.qaRounds));
      check("the task reads as paused", h.db.getThread(id)?.state === "paused", h.db.getThread(id)?.state);

      // Resume steers the same live run; its turn completing is what finally ends the stage.
      await h.mgr.resumeThread(id, "carry on");
      impl.finishTurn();
      await loop;
      await settle();
      check("QA ran once the resumed turn finished", h.qaRounds.length === 1, JSON.stringify(h.qaRounds));
    } finally {
      await settle();
      h.dispose();
    }
  }

  console.log(`\n${failed === 0 ? "✅ PASS" : "❌ FAIL"} — ${passed} passed, ${failed} failed`);
  if (failed) {
    for (const f of failures) console.log(`  • ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

void main();
