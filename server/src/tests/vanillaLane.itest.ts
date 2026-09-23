/**
 * Integration test — Default mode (the "vanilla" lane).
 *
 * Default mode dispatches ONE stock implementor session: no orchestrator system-prompt wrapper, no
 * bus/office MCP tools, and no planner/researcher/QA/self-improvement/auto-review. It stays warm
 * ('paused', resumable via Inject/Resume on the SAME session) until the owner clicks Mark done.
 *
 * WHAT IS REAL vs. STUBBED (threadmanager-itest.md's "stub at the right depth")
 *  - REAL: the `Db` (temp file), `EventHub`, `enqueueOrRun`/`runPipeline`/`runVanillaLane`/
 *    `runImplementorQa`/`runImplementorQaLoop`'s vanilla branch, `gateVanillaProvider`'s candidate
 *    filter, `settleVanillaPaused`, `runImplementorOnlyResume`'s vanilla branch, and `markDone`.
 *  - STUBBED: only the agent-spawning leaves — `startResumedImplementor`, `awaitImplementorCompletion`,
 *    `drainQueuedImplementor`, `stopLive`, `flushDirectorNotes`. No `claude` subprocess, no quota.
 *
 * Section A is a pure-function test of `implementorConfig`'s `vanilla` opt (roles.ts) — the actual
 * "no wrapper" guarantee (bare system prompt, no MCP servers) lives there, one level below the stubs
 * above, so it needs its own direct assertion the same way reader.itest.ts's toolset section does.
 *
 * Run:  npm run test:vanilla-lane   (from server/)
 */

process.env.CAP_RETRY_MS = "0";
process.env.ACCOUNT_PING_MS = "3600000";
process.env.FAST_ACCOUNT_PING_MS = "3600000";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { AccountManager } from "../accounts/accountManager.js";
import type { ResultEvent } from "../agents/runner.js";
import type { Thread } from "../types.js";

const { implementorConfig } = await import("../agents/roles.js");
const { Db } = await import("../db/db.js");
const { EventHub } = await import("../events.js");
const { FileMemoryService } = await import("../memory/memory.js");
const { ThreadManager } = await import("../orchestrator/threadManager.js");

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

// ---- A. implementorConfig's `vanilla` opt — the actual "no wrapper" guarantee ----------------------
async function testVanillaConfig(): Promise<void> {
  console.log("\nA. implementorConfig({ vanilla: true }) — bare system prompt, no MCP servers");
  const fakeServer = { type: "sdk", name: "fake" } as unknown as McpServerConfig;

  const normal = implementorConfig(process.cwd(), { bus: fakeServer, office: fakeServer }, { effort: "high" });
  check(
    "the normal (non-vanilla) config carries the orchestrator append + MCP tools",
    typeof normal.systemPrompt === "object" && "append" in normal.systemPrompt! && Object.keys(normal.mcpServers ?? {}).length === 2,
    JSON.stringify(normal.systemPrompt) + " / " + JSON.stringify(Object.keys(normal.mcpServers ?? {})),
  );

  const vanilla = implementorConfig(process.cwd(), { bus: fakeServer, office: fakeServer }, { effort: "high", vanilla: true });
  check(
    "vanilla systemPrompt is the bare claude_code preset (no append)",
    typeof vanilla.systemPrompt === "object" &&
      (vanilla.systemPrompt as { type?: string; preset?: string; append?: string }).type === "preset" &&
      (vanilla.systemPrompt as { preset?: string }).preset === "claude_code" &&
      !("append" in (vanilla.systemPrompt as object)),
    JSON.stringify(vanilla.systemPrompt),
  );
  check("vanilla mcpServers is empty (no bus/office tools)", Object.keys(vanilla.mcpServers ?? {}).length === 0, JSON.stringify(vanilla.mcpServers));
  check("vanilla still runs under bypassPermissions (autonomous)", vanilla.permissionMode === "bypassPermissions");
  check("vanilla still disallows the broken built-in question tool", (vanilla.disallowedTools ?? []).includes("AskUserQuestion"));
  check("vanilla still carries a turn ceiling (safety, not a persona wrapper)", typeof vanilla.maxTurns === "number" && vanilla.maxTurns! > 0);
}

