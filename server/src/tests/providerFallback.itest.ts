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

// Keep live Codex-usage fixtures and their persisted cache out of the real server data directory.
const testDataRoot = mkdtempSync(join(tmpdir(), "provider-fallback-data-"));
process.env.DATA_DIR = testDataRoot;

const { Db } = await import("../db/db.js");
const { EventHub } = await import("../events.js");
const { FileMemoryService } = await import("../memory/memory.js");
const { ThreadManager } = await import("../orchestrator/threadManager.js");
const { CodexAgentRun } = await import("../agents/codexRunner.js");
const { GrokAgentRun } = await import("../agents/grokRunner.js");
const { noteCodexPing } = await import("../agents/codexUsage.js");
const { parseUsageLimitResetAt, usageLimitResetWasExplicitlyElapsed } = await import("../agents/runner.js");

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    return;
  }
  console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  process.exitCode = 1;
}

function usageLimitNoticeAt(date: Date): string {
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][date.getMonth()];
  const day = date.getDate();
  const mod100 = day % 100;
  const suffix = mod100 >= 11 && mod100 <= 13 ? "th" : (["th", "st", "nd", "rd"][day % 10] ?? "th");
  const hour24 = date.getHours();
  const hour = hour24 % 12 || 12;
  const minute = String(date.getMinutes()).padStart(2, "0");
  const meridiem = hour24 >= 12 ? "PM" : "AM";
  return `You've hit your usage limit. Try again at ${month} ${day}${suffix}, ${date.getFullYear()} ${hour}:${minute} ${meridiem}.`;
}

function bootFixtureManager(fixtureDb: any, fixtureRoot: string): any {
  const originalScheduleAutoResume = (ThreadManager.prototype as any).scheduleAutoResume;
  (ThreadManager.prototype as any).scheduleAutoResume = () => {};
  try {
    return new ThreadManager(fixtureDb, new EventHub(), new FileMemoryService(join(fixtureRoot, "memory")), new StubAccounts() as unknown as AccountManager);
  } finally {
    (ThreadManager.prototype as any).scheduleAutoResume = originalScheduleAutoResume;
  }
}

