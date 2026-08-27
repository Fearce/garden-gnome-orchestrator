/**
 * Integration test — TIMED and SHOTGUN task modes against the real ThreadManager.
 *
 * WHAT IS REAL vs. STUBBED
 *  - REAL: the `Db` (a temp file — so every persistence claim is checked through the actual schema,
 *    mapper and migration), `EventHub`, `enqueueOrRun`/`pumpQueue`/the concurrency gate, the whole
 *    `runTimedWindow` loop with its durable counters, `prepareShotgun`'s validate→spawn→persist path,
 *    the collaborator barrier, and `collaboratorOwnershipBlock`'s rebuild-from-disk.
 *  - STUBBED: only the agent-spawning leaves — `startResumedImplementor`, `awaitImplementorCompletion`,
 *    `stopLive`, `startPipeline` and `runShotgunDecomposition`. No `claude` subprocess, no quota, ~1s.
 *
 * Stubbing at that depth is the point: it leaves every DECISION under test (extend vs. finalize, split
 * vs. degrade, wait vs. integrate) executing for real, and replaces only the thing that would cost money.
 *
 * Run:  npm run test:task-modes   (from server/)
 */

process.env.CAP_RETRY_MS = "0"; // no cap-supervisor interval during the test
process.env.ACCOUNT_PING_MS = "3600000";
process.env.FAST_ACCOUNT_PING_MS = "3600000";
process.env.SHOTGUN_BARRIER_POLL_MS = "20"; // the barrier polls durable state; keep the test fast
process.env.TIMED_MIN_SLICE_MS = "60000";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountManager } from "../accounts/accountManager.js";
import type { ResultEvent } from "../agents/runner.js";
import type { ShotgunPlan } from "../orchestrator/shotgun.js";
import type { Thread } from "../types.js";

const { Db } = await import("../db/db.js");
const { EventHub } = await import("../events.js");
const { FileMemoryService } = await import("../memory/memory.js");
const { ThreadManager } = await import("../orchestrator/threadManager.js");
const { TIMED_COMPLETE_MARKER } = await import("../orchestrator/timedTasks.js");

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
  auxToken(): string | undefined {
    return undefined;
  }
}

const OK: ResultEvent = { type: "result", subtype: "success", isError: false };
const ERR: ResultEvent = { type: "result", subtype: "error_during_execution", isError: true, result: "boom" };
const HOUR = 3_600_000;
const REPO = process.cwd(); // an existing directory — runPipeline refuses one that isn't on disk

interface Harness {
  mgr: InstanceType<typeof ThreadManager>;
  db: InstanceType<typeof Db>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  internals: any;
  rounds: string[]; // the nudge each stubbed implementor relaunch received, in order
  started: string[]; // thread ids handed to the stubbed startPipeline
  dispose(): void;
}

