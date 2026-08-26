/**
 * Integration test — auto model selection is actually WIRED into the pipeline (real ThreadManager, real Db).
 *
 * The pure halves (reply validation, the score) are covered by `test:model-select`. What can only break
 * here is the wiring: a pick that is made but never reaches the spawn, an effort the operator pinned that
 * a pick silently overrides, a task that runs on a backend the pick named after that backend went away, or
 * a settled task that never gets graded — each of which typechecks perfectly and makes the feature a
 * no-op or a hazard.
 *
 * WHAT IS REAL vs. STUBBED
 *  - REAL: `autoSelectModel` (its roster, its persistence, its grade record), `pickedModel`,
 *    `implementorEffort`, `routeForPick`, `startImplementor`'s model/effort resolution, `setState`'s
 *    grading hook, and the real Db behind all of them.
 *  - STUBBED: the network (a canned Anthropic reply — no token, no quota) and `wireRun`, which is the
 *    last thing `startImplementor` does BEFORE spawning the CLI. Throwing there stops the run at exactly
 *    the point where the `agent_runs` row (model + effort) exists but nothing has been spawned, which is
 *    the only assertion this test needs from that method.
 *
 * Run:  npm run test:auto-model   (from server/)   — or:  npx tsx src/tests/autoModelSelection.itest.ts
 * Exits non-zero if any assertion fails. Self-contained: throwaway DB + workspace, removed at the end.
 */

process.env.CAP_RETRY_MS = "0";
process.env.ACCOUNT_PING_MS = "3600000";
process.env.FAST_ACCOUNT_PING_MS = "3600000";

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountManager } from "../accounts/accountManager.js";
import type { ImplementorProvider, ModelPick, Thread } from "../types.js";

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

class StubAccounts {
  onUsageRefresh(_cb: () => void): void {}
  effectiveUtilization(): number | null {
    return null;
  }
  soonestResetAt(): number | null {
    return null;
  }
  hasHeadroom(): boolean {
    return true;
  }
  setPingInterval(_ms: number): void {}
  applyEnabled(_id: string, _enabled: boolean): void {}
  applyWeeklySafetyPct(_id: string, _pct: number): void {}
  setSpreadUsage(_on: boolean): void {}
  isModelLimited(_id: string, _model: string): boolean {
    return false;
  }
  auxToken(): string | undefined {
    return "stub-token";
  }
  select(): { account: { id: string; label: string; token: string } } {
    return { account: { id: "acct-a", label: "account a", token: "stub-token" } };
  }
  dispatchPreview(): Record<string, unknown> {
    return {
      account: { id: "acct-a", label: "account a", token: "stub-token" },
      hasHeadroom: true,
      fiveHour: 10,
      sevenDay: 10,
      fiveHourReset: Date.now() + 3_600_000,
      sevenDayReset: Date.now() + 86_400_000,
      weeklySafetyPct: 100,
    };
  }
}

const WIRE_SENTINEL = "stopped before spawn";

interface Harness {
  mgr: InstanceType<typeof ThreadManager>;
  db: InstanceType<typeof Db>;
  workspace: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  internals: any;
  calls: () => number;
  reply(...replies: string[]): void;
  seed(): string;
  dispose(): void;
}

