/**
 * SUB-TASKS — a sub-agent an agent spawned, living in its own child thread.
 *
 * An implementor that wants help used to reach for the SDK's built-in Agent tool: an invisible
 * in-process helper the owner could neither see nor talk to, always on the parent's own model. A
 * sub-task replaces that. The spawning agent names ANY provider and ANY model (a Claude implementor can
 * hand a slice to Codex, or ask Jev for a calibrated judgement), and the sub-agent becomes a real thread
 * with `parent_id` = the spawning task and a `sub_task` spec. So it gets everything a task has — a feed,
 * inject/interrupt/stop/resume, deliverables, a work memo — and it is openable from its parent's panel.
 *
 * Two kinds, one surface:
 * - **Coding sub-agents** (claude / codex / grok / zai) run the ordinary implementor path through the
 *   same seam shotgun collaborators use: no planner, no QA (the spawning agent reviews), and exempt from
 *   the concurrency caps, because the parent holds a slot and may block waiting for its child. The
 *   model is a STRICT task-local pin (`exactModelRequest`), so a capped pool parks visibly instead of
 *   quietly running something else.
 * - **Jev sub-agents** are one HTTP call to TypeSafe AI's decision-only model: a state plus typed
 *   questions in, calibrated probabilities out. No session, no tools, never edits a file. A follow-up
 *   question (from the parent via `message_subtask`, or from the owner's inject) is another call against
 *   the SAME stored state.
 *
 * The result always travels back, through exactly two channels: the spawning agent's `wait_for_subtasks`
 * call, or — once its turn ends — the barrier in `ThreadManager.integrateSubTasks`, which waits for every
 * running sub-task and resumes the parent with each unreported result before its task hands off. A live
 * SDK parent also gets a heads-up when a child settles, but never the result itself: a message sent as a
 * turn ends can be lost, and a result must not be. `subTaskReported` (durable, on the child) is what keeps
 * a result from being delivered twice.
 *
 * Bounds, because an agent that can spawn agents can otherwise spawn without end: a live cap and a
 * lifetime cap per parent, a depth limit, a per-sub-task Jev call limit, and a bounded number of barrier
 * report rounds.
 */

import { z } from "zod";
import type { Db } from "../db/db.js";
import type { EventHub } from "../events.js";
import { evaluateJev, formatJevEvaluation, invalidJevQuestions, JEV_DEFAULT_MODEL } from "../agents/jevClient.js";
import type { DispatchInput, ThreadActionResult } from "./api.js";
import {
  EFFORTS,
  SUB_AGENT_PROVIDERS,
  type Effort,
  type ImplementorProvider,
  type JevEvaluation,
  type JevJson,
  type JevQuestion,
  type Role,
  type SubAgentProvider,
  type SubTaskSpec,
  type Thread,
  type ThreadState,
} from "../types.js";

// ---- bounds ---------------------------------------------------------------------------------------

/** Sub-tasks one task may have running at once. Each coding sub-agent is a full agent on this box. */
export const MAX_ACTIVE_SUBTASKS = 6;
/** Sub-tasks one task may spawn in its whole life — the runaway guard a live cap alone is not. */
export const MAX_SUBTASKS_PER_TASK = 24;
/** Nesting: a top-level task's sub-agent may spawn its own sub-agents, which may not spawn further. */
export const MAX_SUBTASK_DEPTH = 2;
/** Jev calls one Jev sub-task may make (its first evaluation plus follow-ups). Jev is metered. */
export const MAX_JEV_EVALUATIONS = 50;
/** How many times the barrier may resume a parent with sub-task results before it hands off anyway. */
export const MAX_SUBTASK_REPORT_ROUNDS = 3;
/** Longest single `wait_for_subtasks` block. The owner's messages reach an agent only between tool calls. */
export const MAX_WAIT_SECONDS = 300;
export const DEFAULT_WAIT_SECONDS = 60;
/** How much of a sub-agent's final report travels back to the parent in one delivery. */
const RESULT_CHARS = 6000;

/** States a sub-task has stopped in, whatever the verdict. `review` counts: the sub-agent stopped and a
 *  human may want to look, which from the parent's side is a finished run it must hear about. */
const SETTLED: ReadonlySet<ThreadState> = new Set(["done", "review", "failed", "cancelled", "closed"]);

export function subTaskSettled(state: ThreadState): boolean {
  return SETTLED.has(state);
}

export function isJevSubTask(thread: Pick<Thread, "subTask"> | null | undefined): boolean {
  return thread?.subTask?.provider === "jev";
}

