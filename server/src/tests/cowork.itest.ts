/**
 * Co-work vertical-slice integration gate.
 *
 * Real: SQLite schema/transactions, CoworkManager lifecycle, durable streaming/history, restart
 * reconciliation, cancellation, workspace exclusion, and WebSocket command validation.
 * Stubbed: only the paid provider process. FakeRun exposes streaming and coalesced result boundaries
 * plus a session id, so the test controls exactly when a human-led work slice finishes.
 */

process.env.CAP_RETRY_MS = "0";
process.env.ACCOUNT_PING_MS = "3600000";
process.env.FAST_ACCOUNT_PING_MS = "3600000";

import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunLike, ResultEvent, SendOpts, UserContent } from "../agents/runner.js";
import { contentWithImages } from "../attachments.js";
import type { CoworkMessage, FileAttachment, RateLimitInfo, AgentEvent } from "../types.js";
import type { CoworkRuntime, CoworkTarget } from "../orchestrator/cowork.js";
import type { AccountManager } from "../accounts/accountManager.js";

const { Db } = await import("../db/db.js");
const { EventHub } = await import("../events.js");
const { CoworkManager } = await import("../orchestrator/cowork.js");
const { coworkAttachmentPath } = await import("../coworkAttachments.js");
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

function contentText(content: UserContent | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } => !!block && typeof block === "object" && (block as { type?: string }).type === "text")
    .map((block) => block.text)
    .join("\n");
}