// ---- harness ------------------------------------------------------------------------------------
class StubAccounts {
  onUsageRefresh(_cb: () => void): void {}
  effectiveUtilization(): number | null { return null; }
  soonestResetAt(): number | null { return null; }
  hasHeadroom(): boolean { return true; }
  setPingInterval(_ms: number): void {}
  applyEnabled(_id: string, _enabled: boolean): void {}
  applyWeeklySafetyPct(_id: string, _pct: number): void {}
  setSpreadUsage(_on: boolean): void {}
  setProfileToken(_id: string, _token: string): void {}
  select(): { id: string; label: string; token: string } { return { id: "acct1", label: "acct1", token: "tok" }; }
  auxToken(): string | undefined { return undefined; }
}

const OK: ResultEvent = { type: "result", subtype: "success", isError: false };
const REPO = process.cwd();

interface Harness {
  mgr: InstanceType<typeof ThreadManager>;
  db: InstanceType<typeof Db>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  internals: any;
  roleCalls: string[]; // any structured role runRole was asked to run (should stay empty for vanilla)
  resumeCalls: number; // how many times startResumedImplementor was invoked
  dispose(): void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "vanilla-lane-"));
  const db = new Db(join(dir, "orchestrator.sqlite"));
  const hub = new EventHub();
  const memory = new FileMemoryService(join(dir, "memory"));
  const mgr = new ThreadManager(db, hub, memory, new StubAccounts() as unknown as AccountManager);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = mgr as any;
  if (internals.capSupervisor) clearInterval(internals.capSupervisor);
  if (internals.tokenResumeTimer) clearTimeout(internals.tokenResumeTimer);
  if (internals.capResumeWake) clearTimeout(internals.capResumeWake);

  const roleCalls: string[] = [];
  let resumeCalls = 0;
  internals.runRole = async (_t: unknown, role: string): Promise<ResultEvent | undefined> => {
    // The vanilla lane must never reach a structured role (planner/researcher/qa/reader) — only the
    // implementor's own (stubbed below) spawn path runs.
    roleCalls.push(role);
    return OK;
  };
  internals.stopLive = async (): Promise<void> => {};
  internals.flushDirectorNotes = (): void => {};
  internals.startResumedImplementor = async (): Promise<{ run: unknown; runId: string; accountId: string }> => {
    resumeCalls++;
    return { run: { send() {} }, runId: `run-${resumeCalls}`, accountId: "acct1" };
  };
  internals.drainQueuedImplementor = async (_t: Thread, _e: unknown, _k: string, res: ResultEvent | undefined): Promise<ResultEvent | undefined> => res;

  return {
    mgr,
    db,
    internals,
    roleCalls,
    get resumeCalls() { return resumeCalls; },
    dispose() {
      if (internals.capSupervisor) clearInterval(internals.capSupervisor);
      if (internals.tokenResumeTimer) clearTimeout(internals.tokenResumeTimer);
      if (internals.capResumeWake) clearTimeout(internals.capResumeWake);
      try { db.raw.close(); } catch { /* already closed */ }
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows file lock — harmless */ }
    },
  } as Harness;
}

const TERMINAL = new Set(["done", "review", "failed", "cancelled", "paused"]);
async function pollTerminal(db: InstanceType<typeof Db>, id: string, timeoutMs = 4000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = db.getThread(id);
    if (t && TERMINAL.has(t.state)) return t.state;
    await new Promise((r) => setTimeout(r, 5));
  }
  return db.getThread(id)?.state ?? "gone";
}

