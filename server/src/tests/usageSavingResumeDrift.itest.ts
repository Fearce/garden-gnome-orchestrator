/**
 * Integration test — a warm-resumed implementor session must re-check its MODEL, not just its provider.
 *
 * The bug (task 6bf166a5, 2026-09-17): a Claude subscription's weekly window briefly crossed the
 * "Usage saving" threshold, downgrading the implementor to claude-sonnet-5 for that resume. Once the
 * subscription's usage dropped back under the threshold, every LATER turn-ceiling continuation kept
 * warm-resuming the SAME sonnet session anyway — `startResumedImplementor`'s model-drift guard only
 * compared the prior session's model against an explicit saving/pin/auto-selection pick, and fell back
 * to `undefined` (no opinion) once none of those three applied, so the ordinary "saving turned back off,
 * route back to the configured default" case was silently invisible to it. The owner reported the task
 * "randomly stopped using Opus 5.5" and never came back, despite Token Conservation Mode being off the
 * whole time (a different, unrelated toggle) — Usage Saving, a separate per-subscription setting, was on.
 *
 * WHAT IS REAL vs. SIMULATED
 *  - REAL: `startResumedImplementor` itself — the provider/session-age gating, the model-drift guard this
 *    test targets, and `usageSavingTarget`/`providerRoleModel`/`modelFor` resolving against a real Db.
 *  - SIMULATED: only the agent spawn — `startImplementor` is intercepted to record whether it was asked
 *    to `resume` the prior session (session preserved) or not (drift detected, fresh session started).
 *
 * Run:  npm run test:usage-saving-resume-drift   (from server/)   — or:  npx tsx src/tests/usageSavingResumeDrift.itest.ts
 * Exits non-zero if any assertion fails. Self-contained: creates a throwaway DB + workspace and removes them.
 */

// A warm-resume test needs RESUME_FULL_SESSION=1 (see threadmanager-itest.md): the fake session id has no
// real CLI transcript, so sessionAgeMs is null and the age check would otherwise fall COLD, taking the
// Haiku-compression path instead of the warm resume path this guard lives on. Must be set before config.js
// is first evaluated, so the app modules are dynamically imported below.
process.env.RESUME_FULL_SESSION = "1";
process.env.CAP_RETRY_MS = "0";
process.env.ACCOUNT_PING_MS = "3600000";
process.env.FAST_ACCOUNT_PING_MS = "3600000";

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountManager } from "../accounts/accountManager.js";
import type { Thread } from "../types.js";

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

/** Mutable per-test account meters, mirroring usageSaving.test.ts's fixture shape. */
class UsageAccounts {
  fiveHour = 95;
  sevenDay = 95;
  onUsageRefresh(_cb: () => void): void {}
  effectiveUtilization(): number | null { return this.fiveHour; }
  soonestResetAt(): number | null { return Date.now() + 3_600_000; }
  hasHeadroom(): boolean { return true; }
  setPingInterval(_ms: number): void {}
  applyEnabled(_id: string, _enabled: boolean): void {}
  applyWeeklySafetyPct(_id: string, _pct: number): void {}
  setSpreadUsage(_on: boolean): void {}
  isModelLimited(_id: string, _model: string): boolean { return false; }
  // The model-drift reseed compresses the prior session, which reads a token without running the
  // dispatch selector. The fake session id has no transcript, so compression degrades to git+plan.
  auxToken(): string { return "test-token"; }
  // The resume path now SELECTS the subscription itself and hands it to the dispatch, so the guard and
  // the dispatch can never name different accounts (see startResumedImplementor).
  select(): { account: { id: string; label: string; token: string }; reason: string } {
    return { account: { id: "account-a", label: "Claude A", token: "test-token" }, reason: "fixture" };
  }
  dispatchPreview(): Record<string, unknown> {
    return {
      account: { id: "account-a", label: "Claude A", token: "test-token" },
      hasHeadroom: true,
      fiveHour: this.fiveHour,
      sevenDay: this.sevenDay,
      weeklySafetyPct: 100,
    };
  }
  dto(): Array<Record<string, unknown>> {
    return [{
      id: "account-a", label: "Claude A", enabled: true, active: false, rateLimited: false,
      fiveHour: this.fiveHour, sevenDay: this.sevenDay, updatedAt: Date.now(), weeklySafetyPct: 100,
    }];
  }
  byId(): undefined { return undefined; }
}

