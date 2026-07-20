import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { OrchestratorApi } from "../orchestrator/api.js";
import type { Scheduler } from "../orchestrator/scheduler.js";
import type { ImageAttachment } from "../types.js";
import { DIRECTOR_SERVER } from "../agents/toolNames.js";
import { existsSync } from "node:fs";
import { config } from "../config.js";
import { findWorkspaces } from "../workspace/findWorkspace.js";

/**
 * The director's control surface: clarify with the user, dispatch tasks, and
 * steer live threads. ask_user blocks the tool call until the GUI answers — the
 * runner sets a long CLAUDE_CODE_STREAM_CLOSE_TIMEOUT so that wait is safe.
 */
export function createDirectorServer(
  api: OrchestratorApi,
  getImages: () => ImageAttachment[],
  onDispatch: (threadId: string) => void,
  scheduler: Scheduler,
): McpServerConfig {
  const askUser = tool(
    "ask_user",
    `Ask ${config.ownerName} a clarifying question BEFORE dispatching work, when the request is ambiguous or you're filling a gap they likely forgot to mention. Prefer multiple-choice options when you can; leave options empty for a free-text answer. Blocks until they answer. Don't over-ask — bundle related questions, and only ask what actually changes what you'd dispatch. Keep the question SHORT: a sentence or two of the essential ask, not a wall of text.`,
    {
      header: z.string().describe("A 1-3 word chip label for the question, e.g. 'Target repo'."),
      question: z
        .string()
        .describe(
          "The question, kept concise — a few short sentences at most. Markdown is rendered (bold, lists, inline/fenced code), so use a code block for a snippet or path rather than inlining it, but don't pad the prose.",
        ),
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
      return { content: [{ type: "text", text: `${config.ownerName} answered: ${answer}` }] };
    },
  );

  const findWorkspace = tool(
    "find_workspace",
    `Resolve a project/repo NAME to its real absolute path on disk. ALWAYS use this to get the workspace before dispatch instead of guessing a path — pass the project name or keywords from ${config.ownerName}'s request (e.g. 'my web app', 'api server'). Returns ranked EXISTING directories (git repos preferred). One clear match → use it as the workspace; several plausible → ask ${config.ownerName} which; none → ask ${config.ownerName} for the path.`,
    { query: z.string().describe("Project name / keywords to locate, e.g. 'api server' or 'my web app'.") },
    async (args) => {
      const matches = findWorkspaces(args.query, config.workspaceSearchRoots);
      if (!matches.length) {
        return { content: [{ type: "text", text: `No directory matched "${args.query}" under the search roots. Ask ${config.ownerName} for the exact absolute path.` }] };
      }
      const text = matches.map((m, i) => `${i + 1}. ${m.path}${m.isGitRepo ? "  (git repo)" : ""}`).join("\n");
      return {
        content: [
          {
            type: "text",
            text: `Candidates for "${args.query}" (best first):\n${text}\n\nUse the top match as the dispatch workspace unless it's clearly wrong; if two are equally plausible, ask ${config.ownerName} which.`,
          },
        ],
      };
    },
  );

  const dispatch = tool(
    "dispatch",
    `Dispatch a task: the planner runs first in the target repo (reading the code and deciding whether external research is needed), routes to a researcher or straight to an Opus 4.8 implementor, then QA reviews — all seeded with the enriched brief and self-assembling; you don't choose the agents. Returns the task id immediately; the pipeline runs in the background and streams to the board. Call this once you have enough context (after enriching and any clarifying questions). Any image(s) ${config.ownerName} attached to this request are forwarded to the planner/implementor automatically — reference what they show in the brief if relevant; you don't need to re-describe them pixel by pixel.`,
    {
      title: z.string().describe("Short task title for the board lane."),
      workspace: z
        .string()
        .describe(
          "Absolute path of an EXISTING repo/dir the implementor works in, e.g. /Users/you/my-project. It must already be on disk — agents can't run in a path that isn't there, so don't guess folder names.",
        ),
      brief: z
        .string()
        .describe(
          `The ENRICHED brief for the implementor: the goal, the context you gathered (memories, constraints, conventions), what done looks like, and anything ${config.ownerName} clarified. Write it as the full spec you'd give up front — Opus 4.8 does best with the whole task stated at once.`,
        ),
    },
    async (args) => {
      if (!existsSync(args.workspace)) {
        return {
          content: [
            {
              type: "text",
              text: `Workspace "${args.workspace}" does not exist on disk. Do NOT dispatch — a task can only run in a directory that already exists. Confirm the exact absolute path with ${config.ownerName} (ask_user) and retry with the corrected path.`,
            },
          ],
          isError: true,
        };
      }
      const id = await api.dispatch({ title: args.title, workspace: args.workspace, brief: args.brief, images: getImages() });
      onDispatch(id); // link this turn's director messages to the new task so a search hit can jump to it
      return { content: [{ type: "text", text: `Dispatched task ${id} ("${args.title}") in ${args.workspace}.` }] };
    },
  );

  const dispatchRead = tool(
    "dispatch_read",
    `Dispatch a PURE READ-ONLY LOOKUP to the fast reader lane: ONE cheap agent reads the repo (files + git history) and posts the answer as a finding — NO planner, NO implementor, NO QA. It's seconds-to-minutes instead of the full pipeline. Use it ONLY for questions that are answered by reading — "where/what/why is X in the code", "is this done?", "which model/config does Y use?", "explain how Z works", "read file W and summarize". The reader CANNOT edit files, run builds/tests, or verify anything; if a request turns out to need any of that it will escalate back for a normal dispatch. So: reader lane ONLY for questions that change nothing and need no verified conclusion — for ANYTHING that edits/creates files, runs commands, needs a tested/verified answer, or spans a broad multi-file investigation, use \`dispatch\` (the full pipeline). Misrouting to the full pipeline is safe; misrouting a real task here wastes a round — WHEN IN DOUBT, use \`dispatch\`. Returns the task id immediately; the answer streams to the board (the card shows a READ badge).`,
    {
      title: z.string().describe("Short task title for the board lane."),
      workspace: z
        .string()
        .describe("Absolute path of an EXISTING repo/dir the reader inspects. It must already be on disk."),
      brief: z
        .string()
        .describe(
          `The question to answer, with enough context for the reader to find it (what ${config.ownerName} is asking, any file/area hints). Keep it a lookup — if it implies changing or verifying anything, use \`dispatch\` instead.`,
        ),
    },
    async (args) => {
      if (!existsSync(args.workspace)) {
        return {
          content: [
            {
              type: "text",
              text: `Workspace "${args.workspace}" does not exist on disk. Do NOT dispatch — confirm the exact absolute path with ${config.ownerName} (ask_user) and retry.`,
            },
          ],
          isError: true,
        };
      }
      const id = await api.dispatch({ title: args.title, workspace: args.workspace, brief: args.brief, images: getImages(), lane: "read" });
      onDispatch(id);
      return { content: [{ type: "text", text: `Dispatched READ task ${id} ("${args.title}") in ${args.workspace} — reader lane, no QA.` }] };
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

  const cronHelp =
    "5-field cron (minute hour day-of-month month day-of-week), server-local time. Examples: '0 9 * * *' = every day 09:00; '*/30 * * * *' = every 30 min; '0 8 * * 1-5' = 08:00 on weekdays; '0 0 1 * *' = midnight on the 1st.";

  const createScheduledTask = tool(
    "create_scheduled_task",
    `Create a RECURRING task: a prompt that runs in a target repo on a cron schedule. Each fire dispatches a normal task through the full pipeline (planner→implementor→QA), using whatever provider/model is active — just like a one-off dispatch, but automatic. Use this when ${config.ownerName} asks to run something on a schedule ("every morning", "nightly", "each Monday"). Resolve the repo path first (find_workspace) if you don't have it. ${cronHelp}`,
    {
      title: z.string().describe("Short title for each dispatched run (the board-lane label)."),
      workspace: z.string().describe("Absolute path of the EXISTING repo/dir the prompt runs in."),
      prompt: z.string().describe(`The brief handed to the pipeline on each run — write it as a complete standalone task, since it runs unattended with no further clarification from ${config.ownerName}.`),
      cron: z.string().describe(`The cron schedule. ${cronHelp}`),
      enabled: z.boolean().default(true).describe("Whether it starts active (default true)."),
      effort: z.enum(["low", "medium", "high", "max"]).optional().describe("Optional implementor effort for each run; omit to let the planner decide."),
    },
    async (args) => {
      if (!existsSync(args.workspace)) {
        return { content: [{ type: "text", text: `Workspace "${args.workspace}" does not exist on disk. Confirm the exact absolute path with ${config.ownerName} and retry.` }], isError: true };
      }
      const r = scheduler.create({ title: args.title, workspace: args.workspace, prompt: args.prompt, cron: args.cron, enabled: args.enabled, effort: args.effort });
      if (!r.ok || !r.schedule) return { content: [{ type: "text", text: `Could not create the scheduled task: ${r.error}` }], isError: true };
      const next = r.schedule.nextRunAt ? new Date(r.schedule.nextRunAt).toLocaleString() : "—";
      return { content: [{ type: "text", text: `Created scheduled task "${r.schedule.title}" (${r.schedule.cron}) in ${r.schedule.workspace}. Next run: ${next}.` }] };
    },
  );

  const listScheduledTasks = tool(
    "list_scheduled_tasks",
    "List all recurring/scheduled tasks with their schedule, whether they're enabled, and the next run time — so you can report on or reference one before editing it.",
    {},
    async () => {
      const list = scheduler.list();
      if (!list.length) return { content: [{ type: "text", text: "No scheduled tasks." }] };
      const text = list
        .map((s) => `- ${s.id} ${s.enabled ? "[on]" : "[off]"} "${s.title}" (${s.cron}) @ ${s.workspace}${s.nextRunAt ? ` — next ${new Date(s.nextRunAt).toLocaleString()}` : ""}`)
        .join("\n");
      return { content: [{ type: "text", text }] };
    },
  );

  const updateScheduledTask = tool(
    "update_scheduled_task",
    `Edit an existing scheduled task — change its prompt, schedule (cron), target repo, effort, or enable/disable it. Pass only the fields you want to change (get the id from list_scheduled_tasks). ${cronHelp}`,
    {
      id: z.string().describe("The scheduled task id (from list_scheduled_tasks)."),
      title: z.string().optional(),
      workspace: z.string().optional(),
      prompt: z.string().optional(),
      cron: z.string().optional().describe(cronHelp),
      enabled: z.boolean().optional(),
      effort: z.enum(["low", "medium", "high", "max"]).optional(),
    },
    async (args) => {
      const { id, ...patch } = args;
      if (patch.workspace && !existsSync(patch.workspace)) {
        return { content: [{ type: "text", text: `Workspace "${patch.workspace}" does not exist on disk.` }], isError: true };
      }
      const r = scheduler.update(id, patch);
      if (!r.ok || !r.schedule) return { content: [{ type: "text", text: `Could not update: ${r.error}` }], isError: true };
      const next = r.schedule.nextRunAt ? new Date(r.schedule.nextRunAt).toLocaleString() : "—";
      return { content: [{ type: "text", text: `Updated "${r.schedule.title}" (${r.schedule.cron}), ${r.schedule.enabled ? "enabled" : "disabled"}. Next run: ${next}.` }] };
    },
  );

  const deleteScheduledTask = tool(
    "delete_scheduled_task",
    "Delete a scheduled task permanently (get its id from list_scheduled_tasks). This stops all future runs; tasks it already dispatched are unaffected.",
    { id: z.string() },
    async (args) => {
      const r = scheduler.remove(args.id);
      return { content: [{ type: "text", text: r.ok ? `Deleted scheduled task ${args.id}.` : `Could not delete: ${r.error}` }], isError: !r.ok };
    },
  );

  return createSdkMcpServer({
    name: DIRECTOR_SERVER,
    version: "0.1.0",
    tools: [askUser, findWorkspace, dispatch, dispatchRead, listThreads, threadStatus, inject, interruptThread, readFindings, createScheduledTask, listScheduledTasks, updateScheduledTask, deleteScheduledTask],
  });
}
