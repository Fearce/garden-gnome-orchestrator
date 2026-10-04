import { readFile, writeFile } from "node:fs/promises";
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
  enqueueExtraction(item: { source: string; sessionId: string | null; text: string }): Promise<"queued" | "too-short" | "unavailable">;
}

const SESSION_LIMIT = 4;
const PROMPT_LIMIT = 2;
const RECALL_TIMEOUT_MS = 9_000;
const HOOK_TIMEOUT_S = 15;
const MIN_PROMPT_CHARS = 8;
const OFFSETS_FILE = "memory-extraction-offsets.json";

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
export function memoryAgentHooks(memory: AgentMemory, dir: string, offsets = new ExtractionOffsets()): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
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
    PreCompact: one((input) => queueTranscript(memory, input, offsets)),
    SessionEnd: one((input) => queueTranscript(memory, input, offsets)),
  };
}

async function queueTranscript(memory: AgentMemory, input: HookInput, offsets: ExtractionOffsets): Promise<Record<string, never>> {
  try {
    const path = input.transcript_path;
    if (!path) return {};
    const lines = (await readFile(path, "utf8")).split(/\r?\n/);
    const from = await offsets.get(path);
    if (from >= lines.length) return {};
    const text = userText(lines.slice(from));
    const outcome = await memory.enqueueExtraction({ source: "ggo-agent", sessionId: input.session_id ?? null, text });
    if (outcome !== "unavailable") await offsets.set(path, lines.length);
  } catch {
    // A transcript that cannot be read now is retried from the same offset at the next compaction.
  }
  return {};
}

/** The user-role text of transcript JSONL lines: what the agent was told, not what it did. */
export function userText(lines: string[]): string {
  const chunks: string[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: { type?: string; role?: string; message?: { role?: string; content?: unknown } };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
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

/** How far into each transcript extraction has already read, kept across restarts. */
export class ExtractionOffsets {
  private cache: Record<string, number> | null = null;

  constructor(private readonly file = join(config.dataDir, OFFSETS_FILE)) {}

  async get(transcript: string): Promise<number> {
    return (await this.load())[transcript] ?? 0;
  }

  async set(transcript: string, line: number): Promise<void> {
    const all = await this.load();
    all[transcript] = line;
    const entries = Object.entries(all);
    // Bounded: only the most recently touched transcripts matter.
    if (entries.length > 500) this.cache = Object.fromEntries(entries.slice(-400));
    await writeFile(this.file, JSON.stringify(this.cache), "utf8");
  }

  private async load(): Promise<Record<string, number>> {
    if (this.cache) return this.cache;
    try {
      this.cache = JSON.parse(await readFile(this.file, "utf8")) as Record<string, number>;
    } catch {
      this.cache = {};
    }
    return this.cache;
  }
}
