import { EventEmitter } from "node:events";
import { readdir, realpath, readFile, stat } from "node:fs/promises";
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
  NormalizedToolCall,
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
const SEARCH_SKIPPED_DIRS = new Set([".git", "node_modules", "dist", "build"]);
const SEARCH_FILE_LIMIT = 20_000;
const SEARCH_TIME_BUDGET_MS = 12_000;
// A model-authored pattern is compiled into a JS RegExp, which backtracks where ripgrep's
// linear-time engine did not. Matching is synchronous on the server's only thread, so cap the
// line length fed to it: a pathological pattern then costs a bounded slice rather than a stall.
const SEARCH_LINE_CHAR_LIMIT = 2_000;
const BUDGET_SPENT_TOOL_RESULT = "The read context budget for this turn is exhausted, so this tool was not run. Return your final structured result now.";

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
  description: "Search text inside the task workspace by regular expression. Returns workspace-relative paths, line numbers, and matching lines; never runs a shell.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["pattern"],
    properties: {
      pattern: { type: "string", description: "JavaScript regular-expression search pattern." },
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

/**
 * Some OpenAI-compatible model backends canonicalize a function name to lowercase in their response
 * even though they were given a mixed-case declaration (Groq's tool-capable free models do this in
 * practice for `Glob`). Replay must use the declaration name: providers validate every historical
 * assistant tool call against the tools in the next request. Only map a case-insensitive match from
 * the currently offered, capability-bounded list; an unknown name remains unknown and is rejected by
 * the normal read-only executor.
 */
function canonicalToolCalls(calls: readonly NormalizedToolCall[], tools: readonly ProviderTool[]): NormalizedToolCall[] {
  const canonical = new Map(tools.map((tool) => [tool.name.toLowerCase(), tool.name]));
  return calls.map((call) => {
    const name = canonical.get(call.name.toLowerCase());
    return name && name !== call.name ? { ...call, name } : call;
  });
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

/**
 * The gitignore-style glob semantics the harness offers, reduced to what a model actually sends:
 * `*` and `?` stay inside one path segment, `**` spans segments, and `{a,b}` alternates.
 */
function globToRegExp(pattern: string): RegExp {
  let source = "";
  let braces = 0;
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]!;
    if (char === "*") {
      if (pattern[index + 1] !== "*") {
        source += "[^/]*";
        continue;
      }
      index++;
      if (pattern[index + 1] === "/") {
        index++;
        source += "(?:[^/]+/)*";
      } else {
        source += ".*";
      }
      continue;
    }
    if (char === "?") source += "[^/]";
    else if (char === "{") { braces++; source += "(?:"; }
    else if (char === "}" && braces > 0) { braces--; source += ")"; }
    else if (char === "," && braces > 0) source += "|";
    else source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  if (braces > 0) throw new Error("Glob has an unclosed { group.");
  return new RegExp(`^${source}$`);
}

/**
 * A glob with no separator matches the basename at any depth, so `*.ts` finds a nested file the way
 * ripgrep did and the way the model expects; anything with a separator matches the relative path.
 */
function globMatcher(pattern: string): (relativePath: string) => boolean {
  const matches = globToRegExp(pattern);
  if (pattern.includes("/")) return (relativePath) => matches.test(relativePath);
  return (relativePath) => matches.test(relativePath.slice(relativePath.lastIndexOf("/") + 1));
}

interface SearchBudget {
  deadline: number;
  filesLeft: number;
}

function searchBudget(): SearchBudget {
  return { deadline: Date.now() + SEARCH_TIME_BUDGET_MS, filesLeft: SEARCH_FILE_LIMIT };
}

function budgetSpent(budget: SearchBudget): boolean {
  return budget.filesLeft <= 0 || Date.now() > budget.deadline;
}

function includeFilter(glob: string): (relativePath: string) => boolean {
  if (!glob) return () => true;
  try {
    return globMatcher(glob);
  } catch (error) {
    throw new Error(`Glob is not valid: ${errorText(error)}`);
  }
}

function compileSearchPattern(pattern: string, caseSensitive: boolean): RegExp {
  try {
    return new RegExp(pattern, caseSensitive ? "" : "i");
  } catch (error) {
    throw new Error(`Search pattern is not a valid regular expression: ${errorText(error)}`);
  }
}

/**
 * Walks `target` for accepted workspace-relative file paths. Symlinks are never traversed: ripgrep
 * was not asked to follow them either, and skipping them holds the workspace-confinement guarantee
 * without a realpath call per entry.
 */
async function collectFiles(
  root: string,
  target: string,
  budget: SearchBudget,
  accept: (relativePath: string) => boolean,
): Promise<string[]> {
  const relativeTo = (absolute: string): string => relative(root, absolute).split(sep).join("/");
  if ((await stat(target)).isFile()) {
    const only = relativeTo(target);
    return accept(only) ? [only] : [];
  }
  const found: string[] = [];
  const pending = [target];
  while (pending.length && !budgetSpent(budget)) {
    const directory = pending.pop()!;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (budgetSpent(budget)) break;
      if (entry.isSymbolicLink()) continue;
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SEARCH_SKIPPED_DIRS.has(entry.name)) pending.push(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      budget.filesLeft--;
      const relativePath = relativeTo(absolute);
      if (accept(relativePath)) found.push(relativePath);
    }
  }
  return found.sort();
}

