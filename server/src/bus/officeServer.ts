import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { OrchestratorApi } from "../orchestrator/api.js";
import type { ChatScope, Role } from "../types.js";
import { OFFICE_SERVER } from "../agents/toolNames.js";

export interface OfficeContext {
  threadId: string;
  role: Role;
  workspace: string;
  title: string;
  getRunId: () => string | undefined;
}

/** Map the agent-facing scope word to the internal ChatScope. "team" is the per-repo project room
 *  agents share when 2+ work the same workspace; "office" is the general room everyone is in. */
function toScope(word: "office" | "team"): ChatScope {
  return word === "team" ? "project" : "general";
}

/**
 * The office: a per-run MCP server that lets a working agent see its coworkers and chat with them —
 * everyone in the general "office", and teammates in the per-repository "team" room when 2+ agents
 * share a workspace. It's how concurrent tasks on the same repo coordinate instead of silently
 * editing the same files. Bound to one run (thread/role/workspace) because the SDK passes no caller
 * identity into a tool handler. (Codex implementors run as a separate process with no MCP, so they
 * don't get the office — a documented degradation, like the bus tools.)
 */
export function createOfficeServer(api: OrchestratorApi, ctx: OfficeContext): McpServerConfig {
  const officeLook = tool(
    "office_look",
    "Look around the office: list every other agent working right now — their role, their task, and which repo they're in — plus whether they share YOUR repo (your teammates). Call this when you start, and whenever you want to know who else is active, so you can coordinate instead of duplicating or colliding on work.",
    {},
    async () => {
      const roster = api.officeRoster(ctx.threadId);
      const others = roster.filter((r) => !r.self);
      if (!others.length) {
        return { content: [{ type: "text", text: "You're the only agent working right now — the office is quiet. No one else to coordinate with." }] };
      }
      const team = others.filter((r) => r.sameRepo);
      const lines = others.map(
        (r) => `- ${r.role} on "${r.title}" — ${r.workspace}${r.sameRepo ? "  ⟵ SAME REPO as you (teammate)" : ""}`,
      );
      const header = team.length
        ? `⚠️ ${team.length} other agent(s) are in YOUR repo right now — coordinate with them via chat_post(scope:"team") before editing shared files.`
        : "No one else is in your repo, but here's who's around:";
      return { content: [{ type: "text", text: `${header}\n${lines.join("\n")}` }] };
    },
  );

  const chatPost = tool(
    "chat_post",
    'Say something to your coworkers. scope "office" posts to the whole office (every active agent); scope "team" posts to your project room — the agents working in THIS SAME repo. Use "team" to divide up files/areas, announce what you\'re about to change, and share findings so two tasks don\'t edit the same code. Read first (chat_read / office_look) and address anything relevant in your message.',
    {
      scope: z.enum(["office", "team"]).default("team").describe('"office" = everyone; "team" = agents in your repo.'),
      message: z.string().min(1).describe("What to tell your coworkers."),
    },
    async (args) => {
      const m = api.chatPost({
        threadId: ctx.threadId,
        runId: ctx.getRunId() ?? null,
        role: ctx.role,
        scope: toScope(args.scope),
        body: args.message,
      });
      const where = m.scope === "project" ? "your team" : "the office";
      return { content: [{ type: "text", text: `Posted to ${where}.` }] };
    },
  );

  const chatRead = tool(
    "chat_read",
    "Read recent office chat. scope \"team\" = your repo's room, \"office\" = the general room, \"all\" = both (default). Check this before you start work and before posting, so you don't miss what a teammate already said.",
    {
      scope: z.enum(["office", "team", "all"]).default("all"),
      limit: z.number().int().min(1).max(100).default(40),
    },
    async (args) => {
      const scope = args.scope === "all" ? ("all" as const) : toScope(args.scope);
      const msgs = api.chatRead({ threadId: ctx.threadId, scope, limit: args.limit });
      if (!msgs.length) return { content: [{ type: "text", text: "No messages yet." }] };
      const text = msgs
        .map((m) => {
          const who = m.kind === "system" ? "office" : m.role;
          const tag = m.scope === "project" ? "team" : "office";
          return `[${tag}] ${who}: ${m.body}`;
        })
        .join("\n");
      return { content: [{ type: "text", text }] };
    },
  );

  return createSdkMcpServer({
    name: OFFICE_SERVER,
    version: "0.1.0",
    tools: [officeLook, chatPost, chatRead],
  });
}
