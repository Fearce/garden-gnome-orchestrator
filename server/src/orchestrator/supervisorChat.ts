import type { JsonSchemaLike } from "../agents/structuredText.js";
import type { Db } from "../db/db.js";
import type { EventHub } from "../events.js";
import type {
  AutoReviewSource,
  Finding,
  SupervisorChatAction,
  SupervisorChatActionResult,
  SupervisorChatStatus,
  SupervisorChatTarget,
  SupervisorChatTurn,
  Thread,
  ThreadState,
} from "../types.js";
import type { PostFindingInput, ThreadActionResult } from "./api.js";
import type { SupervisorJudgement } from "./supervisor.js";

const MAX_CONTENT_CHARS = 4_000;
const MAX_REPLY_CHARS = 2_400;
const MAX_ACTION_MESSAGE_CHARS = 1_200;
const MAX_TARGETS = 8;
const MAX_CATALOG_TASKS = 40;
const CHAT_HISTORY_TURNS = 8;
const CHAT_SNAPSHOT_TURNS = 100;
const CAP_PARK_MARKER = /auto-resume pending/i;
const MUTATING_ACTIONS = new Set<SupervisorChatAction>(["steer", "pause", "resume", "start_auto_review"]);
const TERMINAL_STATES = new Set<ThreadState>(["done", "cancelled", "closed"]);
const BOARD_ACTIVE_STATES = new Set<ThreadState>(["planning", "researching", "implementing", "qa", "reviewing"]);

type SteeringMode = "append" | "interrupt" | "queue";

interface ProposedAction {
  threadId: string;
  action: SupervisorChatAction;
  message: string;
  mode: SteeringMode;
  /** Board steering may use an existing live lane, but must never cold-resume one. */
  boardWide?: boolean;
}

interface ProposedBoardAction {
  action: "status" | "steer" | "start_auto_review";
  message: string;
  mode: "append" | "queue";
}

export interface SupervisorChatDecision {
  reply: string;
  needsOwner: boolean;
  actions: ProposedAction[];
  boardActions: ProposedBoardAction[];
}

export const SUPERVISOR_CHAT_SCHEMA: JsonSchemaLike = {
  type: "object",
  additionalProperties: false,
  required: ["reply", "needsOwner", "actions"],
  properties: {
    reply: { type: "string" },
    needsOwner: { type: "boolean" },
    actions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        // `taskId` is a tolerated provider alias. The action parser requires exactly one usable id and
        // still checks it against the server-owned scope. Keeping both optional in JSON Schema prevents
        // a harmless naming variance from discarding an otherwise safe plan before that check can run.
        required: ["action", "message", "mode"],
        properties: {
          threadId: { type: "string" },
          taskId: { type: "string" },
          action: {
            type: "string",
            enum: ["status", "comment", "steer", "pause", "resume", "start_auto_review", "escalate"],
          },
          message: { type: "string" },
          mode: { type: "string", enum: ["append", "interrupt", "queue"] },
        },
      },
    },
    boardActions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["action", "message", "mode"],
        properties: {
          action: { type: "string", enum: ["status", "steer", "start_auto_review"] },
          message: { type: "string" },
          mode: { type: "string", enum: ["append", "queue"] },
        },
      },
    },
  },
};

/** The conversational supervisor gets only existing-task controls. Keeping this interface beside the
 * action executor makes its authority auditable in one screenful: there is deliberately no dispatch,
 * retry, cancel, delete, close, or mark-done method. */
export interface SupervisorChatHost {
  readonly db: Db;
  readonly hub: EventHub;
  postFinding(input: PostFindingInput): Finding;
  canInjectSupervisorInstruction(threadId: string): boolean;
  injectSupervisorInstruction(
    threadId: string,
    message: string,
    mode: SteeringMode,
    options?: { liveOnly?: boolean },
  ): Promise<ThreadActionResult>;
  interruptThread(threadId: string): Promise<ThreadActionResult>;
  resumeThread(threadId: string, message?: string, operatorInitiated?: boolean): Promise<ThreadActionResult>;
  autoReview(threadId: string, source?: AutoReviewSource): Promise<ThreadActionResult>;
}

type Judge = (prompt: string, schema: JsonSchemaLike) => Promise<SupervisorJudgement | null>;

