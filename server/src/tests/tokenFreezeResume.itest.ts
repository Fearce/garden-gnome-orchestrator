/**
 * Integration test — token-freeze → usage-reset → auto-resume, against the REAL orchestrator machinery.
 *
 * Reproduces Mikkel's 4-step mock scenario deterministically, in seconds, with no real API limit hit:
 *   1. Start a (mock) long task and freeze it mid-work.
 *   2. Simulate hitting the usage/token limit (force utilization over the threshold) — the task should
 *      FREEZE (pause / cap-park), not die, and the orchestrator should ARM a reset-timed auto-resume.
 *   3. Simulate the usage window resetting (utilization drops, an account regains headroom).
 *   4. Assert the task is RESUMED correctly — the resume fires, re-enters the SAME task carrying its
 *      prior SDK session (journal/context intact, not a cold restart), and runs to completion.
 *
 * WHAT IS REAL vs. SIMULATED
 *  - REAL: the entire freeze/resume orchestration in `ThreadManager` — `maybeScheduleTokenResume`,
 *    `armTokenResume`, `restoreTokenResume`, `fireTokenResume`, the `resumeThread` re-entry, and the
 *    DB-sourced prior-session recovery (`latestImplementorSession`) that every resume path feeds into
 *    `startResumedImplementor`. A real `Db` (temp file) and a real `EventHub` back it.
 *  - SIMULATED: only the two leaves we cannot exercise without burning real API tokens / a live limit:
 *      (a) the account usage signal — a stub AccountManager whose utilization / reset / headroom we
 *          drive directly, standing in for the ~10-min usage ping crossing/clearing the cap; and
 *      (b) the actual Claude agent spawn — `startResumedImplementor` is intercepted to RECORD the
 *          session id the real recovery handed it, then mark the task done (standing in for the resumed
 *          implementor running to completion). Everything UP TO the spawn is the real code path.
 *  - The routing gate (`gateImplementorProvider`) is forced open: it's orthogonal to freeze/resume and
 *    would otherwise reject the stub's tokenless accounts.
 *
 * The assertions are real: each FAILS if the resume machinery is broken (no arm, wrong epoch, no fire,
 * cold restart that drops the prior session, premature wake with no headroom, or lost across a restart).
 *
 * Run:  npm run test:token-freeze   (from server/)   — or:  npx tsx src/tests/tokenFreezeResume.itest.ts
 * Exits non-zero if any assertion fails. Self-contained: creates a throwaway DB + workspace and removes them.
 */

// Env must be set BEFORE config.js is first evaluated — so the app modules are dynamically imported below.
process.env.CAP_RETRY_MS = "0"; // disable the cap-supervisor interval + its 4s boot sweep — THIS test drives resume
process.env.ACCOUNT_PING_MS = "3600000"; // never let a real ping timer fire during the test
process.env.FAST_ACCOUNT_PING_MS = "3600000";
process.env.RESUME_FULL_SESSION = "1"; // force the warm (network-free) resume path if the leaf ever runs

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountManager } from "../accounts/accountManager.js";
import type { Thread, ThreadState } from "../types.js";

const { Db } = await import("../db/db.js");
const { EventHub } = await import("../events.js");
const { FileMemoryService } = await import("../memory/memory.js");
const { ThreadManager } = await import("../orchestrator/threadManager.js");

// The exact CAP_PARK marker the supervisor keys off (private in threadManager.ts — mirrored here on purpose).
const CAP_PARK_PREFIX = "⏳ Auto-resume pending";
const WAKEUP_KEY = "token_resume_wakeup_at";

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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

// ---- stub AccountManager: the ONLY usage signal, fully driven by the test -------------------------
class StubAccounts {
  util: number | null = null; // effectiveUtilization() — the live burn %
  reset: number | null = null; // soonestResetAt() — epoch of the next window reset
  headroom = false; // hasHeadroom() — does any account have room right now
  private refreshCb: (() => void) | undefined;
  onUsageRefresh(cb: () => void): void {
    this.refreshCb = cb;
  }
  /** Stand-in for a usage ping landing: fires the same hook the real AccountManager fires. */
  fireUsageRefresh(): void {
    this.refreshCb?.();
  }
  effectiveUtilization(): number | null {
    return this.util;
  }
  soonestResetAt(): number | null {
    return this.reset;
  }
  hasHeadroom(): boolean {
    return this.headroom;
  }
  setPingInterval(_ms: number): void {}
  applyEnabled(_id: string, _enabled: boolean): void {}
  applyWeeklySafetyPct(_id: string, _pct: number): void {}
}

