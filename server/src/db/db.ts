import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { SCHEMA } from "./schema.js";
import { manualDeploymentSummary, parseManualDeployment, parseManualDeploymentClaim } from "../orchestrator/manualDeployment.js";
import {
  BACKFILL_CHUNK,
  FTS_CURSOR_KEY,
  FTS_READY_KEY,
  FTS_WRITE_TRIGGERS,
  trigramMatchExpr,
  type BackfillStep,
} from "./searchIndex.js";
import type {
  AgentRun,
  AgentRunState,
  AttachmentRef,
  AutoReviewEpisode,
  AutoReviewSource,
  ChatCursor,
  ChatMessage,
  ChatRoomSummary,
  ChatScope,
  CoworkMessage,
  CoworkMessageKind,
  CoworkMessageRole,
  CoworkSession,
  CoworkSteeringMode,
  CoworkTurn,
  CoworkTurnState,
  DirectorMessage,
  Effort,
  FileAttachment,
  Finding,
  FindingKind,
  ImplementorProvider,
  Message,
  ModelGrade,
  ModelOutcome,
  ModelRequest,
  ModelStat,
  ModelEffortStat,
  OperatorNote,
  Question,
  QuestionOption,
  ReviewerOutput,
  Role,
  ScheduledTask,
  Severity,
  ShotgunAssignment,
  StageOutputs,
  SupervisorAction,
  SupervisorChatActionResult,
  SupervisorChatStatus,
  SupervisorChatTarget,
  SupervisorChatTurn,
  SupervisorEvent,
  SupervisorEventKind,
  SupervisorTrigger,
  TaskSearchHit,
  Thread,
  ThreadLane,
  ThreadState,
  TokenUsage,
} from "../types.js";

export function newId(): string {
  return randomUUID();
}

const now = () => Date.now();

function coworkNameFromPrompt(prompt: string, fallback: string): string {
  const first = prompt.split(/\r?\n/, 1)[0]?.trim().replace(/\s+/g, " ") ?? "";
  if (!first) return fallback;
  return first.length > 72 ? `${first.slice(0, 69).trimEnd()}…` : first;
}

type Row = Record<string, unknown>;

function rowToTokenUsage(r: Row): TokenUsage | null {
  const values = [r.input_tokens, r.output_tokens, r.cache_read_input_tokens, r.cache_creation_input_tokens, r.reasoning_output_tokens, r.total_tokens];
  if (values.every((v) => v == null)) return null;
  return {
    inputTokens: Number(r.input_tokens ?? 0),
    outputTokens: Number(r.output_tokens ?? 0),
    cacheReadInputTokens: Number(r.cache_read_input_tokens ?? 0),
    cacheCreationInputTokens: Number(r.cache_creation_input_tokens ?? 0),
    reasoningOutputTokens: Number(r.reasoning_output_tokens ?? 0),
    totalTokens: Number(r.total_tokens ?? 0),
  };
}

function rowToThread(r: Row): Thread {
  return {
    id: r.id as string,
    title: r.title as string,
    state: r.state as ThreadState,
    workspace: r.workspace as string,
    brief: r.brief as string,
    rawPrompt: r.raw_prompt as string,
    error: (r.error as string | null) ?? null,
    effortOverride: (r.effort_override as Effort | null) ?? null,
    modelRequest: parseModelRequest(r.model_request),
    closedAt: (r.closed_at as number | null) ?? null,
    // The state a closed task came from: kept for restore, and surfaced so the UI can mark tasks that
    // finished correctly (closed_prev_state === 'done') with a checkmark. Null on never-closed rows.
    closedPrevState: (r.closed_prev_state as ThreadState | null) ?? null,
    // Dispatch lane: null = normal pipeline, 'read' = the read-only reader lane. A small scalar the UI
    // reads for the READ badge, so it belongs on the DTO (unlike the heavy stage_outputs blob).
    lane: (r.lane as ThreadLane | null) ?? null,
    // HEAD sha at dispatch — the baseline for task-scoped Changes attribution. Null on rows created
    // before this column existed / before dispatch set it.
    baselineHead: (r.baseline_head as string | null) ?? null,
    // Timed window (null on an ordinary task). Small scalars the card renders a live countdown from,
    // so they belong on the DTO — unlike the heavy stage_outputs blob that holds the round counters.
    durationMs: (r.duration_ms as number | null) ?? null,
    deadlineAt: (r.deadline_at as number | null) ?? null,
    activeDeadlineAt: (r.active_deadline_at as number | null) ?? null,
    // Shotgun: requested collaborator count, and — on a collaborator — its lead plus its owned share.
    agentCount: (r.agent_count as number | null) ?? null,
    parentId: (r.parent_id as string | null) ?? null,
    assignment: parseAssignment(r.assignment),
    manualDeployment: manualDeploymentSummary(parseStageOutputs(r.stage_outputs).manualDeployment),
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
}

function parseModelRequest(raw: unknown): ModelRequest | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<ModelRequest>;
    if (
      !value ||
      typeof value.requested !== "string" ||
      (value.provider !== null && value.provider !== "claude" && value.provider !== "codex" && value.provider !== "grok" && value.provider !== "zai") ||
      (value.model !== null && typeof value.model !== "string") ||
      value.strict !== true
    ) return null;
    return { requested: value.requested, provider: value.provider ?? null, model: value.model ?? null, strict: true };
  } catch {
    return null;
  }
}

/** A collaborator's persisted share. Tolerant by design: a row written by an older build, or a blob
 *  corrupted somehow, must degrade to "no assignment" (the thread then simply reads as an ordinary task)
 *  rather than throwing inside the mapper and taking every thread listing down with it. */
function parseAssignment(raw: unknown): ShotgunAssignment | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const v = JSON.parse(raw) as ShotgunAssignment;
    return v && typeof v === "object" && typeof v.objective === "string" ? { ...v, files: Array.isArray(v.files) ? v.files : [] } : null;
  } catch {
    return null;
  }
}

function rowToRun(r: Row): AgentRun {
  return {
    id: r.id as string,
    threadId: r.thread_id as string,
    role: r.role as Role,
    model: r.model as string,
    account: (r.account as string | null) ?? null,
    effort: (r.effort as Effort | null) ?? null,
    sessionId: (r.session_id as string | null) ?? null,
    state: r.state as AgentRunState,
    costUsd: (r.cost_usd as number | null) ?? null,
    numTurns: (r.num_turns as number | null) ?? null,
    tokenUsage: rowToTokenUsage(r),
    error: (r.error as string | null) ?? null,
    // Null (never written) is NOT "the runner saw no cap" — it's a row from before the flag existed.
    capFlagged: r.cap_flagged == null ? null : r.cap_flagged === 1,
    startedAt: r.started_at as number,
    endedAt: (r.ended_at as number | null) ?? null,
  };
}

function parseJsonOrNull(raw: unknown): unknown | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function rowToCoworkSession(r: Row): CoworkSession {
  return {
    id: r.id as string,
    name: r.name as string,
    autoNamed: r.auto_named === 1,
    workspace: r.workspace as string,
    state: r.state as CoworkSession["state"],
    requestedProvider: (r.requested_provider as CoworkSession["requestedProvider"]) ?? null,
    requestedModel: (r.requested_model as string | null) ?? null,
    provider: (r.provider as CoworkSession["provider"]) ?? null,
    model: (r.model as string | null) ?? null,
    effort: (r.effort as Effort | null) ?? null,
    account: (r.account as string | null) ?? null,
    agentSessionId: (r.agent_session_id as string | null) ?? null,
    activeTurnId: (r.active_turn_id as string | null) ?? null,
    error: (r.error as string | null) ?? null,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
}

function rowToCoworkTurn(r: Row): CoworkTurn {
  return {
    id: r.id as string,
    sessionId: r.session_id as string,
    state: r.state as CoworkTurn["state"],
    provider: (r.provider as CoworkTurn["provider"]) ?? null,
    model: (r.model as string | null) ?? null,
    effort: (r.effort as Effort | null) ?? null,
    account: (r.account as string | null) ?? null,
    agentSessionId: (r.agent_session_id as string | null) ?? null,
    error: (r.error as string | null) ?? null,
    costUsd: (r.cost_usd as number | null) ?? null,
    numTurns: (r.num_turns as number | null) ?? null,
    tokenUsage: rowToTokenUsage(r),
    startedAt: r.started_at as number,
    endedAt: (r.ended_at as number | null) ?? null,
  };
}

function rowToCoworkMessage(r: Row): CoworkMessage {
  const refs = parseAttachments(r.attachments);
  return {
    id: r.id as string,
    sessionId: r.session_id as string,
    turnId: (r.turn_id as string | null) ?? null,
    role: r.role as CoworkMessageRole,
    kind: r.kind as CoworkMessageKind,
    content: r.content as string,
    attachments: refs.length ? refs : undefined,
    meta: parseJsonOrNull(r.meta),
    partial: r.partial === 1,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
}

function rowToFinding(r: Row): Finding {
  return {
    id: r.id as string,
    threadId: r.thread_id as string,
    fromRunId: (r.from_run_id as string | null) ?? null,
    fromRole: (r.from_role as Role | null) ?? null,
    kind: ((r.kind as string | null) ?? "finding") as FindingKind,
    summary: r.summary as string,
    detail: (r.detail as string | null) ?? null,
    path: (r.path as string | null) ?? null,
    label: (r.label as string | null) ?? null,
    severity: r.severity as Severity,
    routed: Boolean(r.routed),
    createdAt: r.created_at as number,
  };
}

function rowToModelGrade(r: Row): ModelGrade {
  return {
    threadId: r.thread_id as string,
    workspace: r.workspace as string,
    title: r.title as string,
    provider: r.provider as ImplementorProvider,
    model: r.model as string,
    effort: r.effort as Effort,
    reason: r.reason as string,
    outcome: (r.outcome as ModelOutcome | null) ?? null,
    score: (r.score as number | null) ?? null,
    qaRounds: (r.qa_rounds as number | null) ?? null,
    costUsd: (r.cost_usd as number | null) ?? null,
    numTurns: (r.num_turns as number | null) ?? null,
    tokenUsage: rowToTokenUsage(r),
    tokenUsageComplete: r.token_usage_complete == null ? null : r.token_usage_complete === 1,
    durationMs: (r.duration_ms as number | null) ?? null,
    ranModels: (r.ran_models as string | null) ?? null,
    gradedModel: (r.graded_model as string | null) ?? null,
    createdAt: r.created_at as number,
    gradedAt: (r.graded_at as number | null) ?? null,
  };
}

function rowToQuestion(r: Row): Question {
  return {
    id: r.id as string,
    threadId: (r.thread_id as string | null) ?? null,
    runId: (r.run_id as string | null) ?? null,
    header: r.header as string,
    question: r.question as string,
    options: JSON.parse((r.options as string) || "[]") as QuestionOption[],
    multiSelect: Boolean(r.multi_select),
    answer: (r.answer as string | null) ?? null,
    answeredAt: (r.answered_at as number | null) ?? null,
    createdAt: r.created_at as number,
  };
}

function rowToScheduledTask(r: Row): ScheduledTask {
  return {
    id: r.id as string,
    title: r.title as string,
    workspace: r.workspace as string,
    prompt: r.prompt as string,
    cron: r.cron as string,
    enabled: Boolean(r.enabled),
    effort: (r.effort as Effort | null) ?? null,
    lastRunAt: (r.last_run_at as number | null) ?? null,
    nextRunAt: (r.next_run_at as number | null) ?? null,
    lastThreadId: (r.last_thread_id as string | null) ?? null,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
}

// The note list's ordering key, allocated in the same statement as the write so it can't race a
// concurrent post. `seq` is never exposed on the DTO — it exists only to make "newest" exact when a
// burst of notes shares one millisecond (see the schema comment).
const NEXT_NOTE_SEQ = "(SELECT IFNULL(MAX(seq), 0) + 1 FROM operator_notes)";

/** Who a note came from — set on insert and moved over on a refresh, so one row always names its
 *  current owner rather than whichever task happened to note the link first. */
type NoteSource = Pick<OperatorNote, "threadId" | "threadTitle" | "workspace" | "fromRole" | "fromName">;

function rowToOperatorNote(r: Row): OperatorNote {
  return {
    id: r.id as string,
    body: r.body as string,
    url: (r.url as string | null) ?? null,
    threadId: (r.thread_id as string | null) ?? null,
    threadTitle: (r.thread_title as string | null) ?? null,
    workspace: (r.workspace as string | null) ?? null,
    fromRole: (r.from_role as Role | null) ?? null,
    fromName: (r.from_name as string | null) ?? null,
    createdAt: r.created_at as number,
  };
}

function rowToSupervisorEvent(r: Row): SupervisorEvent {
  return {
    id: r.id as string,
    threadId: (r.thread_id as string | null) ?? null,
    threadTitle: (r.thread_title as string | null) ?? null,
    workspace: (r.workspace as string | null) ?? null,
    trigger: r.trigger as SupervisorTrigger,
    kind: r.kind as SupervisorEventKind,
    action: (r.action as SupervisorAction | null) ?? null,
    summary: r.summary as string,
    detail: (r.detail as string | null) ?? null,
    usedAgent: !!r.used_agent,
    costUsd: r.cost_usd == null ? null : Number(r.cost_usd),
    totalTokens: r.total_tokens == null ? null : Number(r.total_tokens),
    model: (r.model as string | null) ?? null,
    notifiedDiscord: !!r.notified_discord,
    createdAt: r.created_at as number,
  };
}

function parseReviewerVerdict(raw: unknown): ReviewerOutput | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<ReviewerOutput> | null;
    if (!value || typeof value.accept !== "boolean" || typeof value.summary !== "string") return null;
    const manualDeployment = parseManualDeploymentClaim(value.manualDeployment);
    return {
      accept: value.accept,
      summary: value.summary,
      ...(Array.isArray(value.issues) ? { issues: value.issues } : {}),
      ...(manualDeployment ? { manualDeployment } : {}),
    };
  } catch {
    return null;
  }
}

function rowToAutoReviewEpisode(r: Row): AutoReviewEpisode {
  return {
    threadId: r.thread_id as string,
    revision: r.revision as string,
    status: r.status as AutoReviewEpisode["status"],
    source: r.source as AutoReviewSource,
    claimToken: (r.claim_token as string | null) ?? null,
    attemptCount: Number(r.attempt_count),
    reason: (r.reason as string | null) ?? null,
    verdict: parseReviewerVerdict(r.verdict_json),
    verdictRunId: (r.verdict_run_id as string | null) ?? null,
    startedAt: Number(r.started_at),
    settledAt: r.settled_at == null ? null : Number(r.settled_at),
    updatedAt: Number(r.updated_at),
  };
}

function parseSupervisorTargets(raw: unknown): SupervisorChatTarget[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter((target): target is SupervisorChatTarget => {
      if (!target || typeof target !== "object") return false;
      const item = target as Record<string, unknown>;
      return typeof item.threadId === "string" && typeof item.title === "string";
    });
  } catch {
    return [];
  }
}

function parseSupervisorActionResults(raw: unknown): SupervisorChatActionResult[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter((result): result is SupervisorChatActionResult => {
      if (!result || typeof result !== "object") return false;
      const item = result as Record<string, unknown>;
      return (
        typeof item.threadId === "string" &&
        typeof item.threadTitle === "string" &&
        typeof item.action === "string" &&
        typeof item.ok === "boolean" &&
        typeof item.message === "string"
      );
    });
  } catch {
    return [];
  }
}

function rowToSupervisorChatTurn(r: Row): SupervisorChatTurn {
  return {
    id: r.id as string,
    content: r.content as string,
    targets: parseSupervisorTargets(r.targets),
    status: r.status as SupervisorChatStatus,
    response: (r.response as string | null) ?? null,
    actionResults: parseSupervisorActionResults(r.action_results),
    usedAgent: !!r.used_agent,
    costUsd: r.cost_usd == null ? null : Number(r.cost_usd),
    totalTokens: r.total_tokens == null ? null : Number(r.total_tokens),
    model: (r.model as string | null) ?? null,
    provider: (r.provider as ImplementorProvider | null) ?? null,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
}

function rowToChat(r: Row): ChatMessage {
  return {
    id: r.id as string,
    room: r.room as string,
    scope: r.scope as ChatScope,
    workspace: (r.workspace as string | null) ?? null,
    threadId: (r.thread_id as string | null) ?? null,
    runId: (r.run_id as string | null) ?? null,
    role: r.role as ChatMessage["role"],
    kind: r.kind as ChatMessage["kind"],
    body: r.body as string,
    senderName: (r.sender_name as string | null) ?? null,
    remoteInstance: (r.remote_instance as string | null) ?? null,
    createdAt: r.created_at as number,
  };
}

function rowToMessage(r: Row): Message {
  const refs = parseAttachments(r.attachments);
  return {
    id: r.id as string,
    threadId: r.thread_id as string,
    runId: (r.run_id as string | null) ?? null,
    role: r.role as Message["role"],
    kind: r.kind as Message["kind"],
    content: r.content as string,
    attachments: refs.length ? refs : undefined,
    createdAt: r.created_at as number,
  };
}

function rowToDirectorMessage(r: Row): DirectorMessage {
  const refs = parseAttachments(r.attachments);
  return {
    id: r.id as string,
    role: r.role as DirectorMessage["role"],
    kind: r.kind as DirectorMessage["kind"],
    content: r.content as string,
    attachments: refs.length ? refs : undefined,
    threadId: (r.thread_id as string | null) ?? null,
    createdAt: r.created_at as number,
  };
}

// Escape the LIKE wildcards in a user query so a literal % or _ matches itself, not "any run of
// chars". Paired with `ESCAPE '\'` on the statement. Backslash is escaped first so it can't
// double-escape a following wildcard.
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => "\\" + c);
}

