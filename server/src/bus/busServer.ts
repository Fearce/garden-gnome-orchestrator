import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { OrchestratorApi } from "../orchestrator/api.js";
import type { Role } from "../types.js";
import { BUS_SERVER } from "../agents/toolNames.js";

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
    "Ask Mikkel for help when you hit a blocker only HE can resolve — a missing file/credential, a needed secret or access, or a decision you can't make yourself. Pauses this task until he answers. Use it EARLY: the moment you identify a hard blocker, ask — do NOT spend turns hunting workarounds for something he can fix in seconds. Prefer multiple-choice options when you can.",
    {
      header: z.string().describe("A 1-3 word chip label, e.g. 'Missing creds'."),
      question: z.string().describe("What you need from Mikkel, with enough context for him to act."),
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
      return { content: [{ type: "text", text: `Mikkel answered: ${answer}` }] };
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
    tools: [postFinding, readFindings, notifyThread, askUser],
  });
}
