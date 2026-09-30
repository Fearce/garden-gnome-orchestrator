/**
 * Integration gate — the newest-in-family invariant.
 *
 * The owner saw a sub-agent running on `gpt-6-sol` while `gpt-6.1-sol` was installed. His rule: GGO never
 * runs an older model of a line (Opus, Sonnet, Sol, Luna, …) when a newer member of that line is available,
 * and a release reconfigures GGO with no manual step. A different line (Sonnet beside Opus, Luna beside
 * Sol) is a choice, never an upgrade target.
 *
 * WHAT IS REAL vs. STUBBED
 *  - REAL: `modelFamily.ts`, the strict-pin resolvers, the Db, ThreadManager's boot/catalog migration, its
 *    dispatch, retry pin gate and dispatch-target resolver, the Scheduler's fire, the GoalRunner's step
 *    dispatch, SubTaskService's spawn, and the three runner constructors.
 *  - STUBBED: AccountManager's usage surface, and the pipeline start (nothing spawns a CLI or spends quota).
 *
 * Run:  npm run test:model-family   (from server/)
 * Exits non-zero if any assertion fails. Self-contained: a throwaway DB and Codex homes, removed after.
 */

process.env.CAP_RETRY_MS = "0";
process.env.ACCOUNT_PING_MS = "3600000";
process.env.FAST_ACCOUNT_PING_MS = "3600000";
process.env.TYPESAFE_API_KEY = "";
process.env.JEV_API_KEY = "";

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Codex availability must come from this gate's seeded catalog, never from the operator's ~/.codex login.
const codexHomes = mkdtempSync(join(tmpdir(), "model-family-codex-"));
process.env.CODEX_HOME_DIR = join(codexHomes, "home");
process.env.CODEX_SOURCE_HOME = join(codexHomes, "source");

import type { AccountManager } from "../accounts/accountManager.js";
import type { GoalJudgement } from "../orchestrator/goals.js";
import type { ModelOverrides, Thread } from "../types.js";

const family = await import("../agents/modelFamily.js");
const { currentCodexModel, currentCodexModels } = await import("../agents/codexModelGeneration.js");
const { exactModelRequest, resolveModelRequest } = await import("../orchestrator/modelRequest.js");
const { claudeOpusTarget } = await import("../orchestrator/claudeOpusFloor.js");
const { applyImplementorModelPolicy } = await import("../orchestrator/modelRoutingPolicy.js");
const { conservationResolvedModel } = await import("../orchestrator/tokenConservation.js");
const { AgentRun } = await import("../agents/runner.js");
const { CodexAgentRun } = await import("../agents/codexRunner.js");
const { GrokAgentRun } = await import("../agents/grokRunner.js");
const { Db } = await import("../db/db.js");
const { EventHub } = await import("../events.js");
const { FileMemoryService } = await import("../memory/memory.js");
const { ThreadManager } = await import("../orchestrator/threadManager.js");
const { Scheduler } = await import("../orchestrator/scheduler.js");
const { GoalRunner } = await import("../orchestrator/goals.js");

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

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- 1: pure — version ordering and family detection ----------------------------------------------

