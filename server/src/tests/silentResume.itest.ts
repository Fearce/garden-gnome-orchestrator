/**
 * Integration test — a resumed implementor that comes back EMPTY must never read as a finish.
 *
 * The bug (task 955833b2, 2026-07-27, and two more like it): the implementor hit the per-session turn
 * ceiling, the auto-resume warm-resumed its session, and the resumed run returned `subtype: success` with
 * **0 turns, $0 and not one message** — the CLI loaded the session, emitted `system:init` and exited
 * without ever reaching the model. `awaitImplementorCompletion` only looped on a turn-limit stop or a
 * voluntary stall, so a hollow success ended the loop and half-finished work went straight to QA.
 *
 * WHAT IS REAL vs. SIMULATED
 *  - REAL: `awaitImplementorCompletion` itself — the silent detection (`ranSilently`, counted off the
 *    thread's persisted messages), the auto-resume loop and its budget, the `forceFresh` hand-off, the
 *    error result synthesized when the budget runs out, and the `agent_runs` stamp (`markSilentRun`).
 *    A real `Db` (temp file) and a real `EventHub` back all of it, and the run row is asserted through
 *    `classifyRun` from probe-run-errors.cjs so the orchestrator and the sweep can't drift apart.
 *  - SIMULATED: only the agent spawn — a fake `AgentRunLike` returns a canned result, and
 *    `startResumedImplementor` is intercepted to record what the loop asked for.
 *
 * Run:  npm run test:silent-resume   (from server/)   — or:  npx tsx src/tests/silentResume.itest.ts
 * Exits non-zero if any assertion fails. Self-contained: creates a throwaway DB + workspace and removes them.
 */

// Env must be set BEFORE config.js is first evaluated — so the app modules are dynamically imported below.
process.env.CAP_RETRY_MS = "0"; // no cap-supervisor interval or boot sweep interfering
process.env.ACCOUNT_PING_MS = "3600000";
process.env.FAST_ACCOUNT_PING_MS = "3600000";
process.env.MAX_AUTO_RESUMES = "2"; // keep the budget-exhaustion case to two cheap iterations

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountManager } from "../accounts/accountManager.js";
import type { AgentRunLike, ResultEvent } from "../agents/runner.js";
import type { Thread } from "../types.js";

const { Db } = await import("../db/db.js");
const { EventHub } = await import("../events.js");
const { FileMemoryService } = await import("../memory/memory.js");
const { ThreadManager } = await import("../orchestrator/threadManager.js");

const require_ = createRequire(import.meta.url);
const { classifyRun } = require_("../../scripts/probe-run-errors.cjs") as {
  classifyRun: (row: Record<string, unknown>) => string;
};

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

// ---- stubs -----------------------------------------------------------------------------------------

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

const SUCCESS: ResultEvent = { type: "result", subtype: "success", isError: false, result: "ok" };

/** The one leaf the pipeline can't run here: a spawned agent. Returns a canned result and records stops.
 *  `beforeResult` fires just before the result resolves — used to simulate the real runner's `onEnd`
 *  winning the race against the awaited result (it clears `this.live` and finalizes the run row). */
function fakeRun(res: ResultEvent = SUCCESS, beforeResult?: () => void): AgentRunLike {
  const run = {
    emitter: { on() {}, off() {}, once() {}, emit() {} },
    sessionId: "sess-1",
    finished: false,
    lastResult: res,
    rateLimited: false,
    rateLimitInfo: undefined,
    transientApiError: false,
    transientApiErrorMessage: undefined,
    start() {
      return run;
    },
    onEvent: () => () => {},
    onEnd: () => {},
    send() {},
    async interrupt() {},
    async setModel() {},
    async setPermissionMode() {},
    endInput() {},
    async stop() {},
    async result() {
      beforeResult?.();
      return res;
    },
    async nextResult() {
      beforeResult?.();
      return res;
    },
  };
  return run as unknown as AgentRunLike;
}

interface ResumeAsk {
  session: string | undefined;
  forceFresh: boolean;
  nudge: string;
}

interface Harness {
  mgr: InstanceType<typeof ThreadManager>;
  db: InstanceType<typeof Db>;
  thread: Thread;
  asks: ResumeAsk[];
  /** Drive what each successive resume produces: "silent" (no messages) or "works" (writes one). */
  script: ("silent" | "works")[];
  dispose(): void;
}

