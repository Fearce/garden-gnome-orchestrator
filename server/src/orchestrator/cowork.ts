import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, basename } from "node:path";
import type { Db } from "../db/db.js";
import type { EventHub } from "../events.js";
import type { AgentRunLike, ResultEvent, SendOpts, UserContent } from "../agents/runner.js";
import { contentWithImages, type ImageBlock } from "../attachments.js";
import { config } from "../config.js";
import { injectionSendOptions } from "./injection.js";
import {
  coworkContentWithAttachments,
  coworkImageBlocks,
  materializeCoworkAttachments,
  removeCoworkAttachmentFiles,
  validateCoworkAttachments,
} from "../coworkAttachments.js";
import type {
  CoworkActionResult,
  CoworkMessage,
  CoworkSession,
  CoworkSteeringMode,
  CoworkTurn,
  Effort,
  FileAttachment,
  ImplementorProvider,
  RateLimitInfo,
} from "../types.js";
import { normalizeWorkspace } from "../types.js";

export interface CoworkTarget {
  provider: ImplementorProvider;
  model: string;
  effort: Effort;
  accountId: string | null;
  accountLabel: string | null;
}

export interface PreparedCoworkRun {
  target: CoworkTarget;
  agent: AgentRunLike;
  startContent: UserContent;
}

/** Narrow bridge into ThreadManager's provider/account/capacity machinery. Keeping this interface small
 * lets the conversational lifecycle test against a deterministic fake without constructing the task
 * pipeline, and keeps pipeline state out of Co-work itself. */
export interface CoworkRuntime {
  prepare(input: { session: CoworkSession; prompt: string; history: CoworkMessage[]; images: ImageBlock[] }): PreparedCoworkRun | { error: string };
  taskConflict(workspace: string): string | null;
  observeRateLimit(target: CoworkTarget, info: RateLimitInfo): void;
  isCapped(target: CoworkTarget, agent: AgentRunLike): boolean;
  noteCap(target: CoworkTarget, agent: AgentRunLike): void;
  releasedWorkspace(): void;
}

export interface CoworkTimebox {
  handoffMs: number;
  stopMs: number;
}

interface LiveCoworkTurn {
  turnId: string;
  run: AgentRunLike;
  cancelled: boolean;
  timeboxed: boolean;
  acceptingSteering: boolean;
  expectedResults: number;
  steeringAccepted: boolean;
  rotateStream: () => void;
  handoffTimer?: NodeJS.Timeout;
  stopTimer?: NodeJS.Timeout;
}

const MAX_ERROR_CHARS = 8_000;

const TIMEBOX_HANDOFF = [
  "[CO-WORK COLLABORATION BOUNDARY]",
  "Stop starting new work. Finish only the operation already in flight, leave the workspace safe, and hand control back now.",
  "Reply concisely with: the useful increment completed, verification actually run, anything still in progress, and the best next owner-directed step.",
  "[/CO-WORK COLLABORATION BOUNDARY]",
].join("\n");

function steeringPrompt(mode: CoworkSteeringMode, message: string): string {
  const direction = mode === "queue"
    ? "Finish the current safe unit, then apply this before handing control back. Do not expand beyond it."
    : mode === "append"
      ? "Apply this at the next safe point. Preserve compatible progress and change direction where needed."
      : "Stop the current approach at the next safe boundary. This supersedes conflicting prior direction; apply it immediately.";
  return [
    `[CO-WORK OWNER ${mode === "queue" ? "QUEUE" : mode === "append" ? "INJECTION" : "INTERRUPT & INJECT"}]`,
    message,
    `[/CO-WORK OWNER ${mode === "queue" ? "QUEUE" : mode === "append" ? "INJECTION" : "INTERRUPT & INJECT"}]`,
    direction,
    "Begin the response to this update with `ACK:` and briefly say how you are applying it.",
  ].join("\n\n");
}

function addCount(a: number | null | undefined, b: number | null | undefined): number | null {
  return a == null && b == null ? null : (a ?? 0) + (b ?? 0);
}

