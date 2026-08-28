/**
 * Integration test — append steering during QA must stay non-destructive, while "Interrupt & inject"
 * must stop/supersede QA and return the same task to implementation (real ThreadManager machinery).
 *
 * Regression guard for: clicking "Interrupt & inject" while QA was reviewing accepted the injection but
 * left QA running. The stale QA could then mark the task done or park it even though the owner wanted the
 * same task back in implementation with the injected instruction.
 *
 * WHAT IS REAL vs. STUBBED
 *  - REAL: `injectThread` / `resumeThread` and every gate they walk, `runImplementorQaLoop`, `runQA` and
 *    its verdict reading, plus the real `Db` + `EventHub` behind them.
 *  - STUBBED: only the agent-spawning leaves — `runRole` (which stands up a fake QA run, registering it in
 *    `liveQa` exactly as the real one does), the implementor start/await, and `stopLive`.
 *  - The fake agent models the CLI's relevant behavior: `stop()`/`interrupt()` aborts the turn, and the
 *    test can also force a stale verdict after stop to prove the loop ignores superseded QA output.
 *
 * Run:  npm run test:inject-qa   (from server/)   — or:  npx tsx src/tests/injectDuringQa.itest.ts
 * Exits non-zero if any assertion fails. Self-contained: creates a throwaway DB + workspace and removes them.
 */

process.env.CAP_RETRY_MS = "0"; // no cap-supervisor interval during the test
process.env.ACCOUNT_PING_MS = "3600000";
process.env.FAST_ACCOUNT_PING_MS = "3600000";

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountManager } from "../accounts/accountManager.js";
import type { SendOpts } from "../agents/runner.js";
import type { Thread } from "../types.js";

const { Db } = await import("../db/db.js");
const { EventHub } = await import("../events.js");
const { FileMemoryService } = await import("../memory/memory.js");
const { ThreadManager } = await import("../orchestrator/threadManager.js");
const { handleCommand } = await import("../ws/hub.js");

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
 * A running agent, faithful on the one axis this test is about: how it reacts to steering. A `priority:
 * "now"` send and an `interrupt()` both abort the turn — that is what the CLI does, and what makes a
 * reverted fix show up here as a dead task rather than as a failed flag assertion.
 */
class FakeRun {
  readonly sends: { text: string; opts?: SendOpts }[] = [];
  sessionId?: string;
  interrupts = 0;
  stops = 0;
  aborted = false;
  stopped = false;
  stopError?: Error;
  send(content: unknown, opts?: SendOpts): void {
    this.sends.push({ text: sendText(content), opts });
    if (opts?.priority === "now") this.aborted = true;
  }
  async interrupt(): Promise<void> {
    this.interrupts++;
    this.aborted = true;
  }
  async stop(): Promise<void> {
    this.stops++;
    if (this.stopError) throw this.stopError;
    this.stopped = true;
    this.aborted = true;
  }
}

/** The verdict-less result an aborted turn produces: success-shaped, no structuredOutput. */
const ABORTED = { type: "result", subtype: "success", isError: false };
const verdictResult = (structuredOutput: { pass: boolean; summary: string; changed: boolean }) => ({
  type: "result",
  subtype: "success",
  isError: false,
  structuredOutput,
});

interface Harness {
  mgr: InstanceType<typeof ThreadManager>;
  db: InstanceType<typeof Db>;
  workspace: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  internals: any;
  drained: string[][];
  resumes: string[];
  dispose(): void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "inject-qa-"));
  const workspace = join(dir, "workspace");
  mkdirSync(workspace, { recursive: true });
  const db = new Db(join(dir, "orchestrator.sqlite"));
  const hub = new EventHub();
  const memory = new FileMemoryService(join(dir, "memory"));
  const mgr = new ThreadManager(db, hub, memory, new StubAccounts() as unknown as AccountManager);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = mgr as any;
  const drained: string[][] = [];
  const resumes: string[] = [];
  internals.startResumedImplementor = async (_t: Thread, _kickoff: string, _resume: unknown, opts?: { resumeNudge?: string }): Promise<{ run: FakeRun; accountId: string; account: { id: string } }> => {
    if (opts?.resumeNudge) resumes.push(opts.resumeNudge);
    return { run: new FakeRun(), accountId: "acct-a", account: { id: "acct-a" } };
  };
  internals.awaitImplementorCompletion = async (): Promise<{ isError: boolean }> => ({ isError: false });
  internals.stopLive = async (): Promise<void> => {};
  internals.runSelfImprovement = async (): Promise<void> => {};
  internals.flushDirectorNotes = (): void => {};
  // Record what the queue held each time the pipeline drained it, then clear it like the real one does —
  // that recording is the proof the injected direction actually reaches the implementor.
  internals.drainQueuedImplementor = async (t: Thread, _e: unknown, _k: string, res: unknown): Promise<unknown> => {
    const q = internals.queuedForImplementor.get(t.id);
    if (q?.length) {
      drained.push([...q]);
      internals.queuedForImplementor.delete(t.id);
    }
    return res;
  };

  return {
    mgr,
    db,
    workspace,
    internals,
    drained,
    resumes,
    dispose() {
      if (internals.capSupervisor) clearInterval(internals.capSupervisor);
      db.raw.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Every inject fires an auto-retitle that is deliberately un-awaited (`void`), so it lands a tick or two
 *  after the call returns. Yield to it before closing the DB, or its write throws into the next test. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 25));

