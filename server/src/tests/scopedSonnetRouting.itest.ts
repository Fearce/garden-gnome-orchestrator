/**
 * Integration test — scoped Sonnet routing: which Claude model a task's roles actually dispatch on.
 *
 * Owner direction, 2026-10-02: Sonnet 5.5 for well-scoped coding, Opus 5.5 for open-ended or agentic
 * work, decided by the task's own route. The assertions are about RESOLUTION on a real ThreadManager:
 *  - A well-scoped task's implementor and QA run Sonnet; its planner and the director stay on Opus.
 *  - An agentic task (investigation, goal step) stays on Opus everywhere.
 *  - Every explicit choice wins: a strict task pin, a per-role model in Settings, usage saving, and the
 *    Settings switch itself.
 *  - Auto-routed Sonnet that is not installed or whose pool is capped falls back to Opus, once noted.
 *  - The route note names the model and the reason; a tight plan can move a refinable task to Sonnet.
 *
 * WHAT IS REAL vs. STUBBED
 *  - REAL: `resolveRoute`, `implementorDispatchTarget`, `claudeTaskTarget`, `implementorModelRoster`,
 *    `refineClaudeModel`, the persisted route/matrix/settings and the real `Db` behind them.
 *  - STUBBED: only AccountManager's usage surface. No `claude` subprocess, no quota spent.
 *
 * Run:  npm run test:scoped-sonnet   (from server/)
 * Exits non-zero if any assertion fails. Self-contained: creates a throwaway DB and removes it.
 */

process.env.CAP_RETRY_MS = "0";
process.env.ACCOUNT_PING_MS = "3600000";
process.env.FAST_ACCOUNT_PING_MS = "3600000";
process.env.ACCOUNT_1_TOKEN = "test-token-1";
process.env.ACCOUNT_1_ID = "acct1";
process.env.ACCOUNT_1_LABEL = "Sub One";
for (let i = 2; i <= 8; i++) process.env[`ACCOUNT_${i}_TOKEN`] = "";

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountManager } from "../accounts/accountManager.js";
import type { ModelOverrides, ModelRequest, PlanOutput, RouteDecision, ThreadLane } from "../types.js";

const { Db } = await import("../db/db.js");
const { EventHub } = await import("../events.js");
const { FileMemoryService } = await import("../memory/memory.js");
const { ThreadManager } = await import("../orchestrator/threadManager.js");
const { fallbackModelFor } = await import("../config.js");

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

const SONNET = "claude-sonnet-5-5";
const OPUS = "claude-opus-5-5";
const ROSTER = [OPUS, SONNET, "claude-fable-5-1", "claude-sonnet-5", "claude-haiku-4-5-20251001"];

const SCOPED_BRIEF = "Fix the typo 'recieve' in README.md.";
const AGENTIC_BRIEF = "Investigate why QA keeps timing out on the overlay repo and figure out the root cause.";

/** Models whose own pool the stub reports as capped. */
const limited = new Set<string>();
let stubSevenDay = 0;
/** The second subscription's weekly meter; dispatch always picks acct1. */
let stubOtherSevenDay = 0;

class StubAccounts {
  onUsageRefresh(_cb: () => void): void {}
  effectiveUtilization(): number | null { return 0; }
  soonestResetAt(): number | null { return null; }
  hasHeadroom(): boolean { return true; }
  isModelLimited(_accountId: string, model: string): boolean { return limited.has(model); }
  dispatchPreview(): Record<string, unknown> {
    return {
      account: { id: "acct1", label: "Sub One" },
      hasHeadroom: true,
      fiveHour: 0,
      fiveHourReset: null,
      sevenDay: 0,
      sevenDayReset: null,
      weeklySafetyPct: 100,
    };
  }
  auxToken(): string | undefined { return undefined; }
  setPingInterval(_ms: number): void {}
  applyEnabled(_id: string, _enabled: boolean): void {}
  applyWeeklySafetyPct(_id: string, _pct: number): void {}
  setSpreadUsage(_on: boolean): void {}
  setProfileToken(_id: string, _token: string): void {}
  dto(): unknown[] {
    return [
      { id: "acct1", label: "Sub One", enabled: true, fiveHour: 0, sevenDay: stubSevenDay, sevenDayReset: null },
      { id: "acct2", label: "Sub Two", enabled: true, fiveHour: 0, sevenDay: stubOtherSevenDay, sevenDayReset: null },
    ];
  }
}