function addTokenUsage(a: CoworkTurn["tokenUsage"], b: CoworkTurn["tokenUsage"]): CoworkTurn["tokenUsage"] {
  if (!a) return b;
  if (!b) return a;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
    reasoningOutputTokens: a.reasoningOutputTokens + b.reasoningOutputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

function resultError(result: ResultEvent | undefined, fallback?: string): string {
  const text = result?.errors?.filter(Boolean).join("\n") || fallback || result?.result || result?.subtype;
  return (text || "The Co-worker turn ended without a result.").slice(0, MAX_ERROR_CHARS);
}

function safeJson(value: unknown): string {
  try {
    const text = JSON.stringify(value, null, 2);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
}

function cleanName(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, 120);
}

function workspaceName(workspace: string): string {
  return basename(workspace.replace(/[\\/]+$/, "")) || "New Co-work";
}

function attachmentOnlyPrompt(files: FileAttachment[]): string {
  if (files.length === 1) return `Review the attached file ${JSON.stringify(files[0]!.name)}.`;
  return `Review the ${files.length} attached files.`;
}

/** Failed/unconfirmed live directions remain visible in the durable UI transcript, but a fresh
 * provider must not later apply them as if delivery had succeeded. `accepted` is the pre-delivery-
 * state-machine legacy value from the first steering build and is treated as delivered. */
function providerHistory(messages: CoworkMessage[]): CoworkMessage[] {
  return messages.filter((message) => {
    if (message.role !== "user" || !message.meta || typeof message.meta !== "object") return true;
    const meta = message.meta as Record<string, unknown>;
    if (typeof meta.steeringMode !== "string") return true;
    return meta.delivery !== "failed" && meta.delivery !== "pending";
  });
}

/** Durable, one-turn-at-a-time, human-led coding conversations. This class never creates a Thread and
 * has no planner/QA/supervisor hooks; completing a turn always returns the session to idle. */
export class CoworkManager {
  private readonly live = new Map<string, LiveCoworkTurn>();

  constructor(
    readonly db: Db,
    readonly hub: EventHub,
    private readonly runtime: CoworkRuntime,
    private readonly timebox: CoworkTimebox = {
      handoffMs: config.coworkerHandoffMs,
      stopMs: config.coworkerStopMs,
    },
  ) {
    for (const session of this.db.interruptOrphanedCoworkTurns()) {
      const message = this.db.upsertCoworkMessage({
        sessionId: session.id,
        role: "system",
        kind: "system",
        content: session.error ?? "The server restarted during the prior turn.",
      });
      this.hub.publish({ type: "cowork.message", message });
      this.publishSession(session);
    }
  }

  sessions(): CoworkSession[] {
    return this.db.listCoworkSessions();
  }

  history(sessionId: string): { session: CoworkSession | null; turns: CoworkTurn[]; messages: CoworkMessage[] } {
    return {
      session: this.db.getCoworkSession(sessionId),
      turns: this.db.listCoworkTurns(sessionId),
      messages: this.db.listCoworkMessages(sessionId),
    };
  }

  /** True while this process owns a Co-worker turn in the normalized workspace. Used as an external
   * repository lock by normal dispatch/resume and by the Git console's destructive-action guard. */
  hasLiveWorkspace(workspace: string): boolean {
    const key = normalizeWorkspace(workspace);
    return this.db.listCoworkSessions().some(
      (session) =>
        normalizeWorkspace(session.workspace) === key &&
        (session.activeTurnId != null || session.state === "running" || session.state === "stopping"),
    );
  }

  describeActiveWork(): string {
    const active = this.db.listCoworkSessions().filter((session) => session.activeTurnId);
    return active.length
      ? active.map((session) => `cowork:${session.id.slice(0, 8)} ${session.state} "${session.name}"`).join("; ")
      : "no active Co-work turns";
  }

  create(input: {
    name?: string;
    workspace: string;
    provider?: ImplementorProvider | null;
    model?: string | null;
  }): CoworkActionResult {
    const workspace = input.workspace.trim();
    if (!workspace || !isAbsolute(workspace)) return { ok: false, error: "Choose an absolute workspace folder." };
    let canonical: string;
    try {
      canonical = realpathSync(workspace);
      if (!statSync(canonical).isDirectory()) return { ok: false, error: "The workspace must be a folder." };
    } catch {
      return { ok: false, error: `Workspace "${workspace}" does not exist or cannot be opened.` };
    }
    const provider = input.provider ?? null;
    const model = input.model?.trim() || null;
    if ((provider == null) !== (model == null)) {
      return { ok: false, error: "Choose both a provider and model, or leave both on Auto." };
    }
    const suppliedName = cleanName(input.name ?? "");
    const session = this.db.createCoworkSession({
      name: suppliedName || workspaceName(canonical),
      autoNamed: !suppliedName,
      workspace: canonical,
      requestedProvider: provider,
      requestedModel: model,
    });
    this.publishSession(session);
    return { ok: true, session };
  }

  rename(sessionId: string, name: string): CoworkActionResult {
    const clean = cleanName(name);
    if (!clean) return { ok: false, error: "Session name cannot be empty." };
    const session = this.db.renameCoworkSession(sessionId, clean);
    if (!session) return { ok: false, error: "Co-work session not found." };
    this.publishSession(session);
    return { ok: true, session };
  }

  remove(sessionId: string): CoworkActionResult {
    const session = this.db.getCoworkSession(sessionId);
    if (!session) return { ok: false, error: "Co-work session not found." };
    if (session.activeTurnId || this.live.has(sessionId)) return { ok: false, session, error: "Stop the running turn before deleting this session." };
    if (!this.db.deleteCoworkSession(sessionId)) return { ok: false, session, error: "The session could not be deleted while it was active." };
    try {
      removeCoworkAttachmentFiles(this.db, sessionId);
    } catch (error) {
      this.hub.log("warn", `Could not remove cached files for deleted Co-work session ${sessionId.slice(0, 8)}: ${(error as Error).message || String(error)}`);
    }
    this.hub.publish({ type: "cowork.removed", sessionId });
    return { ok: true };
  }

  /** Claims and starts one bounded turn, but does not await its potentially long agent run. The durable
   * user echo and running state are visible before this method returns to the WebSocket handler. */
  send(sessionId: string, prompt: string, clientId?: string, attachments: FileAttachment[] = []): CoworkActionResult {
    const text = prompt.trim() || (attachments.length ? attachmentOnlyPrompt(attachments) : "");
    if (!text) return { ok: false, error: "Write an instruction or attach a file first." };
    const session = this.db.getCoworkSession(sessionId);
    if (!session) return { ok: false, error: "Co-work session not found." };
    const attachmentError = validateCoworkAttachments(attachments);
    if (attachmentError) return { ok: false, session, error: attachmentError };
    if (!existsSync(session.workspace)) return { ok: false, session, error: `Workspace "${session.workspace}" no longer exists.` };
    const conflict = this.runtime.taskConflict(session.workspace);
    if (conflict) return { ok: false, session, error: conflict };
    if ([...this.live.entries()].some(([id]) => id !== sessionId && this.sameWorkspace(id, session.workspace))) {
      return { ok: false, session, error: "Another Co-worker turn is already using this workspace. Stop it or wait for it to finish." };
    }

    // Read the prior transcript before beginCoworkTurn adds this prompt; fresh-session fallback should
    // include the history once and the current instruction once.
    const history = providerHistory(this.db.listCoworkMessages(sessionId));
    const claimed = this.db.beginCoworkTurn(sessionId, text, clientId, attachments);
    if (!claimed.ok) return { ok: false, session: claimed.session ?? undefined, error: claimed.error };
    this.hub.publish({ type: "cowork.message", message: claimed.message });
    this.publishSession(claimed.session);
    void this.execute(claimed.session, claimed.turn, text, history, claimed.message);
    // prepare() failures can settle synchronously before the WebSocket action receipt is sent. Return
    // the current row so that receipt cannot overwrite the UI with the stale running claim.
    return { ok: true, session: this.db.getCoworkSession(sessionId) ?? claimed.session };
  }

  /** Deliver owner direction into the one live Co-worker run. Unlike send(), this deliberately does
   * not claim a second DB turn: the update is part of the active collaborative slice and the manager
   * keeps that slice open until the provider has returned a result for every accepted update. */
  steer(sessionId: string, prompt: string, mode: CoworkSteeringMode, clientId?: string, attachments: FileAttachment[] = []): CoworkActionResult {
    const text = prompt.trim() || (attachments.length ? attachmentOnlyPrompt(attachments) : "");
    if (!text) return { ok: false, error: "Write a direction or attach a file first." };
    const session = this.db.getCoworkSession(sessionId);
    if (!session) return { ok: false, error: "Co-work session not found." };
    const attachmentError = validateCoworkAttachments(attachments);
    if (attachmentError) return { ok: false, session, error: attachmentError };
    const live = this.live.get(sessionId);
    if (!live || session.activeTurnId !== live.turnId || session.state !== "running" || !live.acceptingSteering) {
      return {
        ok: false,
        session,
        error: session.state === "stopping"
          ? "This turn is already stopping. Send a new instruction after it settles."
          : "The active turn just finished. Send this as the next Co-work turn instead.",
      };
    }

    const accepted = this.db.appendCoworkSteering({
      sessionId,
      turnId: live.turnId,
      content: text,
      mode,
      messageId: clientId,
      attachments,
    });
    if (!accepted.ok) return { ok: false, session: accepted.session ?? undefined, error: accepted.error };
    this.hub.publish({ type: "cowork.message", message: accepted.message });
    this.publishSession(accepted.session);

    try {
      const files = materializeCoworkAttachments(this.db, sessionId, accepted.message.attachments);
      const direction = coworkContentWithAttachments(this.db, sessionId, steeringPrompt(mode, text), accepted.message.attachments);
      this.deliverLiveDirection(live, contentWithImages(direction, coworkImageBlocks(files)), mode);
      const delivered = this.db.upsertCoworkMessage({
        id: accepted.message.id,
        sessionId,
        turnId: live.turnId,
        role: "user",
        kind: "text",
        content: text,
        attachments: accepted.message.attachments,
        meta: { steeringMode: mode, delivery: "delivered" },
        createdAt: accepted.message.createdAt,
      });
      this.hub.publish({ type: "cowork.message", message: delivered });
    } catch (error) {
      const reason = (error as Error).message || String(error);
      const failed = this.db.upsertCoworkMessage({
        id: accepted.message.id,
        sessionId,
        turnId: live.turnId,
        role: "user",
        kind: "text",
        content: text,
        attachments: accepted.message.attachments,
        meta: { steeringMode: mode, delivery: "failed", error: reason },
        createdAt: accepted.message.createdAt,
      });
      this.hub.publish({ type: "cowork.message", message: failed });
      return { ok: false, session: this.db.getCoworkSession(sessionId) ?? accepted.session, error: `Direction was saved but could not reach the live agent: ${reason}` };
    }
    return { ok: true, session: this.db.getCoworkSession(sessionId) ?? accepted.session };
  }

  async stop(sessionId: string): Promise<CoworkActionResult> {
    const session = this.db.getCoworkSession(sessionId);
    if (!session) return { ok: false, error: "Co-work session not found." };
    const live = this.live.get(sessionId);
    if (!session.activeTurnId || !live) {
      return { ok: false, session, error: "No Co-worker turn is running." };
    }
    live.cancelled = true;
    live.acceptingSteering = false;
    const stopping = this.db.setCoworkStopping(sessionId, live.turnId);
    if (stopping) this.publishSession(stopping);
    try {
      await live.run.stop();
    } catch {
      // execute() owns the terminal transition and remains able to settle after a failed stop call.
    }
    return { ok: true, session: this.db.getCoworkSession(sessionId) ?? session };
  }

  private deliverLiveDirection(live: LiveCoworkTurn, content: UserContent, mode: CoworkSteeringMode): void {
    live.rotateStream();
    live.expectedResults++;
    live.steeringAccepted = true;
    let options: SendOpts | undefined;
    if (mode === "queue") options = { priority: "later" };
    else options = injectionSendOptions(live.run, mode);
    try {
      live.run.send(content, options);
    } catch (error) {
      live.expectedResults = Math.max(0, live.expectedResults - 1);
      throw error;
    }
  }

  /** Soft wall-clock boundary shared by streaming and batch backends. It asks for a clean hand-back
   * through the same priority-now path as owner steering, so partial work is summarized instead of
   * silently killed. No pipeline retry or continuation is started. */
  private requestTimedHandoff(sessionId: string, turnId: string): void {
    const live = this.live.get(sessionId);
    if (!live || live.turnId !== turnId || live.cancelled || live.timeboxed || !live.acceptingSteering) return;
    const message = this.db.upsertCoworkMessage({
      sessionId,
      turnId,
      role: "system",
      kind: "system",
      content: "Collaboration boundary reached — asking the Co-worker to summarize this work slice and hand control back.",
    });
    this.hub.publish({ type: "cowork.message", message });
    try {
      this.deliverLiveDirection(live, TIMEBOX_HANDOFF, "interrupt");
    } catch {
      this.enforceTimedHandoff(sessionId, turnId);
    }
  }

  /** Hard backstop for a provider that ignores the soft hand-back. This is an intentional timebox, not
   * a failure and not an autonomous retry: execute() records `timeboxed`, returns the session to idle,
   * and preserves the provider session id for the owner's deliberate next prompt. */
  private enforceTimedHandoff(sessionId: string, turnId: string): void {
    const live = this.live.get(sessionId);
    if (!live || live.turnId !== turnId || live.cancelled || live.timeboxed) return;
    live.timeboxed = true;
    live.acceptingSteering = false;
    const stopping = this.db.setCoworkStopping(sessionId, turnId);
    if (stopping) this.publishSession(stopping);
    void live.run.stop().catch(() => {});
  }

  private sameWorkspace(sessionId: string, workspace: string): boolean {
    const other = this.db.getCoworkSession(sessionId);
    return !!other && normalizeWorkspace(other.workspace) === normalizeWorkspace(workspace);
  }

  private async execute(
    session: CoworkSession,
    turn: CoworkTurn,
    prompt: string,
    history: CoworkMessage[],
    ownerMessage: CoworkMessage,
  ): Promise<void> {
    let prepared: PreparedCoworkRun | { error: string };
    try {
      // Rebuild every prior path too: a data-directory restore or manually cleared cache must not make
      // an old file reference lie when a fresh provider fallback replays the durable conversation.
      materializeCoworkAttachments(this.db, session.id, history.flatMap((message) => message.attachments ?? []));
      const files = materializeCoworkAttachments(this.db, session.id, ownerMessage.attachments);
      prepared = this.runtime.prepare({
        session,
        prompt: coworkContentWithAttachments(this.db, session.id, prompt, ownerMessage.attachments),
        history,
        images: coworkImageBlocks(files),
      });
    } catch (error) {
      prepared = { error: (error as Error).message || String(error) };
    }
    if ("error" in prepared) {
      this.failBeforeStart(session.id, turn.id, prepared.error);
      return;
    }

    const targetSession = this.db.setCoworkTurnTarget({
      sessionId: session.id,
      turnId: turn.id,
      provider: prepared.target.provider,
      model: prepared.target.model,
      effort: prepared.target.effort,
      // Persist the routing identity, not only a display label. Claude session ids belong to the
      // subscription that created them; resuming under another token would lose context or fail.
      account: prepared.target.accountId,
    });
    if (!targetSession) {
      await prepared.agent.stop().catch(() => {});
      this.failBeforeStart(session.id, turn.id, "The Co-work session changed before its agent could start.");
      return;
    }
    this.publishSession(targetSession);

    const live: LiveCoworkTurn = {
      turnId: turn.id,
      run: prepared.agent,
      cancelled: false,
      timeboxed: false,
      acceptingSteering: true,
      expectedResults: 1,
      steeringAccepted: false,
      rotateStream: () => {},
    };
    this.live.set(session.id, live);
    let streamPart = 0;
    let reply = "";
    let thinking = "";
    let eventError: string | undefined;
    let latestResult: ResultEvent | undefined;
    let totalCostUsd: number | null = null;
    let totalTurns: number | null = null;
    let totalTokenUsage: CoworkTurn["tokenUsage"] = null;
    const seenResults = new Set<ResultEvent>();

    const messageId = (kind: "text" | "thinking"): string =>
      `${turn.id}:${kind === "text" ? "reply" : "thinking"}${streamPart ? `:${streamPart}` : ""}`;
    const persistStream = (kind: "text" | "thinking", content: string, partial: boolean): CoworkMessage =>
      this.db.upsertCoworkMessage({
        id: messageId(kind),
        sessionId: session.id,
        turnId: turn.id,
        role: "coworker",
        kind,
        content,
        partial,
      });
    const sealStream = (): void => {
      if (reply) this.hub.publish({ type: "cowork.message", message: persistStream("text", reply, false) });
      if (thinking) this.hub.publish({ type: "cowork.message", message: persistStream("thinking", thinking, false) });
    };
    live.rotateStream = () => {
      sealStream();
      streamPart++;
      reply = "";
      thinking = "";
    };

    const recordResult = (result: ResultEvent): void => {
      if (seenResults.has(result)) return;
      seenResults.add(result);
      latestResult = result;
      totalCostUsd = addCount(totalCostUsd, result.costUsd);
      totalTurns = addCount(totalTurns, result.numTurns);
      totalTokenUsage = addTokenUsage(totalTokenUsage, result.tokenUsage ?? null);
      if (result.aborted) eventError = undefined;
      if (!reply && !result.isError && result.result?.trim()) {
        reply = result.result;
        this.hub.publish({ type: "cowork.message", message: persistStream("text", reply, false) });
      }
      // Codex/Grok suppress the superseded batch result and emit one final result after consuming every
      // buffered update. Claude/z.ai emit one result per user message, including an explicit aborted
      // result when priority-now steering supersedes the current response.
      if (prepared.agent.steeringResultMode === "coalesced" && live.steeringAccepted && !result.aborted) {
        live.expectedResults = 0;
      } else {
        live.expectedResults = Math.max(0, live.expectedResults - 1);
      }
      if (result.isError && !result.aborted) live.expectedResults = 0;
      if (live.expectedResults === 0) live.acceptingSteering = false;
      else live.rotateStream();
    };

    const off = prepared.agent.onEvent((event) => {
      switch (event.type) {
        case "init": {
          if (!event.sessionId) break;
          // Keep the linkage durable during the turn, not only after it. A server bounce can then retain
          // the provider session that was already established even when no terminal result arrived.
          const current = this.db.setCoworkAgentSession(session.id, turn.id, event.sessionId);
          if (current) this.publishSession(current);
          break;
        }
        case "text_delta":
          reply += event.text;
          persistStream("text", reply, true);
          this.hub.publish({ type: "cowork.delta", sessionId: session.id, turnId: turn.id, messageId: messageId("text"), text: event.text });
          break;
        case "text": {
          // Claude emits deltas followed by the same committed block; CLI backends may emit only text.
          // Avoid doubling the delta stream, while still appending genuinely separate assistant blocks.
          if (!reply) reply = event.text;
          else if (reply !== event.text && !reply.endsWith(event.text)) reply += `${reply.endsWith("\n") ? "" : "\n\n"}${event.text}`;
          const message = persistStream("text", reply, false);
          this.hub.publish({ type: "cowork.message", message });
          break;
        }
        case "thinking_delta":
          thinking += event.text;
          persistStream("thinking", thinking, true);
          this.hub.publish({ type: "cowork.thinking", sessionId: session.id, turnId: turn.id, messageId: messageId("thinking"), text: event.text });
          break;
        case "thinking": {
          if (!thinking) thinking = event.text;
          else if (thinking !== event.text && !thinking.endsWith(event.text)) thinking += `${thinking.endsWith("\n") ? "" : "\n\n"}${event.text}`;
          const message = persistStream("thinking", thinking, false);
          this.hub.publish({ type: "cowork.message", message });
          break;
        }
        case "tool_use": {
          const message = this.db.upsertCoworkMessage({
            id: `${turn.id}:tool:${event.id}`,
            sessionId: session.id,
            turnId: turn.id,
            role: "coworker",
            kind: "tool",
            content: event.name,
            meta: { id: event.id, name: event.name, input: event.input },
          });
          this.hub.publish({ type: "cowork.message", message });
          break;
        }
        case "tool_result": {
          const message = this.db.upsertCoworkMessage({
            id: `${turn.id}:tool-result:${event.id}`,
            sessionId: session.id,
            turnId: turn.id,
            role: "coworker",
            kind: "tool_result",
            content: safeJson(event.content),
            meta: { id: event.id, isError: event.isError },
          });
          this.hub.publish({ type: "cowork.message", message });
          break;
        }
        case "rate_limit":
          this.runtime.observeRateLimit(prepared.target, event.info);
          break;
        case "error":
          eventError = event.message;
          break;
        case "result":
          recordResult(event);
          break;
        default:
          break;
      }
    });

    live.handoffTimer = setTimeout(() => this.requestTimedHandoff(session.id, turn.id), this.timebox.handoffMs);
    live.handoffTimer.unref?.();
    live.stopTimer = setTimeout(() => this.enforceTimedHandoff(session.id, turn.id), this.timebox.stopMs);
    live.stopTimer.unref?.();

    try {
      prepared.agent.start(prepared.startContent);
      let first = true;
      while (true) {
        const result = first ? await prepared.agent.result() : await prepared.agent.nextResult();
        first = false;
        if (result) recordResult(result);
        if (live.cancelled || live.timeboxed || !result) break;
        if (result.isError && !result.aborted) break;
        if (live.expectedResults === 0) break;
        if (prepared.agent.finished) {
          eventError = "The provider ended before every accepted Co-work direction produced a reply.";
          break;
        }
      }
    } catch (error) {
      eventError = (error as Error).message || String(error);
    } finally {
      live.acceptingSteering = false;
      if (live.handoffTimer) clearTimeout(live.handoffTimer);
      if (live.stopTimer) clearTimeout(live.stopTimer);
      off();
      await prepared.agent.stop().catch(() => {});
    }

    sealStream();

    const stillLive = this.live.get(session.id);
    const cancelled = stillLive?.turnId === turn.id && stillLive.cancelled;
    const hardTimebox = stillLive?.turnId === turn.id && stillLive.timeboxed;
    if (stillLive?.turnId === turn.id) this.live.delete(session.id);
    const capped = this.runtime.isCapped(prepared.target, prepared.agent);
    if (capped) this.runtime.noteCap(prepared.target, prepared.agent);
    const turnLimit = latestResult?.subtype === "error_max_turns";
    const timeboxed = hardTimebox || turnLimit;
    const failed = !cancelled && !timeboxed && (!latestResult || (latestResult.isError && !latestResult.aborted) || !!eventError || capped);
    const error = failed
      ? capped
        ? `${prepared.target.model} has no usable capacity for this turn. No substitute was started; send again when that model's capacity is available.`
        : resultError(latestResult, eventError)
      : null;

    const updated = this.db.finishCoworkTurn({
      sessionId: session.id,
      turnId: turn.id,
      state: cancelled ? "cancelled" : timeboxed ? "timeboxed" : failed ? "error" : "done",
      error,
      agentSessionId: prepared.agent.sessionId ?? null,
      costUsd: totalCostUsd,
      numTurns: totalTurns,
      tokenUsage: totalTokenUsage,
    });
    if (cancelled || timeboxed || error) {
      const message = this.db.upsertCoworkMessage({
        sessionId: session.id,
        turnId: turn.id,
        role: "system",
        kind: "system",
        content: cancelled
          ? "Turn stopped. The session is ready for your next instruction."
          : timeboxed
            ? "This collaborative work slice reached its hand-back boundary. Changes and context were preserved; review the progress above and choose the next instruction."
            : error!,
      });
      this.hub.publish({ type: "cowork.message", message });
    }
    if (updated) this.publishSession(updated);
    this.runtime.releasedWorkspace();
  }

  private failBeforeStart(sessionId: string, turnId: string, error: string): void {
    const reason = error.slice(0, MAX_ERROR_CHARS);
    const session = this.db.finishCoworkTurn({ sessionId, turnId, state: "error", error: reason });
    const message = this.db.upsertCoworkMessage({
      sessionId,
      turnId,
      role: "system",
      kind: "system",
      content: reason,
    });
    this.hub.publish({ type: "cowork.message", message });
    if (session) this.publishSession(session);
    this.runtime.releasedWorkspace();
  }

  private publishSession(session: CoworkSession): void {
    this.hub.publish({ type: "cowork.session", session });
  }
}
