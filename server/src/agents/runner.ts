import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentDefinition,
  CanUseTool,
  McpServerConfig,
  Options,
  PermissionMode,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { EventEmitter } from "node:events";
import { config } from "../config.js";
import type { AgentEvent, RateLimitInfo } from "../types.js";

export type UserContent = string | unknown[];

export type SystemPromptSpec =
  | string
  | { type: "preset"; preset: "claude_code"; append?: string };

export interface AgentRunConfig {
  model: string;
  cwd: string;
  systemPrompt?: SystemPromptSpec;
  permissionMode?: PermissionMode;
  allowedTools?: string[];
  disallowedTools?: string[];
  mcpServers?: Record<string, McpServerConfig>;
  agents?: Record<string, AgentDefinition>;
  settingSources?: Array<"user" | "project" | "local">;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  outputFormat?: { type: "json_schema"; schema: Record<string, unknown> };
  includePartialMessages?: boolean;
  maxTurns?: number;
  canUseTool?: CanUseTool;
  resume?: string;
  forkSession?: boolean;
  /** Per-run subscription token — lets concurrent agents run on different accounts. */
  oauthToken?: string;
}

/**
 * Build the child-process env. The cardinal rule: never let ANTHROPIC_API_KEY
 * through, so agents authenticate via the Max subscription only. A long stream
 * close timeout keeps a human-blocked MCP tool (e.g. ask_user) from aborting.
 */
function buildEnv(token?: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT ?? "1800000";
  const oauth = token ?? config.oauthToken;
  if (oauth) env.CLAUDE_CODE_OAUTH_TOKEN = oauth;
  return env;
}

/**
 * An async queue that feeds the SDK's streaming-input generator. push() hands a
 * message to a waiting iterator immediately, or buffers it; close() ends the
 * stream. This is what lets us inject follow-up messages into a live agent.
 */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private buffer: SDKUserMessage[] = [];
  private waiters: ((r: IteratorResult<SDKUserMessage>) => void)[] = [];
  private closed = false;

  push(msg: SDKUserMessage): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: msg, done: false });
    else this.buffer.push(msg);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    let waiter: ((r: IteratorResult<SDKUserMessage>) => void) | undefined;
    while ((waiter = this.waiters.shift())) {
      waiter({ value: undefined as unknown as SDKUserMessage, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    while (true) {
      const next = this.buffer.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.closed) return;
      const result = await new Promise<IteratorResult<SDKUserMessage>>((resolve) =>
        this.waiters.push(resolve),
      );
      if (result.done) return;
      yield result.value;
    }
  }
}

function toUserMessage(
  content: UserContent,
  opts?: { shouldQuery?: boolean; priority?: "now" | "next" | "later" },
): SDKUserMessage {
  const msg: SDKUserMessage = {
    type: "user",
    message: { role: "user", content: content as never },
    parent_tool_use_id: null,
  };
  if (opts?.shouldQuery === false) msg.shouldQuery = false;
  if (opts?.priority) msg.priority = opts.priority;
  return msg;
}

type ResultEvent = Extract<AgentEvent, { type: "result" }>;

/**
 * One running agent. Always streaming-input mode so we can inject mid-flight,
 * change model/permission, and interrupt. Normalizes SDK messages into
 * AgentEvents on its emitter; captures session_id for later resume.
 */
export class AgentRun {
  readonly emitter = new EventEmitter();
  sessionId: string | undefined;
  finished = false;
  lastResult: ResultEvent | undefined;
  /** Set when this run's account was cap-rejected (5h/weekly) — the signal to fail over. */
  rateLimited = false;
  rateLimitInfo: RateLimitInfo | undefined;

  private readonly input = new InputQueue();
  private q: Query | undefined;

  constructor(private readonly cfg: AgentRunConfig) {
    this.emitter.setMaxListeners(50);
  }

