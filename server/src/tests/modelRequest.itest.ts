/**
 * Integration gate — a Director model request is a durable, strict task-local routing constraint.
 *
 * This test stops immediately before a real CLI spawn. Everything before that boundary is real:
 * Director command parsing, canonical alias resolution, DB persistence/retry, legacy-brief recovery,
 * strict capacity parking, wrong-session rejection, and the model/account written to agent_runs.
 */

process.env.CAP_RETRY_MS = "0";
process.env.ACCOUNT_PING_MS = "3600000";
process.env.FAST_ACCOUNT_PING_MS = "3600000";

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountManager } from "../accounts/accountManager.js";
import type { OperatorNotes } from "../orchestrator/notes.js";
import type { Scheduler } from "../orchestrator/scheduler.js";
import type { ModelRequest, Thread } from "../types.js";

const { Db } = await import("../db/db.js");
const { EventHub } = await import("../events.js");
const { FileMemoryService } = await import("../memory/memory.js");
const { DIRECTOR_CLI_SCHEMA, executeDirectorCliAction } = await import("../orchestrator/directorCliBridge.js");
const { detectModelRequest, resolveModelRequest } = await import("../orchestrator/modelRequest.js");
const { ThreadManager } = await import("../orchestrator/threadManager.js");

const SPARK = "gpt-5.3-codex-spark";
const SOL = "gpt-5.6-sol";
const CANDIDATES = [
  { provider: "codex" as const, model: SPARK, labels: ["GPT-5.3-Codex-Spark"] },
  { provider: "codex" as const, model: SOL, labels: ["GPT-5.6-Sol"] },
  { provider: "claude" as const, model: "claude-opus-5" },
];

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    failures.push(label + (detail ? ` — ${detail}` : ""));
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
  }
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
  isModelLimited(_id: string, _model: string): boolean { return false; }
  auxToken(): string | undefined { return undefined; }
  dispatchPreview(): Record<string, unknown> {
    return {
      account: { id: "acct-a", label: "account a", token: "stub" },
      hasHeadroom: true,
      fiveHour: 10,
      sevenDay: 10,
      fiveHourReset: Date.now() + 3_600_000,
      sevenDayReset: Date.now() + 86_400_000,
      weeklySafetyPct: 100,
    };
  }
}

const dir = mkdtempSync(join(tmpdir(), "strict-model-request-"));
const workspace = join(dir, "workspace");
mkdirSync(workspace, { recursive: true });
const db = new Db(join(dir, "orchestrator.sqlite"));
const hub = new EventHub();
const memory = new FileMemoryService(join(dir, "memory"));
const mgr = new ThreadManager(db, hub, memory, new StubAccounts() as unknown as AccountManager);
// Focused tests use the real manager methods through their internal seams and stop before paid work.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const internals = mgr as any;
internals.modelRequestCandidates = () => CANDIDATES;
internals.enqueueOrRun = (): void => {};
internals.liveBench.prepareForSelection = async (): Promise<void> => {};
internals.liveBench.note = (): undefined => undefined;

const strictSpark = (requested = "GPT Spark"): ModelRequest => ({
  requested,
  provider: "codex",
  model: SPARK,
  strict: true,
});

