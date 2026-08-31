process.env.CAP_RETRY_MS = "0";

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountManager } from "../accounts/accountManager.js";
import type { Scheduler } from "../orchestrator/scheduler.js";
import type { OperatorNotes } from "../orchestrator/notes.js";

const { Db } = await import("../db/db.js");
const { EventHub } = await import("../events.js");
const { FileMemoryService } = await import("../memory/memory.js");
const { ThreadManager } = await import("../orchestrator/threadManager.js");
const { Director } = await import("../orchestrator/director.js");
const { executeDirectorCliAction } = await import("../orchestrator/directorCliBridge.js");
const { directorSafetyArgs } = await import("../agents/codexRunner.js");
const { SUPERVISOR_JUDGE_MAX_TURNS } = await import("../orchestrator/supervisor.js");

let passed = 0;
let failed = 0;
const check = (label: string, ok: boolean, detail?: string): void => {
  if (ok) { passed++; console.log(`  ✅ ${label}`); }
  else { failed++; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`); }
};

class CappedClaudeAccounts {
  onUsageRefresh(_cb: () => void): void {}
  effectiveUtilization(): number | null { return 100; }
  soonestResetAt(): number | null { return Date.now() + 3_600_000; }
  hasHeadroom(): boolean { return false; }
  setPingInterval(_ms: number): void {}
  applyEnabled(_id: string, _enabled: boolean): void {}
  applyWeeklySafetyPct(_id: string, _pct: number): void {}
  setSpreadUsage(_on: boolean): void {}
  isModelLimited(_id: string, _model: string): boolean { return false; }
  dispatchPreview(): Record<string, unknown> {
    return {
      account: { id: "claude-capped", label: "capped Claude", token: "stub" }, hasHeadroom: false,
      fiveHour: 100, sevenDay: 100, fiveHourReset: Date.now() + 3_600_000,
      sevenDayReset: Date.now() + 86_400_000, weeklySafetyPct: 100,
    };
  }
  dto(): Array<Record<string, unknown>> { return [{ id: "claude-capped", enabled: true, rateLimited: true, fiveHour: 100, sevenDay: 100 }]; }
  isRateLimited(): boolean { return true; }
  byId(): undefined { return undefined; }
}

const dir = mkdtempSync(join(tmpdir(), "director-provider-"));
const workspace = join(dir, "workspace");
mkdirSync(workspace, { recursive: true });
const db = new Db(join(dir, "orchestrator.sqlite"));
const hub = new EventHub();
const memory = new FileMemoryService(join(dir, "memory"));
const mgr = new ThreadManager(db, hub, memory, new CappedClaudeAccounts() as unknown as AccountManager);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const internals = mgr as any;
internals.liveBench.prepareForSelection = async (): Promise<void> => {};
internals.liveBench.note = (): undefined => undefined;

try {
  console.log("\n=== provider-neutral director ===\n");
  mgr.setSettings({ codexEnabled: true, modelOverrides: { codex: { director: "gpt-director" } } });
  internals.codexImplementorReady = (): boolean => true;
  internals.codexProviderCandidate = () => ({ provider: "codex", hasHeadroom: true, fiveHour: 20, sevenDay: 30, sevenDayReset: Date.now() + 86_400_000, weeklySafetyPct: 100 });
  internals.codexRosterModels = (): string[] => ["gpt-smart-a", "gpt-smart-b"];

  const configured = mgr.directorTargets(false);
  check("capped Claude is excluded", configured.every((t) => t.provider !== "claude"), JSON.stringify(configured));
  check("Codex remains a director target", configured.length === 1 && configured[0]?.model === "gpt-director", JSON.stringify(configured));
  check("usage-aware fallback chooses Codex", mgr.preferredDirectorTarget(configured)?.provider === "codex");

  const originalCreateDirectorAgent = mgr.createDirectorAgent.bind(mgr);
  let capture: "supervisor" | "generic" = "supervisor";
  let supervisorTurns: number | undefined;
  let genericTurns: number | undefined;
  internals.createDirectorAgent = (_target: unknown, cfg: { maxTurns?: number }) => {
    if (capture === "supervisor") supervisorTurns = cfg.maxTurns;
    else genericTurns = cfg.maxTurns;
    return {
      rateLimited: false,
      onEvent: () => () => {},
      start: () => {},
      result: async () => ({ isError: false, structuredOutput: { ok: true }, costUsd: 0, tokenUsage: { totalTokens: 1 } }),
      stop: async () => {},
    };
  };
  const simpleSchema = { type: "object", additionalProperties: true };
  await mgr.supervisorJudge("inspect this task", simpleSchema);
  capture = "generic";
  await mgr.askDirectorJson("pick a model", simpleSchema, configured[0]);
  internals.createDirectorAgent = originalCreateDirectorAgent;
  check("supervisor judgement uses its bounded eight-turn ceiling", supervisorTurns === SUPERVISOR_JUDGE_MAX_TURNS, String(supervisorTurns));
  check("generic director JSON calls keep the cheaper two-turn ceiling", genericTurns === 2, String(genericTurns));

  const autoTargets = mgr.directorTargets(true);
  internals.askDirectorJson = async (): Promise<unknown> => ({ key: autoTargets.find((t: { model: string }) => t.model === "gpt-smart-b")?.key });
  const smart = await mgr.autoSelectDirectorTarget();
  check("smart selection can choose a non-Claude director model", smart?.provider === "codex" && smart.model === "gpt-smart-b", JSON.stringify(smart));

  let dispatched: Record<string, unknown> | undefined;
  const fakeApi = {
    dispatch: async (input: Record<string, unknown>) => { dispatched = input; return "task-123"; },
  } as unknown as InstanceType<typeof ThreadManager>;
  const lastDispatch = (): Record<string, unknown> | undefined => dispatched;
  const outcome = await executeDirectorCliAction(
    { kind: "dispatch", title: "Fix capped dispatch", workspace, brief: "Make provider failover work." },
    fakeApi,
    {} as Scheduler,
    {} as OperatorNotes,
    [],
  );
  check("CLI bridge executes a real dispatch action", outcome.dispatchedId === "task-123" && lastDispatch()?.workspace === workspace, JSON.stringify(outcome));
  dispatched = undefined;
  const modeOutcome = await executeDirectorCliAction(
    { kind: "dispatch", title: "Carry modes", workspace, brief: "Use the selected task mode." },
    fakeApi,
    {} as Scheduler,
    {} as OperatorNotes,
    [],
    () => ({ durationMs: 8 * 3_600_000, agentCount: 3 }),
  );
  check(
    "CLI bridge carries composer task-mode defaults into full dispatch",
    modeOutcome.dispatchedId === "task-123" && lastDispatch()?.durationMs === 8 * 3_600_000 && lastDispatch()?.agentCount === 3,
    JSON.stringify(lastDispatch()),
  );
  dispatched = undefined;
  await executeDirectorCliAction(
    { kind: "dispatch", title: "Override modes", workspace, brief: "Use explicit modes.", duration: "30m", agents: 2 },
    fakeApi,
    {} as Scheduler,
    {} as OperatorNotes,
    [],
    () => ({ durationMs: 8 * 3_600_000, agentCount: 3 }),
  );
  check("explicit CLI task-mode fields override the composer defaults", lastDispatch()?.durationMs === 30 * 60_000 && lastDispatch()?.agentCount === 2, JSON.stringify(lastDispatch()));
  dispatched = undefined;
  await executeDirectorCliAction(
    { kind: "dispatch_read", title: "Read only", workspace, brief: "Read the repo.", duration: "30m", agents: 2 },
    fakeApi,
    {} as Scheduler,
    {} as OperatorNotes,
    [],
    () => ({ durationMs: 8 * 3_600_000, agentCount: 3 }),
  );
  check("CLI read-lane dispatch ignores task modes like the MCP read tool", lastDispatch()?.durationMs === undefined && lastDispatch()?.agentCount === undefined && lastDispatch()?.lane === "read", JSON.stringify(lastDispatch()));
  let reviewedId: string | undefined;
  fakeApi.autoReview = async (threadId: string) => { reviewedId = threadId; return { ok: true, state: "reviewing" }; };
  const review = await executeDirectorCliAction(
    { kind: "auto_review", threadId: "task-review-123" },
    fakeApi,
    {} as Scheduler,
    {} as OperatorNotes,
    [],
  );
  check(
    "CLI bridge can start an existing task's auto-review",
    reviewedId === "task-review-123" && review.toolName === "auto_review" && review.result?.includes("reviewing") === true,
    JSON.stringify(review),
  );
  const reply = await executeDirectorCliAction({ kind: "reply", message: "Done." }, fakeApi, {} as Scheduler, {} as OperatorNotes, []);
  check("CLI bridge returns user-facing replies without a fake tool", reply.final === "Done." && !reply.toolName, JSON.stringify(reply));
  const freshSafety = directorSafetyArgs(false);
  const resumeSafety = directorSafetyArgs(true);
  check("fresh Codex director uses the exec --sandbox flag", freshSafety.includes("--sandbox"), JSON.stringify(freshSafety));
  check("resumed Codex director avoids unsupported --sandbox", !resumeSafety.includes("--sandbox"), JSON.stringify(resumeSafety));
  check("resumed Codex director remains read-only via config", resumeSafety.includes('sandbox_mode="read-only"'), JSON.stringify(resumeSafety));

  // The real CLIs emit result then end in the same tick. The async bridge must still post the reply
  // after that end event; this is the lifecycle race the pure executeDirectorCliAction test cannot see.
  let eventHandler: ((event: Record<string, unknown>) => void) | undefined;
  let endHandler: (() => void) | undefined;
  const fakeRun = {
    finished: false, rateLimited: false, capped: false,
    onEvent(cb: (event: Record<string, unknown>) => void) { eventHandler = cb; return () => {}; },
    onEnd(cb: () => void) { endHandler = cb; },
  };
  const director = new Director(mgr, db, hub, {} as Scheduler, {} as OperatorNotes);
  const directorInternals = director as any;
  directorInternals.run = fakeRun;
  directorInternals.pending = "test";
  directorInternals.wire(fakeRun, configured[0]);
  eventHandler?.({ type: "result", subtype: "success", isError: false, structuredOutput: { kind: "reply", message: "Lifecycle reply survived." } });
  fakeRun.finished = true;
  endHandler?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  check("CLI result→end race still posts the director reply", db.listDirectorMessages(5).some((m) => m.content === "Lifecycle reply survived."));

  // A new owner message can arrive after the batch CLI flips `finished`, but before its end callback
  // reaches Director. Target selection is async, so the stale callback used to settle (and erase) the
  // new pending turn while start() was awaiting its target. Reproduce that exact ordering.
  let staleEndHandler: (() => void) | undefined;
  const staleFinishedRun = {
    finished: true, rateLimited: false, capped: false,
    onEvent() { return () => {}; },
    onEnd(cb: () => void) { staleEndHandler = cb; },
  };
  const nextRun = {
    finished: false, rateLimited: false, capped: false,
    startedWith: undefined as unknown,
    onEvent() { return () => {}; }, onEnd() {},
    start(content: unknown) { this.startedWith = content; return this; },
    stop: async () => {},
  };
  const rolloverDirector = new Director(mgr, db, hub, {} as Scheduler, {} as OperatorNotes);
  const rolloverInternals = rolloverDirector as any;
  rolloverInternals.run = staleFinishedRun;
  rolloverInternals.wire(staleFinishedRun, configured[0]);
  let releaseSelection: (() => void) | undefined;
  const selectionBlocked = new Promise<void>((resolve) => { releaseSelection = resolve; });
  rolloverInternals.chooseTarget = async () => { await selectionBlocked; return configured[0]; };
  internals.createDirectorAgent = () => nextRun;
  rolloverDirector.handleUserMessage("Do not drop this rollover message.");
  staleEndHandler?.();
  releaseSelection?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  check(
    "a finished CLI run cannot settle the next owner message",
    typeof nextRun.startedWith === "string" &&
      nextRun.startedWith.includes('<ggo_communication_policy state="on">') &&
      nextRun.startedWith.includes("Do not drop this rollover message.") &&
      rolloverInternals.pending === "Do not drop this rollover message.",
    JSON.stringify({ startedWith: nextRun.startedWith, pending: rolloverInternals.pending }),
  );
  rolloverDirector.cancelTurn();
  internals.createDirectorAgent = originalCreateDirectorAgent;

  // Once a state-changing command succeeded, a broken confirmation turn must report the successful
  // server result instead of claiming the entire turn failed and inviting a duplicate dispatch.
  const failedFollowupRun = {
    finished: false, rateLimited: false, capped: false,
    onEvent() { return () => {}; }, onEnd() {}, stop: async () => {},
  };
  directorInternals.run = failedFollowupRun;
  directorInternals.pending = "dispatch test";
  directorInternals.cliCommittedResult = "Dispatched task task-123 (\"Truthful dispatch\") in the workspace.";
  await directorInternals.handleCliResult(
    failedFollowupRun,
    configured[0],
    { type: "result", subtype: "error", isError: true, result: "unsupported resume flag" },
  );
  const latestDirector = db.listDirectorMessages(1)[0]?.content ?? "";
  check("a failed confirmation cannot overwrite a successful dispatch", latestDirector.includes("Dispatched task") && !latestDirector.includes("could not produce"), latestDirector);
} finally {
  if (internals.capSupervisor) clearInterval(internals.capSupervisor);
  db.raw.close();
  rmSync(dir, { recursive: true, force: true });
}

if (failed) {
  console.error(`\nFAIL — ${passed} passed, ${failed} failed`);
  process.exitCode = 1;
} else console.log(`\nPASS — ${passed} passed, 0 failed`);