function pure(): void {
  console.log("\n1 — version ordering");
  const { compareModelVersions: cmp, modelFamilyVersion: fv } = family;
  check("6.1 > 6.0", cmp([6, 1], [6, 0]) > 0);
  check("5.5 > 5.0", cmp([5, 5], [5]) > 0);
  check("a missing minor is .0 — [6] equals [6, 0]", cmp([6], [6, 0]) === 0);
  check("4.10 > 4.9 (numeric, not lexical)", cmp([4, 10], [4, 9]) > 0);
  check("7.0 > 6.9", cmp([7, 0], [6, 9]) > 0);
  check("`gpt-6-sol` reads as Sol 6.0 and `gpt-6.1-sol` as Sol 6.1", fv("gpt-6-sol")?.version.join(".") === "6.0" && fv("gpt-6.1-sol")?.version.join(".") === "6.1");
  check("`claude-opus-5` reads as 5.0 and `claude-opus-5-5` as 5.5", fv("claude-opus-5")?.version.join(".") === "5.0" && fv("claude-opus-5-5")?.version.join(".") === "5.5");
  check("an 8-digit snapshot date is not a version", fv("claude-haiku-4-5-20251001")?.version.join(".") === "4.5");
  check("a dated GPT snapshot is not a version", fv("gpt-4.1-mini-2025-04-14")?.version.join(".") === "4.1" && fv("gpt-4.1-mini-2025-04-14")?.family === "gpt-mini");

  console.log("\n2 — family detection, both providers");
  const same = family.sameModelFamily;
  check("Claude: Opus 5 and Opus 5.5 are one line", same("claude-opus-5", "claude-opus-5-5"));
  check("Claude: Sonnet 5 and Sonnet 5.5 are one line", same("claude-sonnet-5", "claude-sonnet-5-5"));
  check("Claude: pre-4 naming joins its line (claude-3-5-haiku ~ claude-haiku-4-5)", same("claude-3-5-haiku-20241022", "claude-haiku-4-5-20251001"));
  check("Claude: Sonnet is NOT Opus's line", !same("claude-sonnet-5-5", "claude-opus-5-5"));
  check("Claude: Fable is NOT Opus's line", !same("claude-fable-5-1", "claude-opus-5-5"));
  check("Codex: gpt-6 Sol and gpt-6.1 Sol are one line", same("gpt-6-sol", "gpt-6.1-sol"));
  check("Codex: Luna is NOT Sol's line", !same("gpt-6-luna", "gpt-6.1-sol"));
  check("Codex: Spark is NOT Sol's line", !same("gpt-5.3-codex-spark", "gpt-6-sol"));
  check("Codex: Astra is NOT Sol's line", !same("gpt-6-astra", "gpt-6-sol"));
  check("GLM: glm-5.3 and glm-4.7 are one line, glm-4.5-air another", same("glm-5.3", "glm-4.7") && !same("glm-4.5-air", "glm-5.3"));
  check("Grok: grok-4.6 and grok-4.10 are one line, grok-4.1-fast another", same("grok-4.6", "grok-4.10") && !same("grok-4.1-fast", "grok-4.6"));
  check("a 1M-context variant is its own line", !same("claude-opus-5-5[1m]", "claude-opus-5-5"));
  check("typed wording parses: \"GPT-6 Sol\" is the gpt-6-sol line", same("GPT-6 Sol", "gpt-6.1-sol"));
  check("typed wording parses: \"Opus 5\" is the Opus line", same("Opus 5", "claude-opus-5-5"));
  check("an unknown naming scheme is no family at all", family.modelFamilyVersion("gpt-daybreak-blue-latest") === null && family.modelFamilyVersion("opus") === null);

  console.log("\n3 — newest in family");
  const roster = ["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-sonnet-5", "gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna"];
  const newest = family.newestInFamily;
  check("gpt-6-sol → gpt-6.1-sol", newest("gpt-6-sol", roster) === "gpt-6.1-sol");
  check("claude-opus-5 → claude-opus-5-5", newest("claude-opus-5", roster) === "claude-opus-5-5");
  check("claude-sonnet-5 → claude-sonnet-5-5 (its own line, never Opus)", newest("claude-sonnet-5", roster) === "claude-sonnet-5-5");
  check("the newest member stays itself", newest("gpt-6.1-sol", roster) === "gpt-6.1-sol");
  check("a line with nothing newer stays itself (Luna)", newest("gpt-6-luna", roster) === "gpt-6-luna");
  check("never a downgrade — an id newer than the roster stays", newest("gpt-6.2-sol", roster) === "gpt-6.2-sol");
  check("never an id absent from the roster", newest("claude-haiku-4-5", roster) === "claude-haiku-4-5");
  check("the variant suffix is kept", newest("claude-opus-5[1m]", roster) === "claude-opus-5-5[1m]");
  check("typed wording resolves to the id", newest("GPT-6 Sol", roster) === "gpt-6.1-sol");
  check("a picker list drops only superseded members", family.withoutSupersededModels(roster).join() === "claude-opus-5-5,claude-sonnet-5-5,gpt-6.1-sol,gpt-6-luna");
  check("the note reads as the owner asked", family.familyUpgradeNote("gpt-6-sol", "gpt-6.1-sol") === "gpt-6-sol → gpt-6.1-sol: newer same-family model available");

  console.log("\n4 — strict pins");
  const candidates = [
    { provider: "codex" as const, model: "gpt-6.1-sol", labels: [] },
    { provider: "codex" as const, model: "gpt-6-luna", labels: [] },
    { provider: "claude" as const, model: "claude-opus-5-5", labels: [] },
    { provider: "claude" as const, model: "claude-sonnet-5-5", labels: [] },
  ];
  const exactSol = exactModelRequest("codex", "gpt-6-sol", candidates);
  check("an exact old pin upgrades within its line", exactSol.model === "gpt-6.1-sol" && exactSol.strict && exactSol.requested === "gpt-6-sol", JSON.stringify(exactSol));
  check("a typed old pin upgrades within its line", resolveModelRequest("gpt-6 Sol", candidates).model === "gpt-6.1-sol", JSON.stringify(resolveModelRequest("gpt-6 Sol", candidates)));
  check("a cross-line pin is respected exactly (Luna stays Luna)", exactModelRequest("codex", "gpt-6-luna", candidates).model === "gpt-6-luna");
  check("a cross-tier Claude pin is respected (Sonnet stays Sonnet)", exactModelRequest("claude", "claude-sonnet-5", candidates).model === "claude-sonnet-5-5");
  const astra = exactModelRequest("codex", "gpt-6-astra", candidates);
  check("strict: a line with no available member stays unresolved — no other line substitutes", astra.model === null && astra.strict, JSON.stringify(astra));

  console.log("\n5 — the other selection seams");
  check("the Opus floor lifts to the newest Opus the roster carries", claudeOpusTarget("claude-opus-5", ["claude-opus-6", "claude-opus-5-5", "claude-opus-5"]).model === "claude-opus-6");
  check("the Opus floor leaves Sonnet on its own line", claudeOpusTarget("claude-sonnet-5-5", ["claude-opus-5-5", "claude-sonnet-5-5"]).model !== "claude-sonnet-5" );
  const flagship = applyImplementorModelPolicy(
    [{ provider: "codex", model: "gpt-6.1-sol" }, { provider: "claude", model: "claude-opus-6" }],
    { tier: "flagship", preferredModel: "claude-opus-5-5" } as never,
  );
  check("the flagship policy admits a newer member of an approved line", flagship.eligible.some((c) => c.model === "claude-opus-6"), JSON.stringify(flagship.eligible));
  const staleRoute = applyImplementorModelPolicy(
    [{ provider: "codex", model: "gpt-6.1-sol" }, { provider: "claude", model: "claude-opus-5-5" }],
    { tier: "flagship", preferredModel: "claude-opus-5" } as never,
  );
  check(
    "a route stored before a release prefers its line's newest member",
    staleRoute.mode === "preferred" && staleRoute.eligible.map((c) => c.model).join() === "claude-opus-5-5",
    JSON.stringify(staleRoute),
  );
  check("pre-GPT-6 ids still map onto their GPT-6 line", currentCodexModel("gpt-5.6-sol") === "gpt-6-sol");
  check("a Codex catalog never offers both members of a line", currentCodexModels(["gpt-6-sol", "gpt-6.1-sol"]).join() === "gpt-6.1-sol");
}

