/**
 * Integration test — concurrency SLOT ACCOUNTING: the operator's "Max concurrent tasks" setting must
 * mean exactly what it says, and a task that stops working must give its slot back.
 *
 * The bug this guards (2026-09-17): `activePipelines` was only ever decremented by the `releaseSlot()`
 * closure inside the owning run promise's `finally`. Any task that left its work states without that
 * promise unwinding — a park whose provider await outlived it, an exception escaping a reservation
 * prologue — held its slot for the life of the process. With one leaked slot a cap of 4 let only 3 tasks
 * leave the queue, with two leaked slots only 2, and nothing but a restart ever gave them back.
 *
 * WHAT IS REAL vs. STUBBED
 *  - REAL: `enqueueOrRun` + `pumpQueue` + `reservePipelineSlot`/`releasePipelineSlot` + the state-driven
 *    release in `publishState`, plus the real `setState`, `cancelThread`, `closeThread`, `dismissThread`,
 *    `markDone`, `injectThread`, `interruptThread`, `setSettings` and the real `Db`/`EventHub`.
 *  - STUBBED: only `startPipeline`, the agent-spawning leaf. It reserves the slot exactly like
 *    runPipeline's top and then NEVER releases — i.e. it models precisely the run promise that does not
 *    unwind. So every "the slot came back" assertion below is earned by the state machine alone.
 *
 * Run:  npm run test:slots   (from server/)   — or:  npx tsx src/tests/concurrencySlots.itest.ts
 * Exits non-zero if any assertion fails. Self-contained: creates a throwaway DB and removes it.
 */

process.env.CAP_RETRY_MS = "0"; // no cap-supervisor interval during the test
process.env.ACCOUNT_PING_MS = "3600000";
process.env.FAST_ACCOUNT_PING_MS = "3600000";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountManager } from "../accounts/accountManager.js";
import type { ThreadState } from "../types.js";

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
  setProfileToken(_id: string, _token: string): void {}
}

interface Harness {
  mgr: InstanceType<typeof ThreadManager>;
  db: InstanceType<typeof Db>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  internals: any;
  dispatch(title: string, workspace?: string): string;
  setState(id: string, state: ThreadState): void;
  state(id: string): string | undefined;
  slotHeld(id: string): boolean;
  slots(): number;
  dispose(): void;
}

const REPO = "C:/repos/slots";

/** A ThreadManager whose startPipeline leaf reserves a slot and never gives it back — the exact shape of
 *  a run promise that outlives the task. Everything that hands the slot back must therefore be the
 *  state machine, which is what these tests are about. */
