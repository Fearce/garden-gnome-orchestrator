import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { config } from "../config.js";
import type { Effort } from "../types.js";
import type { AgentRunConfig } from "./runner.js";
import { BUS_SERVER, BUS_TOOLS, DIRECTOR_SERVER, DIRECTOR_TOOLS, GIT_SERVER, MEMORY_SERVER, OFFICE_SERVER, OFFICE_TOOLS, READER_TOOLS, T } from "./toolNames.js";
import { DIRECTOR_PROMPT, IMPLEMENTOR_APPEND, PLANNER_PROMPT, QA_PROMPT, READER_PROMPT, RESEARCHER_PROMPT } from "./prompts.js";

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
    // `xhigh` is offered to the planner only when ENABLE_XHIGH is set (a Max-5-only tier); otherwise
    // the json_schema enum omits it entirely, so the planner's structured output literally cannot emit it.
    effort: { type: "string", enum: config.enableXhigh ? ["low", "medium", "high", "xhigh", "max"] : ["low", "medium", "high", "max"] },
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

// The reader's lean structured output: did it ANSWER the question read-only, or ESCALATE because the
// task actually needs the full pipeline? The answer itself is posted as a finding (post_finding); this
// only reports the disposition so runReader knows whether to mark the task done or park it for redispatch.
export const READER_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["answered", "escalated"],
  properties: {
    answered: { type: "boolean", description: "You fully answered the question read-only and posted the answer as a finding." },
    escalated: { type: "boolean", description: "The task needs the full pipeline (edits/verification/depth) — you posted a 'needs full pipeline' finding instead of half-answering." },
    reason: { type: "string", description: "When escalated: the one-line reason the full pipeline is needed." },
  },
};

/** Gate the `xhigh` effort tier behind the ENABLE_XHIGH opt-in. This is the single chokepoint that
 *  guarantees actual prevention: a stale DB row, a resumed run, or any legacy plan that still carries
 *  `xhigh` is coerced down to `high` here, so it can never reach the real SDK `options.effort`. */
export function resolveEffort(effort?: Effort): Effort {
  const requested = effort ?? "high";
  if (requested === "xhigh" && !config.enableXhigh) return "high";
  return requested;
}

