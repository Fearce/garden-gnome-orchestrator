import { existsSync } from "node:fs";
import { config } from "../config.js";
import type { JsonSchemaLike } from "../agents/structuredText.js";
import type { ImageAttachment } from "../types.js";
import type { ThreadManager } from "./threadManager.js";
import type { OperatorNotes } from "./notes.js";
import type { Scheduler } from "./scheduler.js";
import { findWorkspaces } from "../workspace/findWorkspace.js";
import { normalizeDuration } from "./timedTasks.js";
import { clampAgentCount } from "./shotgun.js";

/** Codex/Grok cannot attach the in-process director MCP server. They instead return one constrained
 *  command per turn; this module executes it through the exact same orchestrator APIs and sends the
 *  result back for the next turn. The model never receives a shell-based escape hatch for directing. */
export const DIRECTOR_CLI_SCHEMA: JsonSchemaLike = {
  type: "object",
  additionalProperties: false,
  required: ["kind"],
  properties: {
    kind: {
      type: "string",
      enum: [
        "reply", "ask_user", "find_workspace", "dispatch", "dispatch_read", "list_threads",
        "thread_status", "inject", "interrupt_thread", "auto_review", "read_findings", "post_operator_note",
        "create_scheduled_task", "list_scheduled_tasks", "update_scheduled_task", "delete_scheduled_task",
      ],
    },
    message: { type: "string" },
    query: { type: "string" },
    title: { type: "string" },
    workspace: { type: "string" },
    brief: { type: "string" },
    duration: { type: "string" },
    agents: { type: "number" },
    threadId: { type: "string" },
    mode: { type: "string", enum: ["append", "interrupt"] },
    header: { type: "string" },
    question: { type: "string" },
    options: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label"],
        properties: { label: { type: "string" }, description: { type: "string" } },
      },
    },
    multiSelect: { type: "boolean" },
    note: { type: "string" },
    url: { type: "string" },
    id: { type: "string" },
    prompt: { type: "string" },
    cron: { type: "string" },
    enabled: { type: "boolean" },
    effort: { type: "string", enum: ["low", "medium", "high", "max"] },
  },
};

export interface DirectorCliAction {
  kind: string;
  message?: string;
  query?: string;
  title?: string;
  workspace?: string;
  brief?: string;
  duration?: string;
  agents?: number;
  threadId?: string;
  mode?: "append" | "interrupt";
  header?: string;
  question?: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
  note?: string;
  url?: string;
  id?: string;
  prompt?: string;
  cron?: string;
  enabled?: boolean;
  effort?: "low" | "medium" | "high" | "max";
}

export interface DirectorCliOutcome {
  final?: string;
  toolName?: string;
  toolInput?: unknown;
  result?: string;
  dispatchedId?: string;
}

export const DIRECTOR_CLI_PROTOCOL = `
You are running through the provider-neutral Director command bridge. You have NO direct orchestrator
tools and must not inspect or modify files. On every turn return exactly ONE JSON object matching the
required schema. The server executes tool commands and sends you a TOOL RESULT; then return the next
command. Use kind="reply" with message only when you are ready to speak to ${config.ownerName}.

Commands and fields:
- reply: message
- ask_user: header, question, options?, multiSelect?
- find_workspace: query
- dispatch: title, workspace, brief, duration?, agents?
- dispatch_read: title, workspace, brief
- list_threads
- thread_status: threadId
- inject: threadId, message, mode (append|interrupt). During QA, append steers QA and queues for the implementor; interrupt stops/supersedes QA and returns the task to implementation.
- interrupt_thread: threadId (pauses implementation, or stops/supersedes active QA and returns the task to implementation)
- auto_review: threadId (start the app's auto-reviewer for a task parked in review)
- read_findings: threadId? (omit for all)
- post_operator_note: note, url?
- create_scheduled_task: title, workspace, prompt, cron, enabled?, effort?
- list_scheduled_tasks
- update_scheduled_task: id plus any of title/workspace/prompt/cron/enabled/effort
- delete_scheduled_task: id

Never say something was dispatched/changed until the server has returned a successful TOOL RESULT.
`;