function searchResult(lines: readonly string[], clipped: boolean): string {
  if (!lines.length) return clipped ? "(no matches before the search limit)" : "(no matches)";
  return truncate(lines.join("\n") + (clipped ? "\n\n[search stopped at the output/time limit]" : ""));
}

async function grepFile(root: string, relativePath: string, matches: RegExp): Promise<string[]> {
  const absolute = resolve(root, relativePath);
  let content: Buffer;
  try {
    if ((await stat(absolute)).size > MAX_READ_BYTES) return [];
    content = await readFile(absolute);
  } catch {
    return [];
  }
  if (content.includes(0)) return [];
  const hits: string[] = [];
  const lines = content.toString("utf8").replace(/\r\n/g, "\n").split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.slice(0, SEARCH_LINE_CHAR_LIMIT);
    if (matches.test(line)) hits.push(`${relativePath}:${index + 1}:${line.trim()}`);
  }
  return hits;
}

async function grepTool(root: string, input: Record<string, unknown>): Promise<string> {
  const pattern = string(input.pattern);
  if (!pattern || pattern.length > 1_000 || /[\0\r\n]/.test(pattern)) throw new Error("Search pattern is empty or too long.");
  const matches = compileSearchPattern(pattern, input.case_sensitive === true);
  const accept = includeFilter(string(input.glob));
  const target = await confinedPath(root, string(input.path) || ".");
  const budget = searchBudget();
  const files = await collectFiles(root, target, budget, accept);
  const hits: string[] = [];
  let used = 0;
  let clipped = budgetSpent(budget);
  for (const file of files) {
    if (used >= MAX_TOOL_RESULT_CHARS || budgetSpent(budget)) {
      clipped = true;
      break;
    }
    for (const hit of await grepFile(root, file, matches)) {
      hits.push(hit);
      used += hit.length + 1;
      if (used >= MAX_TOOL_RESULT_CHARS) {
        clipped = true;
        break;
      }
    }
  }
  return searchResult(hits, clipped);
}

async function globTool(root: string, input: Record<string, unknown>): Promise<string> {
  const pattern = string(input.pattern);
  if (!pattern || pattern.length > 500 || /[\0\r\n]/.test(pattern)) throw new Error("Glob is empty or too long.");
  const accept = includeFilter(pattern);
  const target = await confinedPath(root, string(input.path) || ".");
  const budget = searchBudget();
  const files = await collectFiles(root, target, budget, accept);
  const listed: string[] = [];
  let used = 0;
  let clipped = budgetSpent(budget);
  for (const file of files) {
    if (used >= MAX_TOOL_RESULT_CHARS) {
      clipped = true;
      break;
    }
    listed.push(file);
    used += file.length + 1;
  }
  return searchResult(listed, clipped);
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
        const tools = this.tools();
        const completion = await this.session.complete({
          messages: this.messages,
          tools,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
        });
        const canonicalCalls = canonicalToolCalls(completion.toolCalls, tools);
        if (canonicalCalls.length) {
          if (toolCalls + canonicalCalls.length > MAX_TOOL_CALLS_PER_TURN) {
            throw new Error(`The model exceeded the ${MAX_TOOL_CALLS_PER_TURN}-tool safety limit.`);
          }
          this.messages.push({ role: "assistant", content: completion.text, toolCalls: canonicalCalls });
          if (completion.text.trim()) this.emit({ type: "thinking", text: completion.text.trim() });
          // EVERY tool call in this assistant turn must get a result message, even once the read
          // budget is spent: an OpenAI-compatible endpoint rejects an assistant turn whose
          // `tool_calls` are not all answered, and Gemini requires one `functionResponse` per
          // `functionCall`. Abandoning the tail of a parallel batch therefore poisons the next
          // request instead of ending the turn, so a spent budget refuses the remaining calls
          // rather than dropping them.
          let budgetSpent = false;
          for (const call of canonicalCalls) {
            toolCalls++;
            const parsed = this.parseArguments(call.arguments);
            this.emit({ type: "tool_use", id: call.id, name: call.name, input: parsed });
            const result = budgetSpent
              ? { content: BUDGET_SPENT_TOOL_RESULT, isError: true }
              : await this.executeTool(root, call.name, parsed);
            const remaining = Math.max(0, MAX_TOOL_CONTEXT_CHARS - toolContextChars);
            const bounded = budgetSpent ? result.content : truncate(result.content, Math.min(MAX_TOOL_RESULT_CHARS, remaining));
            toolContextChars += bounded.length;
            this.emit({ type: "tool_result", id: call.id, content: bounded, isError: result.isError });
            this.messages.push({ role: "tool", content: bounded, toolCallId: call.id, toolName: call.name });
            if (toolContextChars >= MAX_TOOL_CONTEXT_CHARS) budgetSpent = true;
          }
          if (budgetSpent) {
            this.messages.push({ role: "user", content: "The read context budget is full. Stop calling tools and return your final structured result now." });
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
