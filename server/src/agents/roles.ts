import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { config } from "../config.js";
import { EFFORTS, type Effort } from "../types.js";
import type { AgentRunConfig } from "./runner.js";
import { conciseCommunicationEnabled, withCommunicationSystemPolicy, type CommunicationPolicyOptions } from "./communicationPolicy.js";
import { BUS_SERVER, BUS_TOOLS, DIRECTOR_SERVER, DIRECTOR_TOOLS, GIT_SERVER, MEMORY_SERVER, OFFICE_SERVER, OFFICE_TOOLS, READER_TOOLS, T } from "./toolNames.js";
import { COWORKER_PROMPT, DIRECTOR_PROMPT, IMPLEMENTOR_APPEND, PLANNER_PROMPT, QA_FIX_PROMPT, QA_PROMPT, READER_PROMPT, RESEARCHER_PROMPT, REVIEWER_PROMPT } from "./prompts.js";

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
    // `xhigh` is offered to the planner when enabled for this machine; otherwise
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
  required: ["pass", "summary", "changed"],
  properties: {
    pass: { type: "boolean" },
    summary: { type: "string" },
    changed: { type: "boolean", description: "True only when this QA run changed code or other task files." },
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

// The reader's structured output includes the answer as well as its disposition. Normal SDK readers
// still post the finding directly; a read-only Codex fallback has no MCP bus, so ThreadManager records
// this field through the same finding service on its behalf.
export const READER_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["answered", "escalated", "answer"],
  properties: {
    answered: { type: "boolean", description: "You fully answered the question read-only and posted the answer as a finding." },
    escalated: { type: "boolean", description: "The task needs the full pipeline (edits/verification/depth) — you posted a 'needs full pipeline' finding instead of half-answering." },
    answer: { type: "string", description: "The complete owner-facing answer with concrete file/commit references, or the escalation explanation." },
    reason: { type: "string", description: "When escalated: the one-line reason the full pipeline is needed." },
  },
};