  start(firstMessage: UserContent): this {
    const options: Options = {
      model: this.cfg.model,
      cwd: this.cfg.cwd,
      permissionMode: this.cfg.permissionMode ?? "default",
      includePartialMessages: this.cfg.includePartialMessages ?? true,
      settingSources: this.cfg.settingSources ?? [],
      env: buildEnv(this.cfg.oauthToken),
    };
    if (this.cfg.systemPrompt !== undefined) options.systemPrompt = this.cfg.systemPrompt;
    if (this.cfg.allowedTools) options.allowedTools = this.cfg.allowedTools;
    if (this.cfg.disallowedTools) options.disallowedTools = this.cfg.disallowedTools;
    if (this.cfg.mcpServers) options.mcpServers = this.cfg.mcpServers;
    if (this.cfg.agents) options.agents = this.cfg.agents;
    if (this.cfg.effort) options.effort = this.cfg.effort;
    if (this.cfg.outputFormat) options.outputFormat = this.cfg.outputFormat;
    if (this.cfg.maxTurns !== undefined) options.maxTurns = this.cfg.maxTurns;
    if (this.cfg.canUseTool) options.canUseTool = this.cfg.canUseTool;
    if (this.cfg.resume) options.resume = this.cfg.resume;
    if (this.cfg.forkSession) options.forkSession = this.cfg.forkSession;

    this.q = query({ prompt: this.input, options });
    this.input.push(toUserMessage(firstMessage));
    void this.consume();
    return this;
  }

  /** Subscribe to normalized agent events. */
  onEvent(cb: (e: AgentEvent) => void): () => void {
    this.emitter.on("event", cb);
    return () => this.emitter.off("event", cb);
  }

  onEnd(cb: () => void): void {
    if (this.finished) cb();
    else this.emitter.once("end", cb);
  }

  /** Send a follow-up user message into the live session (the inject path). */
  send(content: UserContent, opts?: { shouldQuery?: boolean; priority?: "now" | "next" | "later" }): void {
    this.input.push(toUserMessage(content, opts));
  }

  async interrupt(): Promise<void> {
    try {
      await this.q?.interrupt();
    } catch {
      /* interrupt only valid mid-turn; ignore if idle */
    }
  }

  async setModel(model?: string): Promise<void> {
    await this.q?.setModel(model);
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    await this.q?.setPermissionMode(mode);
  }

  /** Close the input stream — lets the agent finish its current turn and end. */
  endInput(): void {
    this.input.close();
  }

  /** Hard stop: interrupt, close input, tear down the child process. */
  async stop(): Promise<void> {
    await this.interrupt();
    this.input.close();
    try {
      this.q?.close();
    } catch {
      /* already closed */
    }
  }

  /** Resolves on the next result event (or run end). For one-shot agents. */
  result(): Promise<ResultEvent | undefined> {
    if (this.lastResult) return Promise.resolve(this.lastResult);
    return this.nextResult();
  }

  /** Resolves on the NEXT result event regardless of any cached one — for the QA loop. */
  nextResult(): Promise<ResultEvent | undefined> {
    return new Promise((resolve) => {
      const off = this.onEvent((e) => {
        if (e.type === "result") {
          off();
          resolve(e);
        }
      });
      this.emitter.once("end", () => {
        off();
        resolve(this.lastResult);
      });
    });
  }

  private emit(e: AgentEvent): void {
    this.emitter.emit("event", e);
  }

  /** Flag a usage cap that arrived as something OTHER than a rate_limit_event (an assistant-message
   *  `error: "rate_limit"`, or an error result). Sets the failover signal AND emits a rate_limit
   *  event so the AccountManager marks this account capped (selection/failover then avoid it).
   *  Idempotent — only the first cap per run flags, so repeated signals don't re-emit. */
  private flagCapFromSignal(info: RateLimitInfo): void {
    if (this.rateLimited) return;
    this.rateLimited = true;
    this.rateLimitInfo = info;
    this.emit({ type: "rate_limit", info });
  }

  private async consume(): Promise<void> {
    try {
      for await (const message of this.q as Query) {
        this.handle(message);
      }
    } catch (err) {
      this.emit({ type: "error", message: errMessage(err) });
    } finally {
      this.finished = true;
      this.emitter.emit("end");
    }
  }

