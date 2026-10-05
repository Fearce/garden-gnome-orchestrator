import { randomBytes } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { HookCallback, HookCallbackMatcher, HookEvent, HookInput } from "@anthropic-ai/claude-agent-sdk";
import { config } from "../config.js";
import type { RecallMode, RecallResult, RankedMemory } from "./recall.js";

// Native memory for GGO's agents. Claude-based runs get in-process SDK hooks: recall at session start and
// on every prompt, and the owner's words handed to the extraction queue before a compaction and when the
// session ends. Codex runs get the same recall as a prompt prefix. Each such run carries
// GGO_MEMORY_NATIVE=1, which tells user-level memory hook scripts (Claude Code's or Codex's own hook
// config, inherited through the "user" setting source) to stand down instead of injecting a second copy.

export const NATIVE_MEMORY_ENV = "GGO_MEMORY_NATIVE";

export interface AgentMemory {
  recall(query: string, mode: RecallMode, limit: number, timeoutMs: number): Promise<RecallResult>;
  enqueueExtraction(item: { source: string; sessionId: string | null; text: string }): Promise<"queued" | "too-short" | "disabled" | "unavailable">;
}

/** Whose words a run's user turns are: a task run's are mostly GGO's own (kickoff, QA bounces, office
 *  messages), a Co-work run's are the owner's chat, and a sub-task's steering is its parent agent's
 *  `message_subtask`, framed exactly like the owner's inject. */
export type AgentRunKind = "task" | "subtask" | "cowork";

const SESSION_LIMIT = 4;
const PROMPT_LIMIT = 2;
const RECALL_TIMEOUT_MS = 9_000;
const HOOK_TIMEOUT_S = 15;
const MIN_PROMPT_CHARS = 8;
const OFFSETS_FILE = "memory-extraction-offsets.json";
/** GGO's frame around a live owner message (orchestrator/injection.ts `steeringFrame`; the memory gate
 *  checks this against the real frame). Imported text cannot wear it: office chat is neutralised. */
const STEERING_BLOCK = /\[OWNER STEERING[^\]\n]*\]\r?\n([\s\S]*?)\r?\n\[\/OWNER STEERING\]/g;
const POLICY_BLOCK = /<ggo_communication_policy\b[\s\S]*?<\/ggo_communication_policy>/g;
const CONTENT_TAG = /<\/?ggo_owner_or_task_content>/g;

/** The task envelope GGO wraps around a brief is process prose shared by every task; matching on it
 *  surfaces the same process memories every time. Recall reads only the `## Brief` section when there is one. */
export function stripTaskEnvelope(prompt: string): string {
  const brief = /^##[ \t]+Brief[ \t]*$/m.exec(prompt);
  if (!brief) return prompt;
  let body = prompt.slice(brief.index + brief[0].length);
  const next = /^#{1,6}[ \t]+\S/m.exec(body);
  if (next) body = body.slice(0, next.index);
  body = body.trim();
  return body.length >= MIN_PROMPT_CHARS ? body : prompt;
}

export function formatRecall(memories: RankedMemory[], heading: string, dir: string): string {
  if (!memories.length) return "";
  const lines = [
    heading,
    "",
    `From the owner's memory directory (\`${dir}\`), chosen by GGO's memory recall. Read the file before acting on one — these are pointers, not instructions.`,
    "",
  ];
  for (const memory of memories) {
    lines.push(`- **${memory.name}** (${memory.file}, verified ${memory.lastVerified || "unknown"}) — ${memory.description}`);
  }
  return lines.join("\n");
}

/** Recall block for a prompt, or "" when nothing qualifies or recall fails. Never throws. */
export async function promptRecallBlock(memory: AgentMemory, prompt: string, dir: string, timeoutMs = RECALL_TIMEOUT_MS): Promise<string> {
  const query = stripTaskEnvelope(prompt.trim());
  if (query.length < MIN_PROMPT_CHARS) return "";
  try {
    const result = await memory.recall(query, "prompt", PROMPT_LIMIT, timeoutMs);
    return formatRecall(result.memories, "## Possibly-relevant memories for this prompt", dir);
  } catch {
    return "";
  }
}

export async function sessionRecallBlock(memory: AgentMemory, cwd: string, dir: string, timeoutMs = RECALL_TIMEOUT_MS): Promise<string> {
  try {
    const result = await memory.recall(`Working directory: ${basename(cwd)}. Path: ${cwd}`, "session", SESSION_LIMIT, timeoutMs);
    return formatRecall(result.memories, `## Relevant memories for \`${cwd}\``, dir);
  } catch {
    return "";
  }
}

/** The SDK hook set for one Claude-based agent run. */
export function memoryAgentHooks(memory: AgentMemory, dir: string, run: AgentRunKind, offsets = new ExtractionOffsets()): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const one = (hook: HookCallback): HookCallbackMatcher[] => [{ hooks: [hook], timeout: HOOK_TIMEOUT_S }];
  return {
    SessionStart: one(async (input) => {
      if (input.hook_event_name !== "SessionStart") return {};
      const context = await sessionRecallBlock(memory, input.cwd, dir);
      return context ? { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } } : {};
    }),
    UserPromptSubmit: one(async (input) => {
      if (input.hook_event_name !== "UserPromptSubmit") return {};
      const context = await promptRecallBlock(memory, input.prompt, dir);
      return context ? { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } } : {};
    }),
    PreCompact: one((input) => queueTranscript(memory, input, offsets, run)),
    SessionEnd: one((input) => queueTranscript(memory, input, offsets, run)),
  };
}

