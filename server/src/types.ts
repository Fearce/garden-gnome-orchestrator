// Shared domain types — the contract the whole server builds against.

export type Role = "director" | "planner" | "researcher" | "implementor" | "qa";

export type ThreadState =
  | "intake" // just created, brief not yet built
  | "enriching" // director is enriching / about to clarify
  | "queued" // dispatched but waiting for a concurrency slot (maxConcurrent)
  | "awaiting_user" // blocked on a question for the owner
  | "planning" // planner + researcher running
  | "researching"
  | "awaiting_approval" // plan ready, blocked on your approve/reject
  | "implementing" // implementor live
  | "qa" // QA reviewing/testing the implementor's work
  | "paused" // implementor interrupted, awaiting resume/inject
  | "review" // done but QA wasn't satisfied — needs the owner
  | "done"
  | "failed"
  | "cancelled"
  | "closed"; // soft-closed: kept in the DB (restorable) but off the main board; auto-purged after 30d

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
  closedAt?: number | null; // when soft-closed (state === "closed"); drives the 30-day auto-purge clock
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
  attachments?: AttachmentRef[];
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
  nextAgent?: "researcher" | "implementor"; // the planner routes the pipeline: external research, or straight to build
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
  facts: { claim: string; source?: string }[]; // external claims, each with the source it came from
  memories: { name: string; gist: string }[];
  warnings: string[];
}

/**
 * Per-stage pipeline outputs persisted to disk so a task that dies mid-pipeline (crash, restart,
 * timeout, Claude exit error) can resume from where it failed instead of redoing finished stages.
 * The implementor's "output" isn't JSON — it's the working tree plus its SDK session, recovered
 * from the latest implementor agent_run's session_id, so only the upstream stages live here.
 */
export interface StageOutputs {
  plan?: PlanOutput | null; // the planner's structured plan (null = planner ran but produced nothing)
  planDone?: boolean; // the planner stage ran (true even if it produced nothing) — don't re-run on resume
  research?: ResearchOutput | null; // the researcher's brief, when the planner routed to it
  researchDone?: boolean; // the researcher stage ran (true even if it produced nothing) — don't re-run on resume
  approved?: boolean; // the plan cleared the approval gate — don't re-prompt on resume
  kickoff?: string | null; // the composed brief the implementor was handed (record of what it got)
}

/**
 * Operator-tunable pipeline settings, persisted server-side in the `kv` table and broadcast to every
 * client (mirrors `approvalMode`). Read live at dispatch/pipeline time, so a change applies to the
 * next task without a restart — the agent toggles in particular are meant to be flipped per task.
 */
export interface OrchestratorSettings {
  plannerEnabled: boolean; // off → skip the planner; the implementor runs straight from the brief
  researcherEnabled: boolean; // off → never run the researcher even if the planner routes to it
  qaEnabled: boolean; // off → skip the QA loop; the implementor's output is final
  autoPush: boolean; // off → the implementor commits but does NOT push (overrides the push doctrine)
  maxQaRounds: number; // implementor↔QA fix-rounds before a task settles to review
  maxConcurrent: number; // max pipelines running at once; further dispatches wait in 'queued'
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
