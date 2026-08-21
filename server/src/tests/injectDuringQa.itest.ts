/**
 * Integration test — "Interrupt & inject" while a schema-bound one-shot owns the slot must STEER it,
 * never abort it (real ThreadManager machinery).
 *
 * Regression guard for: clicking "Interrupt & inject" while QA was reviewing killed the task outright and
 * parked it in `review`. The gate forwarded the note with `priority: "now"`, believing that to be a
 * best-effort way to reach QA's current turn. It is not — a "now" message IS an interrupt: the CLI aborts
 * the turn in flight the moment one is queued (CodexAgentRun.send maps it straight to requestInterrupt()).
 * The aborted turn returns a SUCCESS-shaped result with NO structured output, which nothing downstream can
 * tell from a finished review: runQA finds no verdict, it is neither an empty run nor a turn-ceiling stop,
 * and the loop settles the task to `review` with "QA could not complete".
 *
 * WHAT IS REAL vs. STUBBED
 *  - REAL: `injectThread` / `resumeThread` and every gate they walk, `runImplementorQaLoop`, `runQA` and
 *    its verdict reading, plus the real `Db` + `EventHub` behind them.
 *  - STUBBED: only the agent-spawning leaves — `runRole` (which stands up a fake QA run, registering it in
 *    `liveQa` exactly as the real one does), the implementor start/await, and `stopLive`.
 *  - The fake agent models the CLI's actual behavior: a `priority: "now"` send (or an `interrupt()`) aborts
 *    its turn, and an aborted turn returns the success-shaped, verdict-less result production recorded.
 *    That is what makes this gate fail when the fix is reverted rather than merely re-asserting a flag.
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
  interrupts = 0;
  aborted = false;
  send(content: unknown, opts?: SendOpts): void {
    this.sends.push({ text: sendText(content), opts });
    if (opts?.priority === "now") this.aborted = true;
  }
  async interrupt(): Promise<void> {
    this.interrupts++;
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
  const fakeStart = { run: new FakeRun(), accountId: "acct-a", account: { id: "acct-a" } };
  internals.startResumedImplementor = async (): Promise<typeof fakeStart> => fakeStart;
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
function stubQaRunRole(h: Harness, whileLive: (qa: FakeRun) => Promise<void>): FakeRun[] {
  const agents: FakeRun[] = [];
  h.internals.runRole = async (t: Thread, role: string): Promise<unknown> => {
    const agent = new FakeRun();
    agents.push(agent);
    h.internals.liveQa.set(t.id, agent);
    const run = h.db.createRun({ threadId: t.id, role: role as "qa", model: "claude-opus-5", account: "acct-a" });
    await whileLive(agent);
    h.internals.liveQa.delete(t.id);
    const res = agent.aborted ? ABORTED : verdictResult({ pass: true, summary: "verified", changed: false });
    h.db.updateRun(run.id, { sessionId: "qa-session", state: "done", endedAt: Date.now() });
    return res;
  };
  return agents;
}

async function main(): Promise<void> {
  console.log("\n=== Inject during a structured one-shot steers it, never aborts it — integration test ===\n");

  // -- Test A (the bug): an interrupt-mode inject during QA must not kill the task ---------------------
  console.log("Test A — 'Interrupt & inject' while QA reviews: QA still reaches its verdict");
  {
    const h = makeHarness();
    try {
      const id = seedTask(h);
      const agents = stubQaRunRole(h, async (_qa) => {
        await h.mgr.injectThread(id, "scrap the button, add an item blacklist instead", "interrupt");
      });
      await runLoop(h, id);
      const qa = agents[0]!;
      check("the task was NOT parked for review", h.db.getThread(id)?.state !== "review", `state=${h.db.getThread(id)?.state}`);
      check("the task reached QA's verdict and settled done", h.db.getThread(id)?.state === "done", `state=${h.db.getThread(id)?.state}`);
      check("QA was never interrupted", qa.interrupts === 0, `interrupts=${qa.interrupts}`);
      check("QA's turn was never aborted", !qa.aborted);
      check("QA still received the steering", qa.sends.length === 1 && qa.sends[0]!.text.includes("item blacklist"), JSON.stringify(qa.sends.map((s) => s.text.slice(0, 40))));
      check("...as a plain queued message, with no priority", qa.sends[0]!.opts?.priority === undefined, String(qa.sends[0]!.opts?.priority));
      check(
        "the direction was delivered to the implementor before the task settled",
        h.drained.some((q) => q.some((m) => m.includes("item blacklist"))),
        JSON.stringify(h.drained),
      );
      const feed = h.db.listMessages(id).map((m) => m.content);
      check("the feed says where the note went", feed.some((c) => c.includes("sent to QA and queued for the implementor")), JSON.stringify(feed.filter((c) => c.startsWith("↪")).slice(0, 3)));
      await settle();
    } finally {
      h.dispose();
    }
  }

  // -- Test B: append mode behaves identically (a one-shot cannot be interrupted either way) -----------
  console.log("\nTest B — append mode takes the same non-destructive route");
  {
    const h = makeHarness();
    try {
      const id = seedTask(h);
      const agents = stubQaRunRole(h, async () => {
        await h.mgr.injectThread(id, "also cover the offhand slot", "append");
      });
      await runLoop(h, id);
      check("the task settled done", h.db.getThread(id)?.state === "done", `state=${h.db.getThread(id)?.state}`);
      check("the appended note carried no priority either", agents[0]!.sends[0]!.opts?.priority === undefined, String(agents[0]!.sends[0]!.opts?.priority));
      check("it was queued for the implementor too", h.drained.some((q) => q.some((m) => m.includes("offhand slot"))), JSON.stringify(h.drained));
      await settle();
    } finally {
      h.dispose();
    }
  }

  // -- Test C: the fix-round window (state 'qa', no live QA handle) still delivers ---------------------
  // QA has returned but the re-launched implementor isn't live yet, so there is nothing to steer. The
  // note must not spawn an implementor beside the pipeline, and must not be dropped.
  console.log("\nTest C — an inject with no live QA handle is queued, not dropped, and spawns nothing");
  {
    const h = makeHarness();
    try {
      const id = seedTask(h);
      h.db.updateThread(id, { state: "qa" });
      let spawned = 0;
      h.internals.startResumedImplementor = async (): Promise<unknown> => {
        spawned++;
        return { run: new FakeRun(), accountId: "acct-a" };
      };
      const r = await h.mgr.injectThread(id, "use the addon options panel", "interrupt");
      check("the inject was accepted and stayed in the qa stage", r.ok && r.state === "qa", JSON.stringify(r));
      check("no implementor was spawned beside the pipeline", spawned === 0, `spawns=${spawned}`);
      check("the note is queued for the implementor", (h.internals.queuedForImplementor.get(id) ?? []).some((m: string) => m.includes("addon options")), JSON.stringify(h.internals.queuedForImplementor.get(id)));
      await settle();
    } finally {
      h.dispose();
    }
  }

  // -- Test D: Resume-with-a-message during QA is the same gate, and had the same defect ---------------
  console.log("\nTest D — a Resume carrying a message during QA steers rather than aborts");
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

  // -- Test E: the auto-reviewer is the same kind of role, and settles the task itself -----------------
  console.log("\nTest E — an inject during the auto-review steers the reviewer rather than aborting it");
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

  // -- Test F: the other half — a live IMPLEMENTOR must still be interruptible -------------------------
  // Over-correcting here would be just as wrong: steering an implementor mid-turn is the whole point of
  // the button, and that role has no verdict to lose.
  console.log("\nTest F — a live implementor is still interrupted and steered at 'now' priority");
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
