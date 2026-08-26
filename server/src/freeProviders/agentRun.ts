import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { realpath, readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { T } from "../agents/toolNames.js";
import { formatStructuredRoleFeed, jsonContractInstruction, parseStructuredText, type JsonSchemaLike } from "../agents/structuredText.js";
import type { AgentRunConfig, AgentRunLike, ResultEvent, SendOpts, UserContent } from "../agents/runner.js";
import { runReadonlyGit } from "../git/readonlyGit.js";
import type { AgentEvent } from "../types.js";
import type {
  NormalizedCompletion,
  NormalizedCompletionRequest,
  ProviderMessage,
  ProviderRequestError,
  ProviderTool,
} from "./types.js";

const MAX_MODEL_CALLS_PER_TURN = 18;
const MAX_TOOL_CALLS_PER_TURN = 48;
// Groq's smallest documented free-model allowance is 8K TPM. Tool output is replayed on every
// subsequent turn, so a 120K-character read budget would make otherwise valid free runs reliably
// exceed that limit. These are deliberately conservative character caps (code is often denser than
// English) and leave room for the task brief, system contract, tool definitions, and 1K completion.
const MAX_TOOL_RESULT_CHARS = 6_000;
const MAX_TOOL_CONTEXT_CHARS = 10_000;
const MAX_READ_BYTES = 2 * 1024 * 1024;
// Groq's published free tier is 8K TPM. A 4K reservation on both sides of one tool call makes an
// otherwise tiny two-turn lookup deterministically exceed that allowance, because providers may count
// the requested completion ceiling toward admission. 1K is ample for the structured planner/reader
// contracts and lets several bounded turns fit inside the smallest verified free token window.
const MAX_OUTPUT_TOKENS = 1_024;
const STRUCTURED_RETRIES = 2;

type FindingSeverity = "info" | "note" | "warning" | "critical";

export interface FreeProviderTaskTarget {
  providerId: string;
  providerName: string;
  model: string;
}

/** A credential-bound lease returned by FreeProviderService. Secrets stay inside the service closure. */
export interface FreeProviderTaskSession {
  readonly target: FreeProviderTaskTarget;
  complete(request: Omit<NormalizedCompletionRequest, "model">): Promise<NormalizedCompletion>;
  markHarnessFailure(reason: string): void;
  close(): void;
}

export interface FreeProviderAgentCallbacks {
  postFinding?: (input: { summary: string; detail?: string; severity: FindingSeverity }) => string;
}

interface ToolExecution {
  content: string;
  isError: boolean;
}

const READ_TOOL: ProviderTool = {
  name: "Read",
  description: "Read a UTF-8 text file inside the task workspace. Paths outside the workspace and binary files are rejected.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["file_path"],
    properties: {
      file_path: { type: "string", description: "Absolute or workspace-relative file path." },
      offset: { type: "integer", minimum: 1, description: "Optional first line (1-based)." },
      limit: { type: "integer", minimum: 1, maximum: 500, description: "Optional maximum lines; default 250." },
    },
  },
};

const GREP_TOOL: ProviderTool = {
  name: "Grep",
  description: "Search text inside the task workspace with ripgrep. Returns file paths, line numbers, and matching lines; never runs a shell.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["pattern"],
    properties: {
      pattern: { type: "string", description: "Rust-regex search pattern." },
      path: { type: "string", description: "Optional workspace-relative file or directory." },
      glob: { type: "string", description: "Optional include glob such as **/*.ts." },
      case_sensitive: { type: "boolean", description: "Default false." },
    },
  },
};

const GLOB_TOOL: ProviderTool = {
  name: "Glob",
  description: "List files inside the task workspace using a glob. Generated/dependency directories are excluded.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["pattern"],
    properties: {
      pattern: { type: "string", description: "Glob such as **/*.ts or docs/**." },
      path: { type: "string", description: "Optional workspace-relative directory." },
    },
  },
};

const GIT_READ_TOOL: ProviderTool = {
  name: T.gitRead,
  description: "Run one allowlisted read-only git command (log, show, status, or diff) in the task workspace. No shell, network, or write commands.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["subcommand"],
    properties: {
      subcommand: { type: "string", enum: ["log", "show", "status", "diff"] },
      args: { type: "array", items: { type: "string" }, description: "Arguments after the read-only subcommand." },
    },
  },
};

const POST_FINDING_TOOL: ProviderTool = {
  name: T.postFinding,
  description: "Post the reader's concrete answer or escalation to this task's finding board. For a read-lane task, this posted finding is the user-facing deliverable.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["summary"],
    properties: {
      summary: { type: "string", description: "Concise answer headline." },
      detail: { type: "string", description: "Full answer with evidence and file references." },
      severity: { type: "string", enum: ["info", "note", "warning", "critical"] },
    },
  },
};