// ---- the spawn contract (MCP tool input and the CLI `SUBTASK: {json}` bridge share it) -------------

const jevJson: z.ZodType<JevJson> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jevJson), z.record(z.string(), jevJson)]),
);

export const spawnSubAgentShape = {
  provider: z
    .enum(SUB_AGENT_PROVIDERS as unknown as [SubAgentProvider, ...SubAgentProvider[]])
    .describe('Which backend runs the sub-agent: "claude", "codex", "grok", "zai" (full coding agents) or "jev" (typed judgements only — no text, no tools).'),
  model: z
    .string()
    .max(160)
    .optional()
    .describe("Exact model id from list_subagent_models. Omit to use that provider's configured default."),
  effort: z.enum(EFFORTS as unknown as [Effort, ...Effort[]]).optional().describe("Reasoning effort for a coding sub-agent. Omit for the provider default. Ignored for jev."),
  title: z.string().min(1).max(120).describe("Short title for the sub-task card, e.g. \"Port the parser tests\"."),
  brief: z
    .string()
    .max(40_000)
    .optional()
    .describe("Coding sub-agents: the complete standalone brief — what to do and what 'done' means. The sub-agent sees only this plus the repo."),
  state: jevJson.optional().describe("Jev only: the content every question is judged against (a string, or JSON with named fields)."),
  questions: z
    .record(z.string(), z.any())
    .optional()
    .describe(
      'Jev only: a map of question id → question. {"type":"noul","instructions":"Did every test pass?"} returns P(yes); {"type":"choice","instructions":"...","criteria":{"optionA":"desc","optionB":"desc"}} picks one; {"type":"score","instructions":"...","criteria":["level 0","level 1","level 2"]} rates on 2-10 levels.',
    ),
};

export const spawnSubAgentSchema = z.object(spawnSubAgentShape);
export type SpawnSubAgentInput = z.infer<typeof spawnSubAgentSchema>;

/** One provider as the spawning agent sees it in `list_subagent_models`. */
export interface SubAgentRosterEntry {
  provider: SubAgentProvider;
  /** Enabled and authenticated — a spawn is accepted. */
  available: boolean;
  /** Why not, when it isn't. */
  reason?: string;
  /** Has capacity right now. An available provider without it still accepts the spawn; the sub-task
   *  then waits visibly for a window, exactly like a pinned task. */
  hasHeadroom: boolean;
  defaultModel: string | null;
  models: Array<{ id: string; efforts: Effort[] }>;
}

export interface SpawnResult {
  ok: boolean;
  error?: string;
  thread?: Thread;
  /** Human text for the calling agent: the id, what it runs on, and (for Jev) the answers. */
  message: string;
}

/** Who spawned a sub-task — the calling agent's task, role and run. */
export interface Spawner {
  threadId: string;
  role: Role;
  runId: string | null;
}

/** Everything the service needs from ThreadManager, kept narrow so this module never imports it. */
export interface SubTaskHost {
  db: Db;
  hub: EventHub;
  dispatch(input: DispatchInput): Promise<string>;
  officeName(threadId: string, role: Role): string;
  roster(): SubAgentRosterEntry[];
  jevApiKey(): string | undefined;
  /** A heads-up to the SDK implementor live on `threadId`, read at its next tool boundary. Best effort:
   *  it never carries the result itself, so losing it at a turn boundary loses nothing. */
  nudgeLive(threadId: string, text: string): void;
  injectThread(threadId: string, message: string, mode: "append" | "interrupt" | "queue", images?: undefined, options?: { standing?: boolean }): Promise<ThreadActionResult>;
  setState(threadId: string, state: ThreadState, error?: string | null): void;
  cancelThread(threadId: string): Promise<ThreadActionResult>;
}

// ---- the text agents read -------------------------------------------------------------------------

export function providerLabel(provider: SubAgentProvider): string {
  return { claude: "Claude", codex: "Codex", grok: "Grok", zai: "z.ai", jev: "Jev" }[provider];
}

export function subTaskRuntimeLabel(spec: Pick<SubTaskSpec, "provider" | "model" | "effort">): string {
  return [providerLabel(spec.provider), spec.model, spec.effort].filter(Boolean).join(" · ");
}