const realFetch = globalThis.fetch;

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "auto-model-"));
  const workspace = join(dir, "workspace");
  mkdirSync(workspace, { recursive: true });
  const db = new Db(join(dir, "orchestrator.sqlite"));
  const hub = new EventHub();
  const memory = new FileMemoryService(join(dir, "memory"));
  const mgr = new ThreadManager(db, hub, memory, new StubAccounts() as unknown as AccountManager);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = mgr as any;
  internals.wireRun = (): never => {
    throw new Error(WIRE_SENTINEL);
  };
  internals.officeCheckIn = (): void => {};
  internals.ensureGroup = (): void => {};

  let calls = 0;
  let queue: string[] = [];
  globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    // Only the selection call is answered; anything else this process might reach for (the voice-gateway
    // probe on a `done` settle) must look offline rather than be handed a model reply.
    if (!String(url).includes("api.anthropic.com")) throw new Error("offline in test");
    void init;
    calls++;
    const text = queue.shift() ?? "";
    return { status: 200, json: async () => ({ content: [{ type: "text", text }] }), text: async () => "" } as unknown as Response;
  }) as typeof fetch;

  return {
    mgr,
    db,
    workspace,
    internals,
    calls: () => calls,
    reply(...replies) {
      queue = [...replies];
      calls = 0;
    },
    seed() {
      const t = db.createThread({ title: "add a dark-mode toggle", workspace, rawPrompt: "add a dark mode toggle please" });
      db.updateThreadStageOutputs(t.id, { kickoff: "KICKOFF: mock", planDone: true, approved: true });
      return t.id;
    },
    dispose() {
      if (internals.capSupervisor) clearInterval(internals.capSupervisor);
      db.raw.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const HAIKU = "claude-haiku-4-5-20251001";
const pickReply = (model: string, effort = "low"): string => `{"model":"${model}","effort":"${effort}","reason":"small, well-scoped edit"}`;
const thread = (h: Harness, id: string): Thread => h.db.getThread(id)!;

async function main(): Promise<void> {
  console.log("\n=== auto model selection — pipeline wiring (real machinery) ===\n");

  // -- A: off by default — the feature costs nothing until it's switched on ---------------------------
  console.log("Test A — the setting is off by default and nothing is spent");
  {
    const h = makeHarness();
    try {
      check("default is off", h.mgr.settings().autoModelSelection === false, String(h.mgr.settings().autoModelSelection));
      const id = h.seed();
      h.reply(pickReply(HAIKU));
      const pick = await h.internals.autoSelectModel(thread(h, id));
      check("no pick is made", pick === undefined, JSON.stringify(pick));
      check("no model call is paid for", h.calls() === 0, String(h.calls()));
      check("nothing is persisted on the task", h.db.getThreadStageOutputs(id).modelPick === undefined, JSON.stringify(h.db.getThreadStageOutputs(id).modelPick));
      check("no grade record is opened", h.db.getModelGrade(id) === null, "a record appeared");
    } finally {
      h.dispose();
    }
  }

  // -- B: on — the pick is made once, persisted, and recorded for grading -----------------------------
  console.log("\nTest B — switched on: one pick, persisted, with its grade record opened");
  {
    const h = makeHarness();
    try {
      h.mgr.setSettings({ autoModelSelection: true });
      const id = h.seed();
      h.reply(pickReply(HAIKU));
      const pick = (await h.internals.autoSelectModel(thread(h, id), { summary: "one component", steps: [], risks: [], openQuestions: [], effort: "max" })) as ModelPick;
      check("a pick comes back", pick?.model === HAIKU && pick.effort === "low", JSON.stringify(pick));
      check("it is persisted on the task", h.db.getThreadStageOutputs(id).modelPick?.model === HAIKU, JSON.stringify(h.db.getThreadStageOutputs(id).modelPick));
      const rec = h.db.getModelGrade(id);
      check("a grade record is opened, ungraded", rec?.model === HAIKU && rec.gradedAt == null && rec.score == null, JSON.stringify(rec));
      check("the owner is told what was chosen", h.db.listFindings(id).some((f) => f.summary.includes(HAIKU)), "no finding posted");

      // The resume invariant: a task must never re-decide its backend mid-flight — a session id is
      // provider-specific, so a second opinion would strand the work it was meant to continue.
      h.reply(pickReply("claude-opus-4-8", "max"));
      const again = (await h.internals.autoSelectModel(thread(h, id))) as ModelPick;
      check("a resume reuses the pick it already made", again?.model === HAIKU, JSON.stringify(again));
      check("…without paying for a second call", h.calls() === 0, String(h.calls()));
    } finally {
      h.dispose();
    }
  }

  // -- C: an unusable answer must never route a task --------------------------------------------------
  console.log("\nTest C — an unusable answer falls back to normal routing, once");
  {
    const h = makeHarness();
    try {
      h.mgr.setSettings({ autoModelSelection: true });
      const id = h.seed();
      h.reply(pickReply("gpt-4o-mini"), "sorry, I'd rather not say");
      const pick = await h.internals.autoSelectModel(thread(h, id));
      check("no pick is returned", pick === undefined, JSON.stringify(pick));
      check("the failure is recorded so it isn't retried every resume", h.db.getThreadStageOutputs(id).modelPick === null, JSON.stringify(h.db.getThreadStageOutputs(id).modelPick));
      check("no grade record is opened for a task that wasn't auto-picked", h.db.getModelGrade(id) === null, "a record appeared");
      const spent = h.calls();
      await h.internals.autoSelectModel(thread(h, id));
      check("a later resume does not re-spend on it", h.calls() === spent, `${h.calls()} vs ${spent}`);
    } finally {
      h.dispose();
    }
  }

  // -- D: effort precedence ---------------------------------------------------------------------------
  console.log("\nTest D — effort: an operator pin beats the pick, the pick beats the planner");
  {
    const h = makeHarness();
    try {
      h.mgr.setSettings({ autoModelSelection: true });
      const id = h.seed();
      h.reply(pickReply(HAIKU, "medium"));
      await h.internals.autoSelectModel(thread(h, id));
      check("the pick's effort beats the planner's", h.internals.implementorEffort(id, "max") === "medium", String(h.internals.implementorEffort(id, "max")));
      // An operator pin is snapshotted onto the thread at dispatch (there is no later setter), so seed a
      // second task the way a pinned dispatch does and give it the same pick.
      const pinned = h.db.createThread({ title: "pinned", workspace: h.workspace, rawPrompt: "x", effortOverride: "low" });
      h.db.updateThreadStageOutputs(pinned.id, { modelPick: { provider: "claude", model: HAIKU, effort: "medium", reason: "r" } });
      check("an operator-pinned effort still wins", h.internals.implementorEffort(pinned.id, "max") === "low", String(h.internals.implementorEffort(pinned.id, "max")));
    } finally {
      h.dispose();
    }
  }

  // -- E: the pick is provider-scoped -----------------------------------------------------------------
  console.log("\nTest E — a pick only supplies a model to the backend it named");
  {
    const h = makeHarness();
    try {
      h.db.kvSet("cache_grok_models", JSON.stringify(["grok-4.6"]));
      h.db.kvSet("setting_grok_model", "grok-4.5");
      check("a CLI-cache-rejected Grok model is not ready", h.internals.grokModelAvailable() === false, String(h.internals.grokModelAvailable()));
      h.db.kvSet("setting_grok_model", "");
      check("an unpinned Grok selection follows the cached live model", h.internals.grokModel() === "grok-4.6", String(h.internals.grokModel()));

      const id = h.seed();
      h.db.updateThreadStageOutputs(id, { modelPick: { provider: "claude", model: HAIKU, effort: "low", reason: "r" } });
      check("its own backend gets the model", h.internals.pickedModel(id, "claude") === HAIKU, String(h.internals.pickedModel(id, "claude")));
      for (const p of ["codex", "grok", "zai"] as ImplementorProvider[]) {
        check(`${p} does not inherit a Claude model id`, h.internals.pickedModel(id, p) === undefined, String(h.internals.pickedModel(id, p)));
      }
      check("a task with no pick supplies nothing", h.internals.pickedModel(h.seed(), "claude") === undefined, "a phantom model appeared");
    } finally {
      h.dispose();
    }
  }

  // -- F: routing follows the pick, but only while that backend can take the work ----------------------
  console.log("\nTest F — routing follows the pick unless its backend can't run");
  {
    const h = makeHarness();
    try {
      const id = h.seed();
      h.db.updateThreadStageOutputs(id, { modelPick: { provider: "claude", model: HAIKU, effort: "low", reason: "r" } });
      // Through the REAL routing gate, not the helper alone — a pick the gate never consults would leave
      // every one of these assertions passing while tasks routed by usage as before.
      check("a Claude pick routes to Claude", h.internals.gateImplementorProvider(thread(h, id)) === "claude", String(h.internals.gateImplementorProvider(thread(h, id))));
      check("the gate remembers it for the run", h.internals.implementorProvider.get(id) === "claude", String(h.internals.implementorProvider.get(id)));
      // Codex is off in this instance, so a pick naming it cannot be honored — the task must run on what
      // routing resolved rather than be handed to a backend that isn't there.
      h.db.updateThreadStageOutputs(id, { modelPick: { provider: "codex", model: "gpt-5.6-sol", effort: "high", reason: "r" } });
      check("a pick for an unavailable backend falls back to normal routing", h.internals.gateImplementorProvider(thread(h, id)) === "claude", String(h.internals.implementorProvider.get(id)));
      check("…and supplies no model to the backend that actually runs", h.internals.pickedModel(id, "claude") === undefined, String(h.internals.pickedModel(id, "claude")));
      const plain = h.seed();
      check("a task with no pick is routed normally", h.internals.gateImplementorProvider(thread(h, plain)) === "claude", String(h.internals.implementorProvider.get(plain)));

      // The case the whole feature turns on: a pick for a DIFFERENT backend than usage-based routing
      // chose, which is ready. Without it every assertion above passes on a build that ignores the pick
      // entirely — this harness only ever has Claude, so nothing else can tell the two apart.
      // z.ai's readiness is stubbed rather than configured: the real one reads a usage cache from the
      // host's data dir, which would make this gate's verdict depend on the box it runs on.
      h.internals.zaiCapActive = (): boolean => false;
      h.internals.zaiImplementorReady = (): boolean => true;
      h.internals.zaiProviderCandidate = (): Record<string, unknown> => ({
        provider: "zai",
        hasHeadroom: true,
        fiveHour: null,
        sevenDay: null,
        sevenDayReset: null,
        weeklySafetyPct: 100,
      });
      h.mgr.setSettings({ zaiEnabled: true, zaiApiKey: "test-key" });
      const crossed = h.seed();
      check("usage routing alone would pick Claude here", h.internals.gateImplementorProvider(thread(h, crossed)) === "claude", String(h.internals.implementorProvider.get(crossed)));
      h.db.updateThreadStageOutputs(crossed, { modelPick: { provider: "zai", model: "glm-4.6", effort: "high", reason: "r" } });
      check("a pick overrides usage routing when its backend is ready", h.internals.gateImplementorProvider(thread(h, crossed)) === "zai", String(h.internals.implementorProvider.get(crossed)));
      check("…and that backend gets the picked model", h.internals.pickedModel(crossed, "zai") === "glm-4.6", String(h.internals.pickedModel(crossed, "zai")));
    } finally {
      h.dispose();
    }
  }

  // -- G: the pick reaches the actual run ------------------------------------------------------------
  console.log("\nTest G — the run that starts is on the picked model and effort");
  {
    const h = makeHarness();
    try {
      const id = h.seed();
      h.db.updateThreadStageOutputs(id, { modelPick: { provider: "claude", model: HAIKU, effort: "low", reason: "r" } });
      h.internals.implementorProvider.set(id, "claude");
      try {
        h.internals.startImplementor(thread(h, id), "KICKOFF: mock", { effort: h.internals.implementorEffort(id) });
        check("the spawn was stopped by the harness, not completed", false, "startImplementor returned — the stub should have thrown");
      } catch (e) {
        check("stopped exactly before the spawn", (e as Error).message === WIRE_SENTINEL, (e as Error).message);
      }
      const run = h.db.listRuns(id).find((r) => r.role === "implementor");
      check("the run records the picked model", run?.model === HAIKU, String(run?.model));
      check("the run records the picked effort", run?.effort === "low", String(run?.effort));

      // …and with no pick, the configured default is what runs — the feature must be invisible when off.
      const plain = h.seed();
      h.internals.implementorProvider.set(plain, "claude");
      try {
        h.internals.startImplementor(thread(h, plain), "KICKOFF: mock");
      } catch {
        /* the same sentinel */
      }
      const plainRun = h.db.listRuns(plain).find((r) => r.role === "implementor");
      check("a task with no pick runs the configured model", plainRun?.model === h.mgr.modelFor("acct-a", "implementor"), String(plainRun?.model));
    } finally {
      h.dispose();
    }
  }

  // -- H: grading closes the loop ---------------------------------------------------------------------
  console.log("\nTest H — a settled task is graded and feeds the scoreboard");
  {
    const h = makeHarness();
    try {
      h.mgr.setSettings({ autoModelSelection: true });
      const id = h.seed();
      h.reply(pickReply(HAIKU));
      await h.internals.autoSelectModel(thread(h, id));
      const r1 = h.db.createRun({ threadId: id, role: "implementor", model: HAIKU, account: "account a", effort: "low" });
      h.db.updateRun(r1.id, { state: "done", costUsd: 0.5, numTurns: 12, endedAt: Date.now() });
      const r2 = h.db.createRun({ threadId: id, role: "qa", model: "claude-opus-4-8" });
      h.db.updateRun(r2.id, { state: "done", costUsd: 1.5, numTurns: 20, endedAt: Date.now() });
      h.db.updateThreadStageOutputs(id, { qaRoundsUsed: 2 });

      h.internals.setState(id, "done");
      const graded = h.db.getModelGrade(id);
      check("the task is graded", graded?.outcome === "done" && graded.gradedAt != null, JSON.stringify(graded));
      check("one QA fix-round costs 12", graded?.score === 88, String(graded?.score));
      check("the whole task's cost is recorded", graded?.costUsd === 2, String(graded?.costUsd));
      check("the model that ran is credited", graded?.gradedModel === HAIKU, String(graded?.gradedModel));
      const stats = h.db.modelStats();
      check("the scoreboard has it", stats.length === 1 && stats[0]!.model === HAIKU && stats[0]!.avgScore === 88, JSON.stringify(stats));
      check("and it is visible for this repo", h.db.modelStats(stats.length ? h.db.getModelGrade(id)!.workspace : "").length === 1, "repo-scoped stats missed it");
      check("the grade is announced once", h.db.listFindings(id).filter((f) => f.summary.includes("scored")).length === 1, "grade finding count wrong");
    } finally {
      h.dispose();
    }
  }

  // -- I: what must NOT be graded ---------------------------------------------------------------------
  console.log("\nTest I — a quota park is not a verdict, and a re-settle updates in place");
  {
    const h = makeHarness();
    try {
      h.mgr.setSettings({ autoModelSelection: true });
      const id = h.seed();
      h.reply(pickReply(HAIKU));
      await h.internals.autoSelectModel(thread(h, id));
      const r = h.db.createRun({ threadId: id, role: "implementor", model: HAIKU, effort: "low" });
      h.db.updateRun(r.id, { state: "done", costUsd: 1, numTurns: 8, endedAt: Date.now() });

      h.internals.setState(id, "review", "⏳ Auto-resume pending — every Claude subscription was rate-limited mid-task.");
      check("a cap-parked task is left ungraded", h.db.getModelGrade(id)?.gradedAt == null, JSON.stringify(h.db.getModelGrade(id)));
      check("…so it can't reach the scoreboard either", h.db.modelStats().length === 0, JSON.stringify(h.db.modelStats()));

      h.internals.setState(id, "review", "QA still not satisfied after 4 rounds — needs your review.");
      check("a genuine hand-back IS graded", h.db.getModelGrade(id)?.score === 40, String(h.db.getModelGrade(id)?.score));

      // The owner resumes it and it lands: the record must describe how the task ACTUALLY ended.
      h.internals.setState(id, "done");
      check("a later finish re-grades the same record", h.db.getModelGrade(id)?.score === 100, String(h.db.getModelGrade(id)?.score));
      check("still one row for the task", h.db.listModelGrades().length === 1, String(h.db.listModelGrades().length));
      check("the re-grade is not re-announced", h.db.listFindings(id).filter((f) => f.summary.includes("scored")).length === 1, "the grade was announced twice");
    } finally {
      h.dispose();
    }
  }

  console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed`);
  if (failed) {
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

await main().finally(() => {
  globalThis.fetch = realFetch;
});
