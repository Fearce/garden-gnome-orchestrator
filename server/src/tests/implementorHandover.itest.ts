/**
 * Integration test — ONE implementor per workspace, across every hand-over the completion loop makes.
 *
 * The bug (task 56f4d8f4, 2026-09-11): `awaitImplementorResult` relaunches the implementor ITSELF on an
 * account cap, a Fable model-pool fallback or a transient-API retry, but returned only the ResultEvent.
 * Its caller `awaitImplementorCompletion` kept `let current = run` — the run it had passed IN — so after
 * any of those relaunches `current` pointed at an already-dead object. The next turn-ceiling auto-resume
 * then "stopped" that corpse, left the real child running, and started a second agent beside it. Both
 * worked the same checkout for 45 minutes and committed over each other on a production branch; the
 * resume in between came back empty (0 turns) because the original still held its session.
 *
 * WHAT IS REAL vs. SIMULATED
 *  - REAL: `awaitImplementorCompletion` and `awaitImplementorResult` — the cap detection, the account
 *    failover (through `AccountManager.selectFailover`), the turn-ceiling auto-resume and its budget,
 *    and which run each hand-over stops. A real `Db` (temp file) and a real `EventHub` back all of it.
 *  - SIMULATED: only the agent spawn — fake `AgentRunLike`s return canned results and record their stops.
 *
 * Run:  npm run test:implementor-handover   (from server/)
 * Exits non-zero if any assertion fails. Self-contained: creates a throwaway DB + workspace and removes them.
 */

// Env must be set BEFORE config.js is first evaluated — so the app modules are dynamically imported below.
process.env.CAP_RETRY_MS = "0"; // no cap-supervisor interval or boot sweep interfering
process.env.ACCOUNT_PING_MS = "3600000";
process.env.FAST_ACCOUNT_PING_MS = "3600000";
process.env.MAX_AUTO_RESUMES = "2";
process.env.NOTIFY_WEBHOOK_URL = ""; // a failover logs externally; never post from a test

import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AccountManager } from "../accounts/accountManager.js";
import type { AgentRunLike, ResultEvent } from "../agents/runner.js";
import type { Thread } from "../types.js";

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

// ---- stubs -----------------------------------------------------------------------------------------

/** Two subscriptions, both with headroom, so the REAL cap-failover branch runs. `byId` returns null on
 *  purpose: that is the Codex-pseudo-account shape, and it keeps the Fable model-pool branch (which would
 *  relaunch on the same account instead) out of the way. */
