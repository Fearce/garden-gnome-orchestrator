import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { AgentEvent, RateLimitInfo, TokenUsage } from "../types.js";
import type { AgentRunLike, ResultEvent, UserContent } from "./runner.js";
import { parseStructuredText, type JsonSchemaLike } from "./structuredText.js";
import { SHARE_CALL_MAX_CHARS, SHARE_CALL_MAX_MESSAGES, type RelayShareErrorCode, type RelayShareMessage } from "../office/onlineProtocol.js";
import type { ShareCallResult } from "../office/directorShare/client.js";

/** Conversations of shared Director sessions, by session id. In memory only, like the Director's own
 *  session map: after a restart the Director bootstraps a fresh session from its persisted chat. */
const transcripts = new Map<string, RelayShareMessage[]>();
const MAX_SESSIONS = 20;
const OMITTED = "[Earlier turns of this conversation were omitted to fit the shared request limit.]";

export interface SharedDirectorRunOptions {
  /** Send one model call to the selected share (DirectorShareClient.call). */
  call: (messages: RelayShareMessage[], signal: AbortSignal) => Promise<ShareCallResult>;
  /** The Director command schema the reply is parsed against. */
  schema: JsonSchemaLike;
  resume?: string;
}

/**
 * The recipient's Director turn on another console's shared capacity. It runs entirely on the recipient:
 * the conversation, the command bridge and every tool the Director uses stay here, and only the model call
 * goes to the donor. That call is text in, one JSON command out, so the donor never sees a tool, a file or
 * a memory of the recipient's beyond what the recipient's own prompt says.
 *
 * Batch-shaped like the Codex/Grok director runs: one model call per run, then a structured result the
 * Director executes. A steering message that arrives mid-call is folded into one follow-up call before
 * any result is emitted, so the command the model proposed without it is never executed.
 */
export class SharedDirectorRun implements AgentRunLike {
  readonly emitter = new EventEmitter();
  readonly steeringResultMode = "coalesced" as const;
  sessionId: string | undefined;
  finished = false;
  lastResult: ResultEvent | undefined;
  rateLimited = false;
  rateLimitInfo: RateLimitInfo | undefined;
  transientApiError = false;
  transientApiErrorMessage: string | undefined;
  /** Why the last call failed, for the Director's note. */
  shareError: { code: RelayShareErrorCode; message: string } | undefined;
  lastStructuredError: string | undefined;
  private readonly controller = new AbortController();
  private steering: string[] = [];
  private calling = false;

  constructor(private readonly opts: SharedDirectorRunOptions) {}

  start(firstMessage: UserContent): this {
    const resumed = this.opts.resume ? transcripts.get(this.opts.resume) : undefined;
    this.sessionId = resumed ? this.opts.resume! : `shared-${randomUUID()}`;
    const messages = resumed ?? [];
    messages.push({ role: "user", content: contentText(firstMessage) });
    remember(this.sessionId, messages);
    this.emit({ type: "init", sessionId: this.sessionId });
    void this.loop(messages);
    return this;
  }

  /** Steering during a call is held and folded into the next call of this same turn. */
  send(content: UserContent): void {
    if (this.finished) return;
    const text = contentText(content);
    if (!text.trim()) return;
    if (this.calling) this.steering.push(text);
  }

  private async loop(messages: RelayShareMessage[]): Promise<void> {
    for (;;) {
      this.calling = true;
      const result = await this.opts.call(fitToLimit(messages), this.controller.signal);
      this.calling = false;
      if (this.finished) return;
      if (!result.ok) return this.finish(this.errorResult(result.code, result.message));
      messages.push({ role: "assistant", content: result.text });
      if (this.steering.length) {
        const added = this.steering.splice(0).join("\n\n");
        messages.push({
          role: "user",
          content: `${added}\n\n[This arrived while you were deciding. Your command above was NOT executed; return the command to run now.]`,
        });
        continue;
      }
      const parsed = parseStructuredText(result.text, this.opts.schema);
      this.lastStructuredError = parsed.error;
      return this.finish({
        type: "result",
        subtype: "success",
        isError: false,
        result: result.text,
        structuredOutput: parsed.value,
        numTurns: 1,
        ...(result.usage ? { tokenUsage: tokenUsage(result.usage) } : {}),
      });
    }
  }