// ---- B. a clean first turn parks 'paused' — never 'done', never 'review' ---------------------------
async function testFreshDispatchParksPaused(): Promise<void> {
  console.log("\nB. Default-mode dispatch — a clean turn parks 'paused' (warm), not 'done'/'review'");
  const h = makeHarness();
  try {
    let awaited = 0;
    h.internals.awaitImplementorCompletion = async (): Promise<ResultEvent> => {
      awaited++;
      return OK;
    };
    const id = await h.mgr.dispatch({ title: "vanilla task", workspace: REPO, brief: "just answer 2+2", lane: "vanilla" });
    const state = await pollTerminal(h.db, id);
    check("settles to 'paused', not 'done'", state === "paused", `got ${state}`);
    check("no structured role ever ran (no planner/researcher/qa)", h.roleCalls.length === 0, h.roleCalls.join(","));
    check("the implementor spawn path ran exactly once", h.resumeCalls === 1, String(h.resumeCalls));
    check("the implementor was actually awaited", awaited === 1, String(awaited));
    const thread = h.db.getThread(id)!;
    check("thread.lane stays 'vanilla' (drives the Default badge)", thread.lane === "vanilla", String(thread.lane));
    check(
      "a warm-session finding was posted",
      h.db.listFindings(id).some((f) => /stays warm/i.test(f.summary)),
      JSON.stringify(h.db.listFindings(id).map((f) => f.summary)),
    );
    check(
      "no self-improvement / done finding — the pipeline's own is skipped for vanilla",
      !h.db.listFindings(id).some((f) => /QA review is disabled, accepted as done/i.test(f.summary)),
    );
  } finally {
    h.dispose();
  }
}

// ---- C. Inject/Resume on a paused vanilla task warm-resumes the SAME session, settles paused again --
async function testResumeStaysWarm(): Promise<void> {
  console.log("\nC. Resume on a paused vanilla task — warm-resumes, settles back to 'paused'");
  const h = makeHarness();
  try {
    h.internals.awaitImplementorCompletion = async (): Promise<ResultEvent> => OK;
    const id = await h.mgr.dispatch({ title: "vanilla task 2", workspace: REPO, brief: "start", lane: "vanilla" });
    await pollTerminal(h.db, id);
    check("first turn parked paused", h.db.getThread(id)?.state === "paused", String(h.db.getThread(id)?.state));
    check("one spawn so far", h.resumeCalls === 1, String(h.resumeCalls));

    const result = await h.mgr.resumeThread(id, "keep going");
    check("resume reports implementing", result.ok && result.state === "implementing", JSON.stringify(result));
    const state2 = await pollTerminal(h.db, id);
    check("second turn ALSO parks 'paused' (still warm, not done/review)", state2 === "paused", `got ${state2}`);
    check("a SECOND spawn happened (the SAME session, continued — not a fresh dispatch)", h.resumeCalls === 2, String(h.resumeCalls));
    check("still no structured role ever ran across both turns", h.roleCalls.length === 0, h.roleCalls.join(","));
    check("still exactly one task/thread (no second dispatch)", h.db.listThreads().filter((t) => t.title.startsWith("vanilla task 2")).length === 1);
  } finally {
    h.dispose();
  }
}

// ---- D. Mark done on a paused vanilla task actually settles it done --------------------------------
async function testMarkDone(): Promise<void> {
  console.log("\nD. Mark done — the owner's own way of ending a warm vanilla session");
  const h = makeHarness();
  try {
    h.internals.awaitImplementorCompletion = async (): Promise<ResultEvent> => OK;
    const id = await h.mgr.dispatch({ title: "vanilla task 3", workspace: REPO, brief: "start", lane: "vanilla" });
    await pollTerminal(h.db, id);
    check("parked paused before Mark done", h.db.getThread(id)?.state === "paused");
    const result = await h.mgr.markDone(id);
    check("Mark done succeeds from 'paused'", result.ok && result.state === "done", JSON.stringify(result));
    check("thread is now 'done'", h.db.getThread(id)?.state === "done", String(h.db.getThread(id)?.state));
  } finally {
    h.dispose();
  }
}

// ---- run -------------------------------------------------------------------------------------------
console.log("Default mode (vanilla lane) — no wrapper prompt, no planner/QA/self-improvement/review, stays warm");
await testVanillaConfig();
await testFreshDispatchParksPaused();
await testResumeStaysWarm();
await testMarkDone();

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("Failures:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
