/**
 * Co-work vertical-slice integration gate.
 *
 * Real: SQLite schema/transactions, CoworkManager lifecycle, durable streaming/history, restart
 * reconciliation, cancellation, workspace exclusion, and WebSocket command validation.
 * Stubbed: only the paid provider process. FakeRun exposes the same one-result boundary and session id
 * as the real runners, so the test controls exactly when a human-led turn finishes.
 */

process.env.CAP_RETRY_MS = "0";
process.env.ACCOUNT_PING_MS = "3600000";
process.env.FAST_ACCOUNT_PING_MS = "3600000";

import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunLike, ResultEvent, SendOpts, UserContent } from "../agents/runner.js";
import type { CoworkMessage, RateLimitInfo, AgentEvent } from "../types.js";
import type { CoworkRuntime, CoworkTarget } from "../orchestrator/cowork.js";
import type { AccountManager } from "../accounts/accountManager.js";

const { Db } = await import("../db/db.js");
const { EventHub } = await import("../events.js");
const { CoworkManager } = await import("../orchestrator/cowork.js");
const { clientCommandSchema } = await import("../ws/protocol.js");
const { FileMemoryService } = await import("../memory/memory.js");
const { ThreadManager } = await import("../orchestrator/threadManager.js");

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(label: string, condition: unknown, detail?: string): void {
  if (condition) {
    passed++;
    console.log(`  PASS ${label}`);
  } else {
    failed++;
    failures.push(label + (detail ? ` -- ${detail}` : ""));
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ""}`);
  }
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  check(label, predicate());
}

class FakeRun implements AgentRunLike {
  readonly emitter = new EventEmitter();
  sessionId: string | undefined;
  finished = false;
  lastResult: ResultEvent | undefined;
  rateLimited = false;
  rateLimitInfo: RateLimitInfo | undefined;
  transientApiError = false;
  transientApiErrorMessage: string | undefined;
  startedWith: UserContent | undefined;
  stopCalls = 0;
  private settle: ((result: ResultEvent | undefined) => void) | null = null;
  private readonly resultPromise = new Promise<ResultEvent | undefined>((resolve) => { this.settle = resolve; });

  constructor(readonly linkedSessionId: string) {}

  start(firstMessage: UserContent): this {
    this.startedWith = firstMessage;
    this.sessionId = this.linkedSessionId;
    this.emitter.emit("event", { type: "init", sessionId: this.linkedSessionId } satisfies AgentEvent);
    return this;
  }

  onEvent(cb: (event: AgentEvent) => void): () => void {
    this.emitter.on("event", cb);
    return () => this.emitter.off("event", cb);
  }

  onEnd(cb: () => void): void {
    if (this.finished) cb();
    else this.emitter.once("end", cb);
  }

  send(_content: UserContent, _opts?: SendOpts): void {}
  async interrupt(): Promise<void> { await this.stop(); }
  async setModel(): Promise<void> {}
  async setPermissionMode(): Promise<void> {}
  endInput(): void {}

  async stop(): Promise<void> {
    this.stopCalls++;
    if (!this.finished) {
      this.finished = true;
      this.settle?.(undefined);
      this.settle = null;
      this.emitter.emit("end");
    }
  }

  result(): Promise<ResultEvent | undefined> { return this.resultPromise; }
  nextResult(): Promise<ResultEvent | undefined> { return this.resultPromise; }

  delta(text: string): void {
    this.emitter.emit("event", { type: "text_delta", text } satisfies AgentEvent);
  }

  tool(id: string, name: string, input: unknown, output: unknown): void {
    this.emitter.emit("event", { type: "tool_use", id, name, input } satisfies AgentEvent);
    this.emitter.emit("event", { type: "tool_result", id, content: output, isError: false } satisfies AgentEvent);
  }

  complete(result = "Turn complete"): void {
    const event: ResultEvent = {
      type: "result",
      subtype: "success",
      isError: false,
      result,
      numTurns: 3,
      costUsd: 0.012,
      tokenUsage: {
        inputTokens: 100,
        outputTokens: 40,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 140,
      },
    };
    this.lastResult = event;
    this.settle?.(event);
    this.settle = null;
  }

  fail(message: string): void {
    const event: ResultEvent = { type: "result", subtype: "error", isError: true, errors: [message] };
    this.lastResult = event;
    this.settle?.(event);
    this.settle = null;
  }
}

const TARGET: CoworkTarget = {
  provider: "codex",
  model: "gpt-test-cowork",
  effort: "high",
  accountId: "codex-test",
  accountLabel: "Codex test",
};

class FakeRuntime implements CoworkRuntime {
  readonly runs: FakeRun[] = [];
  readonly prepared: { sessionId: string; agentSessionId: string | null; prompt: string; history: CoworkMessage[] }[] = [];
  conflict: string | null = null;
  released = 0;
  capped = false;

  prepare(input: Parameters<CoworkRuntime["prepare"]>[0]) {
    this.prepared.push({
      sessionId: input.session.id,
      agentSessionId: input.session.agentSessionId,
      prompt: input.prompt,
      history: input.history,
    });
    const run = new FakeRun(`provider-session-${this.runs.length + 1}`);
    this.runs.push(run);
    return { target: TARGET, agent: run, startContent: input.prompt };
  }

  taskConflict(): string | null { return this.conflict; }
  observeRateLimit(): void {}
  isCapped(): boolean { return this.capped; }
  noteCap(): void {}
  releasedWorkspace(): void { this.released++; }
}

class StubAccounts {
  onUsageRefresh(_cb: () => void): void {}
  effectiveUtilization(): number | null { return null; }
  soonestResetAt(): number | null { return null; }
  hasHeadroom(): boolean { return true; }
  setPingInterval(_ms: number): void {}
  applyEnabled(_id: string, _enabled: boolean): void {}
  applyWeeklySafetyPct(_id: string, _pct: number): void {}
  setSpreadUsage(_on: boolean): void {}
}

async function main(): Promise<void> {
  console.log("\n=== Co-work durable one-turn lifecycle ===\n");
  const root = mkdtempSync(join(tmpdir(), "cowork-itest-"));
  const workspace = join(root, "workspace");
  const database = join(root, "orchestrator.sqlite");
  mkdirSync(workspace, { recursive: true });

  let db = new Db(database);
  const hub = new EventHub();
  const events: string[] = [];
  const unsubscribe = hub.subscribe((event) => events.push(event.type));
  const runtime = new FakeRuntime();
  const cowork = new CoworkManager(db, hub, runtime);

  try {
    console.log("1 - creation, safe workspace resolution, and command contract");
    const relative = cowork.create({ workspace: "." });
    check("relative workspace paths are rejected", !relative.ok && relative.error?.includes("absolute"));
    const incomplete = cowork.create({ workspace, provider: "codex" });
    check("provider/model must be selected as a pair", !incomplete.ok && incomplete.error?.includes("both"));
    const created = cowork.create({ workspace, provider: "codex", model: TARGET.model });
    check("a session is created on a canonical workspace", created.ok && created.session?.workspace === realpathSync(workspace));
    check("an explicit model request is durable before any run", created.session?.requestedModel === TARGET.model && created.session.provider === null);
    check("valid Co-work send parses at the WebSocket boundary", clientCommandSchema.safeParse({ type: "cowork.send", sessionId: created.session!.id, text: "Do it" }).success);
    check("blank turns are rejected at the WebSocket boundary", !clientCommandSchema.safeParse({ type: "cowork.send", sessionId: created.session!.id, text: "   " }).success);
    check("unknown providers are rejected at the WebSocket boundary", !clientCommandSchema.safeParse({ type: "cowork.create", workspace, provider: "other", model: "x" }).success);

    const sessionId = created.session!.id;
    console.log("\n2 - one owner prompt claims exactly one bounded turn");
    const clientId = "db39da8d-5a43-4a44-85ae-335b14434991";
    const first = cowork.send(sessionId, "Add a durable Co-work feature and verify it.", clientId);
    check("first prompt starts", first.ok);
    check("running state and active turn are persisted before reply", db.getCoworkSession(sessionId)?.state === "running" && !!db.getCoworkSession(sessionId)?.activeTurnId);
    const duplicate = cowork.send(sessionId, "Start an overlapping turn");
    check("a second prompt cannot overlap", !duplicate.ok && duplicate.error?.includes("already running"));
    check("only one turn row exists", db.listCoworkTurns(sessionId).length === 1);
    check("the owner echo uses the client id for delivery acknowledgement", db.listCoworkMessages(sessionId)[0]?.id === clientId);
    check("Co-work creates no autonomous task thread", db.listThreads().length === 0);
    check("the requested target and provider account became sticky", db.getCoworkSession(sessionId)?.model === TARGET.model && db.getCoworkSession(sessionId)?.provider === TARGET.provider && db.getCoworkSession(sessionId)?.account === TARGET.accountId);
    check("the first prompt auto-names once", db.getCoworkSession(sessionId)?.name === "Add a durable Co-work feature and verify it." && db.getCoworkSession(sessionId)?.autoNamed === false);

    const longReply = `Changed the implementation.\n\n${"verification-output ".repeat(900)}`;
    runtime.runs[0]!.delta(longReply);
    runtime.runs[0]!.tool("tool-1", "Bash", { command: "npm test" }, { exitCode: 0, output: "all passed" });
    const partial = db.listCoworkMessages(sessionId).find((message) => message.kind === "text" && message.role === "coworker");
    check("substantive streaming output is durable before completion", partial?.partial === true && partial.content === longReply, `chars=${partial?.content.length ?? 0}`);
    runtime.runs[0]!.complete(longReply);
    await waitFor(() => db.getCoworkSession(sessionId)?.state === "idle", "a completed turn returns to ready/idle");
    const firstTurn = db.listCoworkTurns(sessionId)[0]!;
    check("turn accounting is persisted", firstTurn.state === "done" && firstTurn.numTurns === 3 && firstTurn.tokenUsage?.totalTokens === 140);
    check("completed output is retained without truncation", db.listCoworkMessages(sessionId).find((message) => message.kind === "text" && message.role === "coworker")?.content === longReply);
    check("tool input and result are both durable", db.listCoworkMessages(sessionId).filter((message) => message.kind === "tool" || message.kind === "tool_result").length === 2);
    check("no task pipeline transition was created on completion", db.listThreads().length === 0 && db.listAllRuns().length === 0);

    console.log("\n3 - the next prompt resumes the same conversation context");
    const second = cowork.send(sessionId, "Now tighten the mobile layout.");
    check("follow-up starts after completion", second.ok);
    check("provider session linkage is handed to the next run", runtime.prepared[1]?.agentSessionId === "provider-session-1", runtime.prepared[1]?.agentSessionId ?? "null");
    check("prior prompt and full reply are available to fresh-session fallback", runtime.prepared[1]?.history.some((message) => message.content === longReply) && runtime.prepared[1]?.history.some((message) => message.content.includes("durable Co-work")));
    check("the auto-generated session name stays stable on follow-up", db.getCoworkSession(sessionId)?.name === "Add a durable Co-work feature and verify it.");
    runtime.runs[1]!.complete("Mobile layout tightened; typecheck passed.");
    await waitFor(() => db.listCoworkTurns(sessionId).length === 2 && db.getCoworkSession(sessionId)?.state === "idle", "follow-up settles independently");
    check("the session remains available instead of becoming done", cowork.sessions().some((session) => session.id === sessionId && session.state === "idle"));

    console.log("\n4 - workspace conflicts, failures, and cancellation are recoverable");
    const peer = cowork.create({ name: "Same repo peer", workspace });
    check("a second durable session may target the same repository", peer.ok);
    check("peer starts while repository is free", cowork.send(peer.session!.id, "Hold this workspace").ok);
    const blockedByPeer = cowork.send(sessionId, "Do not overlap the peer");
    check("live Co-workers cannot overlap in one workspace", !blockedByPeer.ok && blockedByPeer.error?.includes("Another Co-worker"));
    runtime.runs[2]!.complete("Peer complete");
    await waitFor(() => db.getCoworkSession(peer.session!.id)?.state === "idle", "peer releases the workspace");

    runtime.conflict = "A normal task agent is already using this workspace.";
    const taskBlocked = cowork.send(sessionId, "Respect the task lock");
    check("normal-task workspace ownership blocks a Co-worker before persistence", !taskBlocked.ok && db.listCoworkTurns(sessionId).length === 2);
    runtime.conflict = null;

    check("a turn can start after a conflict clears", cowork.send(sessionId, "Exercise failure recovery").ok);
    runtime.runs[3]!.fail("provider exploded");
    await waitFor(() => db.getCoworkSession(sessionId)?.state === "error", "provider failure is clear and terminal for only that turn");
    check("failed turn leaves its diagnostic in the conversation", db.listCoworkMessages(sessionId).some((message) => message.role === "system" && message.content.includes("provider exploded")));

    check("the next owner instruction is accepted from error state", cowork.send(sessionId, "Recover on my instruction").ok);
    const stopResult = await cowork.stop(sessionId);
    check("stop is acknowledged while a turn is live", stopResult.ok);
    await waitFor(() => db.getCoworkSession(sessionId)?.state === "idle", "cancellation returns the session to ready");
    check("cancelled turn is recorded, not retried", db.listCoworkTurns(sessionId).at(-1)?.state === "cancelled");
    check("cancellation posts a usable-session message", db.listCoworkMessages(sessionId).at(-1)?.content.includes("ready for your next instruction"));

    console.log("\n5 - reload and restart preserve history and resumable linkage");
    unsubscribe();
    db.raw.close();
    db = new Db(database);
    check("reload retains sessions, turns, and substantive output", db.getCoworkSession(sessionId)?.agentSessionId === "provider-session-5" && db.listCoworkMessages(sessionId).some((message) => message.content === longReply));

    const orphan = db.createCoworkSession({ name: "Interrupted", autoNamed: false, workspace });
    const orphanClaim = db.beginCoworkTurn(orphan.id, "Half-finished work");
    if (!orphanClaim.ok) throw new Error(orphanClaim.error);
    db.setCoworkAgentSession(orphan.id, orphanClaim.turn.id, "resumable-after-restart");
    db.upsertCoworkMessage({
      id: `${orphanClaim.turn.id}:reply`,
      sessionId: orphan.id,
      turnId: orphanClaim.turn.id,
      role: "coworker",
      kind: "text",
      content: "Substantive partial result",
      partial: true,
    });
    db.raw.close();

    db = new Db(database);
    const restartRuntime = new FakeRuntime();
    const restarted = new CoworkManager(db, new EventHub(), restartRuntime);
    const reconciled = db.getCoworkSession(orphan.id)!;
    check("restart marks the orphaned turn interrupted without autonomous replay", reconciled.state === "error" && reconciled.activeTurnId === null && restartRuntime.runs.length === 0);
    check("restart preserves the provider session and seals partial output", reconciled.agentSessionId === "resumable-after-restart" && db.listCoworkMessages(orphan.id).some((message) => message.content === "Substantive partial result" && !message.partial));
    check("restart adds an understandable durable diagnostic", db.listCoworkMessages(orphan.id).some((message) => message.role === "system" && message.content.includes("server restarted")));
    check("the owner can deliberately continue after restart", restarted.send(orphan.id, "Continue from what survived").ok && restartRuntime.prepared[0]?.agentSessionId === "resumable-after-restart");
    restartRuntime.runs[0]!.complete("Continued successfully");
    await waitFor(() => db.getCoworkSession(orphan.id)?.state === "idle", "post-restart follow-up completes normally");

    check("session/message events were emitted for live UI convergence", events.includes("cowork.session") && events.includes("cowork.message") && events.includes("cowork.delta"));
  } finally {
    try { db.raw.close(); } catch { /* already closed */ }
    rmSync(root, { recursive: true, force: true });
  }

  console.log("\n6 - normal task routing honors the same repository lock");
  const lockRoot = mkdtempSync(join(tmpdir(), "cowork-task-lock-"));
  const lockWorkspace = join(lockRoot, "workspace");
  mkdirSync(lockWorkspace, { recursive: true });
  const lockDb = new Db(join(lockRoot, "orchestrator.sqlite"));
  const taskManager = new ThreadManager(
    lockDb,
    new EventHub(),
    new FileMemoryService(join(lockRoot, "memory")),
    new StubAccounts() as unknown as AccountManager,
  );
  // Exercise the real queue/guard path but stop at the paid process-spawn leaf.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const taskInternals = taskManager as any;
  const started: string[] = [];
  taskInternals.startPipeline = (threadId: string): void => {
    started.push(threadId);
    taskInternals.activePipelines.add(threadId);
    taskInternals.activePipelineToken.set(threadId, Symbol("cowork-lock-test"));
    taskInternals.setState(threadId, "implementing");
  };
  let coworkOwnsRepo = true;
  taskManager.attachCoworkWorkspaceGuard((candidate) => coworkOwnsRepo && realpathSync(candidate) === realpathSync(lockWorkspace));
  try {
    taskManager.setSettings({ maxConcurrent: 5, maxConcurrentPerRepo: 0 });
    const task = lockDb.createThread({ title: "Wait behind Co-work", workspace: lockWorkspace, rawPrompt: "run later" });
    taskInternals.enqueueOrRun(task.id);
    check("a newly dispatched normal task queues behind live Co-work", lockDb.getThread(task.id)?.state === "queued" && started.length === 0);
    coworkOwnsRepo = false;
    taskManager.coworkReleasedWorkspace();
    check("releasing Co-work wakes the normal FIFO task", lockDb.getThread(task.id)?.state === "implementing" && started[0] === task.id);
    check("Co-work sees a real task's active workspace before claiming", taskManager.coworkTaskConflict(lockWorkspace)?.includes("Wait behind Co-work"));
  } finally {
    if (taskInternals.capSupervisor) clearInterval(taskInternals.capSupervisor);
    lockDb.raw.close();
    rmSync(lockRoot, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed) {
    console.error(failures.join("\n"));
    process.exitCode = 1;
  }
}

await main();