function clip(value: string, max: number): string {
  const text = (value ?? "").trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function taskLabel(thread: Pick<Thread, "id" | "title">): string {
  return `${thread.title} · #${shortId(thread.id)}`;
}

function targetSnapshot(thread: Thread | null, id: string): SupervisorChatTarget {
  return thread
    ? { threadId: thread.id, title: thread.title, state: thread.state }
    : { threadId: id, title: `Unknown task #${shortId(id)}`, state: null };
}

/** Clear, single-target controls should not wait on (or be distorted by) a model turn. The model still
 * owns nuanced steering, board-wide requests, and ambiguity; this path only recognizes explicit control
 * language whose meaning is fixed by the selected task's fresh state. The resulting action still flows
 * through execute(), so state checks, audit checkpoints, and the existing task primitives are identical. */
function deterministicDecision(turn: SupervisorChatTurn, thread: Thread | undefined): SupervisorChatDecision | null {
  if (turn.targets.length !== 1 || !thread) return null;
  const text = turn.content;
  const action = (kind: SupervisorChatAction, reply: string, message = "", mode: SteeringMode = "append"): SupervisorChatDecision => ({
    reply,
    needsOwner: false,
    actions: [{ threadId: thread.id, action: kind, message, mode }],
    boardActions: [],
  });

  const asksForStatus =
    /\b(?:status|progress)\b/i.test(text) ||
    /\b(?:update me|give me an update|how(?:'s| is))\b.{0,40}\b(?:task|work|it)\b/i.test(text);
  const asksToPause = /\b(?:pause|hold)\b/i.test(text) || /\bstop\b.{0,30}\b(?:task|work|agent|it)\b/i.test(text);
  const asksToContinue =
    /\b(?:resume|continue|restart)\b/i.test(text) ||
    /\bensure\b.{0,80}\b(?:finish(?:ed)?|complete(?:d)?|done)\b/i.test(text) ||
    /\b(?:finish|complete)\b.{0,30}\b(?:task|work|it|this)\b/i.test(text);
  const asksForReview = /\b(?:auto[- ]review|start (?:the )?review|have (?:the )?reviewer)\b/i.test(text);
  const asksToEscalate = /\b(?:escalate|flag)\b/i.test(text) || /\bblocker\b.{0,30}\b(?:owner|attention|decision)\b/i.test(text);
  const intentCount = [asksForStatus, asksToPause, asksToContinue, asksForReview, asksToEscalate].filter(Boolean).length;
  if (intentCount !== 1) return null;

  if (asksForStatus) return action("status", "I checked the selected task's current state and latest recorded run.");
  if (asksToPause) {
    return action("pause", "The request is an explicit pause, so I'm applying it through the task's existing interrupt control.");
  }
  if (asksToContinue && ["paused", "review", "failed"].includes(thread.state)) {
    return action(
      "resume",
      `The selected task is ${thread.state}, so I'm resuming its existing work with your instruction attached.`,
      text,
    );
  }
  if (asksForReview && thread.state === "review") {
    return action("start_auto_review", "The selected task is in review, so I'm delegating it through the existing auto-review path.");
  }
  if (asksToEscalate) {
    return action("escalate", "I'm recording this as an owner-visible escalation on the selected task.", text);
  }
  return null;
}

/** A common board command has fixed safe semantics and does not need a large catalog/model round trip.
 * The server supplies the quality-preserving instruction and resolves the live scope immediately before
 * execution. Destructive or quality-bypass wording deliberately falls through to the guarded model path. */
function deterministicBoardDecision(turn: SupervisorChatTurn): SupervisorChatDecision | null {
  if (turn.targets.length) return null;
  const text = turn.content;
  const namesReviewBacklog =
    /\b(?:all|every)\b.{0,80}\b(?:tasks?|items?)\b.{0,40}\b(?:in|awaiting|pending)\s+(?:auto[- ]?)?review\b/i.test(text) ||
    /\b(?:all|every)\b.{0,50}\breview\s+(?:tasks?|items?|backlog)\b/i.test(text);
  const asksToVerifyReview =
    /\b(?:check|verify|auto[- ]review)\b/i.test(text) ||
    /\breview\b.{0,40}\b(?:all|every)\b/i.test(text) ||
    /\b(?:have|let)\b.{0,30}\b(?:the\s+)?reviewer\b/i.test(text);
  if (namesReviewBacklog && asksToVerifyReview) {
    return {
      reply: "I will delegate each eligible review item to the existing auto-reviewer. The reviewer verifies the work, sends unfinished work through its normal fix or hand-back flow, and is the only path here that can mark a task done.",
      needsOwner: false,
      actions: [],
      boardActions: [{
        action: "start_auto_review",
        mode: "append",
        message: "Verify this task against its brief and workspace. Accept it only if the existing auto-review requirements pass; otherwise use the normal fix or hand-back flow.",
      }],
    };
  }

  const namesGroup = /\b(?:tasks?|agents?|them|they|all|everything)\b/i.test(text);
  const namesCurrentWork = /\b(?:running|active|in[ -]progress|we have|currently)\b/i.test(text);
  const asksToFinish = /\b(?:finish(?:\s+up)?|wrap\s+up|complete\s+(?:their|the|current))\b/i.test(text);
  const unsafe = /\b(?:cancel|delete|discard|force[- ]?stop|mark\s+(?:them\s+)?done|skip\s+(?:qa|tests?|review)|without\s+(?:qa|tests?|review))\b/i.test(text);
  if (!namesGroup || !namesCurrentWork || !asksToFinish || unsafe) return null;

  return {
    reply: "I will send a bounded append-only direction to each reachable active task. It keeps required verification and quality gates intact.",
    needsOwner: false,
    actions: [],
    boardActions: [{
      action: "steer",
      mode: "append",
      message: [
        "Finish the current approved scope promptly and do not expand it.",
        "Keep every required test, verification, QA/review, deployment, commit/push, and acceptance gate.",
        "Do not mark done or hand off incomplete work.",
        "If a real blocker remains, report the exact blocker, completed work, and remaining handoff instead of continuing to churn.",
      ].join(" "),
    }],
  };
}

function parseDecision(output: unknown, allowedIds: ReadonlySet<string>, allowBoard: boolean): SupervisorChatDecision | null {
  if (!output || typeof output !== "object" || Array.isArray(output)) return null;
  const raw = output as Record<string, unknown>;
  if (typeof raw.reply !== "string" || typeof raw.needsOwner !== "boolean" || !Array.isArray(raw.actions)) return null;
  if (raw.actions.length > MAX_TARGETS) return null;
  const rawBoardActions = raw.boardActions === undefined ? [] : raw.boardActions;
  if (!Array.isArray(rawBoardActions) || rawBoardActions.length > 1 || (!allowBoard && rawBoardActions.length)) return null;
  // A board template and hand-enumerated actions in one plan create two competing scope authorities.
  if (rawBoardActions.length && raw.actions.length) return null;

  const validActions = new Set<SupervisorChatAction>(["status", "comment", "steer", "pause", "resume", "start_auto_review", "escalate"]);
  const validModes = new Set<SteeringMode>(["append", "interrupt", "queue"]);
  const actions: ProposedAction[] = [];
  const seenExact = new Set<string>();
  const mutationByTask = new Set<string>();

  for (const item of raw.actions) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const value = item as Record<string, unknown>;
    const canonicalId = typeof value.threadId === "string" ? value.threadId : undefined;
    const aliasId = typeof value.taskId === "string" ? value.taskId : undefined;
    if (canonicalId && aliasId && canonicalId !== aliasId) return null;
    const threadId = canonicalId ?? aliasId;
    if (
      !threadId ||
      !allowedIds.has(threadId) ||
      typeof value.action !== "string" ||
      !validActions.has(value.action as SupervisorChatAction)
    ) {
      return null;
    }
    const action = value.action as SupervisorChatAction;
    // Some providers omit fields that are schema-required but irrelevant to a non-steering action.
    // Accept that harmless variance without weakening scope or mutation safety; steering still requires
    // both an actual instruction and a valid delivery mode.
    const message = typeof value.message === "string" ? value.message : "";
    const mode = validModes.has(value.mode as SteeringMode) ? (value.mode as SteeringMode) : "append";
    if (action === "steer" && (!message.trim() || !validModes.has(value.mode as SteeringMode))) return null;
    const exact = `${threadId}:${action}`;
    if (seenExact.has(exact)) continue;
    seenExact.add(exact);
    if (MUTATING_ACTIONS.has(action)) {
      // One state-changing operation per task per owner turn. A model proposing pause+resume or
      // steer+review in one batch is internally contradictory, so fail closed before either lands.
      if (mutationByTask.has(threadId)) return null;
      mutationByTask.add(threadId);
    }
    actions.push({
      threadId,
      action,
      message: clip(message, MAX_ACTION_MESSAGE_CHARS),
      mode,
    });
  }

  const boardActions: ProposedBoardAction[] = [];
  for (const item of rawBoardActions) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const value = item as Record<string, unknown>;
    if (value.action !== "status" && value.action !== "steer" && value.action !== "start_auto_review") return null;
    const message = typeof value.message === "string" ? clip(value.message, MAX_ACTION_MESSAGE_CHARS) : "";
    const mode = value.mode === "append" || value.mode === "queue" ? value.mode : null;
    if (!mode || (value.action === "steer" && !message)) return null;
    boardActions.push({ action: value.action, message, mode });
  }

  const reply = clip(raw.reply, MAX_REPLY_CHARS);
  if (!reply && actions.length === 0 && boardActions.length === 0) return null;
  return { reply, needsOwner: raw.needsOwner, actions, boardActions };
}

function ageText(at: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function taskFacts(db: Db, thread: Thread, detailed: boolean): string {
  const live = db.listActiveRuns().some((run) => run.threadId === thread.id);
  const base = [
    `Task ${thread.id}`,
    `Title: ${thread.title}`,
    `State: ${thread.state}${live ? " (live run present)" : " (no live run)"}`,
    `Updated: ${ageText(thread.updatedAt)}`,
    `Workspace: ${thread.workspace}`,
    `Error/park reason: ${clip(thread.error ?? "(none)", 400)}`,
  ];
  if (!detailed) return base.slice(0, 4).join(" | ") + (thread.error ? ` | Reason: ${clip(thread.error, 180)}` : "");

  const findings = db.listFindings(thread.id).slice(-3);
  const runs = db.listRuns(thread.id).slice(-3);
  const messages = db.listMessages(thread.id).slice(-4);
  base.push(`Brief: ${clip(thread.brief || thread.rawPrompt, 600) || "(empty)"}`);
  base.push("Recent findings:");
  base.push(...(findings.length ? findings.map((finding) => `- [${finding.severity}] ${clip(finding.summary, 240)}`) : ["- (none)"]));
  base.push("Recent runs:");
  base.push(...(runs.length ? runs.map((run) => `- ${run.role} / ${run.model}: ${run.state}${run.error ? ` — ${clip(run.error, 180)}` : ""}`) : ["- (none)"]));
  base.push("Recent feed:");
  base.push(...(messages.length ? messages.map((message) => `- ${message.role}: ${clip(message.content, 240)}`) : ["- (none)"]));
  return base.join("\n");
}

function conversationContext(turns: SupervisorChatTurn[], currentId: string): string {
  const history = turns.filter((turn) => turn.id !== currentId).slice(-CHAT_HISTORY_TURNS);
  if (!history.length) return "(no prior supervisor chat)";
  return history
    .map((turn) => {
      const targets = turn.targets.length ? turn.targets.map((target) => `${target.title} [${target.threadId}]`).join(", ") : "no explicit targets";
      const results = turn.actionResults.length
        ? `\nRecorded results: ${turn.actionResults.map((result) => `${result.ok ? "ok" : "failed"} ${result.action} on ${result.threadId}: ${clip(result.message, 180)}`).join("; ")}`
        : "";
      return `Owner (${targets}): ${clip(turn.content, 500)}\nSupervisor (${turn.status}): ${clip(turn.response ?? "", 700) || "(no reply)"}${results}`;
    })
    .join("\n\n");
}

function buildPrompt(db: Db, turn: SupervisorChatTurn, candidates: Thread[]): string {
  const explicit = turn.targets.length > 0;
  const context = candidates.length
    ? candidates.map((thread) => taskFacts(db, thread, explicit)).join("\n\n---\n\n")
    : "(there are no eligible existing tasks in context)";
  return [
    "You are the task Supervisor in an authenticated local coding-agent console. The owner is talking to you specifically about EXISTING tasks. You do not create work and you never edit repositories yourself.",
    "",
    explicit
      ? "The owner explicitly selected the task(s) below. They are the complete action scope: never propose an action for any other task."
      : "No task was selected. This is a board-wide request. You may answer a board status question, use one boardActions entry for a clear common instruction to active work or a review-backlog sweep, or act on one catalog task only when the request identifies it unambiguously. Otherwise ask the owner to select the task.",
    "Task creation, dispatch, or unrelated new work belongs in Director. If asked for that, explain this and return no actions. Never silently create or duplicate a task.",
    "If the request is ambiguous, needs a product/owner decision, or names a task you cannot identify, set needsOwner=true, ask one concrete question in reply, and take no action affected by that ambiguity.",
    "Do not claim an operation succeeded in reply. The server validates fresh state and executes actions only after your answer; phrase the reply as your assessment/intent, then the UI appends authoritative results.",
    "",
    "Available actions:",
    "- status: report the task's current state/evidence; no mutation.",
    "- comment: add useful non-urgent context to the task's findings.",
    "- steer: send a task-specific instruction through the existing injection path. Use queue for next-handoff work, append for normal live steering, and interrupt only when the owner explicitly asks for an urgent course correction.",
    "- pause: interrupt a live IMPLEMENTING task into paused. Do not use it for QA/review/planning; ask or explain instead.",
    "- resume: continue a paused/review/failed task through its existing saved-session resume path.",
    "- start_auto_review: delegate a normal review park to the existing reviewer. The reviewer, not you, decides whether it may become done.",
    "- escalate: add a visible warning that needs the owner's attention. It does not pretend to resolve the blocker.",
    "There is intentionally no cancel, retry, delete, close, dispatch, or mark-done action.",
    "Use at most one state-changing action per task. Put the exact instruction/finding text in message. mode is required for every action but ignored unless action=steer. Use threadId from the catalog for per-task actions (taskId is accepted only as a compatibility alias).",
    "For a clear board-wide common request, return actions=[] and exactly one boardActions entry. For action=steer or status, the server expands it to at most 8 reachable top-level tasks currently in planning, researching, implementing, QA, or reviewing. Board steering supports append or queue only; it preserves current sessions and never cold-resumes or interrupts them.",
    "For a clear request to verify all tasks parked in review, use boardActions action=start_auto_review. The server expands it to at most 8 top-level tasks in normal review and skips capacity-owned auto-resume parks. Each existing reviewer independently verifies its task and owns the accept-as-done decision; the Supervisor never marks work done directly. A request to mark tasks done without this review remains an acceptance bypass and is out of scope.",
    "Board pause/resume/escalate and destructive or acceptance-bypass requests are out of scope.",
    "",
    "Recent supervisor conversation:",
    conversationContext(db.listSupervisorChatTurns(CHAT_HISTORY_TURNS + 1), turn.id),
    "",
    explicit ? "Selected task context:" : "Current task catalog (bounded to the most relevant/recent tasks):",
    context,
    "",
    `Owner's new message: ${turn.content}`,
    "",
    "Return exactly one JSON object matching the supplied schema.",
  ].join("\n");
}

function looksLikeNewTaskRequest(content: string): boolean {
  return /\b(?:create|dispatch|start|open|add|spin\s+up)\s+(?:me\s+)?(?:a\s+)?(?:brand[- ]new\s+|new\s+)?task\b/i.test(content);
}

function candidateThreads(db: Db, turn: SupervisorChatTurn): Thread[] {
  if (turn.targets.length) return turn.targets.map((target) => db.getThread(target.threadId)).filter((thread): thread is Thread => !!thread);

  const all = db.listThreads().filter((thread) => !thread.parentId && thread.state !== "closed" && thread.state !== "cancelled");
  const recentTargetIds = db
    .listSupervisorChatTurns(CHAT_HISTORY_TURNS + 1)
    .filter((item) => item.id !== turn.id)
    .slice(-3)
    .flatMap((item) => item.targets.map((target) => target.threadId));
  const rank = (thread: Thread): number => {
    if (["planning", "researching", "implementing", "qa", "reviewing"].includes(thread.state)) return 0;
    if (["awaiting_user", "awaiting_approval", "paused", "review", "failed"].includes(thread.state)) return 1;
    return 2;
  };
  all.sort((a, b) => {
    const recentA = recentTargetIds.includes(a.id) ? 0 : 1;
    const recentB = recentTargetIds.includes(b.id) ? 0 : 1;
    return recentA - recentB || rank(a) - rank(b) || b.updatedAt - a.updatedAt;
  });
  return all.slice(0, MAX_CATALOG_TASKS);
}

function resultText(result: ThreadActionResult, success: string): string {
  return result.ok ? result.message || success : result.error || "The task control declined the action.";
}

function finalResponse(reply: string, results: SupervisorChatActionResult[]): string {
  return reply || (results.length ? "I checked the request against the selected task state. The recorded action results are below." : "I reviewed the request.");
}

export class SupervisorChat {
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly host: SupervisorChatHost,
    private readonly judge: Judge,
    private readonly onChange: () => void,
  ) {
    const recovered = this.host.db.failPendingSupervisorChatTurns();
    if (recovered) this.host.hub.log("warn", `Supervisor chat marked ${recovered} interrupted request(s) failed after restart.`);
  }

  submit(content: string, requestedTargetIds: string[], turnId?: string): SupervisorChatTurn {
    const text = clip(content, MAX_CONTENT_CHARS);
    if (!text) throw new Error("Supervisor message cannot be empty.");
    const ids = [...new Set(requestedTargetIds)].slice(0, MAX_TARGETS);
    if (turnId) {
      const existing = this.host.db.getSupervisorChatTurn(turnId);
      if (existing) {
        const sameTargets = existing.targets.map((target) => target.threadId).join("\n") === ids.join("\n");
        if (existing.content !== text || !sameTargets) throw new Error("Supervisor receipt id already belongs to a different request.");
        // WebSocket delivery is at-least-once. Returning the durable receipt without enqueueing process()
        // makes an exact resend idempotent whether the first attempt is pending or already terminal.
        return existing;
      }
    }
    const targets = ids.map((id) => targetSnapshot(this.host.db.getThread(id), id));
    const turn = this.host.db.createSupervisorChatTurn({ id: turnId, content: text, targets });
    this.onChange();

    const run = this.tail.then(() => this.process(turn.id));
    this.tail = run.catch((error) => {
      const current = this.host.db.getSupervisorChatTurn(turn.id);
      if (current?.status === "pending") {
        this.host.db.updateSupervisorChatTurn(turn.id, {
          status: "failed",
          response: `The supervisor could not finish this request: ${clip(String(error), 500)}`,
        });
        this.onChange();
      }
    });
    return turn;
  }

  snapshot(limit = CHAT_SNAPSHOT_TURNS): SupervisorChatTurn[] {
    return this.host.db.listSupervisorChatTurns(limit);
  }

  private async process(turnId: string): Promise<void> {
    let turn = this.host.db.getSupervisorChatTurn(turnId);
    if (!turn || turn.status !== "pending") return;

    const missing = turn.targets.filter((target) => !this.host.db.getThread(target.threadId));
    if (missing.length) {
      this.finish(turn, "failed", `I couldn't find ${missing.map((target) => `${target.title} (${target.threadId})`).join(", ")}. Select an existing task and resend the instruction.`);
      return;
    }

    // Hard routing boundary: a clear no-target request to create another task never reaches a model that
    // could reinterpret it as permission. The owner gets a useful answer, and no task API is available.
    if (turn.targets.length === 0 && looksLikeNewTaskRequest(turn.content)) {
      this.finish(turn, "succeeded", "New work belongs in the Director chat. I did not create or alter a task; send that request to Director so it can be enriched and dispatched once.");
      return;
    }

    const candidates = candidateThreads(this.host.db, turn);
    const allowedIds = new Set(candidates.map((thread) => thread.id));
    const stateSeen = new Map(candidates.map((thread) => [thread.id, thread.state]));
    let decision = deterministicDecision(turn, candidates[0]) ?? deterministicBoardDecision(turn);
    if (!decision) {
      const judged = await this.judge(buildPrompt(this.host.db, turn, candidates), SUPERVISOR_CHAT_SCHEMA).catch(() => null);
      if (!judged) {
        this.finish(turn, "failed", "The message is saved, but the supervisor could not get model capacity for this turn. No task action was taken; resend it when a provider is available.");
        return;
      }

      turn = this.host.db.updateSupervisorChatTurn(turn.id, {
        usedAgent: true,
        costUsd: judged.costUsd,
        totalTokens: judged.tokenUsage?.totalTokens ?? null,
        model: judged.model,
        provider: judged.provider,
      }) ?? turn;
      this.onChange();

      decision = parseDecision(judged.output, allowedIds, turn.targets.length === 0);
      if (!decision) {
        this.finish(turn, "failed", "The supervisor returned an invalid or out-of-scope action plan. Nothing was changed; select the intended task and resend the instruction.");
        return;
      }
    }

    if (decision.boardActions.length) {
      const board = decision.boardActions[0]!;
      // The model catalog is deliberately bounded, but a server-owned review sweep must not miss an
      // older review item merely because newer active tasks filled that catalog. Resolve this one safe
      // scope from the fresh board, then retain the normal per-turn action limit below.
      const boardCandidates = board.action === "start_auto_review"
        ? this.host.db.listThreads().filter((thread) => !thread.parentId && thread.state === "review")
        : candidates;
      for (const thread of boardCandidates) stateSeen.set(thread.id, thread.state);
      const active = boardCandidates.filter((thread) => BOARD_ACTIVE_STATES.has(thread.state));
      const reviewParked = boardCandidates.filter((thread) => thread.state === "review");
      const eligibleReview = reviewParked.filter((thread) => !CAP_PARK_MARKER.test(thread.error ?? ""));
      const reachable = board.action === "start_auto_review"
        ? eligibleReview
        : board.action === "steer"
          ? active.filter((thread) => this.host.canInjectSupervisorInstruction(thread.id))
          : active;
      const scoped = reachable.slice(0, MAX_TARGETS);
      decision.actions = scoped.map((thread) => ({
        threadId: thread.id,
        action: board.action,
        message: board.message,
        mode: board.mode,
        boardWide: board.action === "steer",
      }));
      const unavailable = board.action === "steer" ? active.length - reachable.length : 0;
      const capacityParked = board.action === "start_auto_review" ? reviewParked.length - eligibleReview.length : 0;
      const overLimit = Math.max(0, reachable.length - scoped.length);
      const scope = board.action === "start_auto_review"
        ? scoped.length
          ? `Scope resolved to ${scoped.length} eligible review task${scoped.length === 1 ? "" : "s"}.`
          : "No eligible normal review task is parked, so nothing will be changed."
        : scoped.length
          ? `Scope resolved to ${scoped.length} reachable active task${scoped.length === 1 ? "" : "s"}.`
          : "No reachable active task is running, so nothing will be changed.";
      const exclusions = [
        unavailable ? `${unavailable} active task${unavailable === 1 ? " has" : "s have"} no live session and will not be cold-resumed.` : "",
        capacityParked ? `${capacityParked} review task${capacityParked === 1 ? " is" : "s are"} already waiting for automatic capacity recovery and will not be reviewed as finished work.` : "",
        overLimit ? `${overLimit} additional ${board.action === "start_auto_review" ? "review" : "active"} task${overLimit === 1 ? " is" : "s are"} outside the board limit and will not be changed.` : "",
      ].filter(Boolean).join(" ");
      decision.reply = clip(`${decision.reply} ${scope}${exclusions ? ` ${exclusions}` : ""}`, MAX_REPLY_CHARS);
    } else if (turn.targets.length === 0) {
      // Without an explicit target selection, a batched model plan may only be the compatibility form of
      // a live-only board steering request. Board-wide pause/resume/review/escalation must not bypass the
      // boardActions expansion path by hand-enumerating per-task mutations.
      if (decision.actions.length > 1 && decision.actions.some((action) => action.action !== "steer")) {
        this.finish(turn, "failed", "The supervisor returned an invalid or out-of-scope action plan. Nothing was changed; select the intended task and resend the instruction.");
        return;
      }
      // An unselected per-task steering plan is allowed only for a currently active, reachable session.
      // This accepts the recovered production plan's harmless taskId alias without opening cold resume.
      const safe = decision.actions.every((action) =>
        action.action !== "steer" ||
        (BOARD_ACTIVE_STATES.has(stateSeen.get(action.threadId)!) && this.host.canInjectSupervisorInstruction(action.threadId))
      );
      if (!safe) {
        this.finish(turn, "failed", "The supervisor returned an invalid or out-of-scope action plan. Nothing was changed; select the intended task and resend the instruction.");
        return;
      }
      decision.actions = decision.actions.map((action) => ({ ...action, boardWide: action.action === "steer" }));
    }

    const results: SupervisorChatActionResult[] = [];
    for (const action of decision.actions) {
      const result = await this.execute(action, stateSeen.get(action.threadId));
      results.push(result);
      // Checkpoint after every operation. A restart can then say exactly what already happened and will
      // never replay the turn automatically.
      turn = this.host.db.updateSupervisorChatTurn(turn.id, { actionResults: [...results] }) ?? turn;
      this.onChange();
    }

    const failed = results.some((result) => !result.ok);
    const status: SupervisorChatStatus = failed ? "failed" : decision.needsOwner ? "needs_input" : "succeeded";
    this.finish(turn, status, finalResponse(decision.reply, results), results);
  }

  private finish(turn: SupervisorChatTurn, status: SupervisorChatStatus, response: string, actionResults = turn.actionResults): void {
    this.host.db.updateSupervisorChatTurn(turn.id, { status, response: clip(response, 6_000), actionResults });
    this.host.hub.log("info", `Supervisor chat ${turn.id.slice(0, 8)} ${status}${actionResults.length ? ` with ${actionResults.length} action result(s)` : ""}.`);
    this.onChange();
  }

  private async execute(action: ProposedAction, expectedState: ThreadState | undefined): Promise<SupervisorChatActionResult> {
    const current = this.host.db.getThread(action.threadId);
    const title = current?.title ?? `Unknown task #${shortId(action.threadId)}`;
    const base = (ok: boolean, message: string, state = current?.state ?? null): SupervisorChatActionResult => ({
      threadId: action.threadId,
      threadTitle: title,
      action: action.action,
      ok,
      message,
      state,
    });
    if (!current) return base(false, "The task no longer exists.", null);

    if (MUTATING_ACTIONS.has(action.action) && expectedState && current.state !== expectedState) {
      return base(false, `Task state changed from ${expectedState} to ${current.state} while the supervisor was deciding, so the stale action was not applied.`);
    }

    switch (action.action) {
      case "status": {
        const runs = this.host.db.listRuns(current.id);
        const latest = runs.at(-1);
        const detail = [
          `State: ${current.state}.`,
          `Updated ${ageText(current.updatedAt)}.`,
          latest ? `Latest run: ${latest.role} on ${latest.model} is ${latest.state}.` : "No agent run is recorded yet.",
          current.error ? `Current reason: ${clip(current.error, 360)}` : "",
        ].filter(Boolean).join(" ");
        return base(true, detail);
      }
      case "comment": {
        const message = action.message || "Supervisor asked that this task receive an owner-visible note.";
        this.host.postFinding({
          threadId: current.id,
          fromRole: "director",
          summary: `Supervisor chat: ${clip(message, 140)}`,
          detail: message.length > 140 ? message : null,
          severity: "note",
        });
        return base(true, "Added the note to the task's findings.");
      }
      case "escalate": {
        const message = action.message || "This task needs the owner's attention.";
        this.host.postFinding({
          threadId: current.id,
          fromRole: "director",
          summary: `Supervisor escalation: ${clip(message, 140)}`,
          detail: message.length > 140 ? message : null,
          severity: "warning",
        });
        return base(true, "Added an owner-visible escalation to the task.");
      }
      case "steer": {
        if (TERMINAL_STATES.has(current.state)) return base(false, `A ${current.state} task cannot receive steering. Restore or retry it deliberately from the task panel if needed.`);
        if (CAP_PARK_MARKER.test(current.error ?? "")) return base(false, "This task is capacity-parked and already owns an automatic resume; steering was not allowed to race that recovery.");
        if (!action.message) return base(false, "The supervisor did not provide an instruction to inject.");
        const result = await this.host.injectSupervisorInstruction(current.id, action.message, action.mode, { liveOnly: action.boardWide === true });
        return base(result.ok, resultText(result, `Sent the instruction through the task's ${action.mode} injection path.`), result.state ?? this.host.db.getThread(current.id)?.state ?? current.state);
      }
      case "pause": {
        if (current.state !== "implementing") return base(false, `Pause is only safe for a live implementing task; this task is ${current.state}.`);
        const result = await this.host.interruptThread(current.id);
        return base(result.ok, resultText(result, "Interrupted the implementor and left the task paused."), result.state ?? this.host.db.getThread(current.id)?.state ?? current.state);
      }
      case "resume": {
        if (!["paused", "review", "failed"].includes(current.state)) return base(false, `Resume applies to paused, review, or failed work; this task is ${current.state}.`);
        if (CAP_PARK_MARKER.test(current.error ?? "")) return base(false, "This task is already waiting for automatic capacity recovery, so a manual resume was not started beside it.");
        const nudge = action.message ? `Supervisor instruction from the owner: ${action.message}` : undefined;
        const result = await this.host.resumeThread(current.id, nudge, true);
        return base(result.ok, resultText(result, "Started the existing saved-session resume path."), result.state ?? this.host.db.getThread(current.id)?.state ?? current.state);
      }
      case "start_auto_review": {
        if (current.state !== "review" || CAP_PARK_MARKER.test(current.error ?? "")) return base(false, "Auto-review can start only from a normal review park, not this task's current state.");
        // Supervisor chat is an explicit authenticated owner instruction. Keep it distinct from the
        // unattended watchdog, whose one-attempt-per-revision convergence guard uses source=supervisor.
        const result = await this.host.autoReview(current.id, "owner");
        return base(result.ok, resultText(result, "Started the existing auto-reviewer; its verdict remains the only acceptance decision."), result.state ?? this.host.db.getThread(current.id)?.state ?? current.state);
      }
    }
  }
}