/** How deep in a sub-task chain `thread` sits: 0 for a task nobody spawned. */
export function subTaskDepth(db: Db, thread: Thread): number {
  let depth = 0;
  let cur: Thread | null = thread;
  const seen = new Set<string>();
  while (cur?.subTask && cur.parentId && !seen.has(cur.id)) {
    seen.add(cur.id);
    depth++;
    cur = db.getThread(cur.parentId);
  }
  return depth;
}

/** The contract appended to a coding sub-agent's kickoff. It overrides the general implementor
 *  doctrine where the two disagree (commit/push, QA), which is why it says so outright. */
export function subTaskContractBlock(input: {
  spec: SubTaskSpec;
  parentTitle: string;
  canSpawn: boolean;
}): string {
  const who = input.spec.spawnedByName ? `${input.spec.spawnedByName} — the ${input.spec.spawnedByRole}` : `The ${input.spec.spawnedByRole}`;
  return [
    "## ⑂ You are a SUB-AGENT",
    "",
    `${who} on task "${input.parentTitle}" — spawned you as a sub-task to do the job above. You run on ${subTaskRuntimeLabel(input.spec)}.`,
    "",
    "These rules override the general implementor instructions wherever they disagree:",
    "- Your FINAL message is handed back to the agent that spawned you as your result. End with a concrete report: what you did, the files you changed, what you verified and how, and anything left undone.",
    "- You share ONE working tree and branch with that agent and any sibling sub-agents. There is no separate checkout: touch only what your brief needs, and never revert, reformat or tidy changes you did not make.",
    "- Do NOT commit or push unless your brief explicitly tells you to. The spawning agent reviews and commits the combined work. If your brief does ask you to commit, stage only your own files by path — never `git add -A` or `git add .`.",
    "- No QA agent reviews a sub-task. Verify your own work: run the build, typecheck and tests your change touches.",
    input.canSpawn
      ? "- You may spawn sub-agents of your own when part of the job genuinely warrants it; wait for them and fold their results into your report."
      : "- You are at the maximum sub-agent depth. Do the work yourself; do not try to spawn further sub-agents.",
    "- The owner can open this sub-task and message you directly. Treat those messages as the owner's.",
  ].join("\n");
}

/** The final report of a settled sub-task, as the parent reads it. */
export function subTaskResultText(db: Db, child: Thread): string {
  if (isJevSubTask(child)) {
    const evals = db.getThreadStageOutputs(child.id).jevEvaluations ?? [];
    const last = evals.at(-1);
    return last ? formatJevEvaluation(last) : child.error ? `Jev could not answer: ${child.error}` : "Jev produced no answer.";
  }
  const memos = db.listImplementationMemos(child.id);
  const memo = [...memos].reverse().find((m) => m.report?.trim());
  const report = memo?.report?.trim() || lastImplementorText(db, child.id);
  const body = report ? clip(report, RESULT_CHARS) : "(the sub-agent left no final report)";
  return child.error && child.state !== "done" ? `${body}\n\nStopped because: ${child.error}` : body;
}

function lastImplementorText(db: Db, threadId: string): string | null {
  const run = db
    .listRuns(threadId)
    .filter((r) => r.role === "implementor")
    .sort((a, b) => b.startedAt - a.startedAt)[0];
  return run ? db.lastTextMessageForRun(run.id)?.content ?? null : null;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… (truncated — the full report is in the sub-task's feed)` : text;
}

const STATE_WORD: Partial<Record<ThreadState, string>> = {
  done: "finished",
  review: "stopped and wants review",
  failed: "failed",
  cancelled: "was cancelled",
  closed: "was closed",
};

/** One sub-task's delivery to its parent: identity, verdict, then the report. */
export function subTaskReport(db: Db, child: Thread): string {
  const verdict = STATE_WORD[child.state] ?? `is ${child.state}`;
  return [
    `⑂ Sub-task ${child.id.slice(0, 8)} "${child.title}" (${child.subTask ? subTaskRuntimeLabel(child.subTask) : "sub-agent"}) ${verdict}.`,
    subTaskResultText(db, child),
  ].join("\n");
}

/** One line of `list_subtasks`. */
export function subTaskStatusLine(child: Thread): string {
  const spec = child.subTask;
  return `- ${child.id} "${child.title}" — ${spec ? subTaskRuntimeLabel(spec) : "sub-agent"} — ${child.state}${child.error && !subTaskSettled(child.state) ? ` (${child.error})` : ""}`;
}

/** The barrier's resume message: every unreported result, and what to do with them. */
export function subTaskIntegrationBrief(reports: string[]): string {
  return [
    "## ⑂ Your sub-agents have reported back",
    "",
    reports.join("\n\n---\n\n"),
    "",
    "Fold their results into your task now. Review what each coding sub-agent changed (`git status`, `git diff`), fix the seams between their work and yours, verify the combined result, then finish the task properly — commit per your instructions and write your final report.",
  ].join("\n");
}

/** Owner or parent follow-up text → Jev questions. A JSON question map is used as given; anything else
 *  becomes one yes/no question, which is the only question shape plain prose can express faithfully. */
export function jevQuestionsFromText(text: string): { questions?: Record<string, JevQuestion>; error?: string } {
  const trimmed = text.trim();
  if (!trimmed) return { error: "Say what you want Jev to judge." };
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const map = parsed && typeof parsed === "object" && "questions" in (parsed as object) ? (parsed as { questions: unknown }).questions : parsed;
      const problem = invalidJevQuestions(map);
      if (problem) return { error: problem };
      return { questions: map as Record<string, JevQuestion> };
    } catch {
      /* not JSON after all — treat it as a yes/no question below */
    }
  }
  return { questions: { answer: { type: "noul", instructions: trimmed } } };
}

