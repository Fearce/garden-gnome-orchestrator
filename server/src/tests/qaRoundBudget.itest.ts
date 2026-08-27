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
// The QA-continuation tests (H/I/J) resume a FAKE session id, which has no CLI transcript on disk — so
// the age-based warm check can't evaluate it. Force full resume to exercise the resumed branch. NOTE
// this is process-global: it is inert for the tests that stub `runQA`/`startResumedImplementor`, but any
// future test driving the REAL `startResumedImplementor` would take the full-resume branch and never the
// compressed-seed one. Set it around the H/I/J block instead if such a test lands here.
process.env.RESUME_FULL_SESSION = "1";

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountManager } from "../accounts/accountManager.js";
import type { ResultEvent } from "../agents/runner.js";
import type { Thread } from "../types.js";

const { Db } = await import("../db/db.js");
const { EventHub } = await import("../events.js");
const { FileMemoryService } = await import("../memory/memory.js");
const { ThreadManager, qaFixFreshKickoff } = await import("../orchestrator/threadManager.js");
const { runErrorText } = await import("../orchestrator/runError.js");
const { clientCommandSchema } = await import("../ws/protocol.js");

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
}

interface Harness {
  mgr: InstanceType<typeof ThreadManager>;
  db: InstanceType<typeof Db>;
  workspace: string;
  qaRounds: number[]; // the `round` value each runQA call saw, in order
  implementorStarts: () => number;
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
  let implementorStarts = 0;
  let verdict = { pass: false, summary: "not satisfied" };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = mgr as any;
  const fakeStart = { run: { send(): void {} }, accountId: "acct-a", account: { id: "acct-a" } };
  internals.startResumedImplementor = async (): Promise<typeof fakeStart> => {
    implementorStarts++;
    return fakeStart;
  };
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
    implementorStarts: () => implementorStarts,
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

const QA_SESSION = "qa-session-cut-off";
/** A run the SDK ended at the per-session turn ceiling: an involuntary cutoff, so no structured verdict.
 *  No `result` text — an Agent-SDK error result carries none, which is why `runErrorText` falls through
 *  to the canned subtype reason the park message and the sweep classifier both key on. */
const CUTOFF = { type: "result", subtype: "error_max_turns", isError: true };
/** A run that came back EMPTY: a SUCCESS result with no structured output, produced by a session the CLI
 *  loaded and exited without ever reaching the model. It is indistinguishable from a finish at the result
 *  level — the only evidence is that the run emitted no messages, which the harness's stub also doesn't. */
const SILENT = { type: "result", subtype: "success", isError: false };
const verdictResult = (structuredOutput: { pass: boolean; summary: string; changed: boolean }) => ({
  type: "result",
  subtype: "success",
  isError: false,
  structuredOutput,
});

interface QaRoleCall {
  kickoff: string;
  resume: string | undefined;
}

/** Stub the agent-spawning leaf BELOW runQA, so the real runQA (its resume decision, its kickoff choice
 *  and its turn-ceiling continuation) runs. Each queued result is returned by one QA run, in order; the
 *  last one repeats if QA is called more times than the test queued.
 *
 *  The stub also persists the `agent_runs` row the real `runRole` would have written, error text and
 *  all: the park path reads the latest QA run's error to stay diagnosable, and a harness with an empty
 *  runs table would silently exercise the generic fallback instead. */
function stubQaRunRole(h: Harness, results: unknown[]): QaRoleCall[] {
  const calls: QaRoleCall[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = h.mgr as any;
  delete internals.runQA; // drop makeHarness's stub — this test exercises the real one
  internals.latestQaRun = () => ({ sessionId: QA_SESSION, provider: "claude" });
  internals.runRole = async (t: Thread, role: string, kickoff: string | unknown[], _cfg: unknown, resume?: string): Promise<unknown> => {
    calls.push({ kickoff: typeof kickoff === "string" ? kickoff : JSON.stringify(kickoff), resume });
    const res = results[Math.min(calls.length - 1, results.length - 1)] as { isError?: boolean };
    const run = h.db.createRun({ threadId: t.id, role: role as "qa", model: "claude-opus-5" });
    h.db.updateRun(run.id, {
      sessionId: QA_SESSION,
      state: res.isError ? "error" : "done",
      error: res.isError ? runErrorText(res as ResultEvent) : null,
      endedAt: Date.now(),
    });
    return res;
  };
  return calls;
}

function seedTask(h: Harness): string {
  const t = h.db.createThread({ title: "mock qa-loop task", workspace: h.workspace, rawPrompt: "do the thing" });
  h.db.updateThreadStageOutputs(t.id, { kickoff: "KICKOFF: mock", planDone: true, approved: true });
  return t.id;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const runLoop = (h: Harness, id: string, maxQaRounds: number, qaAppliesFixes = false, autoPush = true): Promise<void> =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (h.mgr as any).runImplementorQaLoop(h.db.getThread(id)!, "KICKOFF: mock", undefined, undefined, undefined, {
    qaEnabled: true,
    maxQaRounds,
    qaAppliesFixes,
    autoPush,
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

  // -- Test A2: a usage-capped QA retries QA itself, even at the normal round limit ---------------------
  console.log("\nTest A2 — a QA provider cap resumes the charged review directly (no duplicate implementor)");
  {
    const h = makeHarness();
    try {
      const id = seedTask(h);
      const internals = h.mgr as any;
      const continuations: boolean[] = [];
      let calls = 0;
      internals.runQA = async (_thread: Thread, opts: { round: number; continuation?: boolean }): Promise<{ pass: boolean; summary: string } | undefined> => {
        h.qaRounds.push(opts.round);
        continuations.push(opts.continuation === true);
        calls++;
        if (calls === 1) {
          // Mirrors the real runRole ladder after every usable provider has been capped.
          internals.capParked.set(id, "qa");
          return undefined;
        }
        return { pass: true, summary: "fallback provider completed QA" };
      };
      await runLoop(h, id, 1);
      check("the capped final QA round parks for automatic retry", h.db.getThread(id)?.state === "review" && (h.db.getThread(id)?.error ?? "").startsWith("⏳ Auto-resume pending"));
      check("the charged QA round is persisted for direct retry", h.db.getThreadStageOutputs(id).qaCapRetryRound === 1, String(h.db.getThreadStageOutputs(id).qaCapRetryRound));
      check("the original implementation ran once", h.implementorStarts() === 1, String(h.implementorStarts()));

      // Simulate the supervisor's review→failed handoff. The saved stage record is the authority.
      h.db.updateThread(id, { state: "failed", error: h.db.getThread(id)?.error ?? null });
      await runLoop(h, id, 1);
      check("the fallback QA receives the same final round", JSON.stringify(h.qaRounds) === JSON.stringify([1, 1]), JSON.stringify(h.qaRounds));
      check("the replacement QA is a continuation, not a fresh QA budget round", continuations[1] === true, JSON.stringify(continuations));
      check("QA-cap auto-resume did not relaunch the implementor", h.implementorStarts() === 1, String(h.implementorStarts()));
      check("a fallback QA pass completes the task", h.db.getThread(id)?.state === "done", `state=${h.db.getThread(id)?.state}`);
      check("the retry marker clears once QA returns a verdict", h.db.getThreadStageOutputs(id).qaCapRetryRound === undefined);
    } finally {
      h.dispose();
    }
  }

  // -- Test B (the bug): a restart re-entry does NOT reset the budget — it stays bounded ----------------
  // -- Test A3: a restart during QA retries that QA round, never the completed implementor -----------
  console.log("\nTest A3 — a restart-interrupted QA pass resumes the review directly");
  {
    const h = makeHarness();
    try {
      const id = seedTask(h);
      h.setVerdict({ pass: true, summary: "replacement QA completed" });
      h.db.updateThreadStageOutputs(id, { qaRoundsUsed: 2, qaInterruptedRetryRound: 2 });
      await runLoop(h, id, 2);
      check("restart recovery runs the charged QA round", JSON.stringify(h.qaRounds) === JSON.stringify([2]), JSON.stringify(h.qaRounds));
      check("restart recovery does not relaunch the completed implementor", h.implementorStarts() === 0, String(h.implementorStarts()));
      check("the restart QA marker clears after a verdict", h.db.getThreadStageOutputs(id).qaInterruptedRetryRound === undefined);
      check("the direct restart QA retry can complete the task", h.db.getThread(id)?.state === "done", `state=${h.db.getThread(id)?.state}`);
    } finally {
      h.dispose();
    }
  }

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

  // -- Test E: opt-in QA-fixes mode never bounces changed work through the implementor --------------
  console.log("\nTest E — QA-fixes mode sends QA edits to another QA pass, not back to the implementor");
  {
    const h = makeHarness();
    try {
      const id = seedTask(h);
      let calls = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const internals = h.mgr as any;
      // Simulate a single-provider deployment: after QA #1 edits, the verifier must use the same
      // provider but a FRESH session, never warm-resume the editor's session to approve itself.
      internals.latestQaRun = () => ({ sessionId: "qa-editor-session", provider: "claude" });
      internals.qaFixVerifierProvider = () => "claude";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      internals.runQA = async (_thread: Thread, opts: { round: number; applyFixes?: boolean; autoPush?: boolean; forceFresh?: boolean }): Promise<{ pass: boolean; summary: string; changed: boolean }> => {
        h.qaRounds.push(opts.round);
        check("QA-fixes flag reaches the QA runner", opts.applyFixes === true, String(opts.applyFixes));
        check("QA-fixes runner inherits the task auto-push policy", opts.autoPush === true, String(opts.autoPush));
        if (calls === 1) check("same-provider verifier forces a fresh QA session", opts.forceFresh === true, String(opts.forceFresh));
        calls++;
        return calls === 1
          ? { pass: true, summary: "fixed one issue", changed: true }
          : { pass: true, summary: "independently verified", changed: false };
      };
      await runLoop(h, id, 4, true);
      check("the changed QA pass triggered exactly one verifier QA pass", JSON.stringify(h.qaRounds) === JSON.stringify([1, 2]), JSON.stringify(h.qaRounds));
      check("QA fixes did not re-launch the implementor", h.implementorStarts() === 1, `starts=${h.implementorStarts()}`);
      check("an unchanged passing verifier accepted the task", h.db.getThread(id)?.state === "done", `state=${h.db.getThread(id)?.state}`);
    } finally {
      h.dispose();
    }
  }

  // -- Test F: the fresh verifier kickoff still carries the task context ---------------------------
  // A verifier pass is a fresh session on effectively every route (a different provider cannot resume
  // the editor's session, and a same-provider verifier is deliberately forced fresh). If it only got
  // the "a previous reviewer edited the tree" handoff it would review the diff with no brief at all
  // and could not judge completeness against the requirements.
  console.log("\nTest F — a fresh QA-fixes verifier kickoff carries the brief, not just the handoff");
  {
    const h = makeHarness();
    try {
      const thread = h.db.createThread({
        title: "mock qa-fixes task",
        workspace: h.workspace,
        rawPrompt: "do the thing",
        brief: "BRIEF-SENTINEL: add a toggle and gate the new behavior behind it",
      });
      const kickoff = qaFixFreshKickoff(thread, undefined, "fixed a null deref\n- [blocker] deliverable not surfaced", []);
      check("fresh verifier kickoff names the task", kickoff.includes(thread.title), kickoff.slice(0, 80));
      check("fresh verifier kickoff carries the brief", kickoff.includes("BRIEF-SENTINEL"), "brief missing");
      check("fresh verifier kickoff carries the prior-fix handoff", kickoff.includes("previous QA reviewer just edited the working tree"), "handoff missing");
      check("fresh verifier kickoff forwards unresolved issues", kickoff.includes("[blocker] deliverable not surfaced"), "issues missing");
      check("fresh verifier kickoff keeps the deliverables check", kickoff.includes("Deliverables check"), "deliverables block missing");
    } finally {
      h.dispose();
    }
  }

  // -- Test G: the opt-in setting crosses the websocket boundary and persists ----------------------
  console.log("\nTest G — QA-fixes setting defaults off and persists through the settings contract");
  {
    const h = makeHarness();
    try {
      check("settings.set accepts qaAppliesFixes=true", clientCommandSchema.safeParse({ type: "settings.set", settings: { qaAppliesFixes: true } }).success);
      check("settings.set accepts qaAppliesFixes=false", clientCommandSchema.safeParse({ type: "settings.set", settings: { qaAppliesFixes: false } }).success);
      check("QA-fixes mode defaults off", h.mgr.settings().qaAppliesFixes === false, String(h.mgr.settings().qaAppliesFixes));

      h.mgr.setSettings({ qaAppliesFixes: true });
      check("enabling QA-fixes persists the kv value", h.db.kvGet("setting_qa_applies_fixes") === "1", String(h.db.kvGet("setting_qa_applies_fixes")));
      check("enabling QA-fixes is reflected in settings", h.mgr.settings().qaAppliesFixes === true, String(h.mgr.settings().qaAppliesFixes));

      h.mgr.setSettings({ qaAppliesFixes: false });
      check("disabling QA-fixes persists the kv value", h.db.kvGet("setting_qa_applies_fixes") === "0", String(h.db.kvGet("setting_qa_applies_fixes")));
      check("disabling QA-fixes is reflected in settings", h.mgr.settings().qaAppliesFixes === false, String(h.mgr.settings().qaAppliesFixes));
    } finally {
      h.dispose();
    }
  }

  // -- Test H: a QA run cut off at its turn ceiling is CONTINUED, not parked on the owner -----------
  // The implementor path already warm-resumes an `error_max_turns` stop because it is involuntary. QA
  // had no such path: the reviewer was cut off mid-verification, produced no verdict, and the task
  // parked with a review the owner had already paid an Opus pass for. These two tests stub `runRole`
  // (one level deeper than the others) so the REAL runQA + continuation logic runs.
  console.log("\nTest H — a turn-ceiling QA cutoff continues the same session instead of parking");
  {
    const h = makeHarness();
    try {
      const id = seedTask(h);
      const qaCalls = stubQaRunRole(h, [CUTOFF, verdictResult({ pass: true, summary: "verified", changed: false })]);
      await runLoop(h, id, 4);
      check("QA ran twice: the cutoff plus its continuation", qaCalls.length === 2, `calls=${qaCalls.length}`);
      check("round 1's own QA still started fresh", qaCalls[0]?.resume === undefined, String(qaCalls[0]?.resume));
      check("the continuation resumed the cut-off QA session", qaCalls[1]?.resume === QA_SESSION, String(qaCalls[1]?.resume));
      check(
        "the continuation told QA it was cut off, not that the tree changed",
        !!qaCalls[1]?.kickoff.includes("stopped at a per-session turn limit"),
        qaCalls[1]?.kickoff.slice(0, 80),
      );
      check("the continuation did NOT spend a QA round", h.db.getThreadStageOutputs(id).qaRoundsUsed === 1, String(h.db.getThreadStageOutputs(id).qaRoundsUsed));
      check("the continuation was charged to the durable cutoff budget", h.db.getThreadStageOutputs(id).qaCutoffResumes === 1, String(h.db.getThreadStageOutputs(id).qaCutoffResumes));
      check("the continued verdict settled the task", h.db.getThread(id)?.state === "done", `state=${h.db.getThread(id)?.state}`);
    } finally {
      h.dispose();
    }
  }

  // -- Test I: the continuation budget is bounded and durable ---------------------------------------
  console.log("\nTest I — a QA reviewer that keeps hitting the ceiling is bounded, then parks");
  {
    const h = makeHarness();
    try {
      const id = seedTask(h);
      const qaCalls = stubQaRunRole(h, [CUTOFF, CUTOFF, CUTOFF, CUTOFF]);
      await runLoop(h, id, 4);
      // MAX_QA_CUTOFF_RESUMES (2) continuations on top of the round's own QA run.
      check("QA stopped after the bounded continuations", qaCalls.length === 3, `calls=${qaCalls.length}`);
      check("the cutoff budget was fully spent", h.db.getThreadStageOutputs(id).qaCutoffResumes === 2, String(h.db.getThreadStageOutputs(id).qaCutoffResumes));
      check("a verdict-less QA still parks for the owner", h.db.getThread(id)?.state === "review", `state=${h.db.getThread(id)?.state}`);
      check("the park stays diagnosable (names the turn ceiling)", !!h.db.getThread(id)?.error?.includes("per-session turn ceiling"), String(h.db.getThread(id)?.error));
      check("the park says the continuations were spent too", !!h.db.getThread(id)?.error?.includes("cut off again each time"), String(h.db.getThread(id)?.error));

      // A restart mid-continuation must not hand the task a fresh continuation budget.
      h.db.updateThread(id, { state: "failed", error: null });
      h.db.updateThreadStageOutputs(id, { qaRoundsUsed: 1 });
      await runLoop(h, id, 4);
      check("a re-entry gets no fresh continuation budget", qaCalls.length === 4, `calls=${qaCalls.length}`);
    } finally {
      h.dispose();
    }
  }

  // -- Test J: a cut-off QA-fixes VERIFIER continues its own session ---------------------------------
  // The verifier round is deliberately forced fresh so an editing QA run can't warm-resume into
  // approving its own edits. That guard must not survive into the continuation: the session being
  // continued is the verifier's own, so re-forcing fresh would discard the interrupted review.
  console.log("\nTest J — a cut-off QA-fixes verifier continues its own session, not a third fresh pass");
  {
    const h = makeHarness();
    try {
      const id = seedTask(h);
      const qaCalls = stubQaRunRole(h, [
        verdictResult({ pass: true, summary: "fixed one issue", changed: true }),
        CUTOFF,
        verdictResult({ pass: true, summary: "independently verified", changed: false }),
      ]);
      await runLoop(h, id, 4, true);
      check("the verifier round started fresh (no self-approval)", qaCalls[1]?.resume === undefined, String(qaCalls[1]?.resume));
      check("its continuation resumed the verifier's own session", qaCalls[2]?.resume === QA_SESSION, String(qaCalls[2]?.resume));
      check(
        "the continuation still binds the reviewer to reporting its own edits",
        !!qaCalls[2]?.kickoff.includes("you must still report `changed: true`"),
        qaCalls[2]?.kickoff.slice(0, 120),
      );
      check("the continued verifier accepted the task", h.db.getThread(id)?.state === "done", `state=${h.db.getThread(id)?.state}`);
    } finally {
      h.dispose();
    }
  }

  // -- Test K: a QA run that produced NOTHING is re-run fresh, not read as a review ------------------
  // An empty run arrives as a SUCCESS result with no verdict, so it used to fall straight through to the
  // owner: the console showed a QA run that looked fine, the park message said only "could not complete",
  // and nothing had actually been reviewed. A warm resume is what fails this way, so the retry is fresh.
  console.log("\nTest K — a QA run that came back empty is re-run on a fresh session");
  {
    const h = makeHarness();
    try {
      const id = seedTask(h);
      h.db.updateThreadStageOutputs(id, { qaRoundsUsed: 1 }); // round 2 ⇒ warm-resume eligible, as in production
      const qaCalls = stubQaRunRole(h, [SILENT, verdictResult({ pass: true, summary: "verified", changed: false })]);
      await runLoop(h, id, 4);
      check("QA ran twice: the empty run plus its retry", qaCalls.length === 2, `calls=${qaCalls.length}`);
      check("the empty run was the warm resume", qaCalls[0]?.resume === QA_SESSION, String(qaCalls[0]?.resume));
      check("the retry started a FRESH session, not the same resume", qaCalls[1]?.resume === undefined, String(qaCalls[1]?.resume));
      check("the fresh retry got the full review brief", !!qaCalls[1]?.kickoff.includes("# QA review for task:"), qaCalls[1]?.kickoff.slice(0, 80));
      check("the retry did NOT spend a QA round", h.db.getThreadStageOutputs(id).qaRoundsUsed === 2, String(h.db.getThreadStageOutputs(id).qaRoundsUsed));
      check("the retry was charged to the durable silent budget", h.db.getThreadStageOutputs(id).qaSilentRetries === 1, String(h.db.getThreadStageOutputs(id).qaSilentRetries));
      const firstQa = h.db.listRuns(id).filter((r) => r.role === "qa").sort((a, b) => a.startedAt - b.startedAt)[0];
      check("the empty run is recorded as a failure, not a clean 'done'", firstQa?.state === "error", `state=${firstQa?.state}`);
      check("...and it says why (the sweep classifier keys on this text)", !!firstQa?.error?.includes("produced no output"), String(firstQa?.error));
      check("the retry's verdict settled the task", h.db.getThread(id)?.state === "done", `state=${h.db.getThread(id)?.state}`);
    } finally {
      h.dispose();
    }
  }

  // -- Test L: the production sequence — a turn-ceiling continuation that itself comes back empty -----
  // This is the shape that parked a real task: QA hit its ceiling, the continuation woke the session, and
  // the woken session returned without reaching the model. The cutoff path had spent its resume and the
  // empty result carried no verdict, so an already-paid Opus review was thrown away.
  console.log("\nTest L — a continuation that comes back empty falls back to a fresh review");
  {
    const h = makeHarness();
    try {
      const id = seedTask(h);
      const qaCalls = stubQaRunRole(h, [CUTOFF, SILENT, verdictResult({ pass: true, summary: "verified", changed: false })]);
      await runLoop(h, id, 4);
      check("QA ran three times: cutoff, continuation, fresh retry", qaCalls.length === 3, `calls=${qaCalls.length}`);
      check("the continuation resumed the cut-off session", qaCalls[1]?.resume === QA_SESSION, String(qaCalls[1]?.resume));
      check("the retry after the empty continuation is fresh", qaCalls[2]?.resume === undefined, String(qaCalls[2]?.resume));
      check(
        "the fresh retry is no longer told to 'continue where you left off'",
        !qaCalls[2]?.kickoff.includes("stopped at a per-session turn limit"),
        qaCalls[2]?.kickoff.slice(0, 80),
      );
      check("both recovery budgets were charged once each", h.db.getThreadStageOutputs(id).qaCutoffResumes === 1 && h.db.getThreadStageOutputs(id).qaSilentRetries === 1, JSON.stringify(h.db.getThreadStageOutputs(id)));
      check("still only one QA round was spent", h.db.getThreadStageOutputs(id).qaRoundsUsed === 1, String(h.db.getThreadStageOutputs(id).qaRoundsUsed));
      check("the task reached a verdict instead of the owner's queue", h.db.getThread(id)?.state === "done", `state=${h.db.getThread(id)?.state}`);
    } finally {
      h.dispose();
    }
  }

  // -- Test M: the silent-retry budget is bounded and durable ----------------------------------------
  console.log("\nTest M — a reviewer that keeps coming back empty is bounded, then parks diagnosably");
  {
    const h = makeHarness();
    try {
      const id = seedTask(h);
      const qaCalls = stubQaRunRole(h, [SILENT, SILENT, SILENT]);
      await runLoop(h, id, 4);
      // MAX_QA_SILENT_RETRIES (1) fresh retry on top of the round's own QA run.
      check("QA stopped after the single bounded retry", qaCalls.length === 2, `calls=${qaCalls.length}`);
      check("the silent budget was fully spent", h.db.getThreadStageOutputs(id).qaSilentRetries === 1, String(h.db.getThreadStageOutputs(id).qaSilentRetries));
      check("a still-empty QA parks for the owner", h.db.getThread(id)?.state === "review", `state=${h.db.getThread(id)?.state}`);
      check("the park names the real cause (an empty run, not 'could not complete')", !!h.db.getThread(id)?.error?.includes("produced no output"), String(h.db.getThread(id)?.error));
      check("the park says the fresh retry was already tried", !!h.db.getThread(id)?.error?.includes("restarted on a fresh session"), String(h.db.getThread(id)?.error));

      // A restart mid-retry must not hand the task a fresh retry budget.
      h.db.updateThread(id, { state: "failed", error: null });
      h.db.updateThreadStageOutputs(id, { qaRoundsUsed: 1 });
      await runLoop(h, id, 4);
      check("a re-entry gets no fresh silent-retry budget", qaCalls.length === 3, `calls=${qaCalls.length}`);
      check("the re-entry parked again rather than looping", h.db.getThread(id)?.state === "review", `state=${h.db.getThread(id)?.state}`);
    } finally {
      h.dispose();
    }
  }

  // -- Test N: the continuation allowance belongs to the REVIEW, not to the task --------------------
  // It was charged against a task-lifetime counter, so cutoffs in unrelated rounds pooled. In QA-fixes
  // mode — where every round is an editing pass long enough to reach the ceiling — round 1 and round 2
  // each spending one continuation left round 3's FIRST cutoff with nothing, and the task parked on the
  // owner mid-verification although no single review had ever failed twice. Four production tasks were
  // sitting in `review` for exactly this. The budget now resets whenever a round reaches a verdict.
  console.log("\nTest N — a later round's first cutoff still gets its continuation");
  {
    const h = makeHarness();
    try {
      const id = seedTask(h);
      const qaCalls = stubQaRunRole(h, [
        CUTOFF,
        verdictResult({ pass: true, summary: "round 1 fixed something", changed: true }),
        CUTOFF,
        verdictResult({ pass: true, summary: "round 2 fixed something else", changed: true }),
        CUTOFF,
        verdictResult({ pass: true, summary: "nothing left to change", changed: false }),
      ]);
      await runLoop(h, id, 4, true);
      check("every round got its continuation, including the third", qaCalls.length === 6, `calls=${qaCalls.length}`);
      check("round 3's continuation resumed the cut-off session", qaCalls[5]?.resume === QA_SESSION, String(qaCalls[5]?.resume));
      check("the task reached a verdict instead of the owner's queue", h.db.getThread(id)?.state === "done", `state=${h.db.getThread(id)?.state}`);
      const stage = h.db.getThreadStageOutputs(id);
      check("the accepting verdict left a full allowance behind", (stage.qaCutoffResumesThisRound ?? 0) === 0, String(stage.qaCutoffResumesThisRound));
      check("the lifetime tally still counted all three continuations", stage.qaCutoffResumes === 3, String(stage.qaCutoffResumes));
      check("no continuation was charged as a QA round", stage.qaRoundsUsed === 3, String(stage.qaRoundsUsed));
    } finally {
      h.dispose();
    }
  }

  // -- Test O: ...and a renewed allowance is still an allowance --------------------------------------
  // Loosening a budget is the dangerous direction, so pin the other half: a LATER round that keeps
  // wedging must stop after its own MAX_QA_CUTOFF_RESUMES, exactly as the first round does in Test I.
  console.log("\nTest O — a later round that keeps hitting the ceiling is bounded too");
  {
    const h = makeHarness();
    try {
      const id = seedTask(h);
      const qaCalls = stubQaRunRole(h, [
        verdictResult({ pass: true, summary: "round 1 fixed something", changed: true }),
        CUTOFF,
        CUTOFF,
        CUTOFF,
        CUTOFF,
      ]);
      await runLoop(h, id, 4, true);
      check("round 2 stopped after its own bounded continuations", qaCalls.length === 4, `calls=${qaCalls.length}`);
      check("its allowance reads as fully spent", h.db.getThreadStageOutputs(id).qaCutoffResumesThisRound === 2, String(h.db.getThreadStageOutputs(id).qaCutoffResumesThisRound));
      check("the wedged reviewer parked for the owner", h.db.getThread(id)?.state === "review", `state=${h.db.getThread(id)?.state}`);
      check("the park still says the continuations were spent", !!h.db.getThread(id)?.error?.includes("cut off again each time"), String(h.db.getThread(id)?.error));
    } finally {
      h.dispose();
    }
  }

  // -- Test P: the empty-run allowance belongs to the REVIEW too -------------------------------------
  // The same defect as Test N, in the other recovery budget, and it shipped a month longer: `7d776461`
  // spent its one silent retry on a round-3 continuation that came back empty, that retry WORKED, and the
  // round two verdicts later was refused its own first retry and parked — over a recovery that succeeded.
  console.log("\nTest P — a round that recovered from an empty run doesn't spend a later round's retry");
  {
    const h = makeHarness();
    try {
      const id = seedTask(h);
      const qaCalls = stubQaRunRole(h, [
        SILENT,
        verdictResult({ pass: true, summary: "round 1 fixed something", changed: true }),
        SILENT,
        verdictResult({ pass: true, summary: "nothing left to change", changed: false }),
      ]);
      await runLoop(h, id, 4, true);
      check("both rounds got their own fresh retry", qaCalls.length === 4, `calls=${qaCalls.length}`);
      check("round 2's retry started a FRESH session", qaCalls[3]?.resume === undefined, String(qaCalls[3]?.resume));
      check("the task reached a verdict instead of the owner's queue", h.db.getThread(id)?.state === "done", `state=${h.db.getThread(id)?.state}`);
      const stage = h.db.getThreadStageOutputs(id);
      check("the accepting verdict left a full allowance behind", (stage.qaSilentRetriesThisRound ?? 0) === 0, String(stage.qaSilentRetriesThisRound));
      check("the lifetime tally still counted both retries", stage.qaSilentRetries === 2, String(stage.qaSilentRetries));
      check("no retry was charged as a QA round", stage.qaRoundsUsed === 2, String(stage.qaRoundsUsed));
    } finally {
      h.dispose();
    }
  }

  // -- Test Q: ...and a renewed empty-run allowance is still an allowance ----------------------------
  // Loosening a budget is the dangerous direction, so pin the other half exactly as Test O does for the
  // continuations: a LATER round that keeps coming back empty must still stop after its own single retry.
  console.log("\nTest Q — a later round that keeps coming back empty is bounded too");
  {
    const h = makeHarness();
    try {
      const id = seedTask(h);
      const qaCalls = stubQaRunRole(h, [
        verdictResult({ pass: true, summary: "round 1 fixed something", changed: true }),
        SILENT,
        SILENT,
        SILENT,
      ]);
      await runLoop(h, id, 4, true);
      check("round 2 stopped after its own single retry", qaCalls.length === 3, `calls=${qaCalls.length}`);
      check("its allowance reads as fully spent", h.db.getThreadStageOutputs(id).qaSilentRetriesThisRound === 1, String(h.db.getThreadStageOutputs(id).qaSilentRetriesThisRound));
      check("the wedged reviewer parked for the owner", h.db.getThread(id)?.state === "review", `state=${h.db.getThread(id)?.state}`);
      check("the park still says the fresh retry was already tried", !!h.db.getThread(id)?.error?.includes("restarted on a fresh session"), String(h.db.getThread(id)?.error));
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
