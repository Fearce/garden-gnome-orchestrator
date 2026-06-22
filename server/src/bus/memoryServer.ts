import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { MemoryService } from "../memory/memory.js";
import { MEMORY_SERVER } from "../agents/toolNames.js";
import { config } from "../config.js";

/**
 * Exposes the owner's global memory to the director and researcher: a lexical
 * search over ~/.claude/memory returning the most relevant memory files. Agents
 * can then Read a file by path for the full content.
 */
export function createMemoryServer(memory: MemoryService): McpServerConfig {
  const searchMemory = tool(
    "search_memory",
    `Search ${config.ownerName}'s global memory (their stack, preferences, prior decisions, lessons learned, project state) for context relevant to a query. Returns the most relevant memory files with their one-line descriptions and paths. Read a returned path for full detail. ALWAYS check this before dispatching work — it surfaces context ${config.ownerName} assumes you already know.`,
    {
      query: z.string().describe("What to look for, e.g. 'background service supervision rules' or 'design taste preferences'."),
      k: z.number().int().min(1).max(15).default(6).describe("How many results to return."),
    },
    async (args) => {
      const hits = await memory.search(args.query, args.k);
      if (!hits.length) {
        return { content: [{ type: "text", text: `No memory matched "${args.query}".` }] };
      }
      const text = hits
        .map((h) => `- ${h.name} (score ${h.score})\n  ${h.description || "(no description)"}\n  ${h.path}`)
        .join("\n");
      return { content: [{ type: "text", text }] };
    },
  );

  const readMemory = tool(
    "read_memory",
    `Read the full content of ONE of ${config.ownerName}'s memory files, by the \`name\` (or path) returned from search_memory. Use this when a hit looks load-bearing and its one-line description isn't enough to fold the full lesson/decision into a brief. This reads ONLY ${config.ownerName}'s memory — it is not a way to read the codebase (you dispatch a thread for that).`,
    {
      name: z.string().describe("The memory's name or path exactly as returned by search_memory."),
    },
    async (args) => {
      const body = memory.read(args.name);
      if (!body) {
        return { content: [{ type: "text", text: `No memory found for "${args.name}". Use search_memory to get a valid name/path.` }] };
      }
      return { content: [{ type: "text", text: body }] };
    },
  );

  return createSdkMcpServer({ name: MEMORY_SERVER, version: "0.1.0", tools: [searchMemory, readMemory] });
}