// ---- the service -----------------------------------------------------------------------------------

export class SubTaskService {
  /** Parents blocked in wait_for_subtasks, woken the moment one of their sub-tasks settles. */
  private readonly waiters = new Map<string, Set<() => void>>();
  /** The state each sub-task was last announced in, so a repeated write of one state posts once. */
  private readonly announced = new Map<string, ThreadState>();
  /** In-flight Jev calls, so a cancel stops the HTTP request rather than racing its result. */
  private readonly jevCalls = new Map<string, AbortController>();

  constructor(private readonly host: SubTaskHost) {}

  roster(): SubAgentRosterEntry[] {
    return this.host.roster();
  }

  /** `list_subagent_models`, as prose an agent can act on. */
  rosterText(): string {
    return this.roster()
      .map((p) => {
        const head = `${p.provider}${p.available ? (p.hasHeadroom ? "" : " (available, but no capacity right now — a sub-task will wait for a window)") : ` (UNAVAILABLE: ${p.reason ?? "not configured"})`}`;
        if (!p.available) return head;
        const models = p.models.map((m) => `${m.id}${m.id === p.defaultModel ? " [default]" : ""}${m.efforts.length ? ` — efforts: ${m.efforts.join(", ")}` : ""}`);
        return [head, ...models.map((m) => `  - ${m}`)].join("\n");
      })
      .join("\n");
  }

  /** Validate and create one sub-task. For Jev, also wait for its answers (one quick HTTP call) so the
   *  spawning agent gets them in the same tool result. */
  async spawn(spawner: Spawner, raw: unknown): Promise<SpawnResult> {
    const parsed = spawnSubAgentSchema.safeParse(raw);
    if (!parsed.success) return this.refuse(`Invalid sub-agent request: ${parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`);
    const input = parsed.data;
    const parent = this.host.db.getThread(spawner.threadId);
    if (!parent) return this.refuse("The task you are running in no longer exists.");
    const bounds = this.boundsProblem(parent);
    if (bounds) return this.refuse(bounds);

    const entry = this.roster().find((p) => p.provider === input.provider);
    if (!entry?.available) {
      return this.refuse(`${providerLabel(input.provider)} is not available as a sub-agent: ${entry?.reason ?? "not configured"}.\nAvailable now:\n${this.rosterText()}`);
    }
    const spawnedByName = this.host.officeName(spawner.threadId, spawner.role);
    return input.provider === "jev"
      ? this.spawnJev(parent, spawner, spawnedByName, input, entry)
      : this.spawnCoding(parent, spawner, spawnedByName, input as SpawnSubAgentInput & { provider: ImplementorProvider }, entry);
  }

  /** Every bound a new sub-task must fit inside, or null when it fits. */
  private boundsProblem(parent: Thread): string | null {
    if (isJevSubTask(parent)) return "A Jev sub-task cannot spawn sub-agents.";
    if (subTaskDepth(this.host.db, parent) >= MAX_SUBTASK_DEPTH) {
      return `This task is already a sub-agent ${MAX_SUBTASK_DEPTH} levels deep, the maximum. Do the work yourself.`;
    }
    const children = this.host.db.listSubTasks(parent.id);
    if (children.length >= MAX_SUBTASKS_PER_TASK) {
      return `This task has already spawned ${children.length} sub-tasks, the lifetime maximum of ${MAX_SUBTASKS_PER_TASK}. Finish with the ones you have.`;
    }
    const live = children.filter((c) => !subTaskSettled(c.state)).length;
    if (live >= MAX_ACTIVE_SUBTASKS) {
      return `${live} of your sub-tasks are still running (the maximum at once is ${MAX_ACTIVE_SUBTASKS}). Call wait_for_subtasks and spawn more once some finish.`;
    }
    return null;
  }

