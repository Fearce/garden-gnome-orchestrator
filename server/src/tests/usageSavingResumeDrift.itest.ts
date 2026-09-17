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
 * "randomly stopped using Opus 5" and never came back, despite Token Conservation Mode being off the
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
  internals.startImplementor = (t: Thread, kickoff: string, opts?: { resume?: string; images?: unknown[] }) => {
    // Read the model the real (unstubbed) resolution logic would pick, without actually spawning an
    // agent: mirror the claude branch's own fallback chain (no pin/pick configured in this fixture).
    const model = internals.usageSavingTarget("account-a")?.model ?? internals.modelFor("account-a", "implementor");
    asks.push({ resume: opts?.resume, model, kickoff, images: opts?.images?.length ?? 0 });
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
    modelOverrides: { "account-a": { implementor: "claude-opus-5" } },
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
    modelOverrides: { "account-a": { implementor: "claude-opus-5" } },
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
  check("the fresh session resolves back to the configured Opus default", h.asks[0]?.model === "claude-opus-5", h.asks[0]?.model);
  // The replacement session must carry the prior one's compressed handoff. Restarting a long task from
  // the bare kickoff is the "starting again and again" failure the owner has already complained about.
  check(
    "the replacement session is seeded from the prior session, not restarted from the bare kickoff",
    /Resuming — you already worked on this task in an earlier session/.test(h.asks[0]?.kickoff ?? ""),
    (h.asks[0]?.kickoff ?? "").slice(0, 200),
  );
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

console.log(`\n=== ${passed}/${passed + failed} checks passed ===`);
if (failed) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
process.exit(0);
