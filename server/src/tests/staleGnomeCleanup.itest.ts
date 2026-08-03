/**
 * Integration test — stale "working gnome" cleanup (the active-agent state that never cleared).
 *
 * Background: the console's top-bar gnome strip draws any `agent_runs` row whose `state` is
 * `starting`/`running` — it filters on state, NOT on `ended_at`. A run is finalized (endedAt + terminal
 * state) by `finishRun`/`finalizeRun`, which run OUTSIDE the per-run event listener wired in `wireRun`.
 * If a late buffered agent event (an `init`/`text`/`result` flushed as the SDK session tore down) reached
 * that listener AFTER finalization, `markRunning` flipped the row back to `state="running"` while
 * `ended_at` stayed set. That corrupted row (a) shows as a working gnome forever and (b) is invisible to
 * the boot reconciler `markInterrupted`, whose `listActiveRuns` query requires `ended_at IS NULL` — so it
 * survived a full server restart. Exactly the reported "Bram stuck on a closed task" symptom.
 *
 * Two fixes, both asserted here:
 *   A. ROOT CAUSE — `wireRun` routes every state-bearing agent-event write through a guard that no-ops
 *      once the run has an `endedAt`. A finalized run can no longer be resurrected into a live state.
 *   B. BACKSTOP — `markInterrupted` (boot) sweeps `listEndedButLiveStateRuns()` and stamps any
 *      already-ended-but-live-state row terminal, enforcing "an ended run has a terminal state". This
 *      cleans corruption left by any missed path, restart included.
 *
 * WHAT IS REAL: a real on-disk SQLite Db and a real ThreadManager. No agents are spawned — Fix A drives a
 * stub AgentRunLike's event listener directly; Fix B seeds corrupted rows and lets the ctor reconcile.
 *
 * Revert-check (done by hand before commit): removing the `patchLiveRun` guard reds A; deleting the
 * `listEndedButLiveStateRuns` loop in `markInterrupted` reds B.
 *
 * Run:  npm run test:stale-gnomes   (from server/)   — or:  npx tsx src/tests/staleGnomeCleanup.itest.ts
 * Exits non-zero if any assertion fails. Self-contained: throwaway DB in a temp dir, removed on exit.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { Db } = await import("../db/db.js");
const { EventHub } = await import("../events.js");
const { FileMemoryService } = await import("../memory/memory.js");
const { AccountManager } = await import("../accounts/accountManager.js");
const { ResetStagger } = await import("../accounts/resetStagger.js");
const { ThreadManager } = await import("../orchestrator/threadManager.js");
const { config } = await import("../config.js");
import type { AgentEvent, AgentRun, Role } from "../types.js";
import type { AgentRunLike } from "../agents/runner.js";

// ---- tiny assertion harness ------------------------------------------------------------------------
let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    failures.push(label + (detail ? ` — ${detail}` : ""));
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const LIVE_STATES = new Set(["starting", "running", "idle"]);

// ---- Fix B first: markInterrupted must run in the ctor AFTER the corrupted rows exist ---------------
const dir = mkdtempSync(join(tmpdir(), "stale-gnomes-"));
const db = new Db(join(dir, "t.sqlite"));

/** Seed a run row and force it into an arbitrary state/endedAt, as the corruption bug would leave it. */
function seedRun(threadId: string, patch: Partial<Pick<AgentRun, "state" | "endedAt">>): string {
  const r = db.createRun({ threadId, role: "implementor", model: "claude-opus-4-8" });
  db.updateRun(r.id, patch);
  return r.id;
}
console.log("\nB. boot reconciler sweeps ended-but-live-state runs (the restart-survival backstop)");
const closedA = db.createThread({ title: "closed-task", workspace: dir, rawPrompt: "x" });
db.updateThread(closedA.id, { state: "closed" });
// The exact reported bug: a "running" row on a closed task that ALREADY has an end time.
const corrupted = seedRun(closedA.id, { state: "running", endedAt: 1785713824950 });
// An idle-but-ended row is the same class (idle is a live run-state the strip/list treat as active).
const corruptedIdle = seedRun(closedA.id, { state: "idle", endedAt: 1785713138037 });
// Control 1: a genuinely-live run (no end time) — the EXISTING first loop must still stamp it interrupted.
const liveNoEnd = seedRun(closedA.id, { state: "running", endedAt: null });
// Control 2: a properly-finalized run — must be left exactly as-is.
const doneRun = seedRun(closedA.id, { state: "done", endedAt: 1785713900000 });