interface StartAsk {
  resume: string | undefined;
  model: string | undefined;
  account: string | undefined;
  kickoff: string;
  images: number;
}

function makeHarness(): {
  mgr: InstanceType<typeof ThreadManager>;
  db: InstanceType<typeof Db>;
  thread: Thread;
  accounts: UsageAccounts;
  asks: StartAsk[];
  dispose(): void;
} {
  const dir = mkdtempSync(join(tmpdir(), "usage-saving-resume-drift-"));
  const workspace = join(dir, "workspace");
  mkdirSync(workspace, { recursive: true });

  const db = new Db(join(dir, "orchestrator.sqlite"));
  const hub = new EventHub();
  const memory = new FileMemoryService(join(dir, "memory"));
  const accounts = new UsageAccounts();
  const mgr = new ThreadManager(db, hub, memory, accounts as unknown as AccountManager);

  const thread = db.createThread({ title: "usage saving resume drift", workspace, rawPrompt: "p", brief: "b" });
  db.updateThreadStageOutputs(thread.id, {});

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = mgr as any;
  internals.lastImplementorSession.set(thread.id, "sess-1");

  const asks: StartAsk[] = [];
  const realStartImplementor = internals.startImplementor.bind(internals);
  internals.startImplementor = (t: Thread, kickoff: string, opts?: { resume?: string; images?: unknown[]; account?: { id: string } }) => {
    // Resolve the model through the SAME function the real startImplementor dispatches with, given the
    // account it was actually handed. Re-implementing that precedence here would make the one defect
    // this file exists to catch — the drift guard disagreeing with the dispatch — structurally invisible.
    const provider = internals.implementorProvider.get(t.id) ?? "claude";
    const model = internals.implementorDispatchTarget(t.id, provider, opts?.account?.id).model;
    asks.push({ resume: opts?.resume, model, account: opts?.account?.id, kickoff, images: opts?.images?.length ?? 0 });
    void realStartImplementor; // never actually spawn a real agent in this test
    return { run: { onEnd: () => {}, onEvent: () => () => {} }, runId: "run-x", accountId: "account-a" };
  };

  return {
    mgr,
    db,
    thread,
    accounts,
    asks,
    dispose() {
      if (internals.capSupervisor) clearInterval(internals.capSupervisor);
      if (internals.tokenResumeTimer) clearTimeout(internals.tokenResumeTimer);
      db.raw.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

console.log("\n=== A. usage saving still active: the warm session is preserved (unchanged behavior) ===");
{
  const h = makeHarness();
  h.accounts.fiveHour = 10;
  h.accounts.sevenDay = 95; // above the 90% threshold configured below
  h.mgr.setSettings({
    usageSaving: { "account-a": { enabled: true, thresholdPct: 90, model: "claude-sonnet-5", effort: "medium" } },
    modelOverrides: { "account-a": { implementor: "claude-opus-5-5" } },
  });
  const priorRun = h.db.createRun({ threadId: h.thread.id, role: "implementor", model: "claude-sonnet-5", account: "Claude A" });
  h.db.updateRun(priorRun.id, { sessionId: "sess-1" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = h.mgr as any;
  const result = await internals.startResumedImplementor(h.thread, "kickoff", "sess-1", {
    resumeNudge: "continue",
    qaFollows: true,
  });
  check("the resume was driven", result != null);
  check("the prior session was resumed in place (still on sonnet, still saving)", h.asks.length === 1 && h.asks[0]?.resume === "sess-1", JSON.stringify(h.asks));
  h.dispose();
}

console.log("\n=== B. usage saving deactivated: the stale sonnet session is dropped for a fresh Opus one ===");
{
  const h = makeHarness();
  h.accounts.fiveHour = 10;
  h.accounts.sevenDay = 95; // saving was active when the prior run picked its model...
  h.mgr.setSettings({
    usageSaving: { "account-a": { enabled: true, thresholdPct: 90, model: "claude-sonnet-5", effort: "medium" } },
    modelOverrides: { "account-a": { implementor: "claude-opus-5-5" } },
  });
  const priorRun = h.db.createRun({ threadId: h.thread.id, role: "implementor", model: "claude-sonnet-5", account: "Claude A" });
  h.db.updateRun(priorRun.id, { sessionId: "sess-1" });
  h.accounts.sevenDay = 69; // ...but has since dropped back under the threshold, like the real vota account did
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = h.mgr as any;
  const result = await internals.startResumedImplementor(h.thread, "kickoff", "sess-1", {
    resumeNudge: "continue",
    qaFollows: true,
  });
  check("the resume was driven", result != null);
  check(
    "a FRESH session was started instead of continuing the stale sonnet one",
    h.asks.length === 1 && h.asks[0]?.resume === undefined,
    JSON.stringify(h.asks),
  );
  check("the fresh session resolves back to the configured Opus default", h.asks[0]?.model === "claude-opus-5-5", h.asks[0]?.model);
  // The replacement must take the RESEED path (which carries the prior session's compressed handoff),
  // not the `!resumeSession` early return that restarts from the bare kickoff — the "starting again and
  // again" failure the owner has already complained about. What the seed then contains is
  // `composeResumeKickoff`'s business; with a fake session id there is no transcript to compress, so this
  // asserts the branch taken, not the handoff's contents.
  check(
    "the replacement takes the compressed-reseed path, not the bare-kickoff restart",
    /Resuming — you already worked on this task in an earlier session/.test(h.asks[0]?.kickoff ?? ""),
    (h.asks[0]?.kickoff ?? "").slice(0, 200),
  );
  h.dispose();
}

console.log("\n=== B2. a strict owner pin outranks active saving: the sonnet session is dropped for the pinned model ===");
{
  // The reported defect (2026-09-18): the owner pinned claude-opus-5-5 on a vota task, resumed, and the
  // resume ran claude-sonnet-5 — usage saving deliberately outranked the pin, and the pin's own feed
  // message promises "No fallback model is allowed". Saving stays ACTIVE throughout this case: that is
  // what separates it from B, where the pin is absent and the window merely rolled back under.
  const h = makeHarness();
  h.accounts.fiveHour = 10;
  h.accounts.sevenDay = 95; // still above the threshold configured below
  h.mgr.setSettings({
    usageSaving: { "account-a": { enabled: true, thresholdPct: 90, model: "claude-sonnet-5", effort: "medium" } },
    modelOverrides: { "account-a": { implementor: "claude-sonnet-5" } },
  });
  h.db.setModelRequest(h.thread.id, { requested: "claude-opus-5-5", provider: "claude", model: "claude-opus-5-5", strict: true });
  const priorRun = h.db.createRun({ threadId: h.thread.id, role: "implementor", model: "claude-sonnet-5", account: "Claude A" });
  h.db.updateRun(priorRun.id, { sessionId: "sess-1" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = h.mgr as any;
  const result = await internals.startResumedImplementor(h.thread, "kickoff", "sess-1", {
    resumeNudge: "continue",
    qaFollows: true,
  });
  check("the resume was driven", result != null);
  check(
    "the saving-model session is not resumed in place while a pin names another model",
    h.asks.length === 1 && h.asks[0]?.resume === undefined,
    JSON.stringify(h.asks.map((a) => a.resume)),
  );
  check("the resume dispatches the pinned model, not the saving model", h.asks[0]?.model === "claude-opus-5-5", h.asks[0]?.model);
  h.dispose();
}

console.log("\n=== C. a CLI backend drifts too: fresh session, and the owner's images still travel ===");
{
  // A Codex/Grok session is bound to its model just as a Claude one is, so the same drift starts a fresh
  // CLI session. That branch is a DIFFERENT code path from the Claude reseed (it has no local transcript
  // to compress, so it rebuilds from the recovery history) and it must still carry any resume images.
  const h = makeHarness();
  h.accounts.fiveHour = 10;
  h.accounts.sevenDay = 10; // no usage saving anywhere — this drift is a plain configured-model change
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = h.mgr as any;
  internals.implementorProvider.set(h.thread.id, "codex");
  const current = internals.providerRoleModel("codex", "implementor");
  const stale = current === "gpt-5.5" ? "gpt-5.4" : "gpt-5.5"; // whatever the config is, seed a different one
  const priorRun = h.db.createRun({ threadId: h.thread.id, role: "implementor", model: stale, account: `codex:${stale}` });
  h.db.updateRun(priorRun.id, { sessionId: "codex-session" });
  const image = { type: "image" as const, source: { type: "base64" as const, media_type: "image/png" as const, data: "iVBORw0KGgo=" } };
  const result = await internals.startResumedImplementor(h.thread, "kickoff", "codex-session", {
    resumeNudge: "continue",
    qaFollows: true,
    images: [image],
  });
  check("the resume was driven", result != null);
  check("the stale-model CLI session is not resumed in place", h.asks.length === 1 && h.asks[0]?.resume === undefined, JSON.stringify(h.asks.map((a) => a.resume)));
  check("the owner's image still reaches the fresh CLI session", h.asks[0]?.images === 1, String(h.asks[0]?.images));
  h.dispose();
}

console.log("\n=== D. a Fable-pool cap is not drift: the pick's fallback IS what the dispatch runs ===");
{
  // While a Fable pool is latched, `startImplementor` dispatches the pick's fallback — so the prior run
  // is on the FALLBACK while the raw pick still says Fable. Comparing the raw pick would read drift on
  // every single resume and restart the session onto the model it was already running.
  const h = makeHarness();
  h.accounts.fiveHour = 10;
  h.accounts.sevenDay = 10; // no usage saving
  h.accounts.isModelLimited = (_id: string, model: string) => /fable/i.test(model);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = h.mgr as any;
  h.db.updateThreadStageOutputs(h.thread.id, {
    modelPick: { provider: "claude", model: "claude-fable-5-1", effort: "high", reason: "fixture" },
  });
  const fallback = internals.poolResolved("account-a", "claude-fable-5-1");
  check("the fixture really latches the Fable pool", fallback !== "claude-fable-5-1", fallback);
  const priorRun = h.db.createRun({ threadId: h.thread.id, role: "implementor", model: fallback, account: "Claude A" });
  h.db.updateRun(priorRun.id, { sessionId: "sess-1" });
  const result = await internals.startResumedImplementor(h.thread, "kickoff", "sess-1", {
    resumeNudge: "continue",
    qaFollows: true,
  });
  check("the resume was driven", result != null);
  check(
    "the session on the pool fallback is resumed in place, not restarted as drift",
    h.asks.length === 1 && h.asks[0]?.resume === "sess-1",
    JSON.stringify(h.asks.map((a) => a.resume)),
  );
  h.dispose();
}

console.log("\n=== E. a pin for ANOTHER backend is not drift on this one ===");
{
  // A cap failover flips the backend and deliberately leaves the pick/pin behind — a Claude model id
  // means nothing to the Codex CLI. Reading it anyway compares two backends' models and restarts the
  // Codex thread on every continuation.
  const h = makeHarness();
  h.accounts.fiveHour = 10;
  h.accounts.sevenDay = 10;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = h.mgr as any;
  internals.implementorProvider.set(h.thread.id, "codex");
  h.db.setModelRequest(h.thread.id, { requested: "opus 5.5", provider: "claude", model: "claude-opus-5-5", strict: true });
  h.db.updateThreadStageOutputs(h.thread.id, {
    modelPick: { provider: "claude", model: "claude-opus-5-5", effort: "high", reason: "fixture" },
  });
  const current = internals.providerRoleModel("codex", "implementor");
  const priorRun = h.db.createRun({ threadId: h.thread.id, role: "implementor", model: current, account: `codex:${current}` });
  h.db.updateRun(priorRun.id, { sessionId: "codex-session" });
  const result = await internals.startResumedImplementor(h.thread, "kickoff", "codex-session", {
    resumeNudge: "continue",
    qaFollows: true,
  });
  check("the resume was driven", result != null);
  check(
    "the Codex session is resumed in place despite the Claude-side pin and pick",
    h.asks.length === 1 && h.asks[0]?.resume === "codex-session",
    JSON.stringify(h.asks.map((a) => a.resume)),
  );
  h.dispose();
}

console.log("\n=== F. the comparison reads the model of THIS session, not merely the newest run ===");
{
  // A run that never reached `init` (a cap rejection, a wedged spawn) records no session id, so it can
  // never be the run being resumed — but it is the newest one. Reading its model compares a model this
  // session was never bound to and throws away a healthy session.
  const h = makeHarness();
  h.accounts.fiveHour = 10;
  h.accounts.sevenDay = 10;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = h.mgr as any;
  h.mgr.setSettings({ modelOverrides: { "account-a": { implementor: "claude-opus-5-5" } } });
  const owning = h.db.createRun({ threadId: h.thread.id, role: "implementor", model: "claude-opus-5-5", account: "Claude A" });
  h.db.updateRun(owning.id, { sessionId: "sess-1" });
  // Newer, sessionless, on a different model — a rejected relaunch. Its `started_at` is pushed forward
  // explicitly: both rows are written inside one millisecond, so a plain newest-first sort ties and would
  // return the owning run anyway — the fixture would then pass with the fix reverted.
  const rejected = h.db.createRun({ threadId: h.thread.id, role: "implementor", model: "claude-sonnet-5", account: "Claude A" });
  h.db.raw.prepare("UPDATE agent_runs SET started_at = ? WHERE id = ?").run(Date.now() + 60_000, rejected.id);
  const result = await internals.startResumedImplementor(h.thread, "kickoff", "sess-1", {
    resumeNudge: "continue",
    qaFollows: true,
  });
  check("the resume was driven", result != null);
  check(
    "a newer sessionless run does not read as drift on the session being resumed",
    h.asks.length === 1 && h.asks[0]?.resume === "sess-1",
    JSON.stringify(h.asks.map((a) => a.resume)),
  );
  check("the dispatch was handed the account the guard resolved", h.asks[0]?.account === "account-a", String(h.asks[0]?.account));
  h.dispose();
}

console.log("\n=== G. the one-shot roles get the same rule, where their account is finally known ===");
{
  // QA/reviewer/planner resume through `runRole`, which never passed through the guard above: their
  // model is re-derived per attempt from the account the loop selects, so a usage-saving downgrade
  // landing mid-review outlived the window that caused it exactly as it did on the implementor path.
  // The check sits INSIDE the loop, after the account is known — guessing it earlier is the defect
  // fixture F pins. Driven on `planner` because it is the cheapest role with no review-lane machinery;
  // the guard itself (`roleSessionModelDrifted`) is role-agnostic — named here so
  // `npm run gates:touching --prefix server -- roleSessionModelDrifted` finds this gate.
  const fakeAgent = () => ({
    onEvent: (_cb: unknown) => () => {},
    onEnd: (_cb: unknown) => {},
    start: () => {},
    stop: async () => {},
    rateLimited: false,
    result: async () => ({ type: "result", subtype: "success", isError: false, structuredOutput: {} }),
  });

  for (const [label, priorModel, expectResume] of [
    ["a session bound to another model is not resumed", "claude-sonnet-5", false],
    ["a session bound to the model this run resolves IS resumed", null, true],
  ] as Array<[string, string | null, boolean]>) {
    const h = makeHarness();
    h.accounts.fiveHour = 10;
    h.accounts.sevenDay = 10;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = h.mgr as any;
    h.mgr.setSettings({ modelOverrides: { "account-a": { planner: "claude-opus-5-5" } } });
    const session = "planner-session";
    const seeded = priorModel ?? internals.modelFor("account-a", "planner");
    h.db.updateRun(
      h.db.createRun({ threadId: h.thread.id, role: "planner", model: seeded, account: "Claude A" }).id,
      { sessionId: session },
    );
    const seen: Array<string | undefined> = [];
    internals.createRoleAgent = (_provider: string, _create: unknown) => fakeAgent();
    await internals.runRole(
      h.thread,
      "planner",
      "kickoff",
      (ctx: { resume?: string }) => { seen.push(ctx.resume); return {}; },
      session,
    );
    check(label, seen.length === 1 && (seen[0] === session) === expectResume, JSON.stringify(seen));
    h.dispose();
  }
}

console.log(`\n=== ${passed}/${passed + failed} checks passed ===`);
if (failed) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
process.exit(0);