// The auto-reviewer's verdict. `accept` is load-bearing control flow — it settles the task 'done' — so
// it's required alongside the summary the owner reads. `issues` carries the hand-back reasons; QA's issue
// shape is reused so the console renders both the same way.
export const REVIEWER_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["accept", "summary"],
  properties: {
    accept: { type: "boolean", description: "True only if you would sign this off yourself — the task is genuinely finished and correct." },
    summary: { type: "string", description: "What you verified and why you accepted or handed it back." },
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

/** Gate the `xhigh` effort tier behind the ENABLE_XHIGH opt-in. This is the single chokepoint that
 *  guarantees actual prevention: a stale DB row, a resumed run, or any legacy plan that still carries
 *  `xhigh` is coerced down to `high` here, so it can never reach the real SDK `options.effort`. */
export function resolveEffort(effort?: Effort): Exclude<Effort, "ultra"> {
  const requested = effort ?? "high";
  if (requested === "xhigh" && !config.enableXhigh) return "high";
  // Ultra is a Codex CLI execution mode, not an Anthropic SDK effort. If a Codex-selected task later
  // fails over to Claude/z.ai, preserve the highest supported SDK tier instead of leaking an invalid value.
  if (requested === "ultra") return "max";
  return requested;
}

/** Cap a per-task effort at a subscription's configured maximum — the director/planner still picks the
 *  effort per task (so a tiny task stays cheap), but never exceeds `cap`. Returns the lower of the two on
 *  the shared low→ultra ordinal, so a Codex/Grok cap also bounds a
 *  Claude-tier request down into that backend's valid range. */
export function clampEffort(effort: Effort, cap: Effort): Effort {
  return EFFORTS.indexOf(effort) <= EFFORTS.indexOf(cap) ? effort : cap;
}

export function directorConfig(
  servers: { director: McpServerConfig; memory: McpServerConfig },
  directorName: string,
  opts?: CommunicationPolicyOptions,
): AgentRunConfig {
  return {
    model: config.models.director,
    cwd: config.defaultWorkspace,
    systemPrompt: withCommunicationSystemPolicy(
      `${DIRECTOR_PROMPT}\n\nYour name is ${directorName} — that's how ${config.ownerName} and the team refer to you; introduce yourself by it.`,
      conciseCommunicationEnabled(opts),
    ),
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

export function plannerConfig(
  cwd: string,
  servers: { bus: McpServerConfig; office: McpServerConfig },
  opts?: CommunicationPolicyOptions,
): AgentRunConfig {
  return {
    model: config.models.planner,
    cwd,
    systemPrompt: withCommunicationSystemPolicy(PLANNER_PROMPT, conciseCommunicationEnabled(opts)),
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

export function researcherConfig(
  cwd: string,
  servers: { bus: McpServerConfig; memory: McpServerConfig; office: McpServerConfig },
  opts?: CommunicationPolicyOptions,
): AgentRunConfig {
  return {
    model: config.models.researcher,
    cwd,
    systemPrompt: withCommunicationSystemPolicy(RESEARCHER_PROMPT, conciseCommunicationEnabled(opts)),
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
  opts?: { resume?: string; effort?: Effort; conciseCommunication?: boolean },
): AgentRunConfig {
  const cfg: AgentRunConfig = {
    model: config.models.implementor,
    cwd,
    systemPrompt: withCommunicationSystemPolicy(
      { type: "preset", preset: "claude_code", append: IMPLEMENTOR_APPEND },
      conciseCommunicationEnabled(opts),
    ),
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

/** One bounded turn in a persistent Co-work conversation. No bus/office servers and no structured
 * pipeline output: the owner is the only coordinator and the reply itself is the hand-back. */
export function coworkerRunOptions(
  cwd: string,
  opts?: { resume?: string; effort?: Effort; conciseCommunication?: boolean },
): AgentRunConfig {
  const cfg: AgentRunConfig = {
    model: config.models.implementor,
    cwd,
    systemPrompt: withCommunicationSystemPolicy(
      { type: "preset", preset: "claude_code", append: COWORKER_PROMPT },
      conciseCommunicationEnabled(opts),
    ),
    permissionMode: "bypassPermissions",
    // A targeted blocker question is returned as the turn's reply. The built-in prompt tool would
    // bypass the durable Co-work transcript and leave the session waiting in an unrepresented state.
    disallowedTools: ["AskUserQuestion"],
    settingSources: ["user", "project", "local"],
    effort: resolveEffort(opts?.effort),
    includePartialMessages: true,
    maxTurns: config.coworkerMaxTurns,
  };
  if (opts?.resume) cfg.resume = opts.resume;
  return cfg;
}

export function qaConfig(
  cwd: string,
  servers: { bus: McpServerConfig; office: McpServerConfig },
  opts?: { applyFixes?: boolean; conciseCommunication?: boolean },
): AgentRunConfig {
  const applyFixes = opts?.applyFixes === true;
  return {
    model: config.models.qa,
    cwd,
    systemPrompt: withCommunicationSystemPolicy(
      applyFixes ? QA_FIX_PROMPT : QA_PROMPT,
      conciseCommunicationEnabled(opts),
    ),
    // The standard QA path is deliberately read-only. The opt-in QA-fixes path is an editing role
    // which commits only the fixes it made, so a completed task never leaves QA edits orphaned.
    permissionMode: "bypassPermissions",
    disallowedTools: applyFixes ? ["AskUserQuestion"] : ["Write", "Edit", "NotebookEdit", "AskUserQuestion"],
    mcpServers: { [BUS_SERVER]: servers.bus, [OFFICE_SERVER]: servers.office },
    settingSources: ["project"],
    outputFormat: { type: "json_schema", schema: QA_SCHEMA },
    effort: "high",
    includePartialMessages: true,
    // Two ceilings, because these are two different jobs. Reading a diff and reporting on it fits in 60
    // turns. Editing mode does the implementor's work over again — edit, build, run the suite, commit,
    // re-verify — and on 60 it was routinely guillotined mid-verification: a turn-ceiling cutoff on the
    // FIRST round became the common case once `qaAppliesFixes` shipped, spending a continuation (and its
    // whole extra Opus run) to buy the handful of turns the review was short.
    maxTurns: applyFixes ? config.qaFixMaxTurns : 60,
  };
}

/**
 * The on-demand auto-reviewer: ONE agent that stands in for the owner's final review of a task parked in
 * 'review' and either accepts it as done or hands it back with reasons. Shaped like QA — same read-only
 * posture (Write/Edit hard-blocked under bypassPermissions), Bash kept so it can actually run the repo's
 * build/tests and browser-drive a UI rather than eyeballing a diff. The one capability QA doesn't need:
 * it asks the OWNER directly (the bus `ask_user`) for the decisions only they can make, which is the whole
 * point of delegating the review. The built-in AskUserQuestion stays blocked so those questions land in
 * the console's own question flow.
 */
export function reviewerConfig(
  cwd: string,
  servers: { bus: McpServerConfig; office: McpServerConfig },
  opts?: CommunicationPolicyOptions,
): AgentRunConfig {
  return {
    model: config.models.reviewer,
    cwd,
    systemPrompt: withCommunicationSystemPolicy(REVIEWER_PROMPT, conciseCommunicationEnabled(opts)),
    permissionMode: "bypassPermissions",
    disallowedTools: ["Write", "Edit", "NotebookEdit", "MultiEdit", "AskUserQuestion"],
    mcpServers: { [BUS_SERVER]: servers.bus, [OFFICE_SERVER]: servers.office },
    settingSources: ["project"],
    outputFormat: { type: "json_schema", schema: REVIEWER_SCHEMA },
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
  opts?: CommunicationPolicyOptions,
): AgentRunConfig {
  return {
    model: config.models.reader,
    cwd,
    systemPrompt: withCommunicationSystemPolicy(READER_PROMPT, conciseCommunicationEnabled(opts)),
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
