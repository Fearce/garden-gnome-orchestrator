import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { MemoryService } from "../memory/memory.js";
import { MEMORY_TYPES } from "../memory/corpus.js";
import { MEMORY_SERVER } from "../agents/toolNames.js";
import { config } from "../config.js";

type Text = { content: Array<{ type: "text"; text: string }> };
const text = (value: string): Text => ({ content: [{ type: "text", text: value }] });

/**
 * The owner's memory for the director (search, read and write) and the researcher (search and read).
 * Search ranks the owner's memory files by relevance (lexical candidates judged by Haiku or Luna);
 * writes go to the same Markdown files Claude Code's own memory commands use.
 */
export function createMemoryServer(memory: MemoryService, opts: { write?: boolean } = {}): McpServerConfig {
  const owner = config.ownerName;
  const searchMemory = tool(
    "search_memory",
    `Search ${owner}'s global memory (their stack, preferences, prior decisions, lessons learned, project state) for context relevant to a query. Returns the most relevant memories with their one-line descriptions and file names. Read a returned memory for full detail. ALWAYS check this before dispatching work — it surfaces context ${owner} assumes you already know.`,
    {
      query: z.string().describe("What to look for, e.g. 'background service supervision rules' or 'design taste preferences'."),
      k: z.number().int().min(1).max(15).default(6).describe("How many results to return."),
    },
    async (args) => {
      const hits = await memory.search(args.query, args.k);
      if (!hits.length) return text(`No memory matched "${args.query}".`);
      return text(hits.map((h) => `- ${h.name} (${h.file})\n  ${h.description || "(no description)"}`).join("\n"));
    },
  );

  const readMemory = tool(
    "read_memory",
    `Read the full content of ONE of ${owner}'s memory files, by the name or file name returned from search_memory. Use this when a hit looks load-bearing and its one-line description isn't enough to fold the full lesson/decision into a brief. This reads ONLY ${owner}'s memory — it is not a way to read the codebase (you dispatch a thread for that).`,
    {
      name: z.string().describe("The memory's name or file name exactly as returned by search_memory."),
    },
    async (args) => {
      const body = await memory.read(args.name);
      return text(body ?? `No memory found for "${args.name}". Use search_memory to get a valid name or file.`);
    },
  );

  const rememberMemory = tool(
    "remember_memory",
    `Save a durable memory for ${owner}: a stated preference or rule, a stable fact about their stack or collaborators, or a reference they want kept. Only when ${owner} asks you to remember something or states a lasting rule — never for one-off task details. Search first and update the existing memory instead when one already covers it.`,
    {
      type: z.enum(MEMORY_TYPES).describe("user = who they are; feedback = how they want work done (include Why/How to apply lines); project = ongoing work or constraints; reference = an external resource."),
      name: z.string().min(3).max(80).describe("Short title in sentence case."),
      description: z.string().min(10).max(200).describe("One line used to judge relevance at recall time."),
      body: z.string().min(10).max(8000).describe("The memory itself, in Markdown."),
    },
    async (args) => {
      const file = await memory.create({ type: args.type, name: args.name, description: args.description, body: args.body });
      return text(`Saved as ${file}.`);
    },
  );
  const updateMemory = tool(
    "update_memory",
    `Correct or extend one of ${owner}'s existing memories (by file name from search_memory). Fields you omit stay as they are; last_verified is stamped with today's date.`,
    {
      file: z.string().describe("The memory's file name, e.g. feedback_example.md."),
      name: z.string().min(3).max(80).optional(),
      description: z.string().min(10).max(200).optional(),
      body: z.string().min(10).max(8000).optional().describe("Replaces the whole body."),
    },
    async (args) => {
      const ok = await memory.update(args.file, { name: args.name, description: args.description, body: args.body });
      return text(ok ? `Updated ${args.file}.` : `No memory file "${args.file}". Use search_memory to get a valid file name.`);
    },
  );
  const forgetMemory = tool(
    "forget_memory",
    `Delete one of ${owner}'s memories that is wrong or obsolete — only when ${owner} asks, or when it is clearly superseded. The file moves to the memory directory's .ggo-trash folder, so it can be restored.`,
    {
      file: z.string().describe("The memory's file name."),
    },
    async (args) => {
      const moved = await memory.remove(args.file);
      return text(moved ? `Moved ${args.file} to the memory trash.` : `No memory file "${args.file}".`);
    },
  );
  return createSdkMcpServer({
    name: MEMORY_SERVER,
    version: "0.2.0",
    tools: opts.write ? [searchMemory, readMemory, rememberMemory, updateMemory, forgetMemory] : [searchMemory, readMemory],
  });
}
