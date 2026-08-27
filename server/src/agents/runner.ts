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
import type { Account } from "../accounts/account.js";
import { config } from "../config.js";
import { logCrash } from "../crashLog.js";
import type { AgentEvent, RateLimitInfo, TokenUsage } from "../types.js";
import { withAgentToolPath } from "./env.js";

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
  /** Alternate Anthropic-compatible endpoint (z.ai GLM). When set with `authToken`, the run is routed
   *  there via ANTHROPIC_BASE_URL instead of the Claude subscription — see buildEnv. */
  baseUrl?: string;
  /** Bearer auth token for `baseUrl` (the z.ai API key), sent as ANTHROPIC_AUTH_TOKEN. */
  authToken?: string;
}

export type SendOpts = { shouldQuery?: boolean; priority?: "now" | "next" | "later" };

export type ResultEvent = Extract<AgentEvent, { type: "result" }>;

/** The `terminal_reason` values the CLI stamps on a turn its abort controller killed — the client asked
 *  for it (a `priority: "now"` message, `interrupt()`, `stop()`), so it is never the run's own verdict.
 *  These two are the whole set the CLI itself treats as "aborted"; every other reason ends a real turn. */
const ABORTED_TERMINAL_REASONS = new Set(["aborted_streaming", "aborted_tools"]);

function finiteCount(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/** Normalize the SDK's per-model accounting. Summing modelUsage preserves mixed-model turns (including
 *  fallback aliases) and avoids relying on the provider-specific shape of the aggregate `usage` field. */
export function claudeTokenUsage(modelUsage: unknown): TokenUsage | undefined {
  if (!modelUsage || typeof modelUsage !== "object") return undefined;
  const rows = Object.values(modelUsage as Record<string, Record<string, unknown>>);
  if (!rows.length) return undefined;
  const usage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  };
  for (const row of rows) {
    usage.inputTokens += finiteCount(row.inputTokens);
    usage.outputTokens += finiteCount(row.outputTokens);
    usage.cacheReadInputTokens += finiteCount(row.cacheReadInputTokens);
    usage.cacheCreationInputTokens += finiteCount(row.cacheCreationInputTokens);
  }
  usage.totalTokens = usage.inputTokens + usage.outputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
  return usage;
}

/**
 * The public surface every agent backend exposes to the orchestrator — the seam that lets a Codex
 * CLI run (CodexAgentRun) stand in for a Claude SDK run (AgentRun) at the implementor dispatch
 * without the pipeline knowing which provider it's driving. Both classes implement this; the
 * thread manager stores and steers runs through it, constructing the concrete class only at the
 * single provider-factory call in startImplementor.
 */
export interface AgentRunLike {
  readonly emitter: EventEmitter;
  sessionId: string | undefined;
  finished: boolean;
  lastResult: ResultEvent | undefined;
  rateLimited: boolean;
  rateLimitInfo: RateLimitInfo | undefined;
  /** The run ended on a retryable provider/transport failure (5xx, overload, timeout), not a usage cap. */
  transientApiError: boolean;
  transientApiErrorMessage: string | undefined;
  start(firstMessage: UserContent): this;
  onEvent(cb: (e: AgentEvent) => void): () => void;
  onEnd(cb: () => void): void;
  send(content: UserContent, opts?: SendOpts): void;
  interrupt(): Promise<void>;
  setModel(model?: string): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  endInput(): void;
  stop(): Promise<void>;
  result(): Promise<ResultEvent | undefined>;
  nextResult(): Promise<ResultEvent | undefined>;
}

/**
 * The run's backend + subscription identity, published to the agent process as plain (non-secret) env
 * vars. Claude Code's own usage hook (`~/.claude/usage-watcher/handoff_gate.py`) reads them to decide
 * WHICH subscription a session is burning: agents run on per-account tokens, so a machine-global "usage
 * is high" signal derived from one sub would otherwise fire a handoff warning in every session,
 * including the ones running on a sub with plenty of headroom.
 */
const RUN_IDENTITY_ENV = ["CLAUDE_ORCH_PROVIDER", "CLAUDE_ORCH_ACCOUNT_ID", "CLAUDE_ORCH_ACCOUNT_LABEL"] as const;