// ---- a ThreadManager wired to the real DB + a stub usage signal ------------------------------------
interface Harness {
  mgr: InstanceType<typeof ThreadManager>;
  db: InstanceType<typeof Db>;
  stub: StubAccounts;
  workspace: string;
  logs: string[];
  resumeCalls: { threadId: string; resumeSession: string | undefined }[];
  dir: string;
  dispose(): void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "tf-resume-"));
  const dbPath = join(dir, "orchestrator.sqlite");
  const workspace = join(dir, "workspace");
  mkdirSync(workspace, { recursive: true });

  const db = new Db(dbPath);
  const hub = new EventHub();
  const logs: string[] = [];
  hub.subscribe((e) => {
    if (e.type === "log") logs.push(`[${e.level}] ${e.message}`);
  });
  const memory = new FileMemoryService(join(dir, "memory"));
  const stub = new StubAccounts();
  const mgr = new ThreadManager(db, hub, memory, stub as unknown as AccountManager);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = mgr as any;
  // Routing is orthogonal to freeze/resume — force it open so the stub's tokenless accounts don't block.
  internals.gateImplementorProvider = (): string => "claude";
  // Intercept the sole leaf every resume path converges on: record the recovered prior session, then
  // simulate the resumed implementor re-entering with that context and running to completion.
  const resumeCalls: { threadId: string; resumeSession: string | undefined }[] = [];
  internals.startResumedImplementor = async (thread: Thread, _kickoff: string, resumeSession: string | undefined) => {
    resumeCalls.push({ threadId: thread.id, resumeSession });
    db.updateThread(thread.id, { state: "done", error: null }); // resumed → ran to completion (leaf stubbed)
    return null;
  };

  return {
    mgr,
    db,
    stub,
    workspace,
    logs,
    resumeCalls,
    dir,
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

/** Seed a mock task frozen mid-implementor: a persisted kickoff (so a resume skips the planner), an
 *  implementor run carrying an SDK session id (the "journal"), and the given frozen state. Returns the
 *  thread id and the session id a correct resume MUST recover. */
function seedFrozenTask(h: Harness, frozenState: ThreadState, capParked = false): { threadId: string; session: string } {
  const t = h.db.createThread({ title: "mock long task", workspace: h.workspace, rawPrompt: "count slowly to 1e9" });
  h.db.updateThreadStageOutputs(t.id, { kickoff: "KICKOFF: mock long task — original brief", planDone: true, approved: true });
  const run = h.db.createRun({ threadId: t.id, role: "implementor", model: "claude-opus-4-8", account: "sub-alpha" });
  const session = `sess-${t.id.slice(0, 8)}`;
  h.db.updateRun(run.id, { sessionId: session, state: "idle" });
  h.db.updateThread(t.id, {
    state: frozenState,
    error: capParked ? `${CAP_PARK_PREFIX} — every account was rate-limited mid-task.` : null,
  });
  return { threadId: t.id, session };
}

// ====================================================================================================
async function main(): Promise<void> {
  console.log("\n=== Token-freeze → reset → auto-resume — integration test (real machinery) ===\n");

  // -- Test A: feature OFF → a freeze ping must NOT arm anything (guards against a false green) --------
  console.log("Test A — feature OFF: a usage-limit ping does not arm a resume");
  {
    const h = makeHarness();
    try {
      // feature is off by default; even a screaming-hot usage ping must arm nothing.
      h.stub.util = 99;
      h.stub.reset = Date.now() + 3_600_000;
      h.stub.headroom = false;
      h.stub.fireUsageRefresh();
      check("no wakeup armed while the feature is off", !h.db.kvGet(WAKEUP_KEY));
    } finally {
      h.dispose();
    }
  }

  // -- Test B: feature ON + freeze ping → arm the resume at the reset epoch (steps 1-2) ---------------
  console.log("\nTest B — freeze: hitting the token limit arms a reset-timed auto-resume");
  let resetEpoch = 0;
  {
    const h = makeHarness();
    try {
      seedFrozenTask(h, "paused");
      h.mgr.setSettings({ autoResumeOnTokenReset: true, autoResumeThresholdPercent: 80 });
      check("still nothing armed before any usage data crosses the line", !h.db.kvGet(WAKEUP_KEY));

      // Step 2: simulate hitting the usage/token limit — utilization crosses the threshold, a reset is known.
      resetEpoch = Date.now() + 3_600_000;
      h.stub.util = 90;
      h.stub.reset = resetEpoch;
      h.stub.headroom = false; // capped — no room right now
      h.stub.fireUsageRefresh();

      const armed = h.db.kvGet(WAKEUP_KEY);
      check("a wakeup is armed after the freeze", !!armed, `kv=${armed ?? "(empty)"}`);
      check("the wakeup points at the soonest reset epoch", armed === String(resetEpoch), `armed=${armed} expected=${resetEpoch}`);
      check(
        "the freeze was logged as a scheduled resume",
        h.logs.some((l) => /Token threshold hit/i.test(l) && /Scheduling resume/i.test(l)),
        h.logs.filter((l) => /threshold|resume/i.test(l)).join(" | ") || "(no matching log)",
      );
    } finally {
      h.dispose();
    }
  }

  // -- Test C: the frozen task is preserved (not killed) and its journal survives ---------------------
  console.log("\nTest C — the frozen task pauses (not dies) with its session/journal intact");
  {
    const h = makeHarness();
    try {
      const { threadId, session } = seedFrozenTask(h, "paused");
      h.mgr.setSettings({ autoResumeOnTokenReset: true, autoResumeThresholdPercent: 80 });
      h.stub.util = 90;
      h.stub.reset = Date.now() + 3_600_000;
      h.stub.fireUsageRefresh();

      const t = h.db.getThread(threadId);
      check("the task is still present (not deleted/lost)", !!t);
      check("the task is frozen in 'paused' (not 'failed'/'closed')", t?.state === "paused", `state=${t?.state}`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const recovered = (h.mgr as any).latestImplementorSession(threadId) as string | undefined;
      check("the prior implementor session is recoverable from the DB (journal intact)", recovered === session, `recovered=${recovered} expected=${session}`);
    } finally {
      h.dispose();
    }
  }

  // -- Test D: reset fires but NO headroom yet → re-arm, do NOT resume (guards a premature wake) -------
  console.log("\nTest D — an early reset with no headroom re-arms instead of waking into an instant re-cap");
  {
    const h = makeHarness();
    try {
      const { threadId } = seedFrozenTask(h, "paused");
      h.mgr.setSettings({ autoResumeOnTokenReset: true, autoResumeThresholdPercent: 80 });
      const nextReset = Date.now() + 1_800_000;
      h.stub.util = 90;
      h.stub.reset = nextReset;
      h.stub.headroom = false; // window "reset" epoch reached, but the account is still capped
      h.stub.fireUsageRefresh();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (h.mgr as any).fireTokenResume();
      await delay(80);

      check("no resume was attempted while there is no headroom", h.resumeCalls.length === 0, `calls=${h.resumeCalls.length}`);
      check("the task stays frozen ('paused'), not woken", h.db.getThread(threadId)?.state === "paused");
      check("the resume re-armed for the next known reset", h.db.kvGet(WAKEUP_KEY) === String(nextReset), `kv=${h.db.kvGet(WAKEUP_KEY)}`);
    } finally {
      h.dispose();
    }
  }

  // -- Test E: reset WITH headroom → resume fires, re-enters with prior session, runs to done (3-4) ----
  console.log("\nTest E — usage resets: a PAUSED task auto-resumes with its prior session and completes");
  {
    const h = makeHarness();
    try {
      const { threadId, session } = seedFrozenTask(h, "paused");
      h.mgr.setSettings({ autoResumeOnTokenReset: true, autoResumeThresholdPercent: 80 });
      const resetAt = Date.now() + 3_600_000;
      h.stub.util = 90;
      h.stub.reset = resetAt;
      h.stub.headroom = false;
      h.stub.fireUsageRefresh();
      check("armed while frozen", h.db.kvGet(WAKEUP_KEY) === String(resetAt));

      // Step 3: the window resets — utilization drops and an account regains headroom.
      h.stub.util = 5;
      h.stub.headroom = true;

      // Step 4: the armed wakeup fires (what the reset+buffer timer would invoke).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (h.mgr as any).fireTokenResume();
      await delay(120);

      const call = h.resumeCalls.find((c) => c.threadId === threadId);
      check("the resume fired for the frozen task", !!call, `calls=${JSON.stringify(h.resumeCalls)}`);
      check(
        "resume re-entered with the PRIOR session (warm resume, not a cold restart)",
        call?.resumeSession === session,
        `resumeSession=${call?.resumeSession} expected=${session}`,
      );
      check("the resumed task ran to completion ('done')", h.db.getThread(threadId)?.state === "done", `state=${h.db.getThread(threadId)?.state}`);
      check("the wakeup was consumed (kv cleared after firing)", !h.db.kvGet(WAKEUP_KEY), `kv=${h.db.kvGet(WAKEUP_KEY)}`);
      check(
        "the reset+resume was announced to the owner",
        h.logs.some((l) => /Token window reset\. Resuming/i.test(l)),
        h.logs.filter((l) => /reset|resum/i.test(l)).slice(-3).join(" | "),
      );
    } finally {
      h.dispose();
    }
  }

  // -- Test F: the other freeze outcome — a cap-parked 'review' task auto-resumes the same way ---------
  console.log("\nTest F — usage resets: a CAP-PARKED 'review' task auto-resumes with its prior session");
  {
    const h = makeHarness();
    try {
      const { threadId, session } = seedFrozenTask(h, "review", /* capParked */ true);
      h.mgr.setSettings({ autoResumeOnTokenReset: true, autoResumeThresholdPercent: 80 });
      const resetAt = Date.now() + 3_600_000;
      h.stub.util = 92;
      h.stub.reset = resetAt;
      h.stub.headroom = false;
      h.stub.fireUsageRefresh();
      check("armed while cap-parked", h.db.kvGet(WAKEUP_KEY) === String(resetAt));
      check("the cap-park marker is on the parked task", (h.db.getThread(threadId)?.error ?? "").startsWith(CAP_PARK_PREFIX));

      h.stub.util = 4;
      h.stub.headroom = true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (h.mgr as any).fireTokenResume();
      await delay(150);

      const call = h.resumeCalls.find((c) => c.threadId === threadId);
      check("the cap-parked task resumed", !!call);
      check("cap-park resume carried the prior session (context intact)", call?.resumeSession === session, `resumeSession=${call?.resumeSession} expected=${session}`);
      check("the resumed task reached completion ('done')", h.db.getThread(threadId)?.state === "done", `state=${h.db.getThread(threadId)?.state}`);
    } finally {
      h.dispose();
    }
  }

  // -- Test G: durability — a frozen+armed resume survives a server restart (new manager re-arms) -----
  console.log("\nTest G — the armed resume survives a server restart (re-armed from the DB on boot)");
  {
    const dir = mkdtempSync(join(tmpdir(), "tf-resume-restart-"));
    const dbPath = join(dir, "orchestrator.sqlite");
    const workspace = join(dir, "workspace");
    mkdirSync(workspace, { recursive: true });
    const restartResetAt = Date.now() + 3_600_000;
    try {
      // Boot #1: enable, freeze, arm — then "crash" (drop the manager, keep the DB).
      {
        const db = new Db(dbPath);
        const hub = new EventHub();
        const stub = new StubAccounts();
        const mgr = new ThreadManager(db, hub, new FileMemoryService(join(dir, "memory")), stub as unknown as AccountManager);
        mgr.setSettings({ autoResumeOnTokenReset: true, autoResumeThresholdPercent: 80 });
        stub.util = 95;
        stub.reset = restartResetAt;
        stub.fireUsageRefresh();
        check("armed on the first boot", db.kvGet(WAKEUP_KEY) === String(restartResetAt));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const t1 = mgr as any;
        if (t1.capSupervisor) clearInterval(t1.capSupervisor);
        if (t1.tokenResumeTimer) clearTimeout(t1.tokenResumeTimer);
        db.raw.close();
      }
      // Boot #2: a fresh manager over the SAME DB (the restart) must re-arm from the persisted epoch.
      {
        const db = new Db(dbPath);
        const hub = new EventHub();
        const logs: string[] = [];
        hub.subscribe((e) => {
          if (e.type === "log") logs.push(e.message);
        });
        const stub = new StubAccounts();
        const mgr = new ThreadManager(db, hub, new FileMemoryService(join(dir, "memory")), stub as unknown as AccountManager);
        check("the wakeup epoch persisted across the restart", db.kvGet(WAKEUP_KEY) === String(restartResetAt), `kv=${db.kvGet(WAKEUP_KEY)}`);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const armedFor = (mgr as any).tokenResumeArmedFor as number | undefined;
        check("the new boot re-armed the in-memory resume latch", armedFor === restartResetAt, `armedFor=${armedFor}`);
        check(
          "the restart re-arm was logged",
          logs.some((l) => /Re-arming token-reset auto-resume after a restart/i.test(l)),
          logs.filter((l) => /restart|re-arm/i.test(l)).join(" | "),
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const t2 = mgr as any;
        if (t2.capSupervisor) clearInterval(t2.capSupervisor);
        if (t2.tokenResumeTimer) clearTimeout(t2.tokenResumeTimer);
        db.raw.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // ---- summary --------------------------------------------------------------------------------------
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
