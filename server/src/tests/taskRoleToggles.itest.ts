/**
 * Integration test — per-task agent switches (planner / researcher / QA / self-improvement), settable
 * after the task exists.
 *
 * Part 1 drives the REAL runPipeline with runRole and the implementor-spawning leaves stubbed (the depth
 * routeSelection.itest.ts uses), proving the switches beat both the global settings and the task-aware
 * route, and that QA switched on or off WHILE the implementor works is honoured at its hand-off.
 * Part 2 drives the REAL runRole through its createRoleAgent seam (providerFallback.itest.ts's depth),
 * proving a role switched off mid-run is stopped and yields no result instead of failing over.
 *
 * Run:  npm run test:task-role-toggles   (from server/)
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResultEvent } from "../agents/runner.js";

const { Db } = await import("../db/db.js");
const { EventHub } = await import("../events.js");
const { FileMemoryService } = await import("../memory/memory.js");
const { AccountManager } = await import("../accounts/accountManager.js");
const { ResetStagger } = await import("../accounts/resetStagger.js");
const { ThreadManager } = await import("../orchestrator/threadManager.js");
const { config } = await import("../config.js");

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

const TERMINAL = new Set(["done", "review", "failed", "cancelled"]);
const NARROW_BRIEF = "Fix the typo in the README: 'recieve' should be 'receive'.";
const BROAD_BRIEF = "Add two-factor authentication to the login flow, including SMS and TOTP support, with a new database table.";
const SUCCESS: ResultEvent = { type: "result", subtype: "success", isError: false };

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

async function until(cond: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return cond();
}

interface Harness {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  manager: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  internals: any;
  roleCalls: string[];
  /** Replace to hold the implementor mid-work; defaults to an immediate clean finish. */
  implementorGate: () => Promise<ResultEvent>;
  createTask(brief: string, extra?: Record<string, unknown>): string;
  start(id: string): void;
  pollTerminal(id: string, timeoutMs?: number): Promise<string>;
  dispose(): void;
}

function makeHarness(): Harness {
  const dataDir = mkdtempSync(join(tmpdir(), "task-role-toggles-"));
  const db = new Db(join(dataDir, "orchestrator.sqlite"));
  const hub = new EventHub();
  const accounts = new AccountManager(config.accounts, hub, config.accountPingMs, {
    stagger: new ResetStagger(),
    persist: {
      load: (id: string) => { const v = db.kvGet(`account_usage_${id}`); try { return v ? JSON.parse(v) : null; } catch { return null; } },
      save: (id: string, u: unknown) => db.kvSet(`account_usage_${id}`, JSON.stringify(u)),
    },
  });
  const manager = new ThreadManager(db, hub, new FileMemoryService(join(dataDir, "memory")), accounts);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = manager as any;
  internals.resumeCapParked = (): void => {};
  if (internals.capSupervisor) clearInterval(internals.capSupervisor);
  if (internals.tokenResumeTimer) clearTimeout(internals.tokenResumeTimer);
  if (internals.capResumeWake) clearTimeout(internals.capResumeWake);

  const roleCalls: string[] = [];
  const canned: Record<string, ResultEvent> = {
    planner: { ...SUCCESS, structuredOutput: { summary: "plan", steps: [], risks: [], openQuestions: [], nextAgent: "implementor" } },
    researcher: { ...SUCCESS, structuredOutput: { summary: "research", findings: [], sources: [] } },
    qa: { ...SUCCESS, structuredOutput: { pass: true, summary: "looks good", issues: [] } },
  };
  internals.runRole = async (_t: unknown, role: string): Promise<ResultEvent | undefined> => {
    roleCalls.push(role);
    return canned[role];
  };
  const h: Harness = {
    manager,
    db,
    internals,
    roleCalls,
    implementorGate: async () => SUCCESS,
    createTask(brief, extra = {}) {
      return db.createThread({ title: brief.slice(0, 40), workspace: process.cwd(), rawPrompt: brief, brief, ...extra }).id;
    },
    start(id) {
      void internals.runPipeline(id);
    },
    async pollTerminal(id, timeoutMs = 4000) {
      await until(() => TERMINAL.has(db.getThread(id)?.state ?? "gone") && !internals.activePipelines?.has(id), timeoutMs);
      return db.getThread(id)?.state ?? "gone";
    },
    dispose() {
      try { db.raw.close(); } catch { /* already closed */ }
      try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* windows file lock — harmless */ }
    },
  };
  internals.autoSelectModel = async (): Promise<undefined> => undefined;
  internals.gateImplementorProvider = (): string => "claude";
  internals.stopLive = async (): Promise<void> => {};
  internals.flushDirectorNotes = (): void => {};
  internals.startResumedImplementor = async (): Promise<{ run: unknown; accountId: string }> => ({ run: { send() {} }, accountId: "acct1" });
  internals.awaitImplementorCompletion = async (): Promise<ResultEvent> => h.implementorGate();
  internals.drainQueuedImplementor = async (_t: unknown, _e: unknown, _k: string, res: ResultEvent | undefined): Promise<ResultEvent | undefined> => res;
  return h;
}