class StubAccounts {
  selectFailover(excludeId: string): { id: string; label: string; token: string } | null {
    return excludeId === "acct-a" ? { id: "acct-b", label: "Claude B", token: "tok-b" } : null;
  }
  byId(_id: string): null {
    return null;
  }
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

const SUCCESS: ResultEvent = { type: "result", subtype: "success", isError: false, result: "done" };
const CEILING: ResultEvent = { type: "result", subtype: "error_max_turns", isError: true, result: "hit the turn ceiling" };
const CAP: ResultEvent = { type: "result", subtype: "error_during_execution", isError: true, result: "usage limit reached" };

interface FakeRun extends AgentRunLike {
  readonly name: string;
  stops: number;
  /** Fires as the turn's result resolves — the harness uses it to write the output a real run leaves
   *  behind, so a successful turn isn't mistaken for the empty-resume case (`ranSilently`). */
  beforeResult?: () => void;
}

/** The one leaf the pipeline can't run here: a spawned agent. `finished` flips on stop exactly as a real
 *  run's does, so "is another agent still live?" is answerable the same way production answers it. */
function fakeRun(name: string, res: ResultEvent, opts: { rateLimited?: boolean } = {}): FakeRun {
  const run = {
    name,
    stops: 0,
    beforeResult: undefined as (() => void) | undefined,
    emitter: { on() {}, off() {}, once() {}, emit() {} },
    sessionId: `sess-${name}`,
    finished: false,
    lastResult: res,
    rateLimited: opts.rateLimited ?? false,
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
    async stop() {
      run.stops++;
      run.finished = true;
    },
    async result() {
      run.beforeResult?.();
      return res;
    },
    async nextResult() {
      run.beforeResult?.();
      return res;
    },
  };
  return run as unknown as FakeRun;
}

interface Harness {
  mgr: InstanceType<typeof ThreadManager>;
  db: InstanceType<typeof Db>;
  thread: Thread;
  /** Every fake run the pipeline was handed, in the order it got them. */
  runs: FakeRun[];
  /** Runs still unstopped at the moment the auto-resume asked for a continuation — i.e. agents that
   *  would have kept working alongside it. This is the invariant the whole gate exists for. */
  liveAtResume: string[];
  dispose(): void;
}

/** Wire a manager whose implementor spawns are fakes. `onFailover` supplies the run a cap failover
 *  relaunches onto; `onResume` supplies the run the turn-ceiling auto-resume continues with. */
function makeHarness(onFailover: () => FakeRun, onResume: () => FakeRun): Harness {
  const dir = mkdtempSync(join(tmpdir(), "implementor-handover-"));
  const workspace = join(dir, "workspace");
  mkdirSync(workspace, { recursive: true });

  const db = new Db(join(dir, "orchestrator.sqlite"));
  const mgr = new ThreadManager(db, new EventHub(), new FileMemoryService(join(dir, "memory")), new StubAccounts() as unknown as AccountManager);
  const thread = db.createThread({ title: "implementor hand-over", workspace, rawPrompt: "p", brief: "b" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = mgr as any;
  internals.lastImplementorSession.set(thread.id, "sess-A");

  const runs: FakeRun[] = [];
  const liveAtResume: string[] = [];
  const adopt = (run: FakeRun, accountId: string): { run: FakeRun; runId: string; accountId: string } => {
    runs.push(run);
    // A stubbed spawn still owes the row the real one writes: the run trail is what several guards read
    // back, and a harness that writes none makes their assertions pass vacuously.
    const row = db.createRun({ threadId: thread.id, role: "implementor", model: "claude-opus-5", account: accountId });
    internals.live.set(thread.id, { run, runId: row.id, accountId });
    run.beforeResult = () => {
      db.addMessage({ threadId: thread.id, runId: row.id, role: "implementor", kind: "text", content: "Patched the file." });
    };
    return { run, runId: row.id, accountId };
  };

  internals.startImplementor = (_t: Thread, _kickoff: string, opts?: { account?: { id: string } }) =>
    adopt(onFailover(), opts?.account?.id ?? "acct-b");

  internals.startResumedImplementor = async () => {
    for (const run of runs) if (!run.finished) liveAtResume.push(run.name);
    return adopt(onResume(), "acct-b");
  };

  return {
    mgr,
    db,
    thread,
    runs,
    liveAtResume,
    dispose() {
      if (internals.capSupervisor) clearInterval(internals.capSupervisor);
      if (internals.tokenResumeTimer) clearTimeout(internals.tokenResumeTimer);
      db.raw.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Drive the completion loop exactly as the pipeline does, starting from the run it was handed. */
async function drive(h: Harness, first: FakeRun): Promise<ResultEvent | undefined> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = h.mgr as any;
  h.runs.push(first);
  const row = h.db.createRun({ threadId: h.thread.id, role: "implementor", model: "claude-opus-5", account: "acct-a" });
  internals.live.set(h.thread.id, { run: first, runId: row.id, accountId: "acct-a" });
  return internals.awaitImplementorCompletion(h.thread, undefined, "kickoff", first, "acct-a", false, "continue", true);
}

// ---- the cases -------------------------------------------------------------------------------------

console.log("\n=== A. after a cap failover, the turn-ceiling resume stops the run that ACTUALLY hit the ceiling ===");
{
  // The reported incident, end to end: A is capped, the failover continues on B, B hits the turn ceiling.
  // The loop must stop B. Stopping A (the run it was handed) leaves B running beside the continuation.
  const capped = fakeRun("A", CAP, { rateLimited: true });
  const failedOver = fakeRun("B", CEILING);
  const resumed = fakeRun("C", SUCCESS);
  const h = makeHarness(() => failedOver, () => resumed);
  const res = await drive(h, capped);

  check("the cap failover relaunched the implementor", h.runs.map((r) => r.name).includes("B"), h.runs.map((r) => r.name).join(","));
  check("the capped run was ended by the failover", capped.stops === 1, `${capped.stops} stop(s)`);
  check("the run that hit the ceiling was ended before the resume", failedOver.stops === 1, `${failedOver.stops} stop(s)`);
  check("NO agent was left working when the continuation started", h.liveAtResume.length === 0, `still live: ${h.liveAtResume.join(",") || "none"}`);
  check("the capped run was not stopped twice", capped.stops <= 1, `${capped.stops} stop(s)`);
  check("the continuation's finish is the loop's result", res?.isError === false && res?.subtype === "success", JSON.stringify(res));
  h.dispose();
}

console.log("\n=== B. the ordinary path (no failover) still ends the run it was handed ===");
{
  const ceiling = fakeRun("A", CEILING);
  const resumed = fakeRun("B", SUCCESS);
  const h = makeHarness(() => fakeRun("unused", SUCCESS), () => resumed);
  const res = await drive(h, ceiling);

  check("the turn-maxed run was stopped", ceiling.stops === 1, `${ceiling.stops} stop(s)`);
  check("no agent was left working when the continuation started", h.liveAtResume.length === 0, `still live: ${h.liveAtResume.join(",") || "none"}`);
  check("the continuation's finish is the loop's result", res?.isError === false, JSON.stringify(res));
  h.dispose();
}

console.log("\n=== C. a chain of failovers tracks the LAST relaunch, not the first ===");
{
  // Two relaunches deep: A is capped, B is capped too, C hits the ceiling. Only C may be stopped for the
  // resume — a fix that merely remembered "the first relaunch" would strand B here.
  const first = fakeRun("A", CAP, { rateLimited: true });
  const second = fakeRun("B", CAP, { rateLimited: true });
  const third = fakeRun("C", CEILING);
  const relaunches = [second, third];
  const resumed = fakeRun("D", SUCCESS);
  const h = makeHarness(() => relaunches.shift() ?? fakeRun("extra", SUCCESS), () => resumed);
  // `triedClaudeAccounts` gives each account one attempt, so the second failover needs its own account.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = h.mgr as any;
  const accounts = ["acct-b", "acct-c"];
  internals.failoverAccount = () => {
    const id = accounts.shift();
    return id ? { id, label: id, token: "tok" } : null;
  };
  await drive(h, first);

  check("both capped runs were ended by their failovers", first.stops === 1 && second.stops === 1, `A=${first.stops} B=${second.stops}`);
  check("the LAST relaunch is the one the resume stopped", third.stops === 1, `${third.stops} stop(s)`);
  check("no agent was left working when the continuation started", h.liveAtResume.length === 0, `still live: ${h.liveAtResume.join(",") || "none"}`);
  h.dispose();
}

console.log("\n=== D. the backstop: a new implementor ends the unfinished one it displaces ===");
{
  // Defence in depth for any FUTURE path that forgets to stop what it replaces. Behaviour first…
  const h = makeHarness(() => fakeRun("unused", SUCCESS), () => fakeRun("unused", SUCCESS));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = h.mgr as any;

  const orphan = fakeRun("orphan", SUCCESS);
  const row = h.db.createRun({ threadId: h.thread.id, role: "implementor", model: "claude-opus-5", account: "acct-a" });
  internals.live.set(h.thread.id, { run: orphan, runId: row.id, accountId: "acct-a" });
  internals.stopDisplacedImplementor(h.thread.id);
  check("an unfinished implementor is stopped when a new one takes the handle", orphan.stops === 1, `${orphan.stops} stop(s)`);

  const settled = fakeRun("settled", SUCCESS);
  await settled.stop();
  const settledStops = settled.stops;
  internals.live.set(h.thread.id, { run: settled, runId: row.id, accountId: "acct-a" });
  internals.stopDisplacedImplementor(h.thread.id);
  check("a run that already finished is left alone", settled.stops === settledStops, `${settled.stops} stop(s)`);

  internals.live.delete(h.thread.id);
  internals.stopDisplacedImplementor(h.thread.id); // must not throw with no live implementor
  check("no live implementor is a no-op", true);
  h.dispose();
}

console.log("\n=== E. …and the backstop is WIRED, ahead of the handle it protects ===");
{
  // Case D drives the helper directly, so it stays green if the CALL is removed. Pin the call site: it has
  // to run inside startImplementor and BEFORE `this.live.set`, or it would stop the run just created.
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "orchestrator", "threadManager.ts"), "utf8");
  const guard = source.indexOf("this.stopDisplacedImplementor(thread.id);");
  const handover = source.indexOf("this.live.set(thread.id, { run: agent, runId, accountId });");
  check("startImplementor calls the backstop", guard > 0, "no call to stopDisplacedImplementor found");
  check("it runs before the new run takes the live handle", guard > 0 && handover > 0 && guard < handover, `guard@${guard} handle@${handover}`);
}

console.log(`\n=== ${passed}/${passed + failed} checks passed ===`);
if (failed) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
process.exit(0);
