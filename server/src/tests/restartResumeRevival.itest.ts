/**
 * Integration test — a restart's auto-resume promise survives a SECOND restart (real ThreadManager machinery).
 *
 * Regression guard for a bug seen in production (2026-08-08): `markInterrupted` persists state='failed' +
 * RESTART_AUTO_RESUME_MSG and then holds the actual resume only in an in-memory `setTimeout`. A second
 * bounce inside that window dropped it for good — the next boot only scans IN_FLIGHT states, and the thread
 * is 'failed' by then. Two real tasks (that night's own nightly sweep among them) sat for two days showing
 * the promise "auto-resuming…" with nothing ever coming back for them. The persisted marker outlives the
 * process, so it IS the record that a resume is still owed: the next boot re-arms from it.
 *
 * WHAT IS REAL vs. STUBBED
 *  - REAL: `markInterrupted` + `reviveStrandedAutoResumes` (both run in the ThreadManager constructor, so
 *    "reboot" == constructing another manager over the same Db), the durable revival counter, the
 *    crash-loop guard, and the real `Db` + `EventHub` behind them.
 *  - STUBBED: only `resumeThread`, so a scheduled auto-resume is RECORDED instead of spawning an agent.
 *
 * Run:  npm run test:restart-revival   (from server/)
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

// The literals the production code persists. Deliberately re-declared rather than imported: they are a
// cross-process CONTRACT (one process writes them, a later one reads them back), so a silent reword must
// fail here instead of both sides moving together.
const AUTO_RESUME_MSG = "interrupted by a server restart — auto-resuming…";
const MANUAL_RESUME_MSG = "interrupted by a server restart — click Resume to continue from where it left off (finished stages are reused)";
const AUTO_RESUME_DELAY_MS = 4_000;
const MAX_STRANDED_REVIVALS = 3;

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

/** Must carry every method the ThreadManager constructor's boot-apply reaches. */
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

interface Boot {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mgr: any;
  resumed: string[]; // thread ids this boot actually got as far as resuming
  stop(): void; // "the process dies" — drop its timers, keep the Db
}

interface Bed {
  db: InstanceType<typeof Db>;
  dir: string;
  workspace: string;
  dispose(): void;
}