  private errorResult(code: RelayShareErrorCode, message: string): ResultEvent {
    this.shareError = { code, message };
    this.transientApiError = code === "busy" || code === "timeout" || code === "rate-limited";
    this.transientApiErrorMessage = this.transientApiError ? message : undefined;
    return { type: "result", subtype: "error", isError: true, result: message, errors: [message] };
  }

  private finish(result: ResultEvent): void {
    if (this.finished) return;
    this.lastResult = result;
    this.emit(result);
    this.finished = true;
    this.emitter.emit("end");
  }

  private emit(e: AgentEvent): void {
    this.emitter.emit("event", e);
  }

  onEvent(cb: (e: AgentEvent) => void): () => void {
    this.emitter.on("event", cb);
    return () => this.emitter.off("event", cb);
  }

  onEnd(cb: () => void): void {
    if (this.finished) cb();
    else this.emitter.once("end", cb);
  }

  async interrupt(): Promise<void> {
    await this.stop();
  }

  async setModel(): Promise<void> {}
  async setPermissionMode(): Promise<void> {}
  endInput(): void {}

  /** Cancel the call at the donor (the client sends `share.cancel` on abort) and end the run. */
  async stop(): Promise<void> {
    this.controller.abort();
    if (this.finished) return;
    this.finished = true;
    this.emitter.emit("end");
  }

  result(): Promise<ResultEvent | undefined> {
    if (this.lastResult) return Promise.resolve(this.lastResult);
    return this.nextResult();
  }

  nextResult(): Promise<ResultEvent | undefined> {
    return new Promise((resolve) => {
      if (this.finished) return resolve(this.lastResult);
      const off = this.onEvent((e) => {
        if (e.type !== "result") return;
        off();
        resolve(e);
      });
      this.onEnd(() => {
        off();
        resolve(this.lastResult);
      });
    });
  }
}

function remember(sessionId: string, messages: RelayShareMessage[]): void {
  transcripts.delete(sessionId);
  transcripts.set(sessionId, messages);
  while (transcripts.size > MAX_SESSIONS) transcripts.delete(transcripts.keys().next().value as string);
}

/** Keep the opening message (it carries the Director's instructions and the bootstrapped history) and as
 *  many of the most recent messages as fit within both relay limits, marking the gap. */
export function fitToLimit(messages: RelayShareMessage[], limit = SHARE_CALL_MAX_CHARS): RelayShareMessage[] {
  const size = (list: RelayShareMessage[]): number => list.reduce((n, m) => n + m.content.length, 0);
  if (size(messages) <= limit && messages.length <= SHARE_CALL_MAX_MESSAGES) return messages;
  const [first, ...rest] = messages;
  if (!first) return messages;
  const head = { ...first, content: first.content.slice(0, Math.floor(limit * 0.6)) };
  const marker: RelayShareMessage = { role: "user", content: OMITTED };
  let budget = limit - head.content.length - marker.content.length;
  const tail: RelayShareMessage[] = [];
  for (let i = rest.length - 1; i >= 0; i--) {
    if (tail.length >= SHARE_CALL_MAX_MESSAGES - 2) break;
    const m = rest[i]!;
    if (m.content.length > budget) {
      if (!tail.length) tail.unshift({ ...m, content: m.content.slice(-Math.max(0, budget)) });
      break;
    }
    budget -= m.content.length;
    tail.unshift(m);
  }
  return [head, marker, ...tail];
}

/** Text of a user turn. Images cannot be forwarded (the shared call is text only), so each is named. */
function contentText(content: UserContent): string {
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const block of content as Array<{ type?: string; text?: unknown }>) {
    if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block?.type === "image") parts.push("[An image was attached here; a shared Director receives text only.]");
  }
  return parts.join("\n\n");
}

function tokenUsage(u: { inputTokens: number; outputTokens: number }): TokenUsage {
  return {
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: u.inputTokens + u.outputTokens,
  };
}
