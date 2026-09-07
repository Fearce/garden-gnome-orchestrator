/**
 * Planned-restart drain integration gate.
 *
 * Real: durable restart coordination, active-work admission lock, task queue release, Co-worker start
 * refusal, legacy pending-row migration, failed-fire retry, and loopback boundary.
 * Stubbed: only the fatal supervisor restart itself.
 */

process.env.CAP_RETRY_MS = "0";
process.env.ACCOUNT_PING_MS = "3600000";
process.env.FAST_ACCOUNT_PING_MS = "3600000";

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountManager } from "../accounts/accountManager.js";
import type { RestartAttempt } from "../selfRestart.js";

const { Db } = await import("../db/db.js");
const { EventHub } = await import("../events.js");
const { FileMemoryService } = await import("../memory/memory.js");
const { ThreadManager } = await import("../orchestrator/threadManager.js");
const { CoworkManager } = await import("../orchestrator/cowork.js");
const { Director } = await import("../orchestrator/director.js");
const {
  RestartCoordinator,
  decideRestart,
  isLoopbackAddress,
} = await import("../orchestrator/restartCoordinator.js");
const { hubRestartWasANoop } = await import("../selfRestart.js");

let failures = 0;
function check(name: string, condition: unknown, detail?: string): void {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate: () => boolean, ms = 2_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!predicate() && Date.now() < deadline) await sleep(10);
  return predicate();
}

class StubAccounts {
  onUsageRefresh(_cb: () => void): void {}
  effectiveUtilization(): number | null { return null; }
  soonestResetAt(): number | null { return null; }
  hasHeadroom(): boolean { return true; }
  setPingInterval(_ms: number): void {}
  applyEnabled(_id: string, _enabled: boolean): void {}
  applyWeeklySafetyPct(_id: string, _pct: number): void {}
  setSpreadUsage(_on: boolean): void {}
  auxToken(): string | undefined { return undefined; }
}

const dir = mkdtempSync(join(tmpdir(), "restart-drain-"));
const workspace = join(dir, "workspace");
mkdirSync(workspace, { recursive: true });
const db = new Db(join(dir, "orchestrator.sqlite"));
const hub = new EventHub();
const PENDING_KEY = "restart_coordinator_pending";
const LEGACY_PENDING_KEY = "deploy_gate_pending";

