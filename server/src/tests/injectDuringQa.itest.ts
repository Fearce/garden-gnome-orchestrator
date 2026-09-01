/**
 * Integration test — append steering during QA must stay non-destructive, while "Interrupt & inject"
 * must stop/supersede QA and return the same task to implementation (real ThreadManager machinery).
 *
 * Regression guard for: clicking "Interrupt & inject" while QA was reviewing accepted the injection but
 * left QA running. The stale QA could then mark the task done or park it even though the owner wanted the
 * same task back in implementation with the injected instruction.
 *
 * WHAT IS REAL vs. STUBBED
 *  - REAL: `injectThread` / `resumeThread` and every gate they walk, `runImplementorQaLoop`, `runQA` and
 *    its verdict reading, plus the real `Db` + `EventHub` behind them.
 *  - STUBBED: only the agent-spawning leaves — `runRole` (which stands up a fake QA run, registering it in
 *    `liveQa` exactly as the real one does), the implementor start/await, and `stopLive`.
 *  - The fake agent models the CLI's relevant behavior: `stop()`/`interrupt()` aborts the turn, and the
 *    test can also force a stale verdict after stop to prove the loop ignores superseded QA output.
 *
 * Run:  npm run test:inject-qa   (from server/)   — or:  npx tsx src/tests/injectDuringQa.itest.ts
 * Exits non-zero if any assertion fails. Self-contained: creates a throwaway DB + workspace and removes them.
 */

process.env.CAP_RETRY_MS = "0"; // no cap-supervisor interval during the test
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
const { CodexAgentRun } = await import("../agents/codexRunner.js");
const { ThreadManager, ownerRequestsFinishWithoutQa } = await import("../orchestrator/threadManager.js");
const { handleCommand } = await import("../ws/hub.js");

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

/** Text out of whatever shape `send` was handed (a string, or content blocks with images). */
function sendText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text" ? String((b as { text?: string }).text ?? "") : ""))
    .join("\n");
}

function sendImageCount(content: unknown): number {
  return Array.isArray(content)
    ? content.filter((b) => b && typeof b === "object" && (b as { type?: string }).type === "image").length
    : 0;
}

/**
 * A running agent, faithful on the one axis this test is about: how it reacts to steering. A `priority:
 * "now"` send and an `interrupt()` both abort the turn — that is what the CLI does, and what makes a
 * reverted fix show up here as a dead task rather than as a failed flag assertion.
 */
class FakeRun {
  readonly sends: { text: string; images: number; opts?: SendOpts }[] = [];
  sessionId?: string;
  interrupts = 0;
  stops = 0;
  aborted = false;
  stopped = false;
  stopError?: Error;
  send(content: unknown, opts?: SendOpts): void {
    this.sends.push({ text: sendText(content), images: sendImageCount(content), opts });
    if (opts?.priority === "now") this.aborted = true;
  }
  async interrupt(): Promise<void> {
    this.interrupts++;
    this.aborted = true;
  }
  async stop(): Promise<void> {
    this.stops++;
    if (this.stopError) throw this.stopError;
    this.stopped = true;
    this.aborted = true;
  }
}

/** The verdict-less result an aborted turn produces: success-shaped, no structuredOutput. */
const ABORTED = { type: "result", subtype: "success", isError: false };
const verdictResult = (structuredOutput: { pass: boolean; summary: string; changed: boolean }) => ({
  type: "result",
  subtype: "success",
  isError: false,
  structuredOutput,
});
const IMG = { name: "qa-note.png", mediaType: "image/png" as const, dataBase64: "iVBORw0KGgo=" };
const NO_QA_DIRECTIVE = "we dont need QA here just end the task thx";

interface Harness {
  mgr: InstanceType<typeof ThreadManager>;
  db: InstanceType<typeof Db>;
  dir: string;
  workspace: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  internals: any;
  drained: string[][];
  resumes: string[];
  resumeImages: number[];
  dispose(): void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "inject-qa-"));
  const workspace = join(dir, "workspace");
  mkdirSync(workspace, { recursive: true });
  const db = new Db(join(dir, "orchestrator.sqlite"));
  const hub = new EventHub();
  const memory = new FileMemoryService(join(dir, "memory"));
  const mgr = new ThreadManager(db, hub, memory, new StubAccounts() as unknown as AccountManager);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = mgr as any;
  const drained: string[][] = [];
  const resumes: string[] = [];
  const resumeImages: number[] = [];
  internals.startResumedImplementor = async (_t: Thread, _kickoff: string, _resume: unknown, opts?: { resumeNudge?: string; images?: unknown[] }): Promise<{ run: FakeRun; runId: string; accountId: string; account: { id: string } }> => {
    if (opts?.resumeNudge) resumes.push(opts.resumeNudge);
    resumeImages.push(opts?.images?.length ?? 0);
    return { run: new FakeRun(), runId: "stub-implementor-run", accountId: "acct-a", account: { id: "acct-a" } };
  };
  internals.awaitImplementorCompletion = async (): Promise<{ isError: boolean }> => ({ isError: false });
  internals.stopLive = async (): Promise<void> => {};
  internals.runSelfImprovement = async (): Promise<void> => {};
  internals.flushDirectorNotes = (): void => {};
  // Record what the queue held each time the pipeline drained it, then clear it like the real one does —
  // that recording is the proof the injected direction actually reaches the implementor.
  internals.drainQueuedImplementor = async (t: Thread, _e: unknown, _k: string, res: unknown): Promise<unknown> => {
    const q = internals.queuedForImplementor.get(t.id);
    if (q?.length) {
      drained.push([...q]);
      internals.queuedForImplementor.delete(t.id);
      const rows = internals.reviewInjections.pendingImplementor(t.id, "qa", null);
      if (rows.length) {
        internals.reviewInjections.markImplementorDelivered(rows.map((row: { id: string }) => row.id), "stub-queue-run");
        internals.reviewInjections.resolve(rows.map((row: { id: string }) => row.id), "Test implementor completed the queued QA instruction.");
      }
    }
    return res;
  };

  return {
    mgr,
    db,
    dir,
    workspace,
    internals,
    drained,
    resumes,
    resumeImages,
    dispose() {
      if (internals.capSupervisor) clearInterval(internals.capSupervisor);
      db.raw.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Every inject fires an auto-retitle that is deliberately un-awaited (`void`), so it lands a tick or two
 *  after the call returns. Yield to it before closing the DB, or its write throws into the next test. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 25));

function seedTask(h: Harness): string {
  const t = h.db.createThread({ title: "mock qa-inject task", workspace: h.workspace, rawPrompt: "do the thing" });
  h.db.updateThreadStageOutputs(t.id, { kickoff: "KICKOFF: mock", planDone: true, approved: true });
  return t.id;
}

