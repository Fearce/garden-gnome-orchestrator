// Focused deterministic coverage for Director Supervisor. It runs against a real temporary SQLite DB,
// but uses a no-network host: the only "agent" is a controlled function that returns a structured
// verdict. Run: npm run test:director-supervisor

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../db/db.js";
import { EventHub } from "../events.js";
import { DirectorSupervisor, type SupervisorConfig, type SupervisorHost, type SupervisorJudgement } from "../orchestrator/supervisor.js";
import type { Finding, Thread, ThreadState } from "../types.js";
import type { PostFindingInput, ThreadActionResult } from "../orchestrator/api.js";
import type { JsonSchemaLike } from "../agents/structuredText.js";

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

type Verdict = { action: string; message: string; reasoning: string; requiresOwner: boolean };

interface Fixture {
  dir: string;
  db: Db;
  hub: EventHub;
  findings: PostFindingInput[];
  notices: { kind: string; title: string; detail?: string }[];
  recoveries: string[];
  getJudgeCalls(): number;
  setVerdict(verdict: Verdict | null): void;
  setBeforeJudge(action: (() => void) | undefined): void;
  setDiscord(on: boolean): void;
  create(config?: Partial<SupervisorConfig>): DirectorSupervisor;
  close(): void;
}

function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "director-supervisor-test-"));
  const db = new Db(join(dir, "orchestrator.sqlite"));
  const hub = new EventHub();
  const findings: PostFindingInput[] = [];
  const notices: { kind: string; title: string; detail?: string }[] = [];
  const recoveries: string[] = [];
  let calls = 0;
  let discord = false;
  let beforeJudge: (() => void) | undefined;
  let next: Verdict | null = { action: "comment", message: "A bounded note is useful.", reasoning: "The task has no live run.", requiresOwner: false };

  const host: SupervisorHost = {
    db,
    hub,
    async supervisorJudge(_prompt: string, _schema: JsonSchemaLike): Promise<SupervisorJudgement | null> {
      calls++;
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
    async resumeThread(threadId: string): Promise<ThreadActionResult> {
      recoveries.push(threadId);
      return { ok: true, state: "queued" };
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
    notices,
    recoveries,
    getJudgeCalls: () => calls,
    setVerdict: (verdict) => {
      next = verdict;
    },
    setBeforeJudge: (action) => {
      beforeJudge = action;
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

  console.log("director supervisor: token budget reservation");
  {
    const f = fixture();
    try {
      makeTask(f.db, "first token-bounded stall", "planning", true);
      const supervisor = f.create({ maxTokensPerDay: 2_100 });
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

      const stale = makeTask(f.db, "no receiver for correction", "qa", true);
      f.setBeforeJudge(undefined);
      f.setVerdict({ action: "inject_correction", message: "do this", reasoning: "test boundary", requiresOwner: false });
      await supervisor.runNow();
      check("a correction is discarded when no live agent can receive it", f.findings.length === 0 && f.db.listSupervisorEvents().some((e) => e.threadId === stale.id && e.kind === "skip"));

      const silentLive = makeTask(f.db, "silent live run", "implementing", true);
      f.db.createRun({ threadId: silentLive.id, role: "implementor", model: "test-model" });
      f.setVerdict({ action: "comment", message: "confirm the handoff", reasoning: "the live run has made no recorded progress", requiresOwner: false });
      await supervisor.runNow();
      check("a live run with prolonged no-progress is judged without being interrupted", f.findings.length === 1 && f.recoveries.length === 0);

      const capped = makeTask(f.db, "provider capped", "implementing", true);
      f.setVerdict(null);
      await supervisor.runNow();
      check("a provider-cap/no-capacity check records the condition without a destructive fallback", f.recoveries.length === 0 && f.db.listSupervisorEvents().some((e) => e.threadId === capped.id && e.kind === "error"));

      // The act() boundary alone already refuses a recovery on 'cancelled', so the first check in this
      // block cannot see the fresh-state re-read. This one can: a benign comment verdict must not land
      // on a task the owner cancelled while the judge call was in flight — anything else means the
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