class StubAccounts {
  headroom = true;
  onUsageRefresh(_cb: () => void): void {}
  effectiveUtilization(): number | null { return null; }
  soonestResetAt(): number | null { return null; }
  hasHeadroom(): boolean { return this.headroom; }
  isModelLimited(_accountId: string, _model: string): boolean { return false; }
  dispatchPreview(): Record<string, unknown> {
    return { account: { id: "claude-a", label: "Claude A" }, hasHeadroom: this.headroom, fiveHour: 0, sevenDay: 0, fiveHourReset: null, sevenDayReset: null, weeklySafetyPct: 100 };
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
const accountStub = new StubAccounts();
const manager = new ThreadManager(db, new EventHub(), new FileMemoryService(join(root, "memory")), accountStub as unknown as AccountManager);
const thread = db.createThread({ title: "QA falls back after a Codex cap", workspace, rawPrompt: "verify", brief: "verify" });
const internals = manager as any;
const realGrokImplementorReady = internals.grokImplementorReady;
const providers: string[] = [];
const verdict: QaOutput = { pass: true, summary: "Claude completed the review", issues: [] };

const statedResetDate = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
statedResetDate.setSeconds(0, 0);
const statedResetText = usageLimitNoticeAt(statedResetDate);
const statedReset = parseUsageLimitResetAt(statedResetText);
check("the provider's stated absolute reset is parsed", statedReset === statedResetDate.getTime(), String(statedReset));
check("an expired provider reset is distinguishable from an absent reset", usageLimitResetWasExplicitlyElapsed("You've hit your usage limit. Try again at Jan 1st, 2020 12:00 PM.", Date.now()));

// The real loop owns routing and persistence; only the process-spawning leaf is replaced. Constructing
// through Object.create preserves the Codex `instanceof` cap branch used in production.
let claudeSelections = 0;
internals.dispatchAccount = () => {
  claudeSelections++;
  return { id: "claude-a", label: "Claude A", token: undefined };
};
internals.wireRun = () => {};
internals.officeCheckIn = () => {};
internals.ensureGroup = () => {};
internals.createRoleAgent = () => ({
  capped: false,
  rateLimited: false,
  transientApiError: false,
  transientApiErrorMessage: undefined,
  sessionId: undefined,
  start: () => {},
  result: async () => ({ type: "result", subtype: "success", isError: false, structuredOutput: { summary: "planned" } }),
  stop: async () => {},
});
const directCodex = db.createThread({ title: "Codex role leaves Claude reserve asleep", workspace, rawPrompt: "plan", brief: "plan" });
await internals.runRole(directCodex, "planner", "Plan this.", () => ({ model: "unused" }), undefined, { forcedProvider: "codex" });
check("a non-Claude role does not select or wake a Claude account", claudeSelections === 0, String(claudeSelections));

const originalSettings = internals.settings;
const originalOpenaiApiKey = internals.openaiApiKey;
const originalCodexRoleModel = internals.codexRoleModel;
const originalCodexPoolSnapshot = internals.codexPoolSnapshot;
const originalCodexProviderCandidate = internals.codexProviderCandidate;
const originalDedicatedPoolReadyFor = internals.dedicatedPoolReadyFor;
const originalCodexCapActive = internals.codexCapActive;
internals.settings = () => ({ codexEnabled: true });
internals.openaiApiKey = () => "sk-test";
internals.codexRoleModel = () => "gpt-dedicated";
internals.codexPoolSnapshot = () => [{
  limitId: "dedicated",
  limitName: "GPT-Dedicated",
  modelSlug: "gpt-dedicated",
  fiveHour: 10,
  sevenDay: 10,
  fiveHourReset: Date.now() + 60_000,
  sevenDayReset: Date.now() + 60_000,
}];
internals.codexProviderCandidate = () => ({ hasHeadroom: true });
internals.dedicatedPoolReadyFor = () => false; // explicit model pins deliberately bypass the auto-pick helper
internals.codexCapActive = () => true;
check(
  "an explicitly pinned dedicated model remains usable while the general Codex pool is capped",
  internals.codexImplementorReady("planner") === true,
);
internals.settings = originalSettings;
internals.openaiApiKey = originalOpenaiApiKey;
internals.codexRoleModel = originalCodexRoleModel;
internals.codexPoolSnapshot = originalCodexPoolSnapshot;
internals.codexProviderCandidate = originalCodexProviderCandidate;
internals.dedicatedPoolReadyFor = originalDedicatedPoolReadyFor;
internals.codexCapActive = originalCodexCapActive;

// Initial dispatch and cap recovery already wait when every visible pool is forecast to expire
// mid-task. The failover seam must apply the same reserve or a first provider cap can bypass both
// guards and launch a second known-doomed substantial turn.
const originalClaudeProviderCandidate = internals.claudeProviderCandidate;
const originalCodexImplementorReady = internals.codexImplementorReady;
const originalGrokReadyForRunway = internals.grokImplementorReady;
const originalZaiReadyForRunway = internals.zaiImplementorReady;
const substantialDemand = {
  label: "substantial implementation",
  expectedDurationMs: 150 * 60_000,
  expectedBurnPct: 26,
  reservePct: 4,
  substantial: true,
};
const risky = (provider: string, usedPct: number) => ({
  provider,
  hasHeadroom: true,
  fiveHour: usedPct,
  fiveHourReset: Date.now() + 4 * 60 * 60_000,
  sevenDay: 20,
  sevenDayReset: Date.now() + 5 * 24 * 60 * 60_000,
});
internals.claudeProviderCandidate = () => risky("claude", 90);
internals.codexImplementorReady = () => true;
internals.codexProviderCandidate = () => risky("codex", 80);
internals.grokImplementorReady = () => false;
internals.zaiImplementorReady = () => false;
check(
  "substantial failover waits when every fallback is known at risk",
  internals.nextReadyImplementor("zai", new Set(), "implementor", substantialDemand) === undefined,
);
internals.codexProviderCandidate = () => risky("codex", 67);
check(
  "substantial failover immediately selects a viable Codex pool",
  internals.nextReadyImplementor("zai", new Set(), "implementor", substantialDemand) === "codex",
);
internals.claudeProviderCandidate = originalClaudeProviderCandidate;
internals.codexImplementorReady = originalCodexImplementorReady;
internals.codexProviderCandidate = originalCodexProviderCandidate;
internals.grokImplementorReady = originalGrokReadyForRunway;
internals.zaiImplementorReady = originalZaiReadyForRunway;

internals.dispatchAccount = () => ({ id: "claude-a", label: "Claude A", token: undefined });
internals.nextReadyImplementor = (from: string) => (from === "codex" ? "claude" : undefined);
internals.createRoleAgent = (provider: string) => {
  providers.push(provider);
  const cap = provider === "codex";
  const agent = cap ? Object.create(CodexAgentRun.prototype) : {};
  Object.assign(agent, {
    capped: cap,
    rateLimitInfo: cap ? { status: "rejected", resetsAt: statedReset!, resetSource: "provider" } : undefined,
    rateLimited: false,
    transientApiError: false,
    transientApiErrorMessage: undefined,
    sessionId: undefined,
    start: () => {},
    result: async () => cap
      ? { type: "result", subtype: "error", isError: true, result: statedResetText }
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
  check("the provider-stated reset remains latched", internals.codexCapUntil === statedReset, String(internals.codexCapUntil));
  check("a reachable fallback does not create an auto-resume park", !internals.capParked.has(thread.id));
  check("the task never enters a needs-your-review state", db.getThread(thread.id)?.state !== "review", db.getThread(thread.id)?.state);

  // The runner can see a provider cap before a success-shaped terminal event (plain assistant cap
  // notices are one real shape). A nominal success must not bypass fallback just because isError=false.
  const successCap = db.createThread({ title: "Success-shaped Codex cap still falls back", workspace, rawPrompt: "verify", brief: "verify" });
  providers.length = 0;
  internals.dispatchAccount = () => ({ id: "claude-a", label: "Claude A", token: undefined });
  internals.nextReadyImplementor = (from: string) => (from === "codex" ? "claude" : undefined);
  internals.createRoleAgent = (provider: string) => {
    providers.push(provider);
    const cap = provider === "codex";
    const agent = cap ? Object.create(CodexAgentRun.prototype) : {};
    Object.assign(agent, {
      capped: cap,
      rateLimited: false,
      rateLimitInfo: cap ? { status: "rejected", resetsAt: statedReset!, resetSource: "provider" } : undefined,
      transientApiError: false,
      transientApiErrorMessage: undefined,
      sessionId: undefined,
      start: () => {},
      result: async () => cap
        ? { type: "result", subtype: "success", isError: false, result: "usage limit notice" }
        : { type: "result", subtype: "success", isError: false, structuredOutput: verdict },
      stop: async () => {},
    });
    return agent;
  };
  const successCapResult = await internals.runRole(
    successCap,
    "qa",
    "Review the implementation.",
    () => ({ model: "unused" }),
    undefined,
    { forcedProvider: "codex" },
  );
  check("a success-shaped capped provider still retries the next provider", providers.join(" → ") === "codex → claude", providers.join(" → "));
  check("the success-shaped cap reaches the fallback QA verdict", successCapResult?.structuredOutput === verdict);
  check("the success-shaped cap does not create a human-review park", !internals.capParked.has(successCap.id));

  // A stale provider-stated latch must survive a dashboard-only contradiction, but not a newer
  // successful run on that same backend. The latter is direct evidence that a reset/redemption made
  // Codex usable again; interrupted deploy victims are intentionally not conclusive outcomes.
  check("the latest recorded Codex cap remains authoritative before recovery", !internals.codexRecoveredAfterLastRecordedCap());
  const recoveredCodex = db.createRun({ threadId: successCap.id, role: "qa", model: "gpt-5.6-terra", account: "codex:gpt-5.6-terra" });
  db.updateRun(recoveredCodex.id, { state: "done", capFlagged: false, endedAt: Date.now() + 1_000 });
  const interruptedAfterRecovery = db.createRun({ threadId: successCap.id, role: "qa", model: "gpt-5.6-terra", account: "codex:gpt-5.6-terra" });
  db.updateRun(interruptedAfterRecovery.id, { state: "interrupted", endedAt: Date.now() + 2_000 });
  check("a newer successful Codex run invalidates the older recorded cap", internals.codexRecoveredAfterLastRecordedCap());
  const noResultRun = db.createRun({ threadId: successCap.id, role: "qa", model: "gpt-5.6-terra", account: "codex:gpt-5.6-terra" });
  internals.finishRun(noResultRun.id, undefined, { rateLimited: false });
  check("a no-result structured run is recorded as interrupted", db.getRun(noResultRun.id)?.state === "interrupted", db.getRun(noResultRun.id)?.state);
  check("a no-result structured run is not recovery evidence", internals.codexRecoveredAfterLastRecordedCap());
  // Historical rows predate capFlagged. A textual cap is still conclusive whether the old runner
  // wrote it as an error or a nominally-successful terminal event, and must outweigh the earlier
  // recovery exactly as boot-time cap restoration does.
  const legacyErrorCap = db.createRun({ threadId: successCap.id, role: "qa", model: "gpt-5.6-terra", account: "codex:gpt-5.6-terra" });
  db.updateRun(legacyErrorCap.id, {
    state: "error",
    error: statedResetText,
    endedAt: Date.now() + 3_000,
  });
  check("a newer legacy textual error cap remains authoritative", !internals.codexRecoveredAfterLastRecordedCap());
  const legacySuccessCap = db.createRun({ threadId: successCap.id, role: "qa", model: "gpt-5.6-terra", account: "codex:gpt-5.6-terra" });
  db.updateRun(legacySuccessCap.id, {
    state: "done",
    error: statedResetText,
    endedAt: Date.now() + 4_000,
  });
  check("a newer legacy success-shaped textual cap remains authoritative", !internals.codexRecoveredAfterLastRecordedCap());

  // A synchronous/pre-init Claude 429 has no session id to carry. It must fresh-start on the next
  // subscription, not treat the missing id as proof that every provider is exhausted.
  const earlyCap = db.createThread({ title: "Pre-init Claude cap fresh-starts the next account", workspace, rawPrompt: "verify", brief: "verify" });
  const starts: Array<{ message: string; opts: { resume?: string; account?: { id: string } } }> = [];
  const firstImplementor = {
    rateLimited: true,
    transientApiError: false,
    capped: false,
    sessionId: undefined,
    rateLimitInfo: { status: "rejected", resetsAt: Date.now() + 60_000 },
    result: async () => ({ type: "result", subtype: "error", isError: true, result: "HTTP 429" }),
    nextResult: async () => undefined,
    stop: async () => {},
  };
  const secondImplementor = {
    rateLimited: false,
    transientApiError: false,
    capped: false,
    sessionId: undefined,
    result: async () => ({ type: "result", subtype: "success", isError: false, result: "completed" }),
    nextResult: async () => undefined,
    stop: async () => {},
  };
  internals.failoverAccount = () => ({ id: "claude-b", label: "Claude B", token: undefined });
  internals.acctById = () => null;
  internals.logFailover = () => {};
  internals.startImplementor = (_t: unknown, message: string, opts: { resume?: string; account?: { id: string } }) => {
    starts.push({ message, opts });
    return { run: secondImplementor, accountId: "claude-b" };
  };
  const earlyResult = await internals.awaitImplementorResult(
    earlyCap,
    undefined,
    "FULL KICKOFF",
    firstImplementor,
    "claude-a",
    false,
    "Continue exactly where you left off.",
  );
  check("a pre-init Claude cap launches the next account", starts.length === 1, String(starts.length));
  check("the pre-init fallback starts fresh instead of resuming a missing session", starts[0]?.opts.resume === undefined, JSON.stringify(starts[0]?.opts));
  check("the pre-init fallback keeps the full kickoff context", starts[0]?.message.includes("FULL KICKOFF") === true, starts[0]?.message);
  check("the pre-init fallback completes instead of cap-parking", earlyResult?.isError === false && !internals.capParked.has(earlyCap.id));

  // Exact fe529d83 first-chance ordering: restart recovery was retrying QA directly, so the outer
  // implementor provider gate had deliberately not run. An owner correction superseded that QA pass and
  // returned to implementation with no in-memory provider map. Re-evaluate the real xhigh reserve at this
  // boundary: Codex has 33% left and resets in 28m, so it can bridge the turn and Claude must not launch.
  const directQaHandoff = db.createThread({
    title: "fe529d83 restart-interrupted QA handoff routes before launch",
    workspace,
    rawPrompt: "continue after QA correction",
    brief: "continue after QA correction",
  });
  db.updateThread(directQaHandoff.id, { state: "qa" });
  db.updateThreadStageOutputs(directQaHandoff.id, {
    qaRoundsUsed: 1,
    qaInterruptedRetryRound: 1,
    qaSuperseded: { at: Date.now(), messages: ["normal messages and Discord must expose real conversation context"] },
  });
  const realHandoffSettings = internals.settings;
  const realHandoffOpenaiKey = internals.openaiApiKey;
  const realHandoffClaudeCandidate = internals.claudeProviderCandidate;
  const realHandoffCodexCandidate = internals.codexProviderCandidate;
  const realHandoffCodexCapActive = internals.codexCapActive;
  const realHandoffRouteForPick = internals.routeForPick;
  const realStartResumedImplementor = internals.startResumedImplementor;
  const realAwaitImplementorCompletion = internals.awaitImplementorCompletion;
  const realDrainQueuedImplementor = internals.drainQueuedImplementor;
  const handoffNow = Date.now();
  internals.settings = () => ({
    ...realHandoffSettings.call(internals),
    codexEnabled: true,
    grokEnabled: false,
    zaiEnabled: false,
    spreadUsage: false,
  });
  internals.openaiApiKey = () => "sk-test";
  internals.codexCapActive = () => false;
  internals.claudeProviderCandidate = () => ({
    provider: "claude",
    hasHeadroom: false,
    fiveHour: 100,
    fiveHourReset: handoffNow + 28 * 60_000,
    sevenDay: 89,
    sevenDayReset: handoffNow + 4 * 24 * 60 * 60_000,
    weeklySafetyPct: 100,
    capacityLabel: "Claude personal",
    capacityWindows: [{ label: "live usage cap", usedPct: 100, resetAt: handoffNow + 28 * 60_000 }],
  });
  internals.codexProviderCandidate = () => ({
    provider: "codex",
    hasHeadroom: true,
    fiveHour: 67,
    fiveHourReset: handoffNow + 28 * 60_000,
    sevenDay: 33,
    sevenDayReset: handoffNow + 6 * 24 * 60 * 60_000,
    weeklySafetyPct: 100,
    capacityLabel: "Codex general pool",
  });
  internals.routeForPick = (_threadId: string, provider: string) => provider;
  let handoffStartedProvider: string | undefined;
  internals.startResumedImplementor = async () => {
    handoffStartedProvider = internals.implementorProvider.get(directQaHandoff.id);
    return { run: { send: () => {}, stop: async () => {} }, accountId: "openai-codex" };
  };
  internals.awaitImplementorCompletion = async () => ({ type: "result", subtype: "success", isError: false, result: "fixed" });
  internals.drainQueuedImplementor = async (_t: unknown, _e: unknown, _k: unknown, result: unknown) => result;
  internals.implementorProvider.delete(directQaHandoff.id);
  const directHandoffResult = await internals.resumeImplementorAfterQaSupersede(
    directQaHandoff,
    "xhigh",
    "FULL KICKOFF",
    1,
  );
  check("the QA-supersede handoff routes before launching an implementor", directHandoffResult.handled === true);
  check("33% Codex capacity with a near reset is selected immediately", handoffStartedProvider === "codex", String(handoffStartedProvider));
  check(
    "the first-chance handoff records the capacity-aware Codex choice",
    db.listFindings(directQaHandoff.id).some((finding) => finding.summary.includes("Usage-aware routing chose Codex")),
    JSON.stringify(db.listFindings(directQaHandoff.id).map((finding) => finding.summary)),
  );
  check("the first-chance handoff never creates a capacity park", !internals.capParked.has(directQaHandoff.id));
  check("the owner correction is consumed only after Codex starts", !db.getThreadStageOutputs(directQaHandoff.id).qaSuperseded);
  internals.settings = realHandoffSettings;
  internals.openaiApiKey = realHandoffOpenaiKey;
  internals.claudeProviderCandidate = realHandoffClaudeCandidate;
  internals.codexProviderCandidate = realHandoffCodexCandidate;
  internals.codexCapActive = realHandoffCodexCapActive;
  internals.routeForPick = realHandoffRouteForPick;
  internals.startResumedImplementor = realStartResumedImplementor;
  internals.awaitImplementorCompletion = realAwaitImplementorCompletion;
  internals.drainQueuedImplementor = realDrainQueuedImplementor;
  internals.implementorProvider.delete(directQaHandoff.id);

  // Defense in depth for the same incident: if a Claude process nevertheless starts and caps, derive
  // its provider from the concrete run rather than an optional map entry and hand off without parking.
  const directQaRace = db.createThread({
    title: "fe529d83 direct-QA return immediately uses viable Codex",
    workspace,
    rawPrompt: "continue",
    brief: "continue",
  });
  let cappedClaudeStops = 0;
  let immediateCodexStarts = 0;
  const cappedClaude = {
    rateLimited: true,
    transientApiError: false,
    capped: false,
    sessionId: undefined,
    rateLimitInfo: { status: "rejected", resetsAt: Date.now() + 28 * 60_000 },
    result: async () => ({ type: "result", subtype: "error", isError: true, result: "usage limit reached" }),
    nextResult: async () => undefined,
    stop: async () => { cappedClaudeStops++; },
  };
  const recoveredCodexAgent = Object.assign(Object.create(CodexAgentRun.prototype), {
    rateLimited: false,
    transientApiError: false,
    capped: false,
    sessionId: undefined,
    result: async () => ({ type: "result", subtype: "success", isError: false, result: "recovered immediately" }),
    nextResult: async () => undefined,
    stop: async () => {},
  });
  internals.failoverAccount = () => null;
  internals.acctById = () => null;
  internals.nextReadyImplementor = (from: string) => from === "claude" ? "codex" : undefined;
  internals.composeResumeKickoff = async () => "FRESH CODEX TAKEOVER";
  internals.startImplementor = () => {
    immediateCodexStarts++;
    internals.implementorProvider.set(directQaRace.id, "codex");
    const run = db.createRun({ threadId: directQaRace.id, role: "implementor", model: "gpt-5.6-terra", account: "codex:gpt-5.6-terra" });
    internals.live.set(directQaRace.id, { run: recoveredCodexAgent, runId: run.id, accountId: "openai-codex" });
    db.addMessage({ threadId: directQaRace.id, runId: run.id, role: "implementor", kind: "text", content: "Recovered on Codex without waiting for a supervisor sweep." });
    return { run: recoveredCodexAgent, runId: run.id, accountId: "openai-codex" };
  };
  internals.implementorProvider.delete(directQaRace.id); // reproduce the skipped-gate state
  const directQaResult = await internals.awaitImplementorCompletion(
    directQaRace,
    "high",
    "FULL KICKOFF",
    cappedClaude,
    "claude-a",
    false,
    "Continue exactly where you left off.",
    true,
  );
  check("the direct-QA race hands capped Claude to Codex immediately", immediateCodexStarts === 1, String(immediateCodexStarts));
  check("the capped Claude process stops before Codex takes over", cappedClaudeStops === 1, String(cappedClaudeStops));
  check("the immediate Codex takeover completes the original chain", directQaResult?.isError === false, JSON.stringify(directQaResult));
  check("the direct-QA race never remains capacity-parked", !internals.capParked.has(directQaRace.id));

  // The old message ignored a ready pool, discarded its current viability timestamp, then advertised a
  // different provider's 28-minute reset as though every compatible pool were capped.
  const realRoleCapacityOptions = internals.roleCapacityOptions;
  const messageNow = Date.now();
  let capacitySnapshotReads = 0;
  internals.roleCapacityOptions = () => {
    capacitySnapshotReads++;
    return [
      {
        provider: "claude",
        label: "Claude A",
        hasHeadroom: false,
        windows: [{ label: "5h", usedPct: 100, resetAt: messageNow + 28 * 60_000 }],
      },
      {
        provider: "codex",
        label: "Codex general pool",
        hasHeadroom: true,
        windows: [
          { label: "5h", usedPct: 67, resetAt: messageNow + 28 * 60_000 },
          { label: "weekly", usedPct: 20, resetAt: messageNow + 5 * 24 * 60 * 60_000, burnWeight: 0.35 },
        ],
      },
    ];
  };
  const readyMessage = internals.capParkMessage(directQaRace.id, "implementor");
  check("a park message briefly reports the viable Codex pool", readyMessage.includes("Codex general pool is ready; it will restart when a pipeline slot opens"), readyMessage);
  check("a ready pool suppresses the misleading all-capacity-capped claim", !readyMessage.includes("all compatible capacity is currently capped"), readyMessage);
  check("a ready pool suppresses an irrelevant future reset estimate", !readyMessage.includes("Next viable capacity is expected"), readyMessage);
  check("park wording and reset timing use one immutable capacity snapshot", capacitySnapshotReads === 1, String(capacitySnapshotReads));
  internals.roleCapacityOptions = realRoleCapacityOptions;

  // A capacity park created during final unwind used to wait for CAP_RETRY_MS even after its slot became
  // free. Queue fairness stays synchronous; the capacity sweep is DEFERRED a short beat so the settling
  // pipeline finishes unwinding first and a burst of settles collapses into one board read. What this
  // pins is the invariant, not the beat: queued work claims the slot first, and the capacity recheck
  // still lands promptly rather than waiting out CAP_RETRY_MS.
  const realPumpQueue = internals.pumpQueue;
  const realResumeCapParked = internals.resumeCapParked;
  const recoveryOrder: string[] = [];
  internals.pumpQueue = () => recoveryOrder.push("queue");
  internals.resumeCapParked = () => recoveryOrder.push("capacity");
  internals.recoverReleasedCapacity();
  check("queued work claims a released slot before any capacity sweep", recoveryOrder.join(" -> ") === "queue", recoveryOrder.join(" -> "));
  // Coalescing latch: extra releases in the same beat must not queue a second board read.
  internals.recoverReleasedCapacity();
  const sweepDeadline = Date.now() + 5_000;
  while (!recoveryOrder.includes("capacity") && Date.now() < sweepDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  check(
    "slot release still rechecks capacity parks without waiting out CAP_RETRY_MS",
    recoveryOrder.join(" -> ") === "queue -> queue -> capacity",
    recoveryOrder.join(" -> "),
  );
  internals.pumpQueue = realPumpQueue;
  internals.resumeCapParked = realResumeCapParked;

  // Exact 9c53928a-cf11-4c44-ae27-7f2427038e07 reviewer path: the resumed Codex process emits
  // nothing. The structured-role loop drops only that session and retries Codex fresh; it neither
  // quarantines Codex nor redirects unrelated tasks away from a healthy provider.
  const reviewerSessionWedge = db.createThread({
    title: "9c53928a reviewer resume wedge retries Codex fresh",
    workspace,
    rawPrompt: "review",
    brief: "review",
  });
  const reviewerProviders: string[] = [];
  const reviewerConfigs: Array<{ resume?: string; freshFallback?: unknown }> = [];
  const reviewerStarts: unknown[] = [];
  const reviewerAgents = [
    {
      capped: false,
      rateLimited: false,
      transientApiError: true,
      transientApiErrorMessage: "Codex exec resume produced zero events.",
      startupWedged: true,
      startupWedgeScope: "session",
      sessionId: "wedged-reviewer-session",
      start: (message: unknown) => { reviewerStarts.push(message); },
      result: async () => ({ type: "result", subtype: "error", isError: true, result: "startup watchdog" }),
      nextResult: async () => undefined,
      stop: async () => {},
    },
    {
      capped: false,
      rateLimited: false,
      transientApiError: false,
      transientApiErrorMessage: undefined,
      startupWedged: false,
      sessionId: "fresh-reviewer-session",
      start: (message: unknown) => { reviewerStarts.push(message); },
      result: async () => ({ type: "result", subtype: "success", isError: false, structuredOutput: { accept: true, summary: "reviewed", issues: [] } }),
      nextResult: async () => undefined,
      stop: async () => {},
    },
  ];
  const realWaitForTransientRetry = internals.waitForTransientRetry;
  const realCreateRoleAgentForReviewer = internals.createRoleAgent;
  internals.waitForTransientRetry = async () => {};
  internals.createRoleAgent = (provider: string, create: () => unknown) => {
    reviewerProviders.push(provider);
    const concrete = create() as { cfg?: { resume?: string; freshFallback?: unknown } };
    reviewerConfigs.push(concrete.cfg ?? {});
    return reviewerAgents.shift();
  };
  db.kvSet("provider_startup_cooldown_codex_until", "0");
  const reviewerResult = await internals.runRole(
    reviewerSessionWedge,
    "reviewer",
    "FULL REVIEWER KICKOFF",
    () => ({ model: "unused" }),
    "wedged-reviewer-session",
    { forcedProvider: "codex" },
  );
  check("a session-wedged Codex reviewer retries fresh on Codex", reviewerProviders.join(" -> ") === "codex -> codex" && reviewerResult?.isError === false, reviewerProviders.join(" -> "));
  check("the resumed reviewer carries a full fresh-start self-heal kickoff", reviewerConfigs[0]?.resume === "wedged-reviewer-session" && JSON.stringify(reviewerConfigs[0]?.freshFallback).includes("FULL REVIEWER KICKOFF"), JSON.stringify(reviewerConfigs[0]));
  check("the fresh reviewer attempt receives the complete role kickoff", JSON.stringify(reviewerStarts[1]).includes("FULL REVIEWER KICKOFF"), JSON.stringify(reviewerStarts));
  check("the reviewer session wedge never persists a Codex cooldown", !internals.providerStartupCoolingDown("codex"));
  internals.waitForTransientRetry = realWaitForTransientRetry;
  internals.createRoleAgent = realCreateRoleAgentForReviewer;

  // The fleet-freeze incident came from a zero-event Codex REVIEWER resume. That failure belongs to one
  // saved session: it may fail over/fresh-start this task, but it must not persist a provider cooldown
  // that rejects every unrelated Codex dispatch after a server restart.
  const sessionWedgeThread = db.createThread({ title: "Resumed Codex wedge stays session-scoped", workspace, rawPrompt: "review", brief: "review" });
  let sessionWedgeFallbacks = 0;
  const wedgedCodexResume = Object.assign(Object.create(CodexAgentRun.prototype), {
    capped: false,
    rateLimited: false,
    transientApiError: true,
    transientApiErrorMessage: "Codex exec resume produced no events before the startup watchdog.",
    startupWedged: true,
    startupWedgeScope: "session",
    sessionId: "poisoned-codex-session",
    result: async () => ({ type: "result", subtype: "error", isError: true, result: "startup watchdog" }),
    nextResult: async () => undefined,
    stop: async () => {},
  });
  const healthyClaudeAfterSessionWedge = {
    capped: false,
    rateLimited: false,
    transientApiError: false,
    startupWedged: false,
    sessionId: undefined,
    result: async () => ({ type: "result", subtype: "success", isError: false, result: "continued fresh" }),
    nextResult: async () => undefined,
    stop: async () => {},
  };
  db.kvSet("provider_startup_cooldown_codex_until", "0");
  internals.nextReadyImplementor = (from: string) => from === "codex" ? "claude" : undefined;
  internals.composeResumeKickoff = async () => "FRESH SESSION-WEDGE TAKEOVER";
  internals.startImplementor = () => {
    sessionWedgeFallbacks++;
    internals.implementorProvider.set(sessionWedgeThread.id, "claude");
    const run = db.createRun({ threadId: sessionWedgeThread.id, role: "implementor", model: "claude-test", account: "Claude A" });
    internals.live.set(sessionWedgeThread.id, { run: healthyClaudeAfterSessionWedge, runId: run.id, accountId: "claude-a" });
    db.addMessage({ threadId: sessionWedgeThread.id, runId: run.id, role: "implementor", kind: "text", content: "Continued after only the saved Codex session wedged." });
    return { run: healthyClaudeAfterSessionWedge, runId: run.id, accountId: "claude-a" };
  };
  internals.implementorProvider.set(sessionWedgeThread.id, "codex");
  const sessionWedgeResult = await internals.awaitImplementorCompletion(
    sessionWedgeThread,
    "high",
    "FULL KICKOFF",
    wedgedCodexResume,
    "openai-codex",
    false,
    "Continue exactly where you left off.",
    true,
  );
  check("a resumed Codex session wedge still recovers the affected task", sessionWedgeFallbacks === 1 && sessionWedgeResult?.isError === false, JSON.stringify(sessionWedgeResult));
  check("a resumed Codex session wedge does not set a provider cooldown", !internals.providerStartupCoolingDown("codex"), db.kvGet("provider_startup_cooldown_codex_until") ?? "missing");
  const realCodexReadyAfterSessionWedge = internals.codexImplementorReady;
  internals.codexImplementorReady = () => true;
  check("a resumed Codex session wedge leaves unrelated new Codex work eligible", internals.providerReady("codex") === true);
  internals.codexImplementorReady = realCodexReadyAfterSessionWedge;

  // Booting from the same durable semantics must still revive cap parks with their saved session intact:
  // a session-scoped wedge wrote no fleet-wide cooldown for the next process to inherit.
  const bootRoot = mkdtempSync(join(tmpdir(), "provider-fallback-session-wedge-boot-"));
  const bootWorkspace = join(bootRoot, "workspace");
  mkdirSync(bootWorkspace, { recursive: true });
  const bootDb = new Db(join(bootRoot, "orchestrator.sqlite"));
  const bootPark = bootDb.createThread({ title: "Boot revives saved Codex cap park", workspace: bootWorkspace, rawPrompt: "continue", brief: "continue" });
  const savedRun = bootDb.createRun({ threadId: bootPark.id, role: "implementor", model: "gpt-5.6-terra", account: "codex:gpt-5.6-terra" });
  bootDb.updateRun(savedRun.id, { state: "interrupted", sessionId: "saved-codex-after-boot", error: "interrupted by a server restart", endedAt: Date.now() });
  bootDb.updateThread(bootPark.id, { state: "review", error: "⏳ Auto-resume pending — provider recovery (implementor stage)." });
  const bootManager = bootFixtureManager(bootDb, bootRoot);
  const bootInternals = bootManager as any;
  let bootResumed: string | undefined;
  bootInternals.roleCapacityOptions = () => [{
    provider: "codex",
    label: "Codex general pool",
    hasHeadroom: true,
    windows: [{ label: "5h", usedPct: 20, resetAt: Date.now() + 60_000 }],
  }];
  bootInternals.resumeThread = async (id: string) => {
    bootResumed = id;
    return { ok: true, state: "implementing" };
  };
  bootInternals.resumeCapParked();
  await Promise.resolve();
  check("boot recovery resumes a parked task after only its prior session wedged", bootResumed === bootPark.id, bootResumed);
  check("boot recovery preserves the parked task's saved Codex session", bootInternals.latestImplementorSession(bootPark.id) === "saved-codex-after-boot", bootInternals.latestImplementorSession(bootPark.id));
  check("boot recovery inherits no session-wedge provider cooldown", !bootInternals.providerStartupCoolingDown("codex"));
  bootDb.raw.close();
  // Both callers of the capacity sweep are unref'd timers nothing can cancel: the supervisor interval and
  // the 250ms post-slot-release beat. Either can land after shutdown closed the database, and a throw out
  // of a timer callback is an uncatchable process crash, not a skipped sweep — this suite died exactly
  // that way. Prove the sweep no-ops on a closed DB rather than reading from it.
  let sweptAfterClose = "threw";
  try {
    bootInternals.resumeCapParked();
    sweptAfterClose = "returned";
  } catch (e) {
    sweptAfterClose = String(e);
  }
  check("a capacity sweep landing after shutdown no-ops instead of crashing the process", sweptAfterClose === "returned", sweptAfterClose);
  rmSync(bootRoot, { recursive: true, force: true });

  // A CLI that emits zero startup events is not retried on that same backend: one watchdog interval is
  // enough evidence. The single completion chain quarantines it and launches exactly one healthy fallback.
  const startupWedge = db.createThread({ title: "Grok startup wedge fails over once", workspace, rawPrompt: "fix it", brief: "fix it" });
  let startupFallbacks = 0;
  let wedgeStops = 0;
  const wedgedGrok = Object.assign(Object.create(GrokAgentRun.prototype), {
    capped: false,
    rateLimited: false,
    transientApiError: true,
    transientApiErrorMessage: "Grok produced no events within 60s of starting — killed by the startup watchdog.",
    startupWedged: true,
    startupWedgeScope: "provider",
    sessionId: undefined,
    result: async () => ({ type: "result", subtype: "error", isError: true, result: "startup watchdog" }),
    nextResult: async () => undefined,
    stop: async () => { wedgeStops++; },
  });
  const healthyCodex = Object.assign(Object.create(CodexAgentRun.prototype), {
    capped: false,
    rateLimited: false,
    transientApiError: false,
    transientApiErrorMessage: undefined,
    startupWedged: false,
    sessionId: undefined,
    result: async () => ({ type: "result", subtype: "success", isError: false, result: "recovered" }),
    nextResult: async () => undefined,
    stop: async () => {},
  });
  internals.nextReadyImplementor = (from: string) => from === "grok" ? "codex" : undefined;
  internals.composeResumeKickoff = async () => "FRESH FALLBACK KICKOFF";
  internals.startImplementor = () => {
    startupFallbacks++;
    internals.implementorProvider.set(startupWedge.id, "codex");
    const healthyRun = db.createRun({ threadId: startupWedge.id, role: "implementor", model: "gpt-5.6-sol", account: "codex:gpt-5.6-sol" });
    internals.live.set(startupWedge.id, { run: healthyCodex, runId: healthyRun.id, accountId: "openai-codex" });
    db.addMessage({ threadId: startupWedge.id, runId: healthyRun.id, role: "implementor", kind: "text", content: "Recovered and completed the task." });
    return { run: healthyCodex, runId: healthyRun.id, accountId: "openai-codex" };
  };
  const startupResult = await internals.awaitImplementorCompletion(
    startupWedge,
    "high",
    "FULL KICKOFF",
    wedgedGrok,
    "xai-grok",
    false,
    "Continue where you left off.",
    false,
  );
  check("a startup wedge launches exactly one fallback (no retry burst)", startupFallbacks === 1, String(startupFallbacks));
  check("the wedged process is stopped before takeover", wedgeStops >= 1, String(wedgeStops));
  check("the healthy fallback result completes the same chain", startupResult?.isError === false, JSON.stringify(startupResult));
  check("the failed provider is durably cooling down", internals.providerStartupCoolingDown("grok") === true);
  check("a reachable startup-wedge fallback never creates a review park", !internals.capParked.has(startupWedge.id));

  // A genuine fresh-start cooldown is availability, not quota. Put it in the same window inventory so
  // readiness, capacity prose, and the supervisor's exact wake time cannot disagree.
  const realCooldownPoolSnapshot = internals.codexPoolSnapshot;
  const realCooldownRoleOptions = internals.roleCapacityOptions;
  const cooldownNow = Date.now();
  const exactCooldownReset = cooldownNow + 5 * 60_000;
  db.kvSet("provider_startup_cooldown_codex_until", String(exactCooldownReset));
  internals.codexPoolSnapshot = () => [{
    limitId: "cooldown-test",
    limitName: "Cooldown test pool",
    modelSlug: "gpt-cooldown-test",
    fiveHour: 20,
    sevenDay: 20,
    fiveHourReset: cooldownNow + 2 * 60 * 60_000,
    sevenDayReset: cooldownNow + 5 * 24 * 60 * 60_000,
  }];
  const cooldownDemand = internals.capacityDemand(startupWedge, "implementor", "high");
  const cooldownCandidate = internals.codexProviderCandidate("implementor", cooldownDemand, "gpt-cooldown-test");
  const cooldownWindows = cooldownCandidate.capacityWindows ?? [];
  const cooldownWindow = cooldownWindows.find((window: { label: string }) => window.label === "startup health cooldown");
  check("a real provider cooldown is an explicit capacity window", cooldownWindow?.usedPct === 100 && cooldownWindow.resetAt === exactCooldownReset, JSON.stringify(cooldownCandidate.capacityWindows));
  check("the cooldown window and readiness share the same blocker", cooldownCandidate.hasHeadroom === false, JSON.stringify(cooldownCandidate));
  internals.roleCapacityOptions = () => [{
    provider: "codex",
    label: "Codex Cooldown test pool",
    windows: cooldownWindows,
    hasHeadroom: cooldownCandidate.hasHeadroom,
  }];
  const exactNext = internals.nextRoleCapacityAt("implementor", cooldownDemand, cooldownNow);
  check("startup cooldown is the exact next viable time", exactNext === exactCooldownReset, `expected=${exactCooldownReset} actual=${exactNext}`);
  const cooldownMessage = internals.capParkMessage(startupWedge.id, "implementor");
  check("capacity text names startup health instead of claiming usage exhaustion", cooldownMessage.includes("startup health cooldown") && !cooldownMessage.includes("all compatible capacity is currently capped"), cooldownMessage);
  check("capacity text gives a compact cooldown wait", cooldownMessage.includes("Next compatible capacity: in 5m"), cooldownMessage);
  internals.roleCapacityOptions = realCooldownRoleOptions;
  internals.codexPoolSnapshot = realCooldownPoolSnapshot;
  db.kvSet("provider_startup_cooldown_codex_until", "0");

  // A reader may use Codex as a read-only schema fallback, but never Grok (which has no safe owner-answer
  // channel). When Claude and z.ai are exhausted, the supervisor must therefore wake a reader on Codex
  // rather than leaving it in a deterministic cap/repark loop.
  const readerPark = db.createThread({ title: "Reader cap park can use Codex", workspace, rawPrompt: "read", brief: "read" });
  db.updateThread(readerPark.id, { state: "review", error: "⏳ Auto-resume pending — every backend was rate-limited during the reader stage (reader stage)." });
  accountStub.headroom = false;
  internals.zaiImplementorReady = () => false;
  internals.codexImplementorReady = () => true;
  let readerResumed: string | undefined;
  internals.resumeThread = async (id: string) => {
    readerResumed = id;
    return { ok: true, state: "planning" };
  };
  internals.resumeCapParked();
  await Promise.resolve();
  check("a reader cap park resumes when only Codex has headroom", readerResumed === readerPark.id, readerResumed);
  check("the reader handoff keeps the durable cap marker", (db.getThread(readerPark.id)?.error ?? "").startsWith("⏳ Auto-resume pending"));
  accountStub.headroom = true;

  // A persisted cap must prevent even the first post-restart Claude launch. With no usable backend,
  // runRole records the durable cap park immediately and waits for the supervisor instead of spending
  // another rejected turn on the already-saturated subscription.
  const noProvider = db.createThread({ title: "All capped providers do not get retried", workspace, rawPrompt: "verify", brief: "verify" });
  accountStub.headroom = false;
  internals.codexImplementorReady = () => false;
  internals.grokImplementorReady = () => false;
  internals.zaiImplementorReady = () => false;
  internals.nextReadyImplementor = () => undefined;
  let doomedStarts = 0;
  internals.createRoleAgent = () => {
    doomedStarts++;
    throw new Error("a known-capped provider must not launch");
  };
  const noProviderResult = await internals.runRole(noProvider, "qa", "Review the implementation.", () => ({ model: "unused" }));
  check("all-capped routing does not retry the saturated provider", doomedStarts === 0, String(doomedStarts));
  check("all-capped routing marks the QA stage for durable auto-resume", noProviderResult === undefined && internals.capParked.get(noProvider.id) === "qa", String(internals.capParked.get(noProvider.id)));
  internals.capParked.delete(noProvider.id);

  // The implementor has its own initial routing gate rather than runRole. When every configured
  // backend is already known capped, that gate must park immediately too: selecting Claude's
  // deliberate "least bad" no-freeze candidate would otherwise burn one rejected provider turn on
  // every supervisor wake before awaitImplementorResult can mark the durable park.
  const noImplementorProvider = db.createThread({ title: "All capped implementor providers do not get retried", workspace, rawPrompt: "implement", brief: "implement" });
  let implementorStarts = 0;
  internals.startResumedImplementor = async () => {
    implementorStarts++;
    throw new Error("a known-capped implementor provider must not launch");
  };
  await internals.runImplementorQa(noImplementorProvider, "IMPLEMENTOR KICKOFF", undefined, undefined, undefined, { qaEnabled: true, maxQaRounds: 1 });
  check("all-capped implementor routing does not launch a saturated provider", implementorStarts === 0, String(implementorStarts));
  check("all-capped implementor routing creates a durable auto-resume park", (db.getThread(noImplementorProvider.id)?.error ?? "").startsWith("⏳ Auto-resume pending"), db.getThread(noImplementorProvider.id)?.error ?? undefined);
  check("all-capped implementor routing parks in review instead of failing the task", db.getThread(noImplementorProvider.id)?.state === "review", db.getThread(noImplementorProvider.id)?.state ?? undefined);
  accountStub.headroom = true;

  // The durable CAP marker is what lets the supervisor recover after a process restart. Exercise the
  // real scan/state handoff (only the resume leaf is stubbed): a marked QA task is never left as a
  // normal "needs your review" row once any provider has headroom.
  const parked = db.createThread({ title: "Cap park auto-resumes", workspace, rawPrompt: "verify", brief: "verify" });
  db.updateThread(parked.id, { state: "review", error: "⏳ Auto-resume pending — every backend was rate-limited during QA (QA stage)." });
  let resumedId: string | undefined;
  internals.resumeThread = async (id: string) => {
    resumedId = id;
    return { ok: true, state: "planning" };
  };
  internals.resumeCapParked();
  await Promise.resolve();
  check("the cap supervisor invokes the normal resume path when a provider frees up", resumedId === parked.id, resumedId);
  check("the cap supervisor changes the durable park into the resume-aware failed entry", db.getThread(parked.id)?.state === "failed", db.getThread(parked.id)?.state);

  // Every readiness path must use Grok's hard 98% routing ceiling, not merely its 100% cap latch.
  // Otherwise an all-capped pipeline is parked, the supervisor sees Grok as ready at 98%, and it
  // immediately re-enters the same doomed pipeline on every tick.
  internals.grokImplementorReady = realGrokImplementorReady;
  const originalXaiApiKey = process.env.XAI_API_KEY;
  const originalGrokCandidate = internals.grokProviderCandidate;
  const originalGrokModelAvailable = internals.grokModelAvailable;
  const originalCatalogGrokModels = internals.modelCatalog.grokModels;
  try {
    process.env.XAI_API_KEY = "test-grok-routing-key";
    db.kvSet("setting_grok_enabled", "1");
    internals.grokProviderCandidate = () => ({ provider: "grok", hasHeadroom: false });
    check("a Grok provider at its hard safety ceiling is not ready for cap recovery", !internals.grokImplementorReady());
    check("the director excludes Grok at its hard safety ceiling", !internals.directorTargets().some((target: { provider: string }) => target.provider === "grok"));
    check(
      "a sticky Grok director target becomes unready at its hard safety ceiling",
      !internals.directorTargetReady({ key: "grok|xai-grok|test", provider: "grok", accountId: "xai-grok", accountLabel: "Grok", model: "test" }),
    );

    // A director target is model-specific. Its readiness must use the shared provider-cap test while
    // validating the target model, not the separately selected implementor model.
    internals.grokProviderCandidate = () => ({ provider: "grok", hasHeadroom: true });
    internals.grokModelAvailable = () => false;
    internals.modelCatalog.grokModels = () => ["director-model"];
    check("a stale Grok implementor model does not hide available director models", internals.directorTargets(true).some((target: { provider: string; model: string }) => target.provider === "grok" && target.model === "director-model"));
    check(
      "a sticky available Grok director target ignores an unrelated stale implementor model",
      internals.directorTargetReady({ key: "grok|xai-grok|director-model", provider: "grok", accountId: "xai-grok", accountLabel: "Grok", model: "director-model" }),
    );
  } finally {
    internals.grokProviderCandidate = originalGrokCandidate;
    internals.grokModelAvailable = originalGrokModelAvailable;
    internals.modelCatalog.grokModels = originalCatalogGrokModels;
    if (originalXaiApiKey === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = originalXaiApiKey;
    db.kvSet("setting_grok_enabled", "0");
  }

  // No fixed failover count may strand a later configured Claude subscription. The legacy counter
  // stopped after three switches even though config supports more accounts; each prior account caps,
  // then the fifth one returns a normal QA result.
  const multi = db.createThread({ title: "Fifth Claude subscription remains reachable", workspace, rawPrompt: "verify", brief: "verify" });
  const accounts = Array.from({ length: 5 }, (_, i) => ({ id: `claude-${i + 1}`, label: `Claude ${i + 1}`, token: `token-${i + 1}` }));
  let launches = 0;
  internals.dispatchAccount = () => accounts[0]!;
  internals.failoverAccount = (id: string) => accounts[accounts.findIndex((account) => account.id === id) + 1] ?? null;
  internals.nextReadyImplementor = () => undefined;
  internals.modelFor = () => "test-model";
  internals.modelCapFallback = async () => false;
  internals.logFailover = () => {};
  internals.createRoleAgent = () => {
    launches++;
    const capped = launches < accounts.length;
    return {
      capped: false,
      rateLimited: capped,
      rateLimitInfo: capped ? { status: "rejected", resetsAt: Date.now() + 60_000 } : undefined,
      transientApiError: false,
      transientApiErrorMessage: undefined,
      sessionId: undefined,
      start: () => {},
      result: async () => capped
        ? { type: "result", subtype: "error", isError: true, result: "usage limit reached" }
        : { type: "result", subtype: "success", isError: false, structuredOutput: verdict },
      stop: async () => {},
    };
  };
  const fifth = await internals.runRole(multi, "qa", "Review the implementation.", () => ({ model: "unused" }));
  check("all configured Claude subscriptions are tried before parking", launches === 5, String(launches));
  check("the fifth Claude subscription's QA verdict completes", fifth?.structuredOutput === verdict);
  check("a later ready Claude subscription does not cap-park the task", !internals.capParked.has(multi.id));

  // Historical tasks were already parked under the old generic QA error. Boot migration must preserve
  // their completed implementation, latch the provider that named a reset, and retry only QA.
  const legacyRoot = mkdtempSync(join(tmpdir(), "provider-fallback-legacy-"));
  const legacyWorkspace = join(legacyRoot, "workspace");
  mkdirSync(legacyWorkspace, { recursive: true });
  const legacyDb = new Db(join(legacyRoot, "orchestrator.sqlite"));
  const legacyThread = legacyDb.createThread({
    title: "Legacy Codex QA usage-limit park",
    workspace: legacyWorkspace,
    rawPrompt: "verify",
    brief: "verify",
  });
  legacyDb.updateThread(legacyThread.id, {
    state: "review",
    error: `QA could not complete — needs your review ${statedResetText}`,
  });
  legacyDb.updateThreadStageOutputs(legacyThread.id, { kickoff: "KICKOFF: completed implementation", qaRoundsUsed: 2 });
  const legacyRun = legacyDb.createRun({ threadId: legacyThread.id, role: "qa", model: "gpt-5.6", account: "codex:gpt-5.6" });
  legacyDb.updateRun(legacyRun.id, {
    state: "error",
    capFlagged: true,
    error: statedResetText,
    endedAt: Date.now(),
  });
  const legacyCapacityThread = legacyDb.createThread({
    title: "Legacy Codex QA model-capacity park",
    workspace: legacyWorkspace,
    rawPrompt: "verify",
    brief: "verify",
  });
  legacyDb.updateThread(legacyCapacityThread.id, {
    state: "review",
    error: "QA could not complete — Selected model is at capacity. Please try a different model.",
  });
  legacyDb.updateThreadStageOutputs(legacyCapacityThread.id, { kickoff: "KICKOFF: completed implementation", qaRoundsUsed: 4 });
  const legacyCapacityRun = legacyDb.createRun({ threadId: legacyCapacityThread.id, role: "qa", model: "gpt-5.6-terra", account: "codex:gpt-5.6-terra" });
  legacyDb.updateRun(legacyCapacityRun.id, {
    state: "error",
    capFlagged: false,
    error: "Selected model is at capacity. Please try a different model.",
    endedAt: Date.now(),
  });
  const legacyZaiThread = legacyDb.createThread({
    title: "Legacy z.ai QA usage-limit park",
    workspace: legacyWorkspace,
    rawPrompt: "verify",
    brief: "verify",
  });
  legacyDb.updateThread(legacyZaiThread.id, {
    state: "review",
    error: `QA could not complete — needs your review ${statedResetText}`,
  });
  legacyDb.updateThreadStageOutputs(legacyZaiThread.id, { kickoff: "KICKOFF: completed implementation", qaRoundsUsed: 1 });
  const legacyZaiRun = legacyDb.createRun({ threadId: legacyZaiThread.id, role: "qa", model: "glm-4.6", account: "zai" });
  legacyDb.updateRun(legacyZaiRun.id, {
    state: "error",
    capFlagged: true,
    error: statedResetText,
    endedAt: Date.now(),
  });
  // The last overnight task was still actively in QA when the server was deployed. It is not a
  // legacy review park, so boot reconciliation changes it to failed before the cap supervisor sees
  // it. Its recorded provider reset must nevertheless be restored before the direct QA retry.
  const activeResetDate = new Date(statedResetDate.getTime() + 24 * 60 * 60 * 1000);
  const activeResetText = usageLimitNoticeAt(activeResetDate);
  const activeReset = parseUsageLimitResetAt(activeResetText)!;
  const activeQaThread = legacyDb.createThread({
    title: "Active Codex QA usage-limit interruption",
    workspace: legacyWorkspace,
    rawPrompt: "verify",
    brief: "verify",
  });
  legacyDb.updateThread(activeQaThread.id, { state: "qa" });
  legacyDb.updateThreadStageOutputs(activeQaThread.id, { kickoff: "KICKOFF: completed implementation", qaRoundsUsed: 3 });
  const activeQaRun = legacyDb.createRun({ threadId: activeQaThread.id, role: "qa", model: "gpt-5.6", account: "codex:gpt-5.6" });
  const activeQaEndedAt = Date.now() + 10_000;
  legacyDb.raw.prepare("UPDATE agent_runs SET started_at = ? WHERE id = ?").run(activeQaEndedAt - 500, activeQaRun.id);
  legacyDb.updateRun(activeQaRun.id, {
    state: "error",
    capFlagged: true,
    error: activeResetText,
    endedAt: activeQaEndedAt,
  });
  // This fixture needs boot reconciliation to inspect a live QA state, but it must not launch a real
  // async pipeline against the temporary database after this test closes it.
  const originalScheduleAutoResume = (ThreadManager.prototype as any).scheduleAutoResume;
  (ThreadManager.prototype as any).scheduleAutoResume = () => {};
  let legacyManager: InstanceType<typeof ThreadManager>;
  try {
    legacyManager = new ThreadManager(legacyDb, new EventHub(), new FileMemoryService(join(legacyRoot, "memory")), new StubAccounts() as unknown as AccountManager);
  } finally {
    (ThreadManager.prototype as any).scheduleAutoResume = originalScheduleAutoResume;
  }
  const legacyInternals = legacyManager as any;
  check("legacy Codex cap parks are converted to the auto-resume marker", (legacyDb.getThread(legacyThread.id)?.error ?? "").startsWith("⏳ Auto-resume pending"));
  check("raw Codex model-capacity QA parks are converted to the auto-resume marker", (legacyDb.getThread(legacyCapacityThread.id)?.error ?? "").startsWith("⏳ Auto-resume pending"));
  check("model-capacity recovery preserves the charged QA round", legacyDb.getThreadStageOutputs(legacyCapacityThread.id).qaCapRetryRound === 4, String(legacyDb.getThreadStageOutputs(legacyCapacityThread.id).qaCapRetryRound));
  check("legacy QA recovery preserves the charged QA round", legacyDb.getThreadStageOutputs(legacyThread.id).qaCapRetryRound === 2, String(legacyDb.getThreadStageOutputs(legacyThread.id).qaCapRetryRound));
  check("an interrupted active QA cap restores its later Codex reset before retry", legacyInternals.codexCapUntil === activeReset, String(legacyInternals.codexCapUntil));
  check("legacy z.ai account labels latch z.ai before requeue", legacyInternals.zaiCapUntil === statedReset, String(legacyInternals.zaiCapUntil));
  check("an interrupted active QA preserves its direct-review retry marker", legacyDb.getThreadStageOutputs(activeQaThread.id).qaInterruptedRetryRound === 3, String(legacyDb.getThreadStageOutputs(activeQaThread.id).qaInterruptedRetryRound));
  let legacyImplementorStarts = 0;
  let legacyQaRuns = 0;
  legacyInternals.startResumedImplementor = async () => {
    legacyImplementorStarts++;
    return { run: {}, accountId: "claude-a" };
  };
  legacyInternals.stopLive = async () => {};
  legacyInternals.runSelfImprovement = async () => {};
  legacyInternals.runQA = async () => {
    legacyQaRuns++;
    return { pass: true, summary: "fallback QA completed", issues: [] };
  };
  await legacyInternals.runImplementorQaLoop(legacyDb.getThread(legacyThread.id)!, "KICKOFF: completed implementation", undefined, undefined, undefined, {
    qaEnabled: true,
    maxQaRounds: 2,
  });
  check("legacy recovery reruns QA directly", legacyQaRuns === 1 && legacyImplementorStarts === 0, `qa=${legacyQaRuns}, implementor=${legacyImplementorStarts}`);
  check("legacy QA recovery reaches done without another manual-review park", legacyDb.getThread(legacyThread.id)?.state === "done", legacyDb.getThread(legacyThread.id)?.state);
  legacyDb.raw.close();
  rmSync(legacyRoot, { recursive: true, force: true });

  // Boot restoration must never resurrect an old provider-stated reset after a newer clean run proved
  // that reset stale. A still-newer model-capacity rejection has no reset of its own; it gets the normal
  // bounded/live-headroom latch rather than inheriting the disproved multi-day date.
  const staleRoot = mkdtempSync(join(tmpdir(), "provider-fallback-stale-reset-"));
  const staleWorkspace = join(staleRoot, "workspace");
  mkdirSync(staleWorkspace, { recursive: true });
  const staleDb = new Db(join(staleRoot, "orchestrator.sqlite"));
  const staleThread = staleDb.createThread({ title: "Old reset stays disproved", workspace: staleWorkspace, rawPrompt: "verify", brief: "verify" });
  staleDb.updateThread(staleThread.id, { state: "review", error: "QA could not complete — Selected model is at capacity. Please try a different model." });
  staleDb.updateThreadStageOutputs(staleThread.id, { kickoff: "KICKOFF: completed implementation", qaRoundsUsed: 1 });
  const oldCap = staleDb.createRun({ threadId: staleThread.id, role: "qa", model: "gpt-5.6-terra", account: "codex:gpt-5.6-terra" });
  const staleNow = Date.now();
  staleDb.raw.prepare("UPDATE agent_runs SET started_at = ? WHERE id = ?").run(staleNow - 3_500, oldCap.id);
  staleDb.updateRun(oldCap.id, { state: "error", capFlagged: true, error: statedResetText, endedAt: staleNow - 3_000 });
  const recovered = staleDb.createRun({ threadId: staleThread.id, role: "qa", model: "gpt-5.6-terra", account: "codex:gpt-5.6-terra" });
  staleDb.raw.prepare("UPDATE agent_runs SET started_at = ? WHERE id = ?").run(staleNow - 2_500, recovered.id);
  staleDb.updateRun(recovered.id, { state: "done", capFlagged: false, endedAt: staleNow - 2_000 });
  const currentCapacity = staleDb.createRun({ threadId: staleThread.id, role: "qa", model: "gpt-5.6-terra", account: "codex:gpt-5.6-terra" });
  staleDb.raw.prepare("UPDATE agent_runs SET started_at = ? WHERE id = ?").run(staleNow - 1_500, currentCapacity.id);
  staleDb.updateRun(currentCapacity.id, { state: "error", capFlagged: false, error: "Selected model is at capacity. Please try a different model.", endedAt: staleNow - 1_000 });
  (ThreadManager.prototype as any).scheduleAutoResume = () => {};
  let staleManager: InstanceType<typeof ThreadManager>;
  try {
    staleManager = new ThreadManager(staleDb, new EventHub(), new FileMemoryService(join(staleRoot, "memory")), new StubAccounts() as unknown as AccountManager);
  } finally {
    (ThreadManager.prototype as any).scheduleAutoResume = originalScheduleAutoResume;
  }
  const staleInternals = staleManager as any;
  check("a newer success prevents restoration of an older provider-stated Codex reset", staleInternals.codexCapUntil !== statedReset, String(staleInternals.codexCapUntil));
  check("the current reset-less capacity latch remains non-authoritative", staleInternals.codexCapUntilProviderStated === false, String(staleInternals.codexCapUntilProviderStated));
  staleDb.raw.close();
  rmSync(staleRoot, { recursive: true, force: true });

  const recordOutcome = (fixtureDb: any, fixtureThread: any, account: string, state: "done" | "error", error: string, capFlagged: boolean, endedAt: number): void => {
    const run = fixtureDb.createRun({ threadId: fixtureThread.id, role: "qa", model: "fixture", account });
    fixtureDb.raw.prepare("UPDATE agent_runs SET started_at = ? WHERE id = ?").run(endedAt - 100, run.id);
    fixtureDb.updateRun(run.id, { state, error, capFlagged, endedAt });
  };

  // A persisted CLI latch must be cleared by a newer success on THAT provider, not just on Codex.
  // This is plan-wide for each CLI provider even though run.account carries the selected model.
  const successRoot = mkdtempSync(join(tmpdir(), "provider-fallback-success-reconcile-"));
  const successWorkspace = join(successRoot, "workspace");
  mkdirSync(successWorkspace, { recursive: true });
  const successDb = new Db(join(successRoot, "orchestrator.sqlite"));
  const reconcileNow = Date.now();
  successDb.kvSet("grok_cap_until", String(reconcileNow + 7 * 24 * 60 * 60 * 1000));
  successDb.kvSet("grok_cap_recorded_at", String(reconcileNow - 5_000));
  successDb.kvSet("zai_cap_until", String(reconcileNow + 7 * 24 * 60 * 60 * 1000));
  successDb.kvSet("zai_cap_recorded_at", String(reconcileNow - 5_000));
  const grokSuccessThread = successDb.createThread({ title: "New Grok success clears stale latch", workspace: successWorkspace, rawPrompt: "verify", brief: "verify" });
  recordOutcome(successDb, grokSuccessThread, "grok:grok-4.6", "error", statedResetText, true, reconcileNow - 4_000);
  recordOutcome(successDb, grokSuccessThread, "grok:grok-4.6", "done", "", false, reconcileNow - 3_000);
  const zaiSuccessThread = successDb.createThread({ title: "New z.ai success clears stale latch", workspace: successWorkspace, rawPrompt: "verify", brief: "verify" });
  recordOutcome(successDb, zaiSuccessThread, "zai", "error", statedResetText, true, reconcileNow - 2_000);
  recordOutcome(successDb, zaiSuccessThread, "zai", "done", "", false, reconcileNow - 1_000);
  const successInternals = bootFixtureManager(successDb, successRoot);
  check("a newer Grok success clears its persisted historical latch", successInternals.grokCapUntil === undefined, String(successInternals.grokCapUntil));
  check("a newer z.ai success clears its persisted historical latch", successInternals.zaiCapUntil === undefined, String(successInternals.zaiCapUntil));
  successDb.raw.close();
  rmSync(successRoot, { recursive: true, force: true });

  // Director calls can hit a provider cap without creating an agent_runs row. A fresh durable latch
  // from such a call must survive boot even when the database contains an older successful pipeline run.
  const directorRoot = mkdtempSync(join(tmpdir(), "provider-fallback-director-latch-"));
  const directorWorkspace = join(directorRoot, "workspace");
  mkdirSync(directorWorkspace, { recursive: true });
  const directorDb = new Db(join(directorRoot, "orchestrator.sqlite"));
  const directorNow = Date.now();
  const directorLatchUntil = directorNow + 7 * 24 * 60 * 60 * 1000;
  directorDb.kvSet("grok_cap_until", String(directorLatchUntil));
  directorDb.kvSet("grok_cap_recorded_at", String(directorNow));
  const directorThread = directorDb.createThread({ title: "Fresh director Grok cap survives boot", workspace: directorWorkspace, rawPrompt: "verify", brief: "verify" });
  recordOutcome(directorDb, directorThread, "grok:grok-4.6", "done", "", false, directorNow - 1_000);
  const directorInternals = bootFixtureManager(directorDb, directorRoot);
  check("a fresh director-origin Grok latch is not erased by historical success", directorInternals.grokCapUntil === directorLatchUntil, String(directorInternals.grokCapUntil));
  directorDb.raw.close();
  rmSync(directorRoot, { recursive: true, force: true });

  // If a restart beats the KV write after a reset-less provider capacity error, all CLI backends still
  // receive a bounded fallback latch rather than being selected again immediately.
  const fallbackRoot = mkdtempSync(join(tmpdir(), "provider-fallback-resetless-"));
  const fallbackWorkspace = join(fallbackRoot, "workspace");
  mkdirSync(fallbackWorkspace, { recursive: true });
  const fallbackDb = new Db(join(fallbackRoot, "orchestrator.sqlite"));
  const fallbackNow = Date.now();
  const grokCapacityThread = fallbackDb.createThread({ title: "Reset-less Grok capacity cap restores", workspace: fallbackWorkspace, rawPrompt: "verify", brief: "verify" });
  recordOutcome(fallbackDb, grokCapacityThread, "grok:grok-4.6", "error", "Selected model is at capacity. Please try a different model.", false, fallbackNow - 2_000);
  const zaiCapacityThread = fallbackDb.createThread({ title: "Reset-less z.ai capacity cap restores", workspace: fallbackWorkspace, rawPrompt: "verify", brief: "verify" });
  recordOutcome(fallbackDb, zaiCapacityThread, "zai", "error", "Selected model is at capacity. Please try a different model.", false, fallbackNow - 1_000);
  const fallbackInternals = bootFixtureManager(fallbackDb, fallbackRoot);
  check("a reset-less Grok cap is restored with a bounded latch", fallbackInternals.grokCapUntil > Date.now(), String(fallbackInternals.grokCapUntil));
  check("a reset-less z.ai cap is restored with a bounded latch", fallbackInternals.zaiCapUntil > Date.now(), String(fallbackInternals.zaiCapUntil));
  fallbackDb.raw.close();
  rmSync(fallbackRoot, { recursive: true, force: true });

  // A later model-capacity notice is not proof that an earlier provider-stated plan reset is stale.
  // Keep the authoritative date until a clean run succeeds after it.
  const preserveRoot = mkdtempSync(join(tmpdir(), "provider-fallback-preserve-reset-"));
  const preserveWorkspace = join(preserveRoot, "workspace");
  mkdirSync(preserveWorkspace, { recursive: true });
  const preserveDb = new Db(join(preserveRoot, "orchestrator.sqlite"));
  const preserveThread = preserveDb.createThread({ title: "Reset-less capacity does not shorten provider reset", workspace: preserveWorkspace, rawPrompt: "verify", brief: "verify" });
  const preserveNow = Date.now();
  recordOutcome(preserveDb, preserveThread, "codex:gpt-5.6-terra", "error", statedResetText, true, preserveNow - 2_000);
  recordOutcome(preserveDb, preserveThread, "codex:gpt-5.6-terra", "error", "Selected model is at capacity. Please try a different model.", false, preserveNow - 1_000);
  const preserveInternals = bootFixtureManager(preserveDb, preserveRoot);
  check("a reset-less Codex capacity cap preserves an undisproved provider reset", preserveInternals.codexCapUntil === statedReset, String(preserveInternals.codexCapUntil));
  check("the preserved Codex reset remains provider-authoritative", preserveInternals.codexCapUntilProviderStated === true, String(preserveInternals.codexCapUntilProviderStated));
  preserveDb.raw.close();
  rmSync(preserveRoot, { recursive: true, force: true });

  const expiredRoot = mkdtempSync(join(tmpdir(), "provider-fallback-expired-reset-"));
  const expiredWorkspace = join(expiredRoot, "workspace");
  mkdirSync(expiredWorkspace, { recursive: true });
  const expiredDb = new Db(join(expiredRoot, "orchestrator.sqlite"));
  const expiredThread = expiredDb.createThread({ title: "Expired provider reset does not re-latch", workspace: expiredWorkspace, rawPrompt: "verify", brief: "verify" });
  recordOutcome(expiredDb, expiredThread, "codex:gpt-5.6-terra", "error", "You've hit your usage limit. Try again at Jan 1st, 2020 12:00 PM.", true, Date.now() - 1_000);
  const expiredInternals = bootFixtureManager(expiredDb, expiredRoot);
  check("an expired Codex reset does not become a fresh fallback cooldown on boot", expiredInternals.codexCapUntil === undefined, String(expiredInternals.codexCapUntil));
  expiredDb.raw.close();
  rmSync(expiredRoot, { recursive: true, force: true });

  // Regression: this exact persisted-latch + fresh-ping state used to recurse between
  // codexCapActive and codexProviderCandidate until Node exhausted the stack during boot.
  const livePingRoot = mkdtempSync(join(tmpdir(), "provider-fallback-live-ping-"));
  const livePingWorkspace = join(livePingRoot, "workspace");
  mkdirSync(livePingWorkspace, { recursive: true });
  const livePingDb = new Db(join(livePingRoot, "orchestrator.sqlite"));
  const livePingInternals = bootFixtureManager(livePingDb, livePingRoot);
  const livePingNow = Date.now();
  noteCodexPing({
    fiveHour: 10,
    sevenDay: 20,
    fiveHourReset: livePingNow + 4 * 60 * 60_000,
    sevenDayReset: livePingNow + 6 * 24 * 60 * 60_000,
    planType: "test",
    updatedAt: livePingNow,
  });
  livePingInternals.codexCapUntil = livePingNow + 60 * 60_000;
  livePingInternals.codexCapUntilProviderStated = false;
  check(
    "a fresh Codex ping clears a fallback latch without recursive candidate evaluation",
    livePingInternals.codexCapActive() === false && livePingInternals.codexCapUntil === undefined,
    String(livePingInternals.codexCapUntil),
  );
  livePingDb.raw.close();
  rmSync(livePingRoot, { recursive: true, force: true });
} finally {
  db.raw.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(testDataRoot, { recursive: true, force: true });
}
