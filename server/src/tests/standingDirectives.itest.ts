/**
 * Integration test — an owner injection must persist as a STANDING directive for the rest of a task's
 * life, not just reach whichever session happened to be live when it arrived.
 *
 * The bug (task da523e71, 2026-09-04): the owner injected "pull the closed-location work to its own
 * branch, keep it separate from the menu-revision branch" mid-task. The live session at the time honored
 * it. Hours later, a reviewer fix round (`runReviewFixRound` -> `startResumedImplementor`) spawned a
 * brand-new implementor session, seeded from `stage_outputs.kickoff` (a frozen snapshot captured long
 * before the injection existed) plus that round's own director note (the reviewer's fix instructions,
 * which said nothing about branches). The fresh session never saw the branch constraint, checked out
 * whatever branch the shared checkout happened to have active, and committed the closure work onto it —
 * exactly the "agents forgot" the owner reported. `recordStandingDirective` durably records every
 * accepted injection; `standingDirectivesBlock`/`renderStandingDirectives` render the full list verbatim
 * (never lossy-summarized) into every kickoff-composing path.
 *
 * WHAT IS REAL vs. STUBBED
 *  - REAL: `injectThread`'s durable-recording branch, `startResumedImplementor` (all four resume shapes:
 *    no-prior-session, CLI, warm full-session, cold `composeResumeKickoff` reseed) called directly via the
 *    prototype (mirrors injectDuringQa's Test K-C), `freshReviewKickoff`, and a real `Db` + `EventHub`.
 *  - STUBBED: only `startImplementor` (captures the final kickoff text without spawning a real agent).
 *
 * Run:  npm run test:standing-directives   (from server/)   — or:
 *       npx tsx src/tests/standingDirectives.itest.ts
 * Exits non-zero if any assertion fails. Self-contained: creates a throwaway DB + workspace and removes them.
 */

process.env.CAP_RETRY_MS = "0";
process.env.ACCOUNT_PING_MS = "3600000";
process.env.FAST_ACCOUNT_PING_MS = "3600000";

import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountManager } from "../accounts/accountManager.js";
import type { SendOpts } from "../agents/runner.js";
import type { Thread } from "../types.js";

const { Db } = await import("../db/db.js");
const { EventHub } = await import("../events.js");
const { FileMemoryService } = await import("../memory/memory.js");
const { ThreadManager } = await import("../orchestrator/threadManager.js");

// ---- tiny assertion harness ------------------------------------------------------------------------
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
  auxToken(): undefined {
    return undefined;
  }
}

function sendText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text" ? String((b as { text?: string }).text ?? "") : ""))
    .join("\n");
}

class FakeRun {
  readonly sends: { text: string; opts?: SendOpts }[] = [];
  send(content: unknown, opts?: SendOpts): void {
    this.sends.push({ text: sendText(content), opts });
  }
  async interrupt(): Promise<void> {}
  async stop(): Promise<void> {}
}

interface Harness {
  mgr: InstanceType<typeof ThreadManager>;
  db: InstanceType<typeof Db>;
  dir: string;
  workspace: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  internals: any;
  dispose(): void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "standing-directives-"));
  const workspace = join(dir, "workspace");
  mkdirSync(workspace, { recursive: true });
  const db = new Db(join(dir, "orchestrator.sqlite"));
  const hub = new EventHub();
  const memory = new FileMemoryService(join(dir, "memory"));
  const mgr = new ThreadManager(db, hub, memory, new StubAccounts() as unknown as AccountManager);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = mgr as any;
  return {
    mgr,
    db,
    dir,
    workspace,
    internals,
    dispose() {
      if (internals.capSupervisor) clearInterval(internals.capSupervisor);
      db.raw.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 25));

function seedTask(h: Harness): string {
  const t = h.db.createThread({ title: "mock standing-directives task", workspace: h.workspace, rawPrompt: "do the thing" });
  h.db.updateThreadStageOutputs(t.id, { kickoff: "KICKOFF: mock brief and plan", planDone: true, approved: true });
  return t.id;
}

