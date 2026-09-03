/**
 * Integration test — task-aware route selection wired into the REAL runPipeline.
 *
 * routeSelection.test.ts proves the classifier in isolation; this proves the PIPELINE actually honors its
 * decision: a narrow task runs the implementor alone, a broad/risky one keeps the planner and QA, the
 * operator's plannerEnabled/qaEnabled settings remain a hard ceiling the route can never override, the
 * read lane stays untouched by any of this, and the pick is sticky across a resume.
 *
 * WHAT IS REAL vs STUBBED (threadmanager-itest.md's "stub at the right depth"): the real Db (temp file),
 * EventHub, dispatch/enqueueOrRun/runPipeline, and every routing decision under test. Stubbed: runRole
 * (planner/researcher/reader/qa — no `claude` subprocess, no quota) and the implementor-spawning leaves
 * (gateImplementorProvider, startResumedImplementor, awaitImplementorCompletion, drainQueuedImplementor,
 * flushDirectorNotes, stopLive), the same depth reader.itest.ts's escalation-promotion section uses.
 *
 * Run:  npm run test:route-pipeline   (from server/)   — or:  npx tsx src/tests/routeSelection.itest.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResultEvent } from "../agents/runner.js";

const { Db } = await import("../db/db.js");
const { EventHub } = await import("../events.js");
const { FileMemoryService } = await import("../memory/memory.js");
const { AccountManager } = await import("../accounts/accountManager.js");
const { ResetStagger } = await import("../accounts/resetStagger.js");
const { ThreadManager } = await import("../orchestrator/threadManager.js");
const { config } = await import("../config.js");

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    failures.push(label + (detail ? ` — ${detail}` : ""));
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const TERMINAL = new Set(["done", "review", "failed", "cancelled"]);
const NARROW_BRIEF = "Fix the typo in the README: 'recieve' should be 'receive'.";
const BROAD_BRIEF = "Add two-factor authentication to the login flow, including SMS and TOTP support, with a new database table.";

interface Harness {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  manager: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
  roleCalls: string[];
  dispose(): void;
  pollTerminal(id: string, timeoutMs?: number): Promise<string>;
  waitIdle(id: string, timeoutMs?: number): Promise<void>;
}

/** A ThreadManager whose agent-spawning leaves are stubbed but whose route/planner/QA decision logic is
 *  entirely real — the same depth as reader.itest.ts's escalation-promotion section. */