/** A ThreadManager whose agent-spawning leaves are stubbed but whose decision logic is entirely real. */
function makeHarness(opts: { roundResult?: () => ResultEvent; onRound?: (n: number) => void } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "taskmodes-"));
  const db = new Db(join(dir, "orchestrator.sqlite"));
  const hub = new EventHub();
  const memory = new FileMemoryService(join(dir, "memory"));
  const mgr = new ThreadManager(db, hub, memory, new StubAccounts() as unknown as AccountManager);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = mgr as any;

  const rounds: string[] = [];
  const started: string[] = [];
  internals.stopLive = async (): Promise<void> => {};
  internals.startResumedImplementor = async (): Promise<{ run: unknown; accountId: string }> => ({ run: { send() {} }, accountId: "acct1" });
  internals.flushDirectorNotes = (): void => {};
  internals.awaitImplementorCompletion = async (_t: Thread, _e: unknown, _k: string, _r: unknown, _a: string, _u: boolean, msg: string): Promise<ResultEvent> => {
    rounds.push(msg);
    opts.onRound?.(rounds.length);
    return opts.roundResult ? opts.roundResult() : OK;
  };
  internals.drainQueuedImplementor = async (_t: Thread, _e: unknown, _k: string, res: ResultEvent | undefined): Promise<ResultEvent | undefined> => res;
  internals.startPipeline = (id: string): void => {
    started.push(id);
    internals.activePipelines.add(id);
    internals.activePipelineToken.set(id, Symbol("test-slot"));
  };

  return {
    mgr,
    db,
    internals,
    rounds,
    started,
    dispose() {
      if (internals.capSupervisor) clearInterval(internals.capSupervisor);
      if (internals.tokenResumeTimer) clearTimeout(internals.tokenResumeTimer);
      if (internals.capResumeWake) clearTimeout(internals.capResumeWake);
      db.raw.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function main(): Promise<void> {
  console.log("\n=== task modes — timed windows + shotgun collaborators (real ThreadManager) ===\n");

  // ============ A. PERSISTENCE ====================================================================
  console.log("A — persistence: the window and the split survive the real schema + mapper");
  {
    const h = makeHarness();
    try {
      const before = Date.now();
      const id = await h.mgr.dispatch({ title: "timed", workspace: REPO, brief: "do it", durationMs: 8 * HOUR });
      const t = h.db.getThread(id)!;
      check("durationMs persists", t.durationMs === 8 * HOUR, String(t.durationMs));
      check("deadlineAt is stamped ABSOLUTE at dispatch", t.deadlineAt != null && t.deadlineAt >= before + 8 * HOUR && t.deadlineAt <= Date.now() + 8 * HOUR, String(t.deadlineAt));

      const plain = await h.mgr.dispatch({ title: "plain", workspace: REPO, brief: "do it" });
      const p = h.db.getThread(plain)!;
      check("an ordinary task carries NO window (full backward compatibility)", p.durationMs === null && p.deadlineAt === null);
      check("an ordinary task carries no agent count", p.agentCount === null);
      check("an ordinary task is not a collaborator", p.parentId === null && p.assignment === null);

      const shot = await h.mgr.dispatch({ title: "shot", workspace: REPO, brief: "do it", agentCount: 3 });
      check("agentCount persists", h.db.getThread(shot)!.agentCount === 3);

      const kid = await h.mgr.dispatch({
        title: "share",
        workspace: REPO,
        brief: "one share",
        parentId: shot,
        assignment: { title: "api", objective: "build the api", files: ["src/api", "src/db"] },
      });
      const k = h.db.getThread(kid)!;
      check("a collaborator's parentId persists", k.parentId === shot);
      check("its assignment round-trips through the JSON column", k.assignment?.files.join(",") === "src/api,src/db", JSON.stringify(k.assignment));
      check("listCollaborators finds it from the lead", h.db.listCollaborators(shot).map((x) => x.id).join() === kid);
      check("a zero duration is stored as no window, not as an instant deadline", h.db.getThread(await h.mgr.dispatch({ title: "z", workspace: REPO, brief: "b", durationMs: 0 }))!.deadlineAt === null);
    } finally {
      h.dispose();
    }
  }

  console.log("\nA2 — the composer settings round-trip (the 'off' values must survive)");
  {
    const h = makeHarness();
    try {
      check("a fresh manager defaults to off", h.mgr.settings().taskDurationMinutes === 0 && h.mgr.settings().taskAgentCount === 1);
      h.mgr.setSettings({ taskDurationMinutes: 480, taskAgentCount: 3 });
      check("a window pick persists", h.mgr.settings().taskDurationMinutes === 480, String(h.mgr.settings().taskDurationMinutes));
      check("an agent pick persists", h.mgr.settings().taskAgentCount === 3, String(h.mgr.settings().taskAgentCount));
      // The bug this pins: clampAgentCount clamps into the SHOTGUN range [2..6], but the SETTING's
      // domain includes 1 = off. Clamping the setting turned "off" into "2 agents", so clearing the
      // composer silently left every later task a two-agent shotgun the owner never asked for.
      h.mgr.setSettings({ taskDurationMinutes: 0, taskAgentCount: 1 });
      check("clearing the agent count really means ONE agent, not the shotgun minimum", h.mgr.settings().taskAgentCount === 1, String(h.mgr.settings().taskAgentCount));
      check("clearing the window really means no window", h.mgr.settings().taskDurationMinutes === 0, String(h.mgr.settings().taskDurationMinutes));
      // ...while a genuine out-of-range value is still clamped into the shotgun range.
      h.mgr.setSettings({ taskAgentCount: 99 });
      check("an over-range agent count is clamped to the maximum", h.mgr.settings().taskAgentCount === 6, String(h.mgr.settings().taskAgentCount));
      h.mgr.setSettings({ taskDurationMinutes: 999_999 });
      check("an over-range window is clamped", h.mgr.settings().taskDurationMinutes === 7 * 24 * 60, String(h.mgr.settings().taskDurationMinutes));
    } finally {
      h.dispose();
    }
  }

  // ============ B. THE TIMED WINDOW ================================================================
  console.log("\nB — the timed window: extend while there is time, then close");
  {
    const h = makeHarness();
    try {
      const id = await h.mgr.dispatch({ title: "timed", workspace: REPO, brief: "work", durationMs: 2 * HOUR });
      const thread = h.db.getThread(id)!;
      // Two rounds' worth of time, then the deadline is moved into the past to close the window.
      let n = 0;
      h.internals.awaitImplementorCompletion = async (_t: Thread, _e: unknown, _k: string, _r: unknown, _a: string, _u: boolean, msg: string) => {
        h.rounds.push(msg);
        if (++n === 2) h.db.setTimedWindow(id, 2 * HOUR, Date.now() - 1000); // the window runs out mid-run
        return OK;
      };
      const res = await h.internals.runTimedWindow(h.db.getThread(id)!, "high", "kickoff", OK, true);
      check("the window ran extension rounds while time remained", h.rounds.length === 2, `${h.rounds.length} rounds`);
      check("each round carried the continuation directive", h.rounds.every((r) => r.includes("work window is still open")), h.rounds[0]?.slice(0, 60));
      check("the round directive states the remaining time", /\d+[hm]/.test(h.rounds[0] ?? ""), h.rounds[0]?.slice(0, 80));
      check("the result flows through untouched", res === OK);
      const st = h.db.getThreadStageOutputs(id);
      check("the extension count is DURABLE", st.timedExtensions === 2, String(st.timedExtensions));
      check("the window is marked finalized", st.timedFinalizing === true);
      const findings = h.db.listFindings(id);
      check("a closing finding explains why the window ended", findings.some((f) => f.summary.includes("Work window closed")), findings.map((f) => f.summary).join(" | "));
      check("the task was never silently abandoned — the reason names the deadline", findings.some((f) => (f.detail ?? "").includes("window has ended")), findings.map((f) => f.detail).join(" | "));
      void thread;
    } finally {
      h.dispose();
    }
  }

  console.log("\nB2 — a closed window is not re-opened by a later re-entry (the restart case)");
  {
    const h = makeHarness();
    try {
      const id = await h.mgr.dispatch({ title: "timed", workspace: REPO, brief: "work", durationMs: 8 * HOUR });
      h.db.updateThreadStageOutputs(id, { timedFinalizing: true, timedExtensions: 5 });
      // A restart re-enters the pipeline on a task with hours left on the clock. Without the durable
      // marker it would happily start a sixth round on work that was already handed to review.
      const res = await h.internals.runTimedWindow(h.db.getThread(id)!, "high", "kickoff", OK, true);
      check("a finalized window runs NO further rounds even with hours left", h.rounds.length === 0, `${h.rounds.length} rounds`);
      check("the result passes through", res === OK);
      check("the extension count is untouched", h.db.getThreadStageOutputs(id).timedExtensions === 5);
    } finally {
      h.dispose();
    }
  }

  console.log("\nB3 — an ordinary task never enters the window loop");
  {
    const h = makeHarness();
    try {
      const id = await h.mgr.dispatch({ title: "plain", workspace: REPO, brief: "work" });
      const res = await h.internals.runTimedWindow(h.db.getThread(id)!, "high", "kickoff", OK, true);
      check("no rounds for a task with no window", h.rounds.length === 0);
      check("no timed bookkeeping is written", h.db.getThreadStageOutputs(id).timedExtensions === undefined);
      check("the result passes straight through", res === OK);
    } finally {
      h.dispose();
    }
  }

  console.log("\nB4 — the budget, the failure exit, and the early finish");
  {
    // The extension budget is enforced from the DURABLE count, so a restart cannot refill it.
    const h = makeHarness();
    try {
      const id = await h.mgr.dispatch({ title: "timed", workspace: REPO, brief: "work", durationMs: 8 * HOUR });
      h.db.updateThreadStageOutputs(id, { timedExtensions: 40 }); // config default ceiling
      await h.internals.runTimedWindow(h.db.getThread(id)!, "high", "kickoff", OK, true);
      check("a spent extension budget closes the window immediately", h.rounds.length === 0, `${h.rounds.length} rounds`);
      check("...and says the limit was the reason", h.db.listFindings(id).some((f) => (f.detail ?? "").includes("safety limit")), h.db.listFindings(id).map((f) => f.detail).join(" | "));
    } finally {
      h.dispose();
    }
  }
  {
    // A round that ends in error ends the window — piling rounds onto a failing task just reproduces
    // the failure for the rest of the window.
    const h = makeHarness({ roundResult: () => ERR });
    try {
      const id = await h.mgr.dispatch({ title: "timed", workspace: REPO, brief: "work", durationMs: 8 * HOUR });
      const res = await h.internals.runTimedWindow(h.db.getThread(id)!, "high", "kickoff", OK, true);
      check("a failed round stops the window after that round", h.rounds.length === 1, `${h.rounds.length} rounds`);
      check("the error is handed back for the normal park path", res === ERR);
      check("the window is closed so a resume can't loop on it", h.db.getThreadStageOutputs(id).timedFinalizing === true);
    } finally {
      h.dispose();
    }
  }
  {
    // The implementor declaring the objective complete beats the clock: a window is a budget, not a quota.
    const h = makeHarness();
    try {
      const id = await h.mgr.dispatch({ title: "timed", workspace: REPO, brief: "work", durationMs: 8 * HOUR });
      h.internals.awaitImplementorCompletion = async (_t: Thread, _e: unknown, _k: string, _r: unknown, _a: string, _u: boolean, msg: string) => {
        h.rounds.push(msg);
        h.db.addMessage({ threadId: id, role: "implementor", kind: "text", content: `all built and tested.\n${TIMED_COMPLETE_MARKER}: nothing left that isn't padding` });
        return OK;
      };
      await h.internals.runTimedWindow(h.db.getThread(id)!, "high", "kickoff", OK, true);
      check("an early completion stops the window after that round", h.rounds.length === 1, `${h.rounds.length} rounds`);
      check("the early finish is recorded durably", h.db.getThreadStageOutputs(id).timedCompleteEarly === true);
      check("...and reported as a finish, not a timeout", h.db.listFindings(id).some((f) => (f.detail ?? "").includes("fully complete")), h.db.listFindings(id).map((f) => f.detail).join(" | "));
    } finally {
      h.dispose();
    }
  }
  {
    // The runaway guard: rounds that return instantly having written nothing must not spend the window.
    const h = makeHarness();
    try {
      const id = await h.mgr.dispatch({ title: "timed", workspace: REPO, brief: "work", durationMs: 8 * HOUR });
      await h.internals.runTimedWindow(h.db.getThread(id)!, "high", "kickoff", OK, true);
      check("three hollow rounds close the window (the runaway guard)", h.rounds.length === 3, `${h.rounds.length} rounds`);
      check("the hollow counter is durable", h.db.getThreadStageOutputs(id).timedHollowRounds === 3, String(h.db.getThreadStageOutputs(id).timedHollowRounds));
      check("...and the close says nothing was progressing", h.db.listFindings(id).some((f) => (f.detail ?? "").includes("without making progress")), h.db.listFindings(id).map((f) => f.detail).join(" | "));
    } finally {
      h.dispose();
    }
  }
  {
    // ...and a round that DOES produce work resets that counter, so a slow-but-real task isn't cut off.
    const h = makeHarness();
    try {
      const id = await h.mgr.dispatch({ title: "timed", workspace: REPO, brief: "work", durationMs: 8 * HOUR });
      let n = 0;
      h.internals.awaitImplementorCompletion = async (_t: Thread, _e: unknown, _k: string, _r: unknown, _a: string, _u: boolean, msg: string) => {
        h.rounds.push(msg);
        n++;
        // Every round writes a message (real work), except we stop the test at 5 by closing the window.
        h.db.addMessage({ threadId: id, role: "implementor", kind: "text", content: `round ${n} did real work` });
        if (n === 5) h.db.setTimedWindow(id, 8 * HOUR, Date.now() - 1000);
        return OK;
      };
      await h.internals.runTimedWindow(h.db.getThread(id)!, "high", "kickoff", OK, true);
      check("productive rounds keep the window open past the hollow limit", h.rounds.length === 5, `${h.rounds.length} rounds`);
      check("the hollow counter stayed at zero", h.db.getThreadStageOutputs(id).timedHollowRounds === 0, String(h.db.getThreadStageOutputs(id).timedHollowRounds));
    } finally {
      h.dispose();
    }
  }

  // ============ C. SHOTGUN =========================================================================
  console.log("\nC — shotgun: a valid split spawns collaborators with disjoint ownership");
  {
    const h = makeHarness();
    try {
      const id = await h.mgr.dispatch({ title: "big", workspace: REPO, brief: "build two things", agentCount: 3 });
      const plan: ShotgunPlan = {
        parallelizable: true,
        reason: "three independent areas",
        assignments: [
          { title: "api", objective: "build the api", files: ["src/api"] },
          { title: "web", objective: "build the web", files: ["src/web"] },
          { title: "docs", objective: "write the docs", files: ["docs"] },
        ],
      };
      h.internals.runShotgunDecomposition = async (): Promise<ShotgunPlan> => plan;
      const kickoff = await h.internals.prepareShotgun(h.db.getThread(id)!, undefined, "BASE KICKOFF");

      const kids = h.db.listCollaborators(id);
      check("N-1 collaborators are spawned (the lead takes the first share)", kids.length === 2, `${kids.length}`);
      check("each collaborator owns exactly its own share", kids.map((k) => k.assignment?.files.join()).join("|") === "src/web|docs", kids.map((k) => k.assignment?.files.join()).join("|"));
      check("each points at the lead", kids.every((k) => k.parentId === id));
      check("each carries the shared goal in its brief", kids.every((k) => k.brief.includes("build two things")));
      check("the collaborator ids are persisted for the barrier", (h.db.getThreadStageOutputs(id).shotgunChildren ?? []).length === 2);
      check("the lead's own share is persisted", h.db.getThreadStageOutputs(id).shotgunAssignment?.title === "api");
      check("the split is marked planned (sticky)", h.db.getThreadStageOutputs(id).shotgunPlanned === true);
      check("the lead's kickoff keeps the original brief", kickoff.includes("BASE KICKOFF"));
      check("...and gains its own share", kickoff.includes("build the api"));
      check("...and the ownership contract naming the peers' files", kickoff.includes("src/web") && kickoff.includes("docs"));
      check("a finding reports the split", h.db.listFindings(id).some((f) => f.summary.includes("Split across 3 agents")), h.db.listFindings(id).map((f) => f.summary).join(" | "));

      // Sticky: a resume must not re-decompose and spawn a SECOND set of agents onto the same tree.
      h.internals.runShotgunDecomposition = async (): Promise<ShotgunPlan> => plan;
      const again = await h.internals.prepareShotgun(h.db.getThread(id)!, undefined, "BASE KICKOFF");
      check("a re-entry does NOT spawn a second set of collaborators", h.db.listCollaborators(id).length === 2, String(h.db.listCollaborators(id).length));
      check("...and returns the kickoff unchanged", again === "BASE KICKOFF");
    } finally {
      h.dispose();
    }
  }

  console.log("\nC2 — an unsafe or declined split degrades to one agent, and says why");
  {
    for (const [label, plan, expect] of [
      ["overlapping files", { parallelizable: true, reason: "ok", assignments: [{ title: "a", objective: "x", files: ["src/api"] }, { title: "b", objective: "y", files: ["src/api/routes.ts"] }] }, "overwrite each other"],
      ["planner declined", { parallelizable: false, reason: "the work is strictly sequential", assignments: [] }, "strictly sequential"],
      ["only one share", { parallelizable: true, reason: "ok", assignments: [{ title: "a", objective: "x", files: ["src"] }] }, "nothing to parallelize"],
    ] as const) {
      const h = makeHarness();
      try {
        const id = await h.mgr.dispatch({ title: "big", workspace: REPO, brief: "b", agentCount: 2 });
        h.internals.runShotgunDecomposition = async (): Promise<ShotgunPlan> => plan as unknown as ShotgunPlan;
        const kickoff = await h.internals.prepareShotgun(h.db.getThread(id)!, undefined, "BASE");
        check(`${label} ⇒ no collaborators spawned`, h.db.listCollaborators(id).length === 0);
        check(`${label} ⇒ the kickoff is unchanged (an ordinary task)`, kickoff === "BASE");
        check(`${label} ⇒ the degrade reason is recorded`, (h.db.getThreadStageOutputs(id).shotgunDegraded ?? "").length > 0);
        check(`${label} ⇒ the owner is told, with the reason`, h.db.listFindings(id).some((f) => (f.detail ?? "").includes(expect)), h.db.listFindings(id).map((f) => f.detail).join(" | "));
        check(`${label} ⇒ marked planned so it isn't retried every resume`, h.db.getThreadStageOutputs(id).shotgunPlanned === true);
      } finally {
        h.dispose();
      }
    }
  }
  {
    // A decomposition that produced nothing at all (an errored/empty structured run) must degrade, not
    // split on a guess.
    const h = makeHarness();
    try {
      const id = await h.mgr.dispatch({ title: "big", workspace: REPO, brief: "b", agentCount: 2 });
      h.internals.runShotgunDecomposition = async (): Promise<ShotgunPlan | undefined> => undefined;
      await h.internals.prepareShotgun(h.db.getThread(id)!, undefined, "BASE");
      check("an absent decomposition verdict degrades rather than splitting", h.db.listCollaborators(id).length === 0);
      check("...and is recorded as a degrade", (h.db.getThreadStageOutputs(id).shotgunDegraded ?? "").includes("no usable answer"), h.db.getThreadStageOutputs(id).shotgunDegraded ?? "");
    } finally {
      h.dispose();
    }
  }
  {
    // A COLLABORATOR must never split again — that would fork the tree recursively.
    const h = makeHarness();
    try {
      const lead = await h.mgr.dispatch({ title: "lead", workspace: REPO, brief: "b", agentCount: 3 });
      const kid = await h.mgr.dispatch({ title: "share", workspace: REPO, brief: "s", parentId: lead, agentCount: 3, assignment: { title: "api", objective: "x", files: ["src/api"] } });
      let called = false;
      h.internals.runShotgunDecomposition = async (): Promise<ShotgunPlan> => {
        called = true;
        return { parallelizable: true, reason: "r", assignments: [] };
      };
      const kickoff = await h.internals.prepareShotgun(h.db.getThread(kid)!, undefined, "BASE");
      check("a collaborator never runs the decomposition at all", !called);
      check("...and its kickoff is untouched", kickoff === "BASE");
    } finally {
      h.dispose();
    }
  }

  console.log("\nC3 — the barrier waits for every share, then integrates once");
  {
    const h = makeHarness();
    try {
      const id = await h.mgr.dispatch({ title: "lead", workspace: REPO, brief: "b", agentCount: 3 });
      const k1 = await h.mgr.dispatch({ title: "api", workspace: REPO, brief: "s", parentId: id, assignment: { title: "api", objective: "x", files: ["src/api"] } });
      const k2 = await h.mgr.dispatch({ title: "web", workspace: REPO, brief: "s", parentId: id, assignment: { title: "web", objective: "y", files: ["src/web"] } });
      h.db.updateThreadStageOutputs(id, { shotgunChildren: [k1, k2] });
      h.db.updateThread(k1, { state: "implementing" });
      h.db.updateThread(k2, { state: "implementing" });

      const settle = (async () => {
        await new Promise((r) => setTimeout(r, 60));
        h.db.updateThread(k1, { state: "done" });
        await new Promise((r) => setTimeout(r, 60));
        h.db.updateThread(k2, { state: "review", error: "needs a human" });
      })();

      const res = await h.internals.integrateShotgun(h.db.getThread(id)!, "high", "kickoff", OK, true);
      await settle;
      check("the barrier waited for both shares before integrating", h.rounds.length === 1, `${h.rounds.length} integration rounds`);
      check("the integration brief lists both shares", (h.rounds[0] ?? "").includes("api") && (h.rounds[0] ?? "").includes("web"));
      check("...and flags the one that stopped for a human", (h.rounds[0] ?? "").includes("STOPPED"), (h.rounds[0] ?? "").slice(0, 200));
      check("...carrying that share's own error", (h.rounds[0] ?? "").includes("needs a human"));
      check("integration is marked done (sticky against a restart)", h.db.getThreadStageOutputs(id).shotgunIntegrated === true);
      check("the result flows on to QA", res === OK);

      // A second entry (a restart landing after integration) must not integrate twice.
      const again = await h.internals.integrateShotgun(h.db.getThread(id)!, "high", "kickoff", OK, true);
      check("a re-entry does NOT run a second integration pass", h.rounds.length === 1, `${h.rounds.length}`);
      check("...and passes the result through", again === OK);
    } finally {
      h.dispose();
    }
  }
  {
    // A lead whose own run failed must NOT launch an integration round it cannot resume — but the owner
    // has to be told the combined tree was never reconciled, which is the dangerous state.
    const h = makeHarness();
    try {
      const id = await h.mgr.dispatch({ title: "lead", workspace: REPO, brief: "b", agentCount: 2 });
      const k1 = await h.mgr.dispatch({ title: "api", workspace: REPO, brief: "s", parentId: id, assignment: { title: "api", objective: "x", files: ["src/api"] } });
      h.db.updateThreadStageOutputs(id, { shotgunChildren: [k1] });
      h.db.updateThread(k1, { state: "done" });
      const res = await h.internals.integrateShotgun(h.db.getThread(id)!, "high", "kickoff", ERR, true);
      check("no integration round is launched from a failed lead", h.rounds.length === 0);
      check("the error passes through to the normal park path", res === ERR);
      check(
        "the owner is warned the tree was NOT reconciled",
        h.db.listFindings(id).some((f) => f.summary.includes("Integration skipped") && f.severity === "warning"),
        h.db.listFindings(id).map((f) => f.summary).join(" | "),
      );
    } finally {
      h.dispose();
    }
  }
  {
    // An ordinary task must never touch the barrier.
    const h = makeHarness();
    try {
      const id = await h.mgr.dispatch({ title: "plain", workspace: REPO, brief: "b" });
      const res = await h.internals.integrateShotgun(h.db.getThread(id)!, "high", "kickoff", OK, true);
      check("an ordinary task runs no integration pass", h.rounds.length === 0);
      check("...and is untouched", res === OK && h.db.getThreadStageOutputs(id).shotgunIntegrated === undefined);
    } finally {
      h.dispose();
    }
  }

  // ============ D. CONCURRENCY — the deadlock this design has to avoid =============================
  console.log("\nD — collaborators bypass the concurrency caps (else the lead deadlocks on them)");
  {
    const h = makeHarness();
    try {
      h.mgr.setSettings({ maxConcurrent: 1, maxConcurrentPerRepo: 1 });
      const lead = await h.mgr.dispatch({ title: "lead", workspace: REPO, brief: "b", agentCount: 3 });
      check("the lead starts and takes the only slot", h.started.includes(lead), h.started.join());
      const kid = await h.mgr.dispatch({ title: "share", workspace: REPO, brief: "s", parentId: lead, assignment: { title: "api", objective: "x", files: ["src/api"] } });
      // Without the exemption this child sits in 'queued' behind a cap its own parent occupies, and the
      // parent then blocks at the barrier waiting for it: a guaranteed deadlock at maxConcurrent=1.
      check("the collaborator starts anyway rather than queueing behind its own parent", h.started.includes(kid), h.started.join());
      check("...and is NOT parked in 'queued'", h.db.getThread(kid)!.state !== "queued", h.db.getThread(kid)!.state);

      // An unrelated task still respects the cap — the exemption is scoped to collaborators only.
      const other = await h.mgr.dispatch({ title: "other", workspace: REPO, brief: "b" });
      check("an UNRELATED task still obeys the cap", h.db.getThread(other)!.state === "queued", h.db.getThread(other)!.state);
    } finally {
      h.dispose();
    }
  }

  // ============ E. OWNERSHIP SURVIVES A RESTART ====================================================
  console.log("\nE — the ownership contract is rebuilt from disk, not held in memory");
  {
    const h = makeHarness();
    try {
      const lead = await h.mgr.dispatch({ title: "lead", workspace: REPO, brief: "b", agentCount: 3 });
      h.db.updateThreadStageOutputs(lead, { shotgunAssignment: { title: "api", objective: "x", files: ["src/api"] } });
      const k1 = await h.mgr.dispatch({ title: "web", workspace: REPO, brief: "s", parentId: lead, assignment: { title: "web", objective: "y", files: ["src/web"] } });
      const k2 = await h.mgr.dispatch({ title: "docs", workspace: REPO, brief: "s", parentId: lead, assignment: { title: "docs", objective: "z", files: ["docs"] } });
      // Simulate the restart: nothing in the in-memory spawn map, only what is on disk.
      h.internals.shotgunOwnership.clear();
      const block = h.internals.collaboratorOwnershipBlock(h.db.getThread(k1)!) as string;
      check("a revived collaborator still knows its OWN files", block.includes("src/web"));
      check("...and its sibling's", block.includes("docs"));
      check("...and the LEAD's share, which is owned too", block.includes("src/api"), block.slice(0, 400));
      check("...and still carries the do-not-edit-outside rule", block.toLowerCase().includes("only inside your share"));
      check("a non-collaborator gets no block at all", h.internals.collaboratorOwnershipBlock(h.db.getThread(lead)!) === undefined);
      void k2;
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