const containsFold = (text: string, q: string): boolean => text.toLowerCase().includes(q.toLowerCase());

/** One task's conversation match: how many messages matched, and the rowid of the one to quote. */
interface ConversationHit {
  hits: number;
  bestRowid: number;
}

interface RankedTask {
  thread: Thread;
  hit: ConversationHit | null;
  metadata: boolean;
}

/** How one search reaches the tasks' conversations: the trigram index, the full scan it replaced
 *  (only while that index is still being built), or not at all — see `Db.conversationPlan`. */
type ConversationPlan = { via: "index"; match: string } | { via: "scan" } | { via: "none" };

/** Strongest match first: a task whose own title or brief says the word is what the search is about,
 *  then whichever worked the term hardest, then the recent. Recency alone buries the answer — the task
 *  that actually did the work names the thing hundreds of times and is usually far older than the log
 *  dumps and office chatter that mention it once. */
function byRelevance(a: RankedTask, b: RankedTask): number {
  if (a.metadata !== b.metadata) return a.metadata ? -1 : 1;
  const [ah, bh] = [a.hit?.hits ?? 0, b.hit?.hits ?? 0];
  if (ah !== bh) return bh - ah;
  return b.thread.createdAt - a.thread.createdAt;
}

// A readable window of `text` around its first match of `q`. Cut here rather than in the browser
// because the matched row is often a `result` message holding megabytes of tool output, which must
// never reach the socket; runs of whitespace collapse so a slice of a console dump still reads as one
// line in a narrow rail. The match itself is left intact — the client re-finds it to highlight it.
function snippetAround(text: string, q: string, before = 90, after = 240): string {
  const at = text.toLowerCase().indexOf(q.toLowerCase());
  const anchor = at < 0 ? 0 : at;
  const start = Math.max(0, anchor - before);
  const end = Math.min(text.length, anchor + q.length + after);
  const slice = text.slice(start, end).replace(/\s+/g, " ").trim();
  return (start > 0 ? "…" : "") + slice + (end < text.length ? "…" : "");
}

/** Every table whose `attachments` JSON column can hold a reference to a stored blob. */
const REF_TABLES = ["messages", "director_messages", "cowork_messages"] as const;

/** A row that references a blob, addressed by primary key so a rewrite doesn't scan the table. */
interface RefRow {
  table: (typeof REF_TABLES)[number];
  id: string;
}

export type AutoReviewClaimResult =
  | { ok: true; thread: Thread; episode: AutoReviewEpisode; claimToken: string }
  | { ok: false; thread: Thread | null; reason: string };

export type AutoReviewFinishResult =
  | { ok: true; thread: Thread; episode: AutoReviewEpisode }
  | { ok: false; thread: Thread | null; reason: string };

export class Db {
  readonly raw: Database.Database;

