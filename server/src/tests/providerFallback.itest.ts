/**
 * Integration test — a quota rejection in a structured pipeline stage must switch providers before
 * returning to its caller. This exercises the real `runRole` loop with fake agent processes: Codex
 * rejects with its usage-cap signal, then Claude returns a QA verdict. No network or credentials are used.
 *
 * Run: npm run test:provider-fallback (from server/)
 */

process.env.CAP_RETRY_MS = "0";
process.env.ACCOUNT_PING_MS = "3600000";
process.env.FAST_ACCOUNT_PING_MS = "3600000";

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountManager } from "../accounts/accountManager.js";
import type { QaOutput } from "../types.js";

const { Db } = await import("../db/db.js");
const { EventHub } = await import("../events.js");
const { FileMemoryService } = await import("../memory/memory.js");
const { ThreadManager } = await import("../orchestrator/threadManager.js");
const { CodexAgentRun } = await import("../agents/codexRunner.js");
const { parseUsageLimitResetAt } = await import("../agents/runner.js");

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    return;
  }
  console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  process.exitCode = 1;
}

class StubAccounts {
  onUsageRefresh(_cb: () => void): void {}
  effectiveUtilization(): number | null { return null; }
  soonestResetAt(): number | null { return null; }
  hasHeadroom(): boolean { return true; }
  dispatchPreview(): Record<string, unknown> {
    return { account: { id: "claude-a", label: "Claude A" }, hasHeadroom: true, fiveHour: 0, sevenDay: 0, fiveHourReset: null, sevenDayReset: null, weeklySafetyPct: 100 };
  }
  auxToken(): string | undefined { return undefined; }
  setPingInterval(_ms: number): void {}
  applyEnabled(_id: string, _enabled: boolean): void {}
  applyWeeklySafetyPct(_id: string, _pct: number): void {}
  setSpreadUsage(_on: boolean): void {}
}

const root = mkdtempSync(join(tmpdir(), "provider-fallback-"));
const workspace = join(root, "workspace");
mkdirSync(workspace, { recursive: true });
const db = new Db(join(root, "orchestrator.sqlite"));
const manager = new ThreadManager(db, new EventHub(), new FileMemoryService(join(root, "memory")), new StubAccounts() as unknown as AccountManager);
const thread = db.createThread({ title: "QA falls back after a Codex cap", workspace, rawPrompt: "verify", brief: "verify" });
const internals = manager as any;
const providers: string[] = [];
const verdict: QaOutput = { pass: true, summary: "Claude completed the review", issues: [] };

const statedReset = parseUsageLimitResetAt("You've hit your usage limit. Try again at Sep 2nd, 2026 2:23 PM.", new Date("2026-08-27T12:00:00").getTime());
check("the provider's stated absolute reset is parsed", statedReset === new Date("2026-09-02T14:23:00").getTime(), String(statedReset));

// The real loop owns routing and persistence; only the process-spawning leaf is replaced. Constructing
// through Object.create preserves the Codex `instanceof` cap branch used in production.
internals.dispatchAccount = () => ({ id: "claude-a", label: "Claude A", token: undefined });
internals.nextReadyImplementor = (from: string) => (from === "codex" ? "claude" : undefined);
internals.wireRun = () => {};
internals.officeCheckIn = () => {};
internals.ensureGroup = () => {};
internals.createRoleAgent = (provider: string) => {
  providers.push(provider);
  const cap = provider === "codex";
  const agent = cap ? Object.create(CodexAgentRun.prototype) : {};
  Object.assign(agent, {
    capped: cap,
    rateLimited: false,
    transientApiError: false,
    transientApiErrorMessage: undefined,
    sessionId: undefined,
    start: () => {},
    result: async () => cap
      ? { type: "result", subtype: "error", isError: true, result: "You've hit your usage limit. Try again at Sep 2nd, 2026 2:23 PM." }
      : { type: "result", subtype: "success", isError: false, structuredOutput: verdict },
    stop: async () => {},
  });
  return agent;
};

try {
  const result = await internals.runRole(
    thread,
    "qa",
    "Review the implementation.",
    () => ({ model: "unused" }),
    undefined,
    { forcedProvider: "codex" },
  );
  check("the quota-capped provider is attempted once", providers[0] === "codex", providers.join(" → "));
  check("QA immediately retries on the next provider", providers.join(" → ") === "codex → claude", providers.join(" → "));
  check("the fallback provider's verdict reaches QA", result?.structuredOutput === verdict);
  check("a reachable fallback does not create an auto-resume park", !internals.capParked.has(thread.id));
  check("the task never enters a needs-your-review state", db.getThread(thread.id)?.state !== "review", db.getThread(thread.id)?.state);
} finally {
  db.raw.close();
  rmSync(root, { recursive: true, force: true });
}