  private async spawnCoding(
    parent: Thread,
    spawner: Spawner,
    spawnedByName: string,
    input: SpawnSubAgentInput & { provider: ImplementorProvider },
    entry: SubAgentRosterEntry,
  ): Promise<SpawnResult> {
    const brief = input.brief?.trim();
    if (!brief) return this.refuse("A coding sub-agent needs a `brief`: the complete standalone job and what 'done' means.");
    const model = (input.model?.trim() || entry.defaultModel || "").trim();
    const known = entry.models.find((m) => m.id.toLowerCase() === model.toLowerCase());
    if (!model || !known) {
      return this.refuse(`${providerLabel(input.provider)} has no model "${input.model ?? "(default)"}".\nAvailable now:\n${this.rosterText()}`);
    }
    if (input.effort && known.efforts.length && !known.efforts.includes(input.effort)) {
      return this.refuse(`${known.id} does not accept effort "${input.effort}". It accepts: ${known.efforts.join(", ")}.`);
    }
    const spec: SubTaskSpec = {
      provider: input.provider,
      model: known.id,
      effort: input.effort ?? null,
      spawnedByRole: spawner.role,
      spawnedByName,
      spawnedByRunId: spawner.runId,
    };
    const id = await this.host.dispatch({
      title: input.title.trim(),
      workspace: parent.workspace,
      brief,
      effort: input.effort,
      requestedModel: known.id,
      requestedProvider: input.provider,
      parentId: parent.id,
      subTask: spec,
    });
    const child = this.host.db.getThread(id)!;
    this.parentFeed(parent.id, `⑂ ${spawnedByName} spawned sub-task "${child.title}" on ${subTaskRuntimeLabel(spec)}.`);
    const waitNote = entry.hasHeadroom ? "" : `\nNote: ${providerLabel(input.provider)} has no capacity right now, so it will start when a window frees up.`;
    return {
      ok: true,
      thread: child,
      message: `Spawned sub-task ${child.id} "${child.title}" on ${subTaskRuntimeLabel(spec)}. It works in this same repository and working tree. Its result comes back to you when it finishes — call wait_for_subtasks to block for it (about a minute per call), or keep working and it will be delivered.${waitNote}`,
    };
  }

  private async spawnJev(parent: Thread, spawner: Spawner, spawnedByName: string, input: SpawnSubAgentInput, entry: SubAgentRosterEntry): Promise<SpawnResult> {
    if (input.state === undefined) return this.refuse("A Jev sub-agent needs a `state`: the content its questions are judged against.");
    const problem = invalidJevQuestions(input.questions);
    if (problem) return this.refuse(`Jev questions are invalid: ${problem}`);
    const model = input.model?.trim() || entry.defaultModel || JEV_DEFAULT_MODEL;
    const spec: SubTaskSpec = {
      provider: "jev",
      model,
      effort: null,
      spawnedByRole: spawner.role,
      spawnedByName,
      spawnedByRunId: spawner.runId,
    };
    const questions = input.questions as Record<string, JevQuestion>;
    const id = await this.host.dispatch({
      title: input.title.trim(),
      workspace: parent.workspace,
      brief: jevBrief(input.state, questions),
      parentId: parent.id,
      subTask: spec,
      jev: { state: input.state, questions },
    });
    this.parentFeed(parent.id, `⑂ ${spawnedByName} asked Jev (sub-task "${input.title.trim()}") ${Object.keys(questions).length} question(s).`);
    const settled = await this.waitFor(parent.id, [id], 90_000);
    const child = settled.find((t) => t.id === id) ?? this.host.db.getThread(id)!;
    if (!subTaskSettled(child.state)) {
      return { ok: true, thread: child, message: `Sub-task ${id} is still waiting on Jev. Call wait_for_subtasks for its answers.` };
    }
    this.markReported(child.id);
    return {
      ok: child.state === "done",
      thread: child,
      message: child.state === "done" ? `Sub-task ${id} (Jev):\n${subTaskResultText(this.host.db, child)}` : `Sub-task ${id} (Jev) ${child.state}: ${child.error ?? "no answer"}`,
    };
  }

