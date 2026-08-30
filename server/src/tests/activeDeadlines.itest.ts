/**
 * Integration regression for operator-appointed active-task hard deadlines.
 *
 * REAL: SQLite schema/mapper, ThreadManager timer replacement and boot restoration, the synchronous
 * deadline park, concurrent live-handle teardown, durable run/session evidence, resume guards, and
 * the WebSocket trust-boundary schema. STUBBED: only provider handles (recording stop functions) and
 * the one manual-resume leaf used to prove that a second explicit operator action can continue.
 * No provider process or paid request is started.
 *
 * Run: npm run test:active-deadlines (from server/)
 */

process.env.CAP_RETRY_MS = "0";
process.env.ACCOUNT_PING_MS = "3600000";
process.env.FAST_ACCOUNT_PING_MS = "3600000";

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountManager } from "../accounts/accountManager.js";

const { Db } = await import("../db/db.js");
const { EventHub } = await import("../events.js");
const { FileMemoryService } = await import("../memory/memory.js");
const { ACTIVE_DEADLINE_PARK_PREFIX, ThreadManager } = await import("../orchestrator/threadManager.js");
const { clientCommandSchema } = await import("../ws/protocol.js");

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean, timeoutMs = 1_500): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (condition()) return true;
    await sleep(10);
  }
  return condition();
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
  auxToken(): string | undefined {
    return undefined;
  }
}

interface Harness {
  dir: string;
  workspace: string;
  db: InstanceType<typeof Db>;
  mgr: InstanceType<typeof ThreadManager>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  internals: any;
  dispose(): void;
}

function clearManagerTimers(internals: any): void { // eslint-disable-line @typescript-eslint/no-explicit-any
  if (internals.capSupervisor) clearInterval(internals.capSupervisor);
  if (internals.tokenResumeTimer) clearTimeout(internals.tokenResumeTimer);
  if (internals.capResumeWake) clearTimeout(internals.capResumeWake);
  for (const timer of internals.activeDeadlineTimers?.values?.() ?? []) clearTimeout(timer);
  internals.activeDeadlineTimers?.clear?.();
}

