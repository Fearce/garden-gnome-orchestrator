/**
 * Integration test — the per-repo concurrency cap (`maxConcurrentPerRepo`) gates dispatch by REPO, on
 * top of the global `maxConcurrent`, using the real ThreadManager queue machinery.
 *
 * Guards the "Concurrent repo tasks" setting: with the cap at 1, a second task for a repo already
 * running one waits in 'queued' until the first finishes — while tasks in OTHER repos keep running up
 * to the global cap (no head-of-line blocking). 0 = unlimited (only the global cap applies).
 *
 * WHAT IS REAL vs. STUBBED
 *  - REAL: `enqueueOrRun` + `pumpQueue` + `repoAtCapacity`/`activeCountForRepo` — the whole queue gate,
 *    the FIFO scan that skips a repo-blocked task without blocking a free repo behind it, and the real
 *    `Db` + `EventHub` state behind them. Settings are set through the real `setSettings`.
 *  - STUBBED: only `startPipeline`, the agent-spawning leaf — replaced with one that occupies a slot
 *    (adds to activePipelines + flips state to 'implementing') so we control exactly when a "pipeline"
 *    finishes, without spawning a real `claude`. `finishTask` mirrors runPipeline's releaseSlot.
 *
 * Run:  npm run test:per-repo   (from server/)   — or:  npx tsx src/tests/perRepoConcurrency.itest.ts
 * Exits non-zero if any assertion fails. Self-contained: creates a throwaway DB and removes it.
 */

process.env.CAP_RETRY_MS = "0"; // no cap-supervisor interval during the test
process.env.ACCOUNT_PING_MS = "3600000";
process.env.FAST_ACCOUNT_PING_MS = "3600000";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountManager } from "../accounts/accountManager.js";

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
}

interface Harness {
  mgr: InstanceType<typeof ThreadManager>;
  db: InstanceType<typeof Db>;
  dir: string;
  started: string[]; // thread ids handed to startPipeline, in order
  dispatch(workspace: string, title: string): string; // seed + enqueueOrRun; returns id
  finishTask(id: string): void; // release the slot + pump the queue, like runPipeline's releaseSlot
  state(id: string): string | undefined;
  dispose(): void;
}

/** A ThreadManager whose startPipeline leaf is stubbed (occupies a slot, no real agent) but whose
 *  enqueue/pump/per-repo-gate machinery is 100% real. */
