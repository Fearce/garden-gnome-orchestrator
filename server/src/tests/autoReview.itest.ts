/**
 * Integration test — the "Auto-review & mark done" lane (real ThreadManager machinery).
 *
 * The button hands the owner's OWN final review of a parked task to one agent, which either accepts it
 * (the task settles 'done', exactly as if they'd clicked Mark done) or hands it back. That makes two things
 * load-bearing and worth guarding: the verdict must be the ONLY route to 'done' — an errored or
 * verdict-less run must never be read as an acceptance — and only one agent may ever hold the slot.
 *
 * A hand-back is NOT the end of the lane: the reviewer is read-only, so what blocks a task is routinely
 * work an implementor could finish in a minute, and each hand-back with concrete issues buys a bounded
 * implementor fix round plus a re-review (`maxReviewFixRounds`). Tests K–P cover that loop — including
 * that a fix round can never itself become a route to 'done'.
 *
 * WHAT IS REAL vs. STUBBED
 *  - REAL: `autoReview` (its guards, the slot accounting, the state transitions), `runAutoReview`,
 *    `runReviewFixRound`, `reviewRecheck`, `finalizeReview`, the resume/inject gates, `markInterrupted`,
 *    and the real `Db` + `EventHub`.
 *  - STUBBED: `runRole` — the leaf that would spawn a real `claude` process. The test drives it to
 *    return whatever the reviewer "decided" (or to fail), and can hold it open to assert what the rest of
 *    the manager does WHILE a review is live. Plus the implementor's two leaves
 *    (`startResumedImplementor` / `awaitImplementorCompletion`), which the fix round drives.
 *
 * Run:  npm run test:auto-review   (from server/)   — or:  npx tsx src/tests/autoReview.itest.ts
 * Exits non-zero if any assertion fails. Self-contained: creates a throwaway DB + workspace and removes them.
 */

process.env.CAP_RETRY_MS = "0"; // no cap-supervisor interval during the test
process.env.ACCOUNT_PING_MS = "3600000";
process.env.FAST_ACCOUNT_PING_MS = "3600000";

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountManager } from "../accounts/accountManager.js";
import type { ImplementorProvider, ReviewerOutput } from "../types.js";

const { Db } = await import("../db/db.js");
const { EventHub } = await import("../events.js");
const { FileMemoryService } = await import("../memory/memory.js");
const { ThreadManager } = await import("../orchestrator/threadManager.js");
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
  // The fix round runs the REAL routing gate (gateImplementorProvider), which asks the account manager
  // which Claude sub it would dispatch to. Without this the gate throws and the round never starts.
  dispatchPreview(): Record<string, unknown> {
    return { account: { id: "acct-a", label: "acct-a" }, hasHeadroom: true, fiveHour: 0, sevenDay: 0, fiveHourReset: null, sevenDayReset: null, weeklySafetyPct: 100 };
  }
  auxToken(): string | undefined {
    return undefined;
  }
  setPingInterval(_ms: number): void {}
  applyEnabled(_id: string, _enabled: boolean): void {}
  applyWeeklySafetyPct(_id: string, _pct: number): void {}
  setSpreadUsage(_on: boolean): void {}
}

/** What the stubbed `runRole` hands back. Deliberately the SHAPE production sees — a real SDK result
 *  always carries `type`/`subtype`/`isError`, so a stub that omitted them would let the code pass here on
 *  a state it never meets (and hide, for instance, how an errored run's reason is rendered). */
type RunOutcome = { type: "result"; subtype: string; isError: boolean; structuredOutput?: ReviewerOutput } | undefined;

const okResult = (structuredOutput: ReviewerOutput): RunOutcome => ({ type: "result", subtype: "success", isError: false, structuredOutput });

/** How the stubbed implementor of a fix round ends. The real `awaitImplementorCompletion` hands back an
 *  SDK result, so the stub does too — an errored one must never read as a completed fix. */
const FIX_OK = { type: "result", subtype: "success", isError: false } as RunOutcome;
const FIX_FAILED = { type: "result", subtype: "error_during_execution", isError: true } as RunOutcome;

