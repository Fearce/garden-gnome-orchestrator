import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { OrchestratorApi } from "../orchestrator/api.js";
import type { Role } from "../types.js";
import { BUS_SERVER } from "../agents/toolNames.js";
import { config } from "../config.js";

export interface BusContext {
  threadId: string;
  role: Role;
  getRunId: () => string | undefined;
}

/**
 * The cross-agent blackboard, scoped to one thread. Every planner / researcher /
 * implementor gets its own instance bound to its thread + role, because the SDK
 * passes no caller identity into a tool handler.
 */
export function createBusServer(api: OrchestratorApi, ctx: BusContext): McpServerConfig {
  const postFinding = tool(
    "post_finding",
    "Record a discovery on this task's shared blackboard so the director and any other agents on this task can see it. Use it the moment you learn something that changes the plan, blocks progress, or another agent needs to know. A 'critical' finding can interrupt a running implementor.",
    {
      summary: z.string().describe("One-line summary of the finding."),
      detail: z.string().optional().describe("Longer detail / evidence / file references."),
      severity: z
        .enum(["info", "note", "warning", "critical"])
        .default("note")
        .describe("How urgently other agents need this. 'critical' may interrupt a live implementor to deliver it."),
    },
    async (args) => {
      const f = api.postFinding({
        threadId: ctx.threadId,
        fromRole: ctx.role,
        fromRunId: ctx.getRunId() ?? null,
        summary: args.summary,
        detail: args.detail ?? null,
        severity: args.severity,
      });
      return { content: [{ type: "text", text: `Finding recorded (${f.severity}): ${f.summary}` }] };
    },
  );

  const postDeliverable = tool(
    "post_deliverable",
    `Surface a file you produced as a DELIVERABLE in ${config.ownerName}'s console — it appears in the right-panel "Deliverables" section as a card ${config.ownerName} can View (inline preview), Download, or copy the path of. Use this when your output is a concrete file ${config.ownerName} should be able to open or retrieve directly (a report, a generated document, a CSV, a diagram, exported data), not just prose in the feed. Format: \`path\` is the file (absolute, or relative to this task's workspace, e.g. "docs/report.md") and MUST resolve inside the workspace; \`label\` is a short human title (e.g. "Design comparison report"); \`description\` is an optional one-line note about the contents.`,
    {
      path: z
        .string()
        .describe('Path to the file — absolute, or relative to the task workspace (e.g. "docs/report.md"). Must resolve inside the workspace.'),
      label: z.string().describe('Short human-readable label, e.g. "Design comparison report" or "Test results CSV".'),
      description: z.string().optional().describe("Optional one-line note about what the file contains."),
    },
    async (args) => {
      const f = api.postFinding({
        threadId: ctx.threadId,
        fromRole: ctx.role,
        fromRunId: ctx.getRunId() ?? null,
        kind: "deliverable",
        path: args.path,
        label: args.label,
        summary: args.label,
        detail: args.description ?? null,
        severity: "info", // 'info' never triggers route()'s warning/critical injection
      });
      return { content: [{ type: "text", text: `Deliverable recorded: ${f.label} (${f.path})` }] };
    },
  );

  const readFindings = tool(
    "read_findings",
    "Read the findings other agents have posted on this task's blackboard before continuing, so you don't duplicate work or miss new information.",
    {},
    async () => {
      const findings = api.db.listFindings(ctx.threadId);
      if (!findings.length) return { content: [{ type: "text", text: "No findings on this task yet." }] };
      const text = findings
        .map((f) => `- [${f.severity}] (${f.fromRole ?? "?"}) ${f.summary}${f.detail ? `\n    ${f.detail}` : ""}`)
        .join("\n");
      return { content: [{ type: "text", text }] };
    },
  );

  const askUser = tool(
    "ask_user",
    `Ask ${config.ownerName} for help when you hit a blocker only THEY can resolve — a missing file/credential, a needed secret or access, or a decision you can't make yourself. Pauses this task until they answer. Use it EARLY: the moment you identify a hard blocker, ask — do NOT spend turns hunting workarounds for something they can fix in seconds. Prefer multiple-choice options when you can. Keep the question SHORT: lead with the one thing you need, drop background ${config.ownerName} already knows, and aim for a few sentences — a wall of text is harder to answer, not easier.`,
    {
      header: z.string().describe("A 1-3 word chip label, e.g. 'Missing creds'."),
      question: z
        .string()
        .describe(
          `The essential ask, in a few short sentences with just enough context to act — concise, not a wall of text. Markdown is rendered (bold, lists, inline code, fenced code blocks), so use a code block for a command/snippet/path instead of inlining it — but keep prose tight; markdown is for clarity, not length.`,
        ),
      options: z
        .array(z.object({ label: z.string(), description: z.string().optional() }))
        .optional()
        .describe("Multiple-choice options. Omit for a free-text answer."),
      multiSelect: z.boolean().default(false),
    },
    async (args) => {
      const answer = await api.askUser({
        threadId: ctx.threadId,
        runId: ctx.getRunId() ?? null,
        header: args.header,
        question: args.question,
        options: args.options ?? [],
        multiSelect: args.multiSelect,
      });
      return { content: [{ type: "text", text: `${config.ownerName} answered: ${answer}` }] };
    },
  );

  const notifyThread = tool(
    "notify_thread",
    "Flag a DIFFERENT in-progress task with information it needs (use its task id). Records a finding on that task and, if important, interrupts its implementor to deliver it now.",
    {
      targetThreadId: z.string().describe("The id of the other task to notify."),
      message: z.string().describe("What that task needs to know."),
      important: z.boolean().default(false).describe("If true, interrupt that task's implementor to deliver this immediately."),
    },
    async (args) => {
      if (args.targetThreadId === ctx.threadId) {
        return {
          content: [{ type: "text", text: "notify_thread is for a DIFFERENT task — use post_finding for your own task's blackboard." }],
          isError: true,
        };
      }
      const target = api.getThread(args.targetThreadId);
      if (!target) {
        return { content: [{ type: "text", text: `No task with id ${args.targetThreadId}.` }], isError: true };
      }
      // Stamp the originating run so the target thread's route() applies its self-finding guard uniformly.
      api.postFinding({
        threadId: args.targetThreadId,
        fromRunId: ctx.getRunId() ?? null,
        fromRole: ctx.role,
        summary: `From task ${ctx.threadId.slice(0, 8)}: ${args.message}`,
        severity: args.important ? "critical" : "warning",
      });
      return { content: [{ type: "text", text: `Notified task ${args.targetThreadId.slice(0, 8)}.` }] };
    },
  );

  return createSdkMcpServer({
    name: BUS_SERVER,
    version: "0.1.0",
    tools: [postFinding, postDeliverable, readFindings, notifyThread, askUser],
  });
}