async function main(): Promise<void> {
  console.log("\npolicy: active work has no elapsed-time escape hatch");
  const now = Date.now();
  check("idle permits a restart", decideRestart({ activeWork: 0, now }).allow);
  check("one active item holds it", !decideRestart({ activeWork: 1, now }).allow);
  check("many active items hold it", !decideRestart({ activeWork: 9, now: now + 24 * 60 * 60_000 }).allow);
  const retry = decideRestart({ activeWork: 0, now, retryAt: now + 60_000 });
  check("time gates only a failed-fire retry", !retry.allow && retry.retryAt === now + 60_000);

  console.log("\ncoordinator: a live agent drains, and every staged build rides its restart");
  db.kvSet(PENDING_KEY, "");
  db.kvSet(LEGACY_PENDING_KEY, "");
  let active = 1;
  let restarts = 0;
  const coordinator = new RestartCoordinator({
    db,
    hub,
    activeWork: () => active,
    pollMs: 25,
    settleMs: 0,
    restart: async () => {
      restarts++;
      return { route: "hub", ok: true, detail: "accepted" } satisfies RestartAttempt;
    },
  });
  const first = coordinator.request({ label: "task A", commit: "aaaaaaa", stampedAt: now });
  check("one active task is enough to defer", first.outcome === "deferred" && first.activeWork === 1);
  check("a normal drain has no fake clock deadline", first.readyAt === null && /active work/.test(first.waitLabel));
  check("the admission lock is active immediately", coordinator.isDraining());
  const second = coordinator.request({ label: "task B", commit: "bbbbbbb", stampedAt: now + 1 });
  check("a second build joins the same durable restart", second.outcome === "deferred" && second.staged === 2);
  await sleep(80);
  check("elapsed time never kills the active agent", restarts === 0);
  active = 0;
  coordinator.workChanged();
  check("the restart fires as soon as work settles", await waitFor(() => restarts === 1));
  check("the firing latch stays closed until the process dies", coordinator.isDraining());
  coordinator.stop();

  console.log("\ndurability: a pending drain survives the process and ignores the removed hourly window");
  db.kvSet(PENDING_KEY, "");
  db.kvSet(LEGACY_PENDING_KEY, JSON.stringify({
    readyAt: now + 60 * 60_000,
    createdAt: now,
    requesters: [{ at: now, label: "legacy hold", commit: "ccccccc", stampedAt: now + 2 }],
    failures: 0,
  }));
  let legacyActive = 1;
  let legacyRestarts = 0;
  const legacy = new RestartCoordinator({
    db,
    hub,
    activeWork: () => legacyActive,
    pollMs: 25,
    settleMs: 0,
    restart: async () => {
      legacyRestarts++;
      return { route: "hub", ok: true, detail: "accepted" } satisfies RestartAttempt;
    },
  });
  legacy.start();
  check(
    "the legacy row migrates to restart-coordinator storage",
    db.kvGet(LEGACY_PENDING_KEY) === "" && !!db.kvGet(PENDING_KEY),
  );
  legacyActive = 0;
  legacy.workChanged();
  check("a legacy one-hour readyAt is discarded", await waitFor(() => legacyRestarts === 1));
  legacy.stop();

  console.log("\ndurability: another bounce can satisfy a staged restart without double-bouncing");
  const stamp = now + 3;
  db.kvSet(PENDING_KEY, JSON.stringify({
    createdAt: now,
    requesters: [{ at: now, label: "already deployed", commit: "ddddddd", stampedAt: stamp }],
    failures: 0,
    retryAt: null,
  }));
  let released = 0;
  const moot = new RestartCoordinator({
    db,
    hub,
    activeWork: () => 0,
    liveBuild: () => ({ at: stamp }),
    onDrainReleased: () => released++,
    restart: async () => ({ route: "hub", ok: true, detail: "should not run" }),
  });
  moot.start();
  check("the moot durable row is cleared", db.kvGet(PENDING_KEY) === "");
  check("queued work is explicitly released", released === 1 && !moot.isDraining());

  console.log("\nrecovery: a refused restart restores the drain instead of losing the build");
  db.kvSet(PENDING_KEY, "");
  let attempts = 0;
  let refusalReleases = 0;
  const refusing = new RestartCoordinator({
    db,
    hub,
    activeWork: () => 0,
    pollMs: 25,
    settleMs: 0,
    onDrainReleased: () => { refusalReleases++; },
    restart: async () => {
      attempts++;
      return attempts <= 3
        ? { route: "hub", ok: false, detail: "listener elevated" }
        : { route: "hub", ok: true, detail: "accepted" };
    },
  });
  const retryNow = (): void => {
    const pending = JSON.parse(db.kvGet(PENDING_KEY)!) as Record<string, unknown>;
    db.kvSet(PENDING_KEY, JSON.stringify({ ...pending, retryAt: Date.now() - 1 }));
    refusing.workChanged();
  };
  refusing.request({ label: "task C", commit: "eeeeeee", stampedAt: stamp + 1 });
  check("the first attempt ran", await waitFor(() => attempts === 1));
  check("its staged build and failure count are durable", await waitFor(() => {
    const raw = db.kvGet(PENDING_KEY);
    if (!raw) return false;
    const pending = JSON.parse(raw) as { failures?: number; requesters?: unknown[] };
    return pending.failures === 1 && pending.requesters?.length === 1;
  }));
  check("fresh work remains blocked during early retry backoff", refusing.isDraining() && refusalReleases === 0);
  retryNow();
  check("the second refused attempt ran", await waitFor(() => attempts === 2));
  check("fresh work still remains blocked before the alert threshold", refusing.isDraining() && refusalReleases === 0);
  retryNow();
  check("the third refused attempt ran", await waitFor(() => attempts === 3));
  check("fresh work is released during repeated-refusal backoff", !refusing.isDraining() && !refusing.status().draining && refusalReleases === 1);
  retryNow();
  check("a due retry closes admission and can later complete", refusing.isDraining() && await waitFor(() => attempts === 4));
  refusing.stop();

  console.log("\nadmission: fresh task and Co-worker starts pause, existing cohorts remain countable");
  db.kvSet(PENDING_KEY, "");
  const manager = new ThreadManager(
    db,
    hub,
    new FileMemoryService(join(dir, "memory")),
    new StubAccounts() as unknown as AccountManager,
  ) as any;
  let draining = true;
  const started: string[] = [];
  manager.startPipeline = (threadId: string): void => { started.push(threadId); };
  manager.attachRestartDrain(() => draining, () => {});
  const ledgerThread = db.createThread({ title: "ledger backstop", workspace, rawPrompt: "work" });
  const ledgerRun = db.createRun({ threadId: ledgerThread.id, role: "implementor", model: "test-model" });
  check("the durable run ledger prevents a false-idle restart", manager.activeWorkCount() === 1);
  db.updateRun(ledgerRun.id, { state: "done", endedAt: Date.now() });
  const queued = db.createThread({ title: "fresh task", workspace, rawPrompt: "work" });
  manager.enqueueOrRun(queued.id);
  check("fresh dispatch stays queued during drain", db.getThread(queued.id)?.state === "queued" && started.length === 0);
  draining = false;
  manager.restartDrainReleased();
  check("a moot drain releases the queue", started.includes(queued.id));

  draining = true;
  const parked = db.createThread({ title: "parked task", workspace, rawPrompt: "work" });
  db.updateThread(parked.id, { state: "review" });
  const resume = await manager.resumeThread(parked.id);
  const review = await manager.autoReview(parked.id);
  check("fresh manual resume is refused during drain", !resume.ok && /restarting/.test(resume.error ?? ""));
  check("fresh Auto-review is refused during drain", !review.ok && /restarting/.test(review.error ?? ""));

  const supervisorInternals = manager.supervisor as any;
  const supervisorTurnId = randomUUID();
  manager.supervisorSendMessage("Check the board status", [], supervisorTurnId);
  const supervisorTurn = db.getSupervisorChatTurn(supervisorTurnId);
  check(
    "fresh Supervisor chat is saved but starts no agent during drain",
    supervisorTurn?.status === "failed" && /planned restart/.test(supervisorTurn.response ?? "") && manager.activeWorkCount() === 0,
  );
  supervisorInternals.setEnabled(true);
  await manager.supervisorRunNow();
  check("manual Supervisor sweeps do not hang or enqueue during drain", supervisorInternals.snapshot().manualSweep === null);

  draining = false;
  let releaseSupervisor!: (value: unknown) => void;
  const supervisorJudgement = new Promise<unknown>((resolve) => { releaseSupervisor = resolve; });
  supervisorInternals.chat.judge = async () => supervisorJudgement;
  const acceptedSupervisorId = randomUUID();
  manager.supervisorSendMessage("Give me a nuanced board summary", [], acceptedSupervisorId);
  check("an accepted Supervisor turn is counted while its model works", await waitFor(() => manager.activeWorkCount() === 1));
  draining = true;
  releaseSupervisor({
    output: { reply: "No action is needed.", needsOwner: false, actions: [], boardActions: [] },
    costUsd: 0,
    tokenUsage: { totalTokens: 1 },
    model: "test-model",
    provider: "codex",
  });
  check(
    "an accepted Supervisor turn may settle before the restart",
    await waitFor(() => db.getSupervisorChatTurn(acceptedSupervisorId)?.status === "succeeded" && manager.activeWorkCount() === 0),
  );

  const director = new Director(manager, db, hub, {} as any, {} as any);
  let directorReleased = 0;
  director.attachRestartDrain(() => true, () => { directorReleased++; });
  const directorMessageId = randomUUID();
  director.handleUserMessage("Start another task", workspace, undefined, undefined, directorMessageId);
  const directorMessages = db.listDirectorMessages(5);
  check(
    "fresh Director chat is acknowledged but starts no agent during drain",
    director.activeWorkCount() === 0 &&
      directorMessages.some((message) => message.id === directorMessageId) &&
      directorMessages.some((message) => message.role === "director" && /not sent to a model/.test(message.content)),
  );
  const directorInternals = director as any;
  directorInternals.setBusy(true);
  check("an existing Director turn is counted", director.activeWorkCount() === 1);
  directorInternals.setBusy(false);
  check("settling a Director turn wakes the coordinator", director.activeWorkCount() === 0 && directorReleased === 1);

  const cowork = new CoworkManager(db, hub, {
    prepare: () => { throw new Error("restart guard failed"); },
    taskConflict: () => null,
    observeRateLimit: () => {},
    isCapped: () => false,
    noteCap: () => {},
    releasedWorkspace: () => {},
  } as any);
  cowork.attachRestartDrain(() => true);
  const created = cowork.create({ workspace });
  const coworkStart = cowork.send(created.session!.id, "new turn");
  check("fresh Co-worker turn is refused before provider preparation", !coworkStart.ok && /restarting/.test(coworkStart.error ?? ""));

  console.log("\nboundary: local deploy callers are accepted, LAN callers are not");
  check("IPv4 loopback", isLoopbackAddress("127.0.0.1"));
  check("IPv6 loopback", isLoopbackAddress("::1"));
  check("IPv4-mapped loopback", isLoopbackAddress("::ffff:127.0.0.1"));
  check("LAN is rejected", !isLoopbackAddress("192.168.0.122"));
  check("hub ok:false is a refusal", hubRestartWasANoop({ ok: false }));
  check("an empty hub kill list is a refusal", hubRestartWasANoop({ ok: true, stop: { killed: [] } }));
}

main()
  .then(() => {
    db.raw.close();
    rmSync(dir, { recursive: true, force: true });
    if (failures) {
      console.error(`\nrestart drain: FAILED (${failures})`);
      process.exit(1);
    }
    console.log("\nAll restart-drain checks passed.");
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