function required(action: DirectorCliAction, key: keyof DirectorCliAction): string {
  const value = action[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${String(key)} is required for ${action.kind}`);
  return value.trim();
}

export async function executeDirectorCliAction(
  action: DirectorCliAction,
  api: ThreadManager,
  scheduler: Scheduler,
  notes: OperatorNotes,
  images: ImageAttachment[],
  getTaskMode: () => { durationMs: number | null; agentCount: number | null } = () => ({ durationMs: null, agentCount: null }),
): Promise<DirectorCliOutcome> {
  if (action.kind === "reply") return { final: required(action, "message") };
  const toolInput = { ...action, kind: undefined };
  const outcome = (toolName: string, result: string, dispatchedId?: string): DirectorCliOutcome => ({ toolName, toolInput, result, dispatchedId });
  try {
    switch (action.kind) {
      case "ask_user": {
        const answer = await api.askUser({
          threadId: null,
          header: required(action, "header").slice(0, 40),
          question: required(action, "question"),
          options: action.options ?? [],
          multiSelect: action.multiSelect === true,
        });
        return outcome("ask_user", `${config.ownerName} answered: ${answer}`);
      }
      case "find_workspace": {
        const query = required(action, "query");
        const matches = findWorkspaces(query, config.workspaceSearchRoots);
        const result = matches.length
          ? matches.map((m, i) => `${i + 1}. ${m.path}${m.isGitRepo ? " (git repo)" : ""}`).join("\n")
          : `No directory matched "${query}". Ask ${config.ownerName} for the exact path.`;
        return outcome("find_workspace", result);
      }
      case "dispatch":
      case "dispatch_read": {
        const workspace = required(action, "workspace");
        if (!existsSync(workspace)) return outcome(action.kind, `ERROR: workspace "${workspace}" does not exist. Confirm the exact path and retry.`);
        const title = required(action, "title");
        const brief = required(action, "brief");
        const mode = getTaskMode();
        const explicitDuration = action.kind === "dispatch" && action.duration != null;
        const durationMs = explicitDuration ? normalizeDuration(action.duration) : mode.durationMs;
        if (explicitDuration && durationMs == null) {
          return outcome("dispatch", `ERROR: duration "${action.duration}" is not a valid work window. Use forms like "8h", "90m", "2h30m" or omit it.`);
        }
        const explicitAgents = action.kind === "dispatch" && action.agents != null;
        const agentCount = explicitAgents ? clampAgentCount(action.agents!) : mode.agentCount;
        const id = await api.dispatch({
          title,
          workspace,
          brief,
          images,
          ...(action.kind === "dispatch_read" ? { lane: "read" as const } : { durationMs, agentCount }),
        });
        return outcome(action.kind, `Dispatched task ${id} ("${title}") in ${workspace}.`, id);
      }
      case "list_threads": {
        const threads = api.listThreads();
        const result = threads.length
          ? threads.map((t) => `- ${t.id} [${t.state}] "${t.title}" @ ${t.workspace}`).join("\n")
          : "No tasks yet.";
        return outcome("list_threads", result);
      }
      case "thread_status": {
        const threadId = required(action, "threadId");
        const t = api.getThread(threadId);
        if (!t) return outcome("thread_status", `ERROR: no task ${threadId}.`);
        const runs = api.db.listRuns(t.id);
        const findings = api.db.listFindings(t.id);
        return outcome("thread_status", [
          `Task ${t.id} [${t.state}] "${t.title}" @ ${t.workspace}`,
          t.error ? `Error: ${t.error}` : "",
          "Agents:", ...runs.map((r) => `- ${r.role} (${r.model}): ${r.state}${r.error ? ` — ${r.error}` : ""}`),
          "Findings:", ...(findings.length ? findings.map((f) => `- [${f.severity}] (${f.fromRole}) ${f.summary}`) : ["(none)"]),
        ].filter(Boolean).join("\n"));
      }
      case "inject": {
        const threadId = required(action, "threadId");
        const r = await api.injectThread(threadId, required(action, "message"), action.mode ?? "append");
        return outcome("inject", r.ok ? `${r.message ?? `Injected into ${threadId} (${action.mode ?? "append"}).`} Current state: ${r.state ?? "unchanged"}.` : `ERROR: ${r.error}`);
      }
      case "interrupt_thread": {
        const threadId = required(action, "threadId");
        const r = await api.interruptThread(threadId);
        return outcome("interrupt_thread", r.ok ? `${r.message ?? `Interrupted ${threadId}.`} Current state: ${r.state ?? "unchanged"}.` : `ERROR: ${r.error}`);
      }
      case "auto_review": {
        const threadId = required(action, "threadId");
        const r = await api.autoReview(threadId);
        return outcome("auto_review", r.ok
          ? `Started auto-review for ${threadId}; current state: ${r.state ?? "reviewing"}.`
          : `ERROR: ${r.error}`);
      }
      case "read_findings": {
        const findings = api.db.listFindings(action.threadId?.trim() || undefined);
        return outcome("read_findings", findings.length
          ? findings.map((f) => `- ${f.threadId.slice(0, 8)} [${f.severity}] (${f.fromRole}) ${f.summary}`).join("\n")
          : "No findings.");
      }
      case "post_operator_note": {
        const r = notes.add({ body: required(action, "note"), url: action.url ?? null });
        return outcome("post_operator_note", r.ok && r.note ? `Added: ${r.note.body}` : `ERROR: ${r.error}`);
      }
      case "create_scheduled_task": {
        const workspace = required(action, "workspace");
        if (!existsSync(workspace)) return outcome("create_scheduled_task", `ERROR: workspace "${workspace}" does not exist.`);
        const r = scheduler.create({
          title: required(action, "title"), workspace, prompt: required(action, "prompt"),
          cron: required(action, "cron"), enabled: action.enabled ?? true, effort: action.effort,
        });
        return outcome("create_scheduled_task", r.ok && r.schedule ? `Created scheduled task ${r.schedule.id}.` : `ERROR: ${r.error}`);
      }
      case "list_scheduled_tasks": {
        const list = scheduler.list();
        return outcome("list_scheduled_tasks", list.length
          ? list.map((s) => `- ${s.id} ${s.enabled ? "[on]" : "[off]"} "${s.title}" (${s.cron}) @ ${s.workspace}`).join("\n")
          : "No scheduled tasks.");
      }
      case "update_scheduled_task": {
        const id = required(action, "id");
        if (action.workspace && !existsSync(action.workspace)) return outcome("update_scheduled_task", `ERROR: workspace "${action.workspace}" does not exist.`);
        const r = scheduler.update(id, {
          ...(action.title != null ? { title: action.title } : {}),
          ...(action.workspace != null ? { workspace: action.workspace } : {}),
          ...(action.prompt != null ? { prompt: action.prompt } : {}),
          ...(action.cron != null ? { cron: action.cron } : {}),
          ...(action.enabled != null ? { enabled: action.enabled } : {}),
          ...(action.effort != null ? { effort: action.effort } : {}),
        });
        return outcome("update_scheduled_task", r.ok && r.schedule ? `Updated scheduled task ${id}.` : `ERROR: ${r.error}`);
      }
      case "delete_scheduled_task": {
        const id = required(action, "id");
        const r = scheduler.remove(id);
        return outcome("delete_scheduled_task", r.ok ? `Deleted scheduled task ${id}.` : `ERROR: ${r.error}`);
      }
      default:
        return outcome("unknown", `ERROR: unsupported director command "${action.kind}".`);
    }
  } catch (err) {
    return outcome(action.kind, `ERROR: ${err instanceof Error ? err.message : String(err)}`);
  }
}
