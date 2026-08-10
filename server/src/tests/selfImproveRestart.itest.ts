/**
 * Integration test — the opt-in self-improvement round is restart-safe (real ThreadManager machinery).
 *
 * Regression guard for a bug seen in production: the bonus round runs AFTER the task was accepted, but it
 * holds the thread in 'qa' — an AUTO_RESUME state. A server restart landing inside the round therefore
 * flipped the task to 'failed' + auto-resumed it into `runImplementorQaLoop`, which spent a whole extra
 * implementor run AND another QA round on already-accepted work (and would do so again on every bounce).
 * The fix is a durable `selfImproving` marker: `markInterrupted` settles such a task 'done' — where the
 * pipeline was already headed the moment the round began — instead of resuming it.
 *
 * WHAT IS REAL vs. STUBBED
 *  - REAL: `markInterrupted` (it runs in the ThreadManager constructor, so "reboot" == constructing a
 *    second manager over the same Db), `runSelfImprovement`'s marker lifecycle, the QA-stage inject/resume
 *    gates, `runImplementorQaLoop`'s entry cleanup, and the real `Db` + `EventHub` behind all of them.
 *  - STUBBED: only the agent-spawning leaves — `startResumedImplementor`, `awaitImplementorCompletion`,
 *    `stopLive`, `runQA`, `drainQueuedImplementor`, plus `resumeThread` (so a control-case auto-resume is
 *    recorded rather than actually spawning an implementor).
 *
 * Run:  npm run test:self-improve-restart   (from server/)
 * Exits non-zero if any assertion fails. Self-contained: creates a throwaway DB + workspace and removes them.
 */

process.env.CAP_RETRY_MS = "0"; // no cap-supervisor interval during the test
process.env.ACCOUNT_PING_MS = "3600000";
process.env.FAST_ACCOUNT_PING_MS = "3600000";

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountManager } from "../accounts/accountManager.js";
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Must carry every method the ThreadManager constructor's boot-apply reaches, plus `auxToken` — a task
 *  settling to 'done' calls announceDone, which reads it inside a voided promise (a missing method there
 *  is an unhandled rejection, not a test failure, so it would kill the run rather than fail an assert). */
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

interface Harness {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mgr: any;
  db: InstanceType<typeof Db>;
  workspace: string;
  dir: string;
  dispose(): void;
}

function makeDb(prefix: string): { db: InstanceType<typeof Db>; dir: string; workspace: string } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const workspace = join(dir, "workspace");
  mkdirSync(workspace, { recursive: true });
  return { db: new Db(join(dir, "orchestrator.sqlite")), dir, workspace };
}

/** Construct a ThreadManager over an existing Db — i.e. boot the server. The constructor runs
 *  markInterrupted(), so everything this test asserts about a restart has already happened on return. */