function makeHarness(script: ("silent" | "works")[]): Harness {
  const dir = mkdtempSync(join(tmpdir(), "silent-resume-"));
  const workspace = join(dir, "workspace");
  mkdirSync(workspace, { recursive: true });

  const db = new Db(join(dir, "orchestrator.sqlite"));
  const hub = new EventHub();
  const memory = new FileMemoryService(join(dir, "memory"));
  const mgr = new ThreadManager(db, hub, memory, new StubAccounts() as unknown as AccountManager);

  const thread = db.createThread({ title: "silent resume", workspace, rawPrompt: "p", brief: "b" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = mgr as any;
  internals.lastImplementorSession.set(thread.id, "sess-1");

  const asks: ResumeAsk[] = [];
  internals.startResumedImplementor = async (
    t: Thread,
    _kickoff: string,
    session: string | undefined,
    opts: { resumeNudge: string; forceFresh?: boolean },
  ) => {
    asks.push({ session, forceFresh: !!opts.forceFresh, nudge: opts.resumeNudge });
    const behaviour = script[asks.length - 1] ?? "silent";
    const run = db.createRun({ threadId: t.id, role: "implementor", model: "claude-opus-5", account: "a" });
    internals.live.set(t.id, { run: fakeRun(), runId: run.id, accountId: "a" });
    // A working resume writes output the way wireRun does; a silent one writes nothing at all.
    if (behaviour === "works") db.addMessage({ threadId: t.id, runId: run.id, role: "implementor", kind: "text", content: "Patched the file." });
    return { run: internals.live.get(t.id).run, runId: run.id, accountId: "a" };
  };

  return {
    mgr,
    db,
    thread,
    asks,
    script,
    dispose() {
      if (internals.capSupervisor) clearInterval(internals.capSupervisor);
      if (internals.tokenResumeTimer) clearTimeout(internals.tokenResumeTimer);
      db.raw.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Seed the first (pre-loop) implementor run + drive awaitImplementorCompletion the way the pipeline does.
 *  `endsFirst` reproduces the real ordering hazard: the run's `onEnd` fires BEFORE the awaited result is
 *  observed, so it has already cleared the live handle and stamped the row `done`/`endedAt`. */
async function drive(h: Harness, firstProduces: boolean, endsFirst = false): Promise<ResultEvent | undefined> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = h.mgr as any;
  const run = h.db.createRun({ threadId: h.thread.id, role: "implementor", model: "claude-opus-5", account: "a" });
  const onEnd = endsFirst
    ? () => {
        if (internals.live.get(h.thread.id)?.runId !== run.id) return; // already replaced by a relaunch
        internals.live.delete(h.thread.id);
        h.db.updateRun(run.id, { state: "done", endedAt: Date.now(), numTurns: 0, costUsd: 0 });
      }
    : undefined;
  const agent = fakeRun(SUCCESS, onEnd);
  internals.live.set(h.thread.id, { run: agent, runId: run.id, accountId: "a" });
  if (firstProduces) h.db.addMessage({ threadId: h.thread.id, runId: run.id, role: "implementor", kind: "text", content: "Patched the file." });
  return internals.awaitImplementorCompletion(h.thread, undefined, "kickoff", agent, "a", false, "continue", true);
}

/** The stamped run row as the sweep's classifier would read it (snake_case, straight from SQLite). */
function firstRunRow(h: Harness): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (h.db as any).raw
    .prepare("SELECT * FROM agent_runs WHERE thread_id = ? ORDER BY started_at ASC LIMIT 1")
    .get(h.thread.id) as Record<string, unknown>;
}

// ---- the cases -------------------------------------------------------------------------------------

console.log("\n=== A. a run that PRODUCED output is a finish (no false positive) ===");
{
  const h = makeHarness([]);
  const res = await drive(h, true);
  check("no auto-resume was attempted", h.asks.length === 0, `${h.asks.length} resume(s)`);
  check("the success result is passed through untouched", res?.isError === false && res?.subtype === "success");
  check("its run row is left alone", firstRunRow(h).state !== "error", String(firstRunRow(h).state));
  h.dispose();
}

console.log("\n=== B. a SILENT run is retried on a FRESH session, and the retry's finish is accepted ===");
{
  const h = makeHarness(["works"]);
  const res = await drive(h, false);
  check("the silent run triggered exactly one auto-resume", h.asks.length === 1, `${h.asks.length} resume(s)`);
  check("the retry was told not to continue the empty session (forceFresh)", h.asks[0]?.forceFresh === true);
  check("the retry still carries the prior session id for its handoff", h.asks[0]?.session === "sess-1");
  check("the nudge explains the session ended before finishing", /previous session ended before the work was finished/i.test(h.asks[0]?.nudge ?? ""));
  check("the working retry ends the loop as a finish", res?.isError === false);
  h.dispose();
}

console.log("\n=== C. the silent run is recorded as a failure, not a `done` row the sweep can't see ===");
{
  const h = makeHarness(["works"]);
  await drive(h, false);
  const row = firstRunRow(h);
  check("its run row is stamped error", row.state === "error", String(row.state));
  check("it records why", /produced no output/i.test(String(row.error)));
  check("probe:run-errors classifies it as `silent`", classifyRun(row) === "silent", classifyRun(row));
  h.dispose();
}

console.log("\n=== D. silence all the way through the budget PARKS the task instead of handing QA empty work ===");
{
  const h = makeHarness(["silent", "silent", "silent"]);
  const res = await drive(h, false);
  check("it retried up to the auto-resume budget (MAX_AUTO_RESUMES=2)", h.asks.length === 2, `${h.asks.length} resume(s)`);
  check("every retry after the first also forced a fresh session", h.asks.every((a) => a.forceFresh));
  check("the hollow success is replaced by a real error", res?.isError === true, JSON.stringify(res));
  check("the error says the session produced nothing", /produced no output/i.test(res?.result ?? ""));
  h.dispose();
}

console.log("\n=== E. the stamp survives the run finalizing FIRST (onEnd wins the race) ===");
{
  // The real runner's `onEnd` clears `this.live` and finalizes the row as `done` — and for a silent run the
  // CLI exits immediately, so it frequently lands before the awaited result is observed. Keying the stamp
  // off `this.live`, or skipping an already-stamped `endedAt`, silently left the misleading `done` row.
  const h = makeHarness(["works"]);
  const res = await drive(h, false, true);
  const row = firstRunRow(h);
  check("the silent run was still detected and retried", h.asks.length === 1, `${h.asks.length} resume(s)`);
  check("the already-finalized `done` row is corrected to error", row.state === "error", String(row.state));
  check("probe:run-errors still classifies it as `silent`", classifyRun(row) === "silent", classifyRun(row));
  check("the original end time is preserved", row.ended_at != null);
  check("the retry's finish is still accepted", res?.isError === false);
  h.dispose();
}

console.log("\n=== F. a stale 'looks done' message from an EARLIER session can't veto the silent retry ===");
{
  // The QA fix-round case: the pre-QA session signed off with "the task is complete", QA found issues, and
  // the fix-round resume came back empty. `implementorLooksDone` reads that stale sign-off, so vetoing on
  // it would skip the retry entirely and park a task whose fix round never actually ran.
  const h = makeHarness(["works"]);
  const stale = h.db.addMessage({
    threadId: h.thread.id,
    role: "implementor",
    kind: "text",
    content: "All tests pass — the task is complete.",
  });
  // Backdate it so it predates the run we're about to start (same-ms creation would count as this run's
  // own output and mask the silence the case is about).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (h.db as any).raw.prepare("UPDATE messages SET created_at = ? WHERE id = ?").run(Date.now() - 60_000, stale.id);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = h.mgr as any;
  check("the stale message really does read as done", internals.implementorLooksDone(h.thread.id) === true);
  const res = await drive(h, false);
  check("the silent fix-round was retried anyway", h.asks.length === 1, `${h.asks.length} resume(s)`);
  check("on a fresh session", h.asks[0]?.forceFresh === true);
  check("and the working retry is accepted as the finish", res?.isError === false);
  h.dispose();
}

console.log(`\n=== ${passed}/${passed + failed} checks passed ===`);
if (failed) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
process.exit(0);
