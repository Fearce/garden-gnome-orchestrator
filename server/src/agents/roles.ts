import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { config } from "../config.js";
import type { AgentRunConfig } from "./runner.js";
import { BUS_SERVER, BUS_TOOLS, DIRECTOR_SERVER, DIRECTOR_TOOLS, MEMORY_SERVER, T } from "./toolNames.js";
import { DIRECTOR_PROMPT, IMPLEMENTOR_APPEND, PLANNER_PROMPT, RESEARCHER_PROMPT } from "./prompts.js";

export const PLAN_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "steps", "risks", "openQuestions"],
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
  },
};

export const RESEARCH_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "relevantFiles", "facts", "memories", "warnings"],
  properties: {
    summary: { type: "string" },
    relevantFiles: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "why"],
        properties: { path: { type: "string" }, why: { type: "string" } },
      },
    },
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

export function directorConfig(servers: { director: McpServerConfig; memory: McpServerConfig }): AgentRunConfig {
  return {
    model: config.models.director,
    cwd: config.defaultWorkspace,
    systemPrompt: DIRECTOR_PROMPT,
    permissionMode: "bypassPermissions",
    allowedTools: [...DIRECTOR_TOOLS, "Read", "Grep", "Glob"],
    disallowedTools: ["Write", "Edit", "NotebookEdit", "Bash"],
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
    allowedTools: ["Read", "Grep", "Glob", "WebSearch", "WebFetch", T.searchMemory, ...BUS_TOOLS],
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
  opts?: { resume?: string },
): AgentRunConfig {
  const cfg: AgentRunConfig = {
    model: config.models.implementor,
    cwd,
    systemPrompt: { type: "preset", preset: "claude_code", append: IMPLEMENTOR_APPEND },
    // Fully autonomous: bypassPermissions auto-approves every tool (Read/Write/
    // Edit/Bash/…) so dispatched implementors run unsupervised. The bus tools are
    // available via mcpServers; no allowedTools list is needed under bypass.
    permissionMode: "bypassPermissions",
    mcpServers: { [BUS_SERVER]: servers.bus },
    settingSources: ["user", "project", "local"],
    effort: "high",
    includePartialMessages: true,
  };
  if (opts?.resume) cfg.resume = opts.resume;
  return cfg;
}