function makeHarness(prefix = "active-deadline-"): Harness {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const workspace = join(dir, "workspace");
  mkdirSync(workspace, { recursive: true });
  const db = new Db(join(dir, "orchestrator.sqlite"));
  const mgr = new ThreadManager(
    db,
    new EventHub(),
    new FileMemoryService(join(dir, "memory")),
    new StubAccounts() as unknown as AccountManager,
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = mgr as any;
  return {
    dir,
    workspace,
    db,
    mgr,
    internals,
    dispose() {
      clearManagerTimers(internals);
      db.raw.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function task(h: Harness, title: string, state: "intake" | "implementing" = "implementing") {
  const thread = h.db.createThread({ title, workspace: h.workspace, rawPrompt: "long-lived work", brief: "keep going" });
  h.db.updateThread(thread.id, { state });
  return h.db.getThread(thread.id)!;
}

async function persistenceAndProtocol(): Promise<void> {
  console.log("\nA — persistence and authenticated WebSocket command shape\n");
  const h = makeHarness("deadline-persist-");
  const dbPath = join(h.dir, "orchestrator.sqlite");
  try {
    const t = task(h, "persistent deadline");
    const at = Date.now() + 3_600_000;
    const result = await h.mgr.setActiveDeadline(t.id, at);
    check("the manager accepts a practical future deadline", result.ok);
    check("the authoritative thread mapper exposes the exact epoch", h.db.getThread(t.id)?.activeDeadlineAt === at);
    const raw = h.db.raw.prepare("SELECT active_deadline_at AS at FROM threads WHERE id = ?").get(t.id) as { at: number | null } | undefined;
    check("the SQLite column contains the exact epoch", raw?.at === at);

    clearManagerTimers(h.internals);
    h.db.raw.close();
    const reopened = new Db(dbPath);
    check("the deadline survives a real database close/reopen", reopened.getThread(t.id)?.activeDeadlineAt === at);
    reopened.raw.close();

    const valid = clientCommandSchema.safeParse({ type: "thread.deadline", threadId: t.id, deadlineAt: at });
    const clear = clientCommandSchema.safeParse({ type: "thread.deadline", threadId: t.id, deadlineAt: null });
    const malformed = clientCommandSchema.safeParse({ type: "thread.deadline", threadId: t.id, deadlineAt: "three hours" });
    const fractional = clientCommandSchema.safeParse({ type: "thread.deadline", threadId: t.id, deadlineAt: at + 0.5 });
    check("the WS API accepts set and clear commands", valid.success && clear.success);
    check("the WS API rejects non-numeric and fractional epochs", !malformed.success && !fractional.success);
  } finally {
    // The handle was closed above to prove persistence; remove the throwaway directory directly.
    rmSync(h.dir, { recursive: true, force: true });
  }
}

async function liveExpiry(): Promise<void> {
  console.log("\nB — a busy task is durably parked before every live provider is stopped\n");
  const h = makeHarness("deadline-live-");
  try {
    const t = task(h, "Bobfish-style long task");
    const run = h.db.createRun({ threadId: t.id, role: "implementor", model: "gpt-5.6-sol", account: "codex:gpt-5.6-sol" });
    h.db.updateRun(run.id, { state: "running", sessionId: "saved-session-123" });

    const stops: number[] = [];
    const slow = { stop: async () => { stops.push(Date.now()); await sleep(80); } };
    const fast = { stop: async () => { stops.push(Date.now()); } };
    h.internals.activeRuns.set(t.id, new Set([slow, fast]));

    const deadlineAt = Date.now() + 60;
    check("arming the live task succeeds", (await h.mgr.setActiveDeadline(t.id, deadlineAt)).ok);
    check("the timer parks the task", await waitFor(() => (h.db.getThread(t.id)?.error ?? "").startsWith(ACTIVE_DEADLINE_PARK_PREFIX)));

    const parked = h.db.getThread(t.id)!;
    check("expiry lands in an explicit review park", parked.state === "review" && parked.error?.includes("automatic dispatch/resume is blocked") === true, `${parked.state}: ${parked.error}`);
    check("all duplicate live handles receive stop without serial delay", stops.length === 2 && Math.abs(stops[0]! - stops[1]!) < 25, JSON.stringify(stops));
    check("the run is finalized after teardown", await waitFor(() => h.db.getRun(run.id)?.endedAt != null));

    const ended = h.db.getRun(run.id)!;
    check("the run trail names the hard deadline", ended.state === "interrupted" && ended.error?.includes("hard deadline") === true, `${ended.state}: ${ended.error}`);
    check("the resumable provider session id is preserved", ended.sessionId === "saved-session-123", String(ended.sessionId));
    check("no in-memory agent handle remains", (h.internals.activeRuns.get(t.id)?.size ?? 0) === 0);
    check("a system message preserves the operator-visible handoff", h.db.listMessages(t.id).some((m) => m.content.includes(ACTIVE_DEADLINE_PARK_PREFIX)));
    check("a finding preserves deadline evidence", h.db.listFindings(t.id).some((f) => f.summary.includes("Hard deadline reached")));

    // Reproduce the provider finishing its unwind after the park. The central transition guard must
    // reject this stale success, even if an individual pipeline branch forgot its boundary check.
    h.internals.setState(t.id, "done");
    check("a late provider completion cannot overwrite the park", h.db.getThread(t.id)?.state === "review");
  } finally {
    h.dispose();
  }
}

async function changeAndClear(): Promise<void> {
  console.log("\nC — editing replaces the old alarm and clearing removes it\n");
  const h = makeHarness("deadline-edit-");
  try {
    const t = task(h, "editable clock");
    const first = Date.now() + 90;
    await h.mgr.setActiveDeadline(t.id, first);
    await sleep(25);
    const replacement = Date.now() + 260;
    await h.mgr.setActiveDeadline(t.id, replacement);
    await sleep(110);
    check("the superseded timer cannot stop the task", h.db.getThread(t.id)?.state === "implementing" && h.db.getThread(t.id)?.activeDeadlineAt === replacement);

    const cleared = await h.mgr.setActiveDeadline(t.id, null);
    check("clear succeeds and persists NULL", cleared.ok && h.db.getThread(t.id)?.activeDeadlineAt === null);
    await sleep(190);
    check("the cleared replacement timer cannot stop the task", h.db.getThread(t.id)?.state === "implementing");
    check("clear removes the in-memory alarm", !h.internals.activeDeadlineTimers.has(t.id));
  } finally {
    h.dispose();
  }
}

async function restartAndResumeGuard(): Promise<void> {
  console.log("\nD — restart expiry blocks cold replay and requires two deliberate operator actions\n");
  const dir = mkdtempSync(join(tmpdir(), "deadline-boot-"));
  const workspace = join(dir, "workspace");
  mkdirSync(workspace, { recursive: true });
  const db = new Db(join(dir, "orchestrator.sqlite"));
  let internals: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    const t = db.createThread({ title: "expired during restart", workspace, rawPrompt: "work", brief: "work" });
    db.updateThread(t.id, { state: "implementing" });
    db.setActiveDeadline(t.id, Date.now() - 1_000);
    const run = db.createRun({ threadId: t.id, role: "implementor", model: "gpt-5.6-sol", account: "codex:gpt-5.6-sol" });
    db.updateRun(run.id, { state: "running", sessionId: "boot-session" });

    const mgr = new ThreadManager(db, new EventHub(), new FileMemoryService(join(dir, "memory")), new StubAccounts() as unknown as AccountManager);
    internals = mgr as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    check("boot parks an already-expired in-flight row before restart reconciliation", (db.getThread(t.id)?.error ?? "").startsWith(ACTIVE_DEADLINE_PARK_PREFIX));
    check("boot stamps the orphaned run with the deadline reason", await waitFor(() => db.getRun(run.id)?.error?.includes("hard deadline") === true));

    // The ordinary restart resurrection fires after four seconds. Wait past that real boundary and
    // prove neither a duplicate row nor an active pipeline appeared.
    await sleep(4_150);
    check("the restart supervisor does not cold-replay the expired task", db.listRuns(t.id).length === 1 && !internals.activePipelines.has(t.id) && !internals.resuming.has(t.id));

    const extendedAt = Date.now() + 10_000;
    check("the operator can extend the expired clock", (await mgr.setActiveDeadline(t.id, extendedAt)).ok);
    const automatic = await mgr.resumeThread(t.id);
    check("extension alone still cannot trigger an automatic resume", !automatic.ok && automatic.error?.includes("Automatic resume is blocked") === true, automatic.error);

    let manualStarts = 0;
    internals.resumeImplementorOnly = async (): Promise<void> => { manualStarts++; };
    const manual = await internals.resumeThread(t.id, undefined, true);
    check("a subsequent explicit Resume releases the saved session", manual.ok && manualStarts === 1 && db.getThread(t.id)?.state === "implementing");
  } finally {
    if (internals) clearManagerTimers(internals);
    db.raw.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  console.log("\n=== active-task hard deadlines — real persistence + ThreadManager enforcement ===");
  await persistenceAndProtocol();
  await liveExpiry();
  await changeAndClear();
  await restartAndResumeGuard();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.error(failures.map((failure) => `  - ${failure}`).join("\n"));
    process.exitCode = 1;
  }
}

await main();