async function pipelineScenarios(): Promise<void> {
  console.log("\n1. Switches set before the pipeline starts beat the route and the settings");
  {
    const h = makeHarness();
    try {
      const id = h.createTask(BROAD_BRIEF);
      await h.manager.setThreadRole(id, "planner", false);
      await h.manager.setThreadRole(id, "qa", false);
      h.start(id);
      const state = await h.pollTerminal(id);
      check("a broad task with planner+QA switched off settles done", state === "done", state);
      check("…without running the planner or QA", !h.roleCalls.includes("planner") && !h.roleCalls.includes("qa"), h.roleCalls.join(","));
      const notice = h.db.listMessages(id).map((m: { content: string }) => m.content).find((c: string) => c.startsWith("🧭 Route"));
      check("the route notice names the task's own switches", !!notice?.includes("switched off for this task"), notice);
    } finally { h.dispose(); }
  }
  {
    const h = makeHarness();
    try {
      h.manager.setSettings({ plannerEnabled: false, researcherEnabled: false, qaEnabled: false });
      const id = h.createTask(NARROW_BRIEF);
      for (const role of ["planner", "researcher", "qa"]) await h.manager.setThreadRole(id, role, true);
      h.start(id);
      const state = await h.pollTerminal(id);
      check("a narrow task with every role disabled globally still settles done", state === "done", state);
      check("…running planner, researcher and QA in order because the task switched them on",
        h.roleCalls.join(",") === "planner,researcher,qa", h.roleCalls.join(","));
    } finally { h.dispose(); }
  }

  console.log("\n2. QA switched while the implementor is working takes effect at its hand-off");
  {
    const h = makeHarness();
    try {
      const gate = deferred<ResultEvent>();
      h.implementorGate = () => gate.promise;
      const id = h.createTask(NARROW_BRIEF);
      h.start(id);
      await until(() => h.db.getThread(id)?.state === "implementing");
      const result = await h.manager.setThreadRole(id, "qa", true);
      check("switching QA on mid-run is accepted", result.ok === true, JSON.stringify(result));
      gate.resolve(SUCCESS);
      const state = await h.pollTerminal(id);
      check("a narrow task routed without QA gets reviewed once QA is switched on", h.roleCalls.includes("qa") && state === "done", `${state} ${h.roleCalls.join(",")}`);
    } finally { h.dispose(); }
  }
  {
    const h = makeHarness();
    try {
      const gate = deferred<ResultEvent>();
      h.implementorGate = () => gate.promise;
      const id = h.createTask(BROAD_BRIEF);
      h.start(id);
      await until(() => h.db.getThread(id)?.state === "implementing");
      await h.manager.setThreadRole(id, "qa", false);
      gate.resolve(SUCCESS);
      const state = await h.pollTerminal(id);
      check("a broad task routed with QA settles done without it once QA is switched off", !h.roleCalls.includes("qa") && state === "done", `${state} ${h.roleCalls.join(",")}`);
      await h.manager.setThreadRole(id, "qa", null);
      check("returning QA to Auto lifts the finish-without-QA marker", h.db.getThreadStageOutputs(id).ownerQaBypassedAt == null);
    } finally { h.dispose(); }
  }

  console.log("\n3. Self-improvement follows the task's switch over the global setting");
  {
    const h = makeHarness();
    try {
      const rounds: string[] = [];
      h.internals.latestImplementorSession = () => "session-1";
      h.internals.selfImprovementRound = async (t: { id: string }) => { rounds.push(t.id); };
      const on = h.createTask(NARROW_BRIEF);
      await h.manager.setThreadRole(on, "selfImprove", true);
      await h.internals.runSelfImprovement(h.db.getThread(on), undefined, "kickoff");
      check("switched on with the setting off → the bonus round starts", rounds.includes(on));
      h.manager.setSettings({ selfImproveEnabled: true });
      const off = h.createTask(NARROW_BRIEF);
      await h.manager.setThreadRole(off, "selfImprove", false);
      await h.internals.runSelfImprovement(h.db.getThread(off), undefined, "kickoff");
      check("switched off with the setting on → it settles without one", !rounds.includes(off) && h.db.getThread(off)?.state === "done");
    } finally { h.dispose(); }
  }

  console.log("\n4. Persistence, notices and refusals");
  {
    const h = makeHarness();
    try {
      const id = h.createTask(BROAD_BRIEF);
      await h.manager.setThreadRole(id, "researcher", false);
      await h.manager.setThreadRole(id, "qa", true);
      check("the switches round-trip through the task row", JSON.stringify(h.db.getThread(id)?.roleToggles) === JSON.stringify({ researcher: false, qa: true }));
      const same = await h.manager.setThreadRole(id, "qa", true);
      check("repeating a switch is a no-op", same.ok === true && /already on/.test(same.message ?? ""), same.message);
      await h.manager.setThreadRole(id, "researcher", null);
      await h.manager.setThreadRole(id, "qa", null);
      check("Auto on every role clears the column", h.db.getThread(id)?.roleToggles == null);
      const notices = h.db.listMessages(id).filter((m: { content: string }) => m.content.startsWith("◆")).length;
      check("each change posts one feed notice", notices === 4, String(notices));

      h.db.updateThreadStageOutputs(id, { planDone: true, kickoff: "k" });
      const late = await h.manager.setThreadRole(id, "planner", true);
      check("a switch for a stage already passed says it applies on retry", /applies if the task is retried/.test(late.message ?? ""), late.message);

      const read = h.createTask(NARROW_BRIEF, { lane: "read" });
      check("a read-lane task refuses switches", (await h.manager.setThreadRole(read, "qa", true)).ok === false);
      const child = h.createTask(NARROW_BRIEF, { parentId: id });
      check("a share of a parent task refuses switches", (await h.manager.setThreadRole(child, "qa", true)).ok === false);
    } finally { h.dispose(); }
  }
}

