// Focused deterministic coverage for Director Supervisor. It runs against a real temporary SQLite DB,
// but uses a no-network host: the only "agent" is a controlled function that returns a structured
// verdict. Run: npm run test:director-supervisor

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import WebSocket from "ws";
import { Db } from "../db/db.js";
import { EventHub } from "../events.js";
import { DirectorSupervisor, SUPERVISOR_JUDGE_MAX_TURNS, type SupervisorConfig, type SupervisorHost, type SupervisorJudgement } from "../orchestrator/supervisor.js";
import type { Finding, Thread, ThreadState } from "../types.js";
import type { PostFindingInput, ThreadActionResult } from "../orchestrator/api.js";
import type { JsonSchemaLike } from "../agents/structuredText.js";
import { clientCommandSchema } from "../ws/protocol.js";
import { registerWs, type WsContext } from "../ws/hub.js";
import { config } from "../config.js";

let failures = 0;
function check(name: string, condition: boolean): void {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}`);
  }
}

function oldEnough(db: Db, id: string, ageMs = 60 * 60_000): Thread {
  db.raw.prepare("UPDATE threads SET updated_at = ? WHERE id = ?").run(Date.now() - ageMs, id);
  return db.getThread(id)!;
}

function makeTask(db: Db, title: string, state: ThreadState = "planning", old = false): Thread {
  const initial = db.createThread({ title, workspace: "supervisor-test", rawPrompt: title });
  const task = db.updateThread(initial.id, { state })!;
  return old ? oldEnough(db, task.id) : task;
}

async function waitFor(condition: () => boolean, timeoutMs = 500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  return condition();
}

/** Hub-triggered passes are intentionally fire-and-forget. Let their promise-finally broadcast settle
 *  before a temp fixture closes its real SQLite connection. */
async function settleHubPass(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function waitForChatTurn(db: Db, id: string): Promise<NonNullable<ReturnType<Db["getSupervisorChatTurn"]>>> {
  await waitFor(() => db.getSupervisorChatTurn(id)?.status !== "pending", 2_000);
  return db.getSupervisorChatTurn(id)!;
}

/** Exercise the real websocket upgrade guard. The fake context is intentionally empty: an unauthorized
 * connection must be closed before the server attempts to build a snapshot or touch any manager API. */
async function checkUnauthorizedSocket(): Promise<void> {
  const originalPassword = config.authPassword;
  config.authPassword = "supervisor-auth-test";
  const app = Fastify();
  try {
    await app.register(websocket);
    registerWs(app, {} as WsContext);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    const port = address && typeof address === "object" ? address.port : 0;
    const code = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new Error("unauthorized websocket did not close"));
      }, 2_000);
      socket.once("close", (value) => {
        clearTimeout(timer);
        resolve(value);
      });
      socket.once("error", () => {
        // The close frame remains the authority; ws can surface an error on some Windows builds first.
      });
    });
    check("unauthenticated Supervisor websocket commands are rejected before a snapshot is exposed", code === 4401);
  } finally {
    await app.close().catch(() => {});
    config.authPassword = originalPassword;
  }
}

type Verdict = { action: string; message: string; reasoning: string; requiresOwner: boolean };

interface Fixture {
  dir: string;
  db: Db;
  hub: EventHub;
  findings: PostFindingInput[];
  injections: { threadId: string; message: string }[];
  chatInjections: { threadId: string; message: string; mode: "append" | "interrupt" | "queue" }[];
  interruptions: string[];
  notices: { kind: string; title: string; detail?: string }[];
  recoveries: string[];
  resumeDetails: { threadId: string; message?: string; operatorInitiated?: boolean }[];
  autoReviews: string[];
  prompts: string[];
  getJudgeCalls(): number;
  setVerdict(verdict: Verdict | null): void;
  setJudgement(output: unknown | null): void;
  setBeforeJudge(action: (() => void) | undefined): void;
  setCorrectionCanLand(on: boolean): void;
  setDiscord(on: boolean): void;
  create(config?: Partial<SupervisorConfig>): DirectorSupervisor;
  close(): void;
}

function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "director-supervisor-test-"));
  const db = new Db(join(dir, "orchestrator.sqlite"));
  const hub = new EventHub();
  const findings: PostFindingInput[] = [];
  const injections: { threadId: string; message: string }[] = [];
  const chatInjections: { threadId: string; message: string; mode: "append" | "interrupt" | "queue" }[] = [];
  const interruptions: string[] = [];
  const notices: { kind: string; title: string; detail?: string }[] = [];
  const recoveries: string[] = [];
  const resumeDetails: { threadId: string; message?: string; operatorInitiated?: boolean }[] = [];
  const autoReviews: string[] = [];
  const prompts: string[] = [];
  let calls = 0;
  let discord = false;
  let correctionCanLand = false;
  let beforeJudge: (() => void) | undefined;
  let next: unknown | null = { action: "comment", message: "A bounded note is useful.", reasoning: "The task has no live run.", requiresOwner: false };

  const host: SupervisorHost = {
    db,
    hub,
    async supervisorJudge(prompt: string, _schema: JsonSchemaLike): Promise<SupervisorJudgement | null> {
      calls++;
      prompts.push(prompt);
      beforeJudge?.();
      if (!next) return null;
      return {
        output: next,
        costUsd: 0.01,
        tokenUsage: { inputTokens: 80, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, reasoningOutputTokens: 20, totalTokens: 120 },
        model: "test-cheap-model",
        provider: "claude",
      };
    },
    postFinding(input: PostFindingInput): Finding {
      findings.push(input);
      return db.addFinding(input);
    },
    async injectSupervisorCorrection(threadId: string, message: string): Promise<ThreadActionResult> {
      if (!correctionCanLand) return { ok: false, state: db.getThread(threadId)?.state, error: "no live correction target" };
      injections.push({ threadId, message });
      return { ok: true, state: db.getThread(threadId)?.state };
    },
    async injectSupervisorInstruction(threadId, message, mode): Promise<ThreadActionResult> {
      chatInjections.push({ threadId, message, mode });
      return { ok: true, state: db.getThread(threadId)?.state, message: `instruction ${mode}` };
    },
    async interruptThread(threadId): Promise<ThreadActionResult> {
      interruptions.push(threadId);
      return { ok: true, state: "paused", message: "paused by test host" };
    },
    async resumeThread(threadId: string, message?: string, operatorInitiated?: boolean): Promise<ThreadActionResult> {
      recoveries.push(threadId);
      resumeDetails.push({ threadId, message, operatorInitiated });
      return { ok: true, state: "implementing", message: "resumed by test host" };
    },
    async autoReview(threadId: string): Promise<ThreadActionResult> {
      autoReviews.push(threadId);
      return { ok: true, state: "reviewing" };
    },
    supervisorDiscordReady: () => discord,
    notifySupervisor(kind, title, detail): void {
      notices.push({ kind, title, detail });
    },
  };

  return {
    dir,
    db,
    hub,
    findings,
    injections,
    chatInjections,
    interruptions,
    notices,
    recoveries,
    resumeDetails,
    autoReviews,
    prompts,
    getJudgeCalls: () => calls,
    setVerdict: (verdict) => {
      next = verdict;
    },
    setJudgement: (output) => {
      next = output;
    },
    setBeforeJudge: (action) => {
      beforeJudge = action;
    },
    setCorrectionCanLand: (on) => {
      correctionCanLand = on;
    },
    setDiscord: (on) => {
      discord = on;
    },
    create: (config) => new DirectorSupervisor(host, config),
    close: () => {
      db.raw.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function main(): Promise<void> {
  check("supervisor check-ins have a sufficient but bounded turn ceiling", SUPERVISOR_JUDGE_MAX_TURNS === 8);
  console.log("director supervisor: default-off and efficient activation");
  {
    const f = fixture();
    try {
      const task = makeTask(f.db, "healthy task");
      const supervisor = f.create();
      // The default stays completely quiescent: both a manual request and a live hub event cost no turn.
      await supervisor.runNow();
      f.hub.publish({ type: "thread.upsert", thread: task });
      check("starts off", supervisor.snapshot().enabled === false);
      check("off consumes no agent turns", f.getJudgeCalls() === 0 && f.db.listSupervisorEvents().length === 0);

      supervisor.setEnabled(true);
      await supervisor.runNow();
      check("a healthy newly-active task receives deterministic checks only", f.getJudgeCalls() === 0);
      const phase = f.db.updateThread(task.id, { state: "implementing" })!;
      f.hub.publish({ type: "thread.upsert", thread: phase });
      await waitFor(() => f.db.listSupervisorEvents().length === 1);
      check("a phase change is event-driven and does not spend a model turn when healthy", f.getJudgeCalls() === 0 && f.db.listSupervisorEvents()[0]!.kind === "check");
      await settleHubPass();
      supervisor.setEnabled(false);
    } finally {
      f.close();
    }
  }
  {
    const f = fixture();
    try {
      const task = makeTask(f.db, "recent finding is progress", "implementing", true);
      f.db.addFinding({ threadId: task.id, fromRole: "implementor", summary: "Fresh handoff/progress evidence", severity: "info" });
      const supervisor = f.create();
      supervisor.setEnabled(true);
      await supervisor.runNow();
      check("recent findings count as activity and avoid a false stalled-task check-in", f.getJudgeCalls() === 0 && f.db.listSupervisorEvents().length === 0);
      supervisor.setEnabled(false);
    } finally {
      f.close();
    }
  }

  console.log("director supervisor: bounded check-ins, cooldown and budget");
  {
    const f = fixture();
    try {
      makeTask(f.db, "stalled task", "planning", true);
      const supervisor = f.create({ maxCheckinsPerDay: 1, taskCooldownMs: 60 * 60_000 });
      supervisor.setEnabled(true);
      await supervisor.runNow();
      check("a materially stalled task receives one bounded agent check-in", f.getJudgeCalls() === 1);
      check("the judgement and compact usage are durable", f.db.listSupervisorEvents().some((e) => e.usedAgent && e.totalTokens === 120 && e.model === "test-cheap-model"));
      check("a reversible comment is surfaced as a normal finding", f.findings.length === 1 && f.findings[0]!.severity === "note");

      await supervisor.runNow();
      check("per-task cooldown prevents a duplicate check-in", f.getJudgeCalls() === 1);

      makeTask(f.db, "second stalled task", "implementing", true);
      await supervisor.runNow();
      check("the daily agent budget rejects extra check-ins while keeping a durable explanation", f.getJudgeCalls() === 1 && f.db.listSupervisorEvents().some((e) => e.summary.includes("daily check-in budget reached")));
      supervisor.setEnabled(false);
    } finally {
      f.close();
    }
  }

  console.log("director supervisor: manual operator override");
  {
    const f = fixture();
    try {
      makeTask(f.db, "first review handoff", "review", true);
      makeTask(f.db, "second review handoff", "review", true);
      const supervisor = f.create({ maxCheckinsPerDay: 1, taskCooldownMs: 60 * 60_000 });
      supervisor.setEnabled(true);

      await supervisor.runManualNow();
      const first = supervisor.snapshot().manualSweep;
      check(
        "manual Run now examines every eligible task after the unattended daily budget would be spent",
        f.getJudgeCalls() === 2 && first?.state === "complete" && first.examinedCount === 2 && first.budgetLimitedCount === 0,
      );
      check(
        "manual audit rows never claim the daily budget blocked the operator override",
        !f.db.listSupervisorEvents().some((event) => event.trigger === "manual" && /daily check-in budget reached/i.test(event.summary)),
      );

      const automatic = makeTask(f.db, "background budget guard", "failed", true);
      f.hub.publish({ type: "thread.upsert", thread: automatic });
      await waitFor(() => f.db.listSupervisorEvents().some((event) => event.threadId === automatic.id && /daily check-in budget reached/i.test(event.summary)));
      check("the unattended state-change path still obeys the daily budget", f.getJudgeCalls() === 2);

      await supervisor.runManualNow();
      check(
        "a later manual request starts a fresh full sweep after the prior one completed",
        f.getJudgeCalls() > 2 && supervisor.snapshot().manualSweep?.examinedCount === 3,
      );
      supervisor.setEnabled(false);
    } finally {
      f.close();
    }
  }

  console.log("director supervisor: meaningful lifecycle failures");
  {
    const f = fixture();
    try {
      const task = makeTask(f.db, "newly failing task", "implementing");
      const supervisor = f.create();
      supervisor.setEnabled(true);
      const failed = f.db.updateThread(task.id, { state: "failed", error: "retries exhausted" })!;
      f.hub.publish({ type: "thread.upsert", thread: failed });
      await waitFor(() => f.findings.length === 1);
      check("a newly failed non-cap task earns one bounded diagnosis immediately", f.getJudgeCalls() === 1 && f.findings.length === 1);
      await settleHubPass();
      supervisor.setEnabled(false);
    } finally {
      f.close();
    }
  }
  {
    const f = fixture();
    try {
      const task = makeTask(f.db, "phase checked then failing", "planning");
      const supervisor = f.create();
      supervisor.setEnabled(true);
      const implementing = f.db.updateThread(task.id, { state: "implementing" })!;
      f.hub.publish({ type: "thread.upsert", thread: implementing });
      await waitFor(() => f.db.listSupervisorEvents().length === 1);
      check("a healthy phase-change check is recorded first", f.getJudgeCalls() === 0 && f.db.listSupervisorEvents()[0]!.kind === "check");

      const failed = f.db.updateThread(task.id, { state: "failed", error: "retries exhausted" })!;
      f.hub.publish({ type: "thread.upsert", thread: failed });
      await waitFor(() => f.findings.length === 1);
      check("a later failed transition bypasses routine-check cooldown", f.getJudgeCalls() === 1 && f.findings.length === 1);
      await settleHubPass();
      supervisor.setEnabled(false);
    } finally {
      f.close();
    }
  }

  console.log("director supervisor: autonomous review handoff");
  {
    const f = fixture();
    try {
      const task = makeTask(f.db, "ready for delegated review", "implementing");
      f.setVerdict({
        action: "start_auto_review",
        message: "The implementation handoff is complete; verify it with the reviewer.",
        reasoning: "A normal review park is eligible for the existing verifier.",
        requiresOwner: false,
      });
      const supervisor = f.create();
      supervisor.setEnabled(true);
      const review = f.db.updateThread(task.id, { state: "review", error: "implementation finished; needs review" })!;
      f.hub.publish({ type: "thread.upsert", thread: review });
      await waitFor(() => f.autoReviews.length === 1);
      check(
        "a newly normal review park receives one bounded judgement and starts the existing auto-reviewer",
        f.getJudgeCalls() === 1 && f.autoReviews[0] === task.id && f.findings.some((finding) => finding.threadId === task.id && finding.summary.startsWith("Supervisor delegated review:")),
      );

      await supervisor.runNow();
      check("review handoff respects the task cooldown and does not start duplicate reviewers", f.autoReviews.length === 1);

      const cancelledReview = makeTask(f.db, "cancel before delegated review", "review");
      f.setBeforeJudge(() => f.db.updateThread(cancelledReview.id, { state: "cancelled" }));
      await supervisor.runNow();
      f.setBeforeJudge(undefined);
      check("a review cancelled during judgement is never handed to auto-review", f.autoReviews.length === 1 && f.db.getThread(cancelledReview.id)!.state === "cancelled");

      const capPark = makeTask(f.db, "capacity-owned review park", "review", true);
      f.db.updateThread(capPark.id, { error: "Auto-resume pending - capacity is exhausted" });
      await supervisor.runNow();
      check("a capacity-owned review park is never handed to auto-review", f.autoReviews.length === 1 && f.getJudgeCalls() === 2);
      await settleHubPass();
      supervisor.setEnabled(false);
    } finally {
      f.close();
    }
  }
  {
    const f = fixture();
    try {
      const task = makeTask(f.db, "phase checked then reviewed", "planning");
      f.setVerdict({
        action: "start_auto_review",
        message: "The implementation handoff is complete; verify it with the reviewer.",
        reasoning: "A normal review park is eligible for the existing verifier.",
        requiresOwner: false,
      });
      const supervisor = f.create();
      supervisor.setEnabled(true);
      const implementing = f.db.updateThread(task.id, { state: "implementing" })!;
      f.hub.publish({ type: "thread.upsert", thread: implementing });
      await waitFor(() => f.db.listSupervisorEvents().length === 1);
      check("a healthy phase-change check is recorded before review", f.getJudgeCalls() === 0 && f.db.listSupervisorEvents()[0]!.kind === "check");

      const review = f.db.updateThread(task.id, { state: "review", error: "implementation finished; needs review" })!;
      f.hub.publish({ type: "thread.upsert", thread: review });
      await waitFor(() => f.autoReviews.length === 1);
      check("a later review transition bypasses routine-check cooldown", f.getJudgeCalls() === 1 && f.autoReviews[0] === task.id);
      await settleHubPass();
      supervisor.setEnabled(false);
    } finally {
      f.close();
    }
  }

  console.log("director supervisor: token budget reservation");
  {
    const f = fixture();
    try {
      makeTask(f.db, "first token-bounded stall", "planning", true);
      const supervisor = f.create({ maxTokensPerDay: 8_100 });
      supervisor.setEnabled(true);
      await supervisor.runNow();
      makeTask(f.db, "second token-bounded stall", "planning", true);
      await supervisor.runNow();
      check("the daily token reservation blocks another check-in before it can exceed the cap", f.getJudgeCalls() === 1 && f.db.listSupervisorEvents().some((e) => e.summary.includes("120 tokens")));
      supervisor.setEnabled(false);
    } finally {
      f.close();
    }
  }

  console.log("director supervisor: safe action boundaries and cancellation");
  {
    const f = fixture();
    try {
      const cancelled = makeTask(f.db, "cancel during check", "planning", true);
      f.setVerdict({ action: "trigger_recovery", message: "resume it", reasoning: "looks dropped", requiresOwner: true });
      // Simulate an owner cancellation while the agent call is in flight. The fresh-state guard must win.
      f.setBeforeJudge(() => f.db.updateThread(cancelled.id, { state: "cancelled" }));
      const supervisor = f.create();
      supervisor.setEnabled(true);
      await supervisor.runNow();
      check("cancelled work is never revived after a stale judgement", f.getJudgeCalls() === 1 && f.recoveries.length === 0 && f.findings.length === 0);

      const qaRecovery = makeTask(f.db, "qa is not cold-resumable", "qa", true);
      f.setBeforeJudge(undefined);
      f.setVerdict({ action: "trigger_recovery", message: "resume qa", reasoning: "no QA runner is live", requiresOwner: true });
      await supervisor.runNow();
      check(
        "a stale QA lane is not reported as autonomously recovered",
        f.recoveries.length === 0 &&
          f.findings.length === 0 &&
          f.db.listSupervisorEvents().some((e) => e.threadId === qaRecovery.id && e.kind === "skip" && e.summary.includes("qa is not safe")),
      );

      const planningRecovery = makeTask(f.db, "planning is not implementor-resumable", "planning", true);
      f.setVerdict({ action: "trigger_recovery", message: "resume planning", reasoning: "no planner is live", requiresOwner: true });
      await supervisor.runNow();
      check(
        "a stale planning lane is not cold-resumed past its planned stages",
        f.recoveries.length === 0 &&
          f.findings.length === 0 &&
          f.db.listSupervisorEvents().some((e) => e.threadId === planningRecovery.id && e.kind === "skip" && e.summary.includes("planning is not safe")),
      );

      const stale = makeTask(f.db, "no receiver for correction", "qa", true);
      f.setVerdict({ action: "inject_correction", message: "do this", reasoning: "test boundary", requiresOwner: false });
      await supervisor.runNow();
      check("a correction is discarded when no live agent can receive it", f.findings.length === 0 && f.db.listSupervisorEvents().some((e) => e.threadId === stale.id && e.kind === "skip"));

      const receivingCorrection = makeTask(f.db, "live correction receiver", "implementing", true);
      f.db.createRun({ threadId: receivingCorrection.id, role: "implementor", model: "test-model" });
      f.setCorrectionCanLand(true);
      f.setVerdict({ action: "inject_correction", message: "fix the drift", reasoning: "a live agent can apply it", requiresOwner: false });
      await supervisor.runNow();
      f.setCorrectionCanLand(false);
      check(
        "a correction that has a live receiver uses the injection path, not a passive finding",
        f.injections.some((x) => x.threadId === receivingCorrection.id && x.message.includes("fix the drift")) && !f.findings.some((x) => x.threadId === receivingCorrection.id),
      );

      const silentLive = makeTask(f.db, "silent live run", "implementing", true);
      f.db.createRun({ threadId: silentLive.id, role: "implementor", model: "test-model" });
      f.setVerdict({ action: "comment", message: "confirm the handoff", reasoning: "the live run has made no recorded progress", requiresOwner: false });
      await supervisor.runNow();
      check("a live run with prolonged no-progress is judged without being interrupted", f.findings.length === 1 && f.recoveries.length === 0);

      const capped = makeTask(f.db, "provider capped", "implementing", true);
      f.setVerdict(null);
      await supervisor.runNow();
      check("a provider-cap/no-capacity check records the condition without a destructive fallback", f.recoveries.length === 0 && f.db.listSupervisorEvents().some((e) => e.threadId === capped.id && e.kind === "error"));

      const progressed = makeTask(f.db, "progress during alert", "implementing", true);
      f.setVerdict({ action: "alert", message: "needs owner", reasoning: "looked stale before progress landed", requiresOwner: true });
      f.setBeforeJudge(() => {
        f.db.addFinding({ threadId: progressed.id, fromRole: "implementor", summary: "Fresh same-state progress", severity: "info" });
      });
      await supervisor.runNow();
      f.setBeforeJudge(undefined);
      check(
        "a same-state progress update discards a stale owner-facing verdict",
        !f.findings.some((x) => x.threadId === progressed.id) &&
          f.db.listSupervisorEvents().some((e) => e.threadId === progressed.id && e.kind === "skip" && e.summary.includes("fresh activity")),
      );

      // The act() boundary alone already refuses a recovery on 'cancelled', so the first check in this
      // block cannot see the fresh-state re-read. This one can: a benign comment verdict must not land
      // on a task the owner cancelled while the judge call was in flight - anything else means the
      // supervisor nags dead work. (Thread-scoped on purpose: earlier scenarios own their own findings.)
      const cancelledLate = makeTask(f.db, "cancel during comment", "implementing", true);
      f.setVerdict({ action: "comment", message: "a note", reasoning: "no live run", requiresOwner: false });
      f.setBeforeJudge(() => f.db.updateThread(cancelledLate.id, { state: "cancelled" }));
      await supervisor.runNow();
      f.setBeforeJudge(undefined);
      check("a stale benign verdict lands nothing on a task cancelled mid-judgement", f.db.getThread(cancelledLate.id)!.state === "cancelled" && !f.findings.some((x) => x.threadId === cancelledLate.id));
      supervisor.setEnabled(false);
    } finally {
      f.close();
    }
  }

  console.log("director supervisor: Discord gating, dedupe and restart recovery");
  {
    const f = fixture();
    try {
      makeTask(f.db, "blocked without phone", "planning", true);
      f.setVerdict({ action: "alert", message: "needs a decision", reasoning: "a real blocker", requiresOwner: true });
      const first = f.create();
      first.setEnabled(true);
      await first.runNow();
      check("Discord-disabled supervisor produces no phone call", f.notices.length === 0 && !f.db.listSupervisorEvents()[0]!.notifiedDiscord);

      f.setDiscord(true);
      makeTask(f.db, "blocked with phone", "implementing", true);
      await first.runNow();
      check("a high-signal alert reaches enabled Discord exactly once", f.notices.length === 1 && f.db.listSupervisorEvents().some((e) => e.notifiedDiscord));

      // A process restart preserves both task cooldown and the global notification gap from SQLite.
      first.setEnabled(false);
      const firstLastCheckAt = first.snapshot().lastCheckAt;
      const restarted = f.create();
      check("restart restores the durable last-check timestamp", firstLastCheckAt != null && restarted.snapshot().lastCheckAt === firstLastCheckAt);
      restarted.setEnabled(true);
      makeTask(f.db, "second alert after restart", "qa", true);
      await restarted.runNow();
      check(
        "restart does not duplicate a cooled-down task or burst another notification",
        f.getJudgeCalls() === 3 && f.notices.length === 1,
      );
      restarted.setEnabled(false);
    } finally {
      f.close();
    }
  }

  console.log("director supervisor: explicit existing-task chat");
  {
    const f = fixture();
    try {
      const active = makeTask(f.db, "Implement phone navigation", "implementing");
      const paused = makeTask(f.db, "Repair invoice export", "paused");
      const unrelated = makeTask(f.db, "Unselected private task", "review");
      const failedTask = makeTask(f.db, "Concise agent communication setting", "failed");
      const supervisor = f.create();

      const beforeDeterministicResume = f.getJudgeCalls();
      const resume = supervisor.sendChatMessage(
        `this task failed for no reason pls ensure its finished task ${failedTask.id} — "${failedTask.title}"`,
        [failedTask.id],
      );
      const resumed = await waitForChatTurn(f.db, resume.id);
      check(
        "a clear failed-task finish request deterministically resumes the selected existing task",
        resumed.status === "succeeded" &&
          resumed.usedAgent === false &&
          resumed.actionResults[0]?.action === "resume" &&
          resumed.actionResults[0]?.state === "implementing" &&
          f.recoveries.includes(failedTask.id) &&
          f.resumeDetails.some((item) => item.threadId === failedTask.id && item.operatorInitiated === true && item.message?.includes("ensure its finished")) &&
          f.getJudgeCalls() === beforeDeterministicResume,
      );

      f.setJudgement({
        reply: "I can pause the live task and continue the saved paused task.",
        needsOwner: false,
        actions: [
          { threadId: active.id, action: "pause", message: "Pause after preserving current progress.", mode: "append" },
          { threadId: paused.id, action: "resume", message: "Continue from the saved handoff and report blockers.", mode: "append" },
        ],
      });
      const receiptId = crypto.randomUUID();
      const pending = supervisor.sendChatMessage("Pause navigation and resume the invoice task.", [active.id, paused.id], receiptId);
      check(
        "message submission preserves the browser receipt id and is persisted before provider work settles",
        pending.id === receiptId && pending.status === "pending" && f.db.getSupervisorChatTurn(receiptId)?.status === "pending",
      );
      const completed = await waitForChatTurn(f.db, pending.id);
      check(
        "multi-target routing executes each requested existing-task primitive and records authoritative results",
        completed.status === "succeeded" &&
          completed.actionResults.length === 2 &&
          completed.actionResults.every((result) => result.ok) &&
          f.interruptions.includes(active.id) &&
          f.recoveries.includes(paused.id),
      );
      check(
        "owner-initiated resume semantics and the exact selected task ids reach the control boundary",
        f.resumeDetails.some((item) => item.threadId === paused.id && item.operatorInitiated === true && item.message?.includes("saved handoff")) &&
          completed.targets.map((target) => target.threadId).join(",") === `${active.id},${paused.id}`,
      );
      const prompt = f.prompts.at(-1) ?? "";
      check(
        "an explicit target selection is the complete model action scope",
        prompt.includes(active.id) && prompt.includes(paused.id) && !prompt.includes(unrelated.id),
      );
      check(
        "conversation history, model usage, and target title snapshots survive a fresh Supervisor instance",
        f.create().snapshot().chat.some((turn) => turn.id === pending.id && turn.usedAgent && turn.targets[0]?.title === active.title),
      );

      f.setJudgement({
        reply: "I will queue that instruction for the selected implementor's handoff.",
        needsOwner: false,
        actions: [{ threadId: active.id, action: "steer", message: "Keep the mobile menu keyboard-accessible.", mode: "queue" }],
      });
      const steer = supervisor.sendChatMessage("Queue an accessibility reminder for navigation.", [active.id]);
      const steered = await waitForChatTurn(f.db, steer.id);
      check(
        "task steering uses the established injection path with the supervisor-selected delivery mode",
        steered.status === "succeeded" && f.chatInjections.some((item) => item.threadId === active.id && item.mode === "queue" && item.message.includes("keyboard-accessible")),
      );

      const injectionCount = f.chatInjections.length;
      f.setJudgement({
        reply: "Attempting an out-of-scope action.",
        needsOwner: false,
        actions: [{ threadId: unrelated.id, action: "steer", message: "Do something unrelated.", mode: "interrupt" }],
      });
      const escaped = supervisor.sendChatMessage("Only steer navigation.", [active.id]);
      const rejected = await waitForChatTurn(f.db, escaped.id);
      check(
        "a model cannot escape the owner's selected target set",
        rejected.status === "failed" && f.chatInjections.length === injectionCount && /out-of-scope/i.test(rejected.response ?? ""),
      );

      f.setJudgement({ reply: "I checked the recorded state.", needsOwner: false, actions: [{ threadId: active.id, action: "status" }] });
      const compactStatus = supervisor.sendChatMessage("Assess the selected navigation handoff.", [active.id]);
      const compactStatusResult = await waitForChatTurn(f.db, compactStatus.id);
      check(
        "irrelevant omitted model fields do not invalidate an otherwise scoped non-steering action",
        compactStatusResult.status === "succeeded" && compactStatusResult.actionResults[0]?.action === "status",
      );

      f.setJudgement({ reply: "Which acceptance criterion should the reviewer use?", needsOwner: true, actions: [] });
      const ambiguous = supervisor.sendChatMessage("Review it the way I meant earlier.", [unrelated.id]);
      const needsInput = await waitForChatTurn(f.db, ambiguous.id);
      check("ambiguity is surfaced as a durable needs-input reply instead of a fake completion", needsInput.status === "needs_input" && /which/i.test(needsInput.response ?? ""));

      f.setJudgement({
        reply: "The selected task is in a normal review park, so the existing reviewer can take it.",
        needsOwner: false,
        actions: [{ threadId: unrelated.id, action: "start_auto_review", message: "Verify the completed work against its brief.", mode: "append" }],
      });
      const review = supervisor.sendChatMessage("Have the reviewer verify this task.", [unrelated.id]);
      const reviewing = await waitForChatTurn(f.db, review.id);
      check(
        "review requests delegate to the established auto-review action rather than accepting work directly",
        reviewing.status === "succeeded" && f.autoReviews.includes(unrelated.id) && reviewing.actionResults[0]?.action === "start_auto_review",
      );

      const beforeCreate = f.db.listThreads().length;
      const beforeCreateJudges = f.getJudgeCalls();
      const create = supervisor.sendChatMessage("Create a new task to redesign the billing dashboard.", []);
      const routed = await waitForChatTurn(f.db, create.id);
      check(
        "clear new-work requests are sent back to Director without a model turn or duplicate thread",
        routed.status === "succeeded" && /Director/i.test(routed.response ?? "") && f.db.listThreads().length === beforeCreate && f.getJudgeCalls() === beforeCreateJudges,
      );

      f.setJudgement(null);
      const capped = supervisor.sendChatMessage("Assess whether the navigation handoff has drifted.", [active.id]);
      const failed = await waitForChatTurn(f.db, capped.id);
      check("provider failure leaves an auditable failed turn and takes no task action", failed.status === "failed" && /No task action/i.test(failed.response ?? "") && failed.actionResults.length === 0);

      const beforeMissingJudges = f.getJudgeCalls();
      const missing = supervisor.sendChatMessage("Pause this missing task.", ["missing-task-id"]);
      const missingResult = await waitForChatTurn(f.db, missing.id);
      check("deleted or invalid targets fail visibly before any agent call", missingResult.status === "failed" && /couldn't find/i.test(missingResult.response ?? "") && f.getJudgeCalls() === beforeMissingJudges);

      const orphan = f.db.createSupervisorChatTurn({ content: "A turn interrupted by restart", targets: [] });
      f.create();
      const recovered = f.db.getSupervisorChatTurn(orphan.id)!;
      check("restart recovery fails pending turns closed instead of replaying possibly-completed actions", recovered.status === "failed" && /restarted/i.test(recovered.response ?? ""));
    } finally {
      f.close();
    }
  }

  console.log("director supervisor: chat protocol and authorization boundary");
  {
    const clientId = crypto.randomUUID();
    const valid = clientCommandSchema.safeParse({ type: "supervisor.message", content: "Status please", targetIds: ["task-1", "task-2"], clientId });
    const duplicate = clientCommandSchema.safeParse({ type: "supervisor.message", content: "Status please", targetIds: ["task-1", "task-1"] });
    const oversized = clientCommandSchema.safeParse({ type: "supervisor.message", content: "Status please", targetIds: Array.from({ length: 9 }, (_, i) => `task-${i}`) });
    const receiptCommands = [
      { type: "prompt.new", text: "Create work", clientId },
      { type: "prompt.direct", text: "Create directly", workspace: process.cwd(), clientId },
      { type: "thread.inject", threadId: "task-1", message: "Steer it", mode: "append", clientId },
      { type: "chat.post", room: "general", body: "Coordinate", clientId },
    ];
    check("the authenticated command schema accepts bounded multi-target submissions with receipt ids", valid.success);
    check("every owner chat command accepts a UUID receipt id", receiptCommands.every((command) => clientCommandSchema.safeParse(command).success));
    check("malformed receipt ids are rejected at the websocket boundary", !clientCommandSchema.safeParse({ type: "chat.post", room: "general", body: "Coordinate", clientId: "not-a-uuid" }).success);
    check("the command boundary rejects duplicate and oversized target sets", !duplicate.success && !oversized.success);
    const f = fixture();
    try {
      const directorId = crypto.randomUUID();
      const officeId = crypto.randomUUID();
      check(
        "director and office persistence preserve browser receipt ids for exact reconciliation",
        f.db.addDirectorMessage({ id: directorId, role: "user", kind: "text", content: "Hello" }).id === directorId &&
          f.db.addChatMessage({ id: officeId, room: "general", scope: "general", role: "director", body: "Hello" }).id === officeId,
      );
    } finally {
      f.close();
    }
    await checkUnauthorizedSocket();
  }

  console.log("director supervisor: completion cleanup");
  {
    const f = fixture();
    try {
      const task = makeTask(f.db, "settling task", "qa");
      const supervisor = f.create();
      supervisor.setEnabled(true);
      const done = f.db.updateThread(task.id, { state: "done" })!;
      f.hub.publish({ type: "thread.upsert", thread: done });
      await waitFor(() => f.db.listSupervisorEvents().some((e) => e.threadId === task.id && e.action === "cleanup"));
      check("done records safe cleanup without an agent turn or state mutation", f.getJudgeCalls() === 0 && f.findings.length === 0 && f.db.getThread(task.id)!.state === "done");
      await settleHubPass();
      supervisor.setEnabled(false);
    } finally {
      f.close();
    }
  }
}

void main().then(
  () => {
    if (failures) {
      console.error(`\n${failures} director-supervisor check(s) FAILED`);
      process.exit(1);
    }
    console.log("\nAll director-supervisor checks passed.");
  },
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