// ---- the ThreadManager harness --------------------------------------------------------------------

const ACCOUNT = { id: "acct1", label: "Test sub", enabled: true, active: true, rateLimited: false, fiveHour: 10, sevenDay: 10 };
class StubAccounts {
  onUsageRefresh(_cb: () => void): void {}
  effectiveUtilization(): number | null { return null; }
  soonestResetAt(): number | null { return null; }
  hasHeadroom(): boolean { return true; }
  dto() { return [ACCOUNT]; }
  dispatchPreview() {
    return { account: { ...ACCOUNT, token: "stub" }, hasHeadroom: true, fiveHour: 10, sevenDay: 10, fiveHourReset: Date.now() + 3_600_000, sevenDayReset: Date.now() + 86_400_000, weeklySafetyPct: 100 };
  }
  setPingInterval(_ms: number): void {}
  applyEnabled(_id: string, _enabled: boolean): void {}
  applyWeeklySafetyPct(_id: string, _pct: number): void {}
  setSpreadUsage(_on: boolean): void {}
  setProfileToken(_id: string, _token: string): void {}
  isModelLimited(_id: string, _model: string): boolean { return false; }
  auxToken(): string | undefined { return undefined; }
}

const CLAUDE_CATALOG = ["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-sonnet-5", "claude-fable-5-1", "claude-haiku-4-5-20251001"];
const CODEX_CATALOG = ["gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna", "gpt-6-astra"];

