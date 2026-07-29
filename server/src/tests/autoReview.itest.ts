/**
 * Integration test — the "Auto-review & mark done" lane (real ThreadManager machinery).
 *
 * The button hands the owner's OWN final review of a parked task to one agent, which either accepts it
 * (the task settles 'done', exactly as if they'd clicked Mark done) or hands it back to 'review'. That
 * makes two things load-bearing and worth guarding: the verdict must be the ONLY route to 'done' — an
 * errored or verdict-less run must never be read as an acceptance — and while the reviewer holds the slot
 * nothing may spawn an implementor beside it.
 *
 * WHAT IS REAL vs. STUBBED
 *  - REAL: `autoReview` (its guards, the slot accounting, the state transitions), `runAutoReview`,
 *    `finalizeReview`, the resume/inject gates, `markInterrupted`, and the real `Db` + `EventHub`.
 *  - STUBBED: only `runRole` — the leaf that would spawn a real `claude` process. The test drives it to
 *    return whatever the reviewer "decided" (or to fail), and can hold it open to assert what the rest of
 *    the manager does WHILE a review is live.
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
import type { ReviewerOutput } from "../types.js";

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

interface Harness {
  mgr: InstanceType<typeof ThreadManager>;
  db: InstanceType<typeof Db>;
  dir: string;
  workspace: string;
  roleCalls: string[]; // every role runRole was asked to run, in order
  kickoffs: string[]; // the kickoff text each run was given
  implementorStarts: () => number;
  setOutcome(o: RunOutcome): void;
  /** Hold the next run open; the returned function releases it with the given outcome. */
  holdNextRun(): () => void;
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
  let implementorStarts = 0;
  let outcome: RunOutcome = okResult({ accept: true, summary: "looks good" });
  let gate: Promise<void> | undefined;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = mgr as any;
  internals.runRole = async (_thread: unknown, role: string, kickoff: string | unknown[]): Promise<RunOutcome> => {
    roleCalls.push(role);
    kickoffs.push(typeof kickoff === "string" ? kickoff : JSON.stringify(kickoff));
    if (gate) await gate;
    return outcome;
  };
  // The implementor leaves: a review must never reach these. Counting them is the assertion.
  internals.startResumedImplementor = async (): Promise<unknown> => {
    implementorStarts++;
    return { run: { send(): void {} }, accountId: "acct-a" };
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
    implementorStarts: () => implementorStarts,
    setOutcome(o) {
      outcome = o;
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

/** A task parked exactly the way the pipeline parks one for the owner to look at. */
function seedParkedTask(h: Harness, error = "QA still not satisfied after 3 rounds — needs your review."): string {
  const t = h.db.createThread({ title: "mock parked task", workspace: h.workspace, rawPrompt: "do the thing", brief: "Do the thing properly." });
  h.db.updateThreadStageOutputs(t.id, { kickoff: "KICKOFF: mock", planDone: true, approved: true });
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

/** Drive a SEQUENCE of reviewer outcomes (the shared stub returns one fixed outcome), recording the resume
 *  session each run was given. Also persists the `agent_runs` row the real `runRole` would have written:
 *  a continuation resumes the cut-off run's session, so a harness with an empty runs table would silently
 *  prove nothing. The last queued outcome repeats if the code runs more times than the test queued. */
function stubReviewerRuns(h: Harness, results: RunOutcome[]): (string | undefined)[] {
  const resumes: (string | undefined)[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = h.mgr as any;
  internals.runRole = async (thread: { id: string }, role: string, kickoff: string | unknown[], _cfg: unknown, resume?: string): Promise<RunOutcome> => {
    h.roleCalls.push(role);
    h.kickoffs.push(typeof kickoff === "string" ? kickoff : JSON.stringify(kickoff));
    resumes.push(resume);
    const res = results[Math.min(resumes.length - 1, results.length - 1)];
    const run = h.db.createRun({ threadId: thread.id, role: "reviewer", model: "claude-opus-5" });
    h.db.updateRun(run.id, { sessionId: REVIEWER_SESSION, state: res?.isError ? "error" : "done", endedAt: Date.now() });
    return res;
  };
  return resumes;
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
  console.log("\nTest B — a rejecting verdict hands the task back to review with its reasons");
  {
    const h = makeHarness();
    try {
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
      const resumes = stubReviewerRuns(h, [...results]);
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

  // -- Test G: the WS boundary accepts the command ----------------------------------------------------
  console.log("\nTest G — the thread.autoReview command validates at the WebSocket boundary");
  check("thread.autoReview is accepted", clientCommandSchema.safeParse({ type: "thread.autoReview", threadId: "abc" }).success);
  check("thread.autoReview requires a threadId", !clientCommandSchema.safeParse({ type: "thread.autoReview" }).success);

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