const BRANCH_DIRECTIVE = "please pull all of the closed-location work to a separate branch — keep it out of the menu-revision branch";

async function main(): Promise<void> {
  console.log("\n=== Standing owner directives integration test ===\n");

  // -- Test 1: an injection into a LIVE implementor is durably recorded, not just delivered live -------
  console.log("Test 1 — a live-delivered injection is ALSO recorded as a standing directive");
  {
    const h = makeHarness();
    try {
      const id = seedTask(h);
      h.db.updateThread(id, { state: "implementing" });
      const impl = new FakeRun();
      h.internals.live.set(id, { run: impl, runId: "run-1", accountId: "acct-a" });
      const r = await h.mgr.injectThread(id, BRANCH_DIRECTIVE, "append");
      check("the injection was accepted", r.ok, JSON.stringify(r));
      check("it reached the live session as usual", impl.sends.some((s) => s.text.includes("separate branch")), JSON.stringify(impl.sends));
      const stage = h.db.getThreadStageOutputs(id);
      check("it was durably recorded as a standing directive", (stage.standingDirectives ?? []).includes(BRANCH_DIRECTIVE), JSON.stringify(stage.standingDirectives));
      await settle();
    } finally {
      h.dispose();
    }
  }

  // -- Test 2 (the regression): a LATER resume that carries a totally different director note must ------
  // still surface the earlier standing directive. This is runReviewFixRound's exact shape: baseKickoff
  // is the frozen stage_outputs.kickoff, and the resume's own directorNote is the reviewer's fix message.
  console.log("\nTest 2 — a later resume with an unrelated director note still carries the earlier standing directive (no prior session)");
  {
    const h = makeHarness();
    try {
      const id = seedTask(h);
      h.db.updateThread(id, { state: "implementing" });
      const impl = new FakeRun();
      h.internals.live.set(id, { run: impl, runId: "run-1", accountId: "acct-a" });
      await h.mgr.injectThread(id, BRANCH_DIRECTIVE, "append");
      h.internals.live.delete(id); // the live session ended; a later resume starts fresh

      const starts: { text: string }[] = [];
      h.internals.startImplementor = (_t: Thread, text: string): { run: FakeRun; runId: string; accountId: string } => {
        starts.push({ text });
        return { run: new FakeRun(), runId: "fresh-run", accountId: "acct-a" };
      };
      const realStartResumed = (ThreadManager.prototype as unknown as {
        startResumedImplementor: (...args: unknown[]) => Promise<unknown>;
      }).startResumedImplementor.bind(h.mgr);

      const thread = h.db.getThread(id)!;
      const baseKickoff = h.db.getThreadStageOutputs(id).kickoff!;
      const REVIEWER_FIX_NOTE = "The reviewer flagged an unrelated race condition in the run guard — fix that.";
      await realStartResumed(thread, baseKickoff, undefined, {
        resumeNudge: REVIEWER_FIX_NOTE,
        directorNote: REVIEWER_FIX_NOTE,
        qaFollows: false,
      });

      check("exactly one fresh implementor was started", starts.length === 1, `starts=${starts.length}`);
      const text = starts[0]?.text ?? "";
      check("the fresh kickoff carries this resume's own director note", text.includes("race condition in the run guard"), text);
      check(
        "the fresh kickoff ALSO carries the earlier standing directive, though it was never mentioned in this resume's note",
        text.includes(BRANCH_DIRECTIVE),
        text,
      );
      await settle();
    } finally {
      h.dispose();
    }
  }

  // -- Test 3: the cold `composeResumeKickoff` reseed path (old/no session) carries it too --------------
  console.log("\nTest 3 — a cold compressed-handoff reseed also carries the standing directive");
  {
    const h = makeHarness();
    const oldProjectsDir = process.env.CLAUDE_PROJECTS_DIR;
    try {
      const projectsDir = join(h.dir, "claude-projects");
      const projectDir = join(projectsDir, "workspace");
      mkdirSync(projectDir, { recursive: true });
      process.env.CLAUDE_PROJECTS_DIR = projectsDir;

      const id = seedTask(h);
      h.db.updateThread(id, { state: "implementing" });
      const impl = new FakeRun();
      h.internals.live.set(id, { run: impl, runId: "run-1", accountId: "acct-a" });
      await h.mgr.injectThread(id, BRANCH_DIRECTIVE, "append");
      h.internals.live.delete(id);

      const coldSession = "cold-claude-session";
      const coldPath = join(projectDir, `${coldSession}.jsonl`);
      writeFileSync(coldPath, ""); // empty transcript: compressSession finds it but strips to nothing — no Haiku call
      const old = new Date(Date.now() - 120 * 60_000);
      utimesSync(coldPath, old, old);
      h.db.updateRun(h.db.createRun({ threadId: id, role: "implementor", model: "claude-opus-5", account: "acct-a" }).id, { sessionId: coldSession });

      const starts: { text: string }[] = [];
      h.internals.startImplementor = (_t: Thread, text: string): { run: FakeRun; runId: string; accountId: string } => {
        starts.push({ text });
        return { run: new FakeRun(), runId: "fresh-run", accountId: "acct-a" };
      };
      const realStartResumed = (ThreadManager.prototype as unknown as {
        startResumedImplementor: (...args: unknown[]) => Promise<unknown>;
      }).startResumedImplementor.bind(h.mgr);

      const thread = h.db.getThread(id)!;
      const baseKickoff = h.db.getThreadStageOutputs(id).kickoff!;
      await realStartResumed(thread, baseKickoff, coldSession, {
        resumeNudge: "continue",
        directorNote: "Every Claude subscription hit its usage cap partway through this task, so you're taking over.",
        qaFollows: true,
      });

      check("exactly one cold-reseeded implementor was started", starts.length === 1, `starts=${starts.length}`);
      const text = starts[0]?.text ?? "";
      check("the cold seed is the real composeResumeKickoff output (names the resume)", text.includes("Resuming"), text.slice(0, 200));
      check("the cold seed carries the standing directive verbatim", text.includes(BRANCH_DIRECTIVE), text);
      await settle();
    } finally {
      if (oldProjectsDir == null) delete process.env.CLAUDE_PROJECTS_DIR;
      else process.env.CLAUDE_PROJECTS_DIR = oldProjectsDir;
      h.dispose();
    }
  }

  // -- Test 4: a warm full-session resume ALSO carries it (insurance against provider-side compaction) --
  // `config.resumeFullSession` is read once at module load, so the warm path here is forced the same way
  // Test K-C forces it: a transcript file with a fresh (current) mtime, under sessionAgeMs's warm cutoff.
  console.log("\nTest 4 — a warm full-session resume also carries the standing directive");
  {
    const h = makeHarness();
    const oldProjectsDir = process.env.CLAUDE_PROJECTS_DIR;
    try {
      const projectsDir = join(h.dir, "claude-projects-warm");
      const projectDir = join(projectsDir, "workspace");
      mkdirSync(projectDir, { recursive: true });
      process.env.CLAUDE_PROJECTS_DIR = projectsDir;

      const id = seedTask(h);
      h.db.updateThread(id, { state: "implementing" });
      const impl = new FakeRun();
      h.internals.live.set(id, { run: impl, runId: "run-1", accountId: "acct-a" });
      await h.mgr.injectThread(id, BRANCH_DIRECTIVE, "append");
      h.internals.live.delete(id);

      const warmSession = "warm-claude-session";
      writeFileSync(join(projectDir, `${warmSession}.jsonl`), ""); // fresh mtime = now, under the warm cutoff
      h.db.updateRun(h.db.createRun({ threadId: id, role: "implementor", model: "claude-opus-5", account: "acct-a" }).id, { sessionId: warmSession });

      const starts: { text: string; resume?: string }[] = [];
      h.internals.startImplementor = (_t: Thread, text: string, opts?: { resume?: string }): { run: FakeRun; runId: string; accountId: string } => {
        starts.push({ text, resume: opts?.resume });
        return { run: new FakeRun(), runId: "warm-run", accountId: "acct-a" };
      };
      const realStartResumed = (ThreadManager.prototype as unknown as {
        startResumedImplementor: (...args: unknown[]) => Promise<unknown>;
      }).startResumedImplementor.bind(h.mgr);

      const thread = h.db.getThread(id)!;
      const baseKickoff = h.db.getThreadStageOutputs(id).kickoff!;
      await realStartResumed(thread, baseKickoff, warmSession, {
        resumeNudge: "Continue where you left off.",
        directorNote: "Continue where you left off.",
        qaFollows: false,
      });

      check("the warm resume path was taken", starts.some((s) => s.resume === warmSession), JSON.stringify(starts));
      check("the warm resume nudge also carries the standing directive", starts.some((s) => s.text.includes(BRANCH_DIRECTIVE)), JSON.stringify(starts));
      await settle();
    } finally {
      if (oldProjectsDir == null) delete process.env.CLAUDE_PROJECTS_DIR;
      else process.env.CLAUDE_PROJECTS_DIR = oldProjectsDir;
      h.dispose();
    }
  }

  // -- Test 5: the reviewer's own kickoff also carries the standing directive, so a violation is --------
  // catchable at the acceptance gate, not just at the implementor.
  console.log("\nTest 5 — the reviewer's kickoff carries the standing directive too");
  {
    const h = makeHarness();
    try {
      const id = seedTask(h);
      await h.mgr.injectThread(id, BRANCH_DIRECTIVE, "queue"); // no live agent — durable record only
      const thread = h.db.getThread(id)!;
      const kickoff = sendText(h.internals.freshReviewKickoff(thread));
      check("the reviewer kickoff carries the standing directive", kickoff.includes(BRANCH_DIRECTIVE), kickoff);
      await settle();
    } finally {
      h.dispose();
    }
  }

  // -- Test 6: repeating the same steering note verbatim does not pad the durable list -------------------
  console.log("\nTest 6 — an exact repeat of the last directive does not duplicate in the standing list");
  {
    const h = makeHarness();
    try {
      const id = seedTask(h);
      h.db.updateThread(id, { state: "implementing" });
      const impl = new FakeRun();
      h.internals.live.set(id, { run: impl, runId: "run-1", accountId: "acct-a" });
      await h.mgr.injectThread(id, BRANCH_DIRECTIVE, "append");
      await h.mgr.injectThread(id, BRANCH_DIRECTIVE, "append"); // the owner, frustrated, repeats itself
      const stage = h.db.getThreadStageOutputs(id);
      const count = (stage.standingDirectives ?? []).filter((d) => d === BRANCH_DIRECTIVE).length;
      check("the exact repeat was not appended a second time", count === 1, JSON.stringify(stage.standingDirectives));
      await settle();
    } finally {
      h.dispose();
    }
  }

  // -- Test 7: a NON-owner injection must not become an "owner instruction" ----------------------------
  // route() reuses injectThread to hand a critical finding to the live implementor, and the supervisor
  // watchdog reuses it for its own correction. Both are transient agent-to-agent steering aimed at the
  // session that is live right now; the rendered block asserts every line came from the owner, so
  // recording one would pin stale agent noise into every later kickoff under a false attribution.
  console.log("\nTest 7 — a routed critical finding / supervisor correction is NOT recorded as an owner directive");
  {
    const h = makeHarness();
    try {
      const id = seedTask(h);
      h.db.updateThread(id, { state: "implementing" });
      const impl = new FakeRun();
      h.internals.live.set(id, { run: impl, runId: "run-1", accountId: "acct-a" });

      // A real agent-posted critical finding on this task — postFinding calls route(), which injects it.
      h.mgr.postFinding({
        threadId: id,
        fromRole: "qa",
        fromRunId: "some-other-run",
        summary: "The login test is failing right now",
        severity: "critical",
      });
      await settle();
      check(
        "the critical finding still reached the live implementor",
        impl.sends.some((s) => s.text.includes("login test is failing")),
        JSON.stringify(impl.sends),
      );
      check(
        "but it was NOT recorded as a standing owner directive",
        !(h.db.getThreadStageOutputs(id).standingDirectives ?? []).some((d) => d.includes("login test is failing")),
        JSON.stringify(h.db.getThreadStageOutputs(id).standingDirectives),
      );

      // The autonomous Supervisor correction takes the same non-standing route...
      await h.mgr.injectSupervisorCorrection(id, "You appear stalled — report your current status.");
      // ...while Supervisor CHAT relays the OWNER's own words and must still persist.
      await h.mgr.injectSupervisorInstruction(id, BRANCH_DIRECTIVE, "append");
      const directives = h.db.getThreadStageOutputs(id).standingDirectives ?? [];
      check(
        "the autonomous supervisor correction was not recorded either",
        !directives.some((d) => d.includes("report your current status")),
        JSON.stringify(directives),
      );
      check(
        "an owner instruction relayed through supervisor chat IS still recorded",
        directives.some((d) => d.includes(BRANCH_DIRECTIVE)),
        JSON.stringify(directives),
      );
      // Same boundary, second symptom: neither non-owner path is a change of objective, so neither may
      // rename the owner's lane. Both used to, relabelling the card with the finding / stall nudge text.
      check(
        "neither non-owner injection renamed the owner's task card",
        h.db.getThread(id)?.title === "mock standing-directives task",
        h.db.getThread(id)?.title,
      );
      await settle();
    } finally {
      h.dispose();
    }
  }

  // -- Test 7b: QA's kickoff renders the block too — QA is the gate that ships the task, so it is the
  // independent check that can catch a violated directive (a mixed branch) before the work lands.
  console.log(`\nTest 7b — the QA kickoff carries the standing directive as well`);
  {
    const { qaFixFreshKickoff } = await import("../orchestrator/threadManager.js");
    const h = makeHarness();
    try {
      const id = seedTask(h);
      await h.mgr.injectThread(id, BRANCH_DIRECTIVE, "queue");
      const thread = h.db.getThread(id)!;
      const directives = h.db.getThreadStageOutputs(id).standingDirectives;
      const kickoff = qaFixFreshKickoff(thread, undefined, "prior fix summary", [], directives);
      check("the QA kickoff carries the standing directive", kickoff.includes(BRANCH_DIRECTIVE), kickoff);
      check(
        "…under the owner-instruction heading QA is told to check the work against",
        kickoff.includes("Owner instructions given during this task"),
        kickoff,
      );
      await settle();
    } finally {
      h.dispose();
    }
  }

  // -- Test 8: a Retry re-runs the ORIGINAL brief, so the owner's corrections to that brief must survive --
  // resetThreadForRetry wipes stage_outputs; it already excepted the reader-escalation evidence as
  // "original user context". A standing directive is the same class of context - dropping it puts the
  // retry straight back into the reported failure ("I told it to branch and it forgot").
  console.log(`\nTest 8 — a from-scratch Retry preserves the standing directives (and the reader escalation)`);
  {
    const h = makeHarness();
    try {
      const id = seedTask(h);
      h.db.updateThreadStageOutputs(id, {
        readerEscalation: { originalBrief: "the original brief", reason: "needs an edit", answer: "the reader read it" },
      });
      h.db.updateThread(id, { state: "implementing" });
      const impl = new FakeRun();
      h.internals.live.set(id, { run: impl, runId: "run-1", accountId: "acct-a" });
      await h.mgr.injectThread(id, BRANCH_DIRECTIVE, "append");
      h.internals.live.delete(id);

      h.db.resetThreadForRetry(id);
      const stage = h.db.getThreadStageOutputs(id);
      check("the standing directive survived the retry wipe", (stage.standingDirectives ?? []).includes(BRANCH_DIRECTIVE), JSON.stringify(stage));
      check("the reader escalation evidence still survives too", stage.readerEscalation?.originalBrief === "the original brief", JSON.stringify(stage));
      check("the rest of the stage outputs were still wiped", stage.kickoff == null && stage.planDone !== true, JSON.stringify(stage));
      await settle();
    } finally {
      h.dispose();
    }
  }

  console.log(`\n=== RESULT: ${failed === 0 ? "PASS ✅" : "FAIL ❌"} — ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.log("Failures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("test harness error:", e);
  process.exit(2);
});