function boot(db: InstanceType<typeof Db>, dir: string, workspace: string): Harness {
  const hub = new EventHub();
  const memory = new FileMemoryService(join(dir, "memory"));
  const mgr = new ThreadManager(db, hub, memory, new StubAccounts() as unknown as AccountManager);
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mgr: mgr as any,
    db,
    workspace,
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

/** A task the pipeline had already accepted: QA round 1 spent and passed, then the bonus round (or, in the
 *  control, nothing) holding it with a live implementor run the restart is about to orphan.
 *
 *  `state` matters: the round holds 'qa' only until its implementor goes live, after which
 *  `startImplementor` has moved the thread to 'implementing' — which is where the production incident
 *  actually happened. Both are AUTO_RESUME states, and the fix must not care which one it finds. */
function seedAcceptedTask(
  db: InstanceType<typeof Db>,
  workspace: string,
  selfImproving: boolean,
  state: "qa" | "implementing" = "implementing",
): string {
  const t = db.createThread({ title: "mock accepted task", workspace, rawPrompt: "do the thing" });
  db.updateThreadStageOutputs(t.id, { kickoff: "KICKOFF: mock", planDone: true, approved: true, qaRoundsUsed: 1, selfImproving });
  db.updateThread(t.id, { state });
  db.createRun({ threadId: t.id, role: "implementor", model: "claude-opus-5" });
  return t.id;
}

async function testRestartDuringTheRound(): Promise<void> {
  console.log("\nTest A — a restart inside the self-improvement round settles the accepted task done\n");
  const a = makeDb("self-improve-marked-");
  const b = makeDb("self-improve-control-");
  const markedId = seedAcceptedTask(a.db, a.workspace, true);
  // The round's other state: a bounce landing between the QA verdict and the round's implementor going live.
  const markedQaId = seedAcceptedTask(a.db, a.workspace, true, "qa");
  const controlId = seedAcceptedTask(b.db, b.workspace, false);

  const marked = boot(a.db, a.dir, a.workspace);
  const control = boot(b.db, b.dir, b.workspace);
  // Record the deferred auto-resume instead of letting it spawn an implementor. markInterrupted schedules
  // it 4s out, so replacing the method here — synchronously after construction — always wins that race.
  const resumed: string[] = [];
  marked.mgr.resumeThread = async (id: string): Promise<unknown> => {
    resumed.push(`marked:${id}`);
    return { ok: true };
  };
  control.mgr.resumeThread = async (id: string): Promise<unknown> => {
    resumed.push(`control:${id}`);
    return { ok: true };
  };

  const m = marked.db.getThread(markedId)!;
  check("the marked task settled 'done' (bounce caught it in 'implementing')", m.state === "done", `state=${m.state}`);
  check("…and so did one caught in the round's earlier 'qa' window", marked.db.getThread(markedQaId)?.state === "done");
  check("it carries no park/restart error", m.error == null, `error=${m.error}`);
  check("the selfImproving marker was consumed", marked.db.getThreadStageOutputs(markedId).selfImproving === false);
  check(
    "the interruption is recorded as a finding so the trail explains the settle",
    marked.db.listFindings(markedId).some((f) => f.summary.includes("self-improvement round was cut short")),
  );
  check("the orphaned implementor run was still stamped terminal", marked.db.listRuns(markedId).every((r) => r.state === "interrupted"));

  // The control is what makes the above meaningful: the SAME thread state without the marker must keep
  // taking the pre-existing auto-resume path.
  const c = control.db.getThread(controlId)!;
  check("without the marker the same task still auto-resumes (state 'failed')", c.state === "failed", `state=${c.state}`);
  check("…flagged as a restart-triggered resume", (c.error ?? "").includes("restart"), `error=${c.error}`);

  await sleep(4500); // AUTO_RESUME_DELAY_MS + slack
  check("the marked task was never resumed", !resumed.some((r) => r.startsWith("marked:")), resumed.join(","));
  check("the control task WAS resumed", resumed.includes(`control:${controlId}`), resumed.join(","));

  marked.dispose();
  control.dispose();
}

/** A finished implementor result of the shape the SDK really returns — a bare `{isError}` is not a
 *  ResultEvent, and any path that reads `subtype` off one throws inside a catch that swallows it. */
const OK_RESULT = { type: "result", subtype: "success", isError: false };

interface RoundStubs {
  markerDuringRound: boolean[]; // the DURABLE marker, sampled from inside the round
  episodeDuringRound: boolean[]; // the in-memory episode the inject/resume gates key on
  drained: number;
}

/** Stub the round's agent-spawning leaves; reports what the round looked like from the inside. */
function stubRoundLeaves(h: Harness, opts: { throwInRound?: boolean } = {}): RoundStubs {
  const out: RoundStubs = { markerDuringRound: [], episodeDuringRound: [], drained: 0 };
  const fakeStart = { run: { send(): void {} }, runId: "run-x", accountId: "acct-a" };
  h.mgr.stopLive = async (): Promise<void> => {};
  h.mgr.flushDirectorNotes = (): void => {};
  h.mgr.startResumedImplementor = async (t: Thread): Promise<typeof fakeStart> => {
    out.markerDuringRound.push(h.db.getThreadStageOutputs(t.id).selfImproving === true);
    out.episodeDuringRound.push(h.mgr.selfImproving.has(t.id));
    if (opts.throwInRound) throw new Error("boom");
    return fakeStart;
  };
  h.mgr.awaitImplementorCompletion = async (): Promise<unknown> => OK_RESULT;
  h.mgr.drainQueuedImplementor = async (_t: Thread, _e: unknown, _k: string, res: unknown): Promise<unknown> => {
    out.drained++;
    return res;
  };
  return out;
}

async function testMarkerLifecycle(): Promise<void> {
  console.log("\nTest B — the marker is set for the round's lifetime and always cleared\n");
  const { db, dir, workspace } = makeDb("self-improve-life-");
  const h = boot(db, dir, workspace);
  h.mgr.setSettings({ selfImproveEnabled: true });

  const id = seedAcceptedTask(db, workspace, false);
  h.mgr.latestImplementorSession = (): string => "session-abc";
  const round = stubRoundLeaves(h);

  await h.mgr.runSelfImprovement(db.getThread(id)!, undefined, "KICKOFF: mock");
  check("the round ran", round.markerDuringRound.length === 1);
  check("the durable marker was set while the round was live", round.markerDuringRound[0] === true);
  check("the in-memory episode was open too", round.episodeDuringRound[0] === true);
  check("the durable marker is cleared once the round returns", db.getThreadStageOutputs(id).selfImproving === false);
  check("…and so is the episode", !h.mgr.selfImproving.has(id));
  // The round is the task's LAST hand-off boundary, so it owes the Queue button its delivery — nothing
  // downstream drains `queuedForImplementor` before the caller settles the task done.
  check("a follow-up queued during the round is drained, not discarded", round.drained === 1);

  // A throw inside the round must not propagate (the task is already accepted) and must not leak either
  // marker — a leaked durable one would make a LATER restart settle unfinished pipeline work as done.
  const id2 = seedAcceptedTask(db, workspace, false);
  stubRoundLeaves(h, { throwInRound: true });
  let threw = false;
  await h.mgr.runSelfImprovement(db.getThread(id2)!, undefined, "KICKOFF: mock").catch(() => {
    threw = true;
  });
  check("a throw inside the round is swallowed (best-effort by contract)", !threw);
  check("…and the marker is still cleared", db.getThreadStageOutputs(id2).selfImproving === false);
  check("…and the episode is closed", !h.mgr.selfImproving.has(id2));

  // Off by default: no marker, no round.
  const id3 = seedAcceptedTask(db, workspace, false);
  h.mgr.setSettings({ selfImproveEnabled: false });
  const off = stubRoundLeaves(h);
  await h.mgr.runSelfImprovement(db.getThread(id3)!, undefined, "KICKOFF: mock");
  check("with the setting off the round never runs", off.markerDuringRound.length === 0);
  check("…and no marker is written", db.getThreadStageOutputs(id3).selfImproving !== true);

  h.dispose();
}

async function testStaleMarkerCleared(): Promise<void> {
  console.log("\nTest C — a fresh pipeline entry drops a stale marker\n");
  const { db, dir, workspace } = makeDb("self-improve-stale-");
  const h = boot(db, dir, workspace);
  const id = seedAcceptedTask(db, workspace, true);
  db.updateThreadStageOutputs(id, { qaRoundsUsed: 0 });

  h.mgr.stopLive = async (): Promise<void> => {};
  h.mgr.flushDirectorNotes = (): void => {};
  h.mgr.startResumedImplementor = async (): Promise<unknown> => ({ run: { send(): void {} }, runId: "r", accountId: "a" });
  h.mgr.awaitImplementorCompletion = async (): Promise<{ isError: boolean }> => ({ isError: false });
  h.mgr.drainQueuedImplementor = async (_t: Thread, _e: unknown, _k: string, res: unknown): Promise<unknown> => res;
  h.mgr.runSelfImprovement = async (): Promise<void> => {};
  h.mgr.runQA = async (): Promise<{ pass: boolean; summary: string }> => ({ pass: true, summary: "ok" });

  await h.mgr.runImplementorQaLoop(db.getThread(id)!, "KICKOFF: mock", undefined, undefined, undefined, { qaEnabled: true, maxQaRounds: 2 });
  check("the pipeline's own implementor cleared the stale marker", db.getThreadStageOutputs(id).selfImproving === false);
  h.dispose();
}

async function testInjectReachesTheRound(): Promise<void> {
  console.log("\nTest D — the round owns the slot: steering reaches it, nothing spawns beside it\n");
  const { db, dir, workspace } = makeDb("self-improve-inject-");
  const h = boot(db, dir, workspace);
  const id = seedAcceptedTask(db, workspace, true); // 'implementing' — the state the round really holds
  h.mgr.selfImproving.add(id); // the episode runSelfImprovement opens

  h.mgr.retitleFromInjection = async (): Promise<void> => {}; // real one is a voided model call — keep the gate free + offline
  let spawned = 0;
  h.mgr.resumeImplementorOnly = async (): Promise<void> => {
    spawned++;
  };
  const toImplementor: string[] = [];
  h.mgr.live.set(id, { run: { send: (m: string): void => void toImplementor.push(String(m)) }, runId: "r", accountId: "a" });

  const res = await h.mgr.injectThread(id, "also update the README", "append");
  check("the inject is acknowledged", res.ok === true, JSON.stringify(res));
  check("it reached the round's implementor", toImplementor.length === 1 && (toImplementor[0] ?? "").includes("also update the README"));
  check("nothing was stranded in the director-note buffer", !(h.mgr.directorNotes.get(id) ?? []).length);
  check(
    "the feed says where it actually went",
    db.listMessages(id).some((m) => m.content.includes("forwarded to the self-improvement round")),
  );
  const resumeRes = await h.mgr.resumeThread(id, "one more thing");
  check("a resume with steering also reaches it", resumeRes.ok === true && toImplementor.length === 2, toImplementor.join(" | "));
  check("no second implementor was started while the round's handle was live", spawned === 0);

  // THE window this gate exists for: the round is still running, but its implementor's own onEnd has
  // already cleared `this.live` while the awaited result is in flight. Without an episode-keyed gate a
  // Resume here falls through to a COLD resume and puts a second implementor on the same workspace.
  h.mgr.live.delete(id);
  const lateResume = await h.mgr.resumeThread(id, "and one more");
  check("a resume in the onEnd/result race spawns nothing", spawned === 0 && !h.mgr.resuming.has(id));
  check("…and its steering is buffered for the round instead of dropped", (h.mgr.directorNotes.get(id) ?? []).length === 1, JSON.stringify(lateResume));
  await h.mgr.injectThread(id, "late inject", "append");
  check("an inject in the same window spawns nothing either", spawned === 0);
  check("…and is buffered too", (h.mgr.directorNotes.get(id) ?? []).length === 2);

  // Control: a live QA agent in a genuine QA stage still wins, so the QA gate's "never steer or spawn an
  // implementor beside the QA agent" guarantee is untouched.
  const qaId = seedAcceptedTask(db, workspace, false, "qa");
  const toQa: string[] = [];
  h.mgr.liveQa.set(qaId, { send: (m: string): void => void toQa.push(String(m)) });
  await h.mgr.injectThread(qaId, "qa-bound note", "append");
  check("a real QA stage still routes to the QA agent", toQa.length === 1 && toImplementor.length === 2);

  h.dispose();
}

async function main(): Promise<void> {
  console.log("\n=== Self-improvement round is restart-safe — integration test (real machinery) ===");
  await testRestartDuringTheRound();
  await testMarkerLifecycle();
  await testStaleMarkerCleared();
  await testInjectReachesTheRound();

  console.log(`\n${failed === 0 ? "✅ ALL PASSED" : "❌ FAILURES"} — ${passed} passed, ${failed} failed`);
  if (failed) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

await main();