/**
 * Which configured subscription a run's token belongs to. Derived from the token the run actually
 * authenticates with, so the published identity can never drift from the credential. Undefined when the
 * run rides the inherited CLI login — that account's usage is what the machine-global watcher already
 * measures, so the hook's default path is correct for it. Pure (accounts passed in) so it unit-tests
 * without seeding the process env config is read from.
 */
export function accountForToken(accounts: Account[], token: string | undefined): Account | undefined {
  if (!token) return undefined;
  return accounts.find((a) => a.token && a.token === token);
}

/**
 * Build the child-process env. The cardinal rule: never let ANTHROPIC_API_KEY
 * through, so agents authenticate via the Max subscription only. A long stream
 * close timeout keeps a human-blocked MCP tool (e.g. ask_user) from aborting.
 *
 * When `baseUrl` + `authToken` are given (a z.ai GLM run), the request is routed to that
 * Anthropic-compatible endpoint via ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN instead of the Claude
 * subscription — the subscription OAuth token is dropped so the run bills the alternate provider only.
 *
 * Exported for `test:account-usage`: the three RUN_IDENTITY_ENV names are a contract with a hook in
 * another repo, so a rename here has to fail a gate rather than silently stop identifying sessions.
 */
export function buildEnv(opts: { oauthToken?: string; baseUrl?: string; authToken?: string }): Record<string, string | undefined> {
  const env = withAgentToolPath();
  delete env.ANTHROPIC_API_KEY;
  // Clear any inherited endpoint override so a stray env var can't redirect a normal Claude run; the
  // z.ai branch below sets them deliberately for its own run only.
  delete env.ANTHROPIC_BASE_URL;
  delete env.ANTHROPIC_AUTH_TOKEN;
  // Same reason: this process may itself have been started from an agent shell, and an inherited
  // identity would mislabel every run it spawns. Each branch below states its own.
  for (const key of RUN_IDENTITY_ENV) delete env[key];
  env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT ?? "1800000";
  if (opts.baseUrl && opts.authToken) {
    delete env.CLAUDE_CODE_OAUTH_TOKEN; // don't leak a Claude sub token to the alternate provider
    env.ANTHROPIC_BASE_URL = opts.baseUrl;
    env.ANTHROPIC_AUTH_TOKEN = opts.authToken;
    env.API_TIMEOUT_MS = env.API_TIMEOUT_MS ?? String(config.zai.timeoutMs);
    env.CLAUDE_ORCH_PROVIDER = "zai";
    return env;
  }
  const oauth = opts.oauthToken ?? config.oauthToken;
  if (oauth) env.CLAUDE_CODE_OAUTH_TOKEN = oauth;
  env.CLAUDE_ORCH_PROVIDER = "claude";
  const account = accountForToken(config.accounts, oauth);
  if (account) {
    env.CLAUDE_ORCH_ACCOUNT_ID = account.id;
    env.CLAUDE_ORCH_ACCOUNT_LABEL = account.label;
  }
  return env;
}

/**
 * An async queue that feeds the SDK's streaming-input generator. push() hands a
 * message to a waiting iterator immediately, or buffers it; close() ends the
 * stream. This is what lets us inject follow-up messages into a live agent.
 */
// Safety valve: injected messages buffer here only while the SDK generator isn't pulling — normally near
// zero. If it ever climbs this high the consumer has stalled (the run effectively ended); drop the oldest
// so a stuck iterator can't accumulate an unbounded object graph and drift the process toward OOM.
const MAX_INPUT_QUEUE = 1000;

class InputQueue implements AsyncIterable<SDKUserMessage> {
  private buffer: SDKUserMessage[] = [];
  private waiters: ((r: IteratorResult<SDKUserMessage>) => void)[] = [];
  private closed = false;

  push(msg: SDKUserMessage): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: msg, done: false });
      return;
    }
    this.buffer.push(msg);
    if (this.buffer.length > MAX_INPUT_QUEUE) {
      logCrash("inputQueue.overflow", `dropping oldest of ${this.buffer.length} buffered input messages (consumer stalled)`);
      this.buffer.shift();
    }
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