function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "slots-"));
  const db = new Db(join(dir, "orchestrator.sqlite"));
  const hub = new EventHub();
  const memory = new FileMemoryService(join(dir, "memory"));
  const mgr = new ThreadManager(db, hub, memory, new StubAccounts() as unknown as AccountManager);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = mgr as any;
  internals.startPipeline = (id: string): void => {
    internals.reservePipelineSlot(id); // the release is deliberately discarded
    internals.setState(id, "implementing");
  };

  return {
    mgr,
    db,
    internals,
    dispatch(title, workspace = REPO) {
      const t = db.createThread({ title, workspace, rawPrompt: "do the thing" });
      internals.enqueueOrRun(t.id);
      return t.id;
    },
    setState(id, state) {
      internals.setState(id, state);
    },
    state(id) {
      return db.getThread(id)?.state;
    },
    slotHeld(id) {
      return internals.activePipelines.has(id);
    },
    slots() {
      return internals.activePipelines.size;
    },
    dispose() {
      if (internals.capSupervisor) clearInterval(internals.capSupervisor);
      db.raw.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Every thread state, and whether a task in it may occupy a concurrency slot. The work states hold one
 *  (an agent is live, or the pipeline is about to make one live); the parked and settled states must not
 *  — those are exactly the tasks that used to sit on a slot forever. */
const OCCUPANCY: ReadonlyArray<[ThreadState, boolean]> = [
  ["intake", true],
  ["enriching", true],
  ["queued", true], // runPipeline reserves while the row still reads 'queued'
  ["planning", true],
  ["researching", true],
  ["awaiting_approval", true],
  ["implementing", true],
  ["qa", true],
  ["reviewing", true],
  ["awaiting_user", true],
  ["review", false],
  ["paused", false],
  ["failed", false],
  ["done", false],
  ["cancelled", false],
  ["closed", false],
];

async function main(): Promise<void> {
  console.log("\n=== concurrency slot accounting — integration test (real queue + state machine) ===\n");

  // -- Test A: the cap is exact — N configured means N active, not N-1 --------------------------------
  console.log("Test A — the boundary at N: a cap of 4 runs exactly 4 tasks, and the 5th waits");
  {
    const h = makeHarness();
    try {
      h.mgr.setSettings({ maxConcurrent: 4, maxConcurrentPerRepo: 0 });
      const ids = [1, 2, 3, 4, 5].map((n) => h.dispatch(`T${n}`));
      const running = ids.filter((id) => h.state(id) === "implementing");
      check("exactly 4 tasks left the queue (not 3)", running.length === 4, `running=${running.length}`);
      check("the 5th is queued", h.state(ids[4]!) === "queued", `state=${h.state(ids[4]!)}`);
      check("4 slots are held", h.slots() === 4, `slots=${h.slots()}`);
    } finally {
      h.dispose();
    }
  }
  {
    // The off-by-one check at the bottom of the range: a cap of 1 must still start one task.
    const h = makeHarness();
    try {
      h.mgr.setSettings({ maxConcurrent: 1, maxConcurrentPerRepo: 0 });
      const a = h.dispatch("A");
      const b = h.dispatch("B");
      check("cap 1 starts exactly one task", h.state(a) === "implementing" && h.state(b) === "queued");
    } finally {
      h.dispose();
    }
  }

  // -- Test B: state-by-state occupancy ---------------------------------------------------------------
  console.log("\nTest B — every state, counted or not counted toward the cap");
  for (const [state, occupies] of OCCUPANCY) {
    const h = makeHarness();
    try {
      h.mgr.setSettings({ maxConcurrent: 2, maxConcurrentPerRepo: 0 });
      const id = h.dispatch(`in-${state}`);
      h.setState(id, state);
      check(
        `'${state}' ${occupies ? "occupies" : "does NOT occupy"} a slot`,
        h.slotHeld(id) === occupies,
        `held=${h.slotHeld(id)}`,
      );
    } finally {
      h.dispose();
    }
  }

  // -- Test C: a parked/settled task frees its slot for the queue, with no restart ---------------------
  console.log("\nTest C — the leak regression: a task that stops working releases its slot to the queue");
  for (const state of ["review", "paused", "failed", "done", "cancelled"] as ThreadState[]) {
    const h = makeHarness();
    try {
      h.mgr.setSettings({ maxConcurrent: 1, maxConcurrentPerRepo: 0 });
      const first = h.dispatch("first");
      const waiting = h.dispatch("waiting");
      h.setState(first, state);
      check(
        `${state}: the queued task started on the freed slot`,
        h.state(waiting) === "implementing" && h.slots() === 1,
        `waiting=${h.state(waiting)} slots=${h.slots()}`,
      );
    } finally {
      h.dispose();
    }
  }
  {
    const h = makeHarness();
    try {
      h.mgr.setSettings({ maxConcurrent: 1, maxConcurrentPerRepo: 0 });
      const first = h.dispatch("first");
      const waiting = h.dispatch("waiting");
      await h.mgr.cancelThread(first);
      check(
        "cancelThread released the slot",
        !h.slotHeld(first) && h.state(waiting) === "implementing",
        `waiting=${h.state(waiting)}`,
      );
    } finally {
      h.dispose();
    }
  }
  {
    // closeThread settles through the DB, not setState — it must release the slot itself.
    const h = makeHarness();
    try {
      h.mgr.setSettings({ maxConcurrent: 1, maxConcurrentPerRepo: 0 });
      const first = h.dispatch("first");
      h.setState(first, "paused");
      const waiting = h.dispatch("waiting");
      h.internals.activePipelines.add(first); // a slot the park did not hand back
      await h.mgr.closeThread(first);
      check("closeThread released the slot", !h.slotHeld(first), `slots=${h.slots()}`);
      check("the queued task ran after the close", h.state(waiting) === "implementing", `waiting=${h.state(waiting)}`);
    } finally {
      h.dispose();
    }
  }
  {
    const h = makeHarness();
    try {
      h.mgr.setSettings({ maxConcurrent: 1, maxConcurrentPerRepo: 0 });
      const first = h.dispatch("first");
      h.setState(first, "review");
      const waiting = h.dispatch("waiting");
      h.internals.activePipelines.add(first); // a slot the park did not hand back
      await h.mgr.markDone(first);
      check("markDone released the slot", !h.slotHeld(first) && h.state(first) === "done", `state=${h.state(first)}`);
      check("the queued task ran after the manual done", h.state(waiting) === "implementing", `waiting=${h.state(waiting)}`);
    } finally {
      h.dispose();
    }
  }
  {
    const h = makeHarness();
    try {
      h.mgr.setSettings({ maxConcurrent: 1, maxConcurrentPerRepo: 0 });
      const first = h.dispatch("first");
      h.setState(first, "review");
      h.internals.activePipelines.add(first); // a slot the park did not hand back
      h.mgr.dismissThread(first);
      check("dismissThread released the slot", !h.slotHeld(first) && h.slots() === 0, `slots=${h.slots()}`);
    } finally {
      h.dispose();
    }
  }

  // -- Test D: a settings change applies live, with no restart ----------------------------------------
  console.log("\nTest D — changing the cap takes effect immediately");
  {
    const h = makeHarness();
    try {
      h.mgr.setSettings({ maxConcurrent: 2, maxConcurrentPerRepo: 0 });
      const ids = [1, 2, 3, 4].map((n) => h.dispatch(`T${n}`));
      check("2 running under the initial cap", h.slots() === 2, `slots=${h.slots()}`);
      h.mgr.setSettings({ maxConcurrent: 4 });
      check("raising the cap to 4 started both queued tasks at once", h.slots() === 4, `slots=${h.slots()}`);
      check("every task is now implementing", ids.every((id) => h.state(id) === "implementing"));
      // Lowering the cap never stops running work, but it must stop admitting new work.
      h.mgr.setSettings({ maxConcurrent: 2 });
      const extra = h.dispatch("T5");
      check("lowering the cap queues the next dispatch", h.state(extra) === "queued", `state=${h.state(extra)}`);
    } finally {
      h.dispose();
    }
  }

  // -- Test E: injecting into a task that is still waiting for a slot ---------------------------------
  console.log("\nTest E — an inject on a queued task holds the message and never strands the task");
  for (const mode of ["append", "interrupt"] as const) {
    const h = makeHarness();
    try {
      h.mgr.setSettings({ maxConcurrent: 1, maxConcurrentPerRepo: 0 });
      const first = h.dispatch("first");
      const waiting = h.dispatch("waiting");
      const note = `steer me (${mode})`;
      const res = await h.mgr.injectThread(waiting, note, mode, undefined, { retitle: false });
      check(`${mode}: the inject was accepted`, res.ok === true, JSON.stringify(res));
      check(`${mode}: the task is still queued (state untouched)`, h.state(waiting) === "queued", `state=${h.state(waiting)}`);
      check(`${mode}: the message is buffered for the implementor`, (h.internals.directorNotes.get(waiting) ?? []).includes(note));
      check(`${mode}: it is still in the dispatch queue`, h.internals.dispatchQueue.includes(waiting));
      h.setState(first, "done");
      check(`${mode}: the scheduler still picked it up`, h.state(waiting) === "implementing", `state=${h.state(waiting)}`);
      check(`${mode}: the buffered message survived to the start`, (h.internals.directorNotes.get(waiting) ?? []).includes(note));
    } finally {
      h.dispose();
    }
  }
  {
    // 'queue' mode on a task that has never reached an implementor must not fake a QA hand-back.
    const h = makeHarness();
    try {
      h.mgr.setSettings({ maxConcurrent: 1, maxConcurrentPerRepo: 0 });
      h.dispatch("first");
      const waiting = h.dispatch("waiting");
      await h.mgr.injectThread(waiting, "do this too", "queue", undefined, { retitle: false });
      check("queue mode buffered it as a director note", (h.internals.directorNotes.get(waiting) ?? []).includes("do this too"));
      check(
        "queue mode did NOT invent a QA fix-handoff",
        h.db.getThreadStageOutputs(waiting).qaFixHandoff == null && !h.internals.qaFixHandoff.has(waiting),
      );
    } finally {
      h.dispose();
    }
  }
  {
    // Interrupting a task that hasn't started is not an error, and must not pause it out of the queue.
    const h = makeHarness();
    try {
      h.mgr.setSettings({ maxConcurrent: 1, maxConcurrentPerRepo: 0 });
      const first = h.dispatch("first");
      const waiting = h.dispatch("waiting");
      const res = await h.mgr.interruptThread(waiting);
      check("interrupt on a queued task succeeds instead of erroring", res.ok === true, JSON.stringify(res));
      check("it explains that the task has not started", (res.message ?? "").includes("started"), res.message ?? "(no message)");
      check("the task is still queued", h.state(waiting) === "queued", `state=${h.state(waiting)}`);
      h.setState(first, "done");
      check("and it still starts when a slot frees", h.state(waiting) === "implementing", `state=${h.state(waiting)}`);
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
