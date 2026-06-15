import type { Db } from "../db/db.js";
import type { EventHub } from "../events.js";
import type { MemoryService } from "../memory/memory.js";
import type { Finding, ImageAttachment, QuestionOption, Role, Severity, Thread } from "../types.js";

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
