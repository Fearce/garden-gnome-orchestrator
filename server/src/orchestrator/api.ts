import type { Db } from "../db/db.js";
import type { EventHub } from "../events.js";
import type { MemoryService } from "../memory/memory.js";
import type { ChatMessage, ChatScope, Effort, Finding, FindingKind, ImageAttachment, QuestionOption, Role, Severity, Thread, ThreadLane } from "../types.js";

export interface DispatchInput {
  title: string;
  workspace: string;
  brief: string;
  images?: ImageAttachment[];
  effort?: Effort; // pins the implementor effort for this task (skip-director composer pick) — beats the planner's
  lane?: ThreadLane | null; // 'read' routes to the single read-only reader lane (dispatch_read); null/undefined = the normal pipeline
}

export interface AskUserInput {
  threadId: string | null;
  runId?: string | null;
  header: string;
  question: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

export interface PostFindingInput {
  threadId: string;
  fromRole: Role;
  fromRunId?: string | null;
  kind?: FindingKind; // 'deliverable' surfaces a produced file in the right-panel Deliverables section
  summary: string;
  detail?: string | null;
  path?: string | null; // deliverable only — file path (absolute or relative to the task workspace)
  label?: string | null; // deliverable only — human-readable label
  severity?: Severity;
}

export interface ThreadActionResult {
  ok: boolean;
  error?: string;
  state?: string;
}

export interface ChatPostInput {
  threadId: string;
  runId?: string | null;
  role: Role;
  scope: ChatScope; // 'general' = the whole office; 'project' = this task's per-repo room
  body: string;
}

export interface ChatReadInput {
  threadId: string;
  scope?: ChatScope | "all";
  limit?: number;
}

/** One coworker (or self) in the office, from the caller's point of view. */
export interface RosterEntry {
  threadId: string;
  name: string; // the gnome name this task goes by in the office
  title: string;
  workspace: string;
  role: Role;
  sameRepo: boolean; // shares the caller's workspace — a teammate in the project room
  self: boolean;
}

/**
 * The surface the MCP tools (director + bus) call into. ThreadManager
 * implements it; the tools depend only on this interface, so there is no import
 * cycle between the tools and the manager.
 */
export interface OrchestratorApi {
  readonly db: Db;
  readonly hub: EventHub;
  readonly memory: MemoryService;

  /** Block until the user answers in the GUI; returns the answer text. */
  askUser(input: AskUserInput): Promise<string>;

  /** Create a thread and kick off its pipeline. Returns the new thread id. */
  dispatch(input: DispatchInput): Promise<string>;

  listThreads(): Thread[];
  getThread(id: string): Thread | null;

  /** Record a finding and route it (inject into a live implementor if apt). */
  postFinding(input: PostFindingInput): Finding;

  /** Post a message to the office (general room) or this task's project room; broadcasts it live. */
  chatPost(input: ChatPostInput): ChatMessage;

  /** Read recent office chat from the caller's perspective (general, this task's project room, or both). */
  chatRead(input: ChatReadInput): ChatMessage[];

  /** Who else is in the office right now (active agents), from a task's point of view. */
  officeRoster(threadId: string): RosterEntry[];

  /** The office name one of a task's agents (a role) currently goes by — its picked name, or the
   *  deterministic per-(thread, role) default. Each role in a task is a distinct agent with its own name. */
  officeName(threadId: string, role: Role): string;

  /** The director persona's operator-chosen display name (from Settings; default "ChangeNameInSettings"). */
  directorName(): string;

  /** The model a role should run on for a given subscription id (per-sub override → global default →
   *  built-in config.models). Used so the director runs on the operator's picked model. */
  modelFor(subId: string, role: Role): string;

  /** Let an agent pick/rename its own office gnome (per role); returns the stored name (trimmed/clamped). */
  setOfficeName(threadId: string, role: Role, name: string): string;

  injectThread(
    threadId: string,
    message: string,
    mode: "append" | "interrupt" | "queue",
    images?: ImageAttachment[],
  ): Promise<ThreadActionResult>;
  interruptThread(threadId: string): Promise<ThreadActionResult>;
  resumeThread(threadId: string, message?: string): Promise<ThreadActionResult>;
  cancelThread(threadId: string): Promise<ThreadActionResult>;
  retryThread(threadId: string): Promise<ThreadActionResult>;
}