  private refuse(error: string): SpawnResult {
    return { ok: false, error, message: error };
  }

  /** The caller's sub-tasks, one status line each. */
  listText(parentId: string): string {
    const children = this.host.db.listSubTasks(parentId);
    return children.length ? children.map(subTaskStatusLine).join("\n") : "You have not spawned any sub-tasks.";
  }

  /**
   * Block until the named sub-tasks (default: every one still running) have all settled, or the timeout
   * passes — then return every settled result the caller has not yet received, and mark those reported.
   */
  async wait(parentId: string, ids: string[] | undefined, timeoutSeconds: number | undefined): Promise<string> {
    const children = this.host.db.listSubTasks(parentId);
    if (!children.length) return "You have not spawned any sub-tasks.";
    const wanted = ids?.length ? children.filter((c) => ids.some((id) => c.id === id || c.id.startsWith(id))) : children;
    if (!wanted.length) return `None of those ids are your sub-tasks.\n${this.listText(parentId)}`;
    const seconds = Math.min(MAX_WAIT_SECONDS, Math.max(1, Math.round(timeoutSeconds ?? DEFAULT_WAIT_SECONDS)));
    const rows = await this.waitFor(parentId, wanted.map((c) => c.id), seconds * 1000);
    const reports = rows.filter((c) => subTaskSettled(c.state) && !this.host.db.getThreadStageOutputs(c.id).subTaskReported);
    for (const c of reports) this.markReported(c.id);
    const pending = rows.filter((c) => !subTaskSettled(c.state));
    const parts = [
      ...reports.map((c) => subTaskReport(this.host.db, c)),
      pending.length
        ? `Still running after ${seconds}s: ${pending.map((c) => `${c.id.slice(0, 8)} "${c.title}" (${c.state})`).join(", ")}. Call wait_for_subtasks again to keep waiting.`
        : reports.length
          ? "All of the sub-tasks you waited on have finished."
          : "Those sub-tasks had already finished and their results were delivered to you earlier; list_subtasks shows their state.",
    ];
    return parts.join("\n\n---\n\n");
  }