async function main(): Promise<void> {
  console.log("\n=== strict Director model requests ===\n");

  console.log("1 — canonical resolution and conservative legacy parsing");
  for (const label of ["GPT Spark", "Spark", "GPT-5.3-Codex-Spark"]) {
    const resolved = resolveModelRequest(label, CANDIDATES);
    check(`${label} resolves through the live candidate label`, resolved.provider === "codex" && resolved.model === SPARK, JSON.stringify(resolved));
  }
  const direct = detectModelRequest("Use our GPT Spark usage as persistent capacity for this overnight task.", CANDIDATES);
  check("direct owner wording in a legacy brief recovers the Spark pin", direct?.model === SPARK && direct.strict, JSON.stringify(direct));
  check(
    "a brief discussing the quoted phrase does not pin its own implementor",
    detectModelRequest('Add parsing for wording such as "use GPT Spark usage" in Director prompts.', CANDIDATES) === null,
  );
  check("ordinary briefs remain unpinned", detectModelRequest("Improve the overnight trainer and verify it.", CANDIDATES) === null);
  check("a provider contrast cannot pin the explicitly rejected model", detectModelRequest("Run this on GPT, not Grok.", CANDIDATES) === null);
  check("a concrete contrast pins its positive side", detectModelRequest("Use Spark, not Sol.", CANDIDATES)?.model === SPARK);
  const unresolved = resolveModelRequest("GPT Future", CANDIDATES);
  check("an unknown explicit request remains strict and unresolved", unresolved.model === null && unresolved.strict, JSON.stringify(unresolved));

  console.log("\n2 — the provider-neutral Director command bridge carries the exact owner field");
  let dispatched: Record<string, unknown> | undefined;
  const fakeApi = {
    dispatch: async (input: Record<string, unknown>) => { dispatched = input; return "strict-task-123"; },
  } as unknown as InstanceType<typeof ThreadManager>;
  const bridge = await executeDirectorCliAction(
    { kind: "dispatch", title: "Spark task", workspace, brief: "Run the overnight work.", model: "GPT Spark" },
    fakeApi,
    {} as Scheduler,
    {} as OperatorNotes,
    [],
  );
  check("CLI schema exposes the model field", "model" in (DIRECTOR_CLI_SCHEMA.properties ?? {}));
  check(
    "CLI dispatch forwards requestedModel verbatim",
    bridge.dispatchedId === "strict-task-123" && dispatched?.requestedModel === "GPT Spark",
    JSON.stringify(dispatched),
  );

  console.log("\n3 — dispatch, persistence, retry, and legacy recovery retain the constraint");
  const dispatchedId = await mgr.dispatch({ title: "Pinned from bridge", workspace, brief: "Run it.", requestedModel: "GPT Spark" });
  check("manager dispatch persists the canonical strict pin", db.getThread(dispatchedId)?.modelRequest?.model === SPARK, JSON.stringify(db.getThread(dispatchedId)?.modelRequest));
  check("dispatch posts an owner-visible strict-pin finding", db.listFindings(dispatchedId).some((finding) => finding.summary.includes(`pinned — ${SPARK}`)));
  db.updateThreadStageOutputs(dispatchedId, { modelPick: { provider: "codex", model: SOL, effort: "max", reason: "stale" } });
  db.resetThreadForRetry(dispatchedId);
  check("from-scratch retry retains the task-local pin", db.getThread(dispatchedId)?.modelRequest?.model === SPARK);

  const legacy = db.createThread({
    title: "Legacy Bobfish-style task",
    workspace,
    rawPrompt: "",
    brief: "Use GPT Spark capacity as persistent overnight training capacity. Continue the work.",
  });
  db.updateThreadStageOutputs(legacy.id, { modelPick: { provider: "codex", model: SOL, effort: "max", reason: "old automatic pick" } });
  const recovered = internals.ensureThreadModelRequest(legacy) as Thread;
  check("a paused legacy task is backfilled before routing", recovered.modelRequest?.model === SPARK, JSON.stringify(recovered.modelRequest));
  check("legacy recovery removes the conflicting Sol auto-pick", db.getThreadStageOutputs(legacy.id).modelPick === undefined, JSON.stringify(db.getThreadStageOutputs(legacy.id)));

  const ordinaryId = await mgr.dispatch({ title: "Ordinary routing", workspace, brief: "Fix one typo and test it." });
  check("a task with no owner model request remains on normal routing", db.getThread(ordinaryId)?.modelRequest == null);
  mgr.setSettings({ autoModelSelection: true });
  let selectorCalls = 0;
  internals.askDirectorJson = async (): Promise<null> => { selectorCalls++; return null; };
  const pinnedPick = await internals.autoSelectModel(db.getThread(dispatchedId)!);
  check("automatic model selection cannot overwrite a strict pin", pinnedPick === undefined && selectorCalls === 0);

  console.log("\n4 — exact capacity gate, runtime row, resume, and cap recovery never substitute Sol");
  const realRequestedModelCapacitySnapshot = internals.requestedModelCapacitySnapshot.bind(mgr);
  const readySnapshot = {
    options: [{ provider: "codex", label: `Codex ${SPARK}`, windows: [], hasHeadroom: true }],
    ready: [{ provider: "codex", label: `Codex ${SPARK}`, windows: [], hasHeadroom: true }],
  };
  internals.requestedModelCapacitySnapshot = () => readySnapshot;
  const runtimeThread = db.createThread({ title: "Exact Spark runtime", workspace, rawPrompt: "", brief: "Run it.", modelRequest: strictSpark() });
  const provider = internals.gateImplementorProvider(runtimeThread, { capParkOnExhaustion: true, effort: "max" });
  check("strict gate selects only the request's provider", provider === "codex", String(provider));

  const wireSentinel = "stop before real CLI spawn";
  const originalWireRun = internals.wireRun.bind(mgr);
  internals.wireRun = (): never => { throw new Error(wireSentinel); };
  try {
    internals.startImplementor(runtimeThread, "KICKOFF", { effort: "max" });
  } catch (error) {
    check("test intercepted the run at the intended pre-spawn boundary", String(error).includes(wireSentinel), String(error));
  } finally {
    internals.wireRun = originalWireRun;
  }
  const runtimeRun = db.listRuns(runtimeThread.id).at(-1);
  check("the actual agent_run model is Spark", runtimeRun?.model === SPARK, JSON.stringify(runtimeRun));
  check("the runtime account identifies the Spark model", runtimeRun?.account === `codex:${SPARK}`, String(runtimeRun?.account));
  check("no Sol implementor row was created", !db.listRuns(runtimeThread.id).some((run) => run.model === SOL));

  const resumeThread = db.createThread({ title: "Retarget a wrong legacy session", workspace, rawPrompt: "", brief: "Continue.", modelRequest: strictSpark() });
  const oldRun = db.createRun({ threadId: resumeThread.id, role: "implementor", model: SOL, account: `codex:${SOL}`, effort: "max" });
  db.updateRun(oldRun.id, { state: "interrupted", sessionId: "old-sol-session", endedAt: Date.now() });
  internals.implementorProvider.set(resumeThread.id, "codex");
  const realStartImplementor = internals.startImplementor.bind(mgr);
  let resumedWith: string | undefined | null = null;
  internals.startImplementor = (_thread: Thread, _kickoff: string, opts?: { resume?: string }) => {
    resumedWith = opts?.resume ?? null;
    return { run: {}, runId: "fake", accountId: "openai-codex" };
  };
  await internals.startResumedImplementor(resumeThread, "FULL ORIGINAL BRIEF", "old-sol-session", {
    effort: "max",
    resumeNudge: "Continue.",
    qaFollows: true,
  });
  internals.startImplementor = realStartImplementor;
  check("a legacy Sol session is discarded before the Spark relaunch", resumedWith === null, String(resumedWith));

  const resetAt = Date.now() + 3_600_000;
  const cappedThread = db.createThread({ title: "Spark capacity wait", workspace, rawPrompt: "", brief: "Wait for Spark.", modelRequest: strictSpark() });
  internals.requestedModelCapacitySnapshot = () => ({
    options: [{ provider: "codex", label: `Codex ${SPARK}`, windows: [], hasHeadroom: false }],
    ready: [],
    nextAt: resetAt,
  });
  const cappedProvider = internals.gateImplementorProvider(cappedThread, { capParkOnExhaustion: true, effort: "max" });
  const parked = db.getThread(cappedThread.id);
  check("a capped Spark request does not route to Sol", cappedProvider === null && db.listRuns(cappedThread.id).length === 0);
  check("capacity exhaustion becomes a durable auto-resume park", parked?.state === "review" && parked.error?.startsWith("⏳ Auto-resume pending") === true, parked?.error ?? undefined);
  check("the park names the exact-model-only recovery policy", parked?.error?.includes(SPARK) === true && parked.error.includes("no fallback model is allowed"), parked?.error ?? undefined);

  internals.requestedModelCapacitySnapshot = realRequestedModelCapacitySnapshot;
  const impossible = db.createThread({ title: "Unknown exact model", workspace, rawPrompt: "", brief: "Run it.", modelRequest: unresolved });
  // Calling the concrete capacity method through the instance verifies unresolved requests fail before
  // ordinary provider routing. No auth or meter read is needed for this branch.
  const impossibleProvider = internals.gateImplementorProvider(impossible, { capParkOnExhaustion: true, effort: "max" });
  const failedThread = db.getThread(impossible.id);
  check("an unresolved explicit request fails clearly", impossibleProvider === null && failedThread?.state === "failed", JSON.stringify(failedThread));
  check("the failure says no substitute started", failedThread?.error?.includes("no substitute was started") === true, failedThread?.error ?? undefined);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) throw new Error(`Strict model request gate failed:\n${failures.join("\n")}`);
}

try {
  await main();
} finally {
  internals.modelCatalog?.stop?.();
  if (internals.capSupervisor) clearInterval(internals.capSupervisor);
  if (internals.capResumeTimer) clearTimeout(internals.capResumeTimer);
  db.raw.close();
  rmSync(dir, { recursive: true, force: true });
}
