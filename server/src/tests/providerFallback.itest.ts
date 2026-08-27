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
    rateLimitInfo: cap ? { status: "rejected", resetsAt: statedReset!, resetSource: "provider" } : undefined,
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
    error: "You've hit your usage limit. Try again at Sep 2nd, 2026 2:23 PM.",
    endedAt: Date.now() + 3_000,
  });
  check("a newer legacy textual error cap remains authoritative", !internals.codexRecoveredAfterLastRecordedCap());
  const legacySuccessCap = db.createRun({ threadId: successCap.id, role: "qa", model: "gpt-5.6-terra", account: "codex:gpt-5.6-terra" });
  db.updateRun(legacySuccessCap.id, {
    state: "done",
    error: "You've hit your usage limit. Try again at Sep 2nd, 2026 2:23 PM.",
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
    error: "QA could not complete — needs your review You've hit your usage limit. Try again at Sep 2nd, 2026 2:23 PM.",
  });
  legacyDb.updateThreadStageOutputs(legacyThread.id, { kickoff: "KICKOFF: completed implementation", qaRoundsUsed: 2 });
  const legacyRun = legacyDb.createRun({ threadId: legacyThread.id, role: "qa", model: "gpt-5.6", account: "codex:gpt-5.6" });
  legacyDb.updateRun(legacyRun.id, {
    state: "error",
    capFlagged: true,
    error: "You've hit your usage limit. Try again at Sep 2nd, 2026 2:23 PM.",
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
    error: "QA could not complete — needs your review You've hit your usage limit. Try again at Sep 2nd, 2026 2:23 PM.",
  });
  legacyDb.updateThreadStageOutputs(legacyZaiThread.id, { kickoff: "KICKOFF: completed implementation", qaRoundsUsed: 1 });
  const legacyZaiRun = legacyDb.createRun({ threadId: legacyZaiThread.id, role: "qa", model: "glm-4.6", account: "zai" });
  legacyDb.updateRun(legacyZaiRun.id, {
    state: "error",
    capFlagged: true,
    error: "You've hit your usage limit. Try again at Sep 2nd, 2026 2:23 PM.",
    endedAt: Date.now(),
  });
  // The last overnight task was still actively in QA when the server was deployed. It is not a
  // legacy review park, so boot reconciliation changes it to failed before the cap supervisor sees
  // it. Its recorded provider reset must nevertheless be restored before the direct QA retry.
  const activeReset = parseUsageLimitResetAt("You've hit your usage limit. Try again at Sep 3rd, 2026 2:23 PM.", new Date("2026-08-27T12:00:00").getTime())!;
  const activeQaThread = legacyDb.createThread({
    title: "Active Codex QA usage-limit interruption",
    workspace: legacyWorkspace,
    rawPrompt: "verify",
    brief: "verify",
  });
  legacyDb.updateThread(activeQaThread.id, { state: "qa" });
  legacyDb.updateThreadStageOutputs(activeQaThread.id, { kickoff: "KICKOFF: completed implementation", qaRoundsUsed: 3 });
  const activeQaRun = legacyDb.createRun({ threadId: activeQaThread.id, role: "qa", model: "gpt-5.6", account: "codex:gpt-5.6" });
  legacyDb.updateRun(activeQaRun.id, {
    state: "error",
    capFlagged: true,
    error: "You've hit your usage limit. Try again at Sep 3rd, 2026 2:23 PM.",
    endedAt: Date.now(),
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
  staleDb.updateRun(oldCap.id, { state: "error", capFlagged: true, error: "You've hit your usage limit. Try again at Sep 2nd, 2026 2:23 PM.", endedAt: staleNow - 3_000 });
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
} finally {
  db.raw.close();
  rmSync(root, { recursive: true, force: true });
}
