/**
 * Integration test — the per-thread bookkeeping leak fix (`ThreadManager.dropTerminalBookkeeping`).
 *
 * Background: three in-memory structures keyed by thread id — `capResumeNotifiedAt` (cap-resume notify
 * throttle), `lastImplementorSession` (the implementor SDK session cache), and `checkedIn` (the office
 * check-in dedupe, keyed `${threadId}:${role}`) — were cleared ONLY on `retryThread`. Every task that ran
 * and settled to done/cancelled/closed/dismissed WITHOUT a later retry therefore leaked one entry each for
 * the whole process lifetime. On a server that dispatches thousands of tasks over weeks that is a slow but
 * genuinely unbounded climb — exactly the "growing maps of task state → OOM after random uptime" crash
 * vector. The fix drops all three from every TRULY-terminal exit while deliberately KEEPING them for the
 * transient 'failed' re-entry state and the resumable parked states (review/paused).
 *
 * WHAT IS REAL: a real on-disk SQLite Db and a real ThreadManager (full object graph, minus the timers/web).
 * No agents are spawned — the test drives the terminal transitions directly and asserts the private maps
 * drain (or, for the states that must stay resumable, DON'T drain). The private maps are read/poked via a
 * typed view so the test asserts the actual leak surface, not a proxy.
 *
 * Scenarios:
 *   A. HELPER   — dropTerminalBookkeeping drains all three maps for the given thread and leaves others' entries.
 *   B. TERMINAL — setState('done') and setState('cancelled') drain; the public closeThread + dismissThread drain.
 *   C. NON-TERMINAL — setState('failed'|'review'|'paused'|'implementing') must NOT drain (still resumable).
 *
 * Run:  npm run test:leak-bookkeeping   (from server/)   — or:  npx tsx src/tests/threadBookkeepingLeak.itest.ts
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
import type { Thread } from "../types.js";

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

// A typed view onto the three private maps under test — this IS the leak surface, so poke/read it directly.
type LeakMaps = {
  capResumeNotifiedAt: Map<string, number>;
  lastImplementorSession: Map<string, string>;
  checkedIn: Set<string>;
  setState(id: string, state: Thread["state"], error?: string | null): void;
  dropTerminalBookkeeping(id: string): void;
};

const ROLES = ["planner", "researcher", "implementor", "qa"] as const;

const dir = mkdtempSync(join(tmpdir(), "leak-bookkeeping-"));
const db = new Db(join(dir, "t.sqlite"));
const hub = new EventHub();
const memory = new FileMemoryService();
const accounts = new AccountManager(config.accounts, hub, config.accountPingMs, {
  stagger: new ResetStagger(),
  persist: { load: () => null, save: () => {} },
});
// NB: accounts.start() is deliberately NOT called — no pings/timers, so the process stays deterministic.
const manager = new ThreadManager(db, hub, memory, accounts);
const priv = manager as unknown as LeakMaps;

/** Seed all three leak maps with entries for a thread, as a real run would (init event, cap-resume, check-in). */
function poke(id: string): void {
  priv.capResumeNotifiedAt.set(id, Date.now());
  priv.lastImplementorSession.set(id, `sess-${id}`);
  for (const role of ROLES) priv.checkedIn.add(`${id}:${role}`);
}
/** True iff NONE of the three maps still reference the thread. */
function drained(id: string): boolean {
  return (
    !priv.capResumeNotifiedAt.has(id) &&
    !priv.lastImplementorSession.has(id) &&
    ROLES.every((role) => !priv.checkedIn.has(`${id}:${role}`))
  );
}
/** True iff ALL three maps still reference the thread (nothing was dropped). */
function retained(id: string): boolean {
  return (
    priv.capResumeNotifiedAt.has(id) &&
    priv.lastImplementorSession.has(id) &&
    ROLES.every((role) => priv.checkedIn.has(`${id}:${role}`))
  );
}
function newThread(state: Thread["state"]): string {
  const t = db.createThread({ title: `t-${state}`, workspace: dir, rawPrompt: "x" });
  db.updateThread(t.id, { state });
  return t.id;
}

// ---- A. the helper itself ---------------------------------------------------------------------------
console.log("\nA. dropTerminalBookkeeping drains all three maps for the target thread only");
{
  const a = newThread("done");
  const b = newThread("review");
  poke(a);
  poke(b);
  priv.dropTerminalBookkeeping(a);
  check("target thread is fully drained", drained(a));
  check("a bystander thread's entries are untouched", retained(b));
}

// ---- B. terminal transitions drain ------------------------------------------------------------------
console.log("\nB. every terminal exit drains the bookkeeping");
{
  const id = newThread("review");
  poke(id);
  priv.setState(id, "done");
  check("setState('done') drains", drained(id));
}
{
  const id = newThread("implementing");
  poke(id);
  priv.setState(id, "cancelled");
  check("setState('cancelled') drains", drained(id));
}
{
  const id = newThread("review");
  poke(id);
  await manager.closeThread(id);
  check("closeThread() drains (settles via db, not setState)", drained(id));
  check("closeThread() actually closed the row", db.getThread(id)?.state === "closed");
}
{
  const id = newThread("review");
  poke(id);
  manager.dismissThread(id);
  check("dismissThread() drains", drained(id));
  check("dismissThread() actually deleted the row", !db.getThread(id));
}

// ---- C. non-terminal / resumable transitions must NOT drain -----------------------------------------
console.log("\nC. transient + resumable states keep the session cache warm (must NOT drain)");
for (const state of ["failed", "review", "paused", "implementing"] as const) {
  const id = newThread("implementing");
  poke(id);
  priv.setState(id, state);
  check(`setState('${state}') retains (still resumable / transient re-entry)`, retained(id));
}

// ---- summary ----------------------------------------------------------------------------------------
try {
  db.raw.close(); // release the sqlite file handle so Windows lets the temp dir go
} catch {
  /* already closed */
}
try {
  rmSync(dir, { recursive: true, force: true });
} catch {
  // Windows can still hold a transient lock on the just-closed DB file — the OS reaps the temp dir,
  // and a leftover throwaway dir must never fail the assertions themselves.
}
console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} checks passed, ${failed} failed`);
if (failed) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
process.exit(0);