interface Harness {
  mgr: InstanceType<typeof ThreadManager>;
  db: InstanceType<typeof Db>;
  dir: string;
  workspace: string;
  roleCalls: string[]; // every role runRole was asked to run, in order
  kickoffs: string[]; // the kickoff text each run was given
  implementorStarts: () => number;
  fixMessages: string[]; // what each fix round's implementor was relaunched with
  resumeSessions: (string | undefined)[]; // the implementor session each fix round was asked to resume
  capNextFix(): void; // make the next fix round end the way a usage cap does
  setOutcome(o: RunOutcome): void;
  setFixOutcome(o: RunOutcome): void;
  /** Hold the next run open; the returned function releases it with the given outcome. */
  holdNextRun(): () => void;
  /** Hold the next fix round's implementor open, to assert what the task looks like mid-fix. */
  holdNextFix(): () => void;
  /** Hold the fix round in the window AFTER its implementor ended (live handle gone) but BEFORE the
   *  round flips the state back — the one production reaches via the run's own onEnd racing the result. */
  holdAfterFixEnded(): () => void;
  activePipelines(): number;
  dispose(): void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "auto-review-"));
  const workspace = join(dir, "workspace");
  mkdirSync(workspace, { recursive: true });
  const db = new Db(join(dir, "orchestrator.sqlite"));
  const hub = new EventHub();
  const memory = new FileMemoryService(join(dir, "memory"));
  const mgr = new ThreadManager(db, hub, memory, new StubAccounts() as unknown as AccountManager);

  const roleCalls: string[] = [];
  const kickoffs: string[] = [];
  const fixMessages: string[] = [];
  const resumeSessions: (string | undefined)[] = [];
  let implementorStarts = 0;
  let outcome: RunOutcome = okResult({ accept: true, summary: "looks good" });
  let fixOutcome: RunOutcome = FIX_OK;
  let gate: Promise<void> | undefined;
  let fixGate: Promise<void> | undefined;
  let endedGate: Promise<void> | undefined;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = mgr as any;
  internals.runRole = async (_thread: unknown, role: string, kickoff: string | unknown[]): Promise<RunOutcome> => {
    roleCalls.push(role);
    kickoffs.push(typeof kickoff === "string" ? kickoff : JSON.stringify(kickoff));
    if (gate) await gate;
    return outcome;
  };
  // The implementor leaves. Outside a fix round a review must never reach these, so the count is the
  // assertion; inside one they stand in for the spawn. Two things here are production's behavior, not
  // the stub's convenience, and both are load-bearing: the real `startImplementor` flips the thread to
  // 'implementing' AND populates `this.live` as the run goes live (the inject/resume gates and
  // `stopLive` all read that handle), and the run's own `onEnd` clears it — racing, and usually
  // beating, the result the caller awaits. Without both, a test can "prove" an exclusivity the code
  // doesn't have.
  internals.startResumedImplementor = async (thread: { id: string }, _kickoff: string, resume: string | undefined, opts: { resumeNudge: string }): Promise<unknown> => {
    implementorStarts++;
    fixMessages.push(opts?.resumeNudge ?? "");
    resumeSessions.push(resume);
    const live = { run: { send(): void {}, async stop(): Promise<void> {} }, runId: "stub-run", accountId: "acct-a" };
    internals.live.set(thread.id, live);
    internals.setState(thread.id, "implementing");
    return live;
  };
  internals.awaitImplementorCompletion = async (thread: { id: string }): Promise<RunOutcome> => {
    if (fixGate) await fixGate;
    internals.live.delete(thread.id); // the real run's onEnd, which races (and usually wins) this return
    if (endedGate) await endedGate; // hold HERE: state is still 'implementing' but no agent is live
    return fixOutcome;
  };
  internals.resumeImplementorOnly = async (): Promise<void> => {
    implementorStarts++;
  };

  return {
    mgr,
    db,
    dir,
    workspace,
    roleCalls,
    kickoffs,
    fixMessages,
    resumeSessions,
    implementorStarts: () => implementorStarts,
    // How a usage cap actually reaches the fix round: `awaitImplementorResult` flags the thread in
    // `capParked` and returns undefined. That flag is what `settleReview` turns into the CAP_PARK marker
    // the supervisor acts on, so a test that only returns undefined misses the whole hazard.
    capNextFix() {
      fixOutcome = undefined;
      const inner = internals.awaitImplementorCompletion;
      internals.awaitImplementorCompletion = async (thread: { id: string }): Promise<RunOutcome> => {
        internals.capParked.set(thread.id, "implementor");
        return inner(thread);
      };
    },
    setOutcome(o) {
      outcome = o;
    },
    setFixOutcome(o) {
      fixOutcome = o;
    },
    holdNextRun() {
      let release = (): void => {};
      gate = new Promise<void>((res) => {
        release = res;
      });
      return () => {
        gate = undefined;
        release();
      };
    },
    holdNextFix() {
      let release = (): void => {};
      fixGate = new Promise<void>((res) => {
        release = res;
      });
      return () => {
        fixGate = undefined;
        release();
      };
    },
    holdAfterFixEnded() {
      let release = (): void => {};
      endedGate = new Promise<void>((res) => {
        release = res;
      });
      return () => {
        endedGate = undefined;
        release();
      };
    },
    activePipelines: () => internals.activePipelines.size as number,
    dispose() {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const anyMgr = mgr as any;
      if (anyMgr.capSupervisor) clearInterval(anyMgr.capSupervisor);
      if (anyMgr.tokenResumeTimer) clearTimeout(anyMgr.tokenResumeTimer);
      db.raw.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const IMPLEMENTOR_SESSION = "implementor-session-from-the-pipeline";

/** A task parked exactly the way the pipeline parks one for the owner to look at — including the
 *  implementor `agent_runs` row it got there with. That row is not decoration: a fix round is supposed to
 *  WARM-RESUME that session, and a harness with an empty runs table makes `latestImplementorSession`
 *  return undefined, so the resume silently degrades to a fresh start and the test proves nothing. */
function seedParkedTask(h: Harness, error = "QA still not satisfied after 3 rounds — needs your review."): string {
  const t = h.db.createThread({ title: "mock parked task", workspace: h.workspace, rawPrompt: "do the thing", brief: "Do the thing properly." });
  h.db.updateThreadStageOutputs(t.id, { kickoff: "KICKOFF: mock", planDone: true, approved: true });
  const run = h.db.createRun({ threadId: t.id, role: "implementor", model: "claude-opus-5", account: "acct-a" });
  h.db.updateRun(run.id, { sessionId: IMPLEMENTOR_SESSION, state: "done", endedAt: Date.now() });
  h.db.updateThread(t.id, { state: "review", error });
  return t.id;
}

/** Let a review that was started with `void runAutoReview(...)` run to its settle. Several macrotask
 *  turns, not one: the chain is runRole → finalizeReview → the finally that releases the slot, and a
 *  test that disposes (closing the DB) while it is still in flight crashes the whole file. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

const REVIEWER_SESSION = "reviewer-session-cut-off";
/** A run the SDK ended at the per-session turn ceiling: involuntary, so no verdict. No `result` text —
 *  an Agent-SDK error result carries none. */
const CUTOFF = { type: "result", subtype: "error_max_turns", isError: true } as RunOutcome;
/** A run that came back EMPTY: a SUCCESS result with no verdict, from a session the CLI loaded and exited
 *  without ever reaching the model. Nothing but the absence of any output distinguishes it from a finish —
 *  and the harness's stub writes no messages either, exactly as such a run doesn't. */
const EMPTY = { type: "result", subtype: "success", isError: false } as RunOutcome;

/** What each stubbed reviewer run was asked for: the session to resume, and the backend that resume was
 *  pinned to. The two must always agree — a session id doesn't travel between backends. */
interface ReviewerRunLog {
  resumes: (string | undefined)[];
  providers: (ImplementorProvider | undefined)[];
}

/** Drive a SEQUENCE of reviewer outcomes (the shared stub returns one fixed outcome), recording what each
 *  run was asked to resume. Also persists the `agent_runs` row the real `runRole` would have written:
 *  a continuation resumes the cut-off run's session, so a harness with an empty runs table would silently
 *  prove nothing. `account` is the run's persisted account label, i.e. which backend it ran on ("zai:…" for
 *  a review that failed over; the default is a Claude sub). The last queued outcome repeats if the code runs
 *  more times than the test queued. */
function stubReviewerRuns(h: Harness, results: RunOutcome[], account?: string): ReviewerRunLog {
  const log: ReviewerRunLog = { resumes: [], providers: [] };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = h.mgr as any;
  internals.runRole = async (
    thread: { id: string },
    role: string,
    kickoff: string | unknown[],
    _cfg: unknown,
    resume?: string,
    opts?: { preferredProvider?: ImplementorProvider },
  ): Promise<RunOutcome> => {
    h.roleCalls.push(role);
    h.kickoffs.push(typeof kickoff === "string" ? kickoff : JSON.stringify(kickoff));
    log.resumes.push(resume);
    log.providers.push(opts?.preferredProvider);
    const res = results[Math.min(log.resumes.length - 1, results.length - 1)];
    const run = h.db.createRun({ threadId: thread.id, role: "reviewer", model: "claude-opus-5", account });
    h.db.updateRun(run.id, { sessionId: REVIEWER_SESSION, state: res?.isError ? "error" : "done", endedAt: Date.now() });
    return res;
  };
  return log;
}

async function main(): Promise<void> {
  console.log("\n=== Auto-review & mark done — integration test (real machinery) ===\n");

  // -- Test A: the verdict decides, and only a real acceptance reaches 'done' --------------------------
  console.log("Test A — an accepting verdict marks the task done");
  {
    const h = makeHarness();
    try {
      const id = seedParkedTask(h);
      h.setOutcome(okResult({ accept: true, summary: "build + tests pass, brief satisfied" }));
      const res = await h.mgr.autoReview(id);
      await settle();
      check("autoReview reported the task under review", res.ok && res.state === "reviewing", JSON.stringify(res));
      check("exactly one reviewer run was started", h.roleCalls.length === 1 && h.roleCalls[0] === "reviewer", JSON.stringify(h.roleCalls));
      check("no implementor was spawned", h.implementorStarts() === 0, String(h.implementorStarts()));
      check("the task settled done", h.db.getThread(id)?.state === "done", `state=${h.db.getThread(id)?.state}`);
      check("the park reason was cleared", !h.db.getThread(id)?.error, String(h.db.getThread(id)?.error));
      const finding = h.db.listFindings(id).find((f) => f.fromRole === "reviewer");
      check("the acceptance is recorded as a finding", !!finding && finding.severity === "info", JSON.stringify(finding?.summary));
      check("the verdict summary is in the finding", (finding?.summary ?? "").includes("build + tests pass"), finding?.summary);
      check("the concurrency slot was released", h.activePipelines() === 0, String(h.activePipelines()));

      // The kickoff must carry what the owner would have opened the task to read.
      const kickoff = h.kickoffs[0] ?? "";
      check("the kickoff carries the brief", kickoff.includes("Do the thing properly."), kickoff.slice(0, 120));
      check("the kickoff carries the park reason", kickoff.includes("QA still not satisfied"), kickoff.slice(0, 120));
    } finally {
      h.dispose();
    }
  }

  // -- Test B: a hand-back re-parks the task with the reasons, and NEVER marks it done -----------------
  // With the fix budget at 0 this is the whole lane: the reviewer decides and the owner gets the task
  // back. Tests K–P cover the budgeted fix rounds on top of it.
  console.log("\nTest B — with 0 fix rounds, a rejecting verdict hands the task straight back with its reasons");
  {
    const h = makeHarness();
    try {
      h.mgr.setSettings({ maxReviewFixRounds: 0 });
      const id = seedParkedTask(h);
      h.setOutcome(
        okResult({
          accept: false,
          summary: "the typecheck fails on the new module",
          issues: [{ severity: "blocker", description: "tsc reports 3 errors", location: "server/src/x.ts" }],
        }),
      );
      await h.mgr.autoReview(id);
      await settle();
      check("the task went back to review", h.db.getThread(id)?.state === "review", `state=${h.db.getThread(id)?.state}`);
      check("the re-park message carries the verdict", (h.db.getThread(id)?.error ?? "").includes("typecheck fails"), String(h.db.getThread(id)?.error));
      const finding = h.db.listFindings(id).find((f) => f.fromRole === "reviewer");
      check("the hand-back is a warning finding", finding?.severity === "warning", finding?.severity);
      check("the concrete issues are in the finding detail", (finding?.detail ?? "").includes("tsc reports 3 errors"), String(finding?.detail));
      check("no implementor was spawned", h.implementorStarts() === 0, String(h.implementorStarts()));
      check("the slot was released", h.activePipelines() === 0, String(h.activePipelines()));
      check("the button is armed again", (await h.mgr.autoReview(id)).state === "reviewing");
      await settle(); // let that second review finish before the DB closes under it
    } finally {
      h.dispose();
    }
  }

  // -- Test C: an absent verdict is never an acceptance ------------------------------------------------
  console.log("\nTest C — an errored / verdict-less run re-parks (an absent decision is not a yes)");
  for (const [label, outcome, expect] of [
    ["the run hit its turn ceiling", { type: "result", subtype: "error_max_turns", isError: true } as RunOutcome, "turn ceiling"],
    ["the run returned nothing", undefined as RunOutcome, "Auto-review"],
    ["the run returned no structured verdict", { type: "result", subtype: "success", isError: false } as RunOutcome, "Auto-review"],
  ] as const) {
    const h = makeHarness();
    try {
      const id = seedParkedTask(h);
      h.setOutcome(outcome);
      await h.mgr.autoReview(id);
      await settle();
      check(`${label} → still parked in review (never done)`, h.db.getThread(id)?.state === "review", `state=${h.db.getThread(id)?.state}`);
      check(`${label} → the owner is told why`, (h.db.getThread(id)?.error ?? "").includes(expect), String(h.db.getThread(id)?.error));
      check(`${label} → no unhandled harness error leaked into the message`, !(h.db.getThread(id)?.error ?? "").includes("TypeError"), String(h.db.getThread(id)?.error));
    } finally {
      h.dispose();
    }
  }

  // -- Test D: the guards — only a genuine human-review park can be auto-reviewed ----------------------
  console.log("\nTest D — guards: unknown task, wrong state, a cap-parked (self-resuming) task");
  {
    const h = makeHarness();
    try {
      const missing = await h.mgr.autoReview("no-such-thread");
      check("an unknown task is refused", !missing.ok, JSON.stringify(missing));

      const running = seedParkedTask(h);
      h.db.updateThread(running, { state: "implementing", error: null });
      const res = await h.mgr.autoReview(running);
      check("a still-running task is refused", !res.ok && (res.error ?? "").includes("parked in review"), JSON.stringify(res));

      const frozen = seedParkedTask(h, "⏳ Auto-resume pending — every Claude subscription was rate-limited mid-task.");
      const frozenRes = await h.mgr.autoReview(frozen);
      check("a cap-parked task is refused (it resumes itself)", !frozenRes.ok, JSON.stringify(frozenRes));
      check("the cap-parked task was left untouched", h.db.getThread(frozen)?.state === "review", `state=${h.db.getThread(frozen)?.state}`);
      check("no agent ran for any refused task", h.roleCalls.length === 0, JSON.stringify(h.roleCalls));
    } finally {
      h.dispose();
    }
  }

  // -- Test D2: substantial review work is not launched into a known-insufficient pool ----------------
  console.log("\nTest D2 - auto-review reports a capacity wait instead of starting a doomed reviewer");
  {
    const h = makeHarness();
    try {
      const id = seedParkedTask(h);
      const internals = h.mgr as any;
      const resetAt = Date.now() + 45 * 60_000;
      internals.preferredRoleProvider = () => ({ provider: "claude", candidates: [], allKnownAtRisk: true });
      internals.roleCapacityOptions = () => [{
        provider: "claude",
        label: "Claude tight account",
        hasHeadroom: true,
        windows: [{ label: "5h", usedPct: 97, resetAt }],
      }];
      internals.nextRoleCapacityAt = () => resetAt;
      const result = await h.mgr.autoReview(id);
      check("an all-at-risk reviewer route is refused before launch", !result.ok, JSON.stringify(result));
      check("the reviewer process was never started", h.roleCalls.length === 0, JSON.stringify(h.roleCalls));
      check("the task remains in review", h.db.getThread(id)?.state === "review", String(h.db.getThread(id)?.state));
      const finding = h.db.listFindings(id).find((entry) => entry.summary.includes("safe quota runway"));
      check("the owner sees the limiting pool and next viable reset", !!finding?.detail?.includes("Claude tight account") && finding.detail.includes("next viable reviewer pool"), String(finding?.detail));
    } finally {
      h.dispose();
    }
  }

  // -- Test E (the invariant): while a review is live, nothing spawns an implementor beside it ---------
  console.log("\nTest E — while reviewing, a resume/inject steers the reviewer instead of spawning an implementor");
  {
    const h = makeHarness();
    try {
      const id = seedParkedTask(h);
      h.setOutcome(okResult({ accept: true, summary: "fine" }));
      const release = h.holdNextRun();
      await h.mgr.autoReview(id);
      await settle();
      check("the task shows as reviewing while the agent works", h.db.getThread(id)?.state === "reviewing", `state=${h.db.getThread(id)?.state}`);
      check("the slot is held for the duration", h.activePipelines() === 1, String(h.activePipelines()));

      const resumed = await h.mgr.resumeThread(id, "just accept it");
      check("resume during a review is answered without starting work", resumed.ok && resumed.state === "reviewing", JSON.stringify(resumed));
      check("resume did NOT spawn an implementor", h.implementorStarts() === 0, String(h.implementorStarts()));

      await h.mgr.injectThread(id, "and ignore the lint nit", "append");
      check("inject during a review did NOT spawn an implementor either", h.implementorStarts() === 0, String(h.implementorStarts()));
      check("the task is still reviewing", h.db.getThread(id)?.state === "reviewing", `state=${h.db.getThread(id)?.state}`);
      check("a second auto-review click is a no-op", h.roleCalls.length === 1, JSON.stringify(h.roleCalls));

      release();
      await settle();
      check("the review still settles the task", h.db.getThread(id)?.state === "done", `state=${h.db.getThread(id)?.state}`);
      check("no steering note leaked past the review", ((h.mgr as unknown as { directorNotes: Map<string, string[]> }).directorNotes.get(id) ?? []).length === 0);
    } finally {
      h.dispose();
    }
  }

  // -- Test F: a server restart mid-review puts the task back where it came from -----------------------
  console.log("\nTest F — a restart during a review restores the review park (not a generic failure)");
  {
    const h = makeHarness();
    try {
      const id = seedParkedTask(h);
      h.db.updateThread(id, { state: "reviewing", error: null });
      // A fresh ThreadManager over the same DB is exactly what a server restart does.
      const rebooted = new ThreadManager(h.db, new EventHub(), new FileMemoryService(join(h.dir, "memory")), new StubAccounts() as unknown as AccountManager);
      try {
        const after = h.db.getThread(id);
        check("the task is parked in review again", after?.state === "review", `state=${after?.state}`);
        check("it is NOT left failed", after?.state !== "failed", `state=${after?.state}`);
        check("the owner is told to re-run it", (after?.error ?? "").includes("Auto-review"), String(after?.error));
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const any = rebooted as any;
        if (any.capSupervisor) clearInterval(any.capSupervisor);
        if (any.tokenResumeTimer) clearTimeout(any.tokenResumeTimer);
      }
    } finally {
      h.dispose();
    }
  }

  // -- Test H: a reviewer cut off at its turn ceiling is continued, not handed straight back ----------
  // The point of the button is that the owner does NOT read the diff themselves, so a stop that says
  // nothing about the work must not bounce the task back to their desk while a warm resume is available.
  // Test C above proves the re-park when there is no session to continue; this proves the continuation.
  console.log("\nTest H — a turn-ceiling cutoff continues the reviewer's own session before giving up");
  for (const [label, results, expect] of [
    ["a continuation that decides", [CUTOFF, okResult({ accept: true, summary: "verified after the cutoff" })], { runs: 2, state: "done" }],
    ["a reviewer that keeps being cut off", [CUTOFF, CUTOFF, CUTOFF, CUTOFF], { runs: 3, state: "review" }],
  ] as const) {
    const h = makeHarness();
    try {
      const id = seedParkedTask(h);
      const { resumes } = stubReviewerRuns(h, [...results]);
      await h.mgr.autoReview(id);
      await settle();
      check(`${label} → the reviewer ran ${expect.runs}×`, h.roleCalls.length === expect.runs, JSON.stringify(h.roleCalls));
      check(`${label} → every continuation resumed the cut-off session`, resumes.slice(1).every((r) => r === REVIEWER_SESSION), JSON.stringify(resumes));
      check(`${label} → the first run started fresh`, resumes[0] === undefined, String(resumes[0]));
      check(`${label} → the task settled ${expect.state}`, h.db.getThread(id)?.state === expect.state, `state=${h.db.getThread(id)?.state}`);
      check(`${label} → no implementor was spawned`, h.implementorStarts() === 0, String(h.implementorStarts()));
      if (expect.runs > 1) {
        check(`${label} → the continuation told the reviewer it was cut off`, (h.kickoffs[1] ?? "").includes("stopped at a per-session turn limit"), (h.kickoffs[1] ?? "").slice(0, 80));
      }
    } finally {
      h.dispose();
    }
  }

  // -- Test I: a reviewer that came back EMPTY is started over, not handed back -------------------------
  // The other verdict-less stop: the session returned without ever reaching the model, which arrives as a
  // SUCCESS result and so used to fall straight through to a re-park — the owner clicked the button, paid
  // for a run that reviewed nothing, and got the task back with "Run failed (success)." as the reason.
  console.log("\nTest I — an auto-review that came back empty is re-run from scratch before giving up");
  {
    const h = makeHarness();
    try {
      const id = seedParkedTask(h);
      const { resumes } = stubReviewerRuns(h, [EMPTY, okResult({ accept: true, summary: "verified on the retry" })]);
      await h.mgr.autoReview(id);
      await settle();
      check("the reviewer ran twice: the empty run plus its retry", h.roleCalls.length === 2, JSON.stringify(h.roleCalls));
      check("the retry started FRESH — resuming an empty session is what already failed", resumes[1] === undefined, JSON.stringify(resumes));
      check("the retry got the full review kickoff, not a continuation nudge", !(h.kickoffs[1] ?? "").includes("stopped at a per-session turn limit"), (h.kickoffs[1] ?? "").slice(0, 80));
      check("the retry's verdict decided the task", h.db.getThread(id)?.state === "done", `state=${h.db.getThread(id)?.state}`);
      // The reviewer's first run — the seeded task carries an earlier implementor row (the one a fix
      // round warm-resumes), so an unscoped "first run" would assert against that instead.
      const firstRun = h.db
        .listRuns(id)
        .filter((r) => r.role === "reviewer")
        .sort((a, b) => a.startedAt - b.startedAt)[0];
      check("the empty run is recorded as a failure, not a clean 'done'", firstRun?.state === "error", `state=${firstRun?.state}`);
      check("...and it says why", !!firstRun?.error?.includes("produced no output"), String(firstRun?.error));
    } finally {
      h.dispose();
    }
  }

  // -- Test J: the recovery budget is bounded and shared across BOTH involuntary stops -----------------
  console.log("\nTest J — recovery is bounded, shared between cutoffs and empty runs, and parks diagnosably");
  for (const [label, results, expectResumes] of [
    ["a reviewer that keeps coming back empty", [EMPTY, EMPTY, EMPTY, EMPTY], [undefined, undefined, undefined]],
    ["a cutoff whose continuation comes back empty", [CUTOFF, EMPTY, EMPTY, EMPTY], [undefined, REVIEWER_SESSION, undefined]],
  ] as const) {
    const h = makeHarness();
    try {
      const id = seedParkedTask(h);
      const { resumes } = stubReviewerRuns(h, [...results]);
      await h.mgr.autoReview(id);
      await settle();
      // MAX_REVIEW_RECOVERIES (2) recoveries on top of the run the owner's click started.
      check(`${label} → the reviewer ran 3× and stopped`, h.roleCalls.length === 3, JSON.stringify(h.roleCalls));
      check(`${label} → each recovery chose the right session`, JSON.stringify(resumes) === JSON.stringify(expectResumes), JSON.stringify(resumes));
      check(`${label} → a verdict-less review re-parks, never accepts`, h.db.getThread(id)?.state === "review", `state=${h.db.getThread(id)?.state}`);
      check(`${label} → the park names the empty run, not "Run failed (success)"`, !!h.db.getThread(id)?.error?.includes("produced no output"), String(h.db.getThread(id)?.error));
      check(`${label} → no implementor was spawned`, h.implementorStarts() === 0, String(h.implementorStarts()));
    } finally {
      h.dispose();
    }
  }

  // -- Test S: a review that ran on z.ai is continued ON z.ai, or not at all ---------------------------
  // The reviewer is no longer Claude-only: when every Claude sub is capped it fails over to z.ai (the CLI
  // backends stay excluded — no in-process MCP bus, so no post_finding/ask_user). That makes its warm
  // resume provider-specific. A session id doesn't travel between backends, so handing a z.ai session to a
  // Claude run buys an empty run that burns a recovery, and dropping the resume while keeping the "carry
  // on" nudge asks a fresh session to continue work it never heard about.
  console.log("\nTest S — a reviewer that ran on z.ai resumes on z.ai, and starts fresh when z.ai can't take it");
  for (const [label, zaiReady, expect] of [
    ["z.ai still available", true, { resume: REVIEWER_SESSION, provider: "zai" as const, continued: true }],
    ["z.ai capped since", false, { resume: undefined, provider: undefined, continued: false }],
  ] as const) {
    const h = makeHarness();
    try {
      const id = seedParkedTask(h);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (h.mgr as any).zaiImplementorReady = (): boolean => zaiReady;
      const { resumes, providers } = stubReviewerRuns(h, [CUTOFF, okResult({ accept: true, summary: "verified after the cutoff" })], "zai:glm-4.6");
      await h.mgr.autoReview(id);
      await settle();
      check(`${label} → the reviewer ran twice`, h.roleCalls.length === 2, JSON.stringify(h.roleCalls));
      check(`${label} → the recovery resumed ${expect.resume ?? "nothing"}`, resumes[1] === expect.resume, JSON.stringify(resumes));
      check(`${label} → and pinned the backend to ${expect.provider ?? "none"}`, providers[1] === expect.provider, JSON.stringify(providers));
      check(
        `${label} → the kickoff matches what the session can answer`,
        (h.kickoffs[1] ?? "").includes("stopped at a per-session turn limit") === expect.continued,
        (h.kickoffs[1] ?? "").slice(0, 80),
      );
      check(`${label} → the recovery still reached a verdict`, h.db.getThread(id)?.state === "done", `state=${h.db.getThread(id)?.state}`);
      const note = h.db.listFindings(id).find((f) => f.summary.startsWith("Auto-review stopped at its turn ceiling"));
      check(`${label} → the owner is told which recovery ran`, !!note && note.summary.includes("can't be resumed") === !expect.continued, String(note?.summary));
    } finally {
      h.dispose();
    }
  }

  // -- Test K: the point of the whole change — a hand-back is fixed, re-checked, and finished ---------
  // The task this was built for was blocked by ONE mechanical item the reviewer is forbidden to do
  // itself, and cost the owner a second click plus a second full Opus review to clear.
  console.log("\nTest K — a hand-back with issues buys an implementor fix round, then a re-review that can finish it");
  {
    const h = makeHarness();
    try {
      const id = seedParkedTask(h);
      const { resumes } = stubReviewerRuns(h, [
        okResult({
          accept: false,
          summary: "everything checks out except the report placement",
          issues: [{ severity: "blocker", description: "the review report sits outside the workspace and was never surfaced", location: "benchmark-results/PR-73.md" }],
        }),
        okResult({ accept: true, summary: "the report is surfaced now — accepting" }),
      ]);
      await h.mgr.autoReview(id);
      await settle();
      check("the implementor was sent in exactly once", h.implementorStarts() === 1, String(h.implementorStarts()));
      check("the reviewer ran twice: the verdict, then the re-check", h.roleCalls.length === 2 && h.roleCalls.every((r) => r === "reviewer"), JSON.stringify(h.roleCalls));
      check("the re-check warm-resumed the reviewer's own session", resumes[1] === REVIEWER_SESSION, JSON.stringify(resumes));
      check("the re-check told it the tree had changed under it", (h.kickoffs[1] ?? "").includes("has CHANGED since you read it"), (h.kickoffs[1] ?? "").slice(0, 100));
      check("the re-check restated the issues it handed back for", (h.kickoffs[1] ?? "").includes("never surfaced"), (h.kickoffs[1] ?? "").slice(0, 200));
      const fix = h.fixMessages[0] ?? "";
      check("the implementor got the reviewer's concrete issue list", fix.includes("the review report sits outside the workspace"), fix.slice(0, 200));
      check("...and the location with it", fix.includes("benchmark-results/PR-73.md"), fix.slice(0, 200));
      check("...and the reviewer's verdict as context", fix.includes("everything checks out except"), fix.slice(0, 200));
      check("...told plainly that the reviewer re-checks the fix", fix.includes("re-checks your work"), fix.slice(-200));
      check("the fix warm-resumed the task's own implementor session", h.resumeSessions[0] === IMPLEMENTOR_SESSION, JSON.stringify(h.resumeSessions));
      check("the accepted re-check settled the task done", h.db.getThread(id)?.state === "done", `state=${h.db.getThread(id)?.state}`);
      check("the fix-round restart marker was cleared", h.db.getThreadStageOutputs(id).reviewFixing !== true, JSON.stringify(h.db.getThreadStageOutputs(id)));
      check("the slot was released", h.activePipelines() === 0, String(h.activePipelines()));
      const handBack = h.db.listFindings(id).find((f) => f.summary.includes("sending it to the implementor"));
      check("the hand-back that triggered the fix is on the thread", !!handBack && handBack.severity === "warning", JSON.stringify(handBack?.summary));
      check("...and names which round it was", (handBack?.summary ?? "").includes("round 1 of 1"), handBack?.summary);
    } finally {
      h.dispose();
    }
  }

  // -- Test L: the fix budget is bounded, and a still-unhappy reviewer parks (never accepts) ----------
  console.log("\nTest L — the fix budget is bounded: a reviewer still unsatisfied after it parks the task");
  {
    const h = makeHarness();
    try {
      const id = seedParkedTask(h);
      const rejection = okResult({ accept: false, summary: "the typecheck still fails", issues: [{ severity: "blocker", description: "tsc reports 3 errors" }] });
      stubReviewerRuns(h, [rejection]); // never satisfied
      await h.mgr.autoReview(id);
      await settle();
      check("only the budgeted single fix round ran", h.implementorStarts() === 1, String(h.implementorStarts()));
      check("the reviewer ran twice and stopped", h.roleCalls.length === 2, JSON.stringify(h.roleCalls));
      check("the task is parked for the owner, not done", h.db.getThread(id)?.state === "review", `state=${h.db.getThread(id)?.state}`);
      check("the park says a fix was already attempted", (h.db.getThread(id)?.error ?? "").includes("after 1 fix round"), String(h.db.getThread(id)?.error));
      check("the park still carries the reviewer's reason", (h.db.getThread(id)?.error ?? "").includes("typecheck still fails"), String(h.db.getThread(id)?.error));
      check("the fix-round restart marker was cleared", h.db.getThreadStageOutputs(id).reviewFixing !== true, JSON.stringify(h.db.getThreadStageOutputs(id)));
    } finally {
      h.dispose();
    }
  }

  // -- Test M: what does NOT buy a fix round ----------------------------------------------------------
  // A verdict-less run has nothing to act on, and an `accept: false` with no issues would send the
  // implementor in to guess. Both belong on the owner's desk instead.
  console.log("\nTest M — a hand-back with no concrete issues (and a verdict-less run) never spends a fix round");
  for (const [label, outcome] of [
    ["a hand-back with no issues at all", okResult({ accept: false, summary: "something feels off" })],
    ["a hand-back with an empty issue list", okResult({ accept: false, summary: "something feels off", issues: [] })],
    ["a run that reached no verdict", { type: "result", subtype: "success", isError: false } as RunOutcome],
  ] as const) {
    const h = makeHarness();
    try {
      const id = seedParkedTask(h);
      h.setOutcome(outcome);
      await h.mgr.autoReview(id);
      await settle();
      check(`${label} → no implementor was sent in`, h.implementorStarts() === 0, String(h.implementorStarts()));
      check(`${label} → the task parks for the owner`, h.db.getThread(id)?.state === "review", `state=${h.db.getThread(id)?.state}`);
      check(`${label} → and it is not blamed on a fix round`, !(h.db.getThread(id)?.error ?? "").includes("fix round"), String(h.db.getThread(id)?.error));
    } finally {
      h.dispose();
    }
  }

  // -- Test N: a fix round that fails must never become a route to 'done' ------------------------------
  console.log("\nTest N — an implementor that fails its fix round parks the task, and no re-review 'accepts' it");
  {
    const h = makeHarness();
    try {
      const id = seedParkedTask(h);
      stubReviewerRuns(h, [
        okResult({ accept: false, summary: "the build is broken", issues: [{ severity: "blocker", description: "npm run build fails" }] }),
        okResult({ accept: true, summary: "would have accepted — must never be reached" }),
      ]);
      h.setFixOutcome(FIX_FAILED);
      await h.mgr.autoReview(id);
      await settle();
      check("the fix round was attempted", h.implementorStarts() === 1, String(h.implementorStarts()));
      check("no re-review ran on a fix that didn't land", h.roleCalls.length === 1, JSON.stringify(h.roleCalls));
      check("the task parked instead of being accepted", h.db.getThread(id)?.state === "review", `state=${h.db.getThread(id)?.state}`);
      check("the park names the failed fix round", (h.db.getThread(id)?.error ?? "").includes("fix round"), String(h.db.getThread(id)?.error));
      const finding = h.db.listFindings(id).find((f) => f.summary.includes("didn't complete"));
      check("the owner still gets the reviewer's issue list", (finding?.detail ?? "").includes("npm run build fails"), String(finding?.detail));
      check("the fix-round restart marker was cleared", h.db.getThreadStageOutputs(id).reviewFixing !== true, JSON.stringify(h.db.getThreadStageOutputs(id)));
      check("the slot was released", h.activePipelines() === 0, String(h.activePipelines()));
    } finally {
      h.dispose();
    }
  }

  // -- Test O: mid-fix the task looks like real implementor work, and only ONE agent ever holds it -----
  // The fix round runs under 'implementing' with a live implementor, so it re-opens exactly the window
  // Test E guards for the reviewer: a Resume/inject must steer the running agent, never spawn a second.
  console.log("\nTest O — while a fix round runs, the task shows as implementing and no second agent can start");
  {
    const h = makeHarness();
    try {
      const id = seedParkedTask(h);
      stubReviewerRuns(h, [okResult({ accept: false, summary: "one thing left", issues: [{ severity: "major", description: "surface the report" }] })]);
      const release = h.holdNextFix();
      await h.mgr.autoReview(id);
      await settle();
      check("the task shows as implementing while the fix runs", h.db.getThread(id)?.state === "implementing", `state=${h.db.getThread(id)?.state}`);
      check("the fix round is marked for a restart to find", h.db.getThreadStageOutputs(id).reviewFixing === true, JSON.stringify(h.db.getThreadStageOutputs(id)));
      check("the slot is still held", h.activePipelines() === 1, String(h.activePipelines()));
      check("the auto-review ack reports the real state, not a contradicting one", (await h.mgr.autoReview(id)).state === "implementing", JSON.stringify(h.db.getThread(id)?.state));
      check("a second auto-review click starts no second review", h.roleCalls.length === 1, JSON.stringify(h.roleCalls));

      await h.mgr.resumeThread(id, "also bump the version");
      check("a resume mid-fix steers the running implementor, it doesn't start another", h.implementorStarts() === 1, String(h.implementorStarts()));
      await h.mgr.injectThread(id, "and mention it in the report", "append");
      check("an inject mid-fix doesn't start another either", h.implementorStarts() === 1, String(h.implementorStarts()));

      release();
      await settle();
      check("the episode still settles", h.db.getThread(id)?.state === "review", `state=${h.db.getThread(id)?.state}`);
      check("the slot was released", h.activePipelines() === 0, String(h.activePipelines()));
      check("nothing was left queued for a later unrelated run", ((h.mgr as unknown as { queuedForImplementor: Map<string, string[]> }).queuedForImplementor.get(id) ?? []).length === 0);
    } finally {
      h.dispose();
    }
  }

  // -- Test R: the window where the implementor has ended but the round hasn't flipped the state ------
  // Production always passes through it: the run's own onEnd clears `this.live` and races the awaited
  // result, usually winning. The thread then reads 'implementing' with NO live agent — and a state-only
  // gate falls straight through that to the cold-resume path, spawning a second implementor on a
  // workspace the reviewer is about to inspect. Hence the gates key on the EPISODE, not the state.
  console.log("\nTest R — a resume/inject after the fix implementor ended, before the state flips, starts nothing");
  {
    const h = makeHarness();
    try {
      const id = seedParkedTask(h);
      stubReviewerRuns(h, [
        okResult({ accept: false, summary: "one thing left", issues: [{ severity: "major", description: "surface the report" }] }),
        okResult({ accept: true, summary: "fixed" }),
      ]);
      const release = h.holdAfterFixEnded();
      await h.mgr.autoReview(id);
      await settle();
      check("the window is real: implementing, but nothing live", h.db.getThread(id)?.state === "implementing" && !(h.mgr as unknown as { live: Map<string, unknown> }).live.has(id), `state=${h.db.getThread(id)?.state}`);
      await h.mgr.resumeThread(id, "one more thing");
      check("a resume in that window spawns no second implementor", h.implementorStarts() === 1, String(h.implementorStarts()));
      await h.mgr.injectThread(id, "and this too", "interrupt");
      check("an inject in that window spawns none either", h.implementorStarts() === 1, String(h.implementorStarts()));
      release();
      await settle();
      check("the episode still reaches its verdict", h.db.getThread(id)?.state === "done", `state=${h.db.getThread(id)?.state}`);
      check("exactly one fix round ran", h.implementorStarts() === 1, String(h.implementorStarts()));
    } finally {
      h.dispose();
    }
  }

  // -- Test Q: a usage cap during a fix round must NOT hand the task to the cap supervisor -------------
  // `resumeCapParked` resumes a CAP_PARK-marked task through runPipeline — the full QA loop, which can
  // reach 'done' on its own. Leaving the marker on after a capped fix round would therefore let a task
  // be marked done by a verdict the reviewer never gave, on the one lane whose contract forbids exactly
  // that — and `autoReview` refuses a cap-parked task, so the owner couldn't even intervene.
  console.log("\nTest Q — a usage cap during a fix round parks for the owner, never for the cap supervisor");
  {
    const h = makeHarness();
    try {
      const id = seedParkedTask(h);
      stubReviewerRuns(h, [okResult({ accept: false, summary: "one thing left", issues: [{ severity: "blocker", description: "surface the report" }] })]);
      h.capNextFix();
      await h.mgr.autoReview(id);
      await settle();
      const err = h.db.getThread(id)?.error ?? "";
      check("the task parked in review", h.db.getThread(id)?.state === "review", `state=${h.db.getThread(id)?.state}`);
      check("it does NOT carry the cap auto-resume marker", !err.startsWith("⏳ Auto-resume pending"), err);
      check("the owner is told a cap stopped the fix", err.includes("usage-capped"), err);
      check("...and the button is armed again for them", (await h.mgr.autoReview(id)).ok);
      await settle();
    } finally {
      h.dispose();
    }
  }

  // -- Test P: a restart during the FIX round re-parks it, rather than reviving the old pipeline -------
  // The fix runs under 'implementing', an auto-resume state, so without the durable marker a restart
  // would hand the task to runPipeline and re-enter the QA loop this episode had already left behind.
  console.log("\nTest P — a restart during the fix round re-parks the task instead of auto-resuming the pipeline");
  {
    const h = makeHarness();
    try {
      const id = seedParkedTask(h);
      h.db.updateThreadStageOutputs(id, { reviewFixing: true, qaRoundsUsed: 4 });
      h.db.updateThread(id, { state: "implementing", error: null });
      const rebooted = new ThreadManager(h.db, new EventHub(), new FileMemoryService(join(h.dir, "memory")), new StubAccounts() as unknown as AccountManager);
      try {
        const after = h.db.getThread(id);
        check("the task is parked in review again", after?.state === "review", `state=${after?.state}`);
        check("it is NOT left failed for the pipeline to auto-resume", after?.state !== "failed", `state=${after?.state}`);
        check("the owner is told the fix work is still in the tree", (after?.error ?? "").includes("still in the working tree"), String(after?.error));
        check("the marker was consumed, so a later resume isn't mistaken for one", h.db.getThreadStageOutputs(id).reviewFixing !== true, JSON.stringify(h.db.getThreadStageOutputs(id)));
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const any = rebooted as any;
        if (any.capSupervisor) clearInterval(any.capSupervisor);
        if (any.tokenResumeTimer) clearTimeout(any.tokenResumeTimer);
      }
    } finally {
      h.dispose();
    }
  }

  // -- Test G: the WS boundary accepts the command ----------------------------------------------------
  console.log("\nTest G — the thread.autoReview command validates at the WebSocket boundary");
  check("thread.autoReview is accepted", clientCommandSchema.safeParse({ type: "thread.autoReview", threadId: "abc" }).success);
  check("thread.autoReview requires a threadId", !clientCommandSchema.safeParse({ type: "thread.autoReview" }).success);
  check("the fix-round budget is settable, including off", clientCommandSchema.safeParse({ type: "settings.set", settings: { maxReviewFixRounds: 0 } }).success);
  check("...and is bounded", !clientCommandSchema.safeParse({ type: "settings.set", settings: { maxReviewFixRounds: 9 } }).success);

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
