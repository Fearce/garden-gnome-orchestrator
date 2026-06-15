// Shared domain types — the contract the whole server builds against.

export type Role = "director" | "planner" | "researcher" | "implementor" | "qa";

export type ThreadState =
  | "intake" // just created, brief not yet built
  | "enriching" // director is enriching / about to clarify
  | "awaiting_user" // blocked on a question for the user
  | "planning" // planner + researcher running
  | "researching"
  | "awaiting_approval" // plan ready, blocked on your approve/reject
  | "implementing" // implementor live
  | "qa" // QA reviewing/testing the implementor's work
  | "paused" // implementor interrupted, awaiting resume/inject
  | "review" // done but QA wasn't satisfied — needs the user
  | "done"
  | "failed"
  | "cancelled";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type AgentRunState =
  | "starting"
  | "running"
  | "idle"
  | "interrupted"
  | "done"
  | "error";

export type Severity = "info" | "note" | "warning" | "critical";

export interface Thread {
  id: string;
  title: string;
  state: ThreadState;
  workspace: string; // target repo cwd for the implementor
  brief: string; // enriched brief that kicked off the pipeline
  rawPrompt: string; // the user's original ask
  error?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface AgentRun {
  id: string;
  threadId: string;
  role: Role;
  model: string;
  account?: string | null; // which subscription account ran it
  effort?: Effort | null; // planner-chosen effort (implementor); null for other roles
  sessionId?: string | null; // Claude SDK session id, for resume/fork
  state: AgentRunState;
  costUsd?: number | null;
  numTurns?: number | null;
  error?: string | null;
  startedAt: number;
  endedAt?: number | null;
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface Question {
  id: string;
  threadId: string | null; // null = a director-level question
  runId?: string | null;
  header: string;
  question: string;
  options: QuestionOption[]; // empty => free-text answer
  multiSelect: boolean;
  answer?: string | null;
  answeredAt?: number | null;
  createdAt: number;
}

export interface Finding {
  id: string;
  threadId: string;
  fromRunId?: string | null;
  fromRole?: Role | null;
  summary: string;
  detail?: string | null;
  severity: Severity;
  routed: boolean; // delivered/injected somewhere already
  createdAt: number;
}

export type MessageKind = "text" | "tool" | "result" | "system";

export interface Message {
  id: string;
  threadId: string;
  runId?: string | null;
  role: Role | "user";
  kind: MessageKind;
  content: string;
  createdAt: number;
}

export interface DirectorMessage {
  id: string;
  role: "user" | "director";
  kind: MessageKind;
  content: string;
  attachments?: AttachmentRef[];
  createdAt: number;
}

export type ImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

/** An image the user pasted/dropped, carried inline (base64) from the GUI on send. */
export interface ImageAttachment {
  name: string;
  mediaType: ImageMediaType;
  dataBase64: string;
}

/** Lightweight reference to a stored attachment — carried over WS instead of the bytes. */
export interface AttachmentRef {
  id: string;
  name: string;
  mediaType: string;
}

// ---- Structured outputs from planner / researcher ----

export interface PlanStep {
  title: string;
  detail: string;
  files?: string[];
}

export interface PlanOutput {
  summary: string;
  steps: PlanStep[];
  risks: string[];
  openQuestions: string[];
  effort?: Effort; // how hard the implementor should work
  parallelism?: string; // guidance on spawning subagents / parallel work
}

export interface QaIssue {
  severity?: string;
  description: string;
  location?: string;
}

export interface QaOutput {
  pass: boolean;
  summary: string;
  issues?: QaIssue[];
}

export interface ResearchOutput {
  summary: string;
  relevantFiles: { path: string; why: string }[];
  facts: { claim: string; source?: string }[];
  memories: { name: string; gist: string }[];
  warnings: string[];
}

export interface RateLimitInfo {
  status: "allowed" | "allowed_warning" | "rejected";
  resetsAt?: number;
  rateLimitType?: "five_hour" | "seven_day" | "seven_day_opus" | "seven_day_sonnet" | "overage";
  utilization?: number;
}

// ---- Normalized agent stream events (decoupled from SDK message shapes) ----

export type AgentEvent =
  | { type: "init"; sessionId: string }
  | { type: "text_delta"; text: string }
  | { type: "text"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; content: unknown; isError: boolean }
  | { type: "permission_request"; requestId: string; toolName: string; input: unknown }
  | { type: "rate_limit"; info: RateLimitInfo }
  | { type: "question"; question: Question }
  | {
      type: "result";
      subtype: string;
      isError: boolean;
      result?: string;
      structuredOutput?: unknown;
      costUsd?: number;
      numTurns?: number;
    }
  | { type: "error"; message: string };