/** A role agent whose run only ends when stopped — the shape of an abort mid-turn: success, no output. */
function heldRoleAgent(created: string[]) {
  const done = deferred<ResultEvent>();
  created.push("agent");
  return {
    capped: false,
    rateLimited: false,
    transientApiError: false,
    transientApiErrorMessage: undefined,
    sessionId: undefined,
    start: () => {},
    result: () => done.promise,
    nextResult: () => done.promise,
    stop: async () => done.resolve(SUCCESS),
  };
}

async function liveStopScenarios(): Promise<void> {
  console.log("\n5. A role switched off while it runs is stopped and yields nothing (real runRole)");
  for (const role of ["planner", "researcher", "qa"] as const) {
    const dataDir = mkdtempSync(join(tmpdir(), "task-role-live-"));
    const db = new Db(join(dataDir, "orchestrator.sqlite"));
    try {
      const hub = new EventHub();
      const accounts = new AccountManager(config.accounts, hub, config.accountPingMs, {
        stagger: new ResetStagger(),
        persist: { load: () => null, save: () => {} },
      });
      const manager = new ThreadManager(db, hub, new FileMemoryService(join(dataDir, "memory")), accounts);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const internals = manager as any;
      internals.resumeCapParked = (): void => {};
      if (internals.capSupervisor) clearInterval(internals.capSupervisor);
      if (internals.tokenResumeTimer) clearTimeout(internals.tokenResumeTimer);
      if (internals.capResumeWake) clearTimeout(internals.capResumeWake);
      internals.dispatchAccount = () => ({ id: "claude-a", label: "Claude A", token: undefined });
      internals.providerSafeForRole = () => true;
      internals.wireRun = () => {};
      internals.officeCheckIn = () => {};
      internals.ensureGroup = () => {};
      internals.tryFreeStructuredRole = async () => undefined;
      internals.awaitStructuredReviewResult = async (_t: unknown, _l: unknown, agent: { result(): Promise<ResultEvent> }) => agent.result();
      const created: string[] = [];
      internals.createRoleAgent = () => heldRoleAgent(created);

      const thread = db.createThread({ title: `live ${role}`, workspace: process.cwd(), rawPrompt: "x", brief: "x" });
      const running = internals.runRole(thread, role, "Do the role.", () => ({ model: "unused" }));
      const handle = role === "planner" ? internals.liveRole : role === "researcher" ? internals.liveResearcher : internals.liveQa;
      const live = await until(() => handle.has(thread.id), 2000);
      check(`the running ${role} is reachable to be stopped`, live);
      const action = await manager.setThreadRole(thread.id, role, false);
      const res = await Promise.race([running, new Promise((r) => setTimeout(() => r("timeout"), 3000))]);
      check(`switching the ${role} off stops it and runRole returns no result`, res === undefined, JSON.stringify(res));
      check(`…without a failover spawning another ${role}`, created.length === 1, String(created.length));
      check(`…and the notice says it was stopped`, /was stopped/.test(action.message ?? ""), action.message);
      const run = db.listRuns(thread.id).find((r: { role: string }) => r.role === role);
      check(`…and its run is recorded as interrupted, not a finished verdict`, run?.state === "interrupted", run?.state);
    } finally {
      try { db.raw.close(); } catch { /* already closed */ }
      try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* windows file lock — harmless */ }
    }
  }
}

async function main(): Promise<void> {
  console.log("Per-task agent switches (real Db/EventHub/runPipeline/runRole, stubbed agent-spawning leaves)");
  await pipelineScenarios();
  await liveStopScenarios();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log("Failures:\n" + failures.map((f) => `  - ${f}`).join("\n"));
    process.exit(1);
  }
  process.exit(0);
}

await main();