function makeHarness(): Harness {
  const dataDir = mkdtempSync(join(tmpdir(), "route-pipeline-"));
  const db = new Db(join(dataDir, "orchestrator.sqlite"));
  const hub = new EventHub();
  const memory = new FileMemoryService();
  const accounts = new AccountManager(config.accounts, hub, config.accountPingMs, {
    stagger: new ResetStagger(),
    persist: {
      load: (id: string) => { const v = db.kvGet(`account_usage_${id}`); try { return v ? JSON.parse(v) : null; } catch { return null; } },
      save: (id: string, u: unknown) => db.kvSet(`account_usage_${id}`, JSON.stringify(u)),
    },
  });
  const manager = new ThreadManager(db, hub, memory, accounts);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = manager as any;
  // See reader.itest.ts's identical comment: an unstored "sweep shortly after start" setTimeout in the
  // constructor can fire against this instance's already-closed DB once a later test's real polling keeps
  // the process alive past its 4s delay. No-op it outright — nothing here ever cap-parks anything.
  internals.resumeCapParked = (): void => {};
  if (internals.capSupervisor) clearInterval(internals.capSupervisor);
  if (internals.tokenResumeTimer) clearTimeout(internals.tokenResumeTimer);
  if (internals.capResumeWake) clearTimeout(internals.capResumeWake);

  const roleCalls: string[] = [];
  const canned: Record<string, ResultEvent> = {
    planner: { type: "result", subtype: "success", isError: false, structuredOutput: { summary: "plan", steps: [], risks: [], openQuestions: [], nextAgent: "implementor" } },
    qa: { type: "result", subtype: "success", isError: false, structuredOutput: { pass: true, summary: "looks good", issues: [] } },
  };
  internals.runRole = async (_t: unknown, role: string): Promise<ResultEvent | undefined> => {
    roleCalls.push(role);
    return canned[role];
  };
  internals.gateImplementorProvider = (): string => "claude";
  internals.stopLive = async (): Promise<void> => {};
  internals.flushDirectorNotes = (): void => {};
  internals.startResumedImplementor = async (): Promise<{ run: unknown; accountId: string }> => ({ run: { send() {} }, accountId: "acct1" });
  internals.awaitImplementorCompletion = async (): Promise<ResultEvent> => ({ type: "result", subtype: "success", isError: false });
  internals.drainQueuedImplementor = async (_t: unknown, _e: unknown, _k: string, res: ResultEvent | undefined): Promise<ResultEvent | undefined> => res;

  return {
    manager,
    db,
    roleCalls,
    async pollTerminal(id: string, timeoutMs = 4000): Promise<string> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const t = db.getThread(id);
        if (t && TERMINAL.has(t.state)) return t.state;
        await new Promise((r) => setTimeout(r, 5));
      }
      return db.getThread(id)?.state ?? "gone";
    },
    // For a re-entry that doesn't change the (already-terminal) state — pollTerminal alone would return
    // instantly without giving the run any real time to execute — poll runPipeline's own concurrency-slot
    // bookkeeping instead, which is only released in its `finally` once the run has fully unwound.
    async waitIdle(id: string, timeoutMs = 4000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (!internals.activePipelines?.has(id)) return;
        await new Promise((r) => setTimeout(r, 5));
      }
    },
    dispose() {
      try { db.raw.close(); } catch { /* already closed */ }
      try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* windows file lock — harmless */ }
    },
  };
}

