/**
 * Integration test — a Claude-backed QA/planner/reviewer run records the effort it actually ran at.
 *
 * The bug (2026-10-02): the task chat labels each row "<model> <effort>" from the row's own `agent_runs`
 * entry, and implementor rows showed "Opus 5.5 High" while QA rows showed just "Opus 5.5". `runRole`
 * wrote the run's effort only for the CLI backends and usage saving; a plain Claude run sends its role
 * config's effort (QA's is "high") to the SDK but recorded NULL, so the label had nothing to show.
 * Case D covers the one-time Db backfill that labels the Claude QA/reviewer history the same way.
 *
 * WHAT IS REAL vs. SIMULATED
 *  - REAL: `runRole` — provider routing, usage-saving resolution, run creation and the `run.upsert` it
 *    publishes — against a real Db + EventHub.
 *  - SIMULATED: only the agent spawn (`createRoleAgent`) and the role config `makeCfg` hands back.
 *
 * Run:  npm run test:role-run-effort   (from server/)   — or:  npx tsx src/tests/roleRunEffort.itest.ts
 * Exits non-zero if any assertion fails. Self-contained: creates a throwaway DB + workspace and removes them.
 */

process.env.CAP_RETRY_MS = "0";
process.env.ACCOUNT_PING_MS = "3600000";
process.env.FAST_ACCOUNT_PING_MS = "3600000";

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountManager } from "../accounts/accountManager.js";
import type { AgentRun, Thread } from "../types.js";
import type { ServerEvent } from "../ws/protocol.js";

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
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    failures.push(label + (detail ? ` — ${detail}` : ""));
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** One always-available Claude subscription whose weekly meter the test sets. */
class OneAccount {
  sevenDay = 10;
  onUsageRefresh(_cb: () => void): void {}
  effectiveUtilization(): number | null { return 10; }
  soonestResetAt(): number | null { return Date.now() + 3_600_000; }
  hasHeadroom(): boolean { return true; }
  setPingInterval(_ms: number): void {}
  applyEnabled(_id: string, _enabled: boolean): void {}
  applyWeeklySafetyPct(_id: string, _pct: number): void {}
  setSpreadUsage(_on: boolean): void {}
  setProfileToken(_id: string, _token: string): void {}
  isModelLimited(_id: string, _model: string): boolean { return false; }
  auxToken(): string { return "test-token"; }
  select(): { account: { id: string; label: string; token: string }; reason: string } {
    return { account: { id: "account-a", label: "Claude A", token: "test-token" }, reason: "fixture" };
  }
  dispatchPreview(): Record<string, unknown> {
    return { account: { id: "account-a", label: "Claude A", token: "test-token" }, hasHeadroom: true, fiveHour: 10, sevenDay: this.sevenDay, weeklySafetyPct: 100 };
  }
  dto(): Array<Record<string, unknown>> {
    return [{
      id: "account-a", label: "Claude A", enabled: true, active: false, rateLimited: false,
      fiveHour: 10, sevenDay: this.sevenDay, updatedAt: Date.now(), weeklySafetyPct: 100,
    }];
  }
  byId(): undefined { return undefined; }
}

const fakeAgent = () => ({
  onEvent: (_cb: unknown) => () => {},
  onEnd: (_cb: unknown) => {},
  start: () => {},
  stop: async () => {},
  rateLimited: false,
  result: async () => ({ type: "result", subtype: "success", isError: false, structuredOutput: {} }),
});