function object(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.floor(parsed))) : fallback;
}

function truncate(value: string, max = MAX_TOOL_RESULT_CHARS): string {
  if (value.length <= max) return value;
  if (max <= 0) return "";
  const marker = "\n\n[truncated by the read-only free-provider harness]";
  if (max <= marker.length) return value.slice(0, max);
  return `${value.slice(0, max - marker.length)}${marker}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function providerErrorKind(error: unknown): ProviderRequestError["kind"] | undefined {
  return error && typeof error === "object" && "kind" in error ? (error as ProviderRequestError).kind : undefined;
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function confinedPath(root: string, raw: string): Promise<string> {
  if (!raw || /[\0\r\n]/.test(raw)) throw new Error("A non-empty workspace path is required.");
  const lexical = resolve(root, raw);
  if (!isInside(root, lexical)) throw new Error("Path is outside the task workspace.");
  const actual = await realpath(lexical);
  if (!isInside(root, actual)) throw new Error("Path resolves outside the task workspace.");
  return actual;
}

async function readTool(root: string, input: Record<string, unknown>): Promise<string> {
  const file = await confinedPath(root, string(input.file_path ?? input.path));
  const info = await stat(file);
  if (!info.isFile()) throw new Error("Read accepts files only.");
  if (info.size > MAX_READ_BYTES) throw new Error(`File is larger than the ${MAX_READ_BYTES / 1024 / 1024} MB read-only limit.`);
  const content = await readFile(file);
  if (content.includes(0)) throw new Error("Binary files are not exposed to the free-provider harness.");
  const lines = content.toString("utf8").replace(/\r\n/g, "\n").split("\n");
  const offset = boundedInt(input.offset, 1, 1, Math.max(1, lines.length));
  const limit = boundedInt(input.limit, 250, 1, 500);
  const selected = lines.slice(offset - 1, offset - 1 + limit);
  return truncate(selected.map((line, index) => `${offset + index}: ${line}`).join("\n") || "(empty file)");
}

async function runBounded(command: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let clipped = false;
    const timer = setTimeout(() => {
      clipped = true;
      child.kill();
    }, 12_000);
    const append = (current: string, chunk: Buffer): string => {
      if (current.length >= MAX_TOOL_RESULT_CHARS) {
        clipped = true;
        child.kill();
        return current;
      }
      return current + chunk.toString("utf8").slice(0, MAX_TOOL_RESULT_CHARS - current.length);
    };
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && code !== 1 && !clipped) {
        reject(new Error(stderr.trim() || `${command} exited ${code ?? "without a status"}.`));
        return;
      }
      const value = stdout.trim() || (code === 1 ? "(no matches)" : "(no output)");
      resolvePromise(truncate(value + (clipped ? "\n\n[search stopped at the output/time limit]" : "")));
    });
  });
}

async function grepTool(root: string, input: Record<string, unknown>): Promise<string> {
  const pattern = string(input.pattern);
  if (!pattern || pattern.length > 1_000 || /[\0\r\n]/.test(pattern)) throw new Error("Search pattern is empty or too long.");
  const searchRoot = await confinedPath(root, string(input.path) || ".");
  const args = ["--line-number", "--no-heading", "--color", "never", "--hidden", "--glob", "!.git/**", "--glob", "!node_modules/**", "--glob", "!dist/**", "--glob", "!build/**"];
  if (input.case_sensitive !== true) args.push("--ignore-case");
  const glob = string(input.glob);
  if (glob) args.push("--glob", glob);
  args.push("--", pattern, searchRoot);
  return runBounded("rg", args, root);
}

async function globTool(root: string, input: Record<string, unknown>): Promise<string> {
  const pattern = string(input.pattern);
  if (!pattern || pattern.length > 500 || /[\0\r\n]/.test(pattern)) throw new Error("Glob is empty or too long.");
  const searchRoot = await confinedPath(root, string(input.path) || ".");
  return runBounded("rg", ["--files", "--hidden", "--glob", pattern, "--glob", "!.git/**", "--glob", "!node_modules/**", "--glob", "!dist/**", "--glob", "!build/**", searchRoot], root);
}

async function gitReadTool(root: string, input: Record<string, unknown>): Promise<string> {
  const subcommand = string(input.subcommand);
  const args = Array.isArray(input.args) ? input.args.filter((value): value is string => typeof value === "string") : [];
  const result = await runReadonlyGit(root, subcommand, args);
  if (!result.ok) throw new Error(result.error ?? "git read failed");
  return truncate(result.output || "(no output)");
}

/**
 * Provider-neutral, read-only agent loop for the free pool. It intentionally implements only the
 * bounded planner/reader surface: no shell, writes, network tools, MCP process, or credential access.
 */
export class FreeProviderAgentRun implements AgentRunLike {
  readonly emitter = new EventEmitter();
  readonly sessionId: string;
  finished = false;
  lastResult: ResultEvent | undefined;
  rateLimited = false;
  rateLimitInfo = undefined;
  transientApiError = false;
  transientApiErrorMessage: string | undefined;

  private readonly queue: UserContent[] = [];
  private readonly messages: ProviderMessage[] = [];
  private readonly rootPromise: Promise<string>;
  private processing: Promise<void> | null = null;
  private closed = false;

  constructor(
    private readonly session: FreeProviderTaskSession,
    private readonly role: "planner" | "reader",
    private readonly cfg: AgentRunConfig,
    private readonly callbacks: FreeProviderAgentCallbacks = {},
  ) {
    this.sessionId = `free:${session.target.providerId}:${Date.now().toString(36)}`;
    this.rootPromise = realpath(cfg.cwd);
    this.emitter.setMaxListeners(50);
    const system = typeof cfg.systemPrompt === "string" ? cfg.systemPrompt : "";
    const schema = cfg.outputFormat?.schema as JsonSchemaLike | undefined;
    this.messages.push({
      role: "system",
      content: [
        system,
        "You are running inside GGO's bounded free-provider harness. Its listed tools are real. You have read-only workspace access: never claim to edit, run shell commands, browse the web, or access secrets.",
        schema ? jsonContractInstruction(schema) : "",
      ].filter(Boolean).join("\n\n"),
    });
  }

  start(firstMessage: UserContent): this {
    this.emit({ type: "init", sessionId: this.sessionId });
    this.send(firstMessage);
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

  send(content: UserContent, _opts?: SendOpts): void {
    if (this.closed) return;
    this.queue.push(content);
    this.pump();
  }

  async interrupt(): Promise<void> {
    // Provider adapters do not currently expose AbortSignal. The planner's injection buffer is still
    // drained before handoff, so letting this bounded request settle preserves correctness without a
    // fake cancellation signal or abandoning an in-flight quota-consuming request.
  }

  async setModel(_model?: string): Promise<void> {}

  async setPermissionMode(_mode: PermissionMode): Promise<void> {}

  endInput(): void {
    void this.stop();
  }

  async stop(): Promise<void> {
    if (this.finished) return;
    this.closed = true;
    this.queue.length = 0;
    await this.processing?.catch(() => undefined);
    this.session.close();
    this.finished = true;
    this.emitter.emit("end");
  }

  result(): Promise<ResultEvent | undefined> {
    return this.lastResult ? Promise.resolve(this.lastResult) : this.nextResult();
  }

  nextResult(): Promise<ResultEvent | undefined> {
    if (this.finished) return Promise.resolve(this.lastResult);
    return new Promise((resolvePromise) => {
      const onEnd = () => {
        off();
        resolvePromise(this.lastResult);
      };
      const off = this.onEvent((event) => {
        if (event.type !== "result") return;
        this.emitter.off("end", onEnd);
        off();
        resolvePromise(event);
      });
      this.emitter.once("end", onEnd);
    });
  }

  private emit(event: AgentEvent): void {
    this.emitter.emit("event", event);
  }

  private pump(): void {
    if (this.processing || this.closed) return;
    this.processing = this.processQueue().finally(() => {
      this.processing = null;
      if (this.queue.length && !this.closed) this.pump();
    });
  }

  private async processQueue(): Promise<void> {
    while (this.queue.length && !this.closed) {
      const content = this.queue.shift();
      const result = await this.executeTurn(content);
      this.lastResult = result;
      this.emit(result);
    }
  }

  private async executeTurn(content: UserContent | undefined): Promise<ResultEvent> {
    if (typeof content !== "string") {
      return this.errorResult("The free-provider read-only harness cannot safely normalize image or block-array input; falling back to the primary backend.");
    }
    this.messages.push({ role: "user", content });
    let modelCalls = 0;
    let toolCalls = 0;
    let toolContextChars = 0;
    let structuredRetries = 0;

    try {
      const root = await this.rootPromise;
      while (modelCalls < MAX_MODEL_CALLS_PER_TURN) {
        modelCalls++;
        const completion = await this.session.complete({
          messages: this.messages,
          tools: this.tools(),
          maxOutputTokens: MAX_OUTPUT_TOKENS,
        });
        if (completion.toolCalls.length) {
          if (toolCalls + completion.toolCalls.length > MAX_TOOL_CALLS_PER_TURN) {
            throw new Error(`The model exceeded the ${MAX_TOOL_CALLS_PER_TURN}-tool safety limit.`);
          }
          this.messages.push({ role: "assistant", content: completion.text, toolCalls: completion.toolCalls });
          if (completion.text.trim()) this.emit({ type: "thinking", text: completion.text.trim() });
          for (const call of completion.toolCalls) {
            toolCalls++;
            const parsed = this.parseArguments(call.arguments);
            this.emit({ type: "tool_use", id: call.id, name: call.name, input: parsed });
            const result = await this.executeTool(root, call.name, parsed);
            const remaining = Math.max(0, MAX_TOOL_CONTEXT_CHARS - toolContextChars);
            const bounded = truncate(result.content, Math.min(MAX_TOOL_RESULT_CHARS, remaining));
            toolContextChars += bounded.length;
            this.emit({ type: "tool_result", id: call.id, content: bounded, isError: result.isError });
            this.messages.push({ role: "tool", content: bounded, toolCallId: call.id, toolName: call.name });
            if (toolContextChars >= MAX_TOOL_CONTEXT_CHARS) {
              this.messages.push({ role: "user", content: "The read context budget is full. Stop calling tools and return your final structured result now." });
              break;
            }
          }
          continue;
        }

        this.messages.push({ role: "assistant", content: completion.text });
        const schema = this.cfg.outputFormat?.schema as JsonSchemaLike | undefined;
        const parsed = schema ? parseStructuredText(completion.text, schema) : { value: undefined };
        if (schema && !parsed.value) {
          if (structuredRetries++ < STRUCTURED_RETRIES) {
            this.messages.push({ role: "user", content: `${parsed.error ?? "The structured result was invalid"}\nCorrect it now. Return the final JSON contract only; do not call more tools unless essential.` });
            continue;
          }
          throw new Error(parsed.error ?? "The provider did not return the required structured result.");
        }
        const feed = formatStructuredRoleFeed(completion.text);
        if (feed.trim()) this.emit({ type: "text", text: feed });
        return {
          type: "result",
          subtype: "success",
          isError: false,
          result: completion.text,
          structuredOutput: parsed.value,
          costUsd: 0,
          numTurns: modelCalls,
        };
      }
      throw new Error(`The free-provider harness reached its ${MAX_MODEL_CALLS_PER_TURN}-request turn limit.`);
    } catch (error) {
      const kind = providerErrorKind(error);
      if (kind === "rate-limit" || kind === "billing") this.rateLimited = true;
      if (kind === "provider-outage" || kind === "network" || kind === "timeout") {
        this.transientApiError = true;
        this.transientApiErrorMessage = errorText(error);
      }
      if (!kind) this.session.markHarnessFailure(errorText(error));
      return this.errorResult(errorText(error), modelCalls);
    }
  }

  private tools(): ProviderTool[] {
    return this.role === "reader"
      ? [READ_TOOL, GREP_TOOL, GLOB_TOOL, GIT_READ_TOOL, POST_FINDING_TOOL]
      : [READ_TOOL, GREP_TOOL, GLOB_TOOL];
  }

  private parseArguments(raw: string): Record<string, unknown> {
    if (raw.length > 100_000) return { __parseError: "Tool arguments exceeded the size limit." };
    try {
      return object(JSON.parse(raw) as unknown);
    } catch {
      return { __parseError: "Tool arguments were not valid JSON." };
    }
  }

  private async executeTool(root: string, name: string, input: Record<string, unknown>): Promise<ToolExecution> {
    try {
      if (input.__parseError) throw new Error(string(input.__parseError));
      if (name === "Read") return { content: await readTool(root, input), isError: false };
      if (name === "Grep") return { content: await grepTool(root, input), isError: false };
      if (name === "Glob") return { content: await globTool(root, input), isError: false };
      if (name === T.gitRead && this.role === "reader") return { content: await gitReadTool(root, input), isError: false };
      if (name === T.postFinding && this.role === "reader" && this.callbacks.postFinding) {
        const summary = string(input.summary).trim().slice(0, 500);
        if (!summary) throw new Error("Finding summary is required.");
        const severityValue = string(input.severity);
        const severity: FindingSeverity = ["info", "note", "warning", "critical"].includes(severityValue)
          ? severityValue as FindingSeverity
          : "note";
        const response = this.callbacks.postFinding({ summary, detail: string(input.detail).trim().slice(0, 20_000) || undefined, severity });
        return { content: response, isError: false };
      }
      throw new Error(`Tool ${name} is not available in the ${this.role} free-provider harness.`);
    } catch (error) {
      return { content: `Tool error: ${errorText(error)}`, isError: true };
    }
  }

  private errorResult(message: string, turns = 0): ResultEvent {
    this.emit({ type: "error", message });
    return {
      type: "result",
      subtype: "error_free_provider",
      isError: true,
      result: message,
      errors: [message],
      costUsd: 0,
      numTurns: turns,
    };
  }
}
