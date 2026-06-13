import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { OrchestratorApi } from "../orchestrator/api.js";
import { DIRECTOR_SERVER } from "../agents/toolNames.js";

/**
 * The director's control surface: clarify with the user, dispatch tasks, and
 * steer live threads. ask_user blocks the tool call until the GUI answers — the
 * runner sets a long CLAUDE_CODE_STREAM_CLOSE_TIMEOUT so that wait is safe.
 */
export function createDirectorServer(api: OrchestratorApi): McpServerConfig {
  const askUser = tool(
    "ask_user",
    "Ask Kevin a clarifying question BEFORE dispatching work, when the request is ambiguous or you're filling a gap he likely forgot to mention. Prefer multiple-choice options when you can; leave options empty for a free-text answer. Blocks until he answers. Don't over-ask — bundle related questions, and only ask what actually changes what you'd dispatch.",
    {
      header: z.string().describe("A 1-3 word chip label for the question, e.g. 'Target repo'."),
      question: z.string().describe("The full question."),
      options: z
        .array(z.object({ label: z.string(), description: z.string().optional() }))
        .optional()
        .describe("Multiple-choice options. Omit for a free-text answer."),
      multiSelect: z.boolean().default(false).describe("Allow selecting more than one option."),
    },
    async (args) => {
      const answer = await api.askUser({
        threadId: null,
        header: args.header,
        question: args.question,
        options: args.options ?? [],
        multiSelect: args.multiSelect,
      });
      return { content: [{ type: "text", text: `Kevin answered: ${answer}` }] };
    },
  );

  const dispatch = tool(
    "dispatch",
    "Dispatch a task: spins up the planner + researcher, then an Opus 4.8 implementor in the target repo, seeded with the enriched brief. Returns the task id immediately; the pipeline runs in the background and streams to the board. Call this once you have enough context (after enriching and any clarifying questions).",
    {
      title: z.string().describe("Short task title for the board lane."),
      workspace: z.string().describe("Absolute path of the repo/dir the implementor should work in, e.g. C:\\sprogbroen."),
      brief: z
        .string()
        .describe(
          "The ENRICHED brief for the implementor: the goal, the context you gathered (memories, constraints, conventions), what done looks like, and anything Kevin clarified. Write it as the full spec you'd give up front — Opus 4.8 does best with the whole task stated at once.",
        ),
    },
    async (args) => {
      const id = await api.dispatch({ title: args.title, workspace: args.workspace, brief: args.brief });
      return { content: [{ type: "text", text: `Dispatched task ${id} ("${args.title}") in ${args.workspace}.` }] };
    },
  );

  const listThreads = tool(
    "list_threads",
    "List all tasks and their current state so you can decide what to steer or report on.",
    {},
    async () => {
      const threads = api.listThreads();
      if (!threads.length) return { content: [{ type: "text", text: "No tasks yet." }] };
      const text = threads
        .map((t) => `- ${t.id} [${t.state}] "${t.title}" @ ${t.workspace}`)
        .join("\n");
      return { content: [{ type: "text", text }] };
    },
  );

  const threadStatus = tool(
    "thread_status",
    "Get the detailed state of one task: its pipeline state, each agent's status, and the findings on its blackboard.",
    { threadId: z.string() },
    async (args) => {
      const t = api.getThread(args.threadId);
      if (!t) return { content: [{ type: "text", text: `No task ${args.threadId}.` }], isError: true };
      const runs = api.db.listRuns(t.id);
      const findings = api.db.listFindings(t.id);
      const lines = [
        `Task ${t.id} [${t.state}] "${t.title}" @ ${t.workspace}`,
        t.error ? `Error: ${t.error}` : "",
        "Agents:",
        ...runs.map((r) => `  - ${r.role} (${r.model}): ${r.state}${r.error ? ` — ${r.error}` : ""}`),
        "Findings:",
        ...(findings.length ? findings.map((f) => `  - [${f.severity}] (${f.fromRole}) ${f.summary}`) : ["  (none)"]),
      ].filter(Boolean);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  const inject = tool(
    "inject",
    "Feed new information into a RUNNING task's implementor. 'append' queues it for the implementor's next step; 'interrupt' stops it now and hands it the message immediately (use when the new info invalidates what it's currently doing).",
    {
      threadId: z.string(),
      message: z.string().describe("The information / new instruction for the implementor."),
      mode: z.enum(["append", "interrupt"]).default("append"),
    },
    async (args) => {
      const r = await api.injectThread(args.threadId, args.message, args.mode);
      return {
        content: [{ type: "text", text: r.ok ? `Injected into ${args.threadId} (${args.mode}).` : `Failed: ${r.error}` }],
        isError: !r.ok,
      };
    },
  );

  const interruptThread = tool(
    "interrupt_thread",
    "Pause a running task's implementor (it stops at the next safe point and waits). Resume later by injecting or via the board.",
    { threadId: z.string() },
    async (args) => {
      const r = await api.interruptThread(args.threadId);
      return {
        content: [{ type: "text", text: r.ok ? `Paused ${args.threadId}.` : `Failed: ${r.error}` }],
        isError: !r.ok,
      };
    },
  );

  const readFindings = tool(
    "read_findings",
    "Read findings across all tasks (or one task). Use this to notice when something one task discovered is relevant to another, then notify or inject accordingly.",
    { threadId: z.string().optional().describe("Omit to read findings across every task.") },
    async (args) => {
      const findings = api.db.listFindings(args.threadId);
      if (!findings.length) return { content: [{ type: "text", text: "No findings." }] };
      const text = findings
        .map((f) => `- ${f.threadId.slice(0, 8)} [${f.severity}] (${f.fromRole}) ${f.summary}`)
        .join("\n");
      return { content: [{ type: "text", text }] };
    },
  );

  return createSdkMcpServer({
    name: DIRECTOR_SERVER,
    version: "0.1.0",
    tools: [askUser, dispatch, listThreads, threadStatus, inject, interruptThread, readFindings],
  });
}