  private handle(message: SDKMessage): void {
    const m = message as Record<string, any>;
    switch (m.type) {
      case "system":
        if (m.subtype === "init" && typeof m.session_id === "string") {
          this.sessionId = m.session_id;
          this.emit({ type: "init", sessionId: m.session_id });
        }
        break;
      case "assistant": {
        const blocks: any[] = m.message?.content ?? [];
        for (const b of blocks) {
          if (b?.type === "text" && b.text) {
            // A 5h/weekly cap can also surface as a plain assistant TEXT block the CLI injects
            // ("You've hit your session limit · resets 7pm") with no rate_limit_event and no
            // message-level error. Flag the cap and SWALLOW the text so the failover path runs
            // instead of the owner seeing a dead-end "limit" message in the chat.
            if (SESSION_LIMIT_TEXT_RE.test(b.text)) {
              this.flagCapFromSignal({ status: "rejected" });
              continue;
            }
            this.emit({ type: "text", text: b.text });
          } else if (b?.type === "tool_use") {
            this.emit({ type: "tool_use", id: b.id, name: b.name, input: b.input });
          }
        }
        // A 5h/weekly usage cap usually ends the turn as an assistant-message error
        // (SDKAssistantMessageError "rate_limit"), NOT a rate_limit_event — catch it here so the
        // failover path still fires. (Not "overloaded": that's transient server load the SDK retries,
        // and switching accounts wouldn't help.)
        if (m.error === "rate_limit") this.flagCapFromSignal({ status: "rejected" });
        break;
      }
      case "stream_event": {
        const ev = m.event;
        if (ev?.type === "content_block_delta") {
          const d = ev.delta;
          if (d?.type === "text_delta" && d.text) this.emit({ type: "text_delta", text: d.text });
          else if (d?.type === "thinking_delta" && d.thinking) this.emit({ type: "thinking_delta", text: d.thinking });
        }
        break;
      }
      case "user": {
        const blocks = m.message?.content;
        if (Array.isArray(blocks)) {
          for (const b of blocks) {
            if (b?.type === "tool_result") {
              this.emit({ type: "tool_result", id: b.tool_use_id, content: b.content, isError: Boolean(b.is_error) });
            }
          }
        }
        break;
      }
      case "rate_limit_event":
        if (m.rate_limit_info) {
          const info = m.rate_limit_info as RateLimitInfo;
          if (info.status === "rejected") {
            this.rateLimited = true;
            this.rateLimitInfo = info;
          }
          this.emit({ type: "rate_limit", info });
        }
        break;
      case "result": {
        const evt: ResultEvent = {
          type: "result",
          subtype: m.subtype,
          isError: Boolean(m.is_error),
          result: m.result,
          structuredOutput: m.structured_output,
          costUsd: m.total_cost_usd,
          numTurns: m.num_turns,
        };
        this.lastResult = evt;
        // Belt-and-suspenders: a cap can also end the run as an error RESULT (subtype
        // error_during_execution carrying a rate-limit message, or is_error + api_error_status 429)
        // rather than a rate_limit_event / assistant error. Flag BEFORE emitting so the awaiting
        // failover path (which reads agent.rateLimited the moment result() resolves) sees it.
        if (evt.isError && resultLooksRateLimited(m)) this.flagCapFromSignal({ status: "rejected" });
        this.emit(evt);
        break;
      }
      default:
        break;
    }
  }
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

const RATE_LIMIT_RESULT_RE =
  /(rate.?limit|usage limit|session limit|hour limit|limit reached|too many requests|quota (?:exceeded|reached))/i;

/**
 * Tight match for the CLI's own session-limit notice as it appears in an assistant TEXT block
 * ("You've hit your session limit · resets 7pm", "You've hit your usage limit · resets …").
 * Deliberately narrower than RATE_LIMIT_RESULT_RE so a legitimate message that merely mentions a
 * rate/session limit (e.g. the director explaining a cap to the owner) isn't swallowed.
 */
const SESSION_LIMIT_TEXT_RE =
  /you'?ve hit your (?:session|usage|\d+-hour|weekly) limit|(?:session|usage|weekly) limit\s*[·:—–-]\s*resets/i;

/**
 * Whether an ERROR result looks like a usage-cap rejection (vs. error_max_turns / error_max_budget_usd
 * / a real crash). The caller gates this on is_error, so matching the result/errors text here can't
 * false-positive on a successful run that merely mentions rate limits. Checks the structured signals
 * first (429 status, stop_reason) then the human-readable error/result text.
 */
function resultLooksRateLimited(m: Record<string, any>): boolean {
  if (m.api_error_status === 429) return true;
  if (typeof m.stop_reason === "string" && /rate.?limit/i.test(m.stop_reason)) return true;
  const errs = Array.isArray(m.errors) ? m.errors.join(" ") : "";
  const text = typeof m.result === "string" ? m.result : "";
  return RATE_LIMIT_RESULT_RE.test(errs) || RATE_LIMIT_RESULT_RE.test(text);
}
