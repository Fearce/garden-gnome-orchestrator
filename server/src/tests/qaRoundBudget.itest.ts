/**
 * Integration test — the QA-round budget is DURABLE across resumes (real ThreadManager machinery).
 *
 * Regression guard for the "Grok QA loop ran again and again and drained the subscription" bug. The QA
 * round counter used to be a fresh local variable in `runImplementorQaLoop`, so every re-entry (a server
 * restart's auto-resume, or a cap-resume) started the loop at round 1 and ran another full QA pass — with
 * a frequently-bouncing server that's an unbounded implementor↔QA loop. The fix persists `qaRoundsUsed`
 * in stage_outputs and resumes the loop from it, so the total QA rounds across ALL resumes is bounded by
 * `maxQaRounds`.
 *
 * WHAT IS REAL vs. STUBBED
 *  - REAL: `runImplementorQaLoop` itself — the round loop, the durable read/persist of `qaRoundsUsed`,
 *    the exhaustion park, the setState/settleReview transitions, and the real `Db` + `EventHub` behind them.
 *  - STUBBED: only the agent-spawning leaves we cannot run without burning real tokens — `startResumed-
 *    Implementor`, `awaitImplementorCompletion`, `drainQueuedImplementor`, `runQA`, `stopLive`,
 *    `runSelfImprovement`. `runQA` is driven by the test to return a fixed verdict and RECORD the round
 *    number it was called with — that recording is what proves the loop continued instead of resetting.
 *
 * Run:  npm run test:qa-budget   (from server/)   — or:  npx tsx src/tests/qaRoundBudget.itest.ts
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
}

interface Harness {
  mgr: InstanceType<typeof ThreadManager>;
  db: InstanceType<typeof Db>;
  workspace: string;
  qaRounds: number[]; // the `round` value each runQA call saw, in order
  dir: string;
  setVerdict(v: { pass: boolean; summary: string }): void;
  dispose(): void;
}

/** A ThreadManager whose agent-spawning leaves are stubbed but whose QA loop is 100% real. */
function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "qa-budget-"));
  const workspace = join(dir, "workspace");
  mkdirSync(workspace, { recursive: true });
  const db = new Db(join(dir, "orchestrator.sqlite"));
  const hub = new EventHub();
  const memory = new FileMemoryService(join(dir, "memory"));
  const mgr = new ThreadManager(db, hub, memory, new StubAccounts() as unknown as AccountManager);

  const qaRounds: number[] = [];
  let verdict = { pass: false, summary: "not satisfied" };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = mgr as any;
  const fakeStart = { run: { send(): void {} }, accountId: "acct-a", account: { id: "acct-a" } };
  internals.startResumedImplementor = async (): Promise<typeof fakeStart> => fakeStart;
  internals.awaitImplementorCompletion = async (): Promise<{ isError: boolean }> => ({ isError: false });
  internals.drainQueuedImplementor = async (_t: Thread, _e: unknown, _k: string, res: unknown): Promise<unknown> => res;
  internals.stopLive = async (): Promise<void> => {};
  internals.runSelfImprovement = async (): Promise<void> => {};
  internals.flushDirectorNotes = (): void => {};
  internals.runQA = async (_thread: Thread, opts: { round: number }): Promise<{ pass: boolean; summary: string }> => {
    qaRounds.push(opts.round);
    return verdict;
  };

  return {
    mgr,
    db,
    workspace,
    qaRounds,
    dir,
    setVerdict(v) {
      verdict = v;
    },
    dispose() {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const anyMgr = mgr as any;
      if (anyMgr.capSupervisor) clearInterval(anyMgr.capSupervisor);
      db.raw.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function seedTask(h: Harness): string {
  const t = h.db.createThread({ title: "mock qa-loop task", workspace: h.workspace, rawPrompt: "do the thing" });
  h.db.updateThreadStageOutputs(t.id, { kickoff: "KICKOFF: mock", planDone: true, approved: true });
  return t.id;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const runLoop = (h: Harness, id: string, maxQaRounds: number): Promise<void> =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (h.mgr as any).runImplementorQaLoop(h.db.getThread(id)!, "KICKOFF: mock", undefined, undefined, undefined, {
    qaEnabled: true,
    maxQaRounds,
  });

async function main(): Promise<void> {
  console.log("\n=== QA-round budget is durable across resumes — integration test (real machinery) ===\n");

  // -- Test A: a fresh episode spends exactly maxQaRounds and then parks -------------------------------
  console.log("Test A — QA never satisfied: the loop runs exactly maxQaRounds and parks for review");
  {
    const h = makeHarness();
    try {
      const id = seedTask(h);
      h.setVerdict({ pass: false, summary: "nope" });
      await runLoop(h, id, 4);
      check("QA ran exactly maxQaRounds times", h.qaRounds.length === 4, `rounds=${JSON.stringify(h.qaRounds)}`);
      check("the rounds counted up 1..4", JSON.stringify(h.qaRounds) === JSON.stringify([1, 2, 3, 4]), JSON.stringify(h.qaRounds));
      check("qaRoundsUsed was persisted at the cap", h.db.getThreadStageOutputs(id).qaRoundsUsed === 4, String(h.db.getThreadStageOutputs(id).qaRoundsUsed));
      check("the task parked for review", h.db.getThread(id)?.state === "review", `state=${h.db.getThread(id)?.state}`);
    } finally {
      h.dispose();
    }
  }

  // -- Test B (the bug): a restart re-entry does NOT reset the budget — it stays bounded ----------------
  console.log("\nTest B — a restart re-enters the loop but the exhausted budget stays spent (no fresh pass)");
  {
    const h = makeHarness();
    try {
      const id = seedTask(h);
      h.setVerdict({ pass: false, summary: "nope" });
      await runLoop(h, id, 3);
      const afterFirst = h.qaRounds.length;
      check("first episode spent the full budget", afterFirst === 3, `rounds=${afterFirst}`);

      // Simulate a server restart's auto-resume: markInterrupted flips the thread to 'failed', then the
      // resume-aware pipeline re-enters runImplementorQaLoop. Old behavior: 3 MORE fresh QA passes.
      h.db.updateThread(id, { state: "failed", error: null });
      await runLoop(h, id, 3);
      check("the restart did NOT relaunch QA — budget already spent", h.qaRounds.length === afterFirst, `total rounds=${h.qaRounds.length} (expected ${afterFirst})`);
      check("the re-entry parked immediately for review", h.db.getThread(id)?.state === "review", `state=${h.db.getThread(id)?.state}`);
    } finally {
      h.dispose();
    }
  }

  // -- Test C: a MID-episode resume continues from the persisted count (not from round 1) --------------
  console.log("\nTest C — a mid-episode resume continues at the next round, not round 1");
  {
    const h = makeHarness();
    try {
      const id = seedTask(h);
      // 3 rounds were already spent before an interrupt (persisted), cap is 6.
      h.db.updateThreadStageOutputs(id, { qaRoundsUsed: 3 });
      h.setVerdict({ pass: false, summary: "nope" });
      await runLoop(h, id, 6);
      check("QA resumed at round 4 (warm-resume eligible, round > 1)", h.qaRounds[0] === 4, `first round=${h.qaRounds[0]}`);
      check("only the remaining 3 rounds ran (4,5,6)", JSON.stringify(h.qaRounds) === JSON.stringify([4, 5, 6]), JSON.stringify(h.qaRounds));
      check("qaRoundsUsed reached the cap", h.db.getThreadStageOutputs(id).qaRoundsUsed === 6, String(h.db.getThreadStageOutputs(id).qaRoundsUsed));
      check("the task parked for review at the cap", h.db.getThread(id)?.state === "review", `state=${h.db.getThread(id)?.state}`);
    } finally {
      h.dispose();
    }
  }

  // -- Test D: QA passing mid-budget settles 'done' and leaves the (partial) count persisted -----------
  console.log("\nTest D — QA passes on round 2: the task completes and stops spending rounds");
  {
    const h = makeHarness();
    try {
      const id = seedTask(h);
      let calls = 0;
      // fail round 1, pass round 2.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (h.mgr as any).runQA = async (_thread: Thread, opts: { round: number }): Promise<{ pass: boolean; summary: string }> => {
        h.qaRounds.push(opts.round);
        calls++;
        return calls >= 2 ? { pass: true, summary: "all good" } : { pass: false, summary: "one fix" };
      };
      await runLoop(h, id, 7);
      check("QA ran twice then stopped (pass on round 2)", h.qaRounds.length === 2 && h.qaRounds[1] === 2, JSON.stringify(h.qaRounds));
      check("the task reached 'done'", h.db.getThread(id)?.state === "done", `state=${h.db.getThread(id)?.state}`);
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