/**
 * One running agent. Always streaming-input mode so we can inject mid-flight,
 * change model/permission, and interrupt. Normalizes SDK messages into
 * AgentEvents on its emitter; captures session_id for later resume.
 */
export class AgentRun implements AgentRunLike {
  readonly emitter = new EventEmitter();
  sessionId: string | undefined;
  finished = false;
  lastResult: ResultEvent | undefined;
  /** Set when this run's account was cap-rejected (5h/weekly) — the signal to fail over. */
  rateLimited = false;
  rateLimitInfo: RateLimitInfo | undefined;
  transientApiError = false;
  transientApiErrorMessage: string | undefined;

  private readonly input = new InputQueue();
  private q: Query | undefined;

  constructor(private readonly cfg: AgentRunConfig) {
    this.emitter.setMaxListeners(50);
  }

  /** Cap wording specific to the backend this run talks to, beyond the Claude CLI's own notice.
   *  Undefined on the Claude path — a non-Anthropic backend overrides it (see ZaiAgentRun). */
  protected get providerCapText(): RegExp | undefined {
    return undefined;
  }

  start(firstMessage: UserContent): this {
    const options: Options = {
      model: this.cfg.model,
      cwd: this.cfg.cwd,
      permissionMode: this.cfg.permissionMode ?? "default",
      includePartialMessages: this.cfg.includePartialMessages ?? true,
      settingSources: this.cfg.settingSources ?? [],
      env: buildEnv({ oauthToken: this.cfg.oauthToken, baseUrl: this.cfg.baseUrl, authToken: this.cfg.authToken }),
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
    // A steering abort can be the last event before the owner cancels/stops the run.  Callers that
    // correctly discard that aborted result then ask for the next outcome; if `end` already fired in
    // the tiny gap, subscribing below would wait forever for an event that cannot recur.
    if (this.finished) return Promise.resolve(this.lastResult);
    return new Promise((resolve) => {
      const onEnd = () => {
        off();
        resolve(this.lastResult);
      };
      const off = this.onEvent((e) => {
        if (e.type === "result") {
          this.emitter.off("end", onEnd);
          off();
          resolve(e);
        }
      });
      this.emitter.once("end", onEnd);
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

  private flagTransientApiError(value: unknown): void {
    const info = transientApiErrorInfo(value);
    if (!info || this.transientApiError) return;
    this.transientApiError = true;
    this.transientApiErrorMessage = info.message;
  }

  private async consume(): Promise<void> {
    try {
      for await (const message of this.q as Query) {
        this.handle(message);
      }
    } catch (err) {
      const message = errMessage(err);
      this.flagTransientApiError(message);
      this.emit({ type: "error", message });
      // Transport/provider failures can throw before the SDK emits its normal result message. Synthesize
      // one so the orchestration layer can apply its bounded retry/failover policy instead of seeing an
      // ambiguous undefined result and parking the task.
      if (this.transientApiError && !this.lastResult) {
        const evt: ResultEvent = { type: "result", subtype: "error_during_execution", isError: true, result: message };
        this.lastResult = evt;
        this.emit(evt);
      }
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
            this.flagTransientApiError(b.text);
            // A cap can also surface as a plain assistant TEXT block the CLI injects
            // ("You've hit your session limit · resets 7pm") with no rate_limit_event and no
            // message-level error. Flag the cap and SWALLOW the text so the failover path runs
            // instead of the owner seeing a dead-end "limit" message in the chat.
            if (looksLikeCapNotice(b.text, this.providerCapText)) {
              // This per-session cap is invisible to the usage-ping headers (which track only the
              // 5h/weekly windows), so unless we tell AccountManager, the account keeps looking free:
              // a cap-parked task is auto-resumed, instantly re-caps, and loops — re-showing this very
              // message. flagCapFromSignal emits the synthetic rate_limit that holds the account out of
              // rotation until the window resets — once per run, since the CLI repeats this notice and
              // each event reaches AccountManager. Preserve either a provider-stated absolute reset
              // or a short clock reset; fall back to the ~5h session cadence when absent, so the hold
              // always self-expires.
              this.flagCapFromSignal(capInfoFromText(b.text));
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
        if (m.error === "rate_limit") {
          const text = [typeof m.error === "string" ? m.error : "", ...blocks.map((b) => b?.text ?? "")].join("\n");
          this.flagCapFromSignal(capInfoFromText(text));
        }
        else if (m.error) this.flagTransientApiError({ error: m.error, message: blocks.map((b) => b?.text ?? "").join(" ") });
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
          errors: Array.isArray(m.errors) ? m.errors.filter((e: unknown) => typeof e === "string") : undefined,
          structuredOutput: m.structured_output,
          costUsd: m.total_cost_usd,
          numTurns: m.num_turns,
          tokenUsage: claudeTokenUsage(m.modelUsage),
        };
        // An ABORTED turn is not an outcome. The CLI ends one with subtype "success", is_error false and
        // an EMPTY `result` — identical, in every field the pipeline reads, to a turn that finished. Only
        // `terminal_reason` tells them apart (the CLI's own predicate is aborted_streaming || aborted_tools),
        // so carry that through and never cache it as `lastResult`: an aborted turn must not become the
        // answer a later `result()` returns, nor the state `finalizeRun` stamps on the row.
        if (typeof m.terminal_reason === "string") evt.terminalReason = m.terminal_reason;
        if (ABORTED_TERMINAL_REASONS.has(m.terminal_reason)) evt.aborted = true;
        else this.lastResult = evt;
        // Belt-and-suspenders: a cap can also end the run as an error RESULT (subtype
        // error_during_execution carrying a rate-limit message, or is_error + api_error_status 429)
        // rather than a rate_limit_event / assistant error. Flag BEFORE emitting so the awaiting
        // failover path (which reads agent.rateLimited the moment result() resolves) sees it.
        if (evt.isError && resultLooksRateLimited(m, this.providerCapText)) {
          const text = [
            typeof m.result === "string" ? m.result : "",
            typeof m.message === "string" ? m.message : "",
            ...(Array.isArray(m.errors) ? m.errors.filter((e: unknown): e is string => typeof e === "string") : []),
          ].join("\n");
          this.flagCapFromSignal(capInfoFromText(text));
        }
        if (evt.isError) this.flagTransientApiError(m);
        this.emit(evt);
        break;
      }
      default:
        break;
    }
  }
}

/**
 * A z.ai (Zhipu GLM) implementor run. Behaviorally identical to AgentRun — it just carries `baseUrl` +
 * `authToken` in its config so buildEnv routes it to z.ai's Anthropic-compatible endpoint. The nominal
 * subclass exists purely so the thread manager can identify a z.ai run via `instanceof` (providerForRun,
 * the cap-failover flip): z.ai is AgentRun-based but is NOT a Claude account, so its usage cap must be
 * handled like a CLI backend's (fail over to another provider) rather than as a Claude-account failover.
 */
export class ZaiAgentRun extends AgentRun {
  protected override get providerCapText(): RegExp {
    return ZAI_CAP_TEXT_RE;
  }
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export interface TransientApiErrorInfo {
  status?: number;
  message: string;
}

// The unreachable-API forms (`unable to connect to api`, ECONNREFUSED, failed-to-open-socket) belong here for
// the same reason a 5xx does: the provider, not the work, is at fault, so the bounded retry-then-hand-off is
// the right response. They are matched tightly enough not to catch prose about connecting something, since a
// false positive here spends MAX_TRANSIENT_API_FAILURES relaunches before giving up.
const TRANSIENT_API_ERROR_RE =
  /(?:(?:api\s*(?:error|status)?|http(?:\s+status)?)\s*[:=]?\s*(?:500|502|503|504|520|522|524|529)\b|overload(?:ed|_error)?|internal server error|service unavailable|bad gateway|gateway timeout|upstream (?:error|failure)|temporar(?:y|ily) unavailable|connection (?:reset|closed|refused)|unable to connect to (?:the )?api|failed ?to ?open ?socket|ECONNRESET|ECONNREFUSED|ETIMEDOUT|fetch failed|socket hang up)/i;

/** Classify retryable provider/transport failures without conflating them with quota/auth/client errors. */
export function transientApiErrorInfo(value: unknown): TransientApiErrorInfo | undefined {
  const obj = value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
  const rawStatus = obj?.api_error_status ?? obj?.status ?? obj?.statusCode;
  const status = typeof rawStatus === "number" ? rawStatus : typeof rawStatus === "string" ? Number(rawStatus) : undefined;
  const stringify = (x: unknown): string | undefined => {
    if (typeof x === "string") return x;
    if (x == null) return undefined;
    try {
      return JSON.stringify(x);
    } catch {
      return String(x);
    }
  };
  const parts = [
    typeof value === "string" ? value : undefined,
    stringify(obj?.message),
    stringify(obj?.error),
    stringify(obj?.result),
    Array.isArray(obj?.errors) ? obj.errors.join(" ") : undefined,
  ].filter((x): x is string => typeof x === "string" && !!x.trim());
  const message = parts.join(" ").trim() || (status ? `API error ${status}` : "");
  // 429 belongs to the existing usage-cap path. Other 4xx responses generally need operator action,
  // not retries. Retry server-side 5xx errors and known transient transport wording.
  if (status != null && status >= 500 && status <= 599) return { status, message };
  if (TRANSIENT_API_ERROR_RE.test(message)) return { status: Number.isFinite(status) ? status : undefined, message };
  return undefined;
}

const RATE_LIMIT_RESULT_RE =
  /(rate.?limit|usage limit|session limit|hour limit|limit reached|too many requests|quota (?:exceeded|reached))/i;

/**
 * Tight match for the CLI's own session-limit notice as it appears in an assistant TEXT block
 * ("You've hit your session limit · resets 7pm", "You've hit your usage limit · resets …"). The
 * optional fable/model slot also catches a model-scoped pool notice ("You've hit your Fable usage
 * limit"), which classifyCap then routes to the same-account model fallback instead of an account
 * switch — the slot names those qualifiers rather than any word, so ordinary advice like "you've hit
 * your daily usage limit" isn't swallowed. Deliberately narrower than RATE_LIMIT_RESULT_RE so a
 * legitimate message that merely mentions a rate/session limit (e.g. the director explaining a cap
 * to the owner) isn't swallowed either.
 */
const SESSION_LIMIT_TEXT_RE =
  /you'?ve hit your (?:fable[\w .-]{0,10}?|model )?(?:session|usage|\d+-hour|weekly) limit|(?:session|usage|weekly) limit\s*[·:—–-]\s*resets/i;

/**
 * z.ai announces a spent quota in its own words, sharing none of Anthropic's phrasing — the run's last
 * assistant text (and its error result) reads `API Error: Request rejected (429) · [1310][Weekly/Monthly
 * Limit Exhausted. Your limit will reset at 2026-08-07 05:17:25]`. Matched by neither regex above, such a
 * cap was recorded as an ordinary crash: no `noteZaiCap` latch, no provider hand-off, and the sweep's
 * triage reported it as a real failure needing a human.
 *
 * ANCHORED, because the matching branch swallows the text and latches the backend: every notice
 * production has recorded IS the whole message, while an agent that merely quotes one — this repo's own
 * source now contains the literal — always has words before it. Requires the rejection envelope AND a
 * limit word, and is reachable only through `ZaiAgentRun.providerCapText`, so it can never speak for a
 * Claude run.
 */
const ZAI_CAP_TEXT_RE = /^\s*(?:api error:\s*)?request rejected \(429\)[^\n]{0,160}\blimit (?:exhausted|reached)/i;

/** Whether an assistant TEXT block is a usage-cap notice — the CLI's own wording, plus the backend's. */
export function looksLikeCapNotice(text: string, providerCapText?: RegExp): boolean {
  return SESSION_LIMIT_TEXT_RE.test(text) || (providerCapText?.test(text) ?? false);
}

// A session-limit notice with no parseable reset clock is held for the ~5h session cadence, so the cap
// self-expires and the account rejoins rotation rather than staying stuck limited forever.
const SESSION_LIMIT_FALLBACK_MS = 5 * 60 * 60 * 1000;

/**
 * Best-effort epoch for a "resets 7pm" / "resets 12:50pm" clock from the CLI's session-limit text,
 * in server-local time (the reset is a wall-clock time; any "(Europe/Copenhagen)" TZ label is ignored —
 * a real rate_limit_event's header reset is used in preference when one is available). Rolls to the next
 * day when the time has already passed today. Returns undefined when no clock is present.
 */
function parseResetClock(text: string, now: number): number | undefined {
  const m = /resets?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(text);
  if (!m) return undefined;
  let hour = parseInt(m[1]!, 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  const ap = m[3]?.toLowerCase();
  if (hour > 23 || min > 59) return undefined;
  if (ap === "pm" && hour < 12) hour += 12;
  else if (ap === "am" && hour === 12) hour = 0;
  const d = new Date(now);
  d.setHours(hour, min, 0, 0);
  let t = d.getTime();
  if (t <= now) t += 24 * 60 * 60 * 1000; // already passed today → next occurrence
  return t;
}

/** Best-effort reset timestamp from provider text such as Codex's
 * `try again at Sep 2nd, 2026 2:23 PM` or a CLI's `resets 7pm`. Providers that expose a structured
 * rate-limit event still win with that authoritative value; this prevents a plain-text quota rejection
 * from being held only for the generic cooldown. */
export function parseUsageLimitResetAt(text: string, now = Date.now()): number | undefined {
  const absolute = /(?:try again|reset(?:s)?|available again)\s+(?:at\s+)?([A-Z][a-z]{2,8}\s+\d{1,2}(?:st|nd|rd|th)?[,]?\s+\d{4}\s+\d{1,2}:\d{2}\s*(?:am|pm)?)/i.exec(text);
  if (absolute?.[1]) {
    const parsed = Date.parse(absolute[1].replace(/(\d)(st|nd|rd|th)\b/gi, "$1"));
    if (Number.isFinite(parsed) && parsed > now) return parsed;
  }
  // z.ai (and several OpenAI-compatible gateways) state resets in a numeric timestamp such as
  // `Your limit will reset at 2026-08-22 06:06:05`. It is provider-local wall-clock time, just like
  // the short `resets 7pm` form below, so Date.parse intentionally uses the server's local zone.
  const numeric = /(?:try again|reset(?:s)?|available again)\s+(?:at\s+)?(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?)/i.exec(text);
  if (numeric?.[1]) {
    const parsed = Date.parse(numeric[1]);
    if (Number.isFinite(parsed) && parsed > now) return parsed;
  }
  return parseResetClock(text, now);
}

/** Normalize an unstructured quota error into the same durable cap signal as a rate_limit_event.
 * A future reset time keeps the account/provider out of routing until the provider says it is usable;
 * absent one retains the bounded session fallback rather than a permanent latch. */
function capInfoFromText(text: string, now = Date.now()): RateLimitInfo {
  return {
    status: "rejected",
    resetsAt: parseUsageLimitResetAt(text, now) ?? now + SESSION_LIMIT_FALLBACK_MS,
  };
}

/**
 * Whether an ERROR result looks like a usage-cap rejection (vs. error_max_turns / error_max_budget_usd
 * / a real crash). The caller gates this on is_error, so matching the result/errors text here can't
 * false-positive on a successful run that merely mentions rate limits. Checks the structured signals
 * first (429 status, stop_reason) then the human-readable error/result text — the run's own backend
 * contributes its wording via `providerCapText`, since only Anthropic's phrasing is known here.
 * Exported for `test:zai-cap`; the sole production caller is the result branch above.
 */
export function resultLooksRateLimited(m: Record<string, any>, providerCapText?: RegExp): boolean {
  if (m.api_error_status === 429) return true;
  if (typeof m.stop_reason === "string" && /rate.?limit/i.test(m.stop_reason)) return true;
  const errs = Array.isArray(m.errors) ? m.errors.join(" ") : "";
  const text = typeof m.result === "string" ? m.result : "";
  const capped = (s: string): boolean => RATE_LIMIT_RESULT_RE.test(s) || (providerCapText?.test(s) ?? false);
  return capped(errs) || capped(text);
}