  /** Poll the durable rows (restart-safe) and wake early on a settle event. */
  private async waitFor(parentId: string, ids: string[], timeoutMs: number): Promise<Thread[]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const rows = ids.map((id) => this.host.db.getThread(id)).filter((t): t is Thread => !!t);
      if (rows.every((t) => subTaskSettled(t.state)) || Date.now() >= deadline) return rows;
      await new Promise<void>((resolve) => {
        const set = this.waiters.get(parentId) ?? new Set<() => void>();
        const wake = (): void => {
          clearTimeout(timer);
          set.delete(wake);
          resolve();
        };
        const timer = setTimeout(wake, Math.min(2_000, Math.max(0, deadline - Date.now())));
        set.add(wake);
        this.waiters.set(parentId, set);
      });
    }
  }

  /** `message_subtask`: steer a coding sub-agent, or ask a Jev sub-task a follow-up question. */
  async message(parentId: string, subTaskId: string, text: string): Promise<string> {
    const child = this.host.db.listSubTasks(parentId).find((c) => c.id === subTaskId || c.id.startsWith(subTaskId));
    if (!child) return `No sub-task ${subTaskId} of yours.\n${this.listText(parentId)}`;
    if (isJevSubTask(child)) {
      const { questions, error } = jevQuestionsFromText(text);
      if (!questions) return `Not sent: ${error}`;
      const res = await this.askJev(child, questions, "agent");
      if (!res.ok) return `Jev could not answer: ${res.error}`;
      this.markReported(child.id);
      return subTaskResultText(this.host.db, this.host.db.getThread(child.id) ?? child);
    }
    if (subTaskSettled(child.state)) {
      // A settled sub-agent is resumed with the message, exactly as the owner's inject would.
      this.host.db.updateThreadStageOutputs(child.id, { subTaskReported: false });
    }
    const res = await this.host.injectThread(child.id, text, "append", undefined, { standing: false });
    return res.ok ? `Delivered to sub-task ${child.id.slice(0, 8)} "${child.title}". Its updated result comes back to you when it finishes.` : `Not delivered: ${res.error ?? "unknown error"}`;
  }

  // ---- lifecycle hooks (called by ThreadManager) ----------------------------------------------------

  /** A sub-task's state changed. On a settle: announce it in the parent's feed once, then hand the
   *  result to the spawning agent through the first channel that reaches it. */
  onStateChanged(child: Thread): void {
    if (!child.subTask || !child.parentId) return;
    if (!subTaskSettled(child.state)) {
      this.announced.delete(child.id);
      return;
    }
    if (this.announced.get(child.id) === child.state) return;
    this.announced.set(child.id, child.state);
    this.parentFeed(child.parentId, `⑂ Sub-task "${child.title}" (${subTaskRuntimeLabel(child.subTask)}) ${STATE_WORD[child.state] ?? child.state}.`);
    if (this.host.db.getThreadStageOutputs(child.id).subTaskReported) return;
    const waiting = this.waiters.get(child.parentId);
    if (waiting?.size) {
      for (const wake of [...waiting]) wake();
      return; // the pending wait_for_subtasks call reads and reports it
    }
    this.host.nudgeLive(
      child.parentId,
      `⑂ Your sub-task ${child.id.slice(0, 8)} "${child.title}" ${STATE_WORD[child.state] ?? child.state}. Call wait_for_subtasks to read its result (if you end your turn first, it is handed to you then).`,
    );
  }

  /** Settled sub-tasks whose result has not reached the parent — the barrier's work list. */
  unreported(parentId: string): Thread[] {
    return this.host.db
      .listSubTasks(parentId)
      .filter((c) => subTaskSettled(c.state) && !this.host.db.getThreadStageOutputs(c.id).subTaskReported);
  }

  unsettled(parentId: string): Thread[] {
    return this.host.db.listSubTasks(parentId).filter((c) => !subTaskSettled(c.state));
  }

  markReported(childId: string): void {
    this.host.db.updateThreadStageOutputs(childId, { subTaskReported: true });
  }

  /** The owner cancelled a task: its running sub-agents go with it, or they would keep editing a tree
   *  nobody is going to integrate. */
  async cancelChildren(parentId: string): Promise<void> {
    for (const child of this.unsettled(parentId)) await this.host.cancelThread(child.id);
  }

  // ---- Jev execution ---------------------------------------------------------------------------------

  /** A Jev sub-task's pipeline: answer whatever is outstanding — a follow-up interrupted by a restart,
   *  else the spawn questions if never answered — then settle. */
  async runJev(thread: Thread): Promise<void> {
    const stage = this.host.db.getThreadStageOutputs(thread.id);
    const evals = stage.jevEvaluations ?? [];
    if (!stage.jevQuestions || stage.jevState === undefined) {
      this.host.setState(thread.id, "failed", "This Jev sub-task has no stored state/questions to evaluate.");
      return;
    }
    if (stage.jevPending) {
      await this.askJev(thread, stage.jevPending.questions, stage.jevPending.askedBy);
      return;
    }
    if (evals.length) {
      if (thread.state !== "done") this.host.setState(thread.id, "done");
      return;
    }
    await this.askJev(thread, stage.jevQuestions, "agent");
  }

  /** The owner's inject on a Jev sub-task: another question against the same state. */
  async ownerQuestion(thread: Thread, text: string): Promise<ThreadActionResult> {
    const { questions, error } = jevQuestionsFromText(text);
    if (!questions) return { ok: false, state: thread.state, error };
    this.host.db.updateThreadStageOutputs(thread.id, { subTaskReported: false });
    const m = this.host.db.addMessage({ threadId: thread.id, role: "director", kind: "system", content: `↪ asked Jev: ${text.trim()}` });
    this.host.hub.publish({ type: "thread.message", threadId: thread.id, message: m });
    void this.askJev(thread, questions, "owner");
    return { ok: true, state: "implementing" };
  }

  /** One Jev evaluation against the sub-task's stored state, recorded as a run, a feed row and a memo. */
  async askJev(thread: Thread, questions: Record<string, JevQuestion>, askedBy: JevEvaluation["askedBy"]): Promise<{ ok: boolean; error?: string }> {
    const db = this.host.db;
    const stage = db.getThreadStageOutputs(thread.id);
    if ((stage.jevEvaluations?.length ?? 0) >= MAX_JEV_EVALUATIONS) {
      return { ok: false, error: `This Jev sub-task has made ${MAX_JEV_EVALUATIONS} calls, its maximum. Spawn a new one.` };
    }
    const key = this.host.jevApiKey();
    if (!key) {
      this.host.setState(thread.id, "failed", "No TypeSafe API key is configured for Jev (Settings → Subscriptions → Jev).");
      return { ok: false, error: "No Jev API key is configured." };
    }
    if (this.jevCalls.has(thread.id)) return { ok: false, error: "Jev is still answering this sub-task's previous question." };
    const model = thread.subTask?.model || JEV_DEFAULT_MODEL;
    const run = db.createRun({ threadId: thread.id, role: "implementor", model, account: "jev" });
    db.updateRun(run.id, { state: "running" });
    this.host.hub.publish({ type: "run.upsert", run: db.getRun(run.id)! });
    this.host.setState(thread.id, "implementing");
    const controller = new AbortController();
    this.jevCalls.set(thread.id, controller);
    db.updateThreadStageOutputs(thread.id, { jevPending: { questions, askedBy } });
    try {
      const result = await evaluateJev({ apiKey: key, model, state: stage.jevState ?? null, questions, signal: controller.signal });
      const evaluation: JevEvaluation = {
        at: Date.now(),
        model: result.model,
        questions,
        answers: result.answers,
        inputTokens: result.inputTokens,
        costUsd: result.costUsd,
        askedBy,
      };
      const current = db.getThreadStageOutputs(thread.id).jevEvaluations ?? [];
      db.updateThreadStageOutputs(thread.id, { jevEvaluations: [...current, evaluation], jevPending: null });
      const text = formatJevEvaluation(evaluation);
      const m = db.addMessage({ threadId: thread.id, runId: run.id, role: "implementor", kind: "text", content: text });
      this.host.hub.publish({ type: "thread.message", threadId: thread.id, message: m });
      db.updateRun(run.id, {
        state: "done",
        costUsd: result.costUsd,
        numTurns: 1,
        endedAt: Date.now(),
        capFlagged: false,
        tokenUsage: {
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          reasoningOutputTokens: 0,
          totalTokens: result.inputTokens + result.outputTokens,
        },
      });
      this.recordMemo(thread.id, run.id, "completed", text, null, model);
      this.host.hub.publish({ type: "run.upsert", run: db.getRun(run.id)! });
      if (db.getThread(thread.id)?.state !== "cancelled") this.host.setState(thread.id, "done");
      return { ok: true };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      const cancelled = controller.signal.aborted;
      db.updateThreadStageOutputs(thread.id, { jevPending: null });
      db.updateRun(run.id, { state: cancelled ? "interrupted" : "error", error, endedAt: Date.now(), capFlagged: false });
      this.host.hub.publish({ type: "run.upsert", run: db.getRun(run.id)! });
      this.recordMemo(thread.id, run.id, cancelled ? "interrupted" : "failed", null, error, model);
      if (!cancelled) this.host.setState(thread.id, "failed", error);
      return { ok: false, error };
    } finally {
      this.jevCalls.delete(thread.id);
    }
  }

  /** Stop an in-flight Jev call (the owner cancelled the sub-task). */
  abortJev(threadId: string): void {
    this.jevCalls.get(threadId)?.abort();
  }

  private recordMemo(threadId: string, runId: string, outcome: "completed" | "failed" | "interrupted", report: string | null, diagnostic: string | null, model: string): void {
    const run = this.host.db.getRun(runId);
    const memo = this.host.db.upsertImplementationMemo({
      threadId,
      runId,
      outcome,
      handoff: outcome === "completed" ? "done" : "review",
      report,
      diagnostic,
      model,
      account: "jev",
      startedAt: run?.startedAt ?? Date.now(),
      completedAt: Date.now(),
    });
    this.host.hub.publish({ type: "thread.memo", threadId, memo });
  }

  private parentFeed(parentId: string, content: string): void {
    const m = this.host.db.addMessage({ threadId: parentId, role: "implementor", kind: "system", content });
    this.host.hub.publish({ type: "thread.message", threadId: parentId, message: m });
  }
}

/** The brief a Jev sub-task's card and feed show: what it was asked, about what. */
function jevBrief(state: JevJson, questions: Record<string, JevQuestion>): string {
  const stateText = typeof state === "string" ? state : JSON.stringify(state, null, 2);
  return [
    "Jev judgement sub-task.",
    "",
    "## Questions",
    ...Object.entries(questions).map(([id, q]) => `- **${id}** (${q.type}): ${typeof q.instructions === "string" ? q.instructions : JSON.stringify(q.instructions)}`),
    "",
    "## State",
    stateText.length > 4000 ? `${stateText.slice(0, 4000)}\n… (${stateText.length.toLocaleString()} characters in full)` : stateText,
  ].join("\n");
}