  /** Latched once the trigram index covers every message; only ever flips false->true. */
  private ftsReady = false;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.raw = new Database(path);
    this.raw.pragma("journal_mode = WAL");
    // Enforce ON DELETE CASCADE for thread children. The pragma is connection-scoped and
    // off by default in SQLite, so assert it here (not just in SCHEMA) — deleteThread relies on it.
    this.raw.pragma("foreign_keys = ON");
    this.raw.exec(SCHEMA);
    this.migrate();
  }

  private migrate(): void {
    // Add columns introduced after a DB may already exist. Duplicate-column
    // errors are expected on an up-to-date DB and ignored.
    for (const stmt of [
      "ALTER TABLE agent_runs ADD COLUMN account TEXT",
      "ALTER TABLE agent_runs ADD COLUMN effort TEXT",
      "ALTER TABLE director_messages ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'",
      "ALTER TABLE messages ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'",
      "ALTER TABLE cowork_messages ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'",
      "ALTER TABLE threads ADD COLUMN stage_outputs TEXT",
      "ALTER TABLE threads ADD COLUMN effort_override TEXT",
      "ALTER TABLE threads ADD COLUMN model_request TEXT",
      "ALTER TABLE threads ADD COLUMN closed_at INTEGER",
      "ALTER TABLE threads ADD COLUMN closed_prev_state TEXT",
      "ALTER TABLE threads ADD COLUMN baseline_head TEXT",
      "ALTER TABLE threads ADD COLUMN duration_ms INTEGER",
      "ALTER TABLE threads ADD COLUMN deadline_at INTEGER",
      "ALTER TABLE threads ADD COLUMN active_deadline_at INTEGER",
      "ALTER TABLE threads ADD COLUMN agent_count INTEGER",
      "ALTER TABLE threads ADD COLUMN parent_id TEXT",
      "ALTER TABLE threads ADD COLUMN assignment TEXT",
      "ALTER TABLE chat_messages ADD COLUMN sender_name TEXT",
      "ALTER TABLE findings ADD COLUMN kind TEXT NOT NULL DEFAULT 'finding'",
      "ALTER TABLE findings ADD COLUMN path TEXT",
      "ALTER TABLE findings ADD COLUMN label TEXT",
      "ALTER TABLE director_messages ADD COLUMN thread_id TEXT",
      "ALTER TABLE threads ADD COLUMN lane TEXT",
      "ALTER TABLE attachments ADD COLUMN sha256 TEXT",
      "ALTER TABLE agent_runs ADD COLUMN cap_flagged INTEGER",
      "ALTER TABLE agent_runs ADD COLUMN input_tokens INTEGER",
      "ALTER TABLE agent_runs ADD COLUMN output_tokens INTEGER",
      "ALTER TABLE agent_runs ADD COLUMN cache_read_input_tokens INTEGER",
      "ALTER TABLE agent_runs ADD COLUMN cache_creation_input_tokens INTEGER",
      "ALTER TABLE agent_runs ADD COLUMN reasoning_output_tokens INTEGER",
      "ALTER TABLE agent_runs ADD COLUMN total_tokens INTEGER",
      "ALTER TABLE model_grades ADD COLUMN input_tokens INTEGER",
      "ALTER TABLE model_grades ADD COLUMN output_tokens INTEGER",
      "ALTER TABLE model_grades ADD COLUMN cache_read_input_tokens INTEGER",
      "ALTER TABLE model_grades ADD COLUMN cache_creation_input_tokens INTEGER",
      "ALTER TABLE model_grades ADD COLUMN reasoning_output_tokens INTEGER",
      "ALTER TABLE model_grades ADD COLUMN total_tokens INTEGER",
      "ALTER TABLE model_grades ADD COLUMN token_usage_complete INTEGER",
      "ALTER TABLE chat_messages ADD COLUMN remote_instance TEXT",
    ]) {
      try {
        this.raw.exec(stmt);
      } catch {
        /* column already present */
      }
    }
    // After the ALTER, never in SCHEMA: on a pre-sha256 DB the column doesn't exist yet when
    // SCHEMA runs, and exec(SCHEMA) is unguarded — the failed index would abort boot.
    this.raw.exec("CREATE INDEX IF NOT EXISTS idx_attachments_content ON attachments(sha256, name, media_type)");
    this.backfillDirectorThreadLinks();
    this.backfillRemoteChatInstances();
    this.dedupeAttachmentBlobs();
    this.backfillAutoReviewEpisodes();
    this.repairAutoReviewBackfillFreshWork();
  }

  /** One-time repair for tasks created before durable reviewer ownership existed. A historical reviewer
   * run on an owner-visible `review` row is sufficient evidence to PARK unattended automation; it is
   * never sufficient evidence to mark work done. A reviewer/fix still live at the deployment boundary is
   * imported as running so boot reconciliation consumes its synthetic token and parks it safely. Accepted
   * historical tasks are already `done` and remain untouched. */
  private backfillAutoReviewEpisodes(): void {
    if (this.kvGet("auto_review_episode_backfill_v1")) return;
    this.raw.transaction(() => {
      const rows = this.raw
        .prepare(
          `SELECT t.id, t.state, t.error, t.stage_outputs, t.updated_at,
                  (SELECT COUNT(*) FROM agent_runs rr WHERE rr.thread_id=t.id AND rr.role='reviewer') attempts,
                  (SELECT rr.id FROM agent_runs rr WHERE rr.thread_id=t.id AND rr.role='reviewer'
                    ORDER BY rr.started_at DESC, rr.rowid DESC LIMIT 1) reviewer_run_id,
                  (SELECT rr.started_at FROM agent_runs rr WHERE rr.thread_id=t.id AND rr.role='reviewer'
                    ORDER BY rr.started_at DESC, rr.rowid DESC LIMIT 1) reviewer_started_at,
                  (SELECT rr.rowid FROM agent_runs rr WHERE rr.thread_id=t.id AND rr.role='reviewer'
                    ORDER BY rr.started_at DESC, rr.rowid DESC LIMIT 1) reviewer_rowid,
                  (SELECT wr.started_at FROM agent_runs wr WHERE wr.thread_id=t.id AND wr.role<>'reviewer'
                    ORDER BY wr.started_at DESC, wr.rowid DESC LIMIT 1) work_started_at,
                  (SELECT wr.rowid FROM agent_runs wr WHERE wr.thread_id=t.id AND wr.role<>'reviewer'
                    ORDER BY wr.started_at DESC, wr.rowid DESC LIMIT 1) work_rowid,
                  EXISTS (SELECT 1 FROM agent_runs rr
                           WHERE rr.thread_id=t.id AND rr.role='reviewer'
                             AND rr.state IN ('starting','running','idle') AND rr.ended_at IS NULL) active_reviewer
             FROM threads t
            WHERE EXISTS (SELECT 1 FROM agent_runs rr WHERE rr.thread_id=t.id AND rr.role='reviewer')`,
        )
        .all() as Array<Row>;
      const insert = this.raw.prepare(
        `INSERT OR IGNORE INTO auto_review_episodes
           (thread_id, revision, status, source, claim_token, attempt_count, reason, verdict_json,
            verdict_run_id, started_at, settled_at, updated_at)
         VALUES (@threadId, @revision, @status, 'reconciled', @claimToken, @attemptCount, @reason, NULL,
                 @verdictRunId, @startedAt, @settledAt, @updatedAt)`,
      );
      for (const row of rows) {
        const threadId = String(row.id);
        const state = String(row.state);
        const fixing = parseStageOutputs(row.stage_outputs).reviewFixing === true;
        const active = state === "reviewing" || fixing || (state === "awaiting_user" && Number(row.active_reviewer) === 1);
        if (state !== "review" && !active) continue;
        const workStartedAt = row.work_started_at == null ? null : Number(row.work_started_at);
        const reviewerStartedAt = Number(row.reviewer_started_at ?? 0);
        const reviewerCoversCurrentRevision =
          workStartedAt == null ||
          reviewerStartedAt > workStartedAt ||
          (reviewerStartedAt === workStartedAt && Number(row.reviewer_rowid ?? 0) > Number(row.work_rowid ?? 0));
        if (state === "review" && !active && !reviewerCoversCurrentRevision) continue;
        const settledAt = Number(row.updated_at);
        insert.run({
          threadId,
          revision: this.autoReviewRevision(threadId) ?? `thread:${threadId}`,
          status: active ? "running" : "parked",
          claimToken: active ? randomUUID() : null,
          attemptCount: Math.max(1, Number(row.attempts ?? 1)),
          reason: active
            ? "Legacy auto-review was active when durable ownership was installed; boot reconciliation will park it safely."
            : String(row.error ?? "A prior auto-review recorded no durable accepted verdict; this unchanged task remains parked for owner review."),
          verdictRunId: (row.reviewer_run_id as string | null) ?? null,
          startedAt: Number(row.reviewer_started_at ?? settledAt),
          settledAt: active ? null : settledAt,
          updatedAt: settledAt,
        });
      }
      this.kvSet("auto_review_episode_backfill_v1", String(now()));
    })();
  }

  /** Repair the first deployment's conservative legacy import if it already ran before the run-order
   * guard above existed. Those stale rows are safe to delete only when the row came from reconciliation,
   * the task is still parked in review, and the recorded reviewer run predates the work run whose revision
   * would otherwise be suppressed. Real owner/supervisor outcomes are left untouched. */
  private repairAutoReviewBackfillFreshWork(): void {
    if (this.kvGet("auto_review_episode_backfill_v2")) return;
    this.raw.transaction(() => {
      this.raw
        .prepare(
          `DELETE FROM auto_review_episodes
            WHERE source='reconciled'
              AND status='parked'
              AND claim_token IS NULL
              AND verdict_run_id IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM threads t
                 WHERE t.id=auto_review_episodes.thread_id
                   AND t.state='review'
              )
              AND EXISTS (
                SELECT 1
                  FROM agent_runs work
                  JOIN agent_runs reviewer ON reviewer.id=auto_review_episodes.verdict_run_id
                 WHERE work.thread_id=auto_review_episodes.thread_id
                   AND work.role<>'reviewer'
                   AND ('run:' || work.id)=auto_review_episodes.revision
                   AND (
                     reviewer.started_at < work.started_at
                     OR (reviewer.started_at=work.started_at AND reviewer.rowid < work.rowid)
                   )
              )`,
        )
        .run();
      this.kvSet("auto_review_episode_backfill_v2", String(now()));
    })();
  }

  /**
   * One-time: recover which machine each pre-existing cross-machine line came from. Before
   * `remote_instance` existed the machine was recorded only inside `sender_name` ("Sif @ remote workstation"),
   * so every room whose conversation predates the column reads as having no remote participant — and
   * stays hidden behind a chatroom tab that never appears, which is the whole defect the column fixes.
   *
   * Rows whose machine is THIS instance are deliberately skipped. They are the self-echo the relay used
   * to hand back, and counting them would rebuild the phantom teammate the echo fix just removed: a repo
   * only ever worked here would start reading as a cross-machine collaboration.
   */
  private backfillRemoteChatInstances(): void {
    if (this.kvGet("remote_instance_backfill_v1")) return;
    const self = this.kvGet("online_office_name") ?? "";
    this.raw.transaction(() => {
      this.raw
        .prepare(
          `UPDATE chat_messages
              SET remote_instance = substr(sender_name, instr(sender_name, ' @ ') + 3)
            WHERE scope = 'project' AND kind = 'chat'
              AND thread_id IS NULL AND remote_instance IS NULL
              AND instr(sender_name, ' @ ') > 0
              AND substr(sender_name, instr(sender_name, ' @ ') + 3) <> @self`,
        )
        .run({ self });
      this.kvSet("remote_instance_backfill_v1", String(now()));
    })();
  }

  // One-time: attribute each pre-existing director message to the task its turn dispatched, so the
  // search's "go to task" jump works for history recorded before message→task links existed. New messages
  // are linked exactly at dispatch time (Director), so this only backfills the past. The rule is
  // ROLE-AWARE, because a prompt and a note sit on opposite sides of the dispatch — and it only links
  // when it's CONFIDENT, leaving everything else null (no chip) rather than inventing a wrong jump target:
  //   - a USER prompt reliably precedes its dispatch → the FIRST task created at/after it.
  //   - a DIRECTOR note is only confidently a DISPATCH CONFIRMATION when a task was created in the short
  //     window just BEFORE it (the "dispatched X" note is written right after api.dispatch returns) → link
  //     to that task. Enrichment replies, clarifying questions and error notices have no task in that
  //     window → they stay null. (This is the fix for the v1 bug, where a single at/after rule sent every
  //     confirmation to the FOLLOWING task, and an unguarded nearest-task rule mislinked every non-dispatch
  //     director note to a neighbouring task.)
  // It recomputes EVERY row (not just nulls) because v1 already wrote wrong links into existing DBs that
  // must be corrected; the corrected director rule only ever yields the confirmation's own task or null,
  // so it can't produce a wrong jump target. The v2 flag guards against re-running.
  private backfillDirectorThreadLinks(): void {
    if (this.kvGet("director_thread_backfill_v2")) return;
    const CONFIRMATION_WINDOW_MS = 15000;
    this.raw
      .prepare(
        `UPDATE director_messages
         SET thread_id = CASE director_messages.role
           WHEN 'user' THEN (
             SELECT t.id FROM threads t
             WHERE t.created_at >= director_messages.created_at
             ORDER BY t.created_at ASC LIMIT 1
           )
           ELSE (
             SELECT t.id FROM threads t
             WHERE t.created_at <= director_messages.created_at
               AND director_messages.created_at - t.created_at <= ?
             ORDER BY t.created_at DESC LIMIT 1
           )
         END`,
      )
      .run(CONFIRMATION_WINDOW_MS);
    this.kvSet("director_thread_backfill_v2", "1");
  }

  // One-time: collapse byte-identical attachment blobs onto one row, then drop whatever nothing points
  // at any more. Until addAttachment content-addressed them, an image dropped into the director was
  // stored TWICE — once for the director message, once again when the dispatch copied it onto the task's
  // own message — so a mature DB carries roughly a copy per reference (75 MB of 183 MB when this shipped).
  // Every reference is rewritten to the surviving id, so nothing the console can open changes; only the
  // redundant bytes go. Transactional: a failure part-way leaves the old rows untouched.
  private dedupeAttachmentBlobs(): void {
    if (this.kvGet("attachment_dedupe_v1")) return;
    this.raw.transaction(() => {
      this.backfillAttachmentHashes();
      const holders = this.attachmentReferenceIndex();
      for (const ids of this.duplicateAttachmentGroups()) this.collapseAttachmentGroup(ids, holders);
      this.pruneAttachments(this.allAttachmentIds());
    })();
    this.kvSet("attachment_dedupe_v1", "1");
  }

  /** Hash the rows that predate the sha256 column, one at a time — the blobs are ~0.5 MB each, so
   *  selecting them all at once would hold the whole table in memory. */
  private backfillAttachmentHashes(): void {
    const ids = (this.raw.prepare("SELECT id FROM attachments WHERE sha256 IS NULL").all() as Row[]).map(
      (r) => r.id as string,
    );
    const read = this.raw.prepare("SELECT data FROM attachments WHERE id = ?");
    const write = this.raw.prepare("UPDATE attachments SET sha256 = ? WHERE id = ?");
    for (const id of ids) {
      const row = read.get(id) as Row | undefined;
      if (row) write.run(sha256Of(row.data as string), id);
    }
  }

  /** Ids of every set of rows holding identical content. Members are byte-identical and carry the same
   *  name/type, so any one of them can be the keeper; the ordering just favours preserving the original. */
  private duplicateAttachmentGroups(): string[][] {
    const rows = this.raw
      .prepare(
        `SELECT group_concat(id) ids FROM (SELECT id, sha256, name, media_type FROM attachments ORDER BY created_at ASC)
         GROUP BY sha256, name, media_type HAVING COUNT(*) > 1`,
      )
      .all() as Row[];
    return rows.map((r) => String(r.ids).split(","));
  }

  /** Which rows reference each blob, from ONE pass per table. Matching by `LIKE '%id%'` per duplicate
   *  instead re-reads all ~200k messages for each one, which turned this into a 13s boot on a mature DB. */
  private attachmentReferenceIndex(): Map<string, RefRow[]> {
    const index = new Map<string, RefRow[]>();
    for (const table of REF_TABLES) {
      for (const r of this.raw.prepare(`SELECT id, attachments FROM ${table} WHERE attachments != '[]'`).all() as Row[]) {
        for (const ref of parseAttachments(r.attachments)) {
          const rows = index.get(ref.id) ?? [];
          rows.push({ table, id: r.id as string });
          index.set(ref.id, rows);
        }
      }
    }
    return index;
  }

  /** Point every reference at the first id, then delete the rows that gave up their bytes. */
  private collapseAttachmentGroup([keep, ...redundant]: string[], holders: Map<string, RefRow[]>): void {
    const drop = this.raw.prepare("DELETE FROM attachments WHERE id = ?");
    const rewrite = Object.fromEntries(
      REF_TABLES.map((t) => [t, this.raw.prepare(`UPDATE ${t} SET attachments = replace(attachments, ?, ?) WHERE id = ?`)]),
    );
    for (const id of redundant) {
      for (const row of holders.get(id) ?? []) rewrite[row.table]?.run(id, keep, row.id);
      drop.run(id);
    }
  }

  private allAttachmentIds(): string[] {
    return (this.raw.prepare("SELECT id FROM attachments").all() as Row[]).map((r) => r.id as string);
  }

  // ---- kv ----
  kvGet(key: string): string | null {
    const r = this.raw.prepare("SELECT value FROM kv WHERE key = ?").get(key) as Row | undefined;
    return r ? (r.value as string) : null;
  }
  kvSet(key: string, value: string): void {
    this.raw
      .prepare("INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  // ---- Co-work sessions ----

  createCoworkSession(input: {
    name: string;
    autoNamed: boolean;
    workspace: string;
    requestedProvider?: CoworkSession["requestedProvider"];
    requestedModel?: string | null;
  }): CoworkSession {
    const at = now();
    const session: CoworkSession = {
      id: newId(),
      name: input.name,
      autoNamed: input.autoNamed,
      workspace: input.workspace,
      state: "idle",
      requestedProvider: input.requestedProvider ?? null,
      requestedModel: input.requestedModel ?? null,
      provider: null,
      model: null,
      effort: null,
      account: null,
      agentSessionId: null,
      activeTurnId: null,
      error: null,
      createdAt: at,
      updatedAt: at,
    };
    this.raw.prepare(
      `INSERT INTO cowork_sessions
         (id, name, auto_named, workspace, state, requested_provider, requested_model, provider, model,
          effort, account, agent_session_id, active_turn_id, error, created_at, updated_at)
       VALUES
         (@id, @name, @autoNamed, @workspace, @state, @requestedProvider, @requestedModel, @provider, @model,
          @effort, @account, @agentSessionId, @activeTurnId, @error, @createdAt, @updatedAt)`,
    ).run({ ...session, autoNamed: session.autoNamed ? 1 : 0 });
    return session;
  }

  getCoworkSession(id: string): CoworkSession | null {
    const row = this.raw.prepare("SELECT * FROM cowork_sessions WHERE id = ?").get(id) as Row | undefined;
    return row ? rowToCoworkSession(row) : null;
  }

  listCoworkSessions(): CoworkSession[] {
    return (this.raw.prepare("SELECT * FROM cowork_sessions ORDER BY updated_at DESC, created_at DESC").all() as Row[]).map(rowToCoworkSession);
  }

  listCoworkTurns(sessionId: string): CoworkTurn[] {
    return (this.raw.prepare("SELECT * FROM cowork_turns WHERE session_id = ? ORDER BY started_at ASC, rowid ASC").all(sessionId) as Row[]).map(rowToCoworkTurn);
  }

  getCoworkTurn(id: string): CoworkTurn | null {
    const row = this.raw.prepare("SELECT * FROM cowork_turns WHERE id = ?").get(id) as Row | undefined;
    return row ? rowToCoworkTurn(row) : null;
  }

  listCoworkMessages(sessionId: string): CoworkMessage[] {
    return (this.raw.prepare("SELECT * FROM cowork_messages WHERE session_id = ? ORDER BY created_at ASC, rowid ASC").all(sessionId) as Row[]).map(rowToCoworkMessage);
  }

  /** Atomically claim the session and persist the owner prompt. There is no await in this transaction,
   * so two sockets sending together cannot create two live agent turns for one conversation. */
  beginCoworkTurn(sessionId: string, content: string, messageId = newId(), attachments: FileAttachment[] = []):
    | { ok: true; session: CoworkSession; turn: CoworkTurn; message: CoworkMessage }
    | { ok: false; error: string; session: CoworkSession | null } {
    return this.raw.transaction(() => {
      const current = this.getCoworkSession(sessionId);
      if (!current) return { ok: false as const, error: "Co-work session not found.", session: null };
      if (current.activeTurnId || current.state === "running" || current.state === "stopping") {
        return { ok: false as const, error: current.state === "stopping" ? "This turn is still stopping." : "A Co-worker turn is already running.", session: current };
      }
      if (this.raw.prepare("SELECT 1 FROM cowork_messages WHERE id = ?").get(messageId)) {
        return { ok: false as const, error: "This prompt was already received.", session: current };
      }

      const at = now();
      const turnId = newId();
      const nextName = current.autoNamed ? coworkNameFromPrompt(content, current.name) : current.name;
      const claimed = this.raw.prepare(
        `UPDATE cowork_sessions
            SET state='running', active_turn_id=@turnId, error=NULL, name=@name,
                auto_named=CASE WHEN auto_named=1 THEN 0 ELSE auto_named END, updated_at=@at
          WHERE id=@sessionId AND active_turn_id IS NULL AND state IN ('idle','error')`,
      ).run({ sessionId, turnId, name: nextName, at });
      if (claimed.changes !== 1) {
        return { ok: false as const, error: "A Co-worker turn is already running.", session: this.getCoworkSession(sessionId) };
      }

      this.raw.prepare(
        `INSERT INTO cowork_turns
           (id, session_id, state, provider, model, effort, account, agent_session_id, error,
            cost_usd, num_turns, started_at, ended_at)
         VALUES (?, ?, 'running', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, NULL)`,
      ).run(turnId, sessionId, at);
      this.raw.prepare(
        `INSERT INTO cowork_messages
           (id, session_id, turn_id, role, kind, content, attachments, meta, partial, created_at, updated_at)
         VALUES (?, ?, ?, 'user', 'text', ?, ?, NULL, 0, ?, ?)`,
      ).run(
        messageId,
        sessionId,
        turnId,
        content,
        JSON.stringify(attachments.map((file) => this.addAttachment({ name: file.name, mediaType: file.mediaType, data: file.dataBase64 }))),
        at,
        at,
      );

      const messageRow = this.raw.prepare("SELECT * FROM cowork_messages WHERE id = ?").get(messageId) as Row | undefined;
      if (!messageRow) throw new Error("Co-work message insert failed");
      return {
        ok: true as const,
        session: this.getCoworkSession(sessionId)!,
        turn: this.getCoworkTurn(turnId)!,
        message: rowToCoworkMessage(messageRow),
      };
    })();
  }

  /** Persist a live owner update against the exact active turn before it is sent to the provider.
   * The active_turn_id predicate is the same stale-callback fence used by finishCoworkTurn: a message
   * can never leak into a later turn if completion races the WebSocket command. */
  appendCoworkSteering(input: {
    sessionId: string;
    turnId: string;
    content: string;
    mode: CoworkSteeringMode;
    messageId?: string;
    attachments?: FileAttachment[];
  }):
    | { ok: true; session: CoworkSession; message: CoworkMessage }
    | { ok: false; error: string; session: CoworkSession | null } {
    return this.raw.transaction(() => {
      const current = this.getCoworkSession(input.sessionId);
      if (!current) return { ok: false as const, error: "Co-work session not found.", session: null };
      if (current.activeTurnId !== input.turnId || current.state !== "running") {
        return {
          ok: false as const,
          error: current.state === "stopping" ? "This turn is already stopping." : "The active Co-worker turn already finished.",
          session: current,
        };
      }
      const messageId = input.messageId ?? newId();
      if (this.raw.prepare("SELECT 1 FROM cowork_messages WHERE id = ?").get(messageId)) {
        return { ok: false as const, error: "This direction was already received.", session: current };
      }
      const at = now();
      const attachments = (input.attachments ?? []).map((file) =>
        this.addAttachment({ name: file.name, mediaType: file.mediaType, data: file.dataBase64 }),
      );
      this.raw.prepare(
        `INSERT INTO cowork_messages
           (id, session_id, turn_id, role, kind, content, attachments, meta, partial, created_at, updated_at)
         VALUES (?, ?, ?, 'user', 'text', ?, ?, ?, 0, ?, ?)`,
      ).run(
        messageId,
        input.sessionId,
        input.turnId,
        input.content,
        JSON.stringify(attachments),
        JSON.stringify({ steeringMode: input.mode, delivery: "pending" }),
        at,
        at,
      );
      this.raw.prepare(
        "UPDATE cowork_sessions SET updated_at=? WHERE id=? AND active_turn_id=? AND state='running'",
      ).run(at, input.sessionId, input.turnId);
      const row = this.raw.prepare("SELECT * FROM cowork_messages WHERE id=?").get(messageId) as Row | undefined;
      if (!row) throw new Error("Co-work steering message insert failed");
      return { ok: true as const, session: this.getCoworkSession(input.sessionId)!, message: rowToCoworkMessage(row) };
    })();
  }

  /** Persist the concrete target before the process starts. Both Auto and explicit selection become
   * sticky here; later turns must request this exact provider/model instead of silently substituting. */
  setCoworkTurnTarget(input: {
    sessionId: string;
    turnId: string;
    provider: NonNullable<CoworkSession["provider"]>;
    model: string;
    effort: Effort;
    account: string | null;
  }): CoworkSession | null {
    const at = now();
    const changed = this.raw.transaction(() => {
      const sessionUpdate = this.raw.prepare(
        `UPDATE cowork_sessions
            SET provider=@provider, model=@model, effort=@effort, account=@account, updated_at=@at
          WHERE id=@sessionId AND active_turn_id=@turnId`,
      ).run({ ...input, at });
      if (sessionUpdate.changes !== 1) return false;
      this.raw.prepare(
        `UPDATE cowork_turns
            SET provider=@provider, model=@model, effort=@effort, account=@account
          WHERE id=@turnId AND session_id=@sessionId AND state='running'`,
      ).run(input);
      return true;
    })();
    return changed ? this.getCoworkSession(input.sessionId) : null;
  }

  setCoworkStopping(sessionId: string, turnId: string): CoworkSession | null {
    const result = this.raw.prepare(
      "UPDATE cowork_sessions SET state='stopping', updated_at=? WHERE id=? AND active_turn_id=? AND state='running'",
    ).run(now(), sessionId, turnId);
    return result.changes ? this.getCoworkSession(sessionId) : null;
  }

  setCoworkAgentSession(sessionId: string, turnId: string, agentSessionId: string): CoworkSession | null {
    this.raw.transaction(() => {
      this.raw.prepare(
        "UPDATE cowork_sessions SET agent_session_id=?, updated_at=? WHERE id=? AND active_turn_id=?",
      ).run(agentSessionId, now(), sessionId, turnId);
      this.raw.prepare(
        "UPDATE cowork_turns SET agent_session_id=? WHERE id=? AND session_id=? AND state='running'",
      ).run(agentSessionId, turnId, sessionId);
    })();
    return this.getCoworkSession(sessionId);
  }

  upsertCoworkMessage(input: {
    id?: string;
    sessionId: string;
    turnId?: string | null;
    role: CoworkMessageRole;
    kind: CoworkMessageKind;
    content: string;
    attachments?: AttachmentRef[];
    meta?: unknown | null;
    partial?: boolean;
    createdAt?: number;
  }): CoworkMessage {
    const id = input.id ?? newId();
    const at = input.createdAt ?? now();
    const meta = input.meta == null ? null : JSON.stringify(input.meta);
    const attachments = JSON.stringify(input.attachments ?? []);
    this.raw.prepare(
      `INSERT INTO cowork_messages
         (id, session_id, turn_id, role, kind, content, attachments, meta, partial, created_at, updated_at)
       VALUES (@id, @sessionId, @turnId, @role, @kind, @content, @attachments, @meta, @partial, @at, @at)
       ON CONFLICT(id) DO UPDATE SET
         content=excluded.content,
         attachments=CASE WHEN @replaceAttachments=1 THEN excluded.attachments ELSE cowork_messages.attachments END,
         meta=excluded.meta, partial=excluded.partial, updated_at=excluded.updated_at`,
    ).run({
      id,
      sessionId: input.sessionId,
      turnId: input.turnId ?? null,
      role: input.role,
      kind: input.kind,
      content: input.content,
      attachments,
      replaceAttachments: input.attachments === undefined ? 0 : 1,
      meta,
      partial: input.partial ? 1 : 0,
      at,
    });
    return rowToCoworkMessage(this.raw.prepare("SELECT * FROM cowork_messages WHERE id = ?").get(id) as Row);
  }

  finishCoworkTurn(input: {
    sessionId: string;
    turnId: string;
    state: CoworkTurnState;
    error?: string | null;
    agentSessionId?: string | null;
    costUsd?: number | null;
    numTurns?: number | null;
    tokenUsage?: TokenUsage | null;
  }): CoworkSession | null {
    const at = now();
    const sessionState: CoworkSession["state"] = input.state === "error" || input.state === "interrupted" ? "error" : "idle";
    const usage = input.tokenUsage;
    this.raw.transaction(() => {
      this.raw.prepare(
        `UPDATE cowork_turns SET
           state=@state, error=@error, agent_session_id=COALESCE(@agentSessionId, agent_session_id),
           cost_usd=@costUsd, num_turns=@numTurns,
           input_tokens=@inputTokens, output_tokens=@outputTokens,
           cache_read_input_tokens=@cacheReadInputTokens,
           cache_creation_input_tokens=@cacheCreationInputTokens,
           reasoning_output_tokens=@reasoningOutputTokens, total_tokens=@totalTokens,
           ended_at=@at
         WHERE id=@turnId AND session_id=@sessionId AND state='running'`,
      ).run({
        ...input,
        error: input.error ?? null,
        agentSessionId: input.agentSessionId ?? null,
        costUsd: input.costUsd ?? null,
        numTurns: input.numTurns ?? null,
        inputTokens: usage?.inputTokens ?? null,
        outputTokens: usage?.outputTokens ?? null,
        cacheReadInputTokens: usage?.cacheReadInputTokens ?? null,
        cacheCreationInputTokens: usage?.cacheCreationInputTokens ?? null,
        reasoningOutputTokens: usage?.reasoningOutputTokens ?? null,
        totalTokens: usage?.totalTokens ?? null,
        at,
      });
      // active_turn_id is the stale-callback fence: an old process can never settle a newer turn.
      this.raw.prepare(
        `UPDATE cowork_sessions SET
           state=@sessionState, active_turn_id=NULL, error=@error,
           agent_session_id=COALESCE(@agentSessionId, agent_session_id), updated_at=@at
         WHERE id=@sessionId AND active_turn_id=@turnId`,
      ).run({
        sessionId: input.sessionId,
        turnId: input.turnId,
        sessionState,
        error: input.error ?? null,
        agentSessionId: input.agentSessionId ?? null,
        at,
      });
    })();
    return this.getCoworkSession(input.sessionId);
  }

  renameCoworkSession(id: string, name: string): CoworkSession | null {
    const result = this.raw.prepare("UPDATE cowork_sessions SET name=?, auto_named=0, updated_at=? WHERE id=?").run(name, now(), id);
    return result.changes ? this.getCoworkSession(id) : null;
  }

  deleteCoworkSession(id: string): boolean {
    return this.raw.transaction(() => {
      const blobs = this.coworkAttachmentIds(id);
      const deleted = this.raw.prepare("DELETE FROM cowork_sessions WHERE id=? AND active_turn_id IS NULL").run(id).changes === 1;
      if (deleted) this.pruneAttachments(blobs);
      return deleted;
    })();
  }

  /** A process restart never autonomously replays a human-led turn. It closes orphan rows but retains
   * their provider session id, so the owner's next instruction can deliberately continue the conversation. */
  interruptOrphanedCoworkTurns(): CoworkSession[] {
    const active = (this.raw.prepare("SELECT * FROM cowork_sessions WHERE active_turn_id IS NOT NULL OR state IN ('running','stopping')").all() as Row[]).map(rowToCoworkSession);
    if (!active.length) return [];
    const at = now();
    const error = "The server restarted during this turn. The conversation and agent session were preserved; send the next instruction to continue.";
    this.raw.transaction(() => {
      for (const session of active) {
        if (session.activeTurnId) {
          this.raw.prepare(
            "UPDATE cowork_turns SET state='interrupted', error=?, ended_at=? WHERE id=? AND state='running'",
          ).run(error, at, session.activeTurnId);
          // A streamed reply that survived the crash is substantive history, not a still-live cursor.
          // Seal every partial row from the interrupted turn before the UI reloads it.
          this.raw.prepare(
            "UPDATE cowork_messages SET partial=0, updated_at=? WHERE turn_id=? AND partial=1",
          ).run(at, session.activeTurnId);
        }
        this.raw.prepare(
          "UPDATE cowork_sessions SET state='error', active_turn_id=NULL, error=?, updated_at=? WHERE id=?",
        ).run(error, at, session.id);
      }
    })();
    return active.map((session) => this.getCoworkSession(session.id)!).filter(Boolean);
  }

  // ---- threads ----
  createThread(input: {
    title: string;
    workspace: string;
    rawPrompt: string;
    brief?: string;
    effortOverride?: Effort | null;
    modelRequest?: ModelRequest | null;
    lane?: ThreadLane | null;
    durationMs?: number | null;
    deadlineAt?: number | null;
    agentCount?: number | null;
    parentId?: string | null;
    assignment?: ShotgunAssignment | null;
  }): Thread {
    const t: Thread = {
      id: newId(),
      title: input.title,
      state: "intake",
      workspace: input.workspace,
      brief: input.brief ?? "",
      rawPrompt: input.rawPrompt,
      error: null,
      effortOverride: input.effortOverride ?? null,
      modelRequest: input.modelRequest ?? null,
      lane: input.lane ?? null,
      durationMs: input.durationMs ?? null,
      deadlineAt: input.deadlineAt ?? null,
      agentCount: input.agentCount ?? null,
      parentId: input.parentId ?? null,
      assignment: input.assignment ?? null,
      createdAt: now(),
      updatedAt: now(),
    };
    this.raw
      .prepare(
        `INSERT INTO threads(id, title, state, workspace, brief, raw_prompt, error, effort_override, model_request, lane,
                             duration_ms, deadline_at, agent_count, parent_id, assignment, created_at, updated_at)
         VALUES(@id, @title, @state, @workspace, @brief, @rawPrompt, @error, @effortOverride, @modelRequest, @lane,
                @durationMs, @deadlineAt, @agentCount, @parentId, @assignment, @createdAt, @updatedAt)`,
      )
      // better-sqlite3 binds only primitives, so the assignment rides as JSON text (the mapper parses
      // it back); everything else on the DTO is already a scalar.
      .run({
        ...t,
        modelRequest: t.modelRequest ? JSON.stringify(t.modelRequest) : null,
        assignment: t.assignment ? JSON.stringify(t.assignment) : null,
      });
    return t;
  }

  /**
   * Persist a shotgun lead's complete, safe split before any collaborator is allowed to run.
   *
   * The collaborators share one working tree, so "create one child, enqueue it, then create the
   * next" is unsafe: a crash or a fast child can observe an incomplete peer list. The lead's
   * narrowed kickoff, its owned share, every child row, and the barrier's complete child list must
   * become visible as one SQLite transaction. ThreadManager only enqueues the returned children
   * after this method has committed.
   */
  createShotgunSplit(input: {
    leadId: string;
    leadAssignment: ShotgunAssignment;
    leadKickoff: string;
    children: Array<{
      title: string;
      workspace: string;
      brief: string;
      effortOverride?: Effort | null;
      durationMs?: number | null;
      deadlineAt?: number | null;
      assignment: ShotgunAssignment;
    }>;
  }): Thread[] {
    return this.raw.transaction(() => {
      const lead = this.getThread(input.leadId);
      if (!lead) throw new Error(`Shotgun lead ${input.leadId} no longer exists`);
      const stage = this.getThreadStageOutputs(lead.id);
      // This is deliberately a DB guard as well as ThreadManager's early return. A duplicate caller
      // must not create a second set of writers simply because it raced before its in-memory check.
      if (stage.shotgunPlanned || this.listCollaborators(lead.id).length) {
        throw new Error(`Shotgun lead ${lead.id} already has a persisted split`);
      }

      const children = input.children.map((child) =>
        this.createThread({
          title: child.title,
          workspace: child.workspace,
          rawPrompt: "",
          brief: child.brief,
          effortOverride: child.effortOverride ?? null,
          modelRequest: lead.modelRequest ?? null,
          durationMs: child.durationMs ?? null,
          deadlineAt: child.deadlineAt ?? null,
          parentId: lead.id,
          assignment: child.assignment,
        }),
      );
      const next: StageOutputs = {
        ...stage,
        shotgunPlanned: true,
        shotgunAssignment: input.leadAssignment,
        shotgunChildren: children.map((child) => child.id),
        // Persist the narrowed lead kickoff in the same transaction. A resume may therefore never
        // pair a full-objective lead with any persisted collaborator rows.
        kickoff: input.leadKickoff,
      };
      this.raw.prepare("UPDATE threads SET stage_outputs = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(next), now(), lead.id);
      return children;
    })();
  }

  /** Collaborator threads belonging to a lead, oldest first — the order they were assigned, which is the
   *  order the decomposition ranked them. */
  listCollaborators(parentId: string): Thread[] {
    return (this.raw.prepare("SELECT * FROM threads WHERE parent_id = ? ORDER BY created_at ASC").all(parentId) as Row[]).map(rowToThread);
  }

  /** Set (or clear) a task's timed work window. Managed on its own for the same reason as
   *  `setBaselineHead`: the generic `updateThread` SQL never touches these columns, so a routine state
   *  change cannot silently move a deadline that agents and the UI are both counting down to. */
  setTimedWindow(id: string, durationMs: number | null, deadlineAt: number | null): void {
    this.raw.prepare("UPDATE threads SET duration_ms = ?, deadline_at = ? WHERE id = ?").run(durationMs, deadlineAt, id);
  }

  /** Set or clear the operator's hard stop for this task. Kept out of updateThread so routine state
   *  transitions can never erase or move a safety boundary. updated_at changes because this is an
   *  owner-visible task edit and the authoritative row is broadcast immediately by ThreadManager. */
  setActiveDeadline(id: string, deadlineAt: number | null): Thread | null {
    const at = now();
    const result = this.raw
      .prepare("UPDATE threads SET active_deadline_at = ?, updated_at = ? WHERE id = ?")
      .run(deadlineAt, at, id);
    return result.changes ? this.getThread(id) : null;
  }

  getThread(id: string): Thread | null {
    const r = this.raw.prepare("SELECT * FROM threads WHERE id = ?").get(id) as Row | undefined;
    return r ? rowToThread(r) : null;
  }

  listThreads(): Thread[] {
    return (this.raw.prepare("SELECT * FROM threads ORDER BY created_at DESC").all() as Row[]).map(rowToThread);
  }

  /** How many tasks sit in any of these states. A count, so a caller that only wants the number never
   *  pays for hydrating every row of a table that grows for the life of the install. */
  countThreadsInStates(states: readonly ThreadState[]): number {
    if (!states.length) return 0;
    const holes = states.map(() => "?").join(",");
    const r = this.raw.prepare(`SELECT COUNT(*) AS n FROM threads WHERE state IN (${holes})`).get(...states) as Row;
    return Number(r.n ?? 0);
  }

  /** Record the task's baseline HEAD sha (captured at dispatch) for task-scoped Changes attribution.
   *  Managed on its own — the generic updateThread SQL never writes this column, so a routine state
   *  change can't clobber the baseline once it's set. */
  setBaselineHead(id: string, sha: string | null): void {
    this.raw.prepare("UPDATE threads SET baseline_head = ? WHERE id = ?").run(sha, id);
  }

  /** Persist a task-local strict model request independently of routine state updates, then return the
   * fresh row for immediate WS broadcast. */
  setModelRequest(id: string, request: ModelRequest | null): Thread | null {
    const at = now();
    const result = this.raw
      .prepare("UPDATE threads SET model_request = ?, updated_at = ? WHERE id = ?")
      .run(request ? JSON.stringify(request) : null, at, id);
    return result.changes ? this.getThread(id) : null;
  }

  /** Promote an escalated read-lane task into the normal pipeline, in place: clear `lane` (so the READ
   *  badge drops and the thread can never re-enter the read-lane branch of runPipeline again — the
   *  structural guard against an escalation loop) and replace `brief` with the reader's evidence appended.
   *  Managed on its own like `setBaselineHead`/`setTimedWindow` — the generic updateThread SQL never
   *  touches `lane`, so a routine state change can't accidentally clear the badge on an unrelated task. */
  promoteReadLane(id: string, brief: string): Thread | null {
    const current = this.getThread(id);
    if (!current) return null;
    const at = now();
    this.raw.prepare(`UPDATE threads SET lane=NULL, brief=@brief, updated_at=@at WHERE id=@id`).run({ id, brief, at });
    return { ...current, lane: null, brief, updatedAt: at };
  }

  /** Permanently delete a thread and all its children. agent_runs/findings/messages drop via FK
   *  ON DELETE CASCADE (the foreign_keys pragma is asserted in the constructor). questions.thread_id
   *  is nullable with NO FK — a question can be threadless — so its rows are deleted explicitly.
   *  Attachment blobs have no FK either (they outlive any one message, being shared), so the ones this
   *  thread held the last reference to are collected first and pruned once the messages are gone.
   *  Wrapped in a transaction so the thread and its questions go together or not at all. */
  deleteThread(id: string): void {
    this.raw.transaction((tid: string) => {
      const blobs = this.threadAttachmentIds(tid);
      this.raw.prepare("DELETE FROM questions WHERE thread_id = ?").run(tid);
      this.raw.prepare("DELETE FROM threads WHERE id = ?").run(tid);
      this.pruneAttachments(blobs);
    })(id);
  }

  /** Stable identity of the work a reviewer is judging. Reviewer and Supervisor activity is excluded:
   * their own runs/findings must not make a rejected task look newly changed. A real pipeline/resume/fix
   * run creates a new non-reviewer row and therefore a new reviewable revision. Owner-triggered review
   * remains an explicit override for external workspace edits that have no orchestrator run. */
  autoReviewRevision(threadId: string): string | null {
    const row = this.raw
      .prepare(
        `SELECT t.id, t.created_at,
                (SELECT r.id FROM agent_runs r
                  WHERE r.thread_id=t.id AND r.role<>'reviewer'
                  ORDER BY r.started_at DESC, r.rowid DESC LIMIT 1) run_id
           FROM threads t WHERE t.id=?`,
      )
      .get(threadId) as Row | undefined;
    if (!row) return null;
    return row.run_id ? `run:${String(row.run_id)}` : `thread:${threadId}:${Number(row.created_at)}`;
  }

  getAutoReviewEpisode(threadId: string): AutoReviewEpisode | null {
    const row = this.raw.prepare("SELECT * FROM auto_review_episodes WHERE thread_id=?").get(threadId) as Row | undefined;
    return row ? rowToAutoReviewEpisode(row) : null;
  }

  listRunningAutoReviewEpisodes(): AutoReviewEpisode[] {
    return (this.raw.prepare("SELECT * FROM auto_review_episodes WHERE status='running' ORDER BY started_at").all() as Row[]).map(
      rowToAutoReviewEpisode,
    );
  }

  /** Deterministic unattended-Supervisor gate. Null means this revision has never reached a terminal
   * auto-review outcome and may be delegated. A non-null reason is durable across restarts and prevents
   * both another reviewer launch and another paid Supervisor judgement over the same unchanged work. */
  autoReviewAutomationBlock(threadId: string): string | null {
    const deployment = parseManualDeployment(this.getThreadStageOutputs(threadId).manualDeployment);
    if (deployment?.status === "verified") {
      return "This task has a verified manual deployment handoff and is terminal in GGO.";
    }
    const revision = this.autoReviewRevision(threadId);
    const episode = this.getAutoReviewEpisode(threadId);
    if (!revision || !episode || episode.revision !== revision) return null;
    if (episode.status === "running") return "Auto-review already owns this unchanged task.";
    if (episode.status === "accepted") return "This revision already has a recorded accepted auto-review verdict.";
    const why = episode.reason?.trim() || "the reviewer did not accept it";
    return `Auto-review already parked this unchanged task: ${why}`;
  }

  /** Atomically claim `review -> reviewing` and persist the owner token before any runner work starts.
   * The CAS is the cross-manager/process lock; `claim_token` fences late callbacks after restart. An
   * unattended Supervisor gets one claim per work revision, while an explicit owner may retry. */
  claimAutoReview(threadId: string, source: Exclude<AutoReviewSource, "reconciled">): AutoReviewClaimResult {
    return this.raw.transaction((): AutoReviewClaimResult => {
      const current = this.getThread(threadId);
      if (!current) return { ok: false, thread: null, reason: "No such task." };
      const deployment = parseManualDeployment(this.getThreadStageOutputs(threadId).manualDeployment);
      if (deployment?.status === "verified") {
        return { ok: false, thread: current, reason: "This task is complete in GGO and only its manual deployment remains; Auto-review is suppressed." };
      }
      if (current.state !== "review") {
        const active = this.getAutoReviewEpisode(threadId);
        if (active?.status === "running" && ["reviewing", "implementing", "awaiting_user"].includes(current.state)) {
          return { ok: false, thread: current, reason: `Auto-review is already running (${current.state}).` };
        }
        return { ok: false, thread: current, reason: `Only a task parked in review can be auto-reviewed — this one is ${current.state}.` };
      }

      const revision = this.autoReviewRevision(threadId);
      if (!revision) return { ok: false, thread: current, reason: "No such task." };
      const previous = this.getAutoReviewEpisode(threadId);
      if (source === "supervisor" && previous?.revision === revision) {
        return { ok: false, thread: current, reason: this.autoReviewAutomationBlock(threadId) ?? "This unchanged review was already attempted." };
      }

      const at = now();
      const claimToken = randomUUID();
      const changed = this.raw
        .prepare("UPDATE threads SET state='reviewing', error=NULL, updated_at=@at WHERE id=@threadId AND state='review'")
        .run({ threadId, at });
      if (changed.changes !== 1) {
        return { ok: false, thread: this.getThread(threadId), reason: "Another action claimed this task before auto-review could start." };
      }
      const attemptCount = previous?.revision === revision ? previous.attemptCount + 1 : 1;
      this.raw
        .prepare(
          `INSERT INTO auto_review_episodes
             (thread_id, revision, status, source, claim_token, attempt_count, reason, verdict_json,
              verdict_run_id, started_at, settled_at, updated_at)
           VALUES (@threadId, @revision, 'running', @source, @claimToken, @attemptCount, NULL, NULL,
                   NULL, @at, NULL, @at)
           ON CONFLICT(thread_id) DO UPDATE SET
             revision=excluded.revision, status='running', source=excluded.source,
             claim_token=excluded.claim_token, attempt_count=excluded.attempt_count,
             reason=NULL, verdict_json=NULL, verdict_run_id=NULL,
             started_at=excluded.started_at, settled_at=NULL, updated_at=excluded.updated_at`,
        )
        .run({ threadId, revision, source, claimToken, attemptCount, at });
      return {
        ok: true,
        thread: this.getThread(threadId)!,
        episode: this.getAutoReviewEpisode(threadId)!,
        claimToken,
      };
    })();
  }

  /** Atomically persist the reviewer verdict and settle the task. Acceptance is guarded twice: the
   * caller must supply `accept:true`, and the claimed task must still be in `reviewing`. Any stale token,
   * restart reconciliation, cancellation, deadline, or concurrent state change wins and the late verdict
   * is discarded instead of mutating the task. */
  finishAutoReview(input: {
    threadId: string;
    claimToken: string;
    status: "accepted" | "parked";
    reason: string;
    verdict?: ReviewerOutput | null;
  }): AutoReviewFinishResult {
    return this.raw.transaction((): AutoReviewFinishResult => {
      const current = this.getThread(input.threadId);
      if (!current) return { ok: false, thread: null, reason: "The task no longer exists." };
      const episode = this.getAutoReviewEpisode(input.threadId);
      if (!episode || episode.status !== "running" || episode.claimToken !== input.claimToken) {
        return { ok: false, thread: current, reason: "This auto-review no longer owns the task; its late outcome was discarded." };
      }
      const accepting = input.status === "accepted";
      if (accepting && input.verdict?.accept !== true) {
        return { ok: false, thread: current, reason: "An accepted auto-review outcome requires a valid accept=true verdict." };
      }
      const maySettle = accepting
        ? current.state === "reviewing"
        : ["reviewing", "implementing", "awaiting_user", "failed"].includes(current.state);
      if (!maySettle) {
        const at = now();
        const staleReason = `Auto-review outcome discarded because the task moved to ${current.state}: ${input.reason}`;
        this.raw
          .prepare(
            `UPDATE auto_review_episodes
                SET revision=@revision, status='parked', claim_token=NULL, reason=@reason,
                    verdict_json=NULL, verdict_run_id=NULL, settled_at=@at, updated_at=@at
              WHERE thread_id=@threadId AND status='running' AND claim_token=@claimToken`,
          )
          .run({
            threadId: input.threadId,
            claimToken: input.claimToken,
            revision: this.autoReviewRevision(input.threadId) ?? episode.revision,
            reason: staleReason,
            at,
          });
        return { ok: false, thread: current, reason: staleReason };
      }

      const at = now();
      const nextState: ThreadState = accepting ? "done" : "review";
      const nextError = accepting ? null : input.reason;
      this.raw
        .prepare("UPDATE threads SET state=@state, error=@error, updated_at=@at WHERE id=@threadId")
        .run({ threadId: input.threadId, state: nextState, error: nextError, at });
      const latestReviewer = this.raw
        .prepare(
          "SELECT id FROM agent_runs WHERE thread_id=? AND role='reviewer' ORDER BY started_at DESC, rowid DESC LIMIT 1",
        )
        .get(input.threadId) as { id: string } | undefined;
      this.raw
        .prepare(
          `UPDATE auto_review_episodes
              SET revision=@revision, status=@status, claim_token=NULL, reason=@reason,
                  verdict_json=@verdictJson, verdict_run_id=@verdictRunId,
                  settled_at=@at, updated_at=@at
            WHERE thread_id=@threadId AND status='running' AND claim_token=@claimToken`,
        )
        .run({
          threadId: input.threadId,
          claimToken: input.claimToken,
          revision: this.autoReviewRevision(input.threadId) ?? episode.revision,
          status: input.status,
          reason: input.reason,
          verdictJson: input.verdict ? JSON.stringify(input.verdict) : null,
          verdictRunId: latestReviewer?.id ?? null,
          at,
        });
      return { ok: true, thread: this.getThread(input.threadId)!, episode: this.getAutoReviewEpisode(input.threadId)! };
    })();
  }

  /** Atomically terminalize a strictly verified deploy-only handoff and consume any reviewer claim.
   * The structured stage marker is the authority; callers cannot use this for ordinary tasks. */
  finishManualDeployment(threadId: string, reason: string): Thread | null {
    return this.raw.transaction((): Thread | null => {
      const current = this.getThread(threadId);
      if (!current) return null;
      const deployment = parseManualDeployment(this.getThreadStageOutputs(threadId).manualDeployment);
      if (deployment?.status !== "verified") return current;
      if (["cancelled", "closed"].includes(current.state)) return current;
      const at = now();
      if (current.state !== "done" || current.error != null) {
        this.raw.prepare("UPDATE threads SET state='done', error=NULL, updated_at=? WHERE id=?").run(at, threadId);
      }
      const episode = this.getAutoReviewEpisode(threadId);
      if (episode && episode.status !== "accepted") {
        this.raw.prepare(
          `UPDATE auto_review_episodes
              SET revision=@revision, status='parked', claim_token=NULL, reason=@reason,
                  verdict_json=NULL, verdict_run_id=NULL, settled_at=@at, updated_at=@at
            WHERE thread_id=@threadId`,
        ).run({
          threadId,
          revision: this.autoReviewRevision(threadId) ?? episode.revision,
          reason,
          at,
        });
      }
      return this.getThread(threadId);
    })();
  }

  /** Terminalize a live episode when another lifecycle owner wins (cancel, deadline, close). This never
   * changes the task row; the caller owns that transition. Optional token fencing is used by restart
   * reconciliation, while operator lifecycle actions intentionally abort whichever claim is current. */
  abandonAutoReview(threadId: string, reason: string, claimToken?: string): AutoReviewEpisode | null {
    const current = this.getAutoReviewEpisode(threadId);
    if (!current || current.status !== "running" || (claimToken && current.claimToken !== claimToken)) return current;
    const at = now();
    this.raw
      .prepare(
        `UPDATE auto_review_episodes
            SET revision=@revision, status='parked', claim_token=NULL, reason=@reason,
                verdict_json=NULL, verdict_run_id=NULL, settled_at=@at, updated_at=@at
          WHERE thread_id=@threadId AND status='running'${claimToken ? " AND claim_token=@claimToken" : ""}`,
      )
      .run({
        threadId,
        ...(claimToken ? { claimToken } : {}),
        revision: this.autoReviewRevision(threadId) ?? current.revision,
        reason,
        at,
      });
    return this.getAutoReviewEpisode(threadId);
  }

  /** Boot-only reconciliation for a process that died while holding a claim. No terminal task is ever
   * moved, and no acceptance is inferred from a completed run row. Every other stale claimed state is
   * atomically parked in review with the concrete interruption reason and the token is consumed. */
  reconcileInterruptedAutoReview(threadId: string, claimToken: string, reason: string): Thread | null {
    return this.raw.transaction((): Thread | null => {
      const current = this.getThread(threadId);
      const episode = this.getAutoReviewEpisode(threadId);
      if (!current || !episode || episode.status !== "running" || episode.claimToken !== claimToken) return current;
      const at = now();
      const terminal = ["done", "cancelled", "closed"].includes(current.state);
      if (!terminal) {
        this.raw
          .prepare("UPDATE threads SET state='review', error=@reason, updated_at=@at WHERE id=@threadId")
          .run({ threadId, reason, at });
      }
      this.raw
        .prepare(
          `UPDATE auto_review_episodes
              SET revision=@revision, status='parked', claim_token=NULL, reason=@reason,
                  verdict_json=NULL, verdict_run_id=NULL, settled_at=@at, updated_at=@at
            WHERE thread_id=@threadId AND status='running' AND claim_token=@claimToken`,
        )
        .run({
          threadId,
          claimToken,
          revision: this.autoReviewRevision(threadId) ?? episode.revision,
          reason: terminal ? `Auto-review claim closed because the task is already ${current.state}.` : reason,
          at,
        });
      return this.getThread(threadId);
    })();
  }

  updateThread(id: string, patch: Partial<Pick<Thread, "title" | "state" | "brief" | "workspace" | "error">>): Thread | null {
    const current = this.getThread(id);
    if (!current) return null;
    const next = { ...current, ...patch, updatedAt: now() };
    this.raw
      .prepare(
        `UPDATE threads SET title=@title, state=@state, brief=@brief, workspace=@workspace, error=@error, updated_at=@updatedAt WHERE id=@id`,
      )
      .run(next);
    return next;
  }

  /** Soft-close a thread: stamp state='closed', remember the state it came from (closed_prev_state,
   *  for restore), and start the 30-day auto-purge clock (closed_at). Managed only here and in
   *  restoreThread — the generic updateThread SQL never writes these columns, so a normal state change
   *  can't clobber them. */
  closeThread(id: string): Thread | null {
    const current = this.getThread(id);
    if (!current) return null;
    const at = now();
    this.raw
      .prepare(
        `UPDATE threads SET state='closed', closed_at=@at, closed_prev_state=@prev, updated_at=@at WHERE id=@id`,
      )
      .run({ id, at, prev: current.state });
    return { ...current, state: "closed", closedAt: at, closedPrevState: current.state, updatedAt: at };
  }

  /** Restore a closed thread back to the state it was closed from (closed_prev_state; fallback
   *  'review' if it's somehow missing), clearing the close bookkeeping so the purge clock stops. */
  restoreThread(id: string): Thread | null {
    const r = this.raw.prepare("SELECT closed_prev_state FROM threads WHERE id = ?").get(id) as Row | undefined;
    if (!r) return null;
    const prev = ((r.closed_prev_state as string | null) ?? "review") as ThreadState;
    const at = now();
    this.raw
      .prepare(
        `UPDATE threads SET state=@prev, closed_at=NULL, closed_prev_state=NULL, updated_at=@at WHERE id=@id`,
      )
      .run({ id, prev, at });
    return this.getThread(id);
  }

  /** Closed threads whose 30-day window has elapsed (closed_at strictly before `cutoff`) — the boot
   *  + daily auto-purge sweep deletes these permanently. */
  listClosedBefore(cutoff: number): Thread[] {
    return (
      this.raw
        .prepare("SELECT * FROM threads WHERE state='closed' AND closed_at IS NOT NULL AND closed_at < ?")
        .all(cutoff) as Row[]
    ).map(rowToThread);
  }

  /** Saved per-stage pipeline outputs for resume, or {} if none yet. Deliberately NOT folded into
   *  rowToThread/the Thread DTO: this JSON (plan + research + kickoff) can be multi-KB and the UI
   *  never needs it, so it stays off every thread.upsert frame — only the resume path reads it. */
  getThreadStageOutputs(id: string): StageOutputs {
    const r = this.raw.prepare("SELECT stage_outputs FROM threads WHERE id = ?").get(id) as Row | undefined;
    return r ? parseStageOutputs(r.stage_outputs) : {};
  }

  /** Additively merge a stage's output into the saved set — read-merge-write so persisting a later
   *  stage (e.g. research) never wipes an earlier one (plan). Sibling keys are preserved. */
  updateThreadStageOutputs(id: string, patch: Partial<StageOutputs>): void {
    const r = this.raw.prepare("SELECT stage_outputs FROM threads WHERE id = ?").get(id) as Row | undefined;
    if (!r) return;
    const next = { ...parseStageOutputs(r.stage_outputs), ...patch };
    this.raw.prepare("UPDATE threads SET stage_outputs = ? WHERE id = ?").run(JSON.stringify(next), id);
  }

  /** Wipe a thread's prior attempt for a from-scratch retry: delete its agent_runs (incl. the
   *  implementor session a resume would otherwise reuse), findings, feed messages and questions,
   *  and clear every saved stage output except reader escalation evidence + the error — preserving
   *  the original user context that lets a retry choose its route correctly. The office chat_messages are
   *  intentionally left (a durable cross-task record, no thread FK). Transactional so the wipe is
   *  all-or-nothing. */
  resetThreadForRetry(id: string): void {
    this.raw.transaction((tid: string) => {
      const preservedReaderEscalation = this.getThreadStageOutputs(tid).readerEscalation;
      const blobs = this.threadAttachmentIds(tid);
      this.raw.prepare("DELETE FROM agent_runs WHERE thread_id = ?").run(tid);
      this.raw.prepare("DELETE FROM findings WHERE thread_id = ?").run(tid);
      this.raw.prepare("DELETE FROM messages WHERE thread_id = ?").run(tid);
      this.raw.prepare("DELETE FROM questions WHERE thread_id = ?").run(tid);
      // A retry is a brand-new task attempt. Its old review revision/outcome must not suppress the new
      // attempt if it happens to have no agent run yet, and any stale claim token must be fenced out.
      this.raw.prepare("DELETE FROM auto_review_episodes WHERE thread_id = ?").run(tid);
      this.raw
        .prepare("UPDATE threads SET stage_outputs = @stageOutputs, error = NULL WHERE id = @id")
        .run({ id: tid, stageOutputs: preservedReaderEscalation ? JSON.stringify({ readerEscalation: preservedReaderEscalation }) : null });
      this.pruneAttachments(blobs);
    })(id);
  }

  // ---- agent runs ----
  createRun(input: { threadId: string; role: Role; model: string; account?: string | null; effort?: Effort | null }): AgentRun {
    const r: AgentRun = {
      id: newId(),
      threadId: input.threadId,
      role: input.role,
      model: input.model,
      account: input.account ?? null,
      effort: input.effort ?? null,
      sessionId: null,
      state: "starting",
      costUsd: null,
      numTurns: null,
      tokenUsage: null,
      error: null,
      capFlagged: null, // no verdict until the run ends — matches what a re-read of the row returns
      startedAt: now(),
      endedAt: null,
    };
    this.raw
      .prepare(
        `INSERT INTO agent_runs(id, thread_id, role, model, account, effort, session_id, state, cost_usd, num_turns, error, started_at, ended_at)
         VALUES(@id, @threadId, @role, @model, @account, @effort, @sessionId, @state, @costUsd, @numTurns, @error, @startedAt, @endedAt)`,
      )
      .run(r);
    return r;
  }

  updateRun(
    id: string,
    patch: Partial<Pick<AgentRun, "sessionId" | "state" | "costUsd" | "numTurns" | "tokenUsage" | "error" | "endedAt" | "capFlagged">>,
  ): void {
    const sets: string[] = [];
    const params: Row = { id };
    const map: Record<string, string> = {
      sessionId: "session_id",
      state: "state",
      costUsd: "cost_usd",
      numTurns: "num_turns",
      error: "error",
      capFlagged: "cap_flagged",
      endedAt: "ended_at",
    };
    for (const [k, col] of Object.entries(map)) {
      if (k in patch) {
        sets.push(`${col} = @${k}`);
        const v = (patch as Row)[k] ?? null;
        params[k] = typeof v === "boolean" ? (v ? 1 : 0) : v; // better-sqlite3 refuses to bind a boolean
      }
    }
    if ("tokenUsage" in patch) {
      const usage = patch.tokenUsage;
      const usageMap: Array<[keyof TokenUsage, string]> = [
        ["inputTokens", "input_tokens"],
        ["outputTokens", "output_tokens"],
        ["cacheReadInputTokens", "cache_read_input_tokens"],
        ["cacheCreationInputTokens", "cache_creation_input_tokens"],
        ["reasoningOutputTokens", "reasoning_output_tokens"],
        ["totalTokens", "total_tokens"],
      ];
      for (const [key, col] of usageMap) {
        sets.push(`${col} = @${key}`);
        params[key] = usage?.[key] ?? null;
      }
    }
    if (!sets.length) return;
    this.raw.prepare(`UPDATE agent_runs SET ${sets.join(", ")} WHERE id = @id`).run(params);
  }

  getRun(id: string): AgentRun | null {
    const r = this.raw.prepare("SELECT * FROM agent_runs WHERE id = ?").get(id) as Row | undefined;
    return r ? rowToRun(r) : null;
  }

  listRuns(threadId: string): AgentRun[] {
    return (
      this.raw.prepare("SELECT * FROM agent_runs WHERE thread_id = ? ORDER BY started_at ASC").all(threadId) as Row[]
    ).map(rowToRun);
  }

  /** All runs (ASC), or — for the connect snapshot — the most recent `limit` (still returned ASC) so
   *  the hello frame can't grow unbounded as months of history accumulate. */
  listAllRuns(limit?: number): AgentRun[] {
    const rows = limit
      ? (this.raw.prepare("SELECT * FROM agent_runs ORDER BY started_at DESC LIMIT ?").all(limit) as Row[]).reverse()
      : (this.raw.prepare("SELECT * FROM agent_runs ORDER BY started_at ASC").all() as Row[]);
    return rows.map(rowToRun);
  }

  /** Runs the DB still believes are live (no terminal state, no end time) — orphans after a
   *  restart, since every in-memory AgentRun is gone. Used to reconcile the live count on boot. */
  listActiveRuns(): AgentRun[] {
    return (
      this.raw
        .prepare(
          "SELECT * FROM agent_runs WHERE state IN ('starting','running','idle') AND ended_at IS NULL ORDER BY started_at ASC",
        )
        .all() as Row[]
    ).map(rowToRun);
  }

  /** Runs stuck in a live run-state but ALREADY stamped with an end time — the corrupted rows a late
   *  agent event can leave behind (its state flipped back to "running" after the run finalized). These
   *  break the invariant "an ended run has a terminal state": `listActiveRuns` can't see them (it needs
   *  ended_at IS NULL), yet the console's gnome strip draws any starting/running run regardless of
   *  ended_at — so each shows as a phantom working gnome forever, surviving restarts. The boot reconciler
   *  stamps them terminal. */
  listEndedButLiveStateRuns(): AgentRun[] {
    return (
      this.raw
        .prepare(
          "SELECT * FROM agent_runs WHERE state IN ('starting','running','idle') AND ended_at IS NOT NULL ORDER BY started_at ASC",
        )
        .all() as Row[]
    ).map(rowToRun);
  }

  // ---- findings ----
  addFinding(input: {
    threadId: string;
    fromRunId?: string | null;
    fromRole?: Role | null;
    kind?: FindingKind;
    summary: string;
    detail?: string | null;
    path?: string | null;
    label?: string | null;
    severity?: Severity;
  }): Finding {
    const f: Finding = {
      id: newId(),
      threadId: input.threadId,
      fromRunId: input.fromRunId ?? null,
      fromRole: input.fromRole ?? null,
      kind: input.kind ?? "finding",
      summary: input.summary,
      detail: input.detail ?? null,
      path: input.path ?? null,
      label: input.label ?? null,
      severity: input.severity ?? "note",
      routed: false,
      createdAt: now(),
    };
    this.raw
      .prepare(
        `INSERT INTO findings(id, thread_id, from_run_id, from_role, kind, summary, detail, path, label, severity, routed, created_at)
         VALUES(@id, @threadId, @fromRunId, @fromRole, @kind, @summary, @detail, @path, @label, @severity, 0, @createdAt)`,
      )
      .run(f);
    return f;
  }

  getFinding(id: string): Finding | null {
    const r = this.raw.prepare("SELECT * FROM findings WHERE id = ?").get(id) as Row | undefined;
    return r ? rowToFinding(r) : null;
  }

  markFindingRouted(id: string): void {
    this.raw.prepare("UPDATE findings SET routed = 1 WHERE id = ?").run(id);
  }

  listFindings(threadId?: string, limit?: number): Finding[] {
    if (threadId) {
      return (this.raw.prepare("SELECT * FROM findings WHERE thread_id = ? ORDER BY created_at ASC").all(threadId) as Row[]).map(rowToFinding);
    }
    // Cross-thread read (the connect snapshot): bound to the most recent `limit`, returned ASC.
    const rows = limit
      ? (this.raw.prepare("SELECT * FROM findings ORDER BY created_at DESC LIMIT ?").all(limit) as Row[]).reverse()
      : (this.raw.prepare("SELECT * FROM findings ORDER BY created_at ASC").all() as Row[]);
    return rows.map(rowToFinding);
  }

  // ---- questions ----
  addQuestion(input: {
    threadId: string | null;
    runId?: string | null;
    header: string;
    question: string;
    options: QuestionOption[];
    multiSelect: boolean;
  }): Question {
    const q: Question = {
      id: newId(),
      threadId: input.threadId,
      runId: input.runId ?? null,
      header: input.header,
      question: input.question,
      options: input.options,
      multiSelect: input.multiSelect,
      answer: null,
      answeredAt: null,
      createdAt: now(),
    };
    this.raw
      .prepare(
        `INSERT INTO questions(id, thread_id, run_id, header, question, options, multi_select, answer, answered_at, created_at)
         VALUES(@id, @threadId, @runId, @header, @question, @options, @multiSelect, NULL, NULL, @createdAt)`,
      )
      .run({ ...q, options: JSON.stringify(q.options), multiSelect: q.multiSelect ? 1 : 0 });
    return q;
  }

  answerQuestion(id: string, answer: string): Question | null {
    this.raw.prepare("UPDATE questions SET answer = ?, answered_at = ? WHERE id = ?").run(answer, now(), id);
    const r = this.raw.prepare("SELECT * FROM questions WHERE id = ?").get(id) as Row | undefined;
    return r ? rowToQuestion(r) : null;
  }

  getQuestion(id: string): Question | null {
    const r = this.raw.prepare("SELECT * FROM questions WHERE id = ?").get(id) as Row | undefined;
    return r ? rowToQuestion(r) : null;
  }

  listOpenQuestions(): Question[] {
    return (
      this.raw.prepare("SELECT * FROM questions WHERE answer IS NULL ORDER BY created_at ASC").all() as Row[]
    ).map(rowToQuestion);
  }

  // ---- messages ----
  addMessage(input: {
    threadId: string;
    runId?: string | null;
    role: Message["role"];
    kind: Message["kind"];
    content: string;
    attachments?: AttachmentRef[];
  }): Message {
    const m: Message = {
      id: newId(),
      threadId: input.threadId,
      runId: input.runId ?? null,
      role: input.role,
      kind: input.kind,
      content: input.content,
      attachments: input.attachments?.length ? input.attachments : undefined,
      createdAt: now(),
    };
    this.raw
      .prepare(
        `INSERT INTO messages(id, thread_id, run_id, role, kind, content, attachments, created_at)
         VALUES(@id, @threadId, @runId, @role, @kind, @content, @attachments, @createdAt)`,
      )
      .run({ ...m, attachments: JSON.stringify(m.attachments ?? []) });
    return m;
  }

  listMessages(threadId: string): Message[] {
    return (
      this.raw.prepare("SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at ASC").all(threadId) as Row[]
    ).map(rowToMessage);
  }

  /** How many messages a role has PRODUCED for a thread since `since` (inclusive). `system` rows are
   *  excluded because the orchestrator writes those itself (the auto-resume notice), so they say nothing
   *  about whether the agent did any work — which is exactly what the silent-run check asks. */
  countAgentMessagesSince(threadId: string, role: Message["role"], since: number): number {
    const row = this.raw
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE thread_id = ? AND role = ? AND kind != 'system' AND created_at >= ?")
      .get(threadId, role, since) as { n: number };
    return row.n;
  }

  /** The most recent message of a given role+kind for a thread, or null — a single indexed lookup so
   *  callers (e.g. the auto-resume "looks done?" check) don't materialize the whole message history. */
  lastMessageOf(threadId: string, role: Message["role"], kind: Message["kind"]): Message | null {
    const row = this.raw
      .prepare("SELECT * FROM messages WHERE thread_id = ? AND role = ? AND kind = ? ORDER BY created_at DESC LIMIT 1")
      .get(threadId, role, kind) as Row | undefined;
    return row ? rowToMessage(row) : null;
  }

  // ---- director conversation ----
  addDirectorMessage(input: {
    id?: string;
    role: "user" | "director";
    kind: Message["kind"];
    content: string;
    attachments?: AttachmentRef[];
  }): DirectorMessage {
    const m: DirectorMessage = {
      id: input.id ?? newId(),
      role: input.role,
      kind: input.kind,
      content: input.content,
      attachments: input.attachments?.length ? input.attachments : undefined,
      createdAt: now(),
    };
    this.raw
      .prepare(
        `INSERT INTO director_messages(id, role, kind, content, attachments, created_at)
         VALUES(@id, @role, @kind, @content, @attachments, @createdAt)`,
      )
      .run({ ...m, attachments: JSON.stringify(m.attachments ?? []) });
    return m;
  }

  /** Link the given director messages to the task their conversation turn dispatched, so a search hit
   *  can jump to it. Only fills still-unlinked rows (thread_id IS NULL), so an earlier dispatch in the
   *  same turn keeps ownership of the shared lead-up messages when a second task is dispatched after. */
  linkDirectorMessagesToThread(messageIds: string[], threadId: string): void {
    if (!messageIds.length) return;
    const placeholders = messageIds.map(() => "?").join(",");
    this.raw
      .prepare(`UPDATE director_messages SET thread_id = ? WHERE thread_id IS NULL AND id IN (${placeholders})`)
      .run(threadId, ...messageIds);
  }

  /** The director conversation (ASC), or — for the connect snapshot — the most recent `limit`
   *  (returned ASC) so a months-long chat doesn't bloat every hello/reconnect frame. */
  listDirectorMessages(limit?: number): DirectorMessage[] {
    const rows = limit
      ? (this.raw.prepare("SELECT * FROM director_messages ORDER BY created_at DESC, rowid DESC LIMIT ?").all(limit) as Row[]).reverse()
      : (this.raw.prepare("SELECT * FROM director_messages ORDER BY created_at ASC, rowid ASC").all() as Row[]);
    return rows.map(rowToDirectorMessage);
  }

  /** Substring search across the ENTIRE director conversation (both the user's prompts and the
   *  director's replies) — the "find where I mentioned X across every task" search, so it spans the
   *  whole table, not the bounded snapshot slice. Newest-first, capped. Match is case-insensitive for
   *  ASCII (SQLite LIKE's built-in fold); non-ASCII letters match case-sensitively. */
  searchDirectorMessages(query: string, limit = 100): DirectorMessage[] {
    const q = query.trim();
    if (!q) return [];
    const rows = this.raw
      .prepare(
        `SELECT * FROM director_messages
         WHERE content LIKE ? ESCAPE '\\'
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(`%${escapeLike(q)}%`, limit) as Row[];
    return rows.map(rowToDirectorMessage);
  }

  /** Tasks whose title, brief or CONVERSATION contains `query` — the other half of the console's
   *  search. Searching the conversation is the whole point: what the owner remembers a task by is often
   *  a word an agent coined while working (a project folder it created, a file it generated), which
   *  appears in neither the prompt that started the task nor the auto-generated title. Ranked by
   *  `byRelevance`, capped. Match is ASCII case-insensitive, like the director search beside it. */
  searchTasks(query: string, limit = 40): TaskSearchHit[] {
    const q = query.trim();
    if (!q) return [];
    const like = `%${escapeLike(q)}%`;
    const plan = this.conversationPlan(q);
    const messageHits = this.conversationHits(like, plan);
    const ids = new Set(messageHits.keys());
    for (const r of this.raw
      .prepare("SELECT id FROM threads WHERE title LIKE @like ESCAPE '\\' OR brief LIKE @like ESCAPE '\\'")
      .all({ like }) as Row[])
      ids.add(r.id as string);
    if (!ids.size) return [];
    return this.threadsByIds([...ids])
      .map((thread) => ({
        thread,
        hit: messageHits.get(thread.id) ?? null,
        metadata: containsFold(thread.title, q) || containsFold(thread.brief, q),
      }))
      .sort(byRelevance)
      .slice(0, limit)
      .map((c) => this.taskHit(c.thread, q, c.hit));
  }

  /** True once every message is in the trigram index, so a search may use it. Cached because it only
   *  ever flips once, on the boot that finishes the backfill, and a search would otherwise re-read it
   *  on every keystroke. */
  searchIndexReady(): boolean {
    if (!this.ftsReady) this.ftsReady = this.kvGet(FTS_READY_KEY) !== null;
    return this.ftsReady;
  }

  /**
   * How this query reaches the conversations: the index, the old full scan, or not at all.
   *
   * "Not at all" is a deliberate floor, not a gap in the index. A one- or two-character term is
   * shorter than a trigram, so nothing can index it — and it also matches nearly every task, so the
   * scan spends half a minute reading 105 MB to rank noise. Under three characters the search stays
   * on titles and briefs, which is where a fragment that short is actually discriminating, and the
   * rail says so. The rule is length-only (never "…unless the index is still building") so that what
   * the console promises and what the server does cannot drift apart for a minute after a deploy.
   */
  private conversationPlan(q: string): ConversationPlan {
    const match = trigramMatchExpr(q);
    if (match === null) return { via: "none" };
    return this.searchIndexReady() ? { via: "index", match } : { via: "scan" };
  }

  /** Read back the matched threads. Chunked because a common word matches most of the table, and
   *  ranking has to see them all before anything can be cut to `limit`. */
  private threadsByIds(ids: string[]): Thread[] {
    const out: Thread[] = [];
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const rows = this.raw
        .prepare(`SELECT * FROM threads WHERE id IN (${chunk.map(() => "?").join(",")})`)
        .all(...chunk) as Row[];
      out.push(...rows.map(rowToThread));
    }
    return out;
  }

  /**
   * Per task: how many of its messages match, and which one to quote.
   *
   * `messages.content` is ~105 MB of tool output and a leading-wildcard LIKE can use no ordinary
   * index, so this used to re-read the whole table on every keystroke — measured on the real database,
   * a search for "orchestrator" spent **263 seconds** here, all of it blocking the server's only
   * thread. The trigram index narrows to candidates first and the same LIKE re-checks each one, so the
   * answer is unchanged.
   *
   * Count and quote come from ONE pass because they used to come from 41. Picking the message to quote
   * was a separate per-task query, and the tasks a common word returns are by definition the ones that
   * said it most — the biggest conversations in the database — so those 40 follow-up reads cost another
   * 27 seconds. Do not use a window function here: it sorts EVERY matching message within its task
   * before it can emit one row. On the real corpus, a common term still took 17 seconds after the FTS
   * lookup solely because of that sort. Instead, group each task once and join its chosen timestamp back
   * to the materialized candidate set. Only the ~40 rows actually returned are then read for their text.
   */
  private conversationHits(like: string, plan: ConversationPlan): Map<string, ConversationHit> {
    if (plan.via === "none") return new Map();
    // `MATERIALIZED` is important: the FTS + exact-LIKE filter is the expensive part, and this query
    // reads the candidate set once to group it and once to retrieve each group's best row. Without it,
    // SQLite may repeat the virtual-table search for the join.
    const ranked = `WITH candidates AS MATERIALIZED (
        SELECT m.thread_id AS tid, m.rowid AS rid, m.kind AS kind, m.created_at AS created_at
          FROM %SOURCE%
      ), grouped AS (
        SELECT tid,
               COUNT(*) AS n,
               COALESCE(MIN(CASE WHEN kind = 'text' THEN created_at END), MIN(created_at)) AS best_created_at,
               MAX(kind = 'text') AS has_text
          FROM candidates
         GROUP BY tid
      )
      SELECT g.tid, g.n, MIN(c.rid) AS rid
        FROM grouped g
        JOIN candidates c ON c.tid = g.tid
                         AND c.created_at = g.best_created_at
                         AND (g.has_text = 0 OR c.kind = 'text')
       GROUP BY g.tid, g.n`;
    const rows = (
      plan.via === "scan"
        ? this.raw.prepare(ranked.replace("%SOURCE%", "messages m WHERE m.content LIKE ? ESCAPE '\\'")).all(like)
        : this.raw
            .prepare(
              ranked.replace(
                "%SOURCE%",
                `messages_fts JOIN messages m ON m.rowid = messages_fts.rowid
                  WHERE messages_fts MATCH ? AND m.content LIKE ? ESCAPE '\\'`,
              ),
            )
            .all(plan.match, like)
    ) as Row[];
    return new Map(rows.map((r) => [r.tid as string, { hits: r.n as number, bestRowid: r.rid as number }]));
  }

  /** One hit, showing the most informative evidence available: the owner's own brief, else the task's
   *  conversation, else nothing — a title-only match is already legible in the highlighted title. */
  private taskHit(t: Thread, q: string, hit: ConversationHit | null): TaskSearchHit {
    const base = {
      threadId: t.id,
      title: t.title,
      state: t.state,
      workspace: t.workspace,
      createdAt: t.createdAt,
      messageHits: hit?.hits ?? 0,
    };
    if (containsFold(t.brief, q)) return { ...base, where: "brief", snippet: snippetAround(t.brief, q) };
    const message = hit ? this.messageContent(hit.bestRowid) : null;
    if (message) return { ...base, where: "conversation", snippet: snippetAround(message, q) };
    return { ...base, where: "title", snippet: "" };
  }

  /** The text of one already-chosen message, by rowid — read only for the handful of hits that survive
   *  the ranking cut, never for every task a common word touched. */
  private messageContent(rowid: number): string | null {
    const row = this.raw.prepare("SELECT content FROM messages WHERE rowid = ?").get(rowid) as Row | undefined;
    return (row?.content as string | undefined) ?? null;
  }

  // ---- search index maintenance ----

  /**
   * One turn of the backfill walk: index the next `chunk` messages by rowid and advance the persisted
   * cursor. When the walk runs out of rows it finalizes — in a SINGLE transaction it sweeps up anything
   * added since the last chunk, installs the two triggers that maintain the index from then on, and
   * marks it ready. Atomic on purpose: it is the only moment at which a message could be inserted by
   * neither the walk nor a trigger, so nothing may run between the sweep and the trigger.
   */
  backfillSearchIndexChunk(chunk = BACKFILL_CHUNK): BackfillStep {
    if (this.searchIndexReady()) return { indexed: 0, done: true };
    const cursor = Number(this.kvGet(FTS_CURSOR_KEY) ?? 0);
    const upto = (
      this.raw
        .prepare("SELECT MAX(rowid) m FROM (SELECT rowid FROM messages WHERE rowid > ? ORDER BY rowid LIMIT ?)")
        .get(cursor, chunk) as Row
    ).m as number | null;

    if (upto === null) {
      this.raw.transaction(() => {
        this.raw.prepare("INSERT INTO messages_fts(rowid, content) SELECT rowid, content FROM messages WHERE rowid > ?").run(cursor);
        this.raw.exec(FTS_WRITE_TRIGGERS);
        this.kvSet(FTS_READY_KEY, String(now()));
      })();
      this.ftsReady = true;
      return { indexed: 0, done: true };
    }

    const indexed = this.raw.transaction(() => {
      const info = this.raw
        .prepare("INSERT INTO messages_fts(rowid, content) SELECT rowid, content FROM messages WHERE rowid > ? AND rowid <= ?")
        .run(cursor, upto);
      this.kvSet(FTS_CURSOR_KEY, String(upto));
      return info.changes;
    })();
    return { indexed, done: false };
  }

  // ---- office chat ----
  addChatMessage(input: {
    id?: string;
    room: string;
    scope: ChatScope;
    workspace?: string | null;
    threadId?: string | null;
    runId?: string | null;
    role: ChatMessage["role"];
    kind?: ChatMessage["kind"];
    body: string;
    senderName?: string | null;
    remoteInstance?: string | null;
  }): ChatMessage {
    const m: ChatMessage = {
      id: input.id ?? newId(),
      room: input.room,
      scope: input.scope,
      workspace: input.workspace ?? null,
      threadId: input.threadId ?? null,
      runId: input.runId ?? null,
      role: input.role,
      kind: input.kind ?? "chat",
      body: input.body,
      senderName: input.senderName ?? null,
      remoteInstance: input.remoteInstance ?? null,
      createdAt: now(),
    };
    this.raw
      .prepare(
        `INSERT INTO chat_messages(id, room, scope, workspace, thread_id, run_id, role, kind, body, sender_name, remote_instance, created_at)
         VALUES(@id, @room, @scope, @workspace, @threadId, @runId, @role, @kind, @body, @senderName, @remoteInstance, @createdAt)`,
      )
      .run(m);
    return m;
  }

  /** Messages in one room (ASC), optionally only the most recent `limit` (still returned ASC). */
  listRoomMessages(room: string, limit?: number): ChatMessage[] {
    const rows = limit
      ? (this.raw.prepare("SELECT * FROM chat_messages WHERE room = ? ORDER BY created_at DESC LIMIT ?").all(room, limit) as Row[]).reverse()
      : (this.raw.prepare("SELECT * FROM chat_messages WHERE room = ? ORDER BY created_at ASC").all(room) as Row[]);
    return rows.map(rowToChat);
  }

  /** One page of a room's history for the lazily-loaded chatroom view. Without `before` this returns the
   *  most recent `limit` messages; with a `before` cursor it returns the `limit` messages immediately
   *  older than that cursor. Always ASC. `hasMore` says whether still-older messages exist beyond this
   *  page, so the client knows when to stop fetching as the user scrolls up. Keyset-paginated on
   *  (created_at, id) — id (a UUID) is the deterministic tie-break within a millisecond, so no message is
   *  skipped or duplicated at a page boundary even when several land in the same tick. */
  listRoomMessagePage(room: string, limit: number, before?: ChatCursor): { messages: ChatMessage[]; hasMore: boolean } {
    const probe = limit + 1; // fetch one extra to detect whether older messages remain
    const rows = before
      ? (this.raw
          .prepare(
            `SELECT * FROM chat_messages
             WHERE room = ? AND (created_at < @createdAt OR (created_at = @createdAt AND id < @id))
             ORDER BY created_at DESC, id DESC LIMIT @probe`,
          )
          .all(room, { createdAt: before.createdAt, id: before.id, probe }) as Row[])
      : (this.raw.prepare("SELECT * FROM chat_messages WHERE room = ? ORDER BY created_at DESC, id DESC LIMIT ?").all(room, probe) as Row[]);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return { messages: page.reverse().map(rowToChat), hasMore };
  }

  /** The most recent `limit` chat messages across ALL rooms (returned ASC) — the connect-snapshot
   *  slice, bounded so a months-long office history doesn't bloat every hello frame. */
  listRecentChat(limit: number): ChatMessage[] {
    return (this.raw.prepare("SELECT * FROM chat_messages ORDER BY created_at DESC LIMIT ?").all(limit) as Row[])
      .reverse()
      .map(rowToChat);
  }

  /** Whether a task already has any message in a room — used to announce each participant exactly
   *  once when a project group forms (durable across restarts, unlike an in-memory guard). */
  chatThreadInRoom(room: string, threadId: string): boolean {
    const r = this.raw
      .prepare("SELECT 1 FROM chat_messages WHERE room = ? AND thread_id = ? LIMIT 1")
      .get(room, threadId) as Row | undefined;
    return !!r;
  }

  /** Rolled-up project (per-repo) rooms with their distinct participant task ids — drives which tasks
   *  show a "Chatroom" button. General-room rows are excluded (every active agent is in general; it's
   *  not a per-task collaboration). Newest-active room first. */
  listProjectRooms(): ChatRoomSummary[] {
    const rows = this.raw
      .prepare(
        `SELECT room,
                MAX(workspace)      AS workspace,
                COUNT(*)            AS message_count,
                MAX(created_at)     AS last_at,
                GROUP_CONCAT(DISTINCT thread_id) AS thread_ids
         FROM chat_messages
         WHERE scope = 'project'
         GROUP BY room
         ORDER BY last_at DESC`,
      )
      .all() as Row[];
    // Machine names are free text and can contain a comma, so they are collected by their own grouped
    // query rather than folded into the GROUP_CONCAT above.
    const remoteByRoom = new Map<string, string[]>();
    for (const r of this.raw
      .prepare(
        `SELECT room, remote_instance FROM chat_messages
         WHERE scope = 'project' AND remote_instance IS NOT NULL
         GROUP BY room, remote_instance`,
      )
      .all() as Row[]) {
      const room = r.room as string;
      remoteByRoom.set(room, [...(remoteByRoom.get(room) ?? []), r.remote_instance as string]);
    }
    return rows.map((r) => ({
      room: r.room as string,
      workspace: (r.workspace as string | null) ?? "",
      threadIds: String(r.thread_ids ?? "")
        .split(",")
        .filter(Boolean),
      remoteInstances: remoteByRoom.get(r.room as string) ?? [],
      messageCount: r.message_count as number,
      lastAt: r.last_at as number,
    }));
  }

  // ---- scheduled tasks (recurring dispatches) ----
  createScheduledTask(input: {
    title: string;
    workspace: string;
    prompt: string;
    cron: string;
    enabled: boolean;
    effort?: Effort | null;
    nextRunAt?: number | null;
  }): ScheduledTask {
    const t: ScheduledTask = {
      id: newId(),
      title: input.title,
      workspace: input.workspace,
      prompt: input.prompt,
      cron: input.cron,
      enabled: input.enabled,
      effort: input.effort ?? null,
      lastRunAt: null,
      nextRunAt: input.nextRunAt ?? null,
      lastThreadId: null,
      createdAt: now(),
      updatedAt: now(),
    };
    this.raw
      .prepare(
        `INSERT INTO scheduled_tasks(id, title, workspace, prompt, cron, enabled, effort, last_run_at, next_run_at, last_thread_id, created_at, updated_at)
         VALUES(@id, @title, @workspace, @prompt, @cron, @enabled, @effort, @lastRunAt, @nextRunAt, @lastThreadId, @createdAt, @updatedAt)`,
      )
      .run({ ...t, enabled: t.enabled ? 1 : 0 });
    return t;
  }

  getScheduledTask(id: string): ScheduledTask | null {
    const r = this.raw.prepare("SELECT * FROM scheduled_tasks WHERE id = ?").get(id) as Row | undefined;
    return r ? rowToScheduledTask(r) : null;
  }

  listScheduledTasks(): ScheduledTask[] {
    return (this.raw.prepare("SELECT * FROM scheduled_tasks ORDER BY created_at ASC").all() as Row[]).map(rowToScheduledTask);
  }

  updateScheduledTask(
    id: string,
    patch: Partial<Pick<ScheduledTask, "title" | "workspace" | "prompt" | "cron" | "enabled" | "effort" | "lastRunAt" | "nextRunAt" | "lastThreadId">>,
  ): ScheduledTask | null {
    const current = this.getScheduledTask(id);
    if (!current) return null;
    const sets: string[] = [];
    const params: Row = { id };
    const map: Record<string, string> = {
      title: "title",
      workspace: "workspace",
      prompt: "prompt",
      cron: "cron",
      enabled: "enabled",
      effort: "effort",
      lastRunAt: "last_run_at",
      nextRunAt: "next_run_at",
      lastThreadId: "last_thread_id",
    };
    for (const [k, col] of Object.entries(map)) {
      if (k in patch) {
        sets.push(`${col} = @${k}`);
        const v = (patch as Row)[k];
        params[k] = k === "enabled" ? (v ? 1 : 0) : (v ?? null);
      }
    }
    sets.push("updated_at = @updatedAt");
    params.updatedAt = now();
    this.raw.prepare(`UPDATE scheduled_tasks SET ${sets.join(", ")} WHERE id = @id`).run(params);
    return this.getScheduledTask(id);
  }

  deleteScheduledTask(id: string): boolean {
    return this.raw.prepare("DELETE FROM scheduled_tasks WHERE id = ?").run(id).changes > 0;
  }

  // ---- operator notes (the owner's own review list) ----
  createOperatorNote(input: Omit<OperatorNote, "id" | "createdAt">): OperatorNote {
    const n: OperatorNote = {
      id: newId(),
      body: input.body,
      url: input.url ?? null,
      threadId: input.threadId ?? null,
      threadTitle: input.threadTitle ?? null,
      workspace: input.workspace ?? null,
      fromRole: input.fromRole ?? null,
      fromName: input.fromName ?? null,
      createdAt: now(),
    };
    this.raw
      .prepare(
        `INSERT INTO operator_notes(id, seq, body, url, thread_id, thread_title, workspace, from_role, from_name, created_at)
         VALUES(@id, ${NEXT_NOTE_SEQ}, @body, @url, @threadId, @threadTitle, @workspace, @fromRole, @fromName, @createdAt)`,
      )
      .run(n);
    return n;
  }

  /** Newest first — the list is the owner's inbox, so the thing that just landed reads at the top. */
  listOperatorNotes(): OperatorNote[] {
    return (this.raw.prepare("SELECT * FROM operator_notes ORDER BY seq DESC").all() as Row[]).map(rowToOperatorNote);
  }

  /** Oldest first — the order the per-task cap evicts in. */
  listOperatorNotesForThread(threadId: string): OperatorNote[] {
    return (this.raw.prepare("SELECT * FROM operator_notes WHERE thread_id = ? ORDER BY seq ASC").all(threadId) as Row[]).map(rowToOperatorNote);
  }

  /** Rewrite an existing note in place and float it back to the top — how a re-post of the same link
   *  refreshes its note instead of adding a second row for it. The source moves with the text: the row
   *  is about the link, so it should name whoever last had something to say about it. */
  refreshOperatorNote(id: string, body: string, source: NoteSource): OperatorNote | null {
    this.raw
      .prepare(
        `UPDATE operator_notes
            SET body = @body, created_at = @createdAt, seq = ${NEXT_NOTE_SEQ},
                thread_id = @threadId, thread_title = @threadTitle, workspace = @workspace,
                from_role = @fromRole, from_name = @fromName
          WHERE id = @id`,
      )
      .run({ id, body, createdAt: now(), ...source });
    const r = this.raw.prepare("SELECT * FROM operator_notes WHERE id = ?").get(id) as Row | undefined;
    return r ? rowToOperatorNote(r) : null;
  }

  deleteOperatorNote(id: string): boolean {
    return this.raw.prepare("DELETE FROM operator_notes WHERE id = ?").run(id).changes > 0;
  }

  deleteAllOperatorNotes(): number {
    return this.raw.prepare("DELETE FROM operator_notes").run().changes;
  }

  // ---- auto model selection: picks + their grades ----

  /** Record (or replace) the model auto-selection for a task, ungraded. Replacing on thread_id is what
   *  keeps a retry — which re-selects against newer grades — from counting the same task twice. */
  recordModelSelection(input: Omit<ModelGrade, "createdAt" | "gradedAt">): ModelGrade {
    const g: ModelGrade = { ...input, createdAt: now(), gradedAt: null };
    this.raw
      .prepare(
        `INSERT OR REPLACE INTO model_grades(thread_id, workspace, title, provider, model, effort, reason,
           outcome, score, qa_rounds, cost_usd, num_turns, input_tokens, output_tokens,
           cache_read_input_tokens, cache_creation_input_tokens, reasoning_output_tokens, total_tokens, token_usage_complete,
           duration_ms, ran_models, graded_model, created_at, graded_at)
         VALUES(@threadId, @workspace, @title, @provider, @model, @effort, @reason,
           @outcome, @score, @qaRounds, @costUsd, @numTurns, @inputTokens, @outputTokens,
           @cacheReadInputTokens, @cacheCreationInputTokens, @reasoningOutputTokens, @totalTokens, @tokenUsageComplete,
           @durationMs, @ranModels, @gradedModel, @createdAt, @gradedAt)`,
      )
      .run({
        threadId: g.threadId,
        workspace: g.workspace,
        title: g.title,
        provider: g.provider,
        model: g.model,
        effort: g.effort,
        reason: g.reason,
        outcome: g.outcome ?? null,
        score: g.score ?? null,
        qaRounds: g.qaRounds ?? null,
        costUsd: g.costUsd ?? null,
        numTurns: g.numTurns ?? null,
        inputTokens: g.tokenUsage?.inputTokens ?? null,
        outputTokens: g.tokenUsage?.outputTokens ?? null,
        cacheReadInputTokens: g.tokenUsage?.cacheReadInputTokens ?? null,
        cacheCreationInputTokens: g.tokenUsage?.cacheCreationInputTokens ?? null,
        reasoningOutputTokens: g.tokenUsage?.reasoningOutputTokens ?? null,
        totalTokens: g.tokenUsage?.totalTokens ?? null,
        tokenUsageComplete: g.tokenUsageComplete == null ? null : (g.tokenUsageComplete ? 1 : 0),
        durationMs: g.durationMs ?? null,
        ranModels: g.ranModels ?? null,
        gradedModel: g.gradedModel ?? null,
        createdAt: g.createdAt,
        gradedAt: g.gradedAt ?? null,
      });
    return g;
  }

  /** Write a settled task's outcome onto its selection record. No-op when the task had no auto-pick. */
  gradeModelSelection(
    threadId: string,
    patch: Pick<ModelGrade, "outcome" | "score" | "qaRounds" | "costUsd" | "numTurns" | "tokenUsage" | "tokenUsageComplete" | "durationMs" | "ranModels" | "gradedModel">,
  ): ModelGrade | null {
    const existing = this.getModelGrade(threadId);
    if (!existing) return null;
    this.raw
      .prepare(
        `UPDATE model_grades SET outcome=@outcome, score=@score, qa_rounds=@qaRounds,
           cost_usd=@costUsd, num_turns=@numTurns, input_tokens=@inputTokens, output_tokens=@outputTokens,
           cache_read_input_tokens=@cacheReadInputTokens, cache_creation_input_tokens=@cacheCreationInputTokens,
           reasoning_output_tokens=@reasoningOutputTokens, total_tokens=@totalTokens, token_usage_complete=@tokenUsageComplete,
           duration_ms=@durationMs, ran_models=@ranModels,
           graded_model=@gradedModel, graded_at=@gradedAt WHERE thread_id=@threadId`,
      )
      .run({
        threadId,
        outcome: patch.outcome ?? null,
        score: patch.score ?? null,
        qaRounds: patch.qaRounds ?? null,
        costUsd: patch.costUsd ?? null,
        numTurns: patch.numTurns ?? null,
        inputTokens: patch.tokenUsage?.inputTokens ?? null,
        outputTokens: patch.tokenUsage?.outputTokens ?? null,
        cacheReadInputTokens: patch.tokenUsage?.cacheReadInputTokens ?? null,
        cacheCreationInputTokens: patch.tokenUsage?.cacheCreationInputTokens ?? null,
        reasoningOutputTokens: patch.tokenUsage?.reasoningOutputTokens ?? null,
        totalTokens: patch.tokenUsage?.totalTokens ?? null,
        tokenUsageComplete: patch.tokenUsageComplete ? 1 : 0,
        durationMs: patch.durationMs ?? null,
        ranModels: patch.ranModels ?? null,
        gradedModel: patch.gradedModel ?? null,
        gradedAt: now(),
      });
    return this.getModelGrade(threadId);
  }

  getModelGrade(threadId: string): ModelGrade | null {
    const r = this.raw.prepare("SELECT * FROM model_grades WHERE thread_id = ?").get(threadId) as Row | undefined;
    return r ? rowToModelGrade(r) : null;
  }

  /** Most recent selection records (graded or not), newest first — the Settings scoreboard's detail list. */
  listModelGrades(limit = 50): ModelGrade[] {
    return (
      this.raw.prepare("SELECT * FROM model_grades ORDER BY created_at DESC LIMIT ?").all(limit) as Row[]
    ).map(rowToModelGrade);
  }

  /**
   * Per-model performance over the graded record. Only rows whose whole implementation ran on ONE model
   * count: a task a cap-failover split across two backends is evidence about neither. `workspace`
   * (already normalized) scopes it to a single repo — what the selector reads first, since "which model
   * suits this codebase" is a different question from "which model is good in general".
   */
  modelStats(workspace?: string): ModelStat[] {
    const rows = this.raw
      .prepare(
        `SELECT provider, graded_model AS model, COUNT(*) AS picks,
                AVG(score) AS avg_score,
                AVG(CASE WHEN outcome = 'done' THEN 1.0 ELSE 0.0 END) AS done_rate,
                AVG(COALESCE(qa_rounds, 0)) AS avg_qa,
                AVG(COALESCE(cost_usd, 0)) AS avg_cost,
                AVG(CASE WHEN token_usage_complete = 1 THEN total_tokens END) AS avg_total_tokens,
                AVG(CASE WHEN token_usage_complete = 1 THEN input_tokens END) AS avg_input_tokens,
                AVG(CASE WHEN token_usage_complete = 1 THEN output_tokens END) AS avg_output_tokens,
                AVG(CASE WHEN token_usage_complete = 1 THEN COALESCE(cache_read_input_tokens, 0) + COALESCE(cache_creation_input_tokens, 0) END) AS avg_cache_tokens,
                AVG(CASE WHEN token_usage_complete = 1 THEN reasoning_output_tokens END) AS avg_reasoning_tokens,
                AVG(CASE WHEN token_usage_complete = 1 THEN 1.0 ELSE 0.0 END) AS token_sample_rate,
                AVG(COALESCE(duration_ms, 0)) AS avg_ms
           FROM model_grades
          WHERE graded_model IS NOT NULL AND score IS NOT NULL${workspace ? " AND workspace = @workspace" : ""}
          GROUP BY provider, graded_model
          ORDER BY picks DESC, avg_score DESC`,
      )
      .all(workspace ? { workspace } : {}) as Row[];
    return rows.map((r) => ({
      provider: r.provider as ModelStat["provider"],
      model: r.model as string,
      picks: r.picks as number,
      avgScore: Math.round((r.avg_score as number) ?? 0),
      doneRate: (r.done_rate as number) ?? 0,
      avgQaRounds: Number(((r.avg_qa as number) ?? 0).toFixed(1)),
      avgCostUsd: Number(((r.avg_cost as number) ?? 0).toFixed(2)),
      avgTotalTokens: r.avg_total_tokens == null ? null : Math.round(r.avg_total_tokens as number),
      avgInputTokens: r.avg_input_tokens == null ? null : Math.round(r.avg_input_tokens as number),
      avgOutputTokens: r.avg_output_tokens == null ? null : Math.round(r.avg_output_tokens as number),
      avgCacheTokens: r.avg_cache_tokens == null ? null : Math.round(r.avg_cache_tokens as number),
      avgReasoningTokens: r.avg_reasoning_tokens == null ? null : Math.round(r.avg_reasoning_tokens as number),
      tokenSampleRate: (r.token_sample_rate as number) ?? 0,
      avgMinutes: Math.round(((r.avg_ms as number) ?? 0) / 60_000),
    }));
  }

  /** Per-model × effort history for choosing reasoning depth. Kept separate from modelStats so sparse
   *  effort rows do not replace the stronger aggregate model prior in Settings or selection prompts. */
  modelEffortStats(workspace?: string): ModelEffortStat[] {
    const rows = this.raw.prepare(
      `SELECT provider, graded_model AS model, effort, COUNT(*) AS picks,
              AVG(score) AS avg_score,
              AVG(CASE WHEN outcome = 'done' THEN 1.0 ELSE 0.0 END) AS done_rate,
              AVG(COALESCE(qa_rounds, 0)) AS avg_qa,
              AVG(COALESCE(cost_usd, 0)) AS avg_cost,
              AVG(CASE WHEN token_usage_complete = 1 THEN total_tokens END) AS avg_total_tokens,
              AVG(CASE WHEN token_usage_complete = 1 THEN input_tokens END) AS avg_input_tokens,
              AVG(CASE WHEN token_usage_complete = 1 THEN output_tokens END) AS avg_output_tokens,
              AVG(CASE WHEN token_usage_complete = 1 THEN COALESCE(cache_read_input_tokens, 0) + COALESCE(cache_creation_input_tokens, 0) END) AS avg_cache_tokens,
              AVG(CASE WHEN token_usage_complete = 1 THEN reasoning_output_tokens END) AS avg_reasoning_tokens,
              AVG(CASE WHEN token_usage_complete = 1 THEN 1.0 ELSE 0.0 END) AS token_sample_rate,
              AVG(COALESCE(duration_ms, 0)) AS avg_ms
         FROM model_grades
        WHERE graded_model IS NOT NULL AND score IS NOT NULL${workspace ? " AND workspace = @workspace" : ""}
        GROUP BY provider, graded_model, effort
        ORDER BY picks DESC, avg_score DESC`,
    ).all(workspace ? { workspace } : {}) as Row[];
    return rows.map((r) => ({
      provider: r.provider as ModelEffortStat["provider"],
      model: r.model as string,
      effort: r.effort as Effort,
      picks: r.picks as number,
      avgScore: Math.round((r.avg_score as number) ?? 0),
      doneRate: (r.done_rate as number) ?? 0,
      avgQaRounds: Number(((r.avg_qa as number) ?? 0).toFixed(1)),
      avgCostUsd: Number(((r.avg_cost as number) ?? 0).toFixed(2)),
      avgTotalTokens: r.avg_total_tokens == null ? null : Math.round(r.avg_total_tokens as number),
      avgInputTokens: r.avg_input_tokens == null ? null : Math.round(r.avg_input_tokens as number),
      avgOutputTokens: r.avg_output_tokens == null ? null : Math.round(r.avg_output_tokens as number),
      avgCacheTokens: r.avg_cache_tokens == null ? null : Math.round(r.avg_cache_tokens as number),
      avgReasoningTokens: r.avg_reasoning_tokens == null ? null : Math.round(r.avg_reasoning_tokens as number),
      tokenSampleRate: (r.token_sample_rate as number) ?? 0,
      avgMinutes: Math.round(((r.avg_ms as number) ?? 0) / 60_000),
    }));
  }

  // ---- attachments (owner file bytes; served on demand over HTTP, refs over WS) ----
  /** Content-addressed: the same bytes under the same name/type reuse the stored row rather than adding
   *  another copy. One attachment legitimately hangs off several messages — the director's and every task it
   *  was dispatched to — and storing it per reference is what made blobs the biggest table in the DB.
   *  Keyed on name/type as well as the hash so a re-upload under a different name keeps its own filename
   *  when it's served back over /api/attachment/:id. */
  addAttachment(input: { name: string; mediaType: string; data: string }): AttachmentRef {
    const sha256 = sha256Of(input.data);
    const ref = { name: input.name, mediaType: input.mediaType };
    const existing = this.raw
      .prepare("SELECT id FROM attachments WHERE sha256 = ? AND name = ? AND media_type = ?")
      .get(sha256, input.name, input.mediaType) as Row | undefined;
    if (existing) return { id: existing.id as string, ...ref };
    const id = newId();
    this.raw
      .prepare(`INSERT INTO attachments(id, name, media_type, data, sha256, created_at) VALUES(?, ?, ?, ?, ?, ?)`)
      .run(id, input.name, input.mediaType, input.data, sha256, now());
    return { id, ...ref };
  }

  /** Delete any of `ids` no message points at any more. Blobs are shared, so a thread going away only
   *  frees the ones it held the last reference to — call this AFTER the referencing rows are gone. */
  private pruneAttachments(ids: string[]): void {
    if (!ids.length) return;
    const referenced = this.referencedAttachmentIds();
    const drop = this.raw.prepare("DELETE FROM attachments WHERE id = ?");
    for (const id of new Set(ids)) if (!referenced.has(id)) drop.run(id);
  }

  private referencedAttachmentIds(): Set<string> {
    const ids = new Set<string>();
    for (const table of REF_TABLES) {
      for (const r of this.raw.prepare(`SELECT attachments FROM ${table} WHERE attachments != '[]'`).all() as Row[]) {
        for (const ref of parseAttachments(r.attachments)) ids.add(ref.id);
      }
    }
    return ids;
  }

  private threadAttachmentIds(threadId: string): string[] {
    const rows = this.raw
      .prepare("SELECT attachments FROM messages WHERE thread_id = ? AND attachments != '[]'")
      .all(threadId) as Row[];
    return rows.flatMap((r) => parseAttachments(r.attachments).map((ref) => ref.id));
  }

  private coworkAttachmentIds(sessionId: string): string[] {
    const rows = this.raw
      .prepare("SELECT attachments FROM cowork_messages WHERE session_id = ? AND attachments != '[]'")
      .all(sessionId) as Row[];
    return rows.flatMap((r) => parseAttachments(r.attachments).map((ref) => ref.id));
  }

  getAttachment(id: string): { name: string; mediaType: string; data: string } | null {
    const r = this.raw.prepare("SELECT name, media_type, data FROM attachments WHERE id = ?").get(id) as Row | undefined;
    return r ? { name: r.name as string, mediaType: r.media_type as string, data: r.data as string } : null;
  }

  // ---- Director Supervisor: its own audit trail (orchestrator/supervisor.ts) ----

  /** Persist the owner message before any provider work starts. Target titles/states are snapshots, so
   * the conversation still reads correctly after a rename or eventual task purge. */
  createSupervisorChatTurn(input: { id?: string; content: string; targets: SupervisorChatTarget[] }): SupervisorChatTurn {
    const at = now();
    const turn: SupervisorChatTurn = {
      id: input.id ?? newId(),
      content: input.content,
      targets: input.targets,
      status: "pending",
      response: null,
      actionResults: [],
      usedAgent: false,
      costUsd: null,
      totalTokens: null,
      model: null,
      provider: null,
      createdAt: at,
      updatedAt: at,
    };
    this.raw
      .prepare(
        `INSERT INTO supervisor_chat_turns(id, content, targets, status, response, action_results, used_agent, cost_usd, total_tokens, model, provider, created_at, updated_at)
         VALUES(@id, @content, @targetsJson, @status, NULL, '[]', 0, NULL, NULL, NULL, NULL, @createdAt, @updatedAt)`,
      )
      .run({ ...turn, targetsJson: JSON.stringify(turn.targets) });
    return turn;
  }

  /** Update a pending turn as work progresses or settles. A fixed statement keeps every mutable field
   * explicit at this trust boundary; callers cannot smuggle a column name into dynamic SQL. */
  updateSupervisorChatTurn(
    id: string,
    patch: Partial<Pick<SupervisorChatTurn, "status" | "response" | "actionResults" | "usedAgent" | "costUsd" | "totalTokens" | "model" | "provider">>,
  ): SupervisorChatTurn | null {
    const current = this.getSupervisorChatTurn(id);
    if (!current) return null;
    const next: SupervisorChatTurn = { ...current, ...patch, updatedAt: now() };
    this.raw
      .prepare(
        `UPDATE supervisor_chat_turns
            SET status=@status, response=@response, action_results=@actionResultsJson,
                used_agent=@usedAgent, cost_usd=@costUsd, total_tokens=@totalTokens,
                model=@model, provider=@provider, updated_at=@updatedAt
          WHERE id=@id`,
      )
      .run({
        id,
        status: next.status,
        response: next.response ?? null,
        actionResultsJson: JSON.stringify(next.actionResults),
        usedAgent: next.usedAgent ? 1 : 0,
        costUsd: next.costUsd ?? null,
        totalTokens: next.totalTokens ?? null,
        model: next.model ?? null,
        provider: next.provider ?? null,
        updatedAt: next.updatedAt,
      });
    return next;
  }

  getSupervisorChatTurn(id: string): SupervisorChatTurn | null {
    const row = this.raw.prepare("SELECT * FROM supervisor_chat_turns WHERE id = ?").get(id) as Row | undefined;
    return row ? rowToSupervisorChatTurn(row) : null;
  }

  /** Recent UI slice, oldest first so it can render directly as a conversation. */
  listSupervisorChatTurns(limit = 100): SupervisorChatTurn[] {
    const rows = this.raw
      .prepare("SELECT * FROM supervisor_chat_turns ORDER BY created_at DESC, id DESC LIMIT ?")
      .all(limit) as Row[];
    return rows.map(rowToSupervisorChatTurn).reverse();
  }

  /** A process may die after an action but before its final reply is written. Replaying that request on
   * boot could duplicate an injection/resume, so orphaned pending turns fail closed and retain whatever
   * per-action results had already been checkpointed. */
  failPendingSupervisorChatTurns(): number {
    const at = now();
    const result = this.raw
      .prepare(
        `UPDATE supervisor_chat_turns
            SET status='failed',
                response=CASE
                  WHEN action_results = '[]' THEN 'The server restarted before the supervisor could finish. No action is recorded; resend this message if it is still needed.'
                  ELSE 'The server restarted after at least one action was recorded but before the supervisor could finish. Review the action results below before resending.'
                END,
                updated_at=?
          WHERE status='pending'`,
      )
      .run(at);
    return result.changes;
  }

  recordSupervisorEvent(input: {
    threadId?: string | null;
    threadTitle?: string | null;
    workspace?: string | null;
    trigger: SupervisorTrigger;
    kind: SupervisorEventKind;
    action?: SupervisorAction | null;
    summary: string;
    detail?: string | null;
    usedAgent?: boolean;
    costUsd?: number | null;
    totalTokens?: number | null;
    model?: string | null;
    notifiedDiscord?: boolean;
  }): SupervisorEvent {
    const e: SupervisorEvent = {
      id: newId(),
      threadId: input.threadId ?? null,
      threadTitle: input.threadTitle ?? null,
      workspace: input.workspace ?? null,
      trigger: input.trigger,
      kind: input.kind,
      action: input.action ?? null,
      summary: input.summary,
      detail: input.detail ?? null,
      usedAgent: input.usedAgent ?? false,
      costUsd: input.costUsd ?? null,
      totalTokens: input.totalTokens ?? null,
      model: input.model ?? null,
      notifiedDiscord: input.notifiedDiscord ?? false,
      createdAt: now(),
    };
    this.raw
      .prepare(
        `INSERT INTO supervisor_events(id, thread_id, thread_title, workspace, trigger, kind, action, summary, detail, used_agent, cost_usd, total_tokens, model, notified_discord, created_at)
         VALUES(@id, @threadId, @threadTitle, @workspace, @trigger, @kind, @action, @summary, @detail, @usedAgent, @costUsd, @totalTokens, @model, @notifiedDiscord, @createdAt)`,
      )
      .run({ ...e, usedAgent: e.usedAgent ? 1 : 0, notifiedDiscord: e.notifiedDiscord ? 1 : 0 });
    return e;
  }

  /** Newest first, capped — the transparency panel's recent list, not the full history. */
  listSupervisorEvents(limit = 100): SupervisorEvent[] {
    return (this.raw.prepare("SELECT * FROM supervisor_events ORDER BY created_at DESC LIMIT ?").all(limit) as Row[]).map(rowToSupervisorEvent);
  }

  /** Today's (since `sinceMs`) bounded-check-in usage — the supervisor's daily budget guardrail reads
   *  this instead of a separate counter, so the cap survives a restart with nothing extra to keep in sync. */
  supervisorBudgetToday(sinceMs: number): { checkins: number; costUsd: number; totalTokens: number } {
    const row = this.raw
      .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(cost_usd), 0) AS cost, COALESCE(SUM(total_tokens), 0) AS tokens FROM supervisor_events WHERE used_agent = 1 AND created_at >= ?")
      .get(sinceMs) as { n: number; cost: number; tokens: number };
    return { checkins: row.n, costUsd: row.cost, totalTokens: row.tokens };
  }

  /** How many distinct tasks the supervisor flagged with an owner-facing action (alert/recovery) in the
   *  last `sinceMs` window and haven't since settled — the transparency panel's "watching" count. */
  supervisorWatchingCount(sinceMs: number): number {
    const row = this.raw
      .prepare(
        `SELECT COUNT(DISTINCT se.thread_id) AS n
           FROM supervisor_events se
           JOIN threads t ON t.id = se.thread_id
          WHERE se.action IN ('alert', 'trigger_recovery') AND se.created_at >= ?
            AND t.state NOT IN ('done', 'cancelled', 'closed')`,
      )
      .get(sinceMs) as { n: number };
    return row.n;
  }

  /** The most recent supervisor pass (of any kind) over one task — the per-task cooldown read. */
  lastSupervisorEventAt(threadId: string): number | null {
    const row = this.raw.prepare("SELECT MAX(created_at) AS t FROM supervisor_events WHERE thread_id = ?").get(threadId) as { t: number | null };
    return row?.t ?? null;
  }

  /** Whether the supervisor has taken an owner-facing action (alert/recovery) on this task recently — used
   *  to decide whether its later `done` deserves the "closed the loop" phone notice. */
  lastSupervisorWatchAt(threadId: string): number | null {
    const row = this.raw
      .prepare("SELECT MAX(created_at) AS t FROM supervisor_events WHERE thread_id = ? AND action IN ('alert', 'trigger_recovery')")
      .get(threadId) as { t: number | null };
    return row?.t ?? null;
  }

  /** Whether a Discord notice already went out for this exact task+action recently — the per-(thread,
   *  action) dedupe/cooldown that keeps a flapping task from paging the phone repeatedly. */
  lastSupervisorNoticeAt(threadId?: string, action?: SupervisorAction): number | null {
    const row = threadId && action
      ? this.raw
          .prepare("SELECT MAX(created_at) AS t FROM supervisor_events WHERE thread_id = ? AND action = ? AND notified_discord = 1")
          .get(threadId, action) as { t: number | null }
      : this.raw.prepare("SELECT MAX(created_at) AS t FROM supervisor_events WHERE notified_discord = 1").get() as { t: number | null };
    return row?.t ?? null;
  }

  /** Epoch ms of the most recent task-visible activity, or null. Messages are the common progress
   *  signal, but findings/deliverables are durable task history too, so they also reset the
   *  supervisor's no-progress clock. */
  lastActivityAt(threadId: string): number | null {
    const row = this.raw
      .prepare(
        `SELECT MAX(t) AS t
           FROM (
             SELECT MAX(created_at) AS t FROM messages WHERE thread_id = ?
             UNION ALL
             SELECT MAX(created_at) AS t FROM findings WHERE thread_id = ?
           )`,
      )
      .get(threadId, threadId) as { t: number | null };
    return row?.t ?? null;
  }
}

function parseStageOutputs(raw: unknown): StageOutputs {
  if (typeof raw !== "string" || !raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as StageOutputs) : {};
  } catch {
    return {};
  }
}

function sha256Of(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

function parseAttachments(raw: unknown): AttachmentRef[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter(
      (x): x is AttachmentRef =>
        !!x && typeof x.id === "string" && typeof x.name === "string" && typeof x.mediaType === "string",
    );
  } catch {
    return [];
  }
}
