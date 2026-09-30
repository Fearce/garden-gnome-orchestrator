/**
 * Integration gate — the configured max-effort caps bound every implementor run, and only an owner pin
 * reaches past the automatic ceiling.
 *
 * Every implementor launch — a fresh dispatch, a scheduled run, a goal step, a read-lane promotion, a QA
 * fix round, a retry, an auto-resume after a restart — funnels through `startImplementor`, which writes
 * the effort it will actually send onto the `agent_runs` row before the CLI spawns. This gate stops at
 * that boundary (`wireRun`) and reads the row, so it proves what the model would really have received.
 *
 * Run:  npm run test:effort-ceiling   (from server/)   — or:  npx tsx src/tests/effortCeiling.itest.ts
 */

process.env.CAP_RETRY_MS = "0";
process.env.ACCOUNT_PING_MS = "3600000";
process.env.FAST_ACCOUNT_PING_MS = "3600000";

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// startImplementor's Codex branch reaches module-level Codex helpers that read ~/.codex; point them at a
// throwaway home so the gate never depends on this machine's Codex login or usage.
const codexHomes = mkdtempSync(join(tmpdir(), "effort-ceiling-codex-"));
process.env.CODEX_HOME_DIR = join(codexHomes, "home");
process.env.CODEX_SOURCE_HOME = join(codexHomes, "source");
import type { AccountManager } from "../accounts/accountManager.js";
import type { Effort, ImplementorProvider, Thread } from "../types.js";

const { Db } = await import("../db/db.js");
const { EventHub } = await import("../events.js");
const { FileMemoryService } = await import("../memory/memory.js");
const { ThreadManager } = await import("../orchestrator/threadManager.js");
const { automaticEffortOptions, capAutomaticEffort } = await import("../orchestrator/automaticEffort.js");

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    failures.push(label + (detail ? ` — ${detail}` : ""));
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const ACCOUNT = { id: "acct-a", label: "account a", token: "stub" };
const WIRE_SENTINEL = "stop before real CLI spawn";

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
  isModelLimited(_id: string, _model: string): boolean { return false; }
  auxToken(): string | undefined { return undefined; }
  byId(id: string): typeof ACCOUNT | undefined { return id === ACCOUNT.id ? ACCOUNT : undefined; }
  select(): typeof ACCOUNT { return ACCOUNT; }
  dispatchPreview(): Record<string, unknown> {
    return {
      account: ACCOUNT,
      hasHeadroom: true,
      fiveHour: 10,
      sevenDay: 10,
      fiveHourReset: Date.now() + 3_600_000,
      sevenDayReset: Date.now() + 86_400_000,
      weeklySafetyPct: 100,
    };
  }
}

const dir = mkdtempSync(join(tmpdir(), "effort-ceiling-"));
const workspace = join(dir, "workspace");
mkdirSync(workspace, { recursive: true });
const db = new Db(join(dir, "orchestrator.sqlite"));
const mgr = new ThreadManager(db, new EventHub(), new FileMemoryService(join(dir, "memory")), new StubAccounts() as unknown as AccountManager);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const internals = mgr as any;
internals.wireRun = (): never => { throw new Error(WIRE_SENTINEL); };
internals.officeCheckIn = (): void => {};
internals.ensureGroup = (): void => {};

/** Launch one implementor for a fresh task on `provider` and return the effort its run row records. */
function launchedEffort(provider: ImplementorProvider, effort: Effort): string | null | undefined {
  const thread: Thread = db.createThread({ title: `${provider} ${effort}`, workspace, rawPrompt: "Do it.", brief: "Do it." });
  internals.implementorProvider.set(thread.id, provider);
  try {
    internals.startImplementor(thread, "KICKOFF", { effort, account: provider === "claude" ? ACCOUNT : undefined });
  } catch (error) {
    if (!String(error).includes(WIRE_SENTINEL)) throw error;
  }
  return db.listRuns(thread.id).at(-1)?.effort;
}

try {
  console.log("\n1. The automatic ceiling helpers");
  check("max is capped to high", capAutomaticEffort("max") === "high");
  check("xhigh is capped to high", capAutomaticEffort("xhigh") === "high");
  check("medium is untouched", capAutomaticEffort("medium") === "medium");
  check("a model's tiers above high are not offered", automaticEffortOptions(["low", "medium", "high", "xhigh", "max"]).join(",") === "low,medium,high");
  check("a model offering only tiers above high keeps its lowest", automaticEffortOptions(["xhigh", "max"]).join(",") === "xhigh");

  console.log("\n2. A Claude subscription's max-effort cap");
  mgr.setSettings({ accountEffortCaps: { [ACCOUNT.id]: "high" } });
  check("an owner-pinned max runs at the subscription's high cap", launchedEffort("claude", "max") === "high");
  check("an owner-pinned xhigh runs at the high cap", launchedEffort("claude", "xhigh") === "high");
  check("the cap never raises a lower effort", launchedEffort("claude", "medium") === "medium");
  mgr.setSettings({ accountEffortCaps: {} });
  check("with no cap, the owner's explicit max is honored", launchedEffort("claude", "max") === "max");

  console.log("\n3. The Codex, Grok and z.ai effort caps");
  mgr.setSettings({ codexEffort: "high", grokEffort: "high", zaiEffort: "high" });
  check("Codex: an owner-pinned max runs at the high cap", launchedEffort("codex", "max") === "high");
  check("Grok: an owner-pinned max runs at the high cap", launchedEffort("grok", "max") === "high");
  check("z.ai: an owner-pinned max runs at no more than the high cap", ["low", "high"].includes(String(launchedEffort("zai", "max"))));
  check("Codex: a medium task stays medium under the cap", launchedEffort("codex", "medium") === "medium");

  console.log("\n4. A Co-work session's effort is capped like a task's");
  internals.requestedModelCapacitySnapshot = () => ({ options: [], ready: [{ provider: "codex", label: "ready", windows: [], hasHeadroom: true }] });
  const cowork = (provider: ImplementorProvider, model: string): string | undefined => {
    const now = Date.now();
    const prepared = mgr.prepareCoworkerRun({
      session: {
        id: `cw-${provider}`, name: "cowork", autoNamed: false, workspace, state: "idle",
        requestedProvider: provider, requestedModel: model, provider, model, effort: "max", account: null,
        agentSessionId: null, activeTurnId: null, error: null, createdAt: now, updatedAt: now, closedAt: null,
        activeTurnStartedAt: null, lastActivityAt: null, lastSnippet: null, lastSnippetRole: null,
      },
      prompt: "hello",
      history: [],
      images: [],
    });
    return "error" in prepared ? `error: ${prepared.error}` : prepared.target.effort;
  };
  check("Codex Co-work: a max session runs at the high cap", cowork("codex", "gpt-6-sol") === "high", cowork("codex", "gpt-6-sol"));
  check("Grok Co-work: a max session runs at the high cap", cowork("grok", "grok-4.6") === "high", cowork("grok", "grok-4.6"));
  check("z.ai Co-work: a max session runs at no more than the high cap", ["low", "high"].includes(String(cowork("zai", "glm-5.3"))), cowork("zai", "glm-5.3"));
} finally {
  if (internals.capSupervisor) clearInterval(internals.capSupervisor);
  db.raw.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(codexHomes, { recursive: true, force: true });
}

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("Failures:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
process.exit(0);
