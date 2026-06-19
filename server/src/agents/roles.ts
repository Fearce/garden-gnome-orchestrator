import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { config } from "../config.js";
import type { Effort } from "../types.js";
import type { AgentRunConfig } from "./runner.js";
import { BUS_SERVER, BUS_TOOLS, DIRECTOR_SERVER, DIRECTOR_TOOLS, MEMORY_SERVER, T } from "./toolNames.js";
import { DIRECTOR_PROMPT, IMPLEMENTOR_APPEND, PLANNER_PROMPT, QA_PROMPT, RESEARCHER_PROMPT } from "./prompts.js";

// Only `summary` is required. `nextAgent` is intentionally OPTIONAL: the code already defaults a
// missing route to the implementor (threadManager: anything but "researcher" ⇒ implementor), and
// the model occasionally omits an optional enum — marking it `required` turned that normal omission
// into a hard json_schema-validation failure that killed the whole plan. Everything else stays
// optional too so a planner that hits a blocker can emit valid output instead of fabricating
// steps/risks to satisfy the schema.
export const PLAN_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["summary"],
  properties: {
    summary: { type: "string" },
    steps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "detail"],
        properties: {
          title: { type: "string" },
          detail: { type: "string" },
          files: { type: "array", items: { type: "string" } },
        },
      },
    },
    risks: { type: "array", items: { type: "string" } },
    openQuestions: { type: "array", items: { type: "string" } },
    effort: { type: "string", enum: ["low", "medium", "high", "xhigh", "max"] },
    parallelism: { type: "string" },
    // The planner routes the pipeline: 'researcher' to gather external info first, else straight
    // to the implementor. Absent ⇒ implementor (don't burn a researcher unless asked for).
    nextAgent: { type: "string", enum: ["researcher", "implementor"] },
  },
};

export const RESEARCH_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["summary"],
  properties: {
    summary: { type: "string" },
    facts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["claim"],
        properties: { claim: { type: "string" }, source: { type: "string" } },
      },
    },
    memories: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "gist"],
        properties: { name: { type: "string" }, gist: { type: "string" } },
      },
    },
    warnings: { type: "array", items: { type: "string" } },
  },
};

export const QA_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["pass", "summary"],
  properties: {
    pass: { type: "boolean" },
    summary: { type: "string" },
    issues: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["description"],
        properties: {
          severity: { type: "string", enum: ["blocker", "major", "minor", "nit"] },
          description: { type: "string" },
          location: { type: "string" },
        },
      },
    },
  },
};

export function directorConfig(servers: { director: McpServerConfig; memory: McpServerConfig }): AgentRunConfig {
  return {
    model: config.models.director,
    cwd: config.defaultWorkspace,
    systemPrompt: DIRECTOR_PROMPT,
    permissionMode: "bypassPermissions",
    // The director ONLY directs: it has no filesystem/shell tools, so it cannot investigate
    // the codebase itself — any "figure out / debug / explain" is forced into a dispatch.
    // Memory recall goes through the scoped search_memory + read_memory MCP tools, not Read.
    allowedTools: [...DIRECTOR_TOOLS],
    disallowedTools: ["Read", "Grep", "Glob", "Write", "Edit", "NotebookEdit", "Bash", "AskUserQuestion"],
    mcpServers: { [DIRECTOR_SERVER]: servers.director, [MEMORY_SERVER]: servers.memory },
    settingSources: [],
    includePartialMessages: true,
  };
}

export function plannerConfig(cwd: string, servers: { bus: McpServerConfig }): AgentRunConfig {
  return {
    model: config.models.planner,
    cwd,
    systemPrompt: PLANNER_PROMPT,
    permissionMode: "plan",
    allowedTools: ["Read", "Grep", "Glob", ...BUS_TOOLS],
    disallowedTools: ["AskUserQuestion"],
    mcpServers: { [BUS_SERVER]: servers.bus },
    settingSources: ["project"],
    outputFormat: { type: "json_schema", schema: PLAN_SCHEMA },
    includePartialMessages: true,
    maxTurns: 40,
  };
}

export function researcherConfig(cwd: string, servers: { bus: McpServerConfig; memory: McpServerConfig }): AgentRunConfig {
  return {
    model: config.models.researcher,
    cwd,
    systemPrompt: RESEARCHER_PROMPT,
    permissionMode: "plan",
    // External-info-only: the researcher gathers web/docs/changelogs + Mikkel's memory, never the
    // codebase. Read/Grep/Glob are disallowed (the planner owns code reading) so it can't duplicate
    // that work even if tempted — its system prompt forbids it too.
    allowedTools: ["WebSearch", "WebFetch", T.searchMemory, ...BUS_TOOLS],
    disallowedTools: ["Read", "Grep", "Glob", "AskUserQuestion"],
    mcpServers: { [BUS_SERVER]: servers.bus, [MEMORY_SERVER]: servers.memory },
    settingSources: ["project"],
    outputFormat: { type: "json_schema", schema: RESEARCH_SCHEMA },
    includePartialMessages: true,
    maxTurns: 40,
  };
}

export function implementorConfig(
  cwd: string,
  servers: { bus: McpServerConfig },
  opts?: { resume?: string; effort?: Effort },
): AgentRunConfig {
  const cfg: AgentRunConfig = {
    model: config.models.implementor,
    cwd,
    systemPrompt: { type: "preset", preset: "claude_code", append: IMPLEMENTOR_APPEND },
    // Fully autonomous: bypassPermissions auto-approves every tool (Read/Write/
    // Edit/Bash/…) so dispatched implementors run unsupervised — but the broken
    // built-in question tool is disallowed so it uses the bus ask_user instead.
    permissionMode: "bypassPermissions",
    disallowedTools: ["AskUserQuestion"],
    mcpServers: { [BUS_SERVER]: servers.bus },
    settingSources: ["user", "project", "local"],
    effort: opts?.effort ?? "high",
    includePartialMessages: true,
  };
  if (opts?.resume) cfg.resume = opts.resume;
  return cfg;
}

export function qaConfig(cwd: string, servers: { bus: McpServerConfig }): AgentRunConfig {
  return {
    model: config.models.qa,
    cwd,
    systemPrompt: QA_PROMPT,
    // Needs Bash to run tests/build; cannot edit (it reviews, it doesn't implement).
    permissionMode: "bypassPermissions",
    disallowedTools: ["Write", "Edit", "NotebookEdit", "AskUserQuestion"],
    mcpServers: { [BUS_SERVER]: servers.bus },
    settingSources: ["project"],
    outputFormat: { type: "json_schema", schema: QA_SCHEMA },
    effort: "high",
    includePartialMessages: true,
    maxTurns: 60,
  };
}
