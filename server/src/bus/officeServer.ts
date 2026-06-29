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
    "Look around the office: see YOUR own office name, and list every other agent working right now — their name, role, task, and which repo they're in — plus whether they share YOUR repo (your teammates). Call this when you start, and whenever you want to know who else is active, so you can coordinate (and address people by name) instead of colliding on work.",
    {},
    async () => {
      const roster = api.officeRoster(ctx.threadId);
      const me = api.officeName(ctx.threadId);
      const others = roster.filter((r) => !r.self);
      const youAre = `You're "${me}" in the office (rename with office_set_name if you like).`;
      if (!others.length) {
        return { content: [{ type: "text", text: `${youAre}\nYou're the only agent working right now — the office is quiet. No one else to coordinate with.` }] };
      }
      const team = others.filter((r) => r.sameRepo);
      const lines = others.map(
        (r) => `- ${r.name} (${r.role}) on "${r.title}" — ${r.workspace}${r.sameRepo ? "  ⟵ SAME REPO as you (teammate)" : ""}`,
      );
      const header = team.length
        ? `⚠️ ${team.length} other agent(s) are in YOUR repo right now — coordinate with them by name via chat_post(scope:"team") before editing shared files.`
        : "No one else is in your repo, but here's who's around:";
      return { content: [{ type: "text", text: `${youAre}\n${header}\n${lines.join("\n")}` }] };
    },
  );

  const setName = tool(
    "office_set_name",
    "Pick the name you go by in the office (how coworkers will address you, and what shows on your gnome). Optional — you get a default name otherwise. Choose something short and human.",
    { name: z.string().min(1).max(24).describe("Your chosen office name, e.g. 'Nova'.") },
    async (args) => {
      const saved = api.setOfficeName(ctx.threadId, args.name);
      return { content: [{ type: "text", text: `You're now "${saved}" in the office.` }] };
    },
  );

  const chatPost = tool(
    "chat_post",
    'Say something to your coworkers — keep it SHORT, one or two sentences like a real chat message (the office is for quick coordination, NOT long writeups; put detail in your task work, not here). scope "office" posts to the whole office (every active agent); scope "team" posts to your project room — the agents in THIS SAME repo. Use "team" to divide up files/areas, flag what you\'re about to change, and answer teammates. Read first (chat_read / office_look) and address people by name.',
    {
      scope: z.enum(["office", "team"]).default("team").describe('"office" = everyone; "team" = agents in your repo.'),
      message: z.string().min(1).max(500).describe("A short line for your coworkers — one or two sentences, not a report."),
    },
    async (args) => {
      const m = api.chatPost({
        threadId: ctx.threadId,
        runId: ctx.getRunId() ?? null,
        role: ctx.role,
        scope: toScope(args.scope),
        body: args.message,
      });
      if (m.scope === "general") {
        return { content: [{ type: "text", text: "Posted to the office (general room)." }] };
      }
      // Tell the poster whether a teammate is actually around — a team post lands live in any
      // implementor sharing this repo, so they'll see it without polling; if none are here it waits.
      const peers = api.officeRoster(ctx.threadId).filter((r) => r.sameRepo).length;
      const text = peers
        ? `Posted to your team room — ${peers} agent(s) are in this repo right now and will see it (it's delivered into the live implementor's session).`
        : "Posted to your team room — no other agent is in this repo right now, so it'll be waiting for whoever joins next (they read the room on arrival).";
      return { content: [{ type: "text", text }] };
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
          const who = m.kind === "system" ? "office" : `${m.senderName || m.role} (${m.role})`;
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
    tools: [officeLook, setName, chatPost, chatRead],
  });
}
