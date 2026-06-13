import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { MemoryService } from "../memory/memory.js";
import { MEMORY_SERVER } from "../agents/toolNames.js";

/**
 * Exposes the user's global memory to the director and researcher: a lexical
 * search over ~/.claude/memory returning the most relevant memory files. Agents
 * can then Read a file by path for the full content.
 */
export function createMemoryServer(memory: MemoryService): McpServerConfig {
  const searchMemory = tool(
    "search_memory",
    "Search the user's global memory (his stack, preferences, prior decisions, lessons learned, project state) for context relevant to a query. Returns the most relevant memory files with their one-line descriptions and paths. Read a returned path for full detail. ALWAYS check this before dispatching work — it surfaces context the user assumes you already know.",
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

  return createSdkMcpServer({ name: MEMORY_SERVER, version: "0.1.0", tools: [searchMemory] });
}