const runLoop = (h: Harness, id: string, maxQaRounds = 4, qaEnabled = true): Promise<void> =>
  h.internals.runImplementorQaLoop(h.db.getThread(id)!, "KICKOFF: mock", undefined, undefined, undefined, {
    qaEnabled,
    maxQaRounds,
    qaAppliesFixes: false,
    autoPush: true,
  });

/**
 * Stub the leaf BELOW runQA so the real runQA + the real loop run. The fake QA registers itself in
 * `liveQa` exactly as the real `runRole` does, then hands control to `whileLive` — that callback is the
 * test's window to inject "while QA is running". An aborted turn returns the verdict-less result.
 */
function stubQaRunRole(
  h: Harness,
  whileLive: (qa: FakeRun) => Promise<void>,
  opts: { staleVerdictAfterStop?: boolean; verdicts?: Array<{ pass: boolean; summary: string; changed: boolean }> } = {},
): FakeRun[] {
  const agents: FakeRun[] = [];
  h.internals.runRole = async (t: Thread, role: string): Promise<unknown> => {
    const agent = new FakeRun();
    agents.push(agent);
    h.internals.liveQa.set(t.id, agent);
    const run = h.db.createRun({ threadId: t.id, role: role as "qa", model: "claude-opus-5", account: "acct-a" });
    h.internals.liveQaRunId.set(t.id, run.id);
    await whileLive(agent);
    h.internals.liveQa.delete(t.id);
    h.internals.liveQaRunId.delete(t.id);
    const stopped = agent.stopped || agent.aborted;
    const verdict = opts.verdicts?.[agents.length - 1] ?? { pass: true, summary: "verified", changed: false };
    const superseded = h.internals.qaSuperseded(t.id) === true;
    const first = stopped && !opts.staleVerdictAfterStop ? ABORTED : verdictResult(verdict);
    let res: unknown = first;
    if (!superseded) {
      const pending = h.internals.reviewInjections.pendingReviewer(t.id, "qa", null) as Array<{ id: string }>;
      const labels = pending.map((row) => `RI-${row.id.slice(0, 8)}`).join(" + ");
      const acknowledged = pending.length
        ? verdictResult({ ...verdict, summary: `ACK ${labels}: ${verdict.summary}` })
        : first;
      Object.assign(agent, {
        finished: false,
        result: async () => first,
        nextResult: async () => acknowledged,
      });
      res = await h.internals.awaitStructuredReviewResult(t, "qa", agent, run.id);
    }
    agent.sessionId = "qa-session";
    h.internals.finishRun(run.id, res, agent, superseded ? "interrupted" : undefined);
    return superseded ? undefined : res;
  };
  return agents;
}