function contentImages(content: UserContent | undefined): number {
  return Array.isArray(content)
    ? content.filter((block) => !!block && typeof block === "object" && (block as { type?: string }).type === "image").length
    : 0;
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
  sendError: string | null = null;
  readonly sends: Array<{ content: UserContent; opts?: SendOpts }> = [];
  private readonly results: ResultEvent[] = [];
  private readonly waiters: Array<(result: ResultEvent | undefined) => void> = [];

  constructor(
    readonly linkedSessionId: string,
    readonly steeringResultMode?: "per-message" | "coalesced",
  ) {}

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

  send(content: UserContent, opts?: SendOpts): void {
    if (this.sendError) throw new Error(this.sendError);
    this.sends.push({ content, opts });
  }
  async interrupt(): Promise<void> { await this.stop(); }
  async setModel(): Promise<void> {}
  async setPermissionMode(): Promise<void> {}
  endInput(): void {}

  async stop(): Promise<void> {
    this.stopCalls++;
    if (!this.finished) {
      this.finished = true;
      while (this.waiters.length) this.waiters.shift()?.(undefined);
      this.emitter.emit("end");
    }
  }

  result(): Promise<ResultEvent | undefined> { return this.nextResult(); }
  nextResult(): Promise<ResultEvent | undefined> {
    const ready = this.results.shift();
    if (ready) return Promise.resolve(ready);
    if (this.finished) return Promise.resolve(undefined);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

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
    this.emitter.emit("event", event satisfies AgentEvent);
    const waiter = this.waiters.shift();
    if (waiter) waiter(event);
    else this.results.push(event);
  }

  abort(): void {
    const event: ResultEvent = { type: "result", subtype: "success", isError: false, aborted: true, terminalReason: "aborted_tools" };
    this.lastResult = event;
    this.emitter.emit("event", event satisfies AgentEvent);
    const waiter = this.waiters.shift();
    if (waiter) waiter(event);
    else this.results.push(event);
  }

  fail(message: string): void {
    const event: ResultEvent = { type: "result", subtype: "error", isError: true, errors: [message] };
    this.lastResult = event;
    this.emitter.emit("event", event satisfies AgentEvent);
    const waiter = this.waiters.shift();
    if (waiter) waiter(event);
    else this.results.push(event);
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
  readonly prepared: { sessionId: string; agentSessionId: string | null; prompt: string; history: CoworkMessage[]; images: number }[] = [];
  conflict: string | null = null;
  prepareError: string | null = null;
  released = 0;
  capped = false;
  steeringResultMode: "per-message" | "coalesced" | undefined;

  prepare(input: Parameters<CoworkRuntime["prepare"]>[0]) {
    if (this.prepareError) return { error: this.prepareError };
    this.prepared.push({
      sessionId: input.session.id,
      agentSessionId: input.session.agentSessionId,
      prompt: input.prompt,
      history: input.history,
      images: input.images.length,
    });
    const run = new FakeRun(`provider-session-${this.runs.length + 1}`, this.steeringResultMode);
    this.runs.push(run);
    return { target: TARGET, agent: run, startContent: contentWithImages(input.prompt, input.images) };
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
  const screenshot: FileAttachment = {
    name: "layout.png",
    mediaType: "image/png",
    dataBase64: Buffer.from("small screenshot bytes").toString("base64"),
  };
  const sourceFile: FileAttachment = {
    name: "button.tsx",
    mediaType: "text/plain",
    dataBase64: Buffer.from("export const Button = () => <button />;\n").toString("base64"),
  };

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
    check(
      "screenshots and ordinary files parse at the WebSocket boundary",
      clientCommandSchema.safeParse({ type: "cowork.send", sessionId: created.session!.id, text: "Use these", attachments: [screenshot, sourceFile] }).success,
    );
    check(
      "all three live steering modes parse at the WebSocket boundary",
      (["queue", "append", "interrupt"] as const).every((mode) => clientCommandSchema.safeParse({ type: "cowork.steer", sessionId: created.session!.id, text: "Adjust it", mode }).success),
    );
    check("blank turns are rejected at the WebSocket boundary", !clientCommandSchema.safeParse({ type: "cowork.send", sessionId: created.session!.id, text: "   " }).success);
    check(
      "invalid attachment bytes and path-shaped names are rejected at the WebSocket boundary",
      !clientCommandSchema.safeParse({ type: "cowork.send", sessionId: created.session!.id, text: "Bad file", attachments: [{ ...sourceFile, dataBase64: "not-base64" }] }).success &&
        !clientCommandSchema.safeParse({ type: "cowork.send", sessionId: created.session!.id, text: "Bad name", attachments: [{ ...sourceFile, name: "../outside.txt" }] }).success,
    );
    check("unknown providers are rejected at the WebSocket boundary", !clientCommandSchema.safeParse({ type: "cowork.create", workspace, provider: "other", model: "x" }).success);

    const sessionId = created.session!.id;
    const rejectedAttachment = cowork.send(sessionId, "Do not persist this", undefined, [{ ...sourceFile, dataBase64: "%%%" }]);
    check("direct manager callers cannot bypass attachment validation", !rejectedAttachment.ok && db.listCoworkTurns(sessionId).length === 0);
    console.log("\n2 - one owner prompt claims exactly one bounded turn");
    const clientId = "db39da8d-5a43-4a44-85ae-335b14434991";
    const first = cowork.send(sessionId, "Add a durable Co-work feature and verify it.", clientId, [screenshot, sourceFile]);
    check("first prompt starts", first.ok);
    check("running state and active turn are persisted before reply", db.getCoworkSession(sessionId)?.state === "running" && !!db.getCoworkSession(sessionId)?.activeTurnId);
    const duplicate = cowork.send(sessionId, "Start an overlapping turn");
    check("a second prompt cannot overlap", !duplicate.ok && duplicate.error?.includes("already running"));
    check("only one turn row exists", db.listCoworkTurns(sessionId).length === 1);
    check("the owner echo uses the client id for delivery acknowledgement", db.listCoworkMessages(sessionId)[0]?.id === clientId);
    const ownerAttachments = db.listCoworkMessages(sessionId)[0]?.attachments ?? [];
    const sourceRef = ownerAttachments.find((attachment) => attachment.name === sourceFile.name);
    check("the owner echo durably references both uploaded files", ownerAttachments.length === 2 && !!sourceRef);
    check(
      "files are materialized at server-generated agent-readable paths",
      !!sourceRef && existsSync(coworkAttachmentPath(db, sessionId, sourceRef)) && readFileSync(coworkAttachmentPath(db, sessionId, sourceRef), "utf8").includes("Button"),
    );
    check(
      "the active agent receives the path manifest plus a native screenshot block",
      runtime.prepared[0]?.prompt.includes("button.tsx") && runtime.prepared[0]?.prompt.includes("CO-WORK OWNER ATTACHMENTS") &&
        runtime.prepared[0]?.images === 1 && contentImages(runtime.runs[0]?.startedWith) === 1,
    );
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

    console.log("\n3a - queue, inject, and interrupt-and-inject steer the one active slice");
    const liveRun = runtime.runs[1]!;
    const queued = cowork.steer(sessionId, "Queue the keyboard pass after the current safe unit.", "queue", "21111111-1111-4111-8111-111111111111", [sourceFile]);
    const injected = cowork.steer(sessionId, "Use the shared responsive token now.", "append", "22222222-2222-4222-8222-222222222222", [screenshot]);
    const interrupted = cowork.steer(sessionId, "Stop: preserve the compact header instead.", "interrupt", "23333333-3333-4333-8333-333333333333", [screenshot, sourceFile]);
    check("all live steering actions are accepted", queued.ok && injected.ok && interrupted.ok);
    const duplicateSteering = cowork.steer(sessionId, "Do not deliver this twice", "queue", "21111111-1111-4111-8111-111111111111");
    check("a retried steering message is idempotently rejected before provider delivery", !duplicateSteering.ok && liveRun.sends.length === 3);
    liveRun.sendError = "provider input closed";
    const failedSteeringId = "24444444-4444-4444-8444-444444444444";
    const failedSteering = cowork.steer(sessionId, "This transport update must not replay later", "append", failedSteeringId);
    liveRun.sendError = null;
    check("a provider delivery failure is recoverable and owner-visible", !failedSteering.ok && failedSteering.error?.includes("saved but could not reach"));
    check(
      "steering maps to later, live, and priority-now provider delivery",
      liveRun.sends[0]?.opts?.priority === "later" && liveRun.sends[1]?.opts === undefined && liveRun.sends[2]?.opts?.priority === "now",
      JSON.stringify(liveRun.sends.map((send) => send.opts)),
    );
    check("steering prompts require a visible acknowledgement", liveRun.sends.every((send) => contentText(send.content).includes("`ACK:`")));
    check(
      "queue, inject, and interrupt-and-inject preserve files while screenshots reach the provider natively",
      contentText(liveRun.sends[0]?.content).includes("button.tsx") && contentImages(liveRun.sends[0]?.content) === 0 &&
        contentText(liveRun.sends[1]?.content).includes("layout.png") && contentImages(liveRun.sends[1]?.content) === 1 &&
        contentText(liveRun.sends[2]?.content).includes("button.tsx") && contentImages(liveRun.sends[2]?.content) === 1,
    );
    check("steering stays inside one claimed DB turn", db.listCoworkTurns(sessionId).length === 2 && db.getCoworkSession(sessionId)?.activeTurnId === db.listCoworkTurns(sessionId)[1]?.id);
    const steeringMessages = db.listCoworkMessages(sessionId).filter((message) => message.role === "user" && message.meta && typeof message.meta === "object" && "steeringMode" in message.meta);
    check("all owner updates are durable with their delivery mode", steeringMessages.length === 4 && steeringMessages.map((message) => (message.meta as { steeringMode: string }).steeringMode).join(",") === "queue,append,interrupt,append");
    check("steering attachment references survive the pending-to-delivered metadata update", steeringMessages.slice(0, 3).map((message) => message.attachments?.length ?? 0).join(",") === "1,1,2");
    check("delivery status distinguishes received direction from a failed transport", steeringMessages.slice(0, 3).every((message) => (message.meta as { delivery: string }).delivery === "delivered") && (steeringMessages[3]?.meta as { delivery?: string } | null)?.delivery === "failed");

    liveRun.abort();
    await waitFor(() => db.getCoworkSession(sessionId)?.state === "running", "an interrupt abort does not settle the collaborative slice");
    liveRun.complete("ACK: preserved the compact header.");
    liveRun.complete("Queued keyboard pass applied.");
    liveRun.complete("Responsive token verified.");
    await waitFor(() => db.listCoworkTurns(sessionId).length === 2 && db.getCoworkSession(sessionId)?.state === "idle", "follow-up settles independently");
    check("steered replies remain substantive transcript entries", db.listCoworkMessages(sessionId).filter((message) => message.turnId === db.listCoworkTurns(sessionId)[1]?.id && message.role === "coworker" && message.kind === "text").length >= 3);
    check("the session remains available instead of becoming done", cowork.sessions().some((session) => session.id === sessionId && session.state === "idle"));
    check("late steering reports the hand-back instead of leaking into another turn", !cowork.steer(sessionId, "Too late", "append").ok);

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

    runtime.prepareError = "Pinned model capacity is exhausted.";
    const preflightFailed = cowork.send(sessionId, "Exercise pre-start failure recovery");
    check(
      "pre-start failure action returns the terminal error session",
      preflightFailed.ok && preflightFailed.session?.state === "error" && preflightFailed.session.error?.includes("Pinned model capacity"),
      JSON.stringify(preflightFailed),
    );
    check("pre-start failure is durable in the conversation", db.listCoworkMessages(sessionId).some((message) => message.role === "system" && message.content.includes("Pinned model capacity")));
    runtime.prepareError = null;

    check("a turn can start after a conflict clears", cowork.send(sessionId, "Exercise failure recovery").ok);
    check("failed live direction is not replayed into a fresh provider context", !runtime.prepared.at(-1)?.history.some((message) => message.id === failedSteeringId));
    runtime.runs[3]!.fail("provider exploded");
    await waitFor(() => db.getCoworkSession(sessionId)?.state === "error", "provider failure is clear and terminal for only that turn");
    check("failed turn leaves its diagnostic in the conversation", db.listCoworkMessages(sessionId).some((message) => message.role === "system" && message.content.includes("provider exploded")));

    check("the next owner instruction is accepted from error state", cowork.send(sessionId, "Recover on my instruction").ok);
    const stopResult = await cowork.stop(sessionId);
    check("stop is acknowledged while a turn is live", stopResult.ok);
    await waitFor(() => db.getCoworkSession(sessionId)?.state === "idle", "cancellation returns the session to ready");
    check("cancelled turn is recorded, not retried", db.listCoworkTurns(sessionId).at(-1)?.state === "cancelled");
    check("cancellation posts a usable-session message", db.listCoworkMessages(sessionId).at(-1)?.content.includes("ready for your next instruction"));

    console.log("\n4a - wall-clock boundaries force a collaborative hand-back without a retry");
    const boundaryRuntime = new FakeRuntime();
    const boundaryManager = new CoworkManager(db, new EventHub(), boundaryRuntime, { handoffMs: 20, stopMs: 70 });
    const boundarySession = boundaryManager.create({ name: "Timeboxed pair work", workspace });
    check("timebox fixture creates", boundarySession.ok);
    check("timeboxed work slice starts", boundaryManager.send(boundarySession.session!.id, "Start a deliberately slow slice").ok);
    await waitFor(() => boundaryRuntime.runs[0]?.sends.length === 1, "soft boundary asks the live agent to hand control back");
    check(
      "soft boundary interrupts with an explicit concise hand-back prompt",
      boundaryRuntime.runs[0]?.sends[0]?.opts?.priority === "now" && String(boundaryRuntime.runs[0]?.sends[0]?.content).includes("hand control back now"),
    );
    check(
      "the hand-back request is visible in durable history",
      db.listCoworkMessages(boundarySession.session!.id).some((message) => message.role === "system" && message.content.includes("Collaboration boundary reached")),
    );
    await waitFor(() => db.getCoworkSession(boundarySession.session!.id)?.state === "idle", "hard boundary returns an unresponsive run to idle");
    check("the bounded turn is recorded as timeboxed, not failed", db.listCoworkTurns(boundarySession.session!.id).at(-1)?.state === "timeboxed");
    check("timeboxing does not spawn an autonomous continuation", boundaryRuntime.runs.length === 1 && db.listThreads().length === 0);
    check("the owner can deliberately continue after a timebox", boundaryManager.send(boundarySession.session!.id, "Continue with the next small slice").ok);
    await boundaryManager.stop(boundarySession.session!.id);
    await waitFor(() => db.getCoworkSession(boundarySession.session!.id)?.state === "idle", "continued timeboxed session remains stoppable and reusable");

    console.log("\n4b - batch backends coalesce buffered steering into one final result");
    const batchRuntime = new FakeRuntime();
    batchRuntime.steeringResultMode = "coalesced";
    const batchManager = new CoworkManager(db, new EventHub(), batchRuntime, { handoffMs: 5_000, stopMs: 10_000 });
    const batchSession = batchManager.create({ name: "Batch steering", workspace });
    check("batch fixture creates and starts", batchSession.ok && batchManager.send(batchSession.session!.id, "Begin the batch-backed slice").ok);
    check("batch run accepts queued and immediate direction", batchManager.steer(batchSession.session!.id, "Queue this", "queue").ok && batchManager.steer(batchSession.session!.id, "Use this now", "append").ok);
    batchRuntime.runs[0]!.complete("ACK: both buffered directions were applied in this small slice.");
    await waitFor(() => db.getCoworkSession(batchSession.session!.id)?.state === "idle", "one coalesced final result settles the active DB turn");
    check("coalesced steering still creates no task pipeline", db.listCoworkTurns(batchSession.session!.id).length === 1 && db.listThreads().length === 0);

    console.log("\n4c - attachment-only turns and session cleanup are complete");
    const disposableRuntime = new FakeRuntime();
    const disposableManager = new CoworkManager(db, new EventHub(), disposableRuntime);
    const disposable = disposableManager.create({ name: "Attachment cleanup", workspace });
    const disposableFile: FileAttachment = {
      name: "notes.md",
      mediaType: "text/markdown",
      dataBase64: Buffer.from("# Uploaded notes\n").toString("base64"),
    };
    check("an attachment alone is a valid owner turn", disposable.ok && disposableManager.send(disposable.session!.id, "", undefined, [disposableFile]).ok);
    disposableRuntime.runs[0]!.complete("Read the uploaded notes.");
    await waitFor(() => db.getCoworkSession(disposable.session!.id)?.state === "idle", "attachment-only turn settles normally");
    const disposableRef = db.listCoworkMessages(disposable.session!.id)[0]?.attachments?.[0];
    const disposablePath = disposableRef ? coworkAttachmentPath(db, disposable.session!.id, disposableRef) : "";
    check("attachment-only prompts are named and materialized clearly", !!disposableRef && disposableRuntime.prepared[0]?.prompt.includes("notes.md") && existsSync(disposablePath));
    check("deleting a session removes its unique blob and materialized copy", !!disposableRef && disposableManager.remove(disposable.session!.id).ok && db.getAttachment(disposableRef.id) === null && !existsSync(disposablePath));

    console.log("\n5 - reload and restart preserve history and resumable linkage");
    unsubscribe();
    db.raw.close();
    db = new Db(database);
    check(
      "reload retains sessions, turns, substantive output, and attachment references",
      db.getCoworkSession(sessionId)?.agentSessionId === "provider-session-5" &&
        db.listCoworkMessages(sessionId).some((message) => message.content === longReply) &&
        db.listCoworkMessages(sessionId)[0]?.attachments?.length === 2,
    );

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
    const reloadedSource = db.listCoworkMessages(sessionId)[0]?.attachments?.find((attachment) => attachment.name === sourceFile.name);
    const reloadedPath = reloadedSource ? coworkAttachmentPath(db, sessionId, reloadedSource) : "";
    if (reloadedPath) rmSync(reloadedPath, { force: true });
    check("a later turn rebuilds a missing attachment cache from durable bytes", restarted.send(sessionId, "Re-open the component I attached earlier.").ok && !!reloadedSource && existsSync(reloadedPath));
    restartRuntime.runs[0]!.complete("Re-opened the durable component.");
    await waitFor(() => db.getCoworkSession(sessionId)?.state === "idle", "post-reload attachment follow-up completes normally");
    check("the owner can deliberately continue after restart", restarted.send(orphan.id, "Continue from what survived").ok && restartRuntime.prepared[1]?.agentSessionId === "resumable-after-restart");
    restartRuntime.runs[1]!.complete("Continued successfully");
    await waitFor(() => db.getCoworkSession(orphan.id)?.state === "idle", "post-restart follow-up completes normally");

    check("session/message events were emitted for live UI convergence", events.includes("cowork.session") && events.includes("cowork.message") && events.includes("cowork.delta"));
  } finally {
    try { db.raw.close(); } catch { /* already closed */ }
    rmSync(root, { recursive: true, force: true });
  }

  console.log("\n5a - existing Co-work databases migrate without losing history");
  const migrationRoot = mkdtempSync(join(tmpdir(), "cowork-attachment-migration-"));
  const migrationFile = join(migrationRoot, "orchestrator.sqlite");
  try {
    let legacyDb = new Db(migrationFile);
    const legacySession = legacyDb.createCoworkSession({ name: "Before attachments", autoNamed: false, workspace: migrationRoot });
    legacyDb.raw.exec("DROP TABLE cowork_messages");
    legacyDb.raw.exec(`CREATE TABLE cowork_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES cowork_sessions(id) ON DELETE CASCADE,
      turn_id TEXT REFERENCES cowork_turns(id) ON DELETE SET NULL,
      role TEXT NOT NULL,
      kind TEXT NOT NULL,
      content TEXT NOT NULL,
      meta TEXT,
      partial INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    legacyDb.raw.prepare("INSERT INTO cowork_messages VALUES (?, ?, NULL, 'user', 'text', 'existing history', NULL, 0, 1, 1)").run("legacy-message", legacySession.id);
    legacyDb.raw.close();

    legacyDb = new Db(migrationFile);
    const columns = (legacyDb.raw.prepare("PRAGMA table_info(cowork_messages)").all() as Array<{ name: string }>).map((column) => column.name);
    check("migration adds the durable attachment column", columns.includes("attachments"));
    check("migration preserves pre-attachment conversation rows", legacyDb.listCoworkMessages(legacySession.id)[0]?.content === "existing history");
    legacyDb.raw.close();
  } finally {
    rmSync(migrationRoot, { recursive: true, force: true });
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