interface Harness {
  db: InstanceType<typeof Db>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  internals: any;
  workspace: string;
  dispose(): void;
}

function makeHarness(overrides: ModelOverrides = {}, roster: readonly string[] = ROSTER): Harness {
  const dir = mkdtempSync(join(tmpdir(), "scoped-sonnet-"));
  const workspace = join(dir, "workspace");
  mkdirSync(workspace, { recursive: true });
  const db = new Db(join(dir, "orchestrator.sqlite"));
  db.kvSet("setting_model_overrides", JSON.stringify(overrides));
  db.kvSet("cache_claude_models", JSON.stringify(roster));
  const hub = new EventHub();
  const memory = new FileMemoryService(join(dir, "memory"));
  const mgr = new ThreadManager(db, hub, memory, new StubAccounts() as unknown as AccountManager);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = mgr as any;
  return {
    db,
    internals,
    workspace,
    dispose() {
      if (internals.capSupervisor) clearInterval(internals.capSupervisor);
      if (internals.tokenResumeTimer) clearTimeout(internals.tokenResumeTimer);
      db.raw.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

interface TaskOpts {
  brief?: string;
  lane?: ThreadLane;
  modelRequest?: ModelRequest;
  goalStep?: boolean;
}

/** A task routed exactly as runPipeline routes it, returning its id and persisted route. */
function routedTask(h: Harness, opts: TaskOpts = {}): { id: string; route: RouteDecision } {
  const thread = h.db.createThread({
    title: "Task",
    workspace: h.workspace,
    rawPrompt: "",
    brief: opts.brief ?? SCOPED_BRIEF,
    lane: opts.lane ?? null,
    modelRequest: opts.modelRequest ?? null,
  });
  if (opts.goalStep) h.db.updateThreadStageOutputs(thread.id, { skipQa: true });
  const route = h.internals.resolveRoute(h.db.getThread(thread.id), h.internals.settings()) as RouteDecision;
  return { id: thread.id, route };
}

const implementorModel = (h: Harness, id: string): string => h.internals.implementorDispatchTarget(id, "claude", "acct1").model;
const roleModel = (h: Harness, id: string, role: string): string => h.internals.claudeTaskTarget(id, "acct1", role).model;
const notes = (h: Harness, id: string): string[] => h.db.listMessages(id).filter((m) => m.kind === "system").map((m) => m.content);
const fallbackFindings = (h: Harness, id: string) => h.db.listFindings(id).filter((f) => /Sonnet unavailable/.test(f.summary));
const claudeRoster = (h: Harness, id: string): string[] =>
  (h.internals.implementorModelRoster(undefined, { threadId: id }) as Array<{ provider: string; model: string }>)
    .filter((c) => c.provider === "claude")
    .map((c) => c.model);

console.log("\n=== scoped sonnet — a well-scoped task ===\n");
{
  const h = makeHarness();
  try {
    const { id, route } = routedTask(h);
    check("the route judges the typo fix well-scoped", route.claudeModel?.tier === "sonnet", JSON.stringify(route.claudeModel));
    check("its implementor dispatches on Sonnet 5.5", implementorModel(h, id) === SONNET, implementorModel(h, id));
    check("its QA runs on Sonnet 5.5", roleModel(h, id, "qa") === SONNET, roleModel(h, id, "qa"));
    check(
      "the planner and director stay on Opus",
      roleModel(h, id, "planner") === OPUS && roleModel(h, id, "director") === OPUS,
      `${roleModel(h, id, "planner")}/${roleModel(h, id, "director")}`,
    );
    check("auto-selection offers only Opus beside the deterministic Sonnet route", claudeRoster(h, id).includes(OPUS) && !claudeRoster(h, id).includes(SONNET), JSON.stringify(claudeRoster(h, id)));
    const note = notes(h, id).find((content) => content.startsWith("🧭 Route selected"));
    check(
      "the route note names Sonnet 5.5 and why",
      !!note && note.includes(`Claude model: ${SONNET} — narrow, contained change`),
      note,
    );
    check(
      "a Sonnet auto-pick for this task stays Sonnet",
      h.internals.claudePickedModel(id, "acct1", SONNET) === SONNET && h.internals.isScopedSonnetPick(id, { provider: "claude", model: SONNET }),
    );
    check("no fallback was noted", fallbackFindings(h, id).length === 0);
  } finally {
    h.dispose();
  }
}

console.log("\n=== scoped sonnet — agentic work stays on Opus ===\n");
{
  const h = makeHarness();
  try {
    const { id, route } = routedTask(h, { brief: AGENTIC_BRIEF });
    check("the investigation is routed to Opus", route.claudeModel?.tier === "opus", JSON.stringify(route.claudeModel));
    check("its implementor dispatches on Opus 5.5", implementorModel(h, id) === OPUS, implementorModel(h, id));
    check("its QA runs on Opus 5.5", roleModel(h, id, "qa") === OPUS, roleModel(h, id, "qa"));
    check("the automatic roster excludes Sonnet before task capability filtering", !claudeRoster(h, id).includes(SONNET), JSON.stringify(claudeRoster(h, id)));
    check(
      "adaptive picks can choose Sonnet while configured agentic defaults stay Opus",
      h.internals.claudePickedModel(id, "acct1", SONNET) === SONNET && !h.internals.isScopedSonnetPick(id, { provider: "claude", model: SONNET }),
    );
    const note = notes(h, id).find((content) => content.startsWith("🧭 Route selected"));
    check("the route note names Opus and why", !!note && note.includes(`Claude model: ${OPUS} — open-ended investigation`), note);

    const goal = routedTask(h, { goalStep: true });
    check("a goal step stays on Opus however small its brief", goal.route.claudeModel?.tier === "opus" && implementorModel(h, goal.id) === OPUS, implementorModel(h, goal.id));
    check("a goal step skips QA as before", goal.route.useQa === false);

    const lead = h.db.createThread({ title: "Split", workspace: h.workspace, rawPrompt: "", brief: "Split work.", agentCount: 2 });
    const child = h.db.createThread({
      title: "Copy",
      workspace: h.workspace,
      rawPrompt: "",
      brief: SCOPED_BRIEF,
      parentId: lead.id,
      assignment: { title: "Copy", objective: SCOPED_BRIEF, files: ["README.md"] },
    });
    const childRoute = h.internals.resolveRoute(h.db.getThread(child.id), h.internals.settings()) as RouteDecision;
    check("a shotgun collaborator with a narrow slice stays on Opus", childRoute.claudeModel?.tier === "opus" && implementorModel(h, child.id) === OPUS, JSON.stringify(childRoute.claudeModel));
  } finally {
    h.dispose();
  }
}

console.log("\n=== scoped sonnet — explicit choices win ===\n");
{
  const h = makeHarness();
  try {
    const opusPin: ModelRequest = { requested: "opus 5.5", provider: "claude", model: OPUS, strict: true };
    const pinned = routedTask(h, { modelRequest: opusPin });
    check("a strict Opus pin on a scoped task runs Opus", implementorModel(h, pinned.id) === OPUS, implementorModel(h, pinned.id));
    check("…and its QA is not moved to Sonnet either", roleModel(h, pinned.id, "qa") === OPUS, roleModel(h, pinned.id, "qa"));
    check("…and the route note leaves the line to the pin", !notes(h, pinned.id).some((content) => content.includes("Claude model:")));

    const sonnetPin: ModelRequest = { requested: "sonnet 5.5", provider: "claude", model: SONNET, strict: true };
    const pinnedAgentic = routedTask(h, { brief: AGENTIC_BRIEF, modelRequest: sonnetPin });
    check("a strict Sonnet pin on agentic work runs Sonnet exactly", implementorModel(h, pinnedAgentic.id) === SONNET, implementorModel(h, pinnedAgentic.id));

    limited.add(SONNET);
    check("a strict Sonnet pin is not auto-substituted when its pool caps", implementorModel(h, pinnedAgentic.id) === SONNET, implementorModel(h, pinnedAgentic.id));
    check("…and no auto-routing fallback is noted for it", fallbackFindings(h, pinnedAgentic.id).length === 0);
    limited.clear();

    const vanilla = routedTask(h, { lane: "vanilla" });
    check("a default-mode session is never routed to Sonnet", implementorModel(h, vanilla.id) === OPUS, implementorModel(h, vanilla.id));
    check("…and its route note names no Claude line", !notes(h, vanilla.id).some((content) => content.includes("Claude model:")), JSON.stringify(notes(h, vanilla.id)));
  } finally {
    h.dispose();
  }
}
{
  const h = makeHarness({ acct1: { implementor: OPUS }, acct2: { implementor: OPUS } });
  try {
    const { id } = routedTask(h);
    check("a per-role model set in Settings wins over the route", implementorModel(h, id) === OPUS, implementorModel(h, id));
    check("…only for that role: QA left on Auto still runs Sonnet", roleModel(h, id, "qa") === SONNET, roleModel(h, id, "qa"));
    const note = notes(h, id).find((content) => content.startsWith("🧭 Route selected"));
    check("…and with it set on every sub, the route note says the setting takes precedence", !!note && note.includes("the implementor model set in Settings takes precedence"), note);
  } finally {
    h.dispose();
  }
}
{
  const h = makeHarness({ default: { qa: OPUS } });
  try {
    const { id } = routedTask(h);
    check("the composer's default layer counts as a choice too", roleModel(h, id, "qa") === OPUS && implementorModel(h, id) === SONNET);
  } finally {
    h.dispose();
  }
}
{
  const h = makeHarness();
  try {
    stubSevenDay = 95;
    stubOtherSevenDay = 95;
    const saving = { enabled: true, thresholdPct: 90, model: OPUS, effort: "medium" };
    h.db.kvSet("setting_usage_saving", JSON.stringify({ acct1: saving, acct2: saving }));
    const { id } = routedTask(h);
    check("usage saving wins over the route", implementorModel(h, id) === OPUS && roleModel(h, id, "qa") === OPUS, `${implementorModel(h, id)}/${roleModel(h, id, "qa")}`);
    const note = notes(h, id).find((content) => content.startsWith("🧭 Route selected"));
    check("…and with it on every sub, the route note says so", !!note && note.includes("usage saving takes precedence"), note);
  } finally {
    stubSevenDay = 0;
    stubOtherSevenDay = 0;
    h.dispose();
  }
}
{
  const h = makeHarness({ acct2: { implementor: OPUS } });
  try {
    stubOtherSevenDay = 95;
    h.db.kvSet("setting_usage_saving", JSON.stringify({ acct2: { enabled: true, thresholdPct: 90, model: OPUS, effort: "medium" } }));
    const { id } = routedTask(h);
    check("usage saving and a matrix model on another sub leave the dispatching sub on Sonnet", implementorModel(h, id) === SONNET, implementorModel(h, id));
    const note = notes(h, id).find((content) => content.startsWith("🧭 Route selected"));
    check(
      "…and the route note names Sonnet, with the other sub as the exception",
      !!note && note.includes(`Claude model: ${SONNET} — `) && note.includes("on a subscription under usage saving, the implementor runs Opus instead") && !note.includes("precedence"),
      note,
    );
  } finally {
    stubOtherSevenDay = 0;
    h.dispose();
  }
}
{
  const h = makeHarness();
  try {
    h.internals.setSettings({ scopedSonnetRouting: false });
    check("the Settings switch persists", h.internals.settings().scopedSonnetRouting === false);
    const { id } = routedTask(h);
    check("switched off, a scoped task runs Opus", implementorModel(h, id) === OPUS && roleModel(h, id, "qa") === OPUS);
    check("…and the route note says why", notes(h, id).some((content) => content.includes("scoped Sonnet routing is off in Settings")));
    check("…and adaptive auto-selection keeps only current Opus", claudeRoster(h, id).includes(OPUS) && !claudeRoster(h, id).includes(SONNET), JSON.stringify(claudeRoster(h, id)));
  } finally {
    h.dispose();
  }
}

console.log("\n=== scoped sonnet — fallback when Sonnet is unavailable ===\n");
check("Sonnet's pool fallback is Opus 5.5", fallbackModelFor(SONNET) === OPUS, String(fallbackModelFor(SONNET)));
{
  const h = makeHarness({}, [OPUS, "claude-sonnet-5", "claude-fable-5-1"]);
  try {
    const { id } = routedTask(h);
    check("Sonnet 5.5 missing from the roster: the implementor runs Opus", implementorModel(h, id) === OPUS, implementorModel(h, id));
    check("…and QA too", roleModel(h, id, "qa") === OPUS, roleModel(h, id, "qa"));
    check("accessible older Sonnet cannot enter adaptive selection", !claudeRoster(h, id).includes("claude-sonnet-5"), JSON.stringify(claudeRoster(h, id)));
    const findings = fallbackFindings(h, id);
    check(
      "the fallback is noted on the task, once per role",
      findings.length === 2 && findings.every((f) => /not in this installation's Claude roster/.test(f.detail ?? "")),
      JSON.stringify(findings.map((f) => f.summary)),
    );
  } finally {
    h.dispose();
  }
}
{
  const h = makeHarness();
  try {
    const { id } = routedTask(h);
    limited.add(SONNET);
    check("Sonnet's own pool capped: the implementor runs Opus", implementorModel(h, id) === OPUS, implementorModel(h, id));
    check("…an existing Sonnet auto-pick moves to Opus too", h.internals.claudePickedModel(id, "acct1", SONNET) === OPUS);
    check("…and auto-selection is offered Opus instead", claudeRoster(h, id).includes(OPUS) && !claudeRoster(h, id).includes(SONNET), JSON.stringify(claudeRoster(h, id)));
    check("…with the fallback noted", fallbackFindings(h, id).some((f) => /usage pool is capped/.test(f.detail ?? "")));
    limited.clear();
    check("once the pool frees, the task is back on Sonnet", implementorModel(h, id) === SONNET, implementorModel(h, id));
  } finally {
    limited.clear();
    h.dispose();
  }
}

console.log("\n=== scoped sonnet — the reader lane ===\n");
{
  const h = makeHarness();
  try {
    const reader = h.db.createThread({ title: "Where", workspace: h.workspace, rawPrompt: "", brief: "Where is the cap supervisor started?", lane: "read" });
    check("a read-lane lookup runs on Sonnet", roleModel(h, reader.id, "reader") === SONNET, roleModel(h, reader.id, "reader"));
    const normal = routedTask(h);
    check("the reader role outside the read lane stays Opus", roleModel(h, normal.id, "reader") === OPUS, roleModel(h, normal.id, "reader"));
  } finally {
    h.dispose();
  }
}

console.log("\n=== scoped sonnet — the planner's plan ===\n");
{
  const h = makeHarness();
  try {
    const { id, route } = routedTask(h, {
      brief: "Add a CSV export button to the board header that downloads the visible tasks with their title, state and repository columns, using the existing download helper for the file.",
    });
    check("a not-obviously-contained task starts on Opus", route.claudeModel?.tier === "opus" && route.claudeModel.planRefinable === true, JSON.stringify(route.claudeModel));
    check("…and its implementor would dispatch on Opus", implementorModel(h, id) === OPUS);
    const plan: PlanOutput = {
      summary: "Add the export.",
      steps: [
        { title: "Button", detail: "Add the button.", files: ["web/src/components/Board.tsx"] },
        { title: "Export", detail: "Build the CSV.", files: ["web/src/lib/export.ts"] },
      ],
      risks: [],
      openQuestions: [],
      effort: "medium",
    };
    h.internals.refineClaudeModel(id, plan);
    const refined = h.db.getThreadStageOutputs(id).routeDecision?.claudeModel;
    check("a tight plan moves it to Sonnet, persisted on the route", refined?.tier === "sonnet" && refined.planRefinable === false, JSON.stringify(refined));
    check("…so its implementor dispatches on Sonnet", implementorModel(h, id) === SONNET, implementorModel(h, id));
    check("…and the change is announced on the task", notes(h, id).some((content) => content.startsWith(`🧭 Claude model: ${SONNET} — the planner's plan is tight`)));
    const before = notes(h, id).length;
    h.internals.refineClaudeModel(id, { ...plan, steps: [1, 2, 3, 4, 5, 6].map((n) => ({ title: `${n}`, detail: "x", files: [`f${n}.ts`] })) });
    check("a plan is judged once: a later plan changes nothing", h.db.getThreadStageOutputs(id).routeDecision?.claudeModel?.tier === "sonnet" && notes(h, id).length === before);

    const running = routedTask(h, {
      brief: "Add a CSV export button to the board header that downloads the visible tasks with their title, state and repository columns, using the existing download helper for the file.",
    });
    h.db.createRun({ threadId: running.id, role: "implementor", model: OPUS, account: "acct1" });
    h.internals.refineClaudeModel(running.id, plan);
    check("a task already implementing keeps the line its session runs on", h.db.getThreadStageOutputs(running.id).routeDecision?.claudeModel?.tier === "opus");
  } finally {
    h.dispose();
  }
}

console.log("\n=== scoped sonnet — a route persisted before the Claude line existed ===\n");
{
  const h = makeHarness();
  try {
    const { id, route } = routedTask(h);
    const { claudeModel: _dropped, ...legacy } = route;
    h.db.updateThreadStageOutputs(id, { routeDecision: legacy });
    const backfilled = h.internals.resolveRoute(h.db.getThread(id), h.internals.settings()) as RouteDecision;
    check("an un-started task gains its Claude line", backfilled.claudeModel?.tier === "sonnet", JSON.stringify(backfilled.claudeModel));
    check("…and announces it", notes(h, id).some((content) => content.startsWith(`🧭 Claude model: ${SONNET}`)));

    const started = routedTask(h);
    const { claudeModel: _gone, ...older } = started.route;
    h.db.updateThreadStageOutputs(started.id, { routeDecision: older });
    h.db.createRun({ threadId: started.id, role: "implementor", model: OPUS, account: "acct1" });
    const kept = h.internals.resolveRoute(h.db.getThread(started.id), h.internals.settings()) as RouteDecision;
    check("a task already implementing on Opus is not moved", !kept.claudeModel && implementorModel(h, started.id) === OPUS, implementorModel(h, started.id));
  } finally {
    h.dispose();
  }
}

console.log(`\n${failed ? "❌" : "✅"} ${passed} passed, ${failed} failed`);
if (failed) {
  console.log(failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
process.exit(0);