function seedTask(h: Harness): string {
  const t = h.db.createThread({ title: "mock qa-inject task", workspace: h.workspace, rawPrompt: "do the thing" });
  h.db.updateThreadStageOutputs(t.id, { kickoff: "KICKOFF: mock", planDone: true, approved: true });
  return t.id;
}

const runLoop = (h: Harness, id: string, maxQaRounds = 4): Promise<void> =>
  h.internals.runImplementorQaLoop(h.db.getThread(id)!, "KICKOFF: mock", undefined, undefined, undefined, {
    qaEnabled: true,
    maxQaRounds,
    qaAppliesFixes: false,
    autoPush: true,
  });

/**
 * Stub the leaf BELOW runQA so the real runQA + the real loop run. The fake QA registers itself in
 * `liveQa` exactly as the real `runRole` does, then hands control to `whileLive` — that callback is the
 * test's window to inject "while QA is running". An aborted turn returns the verdict-less result.
 */
function stubQaRunRole(
  h: Harness,
  whileLive: (qa: FakeRun) => Promise<void>,
  opts: { staleVerdictAfterStop?: boolean; verdicts?: Array<{ pass: boolean; summary: string; changed: boolean }> } = {},
): FakeRun[] {
  const agents: FakeRun[] = [];
  h.internals.runRole = async (t: Thread, role: string): Promise<unknown> => {
    const agent = new FakeRun();
    agents.push(agent);
    h.internals.liveQa.set(t.id, agent);
    const run = h.db.createRun({ threadId: t.id, role: role as "qa", model: "claude-opus-5", account: "acct-a" });
    await whileLive(agent);
    h.internals.liveQa.delete(t.id);
    const stopped = agent.stopped || agent.aborted;
    const verdict = opts.verdicts?.[agents.length - 1] ?? { pass: true, summary: "verified", changed: false };
    const res = stopped && !opts.staleVerdictAfterStop ? ABORTED : verdictResult(verdict);
    const superseded = h.internals.qaSuperseded(t.id) === true;
    agent.sessionId = "qa-session";
    h.internals.finishRun(run.id, res, agent, superseded ? "interrupted" : undefined);
    return superseded ? undefined : res;
  };
  return agents;
}