const hub = new EventHub();
const memory = new FileMemoryService();
const accounts = new AccountManager(config.accounts, hub, config.accountPingMs, {
  stagger: new ResetStagger(),
  persist: { load: () => null, save: () => {} },
});
// NB: accounts.start() deliberately NOT called — no pings/timers. All seeded threads are 'closed'
// (not IN_FLIGHT), so markInterrupted schedules no auto-resume/requeue timers either.
const manager = new ThreadManager(db, hub, memory, accounts); // ctor runs markInterrupted()

{
  const c = db.getRun(corrupted);
  check("corrupted running+ended row is no longer a live state", !!c && !LIVE_STATES.has(c.state), `state=${c?.state}`);
  check("corrupted row keeps its real end time (clock frozen, not reset)", c?.endedAt === 1785713824950, `endedAt=${c?.endedAt}`);
  const ci = db.getRun(corruptedIdle);
  check("corrupted idle+ended row is no longer a live state", !!ci && !LIVE_STATES.has(ci.state), `state=${ci?.state}`);
  const ln = db.getRun(liveNoEnd);
  check("genuinely-live (no end) row still reconciled by the first loop", ln?.state === "interrupted" && ln?.endedAt != null, `state=${ln?.state} endedAt=${ln?.endedAt}`);
  const d = db.getRun(doneRun);
  check("a properly-done run is left untouched", d?.state === "done" && d?.endedAt === 1785713900000, `state=${d?.state}`);
  check("nothing remains ended-but-live-state after boot", db.listEndedButLiveStateRuns().length === 0);
}

// ---- Fix A: a late event cannot resurrect a finalized run ------------------------------------------
type Priv = {
  wireRun(agent: AgentRunLike, threadId: string, runId: string, role: Role, accountId: string): void;
  finalizeRun(runId: string, agent: AgentRunLike): void;
};
const priv = manager as unknown as Priv;

/** Minimal AgentRunLike stub: records the event + end callbacks wireRun registers, replays them on demand. */
function stubAgent(): { agent: AgentRunLike; emit(e: AgentEvent): void; lastResult: unknown } {
  let onEvent: ((e: AgentEvent) => void) | null = null;
  const stub = {
    sessionId: "sess-late" as string | undefined,
    lastResult: undefined as unknown, // undefined ⇒ finalizeRun stamps 'interrupted' + endedAt
    onEvent(cb: (e: AgentEvent) => void) {
      onEvent = cb;
      return () => {
        onEvent = null;
      };
    },
    onEnd(_cb: () => void) {
      /* wireRun registers off() here; not needed for this drive */
    },
  };
  return {
    agent: stub as unknown as AgentRunLike,
    emit: (e: AgentEvent) => onEvent?.(e),
    lastResult: stub.lastResult,
  };
}

console.log("\nA. wireRun guard — a late agent event cannot flip a finalized run back to 'running'");
{
  const liveThread = db.createThread({ title: "live-task", workspace: dir, rawPrompt: "x" });
  db.updateThread(liveThread.id, { state: "implementing" });
  const run = db.createRun({ threadId: liveThread.id, role: "implementor", model: "claude-opus-4-8" });
  const s = stubAgent();
  priv.wireRun(s.agent, liveThread.id, run.id, "implementor", "acct-1");

  s.emit({ type: "init", sessionId: "sess-1" } as AgentEvent);
  check("run promoted to 'running' by the first init event", db.getRun(run.id)?.state === "running");

  // Finalize as the pipeline would (endedAt + terminal state), THEN a late buffered event arrives.
  priv.finalizeRun(run.id, s.agent);
  const finalized = db.getRun(run.id);
  check("run is finalized (endedAt set, terminal state)", finalized?.endedAt != null && !LIVE_STATES.has(finalized!.state), `state=${finalized?.state} endedAt=${finalized?.endedAt}`);
  const endedAtAfterFinalize = finalized?.endedAt ?? null;

  s.emit({ type: "init", sessionId: "sess-late" } as AgentEvent); // the resurrecting event
  s.emit({ type: "text_delta", text: "buffered tail" } as AgentEvent);
  s.emit({ type: "result", isError: false, costUsd: 1, numTurns: 3 } as AgentEvent);
  const after = db.getRun(run.id);
  check("late init did NOT flip the finalized run back to 'running'", !!after && !LIVE_STATES.has(after.state), `state=${after?.state}`);
  check("late events left the frozen end time intact", after?.endedAt === endedAtAfterFinalize, `endedAt=${after?.endedAt}`);
}

// ---- summary ----------------------------------------------------------------------------------------
try {
  db.raw.close();
} catch {
  /* already closed */
}
try {
  rmSync(dir, { recursive: true, force: true });
} catch {
  /* Windows can hold a transient lock; the OS reaps the temp dir. */
}
console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} checks passed, ${failed} failed`);
if (failed) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
process.exit(0);
