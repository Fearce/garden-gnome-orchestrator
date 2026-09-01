import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, basename } from "node:path";
import type { Db } from "../db/db.js";
import type { EventHub } from "../events.js";
import type { AgentRunLike, ResultEvent, UserContent } from "../agents/runner.js";
import type {
  CoworkActionResult,
  CoworkMessage,
  CoworkSession,
  CoworkTurn,
  Effort,
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
  prepare(input: { session: CoworkSession; prompt: string; history: CoworkMessage[] }): PreparedCoworkRun | { error: string };
  taskConflict(workspace: string): string | null;
  observeRateLimit(target: CoworkTarget, info: RateLimitInfo): void;
  isCapped(target: CoworkTarget, agent: AgentRunLike): boolean;
  noteCap(target: CoworkTarget, agent: AgentRunLike): void;
  releasedWorkspace(): void;
}

interface LiveCoworkTurn {
  turnId: string;
  run: AgentRunLike;
  cancelled: boolean;
}

const MAX_ERROR_CHARS = 8_000;

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

/** Durable, one-turn-at-a-time, human-led coding conversations. This class never creates a Thread and
 * has no planner/QA/supervisor hooks; completing a turn always returns the session to idle. */
export class CoworkManager {
  private readonly live = new Map<string, LiveCoworkTurn>();

  constructor(
    readonly db: Db,
    readonly hub: EventHub,
    private readonly runtime: CoworkRuntime,
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
    this.hub.publish({ type: "cowork.removed", sessionId });
    return { ok: true };
  }

  /** Claims and starts one bounded turn, but does not await its potentially long agent run. The durable
   * user echo and running state are visible before this method returns to the WebSocket handler. */
  send(sessionId: string, prompt: string, clientId?: string): CoworkActionResult {
    const text = prompt.trim();
    if (!text) return { ok: false, error: "Write an instruction first." };
    const session = this.db.getCoworkSession(sessionId);
    if (!session) return { ok: false, error: "Co-work session not found." };
    if (!existsSync(session.workspace)) return { ok: false, session, error: `Workspace "${session.workspace}" no longer exists.` };
    const conflict = this.runtime.taskConflict(session.workspace);
    if (conflict) return { ok: false, session, error: conflict };
    if ([...this.live.entries()].some(([id]) => id !== sessionId && this.sameWorkspace(id, session.workspace))) {
      return { ok: false, session, error: "Another Co-worker turn is already using this workspace. Stop it or wait for it to finish." };
    }

    // Read the prior transcript before beginCoworkTurn adds this prompt; fresh-session fallback should
    // include the history once and the current instruction once.
    const history = this.db.listCoworkMessages(sessionId);
    const claimed = this.db.beginCoworkTurn(sessionId, text, clientId);
    if (!claimed.ok) return { ok: false, session: claimed.session ?? undefined, error: claimed.error };
    this.hub.publish({ type: "cowork.message", message: claimed.message });
    this.publishSession(claimed.session);
    void this.execute(claimed.session, claimed.turn, text, history);
    return { ok: true, session: claimed.session };
  }

  async stop(sessionId: string): Promise<CoworkActionResult> {
    const session = this.db.getCoworkSession(sessionId);
    if (!session) return { ok: false, error: "Co-work session not found." };
    const live = this.live.get(sessionId);
    if (!session.activeTurnId || !live) {
      return { ok: false, session, error: "No Co-worker turn is running." };
    }
    live.cancelled = true;
    const stopping = this.db.setCoworkStopping(sessionId, live.turnId);
    if (stopping) this.publishSession(stopping);
    try {
      await live.run.stop();
    } catch {
      // execute() owns the terminal transition and remains able to settle after a failed stop call.
    }
    return { ok: true, session: this.db.getCoworkSession(sessionId) ?? session };
  }

  private sameWorkspace(sessionId: string, workspace: string): boolean {
    const other = this.db.getCoworkSession(sessionId);
    return !!other && normalizeWorkspace(other.workspace) === normalizeWorkspace(workspace);
  }

  private async execute(session: CoworkSession, turn: CoworkTurn, prompt: string, history: CoworkMessage[]): Promise<void> {
    let prepared: PreparedCoworkRun | { error: string };
    try {
      prepared = this.runtime.prepare({ session, prompt, history });
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

    const live: LiveCoworkTurn = { turnId: turn.id, run: prepared.agent, cancelled: false };
    this.live.set(session.id, live);
    let reply = "";
    let thinking = "";
    let eventError: string | undefined;
    const replyId = `${turn.id}:reply`;
    const thinkingId = `${turn.id}:thinking`;

    const persistStream = (kind: "text" | "thinking", content: string, partial: boolean): CoworkMessage =>
      this.db.upsertCoworkMessage({
        id: kind === "text" ? replyId : thinkingId,
        sessionId: session.id,
        turnId: turn.id,
        role: "coworker",
        kind,
        content,
        partial,
      });

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
          this.hub.publish({ type: "cowork.delta", sessionId: session.id, turnId: turn.id, messageId: replyId, text: event.text });
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
          this.hub.publish({ type: "cowork.thinking", sessionId: session.id, turnId: turn.id, messageId: thinkingId, text: event.text });
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
        default:
          break;
      }
    });

    let result: ResultEvent | undefined;
    try {
      prepared.agent.start(prepared.startContent);
      result = await prepared.agent.result();
    } catch (error) {
      eventError = (error as Error).message || String(error);
    } finally {
      off();
      await prepared.agent.stop().catch(() => {});
    }

    // A result-only backend still gets a durable reply. Do not replace a richer streamed transcript.
    if (!reply && result?.result?.trim()) {
      reply = result.result;
      const message = persistStream("text", reply, false);
      this.hub.publish({ type: "cowork.message", message });
    } else if (reply) {
      const message = persistStream("text", reply, false);
      this.hub.publish({ type: "cowork.message", message });
    }
    if (thinking) {
      const message = persistStream("thinking", thinking, false);
      this.hub.publish({ type: "cowork.message", message });
    }

    const stillLive = this.live.get(session.id);
    const cancelled = stillLive?.turnId === turn.id && stillLive.cancelled;
    if (stillLive?.turnId === turn.id) this.live.delete(session.id);
    const capped = this.runtime.isCapped(prepared.target, prepared.agent);
    if (capped) this.runtime.noteCap(prepared.target, prepared.agent);
    const failed = !cancelled && (!result || result.isError || !!eventError || capped);
    const error = failed
      ? capped
        ? `${prepared.target.model} has no usable capacity for this turn. No substitute was started; send again when that model's capacity is available.`
        : resultError(result, eventError)
      : null;

    const updated = this.db.finishCoworkTurn({
      sessionId: session.id,
      turnId: turn.id,
      state: cancelled ? "cancelled" : failed ? "error" : "done",
      error,
      agentSessionId: prepared.agent.sessionId ?? null,
      costUsd: result?.costUsd ?? null,
      numTurns: result?.numTurns ?? null,
      tokenUsage: result?.tokenUsage ?? null,
    });
    if (cancelled || error) {
      const message = this.db.upsertCoworkMessage({
        sessionId: session.id,
        turnId: turn.id,
        role: "system",
        kind: "system",
        content: cancelled ? "Turn stopped. The session is ready for your next instruction." : error!,
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