async function main(): Promise<void> {
  console.log("\n=== QA inject/interrupt routing integration test ===\n");

  // -- Test A (the bug): interrupt-mode inject during QA returns the task to implementation ------------
  console.log("Test A — 'Interrupt & inject' while QA reviews: QA stops and implementation resumes");
  {
    const h = makeHarness();
    try {
      const id = seedTask(h);
      let injected = false;
      const agents = stubQaRunRole(h, async () => {
        if (injected) return;
        injected = true;
        const r = await h.mgr.injectThread(id, "scrap the button, add an item blacklist instead", "interrupt");
        check("the interrupt was accepted as an implementation resume", r.ok && r.state === "implementing", JSON.stringify(r));
      });
      await runLoop(h, id);
      const firstQa = agents[0]!;
      check("the task was NOT parked for review", h.db.getThread(id)?.state !== "review", `state=${h.db.getThread(id)?.state}`);
      check("the task re-ran QA after the resumed implementation and settled done", h.db.getThread(id)?.state === "done", `state=${h.db.getThread(id)?.state}`);
      check("the interrupted QA run was stopped", firstQa.stops === 1 && firstQa.stopped, `stops=${firstQa.stops}`);
      check("the interrupt did not try to steer QA as a normal send", firstQa.sends.length === 0, JSON.stringify(firstQa.sends));
      check("a fresh QA pass ran after implementation resumed", agents.length === 2, `qaRuns=${agents.length}`);
      check(
        "the injected direction was explicit context for the resumed implementor",
        h.resumes.some((m) => m.includes("item blacklist") && m.includes("QA was interrupted")),
        JSON.stringify(h.resumes),
      );
      const feed = h.db.listMessages(id).map((m) => m.content);
      check("the feed says QA is being returned to the implementor", feed.some((c) => c.includes("interrupt requested") && c.includes("returning to the implementor")), JSON.stringify(feed.filter((c) => c.includes("interrupt")).slice(0, 3)));
      check("the durable QA supersede marker was cleared after resume", !h.db.getThreadStageOutputs(id).qaSuperseded, JSON.stringify(h.db.getThreadStageOutputs(id).qaSuperseded));
      await settle();
    } finally {
      h.dispose();
    }
  }

  // -- Test B: append mode still steers QA non-destructively -------------------------------------------
  console.log("\nTest B — append mode takes the same non-destructive route");
  {
    const h = makeHarness();
    try {
      const id = seedTask(h);
      let injected = false;
      const agents = stubQaRunRole(h, async () => {
        if (injected) return;
        injected = true;
        await h.mgr.injectThread(id, "also cover the offhand slot", "append");
      });
      await runLoop(h, id);
      check("the task settled done", h.db.getThread(id)?.state === "done", `state=${h.db.getThread(id)?.state}`);
      check("the appended note carried no priority either", agents[0]!.sends[0]!.opts?.priority === undefined, String(agents[0]!.sends[0]!.opts?.priority));
      check("it was queued for the implementor too", h.drained.some((q) => q.some((m) => m.includes("offhand slot"))), JSON.stringify(h.drained));
      check("append did not stop the first QA run", agents[0]!.stops === 0 && !agents[0]!.stopped, `stops=${agents[0]!.stops}`);
      await settle();
    } finally {
      h.dispose();
    }
  }

  // -- Test C: the fix-round window (state 'qa', no live QA handle) joins the existing handoff ---------
  // QA has returned but the re-launched implementor isn't live yet, so there is nothing to steer. The
  // note must not spawn an implementor beside the pipeline, must not be dropped, and must not arm a
  // second QA-supersede resume.
  console.log("\nTest C — an interrupt in the QA-fix handoff is queued for that same resume");
  {
    const h = makeHarness();
    try {
      const id = seedTask(h);
      h.db.updateThread(id, { state: "qa" });
      h.internals.qaFixHandoff.add(id);
      let spawned = 0;
      h.internals.startResumedImplementor = async (): Promise<unknown> => {
        spawned++;
        return { run: new FakeRun(), accountId: "acct-a" };
      };
      const r = await h.mgr.injectThread(id, "use the addon options panel", "interrupt");
      check("the inject was accepted in the existing qa handoff", r.ok && r.state === "qa", JSON.stringify(r));
      check("the visible task state stayed truthful until the implementor is live", h.db.getThread(id)?.state === "qa", `state=${h.db.getThread(id)?.state}`);
      check("no implementor was spawned beside the pipeline", spawned === 0, `spawns=${spawned}`);
      check("no QA supersede marker was armed", !h.db.getThreadStageOutputs(id).qaSuperseded, JSON.stringify(h.db.getThreadStageOutputs(id).qaSuperseded));
      check("the note is buffered for the active implementor resume", (h.internals.directorNotes.get(id) ?? []).some((m: string) => m.includes("addon options")), JSON.stringify(h.internals.directorNotes.get(id)));
      check("the note is not queued as a later follow-up", !(h.internals.queuedForImplementor.get(id) ?? []).some((m: string) => m.includes("addon options")), JSON.stringify(h.internals.queuedForImplementor.get(id)));
      await settle();
    } finally {
      h.dispose();
    }
  }

  // -- Test D: a stale QA verdict after stop cannot settle the task -----------------------------------
  console.log("\nTest D — stale QA pass after a QA interrupt is ignored");
  {
    const h = makeHarness();
    try {
      const id = seedTask(h);
      let interrupted = false;
      const agents = stubQaRunRole(
        h,
        async () => {
          if (interrupted) return;
          interrupted = true;
          const r = await h.mgr.interruptThread(id);
          check("the bare interrupt was accepted as an implementation resume", r.ok && r.state === "implementing", JSON.stringify(r));
        },
        { staleVerdictAfterStop: true },
      );
      await runLoop(h, id);
      check("the first QA run was stopped", agents[0]!.stops === 1 && agents[0]!.stopped, `stops=${agents[0]!.stops}`);
      check("the stale pass did not finish the pipeline directly", agents.length === 2, `qaRuns=${agents.length}`);
      const qaRuns = h.db.listRuns(id).filter((r) => r.role === "qa").sort((a, b) => a.startedAt - b.startedAt);
      check("the superseded stale QA run was persisted as interrupted", qaRuns[0]?.state === "interrupted", JSON.stringify(qaRuns.map((r) => ({ role: r.role, state: r.state }))));
      check("the task settled done only after a fresh QA pass", h.db.getThread(id)?.state === "done", `state=${h.db.getThread(id)?.state}`);
      check(
        "the resumed implementor received the no-message QA interrupt context",
        h.resumes.some((m) => m.includes("No extra instruction was supplied") && m.includes("QA was interrupted")),
        JSON.stringify(h.resumes),
      );
      const qaFindings = h.db.listFindings(id).filter((f) => f.fromRole === "qa" && f.summary.includes("QA passed"));
      check("only the fresh QA pass posted an acceptance finding", qaFindings.length === 1, JSON.stringify(qaFindings.map((f) => f.summary)));
      await settle();
    } finally {
      h.dispose();
    }
  }

  // -- Test E: Resume-with-a-message during QA is the same gate, and had the same defect ---------------
  console.log("\nTest E — a Resume carrying a message during QA steers rather than aborts");
  {
    const h = makeHarness();
    try {
      const id = seedTask(h);
      h.db.updateThread(id, { state: "qa" });
      const qa = new FakeRun();
      h.internals.liveQa.set(id, qa);
      const r = await h.mgr.resumeThread(id, "check the blacklist path too");
      check("the resume stayed in the qa stage", r.ok && r.state === "qa", JSON.stringify(r));
      check("QA was not aborted by the resume", !qa.aborted && qa.interrupts === 0);
      check("the resume's steering reached QA with no priority", qa.sends.length === 1 && qa.sends[0]!.opts?.priority === undefined, JSON.stringify(qa.sends[0]?.opts));
      check(
        "and is queued for the implementor, so a QA pass can't settle the task with it unread",
        (h.internals.queuedForImplementor.get(id) ?? []).some((m: string) => m.includes("blacklist path")),
        JSON.stringify(h.internals.queuedForImplementor.get(id)),
      );
      await settle();
    } finally {
      h.dispose();
    }
  }

  // -- Test F: the auto-reviewer is the same kind of role, and settles the task itself -----------------
  console.log("\nTest F — an inject during the auto-review steers the reviewer rather than aborting it");
  {
    const h = makeHarness();
    try {
      const id = seedTask(h);
      h.db.updateThread(id, { state: "reviewing" });
      const reviewer = new FakeRun();
      h.internals.liveReviewer.set(id, reviewer);
      h.internals.reviewing.add(id);
      const r = await h.mgr.injectThread(id, "the deliverable link is broken", "interrupt");
      check("the inject was accepted in the reviewing state", r.ok && r.state === "reviewing", JSON.stringify(r));
      check("the reviewer was not aborted", !reviewer.aborted && reviewer.interrupts === 0);
      check("the reviewer's steering carried no priority", reviewer.sends.length === 1 && reviewer.sends[0]!.opts?.priority === undefined, JSON.stringify(reviewer.sends[0]?.opts));
      await settle();
    } finally {
      h.dispose();
    }
  }

  // -- Test G: the other half — a live IMPLEMENTOR must still be interruptible -------------------------
  // Over-correcting here would be just as wrong: steering an implementor mid-turn is the whole point of
  // the button, and that role has no verdict to lose.
  console.log("\nTest G — a live implementor is still interrupted and steered at 'now' priority");
  {
    const h = makeHarness();
    try {
      const id = seedTask(h);
      h.db.updateThread(id, { state: "implementing" });
      const impl = new FakeRun();
      h.internals.live.set(id, { run: impl, runId: "run-1", accountId: "acct-a" });
      const r = await h.mgr.injectThread(id, "stop and do it the other way", "interrupt");
      check("the inject reached the implementor", r.ok && r.state === "implementing", JSON.stringify(r));
      check("the implementor WAS interrupted", impl.interrupts === 1, `interrupts=${impl.interrupts}`);
      check("its steering kept 'now' priority", impl.sends[0]!.opts?.priority === "now", JSON.stringify(impl.sends[0]?.opts));
      await settle();
    } finally {
      h.dispose();
    }
  }

  // -- Test H: the WebSocket/UI command path returns a truthful action result -------------------------
  console.log("\nTest H — thread.inject over the WebSocket command path reports the QA interrupt result");
  {
    const h = makeHarness();
    try {
      const id = seedTask(h);
      h.db.updateThread(id, { state: "qa" });
      const qa = new FakeRun();
      h.internals.liveQa.set(id, qa);
      const sent: Array<Record<string, unknown>> = [];
      const socket = {
        OPEN: 1,
        readyState: 1,
        bufferedAmount: 0,
        send(raw: unknown) {
          sent.push(JSON.parse(String(raw)));
        },
      };
      await handleCommand({ manager: h.mgr } as Parameters<typeof handleCommand>[0], socket as unknown as Parameters<typeof handleCommand>[1], {
        type: "thread.inject",
        threadId: id,
        message: "switch QA back to implementation",
        mode: "interrupt",
      });
      const action = sent.find((e) => e.type === "thread.action");
      check("the socket sent a thread.action acknowledgment", !!action, JSON.stringify(sent));
      check("the acknowledgment is successful", action?.ok === true, JSON.stringify(action));
      check("the acknowledgment reports implementing, not qa", action?.state === "implementing", JSON.stringify(action));
      check("the acknowledgment explains the queued resume", String(action?.message ?? "").includes("implementor resume queued"), JSON.stringify(action));
      check("the QA handle was stopped through the UI command path", qa.stops === 1 && qa.stopped, `stops=${qa.stops}`);
      await settle();
    } finally {
      h.dispose();
    }
  }

  // -- Test I: a restart after the QA interrupt marker keeps the same QA round budget -----------------
  console.log("\nTest I — persisted QA interrupt returns to implementation without burning an extra QA round");
  {
    const h = makeHarness();
    try {
      const id = seedTask(h);
      h.db.updateThreadStageOutputs(id, {
        qaRoundsUsed: 1,
        qaSuperseded: { at: Date.now(), messages: ["finish the keyboard input branch before QA checks again"] },
      });
      const agents = stubQaRunRole(h, async () => {});
      await runLoop(h, id, 1);
      check("the persisted QA interrupt did not park at the round ceiling", h.db.getThread(id)?.state === "done", `state=${h.db.getThread(id)?.state}`);
      check(
        "the resumed implementor received the persisted interrupt instruction",
        h.resumes.some((m) => m.includes("keyboard input branch") && m.includes("QA was interrupted")),
        JSON.stringify(h.resumes),
      );
      check("QA rechecked the same charged round once after implementation resumed", agents.length === 1, `qaRuns=${agents.length}`);
      check("the persisted QA supersede marker was cleared", !h.db.getThreadStageOutputs(id).qaSuperseded, JSON.stringify(h.db.getThreadStageOutputs(id).qaSuperseded));
      await settle();
    } finally {
      h.dispose();
    }
  }

  // -- Test J: interrupt during the normal QA-fix handoff must not create a second resume -------------
  console.log("\nTest J — interrupt during the QA-to-fix handoff joins that one implementor resume");
  {
    const h = makeHarness();
    try {
      const id = seedTask(h);
      const starts: Array<{ nudge: string; run: FakeRun }> = [];
      const handoffDeliveries: string[][] = [];
      let injectedDuringFixHandoff = false;
      h.internals.startResumedImplementor = async (_t: Thread, _kickoff: string, _resume: unknown, opts?: { resumeNudge?: string }): Promise<{ run: FakeRun; accountId: string; account: { id: string } }> => {
        const run = new FakeRun();
        starts.push({ nudge: opts?.resumeNudge ?? "", run });
        if (starts.length === 2 && !injectedDuringFixHandoff) {
          injectedDuringFixHandoff = true;
          const r = await h.mgr.injectThread(id, "normal messages and Discord must provide real conversation context", "interrupt");
          check("the handoff interrupt was accepted into the existing fix resume", r.ok && r.state === "qa", JSON.stringify(r));
        }
        return { run, accountId: "acct-a", account: { id: "acct-a" } };
      };
      h.internals.flushDirectorNotes = (threadId: string, run: FakeRun): void => {
        const notes = h.internals.directorNotes.get(threadId);
        if (!notes?.length) return;
        h.internals.directorNotes.delete(threadId);
        handoffDeliveries.push([...notes]);
        run.send(notes.join("\n\n"));
      };
      const agents = stubQaRunRole(h, async () => {}, {
        verdicts: [
          { pass: false, summary: "context extraction still reads toolbar labels", changed: false },
          { pass: true, summary: "verified after fix", changed: false },
        ],
      });
      await runLoop(h, id, 4);
      const deliveryCount = handoffDeliveries.flat().filter((m) => m.includes("normal messages and Discord")).length;
      check("the task settled after the normal fix path", h.db.getThread(id)?.state === "done", `state=${h.db.getThread(id)?.state}`);
      check("exactly one initial implementation plus one QA fix implementation ran", starts.length === 2, `starts=${starts.length}`);
      check("exactly one failed QA and one final QA pass ran", agents.length === 2, `qaRuns=${agents.length}`);
      check("the injected handoff instruction was delivered exactly once", deliveryCount === 1, JSON.stringify(handoffDeliveries));
      check("the handoff instruction was not left as a later queued follow-up", !h.drained.some((q) => q.some((m) => m.includes("normal messages and Discord"))), JSON.stringify(h.drained));
      check("no QA supersede marker leaked into the next QA pass", !h.db.getThreadStageOutputs(id).qaSuperseded, JSON.stringify(h.db.getThreadStageOutputs(id).qaSuperseded));
      await settle();
    } finally {
      h.dispose();
    }
  }

  // -- Test K: a rejected QA stop is reported as failure, not a successful queued resume --------------
  console.log("\nTest K — QA stop rejection returns an actionable command failure");
  {
    const h = makeHarness();
    try {
      const id = seedTask(h);
      h.db.updateThread(id, { state: "qa" });
      h.internals.queuedForImplementor.set(id, ["preserve earlier queued work"]);
      const qa = new FakeRun();
      qa.stopError = new Error("simulated stop failure");
      h.internals.liveQa.set(id, qa);
      const sent: Array<Record<string, unknown>> = [];
      const socket = {
        OPEN: 1,
        readyState: 1,
        bufferedAmount: 0,
        send(raw: unknown) {
          sent.push(JSON.parse(String(raw)));
        },
      };
      await handleCommand({ manager: h.mgr } as Parameters<typeof handleCommand>[0], socket as unknown as Parameters<typeof handleCommand>[1], {
        type: "thread.inject",
        threadId: id,
        message: "this should fail visibly",
        mode: "interrupt",
      });
      const action = sent.find((e) => e.type === "thread.action");
      check("the socket sent a failed thread.action acknowledgment", action?.ok === false, JSON.stringify(sent));
      check("the failed acknowledgment keeps the task in qa", action?.state === "qa" && h.db.getThread(id)?.state === "qa", JSON.stringify(action));
      check("the failed acknowledgment names the stop failure", String(action?.error ?? "").includes("simulated stop failure"), JSON.stringify(action));
      check("the QA run was not marked stopped", qa.stops === 1 && !qa.stopped && !qa.aborted, `stops=${qa.stops} stopped=${qa.stopped} aborted=${qa.aborted}`);
      check("the transient supersede marker was cleared", !h.db.getThreadStageOutputs(id).qaSuperseded, JSON.stringify(h.db.getThreadStageOutputs(id).qaSuperseded));
      check("older queued implementor work was preserved", JSON.stringify(h.internals.queuedForImplementor.get(id)) === JSON.stringify(["preserve earlier queued work"]), JSON.stringify(h.internals.queuedForImplementor.get(id)));
      await settle();
    } finally {
      h.dispose();
    }
  }

  console.log(`\n=== RESULT: ${failed === 0 ? "PASS ✅" : "FAIL ❌"} — ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.log("Failures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("test harness error:", e);
  process.exit(2);
});