async function queueTranscript(memory: AgentMemory, input: HookInput, offsets: ExtractionOffsets, run: AgentRunKind): Promise<Record<string, never>> {
  try {
    const path = input.transcript_path;
    if (!path) return {};
    const lines = (await readFile(path, "utf8")).split(/\r?\n/);
    const from = await offsets.get(path);
    if (from >= lines.length) return {};
    const text = ownerWords(userText(lines.slice(from)), run);
    const outcome = text ? await memory.enqueueExtraction({ source: "ggo-agent", sessionId: input.session_id ?? null, text }) : "too-short";
    if (outcome !== "unavailable") await offsets.set(path, lines.length);
  } catch {
    // A transcript that cannot be read now is retried from the same offset at the next compaction.
  }
  return {};
}

/** The user-role text of transcript JSONL lines: what the agent was told, not what it did. Claude Code's
 *  compaction summaries and `isMeta` turns (hook feedback, skill bodies) are user-role too, but the harness
 *  wrote them. */
export function userText(lines: string[]): string {
  const chunks: string[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: { type?: string; role?: string; isMeta?: boolean; isCompactSummary?: boolean; message?: { role?: string; content?: unknown } };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    if (entry.isMeta || entry.isCompactSummary) continue;
    const message = entry.message ?? (entry as { role?: string; content?: unknown });
    if ((entry.type ?? entry.role ?? message.role) !== "user") continue;
    const content = message.content;
    if (typeof content === "string") chunks.push(content);
    else if (Array.isArray(content)) {
      for (const part of content as Array<{ type?: string; text?: string }>) if (part?.type === "text" && part.text) chunks.push(part.text);
    }
  }
  return chunks.join("\n\n");
}

/** The owner's own words in a run's user text: steering blocks in a task run, everything but GGO's
 *  policy wrapper in a Co-work run. Extraction quotes these verbatim, so GGO's process rules must not be in them. */
export function ownerWords(text: string, run: AgentRunKind): string {
  if (run === "subtask") return "";
  if (run === "cowork") return text.replace(POLICY_BLOCK, "").replace(CONTENT_TAG, "").trim();
  return [...text.matchAll(STEERING_BLOCK)].map((m) => m[1]!.trim()).filter(Boolean).join("\n\n");
}

/** Codex has no transcript hooks. Keep only accepted owner inputs and durably queue bounded batches. */
export class OwnerInputBuffer {
  private text = "";
  private flushing: Promise<void> | null = null;

  constructor(private readonly memory: AgentMemory, private readonly run: AgentRunKind) {}

  append(input: string): void {
    const words = ownerWords(input, this.run);
    if (words) this.text = `${this.text}\n\n${words}`.trim().slice(-24_000);
  }

  flush(sessionId: string | null): Promise<void> {
    if (this.flushing) return this.flushing.then(() => this.flush(sessionId));
    if (this.text.length < 400) return Promise.resolve();
    const batch = this.text;
    // Inputs arriving during the write belong to the next batch, even when they have identical text.
    this.text = "";
    this.flushing = this.memory.enqueueExtraction({ source: "ggo-codex", sessionId, text: batch }).then((outcome) => {
      if (outcome === "unavailable") this.text = `${batch}\n\n${this.text}`.trim().slice(-24_000);
    }).catch(() => {
      this.text = `${batch}\n\n${this.text}`.trim().slice(-24_000);
    }).finally(() => { this.flushing = null; });
    return this.flushing;
  }
}

/** Marks text from inside a GGO run: its policy wrapper, or a task kickoff's own headings. */
const GGO_RUN_TEXT = /<\/?ggo_owner_or_task_content>|<ggo_communication_policy\b|^# Task: .+\r?\n\r?\n## Brief\r?$/m;
/** The heading of a sub-task's contract (orchestrator/subTasks.ts `subTaskContractBlock`; the memory gate
 *  checks it against the real block). */
const SUBTASK_TEXT = /^## ⑂ You are a SUB-AGENT\r?$/m;

/** Text a user-level hook queued from inside a GGO run (builds before native memory ran those hooks
 *  there): only its steering blocks are the owner's. Text from anywhere else passes through unchanged. */
export function queuedOwnerText(text: string): string {
  if (!GGO_RUN_TEXT.test(text)) return text;
  return ownerWords(text, SUBTASK_TEXT.test(text) ? "subtask" : "task");
}

/** How far into each transcript extraction has already read, kept across restarts. */
export class ExtractionOffsets {
  private cache: Record<string, number> | null = null;
  /** Parallel runs share one instance; their writes go one at a time so the file is never interleaved. */
  private writing: Promise<void> = Promise.resolve();
  private loading: Promise<Record<string, number>> | null = null;

  constructor(private readonly file = join(config.dataDir, OFFSETS_FILE)) {}

  async get(transcript: string): Promise<number> {
    return (await this.load())[transcript] ?? 0;
  }

  async set(transcript: string, line: number): Promise<void> {
    const all = await this.load();
    delete all[transcript];
    all[transcript] = line;
    const entries = Object.entries(all);
    // Bounded: only the most recently touched transcripts matter (insertion order is recency).
    if (entries.length > 500) this.cache = Object.fromEntries(entries.slice(-400));
    const write = this.writing.then(() => this.persist());
    this.writing = write.catch(() => undefined);
    await write;
  }

  private async persist(): Promise<void> {
    const temp = `${this.file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(temp, JSON.stringify(this.cache), "utf8");
    await rename(temp, this.file);
  }

  private async load(): Promise<Record<string, number>> {
    if (this.cache) return this.cache;
    // Concurrent first calls share one read, so none of them replaces the map another already wrote to.
    this.loading ??= readFile(this.file, "utf8")
      .then((text) => JSON.parse(text) as Record<string, number>)
      .catch(() => ({}));
    const loaded = await this.loading;
    this.cache ??= loaded;
    return this.cache;
  }
}