export function directorConfig(
  servers: { director: McpServerConfig; memory: McpServerConfig },
  directorName: string,
): AgentRunConfig {
  return {
    model: config.models.director,
    cwd: config.defaultWorkspace,
    systemPrompt: `${DIRECTOR_PROMPT}\n\nYour name is ${directorName} — that's how ${config.ownerName} and the team refer to you; introduce yourself by it.`,
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

export function plannerConfig(cwd: string, servers: { bus: McpServerConfig; office: McpServerConfig }): AgentRunConfig {
  return {
    model: config.models.planner,
    cwd,
    systemPrompt: PLANNER_PROMPT,
    permissionMode: "plan",
    allowedTools: ["Read", "Grep", "Glob", ...BUS_TOOLS, ...OFFICE_TOOLS],
    disallowedTools: ["AskUserQuestion"],
    mcpServers: { [BUS_SERVER]: servers.bus, [OFFICE_SERVER]: servers.office },
    settingSources: ["project"],
    outputFormat: { type: "json_schema", schema: PLAN_SCHEMA },
    includePartialMessages: true,
    maxTurns: 40,
  };
}

export function researcherConfig(cwd: string, servers: { bus: McpServerConfig; memory: McpServerConfig; office: McpServerConfig }): AgentRunConfig {
  return {
    model: config.models.researcher,
    cwd,
    systemPrompt: RESEARCHER_PROMPT,
    permissionMode: "plan",
    // External-info-only: the researcher gathers web/docs/changelogs + the owner's memory, never the
    // codebase. Read/Grep/Glob are disallowed (the planner owns code reading) so it can't duplicate
    // that work even if tempted — its system prompt forbids it too.
    allowedTools: ["WebSearch", "WebFetch", T.searchMemory, ...BUS_TOOLS, ...OFFICE_TOOLS],
    disallowedTools: ["Read", "Grep", "Glob", "AskUserQuestion"],
    mcpServers: { [BUS_SERVER]: servers.bus, [MEMORY_SERVER]: servers.memory, [OFFICE_SERVER]: servers.office },
    settingSources: ["project"],
    outputFormat: { type: "json_schema", schema: RESEARCH_SCHEMA },
    includePartialMessages: true,
    maxTurns: 40,
  };
}

export function implementorConfig(
  cwd: string,
  servers: { bus: McpServerConfig; office: McpServerConfig },
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
    mcpServers: { [BUS_SERVER]: servers.bus, [OFFICE_SERVER]: servers.office },
    settingSources: ["user", "project", "local"],
    effort: resolveEffort(opts?.effort),
    includePartialMessages: true,
    // Deterministic turn ceiling: a cutoff here ends with subtype "error_max_turns" at a known point,
    // which the orchestrator detects and warm-resumes invisibly (cheap, since the just-ended session's
    // prompt cache is still warm). Without it the SDK default fires unpredictably mid-task → manual Resume.
    maxTurns: config.implementorMaxTurns,
  };
  if (opts?.resume) cfg.resume = opts.resume;
  return cfg;
}

export function qaConfig(cwd: string, servers: { bus: McpServerConfig; office: McpServerConfig }): AgentRunConfig {
  return {
    model: config.models.qa,
    cwd,
    systemPrompt: QA_PROMPT,
    // Needs Bash to run tests/build; cannot edit (it reviews, it doesn't implement).
    permissionMode: "bypassPermissions",
    disallowedTools: ["Write", "Edit", "NotebookEdit", "AskUserQuestion"],
    mcpServers: { [BUS_SERVER]: servers.bus, [OFFICE_SERVER]: servers.office },
    settingSources: ["project"],
    outputFormat: { type: "json_schema", schema: QA_SCHEMA },
    effort: "high",
    includePartialMessages: true,
    maxTurns: 60,
  };
}

/**
 * The read-only "reader" lane (dispatch_read): ONE cheap Sonnet agent that answers a lookup/question and
 * posts its answer as a finding — no planner/researcher/implementor/QA. Read-only is enforced at the
 * HARNESS level, not by the prompt: under bypassPermissions the disallowedTools denylist is a HARD block
 * (the exact mechanism that stops the QA role from editing today), so Write/Edit/NotebookEdit/Bash/
 * PowerShell literally cannot be invoked. Its capabilities are Read/Grep/Glob for the codebase plus the
 * allowlisted git_read MCP tool for history (no Bash), and the bus/office tools to post its answer and
 * coordinate. It escalates (structured escalated:true + a warning finding) rather than half-answering.
 */
export function readerConfig(
  cwd: string,
  servers: { bus: McpServerConfig; office: McpServerConfig; git: McpServerConfig },
): AgentRunConfig {
  return {
    model: config.models.reader,
    cwd,
    systemPrompt: READER_PROMPT,
    // bypassPermissions auto-approves the read tools so the reader runs unsupervised; the write/shell/
    // network tools below are then hard-blocked by disallowedTools (a real block under bypass, proven by
    // the QA role) — so the read-only guarantee holds even if the model is told, or tricked, to write.
    permissionMode: "bypassPermissions",
    allowedTools: ["Read", "Grep", "Glob", ...READER_TOOLS],
    disallowedTools: [
      "Write",
      "Edit",
      "NotebookEdit",
      "MultiEdit",
      "Bash",
      "PowerShell",
      "KillShell",
      "BashOutput",
      "WebSearch",
      "WebFetch",
      "Task",
      "AskUserQuestion",
    ],
    mcpServers: { [BUS_SERVER]: servers.bus, [OFFICE_SERVER]: servers.office, [GIT_SERVER]: servers.git },
    settingSources: ["project"],
    outputFormat: { type: "json_schema", schema: READER_SCHEMA },
    includePartialMessages: true,
    // A lookup shouldn't need many turns; enough to read several files + git history, then answer.
    maxTurns: 40,
  };
}