function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "per-repo-"));
  const db = new Db(join(dir, "orchestrator.sqlite"));
  const hub = new EventHub();
  const memory = new FileMemoryService(join(dir, "memory"));
  const mgr = new ThreadManager(db, hub, memory, new StubAccounts() as unknown as AccountManager);

  const started: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = mgr as any;
  // Stubbed pipeline start: reserve the concurrency slot exactly like runPipeline's top (add to
  // activePipelines, stamp the slot token, flip state) but spawn nothing. The token lets finishTask
  // release only its own slot, matching the real releaseSlot's supersede guard.
  internals.startPipeline = (id: string): void => {
    started.push(id);
    internals.activePipelines.add(id);
    internals.activePipelineToken.set(id, Symbol("test-slot"));
    internals.setState(id, "implementing");
  };

  return {
    mgr,
    db,
    dir,
    started,
    dispatch(workspace, title) {
      const t = db.createThread({ title, workspace, rawPrompt: "do the thing" });
      internals.enqueueOrRun(t.id);
      return t.id;
    },
    finishTask(id) {
      internals.activePipelineToken.delete(id);
      internals.activePipelines.delete(id);
      internals.setState(id, "done");
      internals.pumpQueue();
    },
    state(id) {
      return db.getThread(id)?.state;
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

const REPO_A = "C:/repos/alpha";
const REPO_B = "C:/repos/beta";

async function main(): Promise<void> {
  console.log("\n=== per-repo concurrency cap — integration test (real queue machinery) ===\n");

  // -- Test A: cap 1 serializes a repo, but a different repo still runs concurrently ------------------
  console.log("Test A — per-repo cap 1: same-repo second task queues; a different repo runs alongside");
  {
    const h = makeHarness();
    try {
      h.mgr.setSettings({ maxConcurrent: 5, maxConcurrentPerRepo: 1 });
      const a1 = h.dispatch(REPO_A, "A1");
      const a2 = h.dispatch(REPO_A, "A2");
      const b1 = h.dispatch(REPO_B, "B1");
      check("A1 started (repo A had a free slot)", h.state(a1) === "implementing", `state=${h.state(a1)}`);
      check("A2 queued (repo A already at its per-repo cap of 1)", h.state(a2) === "queued", `state=${h.state(a2)}`);
      check("B1 started (different repo, below the global cap)", h.state(b1) === "implementing", `state=${h.state(b1)}`);

      // A1 finishes → the queued A2 for the same repo should now start.
      h.finishTask(a1);
      check("A2 started once A1 finished", h.state(a2) === "implementing", `state=${h.state(a2)}`);
    } finally {
      h.dispose();
    }
  }

  // -- Test B: a repo-blocked head does not block a different-repo task behind it in the queue --------
  console.log("\nTest B — no head-of-line blocking: a repo-blocked queued task is skipped for a free repo");
  {
    const h = makeHarness();
    try {
      h.mgr.setSettings({ maxConcurrent: 5, maxConcurrentPerRepo: 1 });
      const a1 = h.dispatch(REPO_A, "A1"); // runs (repo A slot)
      const a2 = h.dispatch(REPO_A, "A2"); // queued behind A1 (repo A at cap)
      // With A1 running and A2 queued at the FRONT of the queue for the blocked repo A, dispatching a
      // repo-B task must NOT wait behind A2 — it should start immediately.
      const b1 = h.dispatch(REPO_B, "B1");
      check("A1 running", h.state(a1) === "implementing", `state=${h.state(a1)}`);
      check("A2 still queued (repo A blocked)", h.state(a2) === "queued", `state=${h.state(a2)}`);
      check("B1 jumped past the blocked A2 and started", h.state(b1) === "implementing", `state=${h.state(b1)}`);
    } finally {
      h.dispose();
    }
  }

  // -- Test C: the global cap still applies even across different repos -------------------------------
  console.log("\nTest C — the global maxConcurrent still gates, independent of the per-repo cap");
  {
    const h = makeHarness();
    try {
      h.mgr.setSettings({ maxConcurrent: 1, maxConcurrentPerRepo: 0 }); // per-repo unlimited
      const a1 = h.dispatch(REPO_A, "A1");
      const b1 = h.dispatch(REPO_B, "B1");
      check("A1 started", h.state(a1) === "implementing", `state=${h.state(a1)}`);
      check("B1 queued by the global cap of 1 (different repo, but no global slot)", h.state(b1) === "queued", `state=${h.state(b1)}`);
      h.finishTask(a1);
      check("B1 started once the global slot freed", h.state(b1) === "implementing", `state=${h.state(b1)}`);
    } finally {
      h.dispose();
    }
  }

  // -- Test D: cap 0 (default) = unlimited per repo — same-repo tasks all run up to the global cap ----
  console.log("\nTest D — per-repo cap 0 (default): same-repo tasks run concurrently up to the global cap");
  {
    const h = makeHarness();
    try {
      h.mgr.setSettings({ maxConcurrent: 5, maxConcurrentPerRepo: 0 });
      const a1 = h.dispatch(REPO_A, "A1");
      const a2 = h.dispatch(REPO_A, "A2");
      const a3 = h.dispatch(REPO_A, "A3");
      check("A1 running", h.state(a1) === "implementing", `state=${h.state(a1)}`);
      check("A2 running (per-repo unlimited)", h.state(a2) === "implementing", `state=${h.state(a2)}`);
      check("A3 running (per-repo unlimited)", h.state(a3) === "implementing", `state=${h.state(a3)}`);
    } finally {
      h.dispose();
    }
  }

  // -- Test E: cap 2 — a third same-repo task queues until one of the two finishes --------------------
  console.log("\nTest E — per-repo cap 2: a third same-repo task queues until one of the two frees a slot");
  {
    const h = makeHarness();
    try {
      h.mgr.setSettings({ maxConcurrent: 10, maxConcurrentPerRepo: 2 });
      const a1 = h.dispatch(REPO_A, "A1");
      const a2 = h.dispatch(REPO_A, "A2");
      const a3 = h.dispatch(REPO_A, "A3");
      check("A1 + A2 running (repo A cap 2)", h.state(a1) === "implementing" && h.state(a2) === "implementing");
      check("A3 queued (repo A at cap 2)", h.state(a3) === "queued", `state=${h.state(a3)}`);
      h.finishTask(a2);
      check("A3 started once a repo-A slot freed", h.state(a3) === "implementing", `state=${h.state(a3)}`);
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