async function main(): Promise<void> {
  console.log("routeSelection wired into runPipeline (real Db/EventHub, stubbed agent-spawning leaves)");

  // ---- 1. Enabled planner/QA + a narrow change → implementor only ---------------------------------
  console.log("\n1. Narrow change, planner+QA enabled → routed to the implementor alone");
  {
    const h = makeHarness();
    try {
      const id = await h.manager.dispatch({ title: "typo fix", workspace: process.cwd(), brief: NARROW_BRIEF });
      const state = await h.pollTerminal(id);
      // The card's state flips to 'done' INSIDE the run, before runPipeline's own finally/releaseSlot
      // unwinds — wait for that too, or a later test's polling can catch this run's tail firing against
      // this harness's already-closed DB.
      await h.waitIdle(id);
      check("narrow task reaches 'done'", state === "done", `got ${state}`);
      check("planner never ran", !h.roleCalls.includes("planner"), h.roleCalls.join(","));
      check("qa never ran", !h.roleCalls.includes("qa"), h.roleCalls.join(","));
      const decision = h.db.getThreadStageOutputs(id).routeDecision;
      check("route persisted as narrow", decision?.scope === "narrow" && decision.usePlanner === false && decision.useQa === false, JSON.stringify(decision));
      check(
        "a route notice explains the pick in the thread's own history",
        h.db.listMessages(id).some((m: { kind: string; content: string }) => m.kind === "system" && /route selected/i.test(m.content) && /no planning/i.test(m.content)),
      );
      const kickoff = h.db.getThreadStageOutputs(id).kickoff ?? "";
      check("implementor kickoff names the selected implementor-only route", /For this task: no planning, no QA/i.test(kickoff), kickoff);
      check("skipped planner is not described as a failed/empty planner", !/planner produced no structured plan/i.test(kickoff), kickoff);
    } finally {
      h.dispose();
    }
  }

  // ---- 2. Enabled planner/QA + broad/risky work → both selected -----------------------------------
  console.log("\n2. Broad/risky work, planner+QA enabled → both kept");
  {
    const h = makeHarness();
    try {
      const id = await h.manager.dispatch({ title: "2fa", workspace: process.cwd(), brief: BROAD_BRIEF });
      const state = await h.pollTerminal(id);
      await h.waitIdle(id);
      check("broad task reaches 'done'", state === "done", `got ${state}`);
      check("planner ran", h.roleCalls.includes("planner"), h.roleCalls.join(","));
      check("qa ran", h.roleCalls.includes("qa"), h.roleCalls.join(","));
      const decision = h.db.getThreadStageOutputs(id).routeDecision;
      check("route persisted as broad", decision?.scope === "broad" && decision.usePlanner === true && decision.useQa === true, JSON.stringify(decision));
    } finally {
      h.dispose();
    }
  }

  // ---- 3. Global settings remain a hard ceiling — route can never override an operator's OFF -------
  console.log("\n3. plannerEnabled/qaEnabled OFF stay a hard ceiling even when the route wants both");
  {
    const h = makeHarness();
    try {
      const qaOnlyId = await h.manager.dispatch({ title: "verified typo fix", workspace: process.cwd(), brief: "Fix the typo in README.md, then run the test suite." });
      const qaOnlyState = await h.pollTerminal(qaOnlyId);
      await h.waitIdle(qaOnlyId);
      check("contained verified task reaches 'done'", qaOnlyState === "done", `got ${qaOnlyState}`);
      check("planner is not run when only QA adds value", !h.roleCalls.includes("planner"), h.roleCalls.join(","));
      check("QA is run for the explicit verification need", h.roleCalls.includes("qa"), h.roleCalls.join(","));
      const qaOnlyDecision = h.db.getThreadStageOutputs(qaOnlyId).routeDecision;
      check("route persists QA-only standard", qaOnlyDecision?.scope === "standard" && qaOnlyDecision.usePlanner === false && qaOnlyDecision.useQa === true, JSON.stringify(qaOnlyDecision));

      h.roleCalls.length = 0;
      h.manager.setSettings({ plannerEnabled: false, qaEnabled: false });
      const id = await h.manager.dispatch({ title: "2fa", workspace: process.cwd(), brief: BROAD_BRIEF });
      const state = await h.pollTerminal(id);
      await h.waitIdle(id);
      check("task still completes with both disabled", state === "done", `got ${state}`);
      check("planner never ran (setting overrides a 'broad' route)", !h.roleCalls.includes("planner"), h.roleCalls.join(","));
      check("qa never ran (setting overrides a 'broad' route)", !h.roleCalls.includes("qa"), h.roleCalls.join(","));
      const decision = h.db.getThreadStageOutputs(id).routeDecision;
      check("the STORED route decision itself is unaffected by settings — still wants both", decision?.usePlanner === true && decision?.useQa === true, JSON.stringify(decision));
      check(
        "the announcement explains settings disabled them, not that the route skipped them",
        h.db.listMessages(id).some((m: { kind: string; content: string }) => m.kind === "system" && /disabled in settings/i.test(m.content)),
      );
    } finally {
      h.dispose();
    }
  }

  // ---- 4. The read lane stays untouched by any of this, regardless of settings ---------------------
  console.log("\n4. dispatch_read (lane:'read') bypasses route selection entirely, planner/QA enabled or not");
  {
    const h = makeHarness();
    try {
      h.manager.setSettings({ plannerEnabled: true, qaEnabled: true });
      // dispatch() fires the pipeline SYNCHRONOUSLY up to its first internal await (enqueueOrRun → void
      // runPipeline), so the reader-aware override must be in place BEFORE dispatch, not after — setting
      // it after risks the reader already having run against the harness's default (planner/qa-only) stub.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (h.manager as any).runRole = async (_t: unknown, role: string): Promise<ResultEvent | undefined> => {
        h.roleCalls.push(role);
        if (role === "reader") return { type: "result", subtype: "success", isError: false, structuredOutput: { answered: true, escalated: false, answer: "Yes, it exists." } };
        return undefined;
      };
      const id = await h.manager.dispatch({
        title: "read: does X exist",
        workspace: process.cwd(),
        brief: "read: does the auth check exist",
        lane: "read",
      });
      const state = await h.pollTerminal(id);
      await h.waitIdle(id);
      check("read-lane task reaches a terminal state via the reader only", state === "done" || state === "closed", `got ${state}`);
      check("only the reader ran — no planner, no QA, despite both being enabled", h.roleCalls.length === 1 && h.roleCalls[0] === "reader", h.roleCalls.join(","));
      check("no routeDecision was ever computed for a read-lane task", h.db.getThreadStageOutputs(id).routeDecision == null);
    } finally {
      h.dispose();
    }
  }

  // ---- 5. Sticky across resume — a route is decided ONCE per episode, never reclassified -----------
  console.log("\n5. Route pick is sticky: re-entering the pipeline doesn't reclassify or re-announce");
  {
    const h = makeHarness();
    try {
      const id = await h.manager.dispatch({ title: "typo fix", workspace: process.cwd(), brief: NARROW_BRIEF });
      await h.pollTerminal(id);
      await h.waitIdle(id);
      const firstDecision = h.db.getThreadStageOutputs(id).routeDecision;
      const firstAnnouncements = h.db.listMessages(id).filter((m: { kind: string; content: string }) => m.kind === "system" && /route selected/i.test(m.content)).length;
      // Re-enter the pipeline directly (mirroring a restart/resume re-invoking runPipeline on the same
      // thread) — resolveRoute must read the persisted decision back rather than reclassifying. The
      // thread's state is already terminal ('done') going in, so pollTerminal alone wouldn't wait for
      // this second run to actually execute — wait on the concurrency-slot bookkeeping instead.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (h.manager as any).startPipeline(id);
      await h.waitIdle(id);
      const secondDecision = h.db.getThreadStageOutputs(id).routeDecision;
      const secondAnnouncements = h.db.listMessages(id).filter((m: { kind: string; content: string }) => m.kind === "system" && /route selected/i.test(m.content)).length;
      check("the persisted route decision is unchanged", JSON.stringify(firstDecision) === JSON.stringify(secondDecision));
      check("no second route announcement was posted", secondAnnouncements === firstAnnouncements, `first=${firstAnnouncements} second=${secondAnnouncements}`);
    } finally {
      h.dispose();
    }
  }

  // ---- 6. Legacy decisions upgrade in place without replaying planner/QA -----------------------------
  console.log("\n6. A pre-policy route gains truthful model evidence on resume");
  {
    const h = makeHarness();
    try {
      h.manager.setSettings({ autoModelSelection: true });
      const brief = `Investigate why stale business records remain visible to users and implement a durable end-to-end fix.

Trace ingestion sources, stored status timestamps, refresh jobs, query filters, caches, and user-facing results.
Handle existing data and future updates with a safe migration or backfill, then add broad regression coverage.`;
      const legacy = h.db.createThread({ title: "Repair stale production records", workspace: process.cwd(), rawPrompt: brief, brief });
      h.db.updateThreadStageOutputs(legacy.id, {
        routeDecision: {
          usePlanner: true,
          useQa: true,
          scope: "broad",
          reason: "broad or risk-bearing work (security/auth; data/destructive; open-ended/ambiguous) — keeping planning and QA",
          signals: ["security/auth", "data/destructive", "open-ended/ambiguous"],
        },
      });
      const decision = h.manager.resolveRoute(h.db.getThread(legacy.id), h.manager.settings());
      check("legacy planner/QA execution stays sticky", decision.usePlanner === true && decision.useQa === true && decision.scope === "broad", JSON.stringify(decision));
      check("legacy task gains the flagship Opus 5 floor", decision.policyVersion === 2 && decision.modelPolicy?.tier === "flagship" && decision.modelPolicy.preferredModel === "claude-opus-5", JSON.stringify(decision));
      check("the stale authoritative/auth false-positive is removed", !decision.signals.includes("security/auth"), JSON.stringify(decision.signals));
      check("the owner receives one actionable route update", h.db.listMessages(legacy.id).some((message: { content: string }) => /Route updated/i.test(message.content) && /flagship implementor required/i.test(message.content) && /claude-opus-5/i.test(message.content)), JSON.stringify(h.db.listMessages(legacy.id)));
    } finally {
      h.dispose();
    }
  }

  console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("Failures:\n" + failures.map((f) => `  - ${f}`).join("\n"));
    process.exit(1);
  }
}

await main();