async function main(): Promise<void> {
  console.log("\n=== QA inject/interrupt routing integration test ===\n");

  console.log("Owner finish-without-QA intent grammar");
  check("the exact owner directive is recognized", ownerRequestsFinishWithoutQa(NO_QA_DIRECTIVE));
  check("Unicode punctuation and contractions are recognized", ownerRequestsFinishWithoutQa("we don\u2019t need QA here \u2014 just end the task, thx"));
  check("an explicit negative does not bypass QA", !ownerRequestsFinishWithoutQa("don't skip QA; finish after QA passes"));
  check("a nested negative does not bypass QA", !ownerRequestsFinishWithoutQa("we don't need to skip QA; finish the task after review"));
  check("never-skip phrasing does not bypass QA", !ownerRequestsFinishWithoutQa("never skip QA; finish the task after it passes"));
  check("ordinary QA sequencing does not bypass QA", !ownerRequestsFinishWithoutQa("fix this before QA"));

  // -- Test A (the bug): interrupt-mode inject during QA returns the task to implementation ------------
  console.log("Test A — 'Interrupt & inject' while QA reviews: QA stops and implementation resumes");
  {
    const h = makeHarness();
    try {
      const id = seedTask(h);
      let injected = false;
      const agents = stubQaRunRole(h, async () => {
        if (injected) return;
        injected = true;
        const r = await h.mgr.injectThread(id, "scrap the button, add an item blacklist instead", "interrupt", [IMG]);
        check("the interrupt was accepted as an implementation resume", r.ok && r.state === "implementing", JSON.stringify(r));
      });
      await runLoop(h, id);
      const firstQa = agents[0]!;
      check("the task was NOT parked for review", h.db.getThread(id)?.state !== "review", `state=${h.db.getThread(id)?.state}`);
      check("the task re-ran QA after the resumed implementation and settled done", h.db.getThread(id)?.state === "done", `state=${h.db.getThread(id)?.state}`);
      check("the interrupted QA run was stopped", firstQa.stops === 1 && firstQa.stopped, `stops=${firstQa.stops}`);
      check("the interrupt did not try to steer QA as a normal send", firstQa.sends.length === 0, JSON.stringify(firstQa.sends));
      check("a fresh QA pass ran after implementation resumed", agents.length === 2, `qaRuns=${agents.length}`);
      check(
        "the injected direction was explicit context for the resumed implementor",
        h.resumes.some((m) => m.includes("item blacklist") && m.includes("QA was interrupted")),
        JSON.stringify(h.resumes),
      );
      check("the attached QA interrupt image reached the resumed implementor", h.resumeImages.some((n) => n === 1), JSON.stringify(h.resumeImages));
      const feed = h.db.listMessages(id).map((m) => m.content);
      check("the feed says QA is being returned to the implementor", feed.some((c) => c.includes("interrupt requested") && c.includes("returning to the implementor")), JSON.stringify(feed.filter((c) => c.includes("interrupt")).slice(0, 3)));
      check("the durable QA supersede marker was cleared after resume", !h.db.getThreadStageOutputs(id).qaSuperseded, JSON.stringify(h.db.getThreadStageOutputs(id).qaSuperseded));
      await settle();
    } finally {
      h.dispose();
    }
  }

  // -- Test B: append mode still steers QA non-destructively -------------------------------------------
  console.log("\nTest B — append mode takes the same non-destructive route");
  {
    const h = makeHarness();
    try {
      const id = seedTask(h);
      let injected = false;
      const agents = stubQaRunRole(h, async () => {
        if (injected) return;
        injected = true;
        await h.mgr.injectThread(id, "also cover the offhand slot", "append");
      });
      await runLoop(h, id);
      check("the task settled done", h.db.getThread(id)?.state === "done", `state=${h.db.getThread(id)?.state}`);
      check("the appended note carried no priority either", agents[0]!.sends[0]!.opts?.priority === undefined, String(agents[0]!.sends[0]!.opts?.priority));
      check("it was queued for the implementor too", h.drained.some((q) => q.some((m) => m.includes("offhand slot"))), JSON.stringify(h.drained));
      check("append did not stop the first QA run", agents[0]!.stops === 0 && !agents[0]!.stopped, `stops=${agents[0]!.stops}`);
      await settle();
    } finally {
      h.dispose();
    }
  }

  // -- Test C: the fix-round window (state 'qa', no live QA handle) joins the existing handoff ---------
  // QA has returned but the re-launched implementor isn't live yet, so there is nothing to steer. The
  // note must not spawn an implementor beside the pipeline, must not be dropped, and must not arm a
  // second QA-supersede resume.
  console.log("\nTest C — an interrupt in the QA-fix handoff is queued for that same resume");
  {
    const h = makeHarness();
    try {
      const id = seedTask(h);
      h.db.updateThread(id, { state: "qa" });
      h.internals.qaFixHandoff.add(id);
      let spawned = 0;
      h.internals.startResumedImplementor = async (): Promise<unknown> => {
        spawned++;
        return { run: new FakeRun(), runId: "test-c-run", accountId: "acct-a" };
      };
      const r = await h.mgr.injectThread(id, "use the addon options panel", "interrupt");
      check("the inject was accepted in the existing qa handoff", r.ok && r.state === "qa", JSON.stringify(r));
      check("the visible task state stayed truthful until the implementor is live", h.db.getThread(id)?.state === "qa", `state=${h.db.getThread(id)?.state}`);
      check("no implementor was spawned beside the pipeline", spawned === 0, `spawns=${spawned}`);
      check("no QA supersede marker was armed", !h.db.getThreadStageOutputs(id).qaSuperseded, JSON.stringify(h.db.getThreadStageOutputs(id).qaSuperseded));
      check("the note is persisted for the active implementor resume", (h.db.getThreadStageOutputs(id).qaFixHandoff?.messages ?? []).some((m) => m.includes("addon options")), JSON.stringify(h.db.getThreadStageOutputs(id).qaFixHandoff));
      check("the old in-memory note buffer was not used", !(h.internals.directorNotes.get(id) ?? []).some((m: string) => m.includes("addon options")), JSON.stringify(h.internals.directorNotes.get(id)));
      check("the note is not queued as a later follow-up", !(h.internals.queuedForImplementor.get(id) ?? []).some((m: string) => m.includes("addon options")), JSON.stringify(h.internals.queuedForImplementor.get(id)));
      await settle();
    } finally {
      h.dispose();
    }
  }

  // -- Test D: a stale QA verdict after stop cannot settle the task -----------------------------------
  console.log("\nTest D — stale QA pass after a QA interrupt is ignored");
  {
    const h = makeHarness();
    try {
      const id = seedTask(h);
      let interrupted = false;
      const agents = stubQaRunRole(
        h,
        async () => {
          if (interrupted) return;
          interrupted = true;
          const r = await h.mgr.interruptThread(id);
          check("the bare interrupt was accepted as an implementation resume", r.ok && r.state === "implementing", JSON.stringify(r));
        },
        { staleVerdictAfterStop: true },
      );
      await runLoop(h, id);
      check("the first QA run was stopped", agents[0]!.stops === 1 && agents[0]!.stopped, `stops=${agents[0]!.stops}`);
      check("the stale pass did not finish the pipeline directly", agents.length === 2, `qaRuns=${agents.length}`);
      const qaRuns = h.db.listRuns(id).filter((r) => r.role === "qa").sort((a, b) => a.startedAt - b.startedAt);
      check("the superseded stale QA run was persisted as interrupted", qaRuns[0]?.state === "interrupted", JSON.stringify(qaRuns.map((r) => ({ role: r.role, state: r.state }))));
      check("the task settled done only after a fresh QA pass", h.db.getThread(id)?.state === "done", `state=${h.db.getThread(id)?.state}`);
      check(
        "the resumed implementor received the no-message QA interrupt context",
        h.resumes.some((m) => m.includes("No extra instruction was supplied") && m.includes("QA was interrupted")),
        JSON.stringify(h.resumes),
      );
      const qaFindings = h.db.listFindings(id).filter((f) => f.fromRole === "qa" && f.summary.includes("QA passed"));
      check("only the fresh QA pass posted an acceptance finding", qaFindings.length === 1, JSON.stringify(qaFindings.map((f) => f.summary)));
      await settle();
    } finally {
      h.dispose();
    }
  }

  // -- Test E: Resume-with-a-message during QA is the same gate, and had the same defect ---------------
  console.log("\nTest E — a Resume carrying a message during QA steers rather than aborts");
  {
    const h = makeHarness();
    try {
      const id = seedTask(h);
      h.db.updateThread(id, { state: "qa" });
      const qa = new FakeRun();
      h.internals.liveQa.set(id, qa);
      const r = await h.mgr.resumeThread(id, "check the blacklist path too");
      check("the resume stayed in the qa stage", r.ok && r.state === "qa", JSON.stringify(r));
      check("QA was not aborted by the resume", !qa.aborted && qa.interrupts === 0);
      check("the resume's steering reached QA with no priority", qa.sends.length === 1 && qa.sends[0]!.opts?.priority === undefined, JSON.stringify(qa.sends[0]?.opts));
      check(
        "and is queued for the implementor, so a QA pass can't settle the task with it unread",
        (h.internals.queuedForImplementor.get(id) ?? []).some((m: string) => m.includes("blacklist path")),
        JSON.stringify(h.internals.queuedForImplementor.get(id)),
      );
      await settle();
    } finally {
      h.dispose();
    }
  }

  // -- Test F: append is a fenced reviewer turn, while interrupt has explicit supersede semantics ------
  console.log("\nTest F — an append during Auto-review reaches the exact run and fences its stale verdict");
  {
    const h = makeHarness();
    try {
      const id = seedTask(h);
      h.db.updateThread(id, { state: "reviewing" });
      const reviewer = new FakeRun();
      h.internals.liveReviewer.set(id, reviewer);
      const run = h.db.createRun({ threadId: id, role: "reviewer", model: "claude-opus-5", account: "acct-a" });
      h.internals.liveReviewerRunId.set(id, run.id);
      h.internals.reviewing.add(id);
      const r = await h.mgr.injectThread(id, "the deliverable link is broken", "append", [IMG]);
      check("the inject was accepted in the reviewing state", r.ok && r.state === "reviewing", JSON.stringify(r));
      check("the reviewer was not aborted", !reviewer.aborted && reviewer.interrupts === 0);
      check("the reviewer's steering carried no priority", reviewer.sends.length === 1 && reviewer.sends[0]!.opts?.priority === undefined, JSON.stringify(reviewer.sends[0]?.opts));
      const row = h.internals.reviewInjections.listThread(id)[0] as { id: string; status: string; reviewerRunId: string; attachmentIds: string[] };
      check("delivery names the exact persisted reviewer run", row.status === "delivered_reviewer" && row.reviewerRunId === run.id, JSON.stringify(row));
      check("the image reached the reviewer and remains in durable history", reviewer.sends[0]?.images === 1 && row.attachmentIds.length === 1 && h.db.listMessages(id).some((m) => m.attachments?.length === 1), JSON.stringify(reviewer.sends[0]));

      const label = `RI-${row.id.slice(0, 8)}`;
      const stale = { type: "result", subtype: "success", isError: false, structuredOutput: { accept: true, summary: "fine" } };
      const steered = { type: "result", subtype: "success", isError: false, structuredOutput: { accept: false, summary: `ACK ${label}: the broken deliverable needs an implementor fix`, issues: [{ severity: "major", description: "repair the deliverable link" }] } };
      Object.assign(reviewer, { finished: false, result: async () => stale, nextResult: async () => steered });
      const result = await h.internals.awaitStructuredReviewResult(h.db.getThread(id), "reviewer", reviewer, run.id);
      const acknowledged = h.internals.reviewInjections.get(row.id) as { status: string; reviewerAcknowledgement: string };
      check("the stale verdict was replaced by the acknowledged steered verdict", result === steered && acknowledged.status === "acknowledged_reviewer", JSON.stringify(result));
      check("the visible feed records accepted, delivered, paused, and acknowledged states", ["[accepted]", "[delivered]", "[waiting]", "[acknowledged]"].every((marker) => h.db.listMessages(id).some((m) => m.content.includes(marker))), JSON.stringify(h.db.listMessages(id).map((m) => m.content)));
      await settle();
    } finally {
      h.dispose();
    }
  }

  console.log("\nTest F1 — a Codex-backed auto-review append interrupts the current CLI batch");
  {
    const h = makeHarness();
    try {
      const id = seedTask(h);
      h.db.updateThread(id, { state: "reviewing" });
      const reviewer = new CodexAgentRun({ model: "gpt-5.6", effort: "low", cwd: h.workspace, apiKey: "test-key" });
      const cli = reviewer as unknown as {
        turnActive: boolean;
        sessionId: string;
        requestInterrupt(): void;
      };
      cli.turnActive = true;
      cli.sessionId = "live-codex-reviewer";
      let interrupts = 0;
      cli.requestInterrupt = () => {
        interrupts++;
      };
      const run = h.db.createRun({ threadId: id, role: "reviewer", model: "gpt-5.6", account: "codex:gpt-5.6" });
      h.internals.liveReviewer.set(id, reviewer);
      h.internals.liveReviewerRunId.set(id, run.id);
      h.internals.reviewing.add(id);

      const r = await h.mgr.injectThread(id, "use the new reviewer instruction before deciding", "append", undefined, { retitle: false });
      const row = h.internals.reviewInjections.listThread(id)[0] as { reviewerRunId: string | null; status: string };
      check("the CLI-backed review inject was accepted", r.ok && r.state === "reviewing", JSON.stringify(r));
      check("delivery still names the exact persisted reviewer run", row.status === "delivered_reviewer" && row.reviewerRunId === run.id, JSON.stringify(row));
      check("Codex reviewer append used immediate batch steering", interrupts === 1, `interrupts=${interrupts}`);
    } finally {
      h.dispose();
    }
  }

  console.log("\nTest F2 — interrupt explicitly stops Auto-review and returns the instruction to implementation");
  {
    const h = makeHarness();
    try {
      const id = seedTask(h);
      h.db.updateThread(id, { state: "reviewing" });
      const reviewer = new FakeRun();
      h.internals.liveReviewer.set(id, reviewer);
      h.internals.reviewing.add(id);
      const r = await h.mgr.injectThread(id, "resolve the branch conflicts and push it", "interrupt", [IMG]);
      check("interrupt reports an implementation handoff", r.ok && r.state === "implementing", JSON.stringify(r));
      check("the reviewer was stopped instead of being sent another review turn", reviewer.stops === 1 && reviewer.sends.length === 0, JSON.stringify(reviewer.sends));
      await settle();
      const row = h.internals.reviewInjections.listThread(id)[0] as { status: string; implementorRunId: string | null };
      check("the instruction and image reached the resumed implementor", h.resumes.some((m) => m.includes("branch conflicts")) && h.resumeImages.some((n) => n === 1), JSON.stringify(h.resumes));
      check("the durable lifecycle records the implementor outcome", row.status === "handled" && row.implementorRunId === "stub-implementor-run", JSON.stringify(row));
    } finally {
      h.dispose();
    }
  }

  console.log("\nTest F3 — a reviewer-recipient verdict race never lies about delivery");
  {
    const h = makeHarness();
    try {
      const terminalId = seedTask(h);
      h.db.updateThread(terminalId, { state: "done" });
      const tooLate = await h.mgr.injectThread(
        terminalId,
        "this arrived after acceptance",
        "append",
        [IMG],
        { recipient: "reviewer" },
      );
      const terminalRow = h.internals.reviewInjections.listThread(terminalId)[0] as { status: string; reviewerRunId: string | null; attachmentIds: string[] };
      check("a terminal race is rejected as too late, not forwarded", !tooLate.ok && terminalRow.status === "too_late" && terminalRow.reviewerRunId == null, JSON.stringify({ tooLate, terminalRow }));
      check("the terminal record retains its image and names the failure", terminalRow.attachmentIds.length === 1 && h.db.listMessages(terminalId).some((m) => /too late/i.test(m.content) && /Nothing was delivered/.test(m.content)), JSON.stringify(h.db.listMessages(terminalId).map((m) => m.content)));

      const parkedId = seedTask(h);
      h.db.updateThread(parkedId, { state: "review", error: "review just settled" });
      const queued = await h.mgr.injectThread(
        parkedId,
        "carry this into implementation instead",
        "append",
        undefined,
        { recipient: "reviewer" },
      );
      const parkedRow = h.internals.reviewInjections.listThread(parkedId)[0] as { status: string; reviewerRunId: string | null; implementorRunId: string | null };
      check("a just-finished reviewer queues the instruction without inventing a live run", queued.ok && queued.state === "review" && parkedRow.status === "queued_implementor" && parkedRow.reviewerRunId == null && parkedRow.implementorRunId == null, JSON.stringify({ queued, parkedRow }));
    } finally {
      await settle();
      h.dispose();
    }
  }

  console.log("\nTest F4 — awaiting-user state keeps routing to the structured reviewer that owns it");
  {
    const h = makeHarness();
    try {
      const reviewId = seedTask(h);
      h.db.updateThread(reviewId, { state: "awaiting_user" });
      const reviewer = new FakeRun();
      const reviewerRun = h.db.createRun({ threadId: reviewId, role: "reviewer", model: "claude-opus-5", account: "acct-a" });
      h.internals.liveReviewer.set(reviewId, reviewer);
      h.internals.liveReviewerRunId.set(reviewId, reviewerRun.id);
      h.internals.reviewing.add(reviewId);
      const supervisor = await h.mgr.injectSupervisorInstruction(reviewId, "use the owner answer and re-check", "append", { liveOnly: true });
      const reviewerRow = h.internals.reviewInjections.listThread(reviewId)[0] as { reviewerRunId: string | null };
      check("Supervisor chat stays eligible while Auto-review awaits an answer", supervisor.ok && supervisor.state === "awaiting_user", JSON.stringify(supervisor));
      check("the awaiting reviewer receives the instruction on its exact run", reviewer.sends.length === 1 && reviewerRow.reviewerRunId === reviewerRun.id, JSON.stringify(reviewerRow));

      const qaId = seedTask(h);
      h.db.updateThread(qaId, { state: "awaiting_user" });
      const qa = new FakeRun();
      const qaRun = h.db.createRun({ threadId: qaId, role: "qa", model: "claude-opus-5", account: "acct-a" });
      h.internals.liveQa.set(qaId, qa);
      h.internals.liveQaRunId.set(qaId, qaRun.id);
      const qaAction = await h.mgr.injectThread(qaId, "QA should include this owner answer", "append", undefined, { recipient: "qa" });
      const qaRow = h.internals.reviewInjections.listThread(qaId)[0] as { reviewerRunId: string | null };
      check("QA awaiting owner input also remains the recipient", qaAction.ok && qaAction.state === "awaiting_user" && qa.sends.length === 1 && qaRow.reviewerRunId === qaRun.id, JSON.stringify({ qaAction, qaRow }));
    } finally {
      await settle();
      h.dispose();
    }
  }

  // -- Test G: the other half — a live IMPLEMENTOR must still be interruptible -------------------------
  // Over-correcting here would be just as wrong: steering an implementor mid-turn is the whole point of
  // the button, and that role has no verdict to lose.
  console.log("\nTest G — a live implementor is still interrupted and steered at 'now' priority");
  {
    const h = makeHarness();
    try {
      const id = seedTask(h);
      h.db.updateThread(id, { state: "implementing" });
      const impl = new FakeRun();
      h.internals.live.set(id, { run: impl, runId: "run-1", accountId: "acct-a" });
      const r = await h.mgr.injectThread(id, "stop and do it the other way", "interrupt");
      check("the inject reached the implementor", r.ok && r.state === "implementing", JSON.stringify(r));
      check("the implementor WAS interrupted", impl.interrupts === 1, `interrupts=${impl.interrupts}`);
      check("its steering kept 'now' priority", impl.sends[0]!.opts?.priority === "now", JSON.stringify(impl.sends[0]?.opts));
      await settle();
    } finally {
      h.dispose();
    }
  }

  // -- Test H: the WebSocket/UI command path returns a truthful action result -------------------------
  console.log("\nTest H — thread.inject over the WebSocket command path reports the QA interrupt result");
  {
    const h = makeHarness();
    try {
      const id = seedTask(h);
      h.db.updateThread(id, { state: "qa" });
      const qa = new FakeRun();
      h.internals.liveQa.set(id, qa);
      const sent: Array<Record<string, unknown>> = [];
      const socket = {
        OPEN: 1,
        readyState: 1,
        bufferedAmount: 0,
        send(raw: unknown) {
          sent.push(JSON.parse(String(raw)));
        },
      };
      await handleCommand({ manager: h.mgr } as Parameters<typeof handleCommand>[0], socket as unknown as Parameters<typeof handleCommand>[1], {
        type: "thread.inject",
        threadId: id,
        message: "switch QA back to implementation",
        mode: "interrupt",
        recipient: "qa",
      });
      const action = sent.find((e) => e.type === "thread.action");
      check("the socket sent a thread.action acknowledgment", !!action, JSON.stringify(sent));
      check("the acknowledgment is successful", action?.ok === true, JSON.stringify(action));
      check("the acknowledgment reports implementing, not qa", action?.state === "implementing", JSON.stringify(action));
      check("the acknowledgment explains the queued resume", String(action?.message ?? "").includes("implementor resume queued"), JSON.stringify(action));
      check("the QA handle was stopped through the UI command path", qa.stops === 1 && qa.stopped, `stops=${qa.stops}`);
      await settle();
    } finally {
      h.dispose();
    }
  }

  // -- Test I: a restart after the QA interrupt marker keeps the same QA round budget -----------------
  console.log("\nTest I — persisted QA interrupt returns to implementation without burning an extra QA round");
  {
    const h = makeHarness();
    try {
      const id = seedTask(h);
      h.db.updateThreadStageOutputs(id, {
        qaRoundsUsed: 1,
        qaSuperseded: { at: Date.now(), messages: ["finish the keyboard input branch before QA checks again"] },
      });
      const agents = stubQaRunRole(h, async () => {});
      await runLoop(h, id, 1);
      check("the persisted QA interrupt did not park at the round ceiling", h.db.getThread(id)?.state === "done", `state=${h.db.getThread(id)?.state}`);
      check(
        "the resumed implementor received the persisted interrupt instruction",
        h.resumes.some((m) => m.includes("keyboard input branch") && m.includes("QA was interrupted")),
        JSON.stringify(h.resumes),
      );
      check("QA rechecked the same charged round once after implementation resumed", agents.length === 1, `qaRuns=${agents.length}`);
      check("the persisted QA supersede marker was cleared", !h.db.getThreadStageOutputs(id).qaSuperseded, JSON.stringify(h.db.getThreadStageOutputs(id).qaSuperseded));
      await settle();
    } finally {
      h.dispose();
    }
  }

  // -- Test J: interrupt during the normal QA-fix handoff must not create a second resume -------------
  console.log("\nTest J — interrupt during the QA-to-fix handoff joins that one implementor resume");
  {
    const h = makeHarness();
    try {
      const id = seedTask(h);
      const starts: Array<{ nudge: string; run: FakeRun }> = [];
      let injectedDuringFixHandoff = false;
      h.internals.startResumedImplementor = async (_t: Thread, _kickoff: string, _resume: unknown, opts?: { resumeNudge?: string; images?: unknown[] }): Promise<{ run: FakeRun; runId: string; accountId: string; account: { id: string } }> => {
        const run = new FakeRun();
        starts.push({ nudge: opts?.resumeNudge ?? "", run });
        if (starts.length === 2 && !injectedDuringFixHandoff) {
          injectedDuringFixHandoff = true;
          const r = await h.mgr.injectThread(id, "normal messages and Discord must provide real conversation context", "interrupt");
          check("the handoff interrupt was accepted into the existing fix resume", r.ok && r.state === "qa", JSON.stringify(r));
        }
        return { run, runId: `test-j-run-${starts.length}`, accountId: "acct-a", account: { id: "acct-a" } };
      };
      const agents = stubQaRunRole(h, async () => {}, {
        verdicts: [
          { pass: false, summary: "context extraction still reads toolbar labels", changed: false },
          { pass: true, summary: "verified after fix", changed: false },
        ],
      });
      await runLoop(h, id, 4);
      const deliveryCount = starts.flatMap((start) => start.run.sends).filter((send) => send.text.includes("normal messages and Discord")).length;
      check("the task settled after the normal fix path", h.db.getThread(id)?.state === "done", `state=${h.db.getThread(id)?.state}`);
      check("exactly one initial implementation plus one QA fix implementation ran", starts.length === 2, `starts=${starts.length}`);
      check("exactly one failed QA and one final QA pass ran", agents.length === 2, `qaRuns=${agents.length}`);
      check("the injected handoff instruction was delivered exactly once", deliveryCount === 1, JSON.stringify(starts.map((start) => start.run.sends)));
      check("the handoff instruction was not left as a later queued follow-up", !h.drained.some((q) => q.some((m) => m.includes("normal messages and Discord"))), JSON.stringify(h.drained));
      check("the durable QA-fix handoff marker was cleared", !h.db.getThreadStageOutputs(id).qaFixHandoff, JSON.stringify(h.db.getThreadStageOutputs(id).qaFixHandoff));
      check("no QA supersede marker leaked into the next QA pass", !h.db.getThreadStageOutputs(id).qaSuperseded, JSON.stringify(h.db.getThreadStageOutputs(id).qaSuperseded));
      await settle();
    } finally {
      h.dispose();
    }
  }

  // -- Test K-A: no-live QA interrupt with an image must fail without queuing that image -------------
  console.log("\nTest K-A - no-live QA interrupt with an image fails without leaking the attachment");
  {
    const h = makeHarness();
    try {
      const id = seedTask(h);
      h.db.updateThread(id, { state: "qa" });
      const before = (h.db.raw.prepare("SELECT count(*) count FROM attachments").get() as { count: number }).count;
      const r = await h.mgr.injectThread(id, "this cannot stop a missing QA handle", "interrupt", [IMG]);
      const after = (h.db.raw.prepare("SELECT count(*) count FROM attachments").get() as { count: number }).count;
      check("the no-live QA interrupt is rejected", !r.ok && r.state === "qa", JSON.stringify(r));
      check("the rejected no-live interrupt did not persist the image blob", after === before, `before=${before} after=${after}`);
      check("the rejected no-live interrupt did not leave model image blocks queued", !h.internals.threadImages.has(id), JSON.stringify(h.internals.threadImages.get(id)));
      check("the rejected no-live interrupt did not arm a supersede marker", !h.db.getThreadStageOutputs(id).qaSuperseded, JSON.stringify(h.db.getThreadStageOutputs(id).qaSuperseded));
      await settle();
    } finally {
      h.dispose();
    }
  }

  // -- Test K-B: a restart during QA-fix handoff resumes implementation before QA -------------------
  console.log("\nTest K-B - restart recovery preserves the pending QA-fix handoff");
  {
    const h = makeHarness();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let rebooted: any;
    try {
      const id = seedTask(h);
      const ref = h.db.addAttachment({ name: IMG.name, mediaType: IMG.mediaType, data: IMG.dataBase64 });
      h.db.updateThread(id, { state: "qa" });
      h.db.updateThreadStageOutputs(id, {
        qaRoundsUsed: 1,
        qaFixHandoff: {
          at: Date.now(),
          resumeNudge: "QA round 1 found issues - fix the remaining keyboard input behavior.",
          messages: ["restart-preserved directive: keep the bearer-token context"],
          attachmentIds: [ref.id],
        },
      });
      const orphan = h.db.createRun({ threadId: id, role: "qa", model: "claude-opus-5", account: "acct-a" });
      h.db.updateRun(orphan.id, { state: "running" });

      let scheduled = 0;
      const proto = ThreadManager.prototype as unknown as { scheduleAutoResume: (threadId: string, title: string) => void };
      const originalSchedule = proto.scheduleAutoResume;
      proto.scheduleAutoResume = function (_threadId: string, _title: string): void {
        scheduled++;
      };
      try {
        rebooted = new ThreadManager(h.db, new EventHub(), new FileMemoryService(join(h.dir, "memory-reboot")), new StubAccounts() as unknown as AccountManager);
      } finally {
        proto.scheduleAutoResume = originalSchedule;
      }

      const ri = rebooted as typeof h.internals;
      const starts: Array<{ nudge: string; images: number }> = [];
      let qaCalls = 0;
      let qaBeforeFixResume = false;
      let autoSelectCalls = 0;
      ri.gateImplementorProvider = () => true;
      ri.autoSelectModel = async (): Promise<void> => {
        autoSelectCalls++;
      };
      ri.startResumedImplementor = async (_t: Thread, _kickoff: string, _resume: unknown, opts?: { resumeNudge?: string; images?: unknown[] }): Promise<{ run: FakeRun; runId: string; accountId: string; account: { id: string } }> => {
        starts.push({ nudge: opts?.resumeNudge ?? "", images: opts?.images?.length ?? 0 });
        return { run: new FakeRun(), runId: `restart-run-${starts.length}`, accountId: "acct-a", account: { id: "acct-a" } };
      };
      ri.awaitImplementorCompletion = async (): Promise<{ isError: boolean }> => ({ isError: false });
      ri.stopLive = async (): Promise<void> => {};
      ri.runSelfImprovement = async (): Promise<void> => {};
      ri.drainQueuedImplementor = async (_t: Thread, _e: unknown, _k: string, res: unknown): Promise<unknown> => res;
      ri.runQA = async (): Promise<{ pass: boolean; summary: string; changed: boolean }> => {
        if (!starts.length) qaBeforeFixResume = true;
        qaCalls++;
        return { pass: true, summary: "verified after restart recovery", changed: false };
      };

      check("boot recovery scheduled exactly one auto-resume", scheduled === 1, `scheduled=${scheduled}`);
      check("boot recovery did not convert the pending fix handoff into a QA-only retry", h.db.getThreadStageOutputs(id).qaInterruptedRetryRound == null, JSON.stringify(h.db.getThreadStageOutputs(id)));
      await ri.runPipeline(id);
      check("restart recovery started exactly one fix implementor", starts.length === 1, JSON.stringify(starts));
      check("the recovered fix resume received the persisted directive exactly once", (starts[0]?.nudge.match(/bearer-token context/g) ?? []).length === 1, starts[0]?.nudge);
      check("the recovered fix resume received the persisted image", starts[0]?.images === 1, JSON.stringify(starts));
      check("QA did not run before the fix implementor resumed", !qaBeforeFixResume, `qaBeforeFixResume=${qaBeforeFixResume}`);
      check("QA ran once after the recovered implementation", qaCalls === 1, `qaCalls=${qaCalls}`);
      check("auto model selection was skipped for the owed fix handoff", autoSelectCalls === 0, `autoSelectCalls=${autoSelectCalls}`);
      check("the recovered task settled only after QA accepted it", h.db.getThread(id)?.state === "done", `state=${h.db.getThread(id)?.state}`);
      check("the durable fix handoff was cleared after delivery", !h.db.getThreadStageOutputs(id).qaFixHandoff, JSON.stringify(h.db.getThreadStageOutputs(id).qaFixHandoff));
      await settle();
    } finally {
      if (rebooted?.capSupervisor) clearInterval(rebooted.capSupervisor);
      h.dispose();
    }
  }

  // -- Test K-C: image-bearing resumes preserve attachments across backend resume branches ----------
  console.log("\nTest K-C - image-bearing resumes preserve attachments across backend resume branches");
  {
    const h = makeHarness();
    const oldProjectsDir = process.env.CLAUDE_PROJECTS_DIR;
    try {
      const projectsDir = join(h.dir, "claude-projects");
      const projectDir = join(projectsDir, "workspace");
      mkdirSync(projectDir, { recursive: true });
      process.env.CLAUDE_PROJECTS_DIR = projectsDir;
      const imageBlock = { type: "image" as const, source: { type: "base64" as const, media_type: "image/png" as const, data: IMG.dataBase64 } };
      const packaged = h.internals.implementorStartContent("no-thread", "resume text", "fresh text", true, [imageBlock]);
      check("the resume content helper attaches image blocks", sendImageCount(packaged) === 1 && sendText(packaged).includes("resume text"), JSON.stringify(packaged));

      const starts: Array<{ label: string; resume?: string; images: number; fallbackImages: number }> = [];
      h.internals.startImplementor = (t: Thread, _kickoff: string, opts?: { resume?: string; images?: unknown[]; freshFallback?: unknown }): { run: FakeRun; runId: string; accountId: string } => {
        starts.push({ label: t.title, resume: opts?.resume, images: opts?.images?.length ?? 0, fallbackImages: sendImageCount(opts?.freshFallback) });
        return { run: new FakeRun(), runId: `${t.id}:impl`, accountId: "acct-a" };
      };
      h.internals.composeResumeKickoff = async (): Promise<string> => "compressed cold seed";
      const realStartResumed = (ThreadManager.prototype as unknown as {
        startResumedImplementor: typeof h.internals.startResumedImplementor;
      }).startResumedImplementor.bind(h.mgr);

      const warmId = seedTask(h);
      h.db.updateThread(warmId, { title: "warm-claude" });
      const warmSession = "warm-claude-session";
      writeFileSync(join(projectDir, `${warmSession}.jsonl`), "");
      h.db.updateRun(h.db.createRun({ threadId: warmId, role: "implementor", model: "claude-opus-5", account: "acct-a" }).id, { sessionId: warmSession });
      await realStartResumed(h.db.getThread(warmId)!, "BASE", warmSession, { resumeNudge: "NUDGE", directorNote: "NUDGE", qaFollows: true, images: [imageBlock] });

      const codexId = seedTask(h);
      h.db.updateThread(codexId, { title: "codex-resume" });
      const codexSession = "codex-session";
      h.db.updateRun(h.db.createRun({ threadId: codexId, role: "implementor", model: "gpt-5.5", account: "codex:gpt-5.5" }).id, { sessionId: codexSession });
      h.internals.implementorProvider.set(codexId, "codex");
      await realStartResumed(h.db.getThread(codexId)!, "BASE", codexSession, { resumeNudge: "NUDGE", directorNote: "NUDGE", qaFollows: true, images: [imageBlock] });

      const coldId = seedTask(h);
      h.db.updateThread(coldId, { title: "cold-claude" });
      const coldSession = "cold-claude-session";
      const coldPath = join(projectDir, `${coldSession}.jsonl`);
      writeFileSync(coldPath, "");
      const old = new Date(Date.now() - 120 * 60_000);
      utimesSync(coldPath, old, old);
      h.db.updateRun(h.db.createRun({ threadId: coldId, role: "implementor", model: "claude-opus-5", account: "acct-a" }).id, { sessionId: coldSession });
      await realStartResumed(h.db.getThread(coldId)!, "BASE", coldSession, { resumeNudge: "NUDGE", directorNote: "NUDGE", qaFollows: true, images: [imageBlock] });

      check("warm Claude resume passes the image to startImplementor", starts.some((s) => s.label === "warm-claude" && s.resume === warmSession && s.images === 1), JSON.stringify(starts));
      check("Codex CLI resume passes the image to the live turn", starts.some((s) => s.label === "codex-resume" && s.resume === codexSession && s.images === 1), JSON.stringify(starts));
      check("Codex CLI fallback also carries the image", starts.some((s) => s.label === "codex-resume" && s.fallbackImages === 1), JSON.stringify(starts));
      check("cold Claude resume passes the image to the fresh seed", starts.some((s) => s.label === "cold-claude" && !s.resume && s.images === 1), JSON.stringify(starts));
      await settle();
    } finally {
      if (oldProjectsDir == null) delete process.env.CLAUDE_PROJECTS_DIR;
      else process.env.CLAUDE_PROJECTS_DIR = oldProjectsDir;
      h.dispose();
    }
  }

  // -- Test K: a rejected QA stop is reported as failure, not a successful queued resume --------------
  console.log("\nTest K — QA stop rejection returns an actionable command failure");
  {
    const h = makeHarness();
    try {
      const id = seedTask(h);
      h.db.updateThread(id, { state: "qa" });
      h.internals.queuedForImplementor.set(id, ["preserve earlier queued work"]);
      const qa = new FakeRun();
      qa.stopError = new Error("simulated stop failure");
      h.internals.liveQa.set(id, qa);
      const sent: Array<Record<string, unknown>> = [];
      const socket = {
        OPEN: 1,
        readyState: 1,
        bufferedAmount: 0,
        send(raw: unknown) {
          sent.push(JSON.parse(String(raw)));
        },
      };
      await handleCommand({ manager: h.mgr } as Parameters<typeof handleCommand>[0], socket as unknown as Parameters<typeof handleCommand>[1], {
        type: "thread.inject",
        threadId: id,
        message: "this should fail visibly",
        mode: "interrupt",
        images: [IMG],
      });
      const action = sent.find((e) => e.type === "thread.action");
      check("the socket sent a failed thread.action acknowledgment", action?.ok === false, JSON.stringify(sent));
      check("the failed acknowledgment keeps the task in qa", action?.state === "qa" && h.db.getThread(id)?.state === "qa", JSON.stringify(action));
      check("the failed acknowledgment names the stop failure", String(action?.error ?? "").includes("simulated stop failure"), JSON.stringify(action));
      check("the QA run was not marked stopped", qa.stops === 1 && !qa.stopped && !qa.aborted, `stops=${qa.stops} stopped=${qa.stopped} aborted=${qa.aborted}`);
      check("the transient supersede marker was cleared", !h.db.getThreadStageOutputs(id).qaSuperseded, JSON.stringify(h.db.getThreadStageOutputs(id).qaSuperseded));
      check("the failed interrupt did not leave image blocks queued for a later resume", !h.internals.threadImages.has(id), JSON.stringify(h.internals.threadImages.get(id)));
      check("older queued implementor work was preserved", JSON.stringify(h.internals.queuedForImplementor.get(id)) === JSON.stringify(["preserve earlier queued work"]), JSON.stringify(h.internals.queuedForImplementor.get(id)));
      await settle();
    } finally {
      h.dispose();
    }
  }

  // -- Owner override: the exact reported sequence must never launch QA after implementation ---------
  console.log("\nOwner override A - a live implementor honors end-without-QA durably");
  {
    const h = makeHarness();
    try {
      const id = seedTask(h);
      h.db.updateThread(id, { state: "implementing" });
      let action: { ok: boolean; state?: string; message?: string } | undefined;
      h.internals.awaitImplementorCompletion = async (
        _thread: Thread,
        _effort: unknown,
        _kickoff: string,
        run: FakeRun,
      ): Promise<{ isError: boolean }> => {
        h.internals.live.set(id, { run, runId: "live-implementor", accountId: "acct-a" });
        try {
          action = await h.mgr.injectThread(id, NO_QA_DIRECTIVE, "append");
        } finally {
          h.internals.live.delete(id);
        }
        return { isError: false };
      };
      const agents = stubQaRunRole(h, async () => {});
      await runLoop(h, id);
      await settle();
      const stage = h.db.getThreadStageOutputs(id);
      check("the live injection acknowledged the durable QA bypass", action?.ok === true && String(action.message).includes("QA bypass recorded"), JSON.stringify(action));
      check("the owner override is persisted on the task", typeof stage.ownerQaBypassedAt === "number", JSON.stringify(stage));
      check("the clean implementation settled done", h.db.getThread(id)?.state === "done", `state=${h.db.getThread(id)?.state}`);
      check("no QA process was launched after the implementor", agents.length === 0, `qaRuns=${agents.length}`);
      check("the control directive did not replace the task title", h.db.getThread(id)?.title === "mock qa-inject task", h.db.getThread(id)?.title);
      check(
        "the completion finding records why QA was skipped",
        h.db.listFindings(id).some((f) => f.summary.includes("Owner requested completion without QA")),
        JSON.stringify(h.db.listFindings(id).map((f) => f.summary)),
      );
    } finally {
      h.dispose();
    }
  }

  // -- Owner override during QA: stop/ignore the reviewer, resume once, and do not re-enter QA --------
  console.log("\nOwner override B - an in-flight QA run cannot re-launch after the owner ends it");
  {
    const h = makeHarness();
    try {
      const id = seedTask(h);
      let action: { ok: boolean; state?: string; message?: string } | undefined;
      let injected = false;
      const agents = stubQaRunRole(h, async () => {
        if (injected) return;
        injected = true;
        action = await h.mgr.injectThread(id, NO_QA_DIRECTIVE, "append");
      });
      await runLoop(h, id);
      await settle();
      check("append-mode owner override stopped the visible QA run", agents[0]?.stops === 1 && agents[0]?.stopped === true, JSON.stringify(agents[0]));
      check("the action said implementation would finish without another QA", action?.ok === true && String(action.message).includes("without another QA run"), JSON.stringify(action));
      check("only the interrupted QA process existed", agents.length === 1, `qaRuns=${agents.length}`);
      check("the resumed implementor settled the task done", h.db.getThread(id)?.state === "done", `state=${h.db.getThread(id)?.state}`);
      check("the supersede handoff was consumed", !h.db.getThreadStageOutputs(id).qaSuperseded, JSON.stringify(h.db.getThreadStageOutputs(id)));
      check("the bypass remains durable after settlement", typeof h.db.getThreadStageOutputs(id).ownerQaBypassedAt === "number", JSON.stringify(h.db.getThreadStageOutputs(id)));
      check("the no-QA control directive did not auto-retitle the card", h.db.getThread(id)?.title === "mock qa-inject task", h.db.getThread(id)?.title);
    } finally {
      h.dispose();
    }
  }

  // -- Restart boundary: completed implementation + interrupted QA settles without replaying either --
  console.log("\nOwner override C - persisted bypass survives a restart boundary");
  {
    const h = makeHarness();
    try {
      const id = seedTask(h);
      h.db.updateThreadStageOutputs(id, {
        ownerQaBypassedAt: Date.now(),
        qaRoundsUsed: 1,
        qaInterruptedRetryRound: 1,
      });
      const agents = stubQaRunRole(h, async () => {});
      await runLoop(h, id, 4, false);
      check("restart recovery accepted the already-finished implementation", h.db.getThread(id)?.state === "done", `state=${h.db.getThread(id)?.state}`);
      check("restart recovery did not relaunch implementation", h.resumes.length === 0, JSON.stringify(h.resumes));
      check("restart recovery did not relaunch QA", agents.length === 0, `qaRuns=${agents.length}`);
      check("the interrupted-QA marker was cleared", h.db.getThreadStageOutputs(id).qaInterruptedRetryRound == null, JSON.stringify(h.db.getThreadStageOutputs(id)));
      check("the owner bypass timestamp survived settlement", typeof h.db.getThreadStageOutputs(id).ownerQaBypassedAt === "number", JSON.stringify(h.db.getThreadStageOutputs(id)));
    } finally {
      h.dispose();
    }
  }

  // -- Parked task: explicit owner acceptance should not spawn an implementor just to mark it done -----
  console.log("\nOwner override D - a parked task is accepted directly");
  {
    const h = makeHarness();
    try {
      const id = seedTask(h);
      h.db.updateThread(id, { state: "review" });
      const action = await h.mgr.injectThread(id, NO_QA_DIRECTIVE, "append");
      await settle();
      check("the parked task was marked done directly", action.ok && action.state === "done" && h.db.getThread(id)?.state === "done", JSON.stringify(action));
      check("direct acceptance did not start an implementor", h.resumes.length === 0, JSON.stringify(h.resumes));
      check("direct acceptance retained the original task title", h.db.getThread(id)?.title === "mock qa-inject task", h.db.getThread(id)?.title);
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
