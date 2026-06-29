import type { Db } from "../db/db.js";
import type { EventHub } from "../events.js";
import type { MemoryService } from "../memory/memory.js";
import type { ChatMessage, ChatScope, Finding, ImageAttachment, QuestionOption, Role, Severity, Thread } from "../types.js";

export interface DispatchInput {
  title: string;
  workspace: string;
  brief: string;
  images?: ImageAttachment[];
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
  summary: string;
  detail?: string | null;
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

  /** The office name a task currently goes by (its picked name, or the deterministic default). */
  officeName(threadId: string): string;

  /** Let an agent pick/rename its office gnome; returns the stored name (trimmed/clamped). */
  setOfficeName(threadId: string, name: string): string;

  injectThread(
    threadId: string,
    message: string,
    mode: "append" | "interrupt",
    images?: ImageAttachment[],
  ): Promise<ThreadActionResult>;
  interruptThread(threadId: string): Promise<ThreadActionResult>;
  resumeThread(threadId: string, message?: string): Promise<ThreadActionResult>;
  cancelThread(threadId: string): Promise<ThreadActionResult>;
}