function makeBed(prefix: string): Bed {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const workspace = join(dir, "workspace");
  mkdirSync(workspace, { recursive: true });
  const db = new Db(join(dir, "orchestrator.sqlite"));
  return {
    db,
    dir,
    workspace,
    dispose() {
      db.raw.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Boot the server over an existing Db. The constructor runs markInterrupted(), so everything this test
 *  asserts about a restart has already happened by the time this returns — except the deferred resume,
 *  which lands AUTO_RESUME_DELAY_MS later into the recorder installed here (synchronously, so it always
 *  wins that race). */
function boot(bed: Bed): Boot {
  const hub = new EventHub();
  const memory = new FileMemoryService(join(bed.dir, "memory"));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mgr = new ThreadManager(bed.db, hub, memory, new StubAccounts() as unknown as AccountManager) as any;
  const resumed: string[] = [];
  mgr.resumeThread = async (id: string): Promise<unknown> => {
    resumed.push(id);
    return { ok: true };
  };
  return {
    mgr,
    resumed,
    stop() {
      if (mgr.capSupervisor) clearInterval(mgr.capSupervisor);
      if (mgr.tokenResumeTimer) clearTimeout(mgr.tokenResumeTimer);
      // A dead process resumes nothing — its pending setTimeout dies with it. Neutralising the method is
      // how this test reproduces the second bounce landing inside the auto-resume window.
      mgr.resumeThread = async (): Promise<unknown> => ({ ok: false, error: "process is gone" });
    },
  };
}

/** A task the restart caught mid-flight: an implementor live in an AUTO_RESUME state. */
function seedLiveTask(bed: Bed, state: Thread["state"] = "implementing"): string {
  const t = bed.db.createThread({ title: "mock live task", workspace: bed.workspace, rawPrompt: "do the thing" });
  bed.db.updateThreadStageOutputs(t.id, { kickoff: "KICKOFF: mock", planDone: true, approved: true });
  bed.db.updateThread(t.id, { state });
  bed.db.createRun({ threadId: t.id, role: "implementor", model: "claude-opus-5" });
  return t.id;
}

/** A task already left stranded by an earlier boot: the promise persisted, the resume never fired. */
function seedStrandedTask(bed: Bed, opts: { error?: string; revivals?: number; ageMs?: number } = {}): string {
  const t = bed.db.createThread({ title: "mock stranded task", workspace: bed.workspace, rawPrompt: "do the thing" });
  bed.db.updateThreadStageOutputs(t.id, {
    kickoff: "KICKOFF: mock",
    planDone: true,
    approved: true,
    ...(opts.revivals == null ? {} : { autoResumeRevivals: opts.revivals }),
  });
  bed.db.updateThread(t.id, { state: "failed", error: opts.error ?? AUTO_RESUME_MSG });
  // `updated_at` is when the promise was stamped — nothing touches it while the task sits stranded, so it
  // is what the staleness bound reads. Set it directly; there is no API for backdating a thread.
  if (opts.ageMs) bed.db.raw.prepare("UPDATE threads SET updated_at = ? WHERE id = ?").run(Date.now() - opts.ageMs, t.id);
  return t.id;
}

/** Interrupted implementor runs that died within seconds of starting — what the crash-loop guard counts. */
function seedFastInterrupts(bed: Bed, threadId: string, n: number): void {
  const at = Date.now();
  for (let i = 0; i < n; i++) {
    const r = bed.db.createRun({ threadId, role: "implementor", model: "claude-opus-5" });
    bed.db.updateRun(r.id, { state: "interrupted", endedAt: at - 1_000 });
  }
}

async function testStrandedPromiseIsRevived(): Promise<void> {
  console.log("\nTest A — a second bounce inside the auto-resume window doesn't lose the resume\n");
  const bed = makeBed("restart-revive-");
  const id = seedLiveTask(bed);

  // Boot 1: the restart that killed the task. It promises an auto-resume 4s out…
  const first = boot(bed);
  const afterFirst = bed.db.getThread(id)!;
  check("boot 1 flips the live task to 'failed' with the durable auto-resume promise", afterFirst.state === "failed" && afterFirst.error === AUTO_RESUME_MSG, `state=${afterFirst.state} error=${afterFirst.error}`);
  check("…and starts it on a fresh revival budget", bed.db.getThreadStageOutputs(id).autoResumeRevivals === 0, JSON.stringify(bed.db.getThreadStageOutputs(id).autoResumeRevivals));

  // …and dies before the timer fires. This is the production sequence: the 08-08 boot at 01:06:59 was
  // followed by another at ~01:07:17, and the promise was never kept.
  first.stop();
  check("the dead boot resumed nothing", first.resumed.length === 0);

  // Boot 2 sees only what is on disk: 'failed' — a state markInterrupted's IN_FLIGHT scan skips.
  const second = boot(bed);
  check("the promise is still on disk for boot 2 to find", bed.db.getThread(id)?.error === AUTO_RESUME_MSG);
  await sleep(AUTO_RESUME_DELAY_MS + 800);
  check("boot 2 re-arms the lost auto-resume", second.resumed.includes(id), `resumed=[${second.resumed.join(",")}]`);
  check("…and charges the attempt durably, so it can't loop forever", bed.db.getThreadStageOutputs(id).autoResumeRevivals === 1, String(bed.db.getThreadStageOutputs(id).autoResumeRevivals));
  // The forensic trail: index.ts writes this to crash.log, which is what makes a restart's effect on
  // in-flight work greppable rather than a cross-table reconstruction after the fact.
  check("boot 1 reports what it interrupted", (first.mgr.bootReconcile ?? "").includes("resumed=1"), String(first.mgr.bootReconcile));
  check("boot 2 reports the revival", (second.mgr.bootReconcile ?? "").includes("revived=1"), String(second.mgr.bootReconcile));

  second.stop();
  bed.dispose();
}

async function testOnlyTheOwedOnesAreRevived(): Promise<void> {
  console.log("\nTest B — only a thread that is actually owed a resume is touched\n");
  const bed = makeBed("restart-revive-controls-");
  const owed = seedStrandedTask(bed);
  // The human-gated twin: a restart during a question/approval leaves THIS message and must stay put —
  // reviving it would spawn an agent on work that was deliberately waiting for a person.
  const manual = seedStrandedTask(bed, { error: MANUAL_RESUME_MSG });
  // An ordinary failure, and a failure with no error text at all.
  const ordinary = seedStrandedTask(bed, { error: "Workspace \"C:\\gone\" does not exist on disk — agents can't run there." });
  const blank = seedStrandedTask(bed, { error: "" });
  // Budget spent: attempts that never got the task running again belong to a person now.
  const spent = seedStrandedTask(bed, { revivals: MAX_STRANDED_REVIVALS });
  // Crash-looping: the resumes DO start and die within seconds — the pre-existing guard must still bind.
  const looping = seedStrandedTask(bed);
  seedFastInterrupts(bed, looping, 3);
  // Too old to pick up: the promise meant "in 4 seconds". Waking a day-old session onto a workspace other
  // agents have since committed to is a surprise, not a recovery — a person decides that one.
  const stale = seedStrandedTask(bed, { ageMs: 25 * 3600_000 });
  const justInside = seedStrandedTask(bed, { ageMs: 23 * 3600_000 });

  const b = boot(bed);
  await sleep(AUTO_RESUME_DELAY_MS + 800);

  check("the owed task is revived", b.resumed.includes(owed), `resumed=[${b.resumed.join(",")}]`);
  check("a restart that was waiting on a person is left alone", !b.resumed.includes(manual));
  check("…and keeps its click-Resume message", bed.db.getThread(manual)?.error === MANUAL_RESUME_MSG);
  check("an ordinary failure is not revived", !b.resumed.includes(ordinary));
  check("a failure with no error text is not revived", !b.resumed.includes(blank));

  check("a task whose revival budget is spent is not revived", !b.resumed.includes(spent));
  const spentErr = bed.db.getThread(spent)?.error ?? "";
  check("…and it stops claiming it is auto-resuming", spentErr !== AUTO_RESUME_MSG, spentErr);
  check("…and says a click is needed now", /Resume/.test(spentErr), spentErr);
  check("…while still reading as a restart interruption for the resume seed", spentErr.startsWith("interrupted by a server restart"), spentErr);

  check("a crash-looping task is not revived either", !b.resumed.includes(looping));
  check("…and says so rather than promising a resume", (bed.db.getThread(looping)?.error ?? "") !== AUTO_RESUME_MSG, bed.db.getThread(looping)?.error ?? "");

  check("a promise older than the staleness bound is not revived", !b.resumed.includes(stale));
  check("…and says it is too old rather than still promising", /too old to pick up/.test(bed.db.getThread(stale)?.error ?? ""), bed.db.getThread(stale)?.error ?? "");
  check("…while one just inside the bound still is", b.resumed.includes(justInside), `resumed=[${b.resumed.join(",")}]`);

  b.stop();
  bed.dispose();
}

async function testRevivalIsBoundedThenReleased(): Promise<void> {
  console.log("\nTest C — the budget counts consecutive failures, and a fresh interruption clears it\n");
  const bed = makeBed("restart-revive-budget-");
  const id = seedStrandedTask(bed);

  // Boot after boot, each dying before its timer fires: the attempts accumulate and then stop.
  const armed: number[] = [];
  for (let i = 0; i < MAX_STRANDED_REVIVALS + 1; i++) {
    const b = boot(bed);
    await sleep(AUTO_RESUME_DELAY_MS + 400);
    armed.push(b.resumed.length);
    b.stop();
    // Each boot re-strands it exactly as the last one did.
    if (bed.db.getThread(id)?.error === AUTO_RESUME_MSG) bed.db.updateThread(id, { state: "failed", error: AUTO_RESUME_MSG });
  }
  check(`the resume is re-armed ${MAX_STRANDED_REVIVALS}× and then stops`, armed.join(",") === [...Array(MAX_STRANDED_REVIVALS).fill(1), 0].join(","), armed.join(","));
  check("the counter records every attempt", bed.db.getThreadStageOutputs(id).autoResumeRevivals === MAX_STRANDED_REVIVALS, String(bed.db.getThreadStageOutputs(id).autoResumeRevivals));

  // A LATER genuine interruption is a new episode — it must get the full budget again, or a long-lived
  // task that survived three strandings over its lifetime could never be auto-resumed again.
  bed.db.updateThread(id, { state: "implementing", error: null });
  bed.db.createRun({ threadId: id, role: "implementor", model: "claude-opus-5" });
  const fresh = boot(bed);
  check("a fresh interruption resets the budget", bed.db.getThreadStageOutputs(id).autoResumeRevivals === 0, String(bed.db.getThreadStageOutputs(id).autoResumeRevivals));
  await sleep(AUTO_RESUME_DELAY_MS + 400);
  check("…and that interruption's own resume still fires", fresh.resumed.includes(id));

  fresh.stop();
  bed.dispose();
}

async function main(): Promise<void> {
  console.log("\n=== A restart's auto-resume promise survives a second restart — integration test ===");
  await testStrandedPromiseIsRevived();
  await testOnlyTheOwedOnesAreRevived();
  await testRevivalIsBoundedThenReleased();

  console.log(`\n${failed === 0 ? "✅ ALL PASSED" : "❌ FAILURES"} — ${passed} passed, ${failed} failed`);
  if (failed) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

await main();