/** Drive one real `runRole` on Claude and return the run row plus every run.upsert it published. */
async function runOnce(
  role: "qa" | "planner" | "reviewer",
  configEffort: string,
  setup?: (mgr: InstanceType<typeof ThreadManager>, accounts: OneAccount) => void,
): Promise<{ run: AgentRun | undefined; published: AgentRun[] }> {
  const dir = mkdtempSync(join(tmpdir(), "role-run-effort-"));
  const workspace = join(dir, "workspace");
  mkdirSync(workspace, { recursive: true });
  const db = new Db(join(dir, "orchestrator.sqlite"));
  const hub = new EventHub();
  const published: AgentRun[] = [];
  const publish = hub.publish.bind(hub);
  hub.publish = (event: ServerEvent) => {
    if (event.type === "run.upsert") published.push(event.run);
    publish(event);
  };
  const accounts = new OneAccount();
  const mgr = new ThreadManager(db, hub, new FileMemoryService(join(dir, "memory")), accounts as unknown as AccountManager);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = mgr as any;
  try {
    setup?.(mgr, accounts);
    const thread: Thread = db.createThread({ title: "role run effort", workspace, rawPrompt: "p", brief: "b" });
    internals.createRoleAgent = (_provider: string, _create: unknown) => fakeAgent();
    await internals.runRole(thread, role, "kickoff", () => ({ effort: configEffort }));
    return { run: db.listRuns(thread.id).find((r) => r.role === role), published: published.filter((r) => r.role === role) };
  } finally {
    if (internals.capSupervisor) clearInterval(internals.capSupervisor);
    if (internals.tokenResumeTimer) clearTimeout(internals.tokenResumeTimer);
    db.raw.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("\n=== A. a Claude QA run records the effort its config sent ===");
{
  const { run, published } = await runOnce("qa", "high");
  check("the QA run row carries effort high", run?.effort === "high", String(run?.effort));
  check(
    "every run.upsert the chat receives carries it, so no row is labelled without it",
    published.length > 0 && published.every((r) => r.effort === "high"),
    JSON.stringify(published.map((r) => r.effort)),
  );
}

console.log("\n=== B. the other one-shot roles get the same record ===");
for (const [role, effort] of [["planner", "medium"], ["reviewer", "high"]] as const) {
  const { run } = await runOnce(role, effort);
  check(`a Claude ${role} run records effort ${effort}`, run?.effort === effort, String(run?.effort));
}

console.log("\n=== C. usage saving's effort is what runs, so it is what is recorded ===");
{
  const { run, published } = await runOnce("qa", "high", (mgr, accounts) => {
    accounts.sevenDay = 95;
    mgr.setSettings({ usageSaving: { "account-a": { enabled: true, thresholdPct: 90, model: "claude-opus-5-5", effort: "low" } } });
  });
  check("the saving effort is recorded, not the config's", run?.effort === "low", String(run?.effort));
  check("the published run agrees", published.every((r) => r.effort === "low"), JSON.stringify(published.map((r) => r.effort)));
}

console.log("\n=== D. history: earlier Claude QA/reviewer rows get the effort they ran at, nothing else is touched ===");
{
  const dir = mkdtempSync(join(tmpdir(), "role-run-effort-backfill-"));
  const path = join(dir, "orchestrator.sqlite");
  try {
    const before = new Db(path);
    const t = before.createThread({ title: "history", workspace: dir, rawPrompt: "p", brief: "b" });
    const rows = {
      qa: before.createRun({ threadId: t.id, role: "qa", model: "claude-opus-5-5", account: "personal" }).id,
      reviewer: before.createRun({ threadId: t.id, role: "reviewer", model: "claude-opus-5-5", account: "vota" }).id,
      planner: before.createRun({ threadId: t.id, role: "planner", model: "claude-opus-5-5", account: "personal" }).id,
      codexQa: before.createRun({ threadId: t.id, role: "qa", model: "gpt-5.6-sol", account: "codex:gpt-5.6-sol" }).id,
      zaiQa: before.createRun({ threadId: t.id, role: "qa", model: "glm-5.3", account: "zai:glm-5.3" }).id,
      savingQa: before.createRun({ threadId: t.id, role: "qa", model: "claude-opus-5-5", account: "personal", effort: "low" }).id,
    };
    // A fresh Db already ran the one-time backfill, so forget it to replay an upgrade over this history.
    before.raw.prepare("DELETE FROM kv WHERE key = 'claude_review_run_effort_backfill_v1'").run();
    before.raw.close();

    const after = new Db(path);
    const effort = (id: string) => after.getRun(id)?.effort ?? null;
    check("a Claude QA row reads high", effort(rows.qa) === "high", String(effort(rows.qa)));
    check("a Claude reviewer row reads high", effort(rows.reviewer) === "high", String(effort(rows.reviewer)));
    check("a planner row is left alone (its effort varied per task)", effort(rows.planner) === null, String(effort(rows.planner)));
    check("CLI-backend QA rows are left alone", effort(rows.codexQa) === null && effort(rows.zaiQa) === null);
    check("a recorded usage-saving effort is kept", effort(rows.savingQa) === "low", String(effort(rows.savingQa)));
    after.raw.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n=== ${passed}/${passed + failed} checks passed ===`);
if (failed) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
process.exit(0);