/** What a pre-release installation left on disk: every kind of stored model choice, on the old member. */
const STALE_OVERRIDES: ModelOverrides = {
  acct1: { implementor: "claude-opus-5", director: "claude-sonnet-5" },
  codex: { implementor: "gpt-6-sol", director: "gpt-6-sol", qa: "gpt-6-luna" },
};

interface Harness {
  mgr: InstanceType<typeof ThreadManager>;
  db: InstanceType<typeof Db>;
  hub: InstanceType<typeof EventHub>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  internals: any;
  workspace: string;
  logs: string[];
  dispose(): Promise<void>;
}

function makeHarness(seed: (db: InstanceType<typeof Db>, workspace: string) => void = () => {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "model-family-"));
  const workspace = join(dir, "workspace");
  mkdirSync(workspace, { recursive: true });
  const db = new Db(join(dir, "orchestrator.sqlite"));
  db.kvSet("cache_claude_models", JSON.stringify(CLAUDE_CATALOG));
  db.kvSet("cache_codex_models", JSON.stringify(CODEX_CATALOG));
  db.kvSet("openai_api_key", "sk-test-model-family");
  db.kvSet("setting_codex_enabled", "1");
  seed(db, workspace);
  const hub = new EventHub();
  const logs: string[] = [];
  hub.subscribe((event) => {
    if (event.type === "log") logs.push(String((event as { message?: unknown }).message ?? ""));
  });
  const memory = new FileMemoryService(join(dir, "memory"));
  const mgr = new ThreadManager(db, hub, memory, new StubAccounts() as unknown as AccountManager);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = mgr as any;
  internals.startPipeline = (): void => {};
  internals.enqueueOrRun = (): void => {};
  return {
    mgr,
    db,
    hub,
    internals,
    workspace,
    logs,
    async dispose() {
      await tick(30);
      if (internals.capSupervisor) clearInterval(internals.capSupervisor);
      if (internals.tokenResumeTimer) clearTimeout(internals.tokenResumeTimer);
      if (internals.capResumeWake) clearTimeout(internals.capResumeWake);
      family.setModelFamilyRoster(null);
      db.raw.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const findingsFor = (h: Harness, threadId: string): string[] => h.db.listFindings(threadId).map((finding) => finding.summary);
const overrides = (h: Harness): ModelOverrides => JSON.parse(h.db.kvGet("setting_model_overrides") ?? "{}") as ModelOverrides;

// ---- 6: stored state migrates at boot -------------------------------------------------------------

async function bootMigration(): Promise<void> {
  console.log("\n6 — stored state moves to the newest member at boot");
  const ids: Record<string, string> = {};
  const h = makeHarness((db, workspace) => {
    db.kvSet("setting_model_overrides", JSON.stringify(STALE_OVERRIDES));
    db.kvSet("setting_usage_saving", JSON.stringify({ codex: { enabled: true, thresholdPct: 90, model: "gpt-6-sol", effort: "high" } }));
    db.kvSet("setting_codex_model", "gpt-6-sol");
    ids.schedule = db.createScheduledTask({ title: "nightly", workspace, prompt: "p", cron: "0 3 * * *", enabled: true, model: "gpt-6-sol", provider: "codex" }).id;
    ids.crossSchedule = db.createScheduledTask({ title: "luna", workspace, prompt: "p", cron: "0 4 * * *", enabled: true, model: "gpt-6-luna", provider: "codex" }).id;
    const goal = db.createGoal({ title: "g", objective: "o", workspace, effort: null, provider: "claude", model: "claude-opus-5", maxConcurrent: 1, burnConservation: false, burnRatePct: 100 });
    ids.goal = goal.id;
    ids.openStep = db.createGoalStep({ goalId: goal.id, title: "open", provider: "codex", model: "gpt-6-sol", effort: null, rationale: "r", brief: "b" }).id;
    ids.settledStep = db.createGoalStep({ goalId: goal.id, title: "settled", provider: "codex", model: "gpt-6-sol", effort: null, rationale: "r", brief: "b" }).id;
    db.raw.prepare("UPDATE goal_steps SET settled_at = ? WHERE id = ?").run(Date.now(), ids.settledStep);
    ids.cowork = db.createCoworkSession({ name: "c", autoNamed: false, workspace, requestedProvider: "codex", requestedModel: "gpt-6-sol" }).id;
    const open = db.createThread({ title: "open pin", workspace, rawPrompt: "x", modelRequest: { requested: "gpt-6-sol", provider: "codex", model: "gpt-6-sol", strict: true } });
    ids.open = open.id;
    db.updateThread(open.id, { state: "failed" });
    const done = db.createThread({ title: "done pin", workspace, rawPrompt: "x", modelRequest: { requested: "gpt-6-sol", provider: "codex", model: "gpt-6-sol", strict: true } });
    ids.done = done.id;
    db.updateThread(done.id, { state: "done" });
    const picked = db.createThread({ title: "auto pick", workspace, rawPrompt: "x" });
    ids.picked = picked.id;
    db.updateThreadStageOutputs(picked.id, { modelPick: { provider: "claude", model: "claude-opus-5", effort: "high", reason: "r" } });
  });
  try {
    const o = overrides(h);
    check("the role matrix moves: Codex Sol 6.0 → 6.1", o.codex?.implementor === "gpt-6.1-sol" && o.codex?.director === "gpt-6.1-sol", JSON.stringify(o.codex));
    check("the role matrix moves: Opus 5 → 5.5 and Sonnet 5 → Sonnet 5.5", o.acct1?.implementor === "claude-opus-5-5" && o.acct1?.director === "claude-sonnet-5-5", JSON.stringify(o.acct1));
    check("a cross-line role pick is untouched (Luna stays Luna)", o.codex?.qa === "gpt-6-luna");
    check("usage saving moves", JSON.parse(h.db.kvGet("setting_usage_saving") ?? "{}").codex?.model === "gpt-6.1-sol", h.db.kvGet("setting_usage_saving") ?? "");
    check("the legacy Codex model key moves", h.db.kvGet("setting_codex_model") === "gpt-6.1-sol");
    check("a scheduled task moves", h.db.getScheduledTask(ids.schedule!)?.model === "gpt-6.1-sol");
    check("a cross-line scheduled task is untouched", h.db.getScheduledTask(ids.crossSchedule!)?.model === "gpt-6-luna");
    check("a goal's pin moves", h.db.getGoal(ids.goal!)?.model === "claude-opus-5-5");
    const steps = h.db.listGoalSteps(ids.goal!);
    check("an open goal step moves", steps.find((s) => s.id === ids.openStep)?.model === "gpt-6.1-sol");
    check("a settled goal step stays history", steps.find((s) => s.id === ids.settledStep)?.model === "gpt-6-sol");
    check("a Co-work session's pin moves", h.db.getCoworkSession(ids.cowork!)?.requestedModel === "gpt-6.1-sol");
    const open = h.db.getThread(ids.open!);
    check("an open task's strict pin moves, still strict", open?.modelRequest?.model === "gpt-6.1-sol" && open.modelRequest.strict, JSON.stringify(open?.modelRequest));
    check("…and says so in the task's own history", findingsFor(h, ids.open!).some((s) => s.includes("gpt-6-sol → gpt-6.1-sol: newer same-family model available")), JSON.stringify(findingsFor(h, ids.open!)));
    check("a finished task stays history", h.db.getThread(ids.done!)?.modelRequest?.model === "gpt-6-sol");
    check("an auto-pick moves", h.db.getThreadStageOutputs(ids.picked!).modelPick?.model === "claude-opus-5-5");
    check("the Settings pickers offer no superseded member", !(h.internals.settings().claudeModels as string[]).includes("claude-opus-5") && !(h.internals.settings().codexModels as string[]).includes("gpt-6-sol"), JSON.stringify(h.internals.settings().codexModels));
    const reboot = h.logs.length;
    h.internals.migrateSupersededModels();
    check("the migration is idempotent (a second pass changes nothing)", h.logs.length === reboot && h.db.getThread(ids.open!)?.modelRequest?.model === "gpt-6.1-sol");
    h.mgr.setSettings({ modelOverrides: { ...overrides(h), codex: { ...overrides(h).codex, planner: "gpt-6-sol" } } } as never);
    check("a settings patch naming an old member is stored as the newest", overrides(h).codex?.planner === "gpt-6.1-sol", JSON.stringify(overrides(h).codex));
  } finally {
    await h.dispose();
  }
}

// ---- 7: every spawn path goes through the guard ----------------------------------------------------

async function spawnPaths(): Promise<void> {
  console.log("\n7 — every spawn path");
  const h = makeHarness();
  try {
    // Task dispatch (the Director, the composer, the API).
    const typed = await h.mgr.dispatch({ title: "typed", workspace: h.workspace, brief: "b", requestedModel: "gpt-6 Sol" });
    const typedThread = h.db.getThread(typed)!;
    check("task dispatch: a typed old pin lands on the newest member", typedThread.modelRequest?.model === "gpt-6.1-sol" && typedThread.modelRequest.provider === "codex", JSON.stringify(typedThread.modelRequest));
    check("task dispatch: the upgrade is logged in the task history", findingsFor(h, typed).some((s) => s.includes("gpt-6 Sol → gpt-6.1-sol: newer same-family model available")), JSON.stringify(findingsFor(h, typed)));
    const sonnet = await h.mgr.dispatch({ title: "sonnet", workspace: h.workspace, brief: "b", requestedProvider: "claude", requestedModel: "claude-sonnet-5" });
    check("task dispatch: a cross-tier Claude pin stays on its tier (Sonnet 5.5, not Opus)", h.db.getThread(sonnet)?.modelRequest?.model === "claude-sonnet-5-5", JSON.stringify(h.db.getThread(sonnet)?.modelRequest));
    const luna = await h.mgr.dispatch({ title: "luna", workspace: h.workspace, brief: "b", requestedProvider: "codex", requestedModel: "gpt-6-luna" });
    check("task dispatch: a cross-line Codex pin is respected exactly", h.db.getThread(luna)?.modelRequest?.model === "gpt-6-luna");

    // Scheduled fire: a row written after boot (an old console, a restore) still fires on the newest.
    const scheduler = new Scheduler(h.db, h.hub, (input) => h.mgr.dispatch(input));
    const schedule = h.db.createScheduledTask({ title: "fire", workspace: h.workspace, prompt: "p", cron: "0 3 * * *", enabled: true, model: "gpt-6-sol", provider: "codex" });
    await scheduler.runNow(schedule.id);
    const fired = h.db.getScheduledTask(schedule.id)?.lastThreadId;
    check("scheduled fire: the task it dispatches runs the newest member", !!fired && h.db.getThread(fired)?.modelRequest?.model === "gpt-6.1-sol", JSON.stringify(fired && h.db.getThread(fired)?.modelRequest));

    // Goal step: the real GoalRunner step dispatch, on a goal pinned to the old member.
    const goals = new GoalRunner(h.db, h.hub, {
      dispatch: (input) => h.mgr.dispatch(input),
      judge: async () => { throw new Error("not judged in this gate"); },
      roster: () => h.mgr.goalModelRoster(),
    }, { ownerName: "Owner" });
    check("goal roster: offers no superseded member", !h.mgr.goalModelRoster().some((c) => c.model === "gpt-6-sol" || c.model === "claude-opus-5"), JSON.stringify(h.mgr.goalModelRoster().map((c) => c.model)));
    const goal = h.db.createGoal({ title: "goal", objective: "o", workspace: h.workspace, effort: "medium", provider: "codex", model: "gpt-6-sol", maxConcurrent: 1, burnConservation: false, burnRatePct: 100 });
    const judgement: GoalJudgement = {
      verdict: "continue",
      reason: "r",
      progress: "p",
      next: { title: "step", brief: "do it", provider: "codex", model: "gpt-6-sol", effort: "medium", rationale: "r" },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (goals as any).dispatchStep(goal, judgement, false, { roster: h.mgr.goalModelRoster(), over: [], hold: null }, []);
    const step = h.db.listGoalSteps(goal.id)[0];
    check("goal step: the step itself records the newest member", step?.model === "gpt-6.1-sol", String(step?.model));
    check("goal step: the step's task runs the newest member",!!step?.threadId && h.db.getThread(step.threadId)?.modelRequest?.model === "gpt-6.1-sol", JSON.stringify(step?.threadId && h.db.getThread(step.threadId)?.modelRequest));

    // Retry / resume: a pin persisted before a release moves when the task next starts.
    const old = h.db.createThread({ title: "retry", workspace: h.workspace, rawPrompt: "x", modelRequest: { requested: "gpt-6-sol", provider: "codex", model: "gpt-6-sol", strict: true } });
    h.db.raw.prepare("UPDATE threads SET model_request = ? WHERE id = ?").run(JSON.stringify({ requested: "gpt-6-sol", provider: "codex", model: "gpt-6-sol", strict: true }), old.id);
    check("retry: the dispatch target resolves the old pin to the newest", h.internals.implementorDispatchTarget(old.id, "codex").model === "gpt-6.1-sol", JSON.stringify(h.internals.implementorDispatchTarget(old.id, "codex")));
    const gated = h.internals.ensureThreadModelRequest(h.db.getThread(old.id)!) as Thread;
    check("retry: the start/resume pin gate persists the newest member", gated.modelRequest?.model === "gpt-6.1-sol" && h.db.getThread(old.id)?.modelRequest?.model === "gpt-6.1-sol");
    check("retry: …and logs it in the task history", findingsFor(h, old.id).some((s) => s.includes("gpt-6-sol → gpt-6.1-sol")), JSON.stringify(findingsFor(h, old.id)));

    // Director / agent sub-agent: spawn_subagent.
    const parentId = await h.mgr.dispatch({ title: "parent", workspace: h.workspace, brief: "the parent job" });
    h.internals.setState(parentId, "implementing");
    const roster = h.mgr.subTasks.roster();
    const claudeModels = roster.find((p) => p.provider === "claude")?.models.map((m) => m.id) ?? [];
    const codexModels = roster.find((p) => p.provider === "codex")?.models.map((m) => m.id) ?? [];
    check("sub-agent roster: Sonnet is offered", claudeModels.includes("claude-sonnet-5-5"), JSON.stringify(claudeModels));
    check("sub-agent roster: no superseded member is offered", !claudeModels.includes("claude-sonnet-5") && !claudeModels.includes("claude-opus-5") && !codexModels.includes("gpt-6-sol"), JSON.stringify({ claudeModels, codexModels }));
    const spawned = await h.mgr.subTasks.spawn({ threadId: parentId, role: "implementor", runId: null }, { provider: "codex", model: "gpt-6-sol", title: "review", brief: "review the diff" });
    check("sub-agent: an old model is spawned on the newest member", spawned.ok && spawned.thread?.subTask?.model === "gpt-6.1-sol" && spawned.thread.modelRequest?.model === "gpt-6.1-sol", spawned.message);
    check("sub-agent: the spawner is told why", spawned.message.includes("gpt-6-sol → gpt-6.1-sol: newer same-family model available"), spawned.message);
    const sonnetChild = await h.mgr.subTasks.spawn({ threadId: parentId, role: "implementor", runId: null }, { provider: "claude", model: "claude-sonnet-5-5", title: "cheap", brief: "mechanical job" });
    check("sub-agent: a Sonnet sub-agent can be spawned", sonnetChild.ok && sonnetChild.thread?.modelRequest?.model === "claude-sonnet-5-5", sonnetChild.message);

    // The runners themselves: the last line, whichever path chose the model.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cfgModel = (run: unknown): string => (run as any).cfg.model;
    check("runner: AgentRun never starts a superseded Claude model", cfgModel(new AgentRun({ model: "claude-opus-5", cwd: h.workspace })) === "claude-opus-5-5");
    check("runner: CodexAgentRun never starts a superseded Codex model", cfgModel(new CodexAgentRun({ model: "gpt-6-sol", effort: "high", cwd: h.workspace, apiKey: "" })) === "gpt-6.1-sol");
    check("runner: a cross-line model passes through", cfgModel(new CodexAgentRun({ model: "gpt-6-luna", effort: "high", cwd: h.workspace, apiKey: "" })) === "gpt-6-luna");
    check("runner: GrokAgentRun resolves through the same roster", cfgModel(new GrokAgentRun({ model: "grok-4.7", effort: "high", cwd: h.workspace } as never)) === family.latestFamilyModel("grok-4.7"));
  } finally {
    await h.dispose();
  }
}

// ---- 8: a new release is picked up with no code change ---------------------------------------------

async function newRelease(): Promise<void> {
  console.log("\n8 — a simulated release");
  const h = makeHarness((db, workspace) => {
    db.kvSet("setting_model_overrides", JSON.stringify({ codex: { implementor: "gpt-6.1-sol" }, acct1: { implementor: "claude-opus-5-5" } }));
    db.createScheduledTask({ title: "nightly", workspace, prompt: "p", cron: "0 3 * * *", enabled: true, model: "gpt-6.1-sol", provider: "codex" });
  });
  try {
    check("before the release, 6.1 is the newest Sol", family.latestFamilyModel("gpt-6-sol") === "gpt-6.1-sol");
    // The catalog refresh writes the new list, exactly as ModelCatalog.storeIfChanged does.
    h.db.kvSet("cache_codex_models", JSON.stringify(["gpt-6.2-sol", ...CODEX_CATALOG]));
    h.db.kvSet("cache_claude_models", JSON.stringify(["claude-opus-6", ...CLAUDE_CATALOG]));
    check("resolution follows the catalog at once — no restart, no invalidation call", family.latestFamilyModel("gpt-6.1-sol") === "gpt-6.2-sol" && family.latestFamilyModel("claude-opus-5-5") === "claude-opus-6");
    check("a role resolves onto the release", h.internals.providerRoleModel("codex", "implementor") === "gpt-6.2-sol" && h.internals.modelFor("acct1", "implementor") === "claude-opus-6", `${h.internals.providerRoleModel("codex", "implementor")} / ${h.internals.modelFor("acct1", "implementor")}`);
    check("the pickers swap the old member for the release", (h.internals.settings().codexModels as string[]).includes("gpt-6.2-sol") && !(h.internals.settings().codexModels as string[]).includes("gpt-6.1-sol"), JSON.stringify(h.internals.settings().codexModels));
    // The catalog's change callback reconfigures stored state.
    h.internals.onModelCatalogChanged();
    check("stored settings are rewritten to the release", overrides(h).codex?.implementor === "gpt-6.2-sol" && overrides(h).acct1?.implementor === "claude-opus-6", JSON.stringify(overrides(h)));
    check("a stored schedule is rewritten to the release", h.db.listScheduledTasks()[0]?.model === "gpt-6.2-sol");
    h.db.kvSet("cache_codex_models", JSON.stringify(["gpt-6.1-luna", "gpt-6.2-sol", ...CODEX_CATALOG]));
    const conserving = { usedPct: 99, resetAt: null };
    check("token conservation lowers a flagship onto the newest economy member", conservationResolvedModel("codex", "gpt-6.2-sol", conserving, Date.now()) === "gpt-6.1-luna", conservationResolvedModel("codex", "gpt-6.2-sol", conserving, Date.now()));
    check("token conservation keeps a newer economy release as economy", conservationResolvedModel("codex", "gpt-6.1-luna", conserving, Date.now()) === "gpt-6.1-luna");
    const pinned = await h.mgr.dispatch({ title: "pin", workspace: h.workspace, brief: "b", requestedProvider: "codex", requestedModel: "gpt-6-sol" });
    check("a new pin to any older Sol lands on the release", h.db.getThread(pinned)?.modelRequest?.model === "gpt-6.2-sol");
  } finally {
    await h.dispose();
  }
}

async function main(): Promise<void> {
  console.log("\n=== newest-in-family invariant ===");
  pure();
  await bootMigration();
  await spawnPaths();
  await newRelease();
  console.log(`\n${failed ? "FAIL" : "PASS"} — ${passed} passed, ${failed} failed`);
  if (failed) {
    for (const failure of failures) console.log(`  - ${failure}`);
  }
  rmSync(codexHomes, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
