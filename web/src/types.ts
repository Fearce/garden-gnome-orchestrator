// Mirror of the server's protocol + domain types (kept in sync by hand).

export type Role = "director" | "planner" | "researcher" | "implementor" | "qa";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type ThreadState =
  | "intake"
  | "enriching"
  | "awaiting_user"
  | "planning"
  | "researching"
  | "awaiting_approval"
  | "implementing"
  | "qa"
  | "paused"
  | "review"
  | "done"
  | "failed"
  | "cancelled"
  | "closed";

export type AgentRunState = "starting" | "running" | "idle" | "interrupted" | "done" | "error";
export type Severity = "info" | "note" | "warning" | "critical";

export interface Thread {
  id: string;
  title: string;
  state: ThreadState;
  workspace: string;
  brief: string;
  rawPrompt: string;
  error?: string | null;
  closedAt?: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface AgentRun {
  id: string;
  threadId: string;
  role: Role;
  model: string;
  account?: string | null;
  effort?: Effort | null;
  sessionId?: string | null;
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
  threadId: string | null;
  runId?: string | null;
  header: string;
  question: string;
  options: QuestionOption[];
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
  routed: boolean;
  createdAt: number;
}

export interface ImageAttachment {
  name: string;
  mediaType: string;
  dataBase64: string;
}

export interface AttachmentRef {
  id: string;
  name: string;
  mediaType: string;
}

export interface DirectorMessage {
  id: string;
  role: "user" | "director";
  kind: string;
  content: string;
  attachments?: AttachmentRef[];
  createdAt: number;
}

export interface Message {
  id: string;
  threadId: string;
  runId?: string | null;
  role: Role | "user";
  kind: "text" | "tool" | "result" | "system";
  content: string;
  attachments?: AttachmentRef[];
  createdAt: number;
}

export interface AccountDTO {
  id: string;
  label: string;
  fiveHour: number | null;
  sevenDay: number | null;
  fiveHourReset?: number | null;
  sevenDayReset?: number | null;
  stale?: boolean;
  rateLimited: boolean;
  resetsAt?: number | null;
  active: boolean;
  updatedAt: number;
  error?: string | null;
}

export type ServerEvent =
  | {
      type: "hello";
      threads: Thread[];
      runs: AgentRun[];
      findings: Finding[];
      questions: Question[];
      director: DirectorMessage[];
      accounts: AccountDTO[];
      approvalMode: boolean;
    }
  | { type: "accounts"; accounts: AccountDTO[] }
  | { type: "plan.ready"; threadId: string; brief: string }
  | { type: "approval.mode"; on: boolean }
  | { type: "thread.changes"; threadId: string; diff: string; log: string }
  | { type: "thread.upsert"; thread: Thread }
  | { type: "thread.removed"; threadId: string }
  | { type: "thread.message"; threadId: string; message: Message }
  | { type: "thread.history"; threadId: string; messages: Message[]; findings: Finding[]; brief: string }
  | { type: "run.upsert"; run: AgentRun }
  | { type: "agent.delta"; threadId: string; runId: string; role: Role; text: string }
  | { type: "agent.text"; threadId: string; runId: string; role: Role; text: string; messageId: string }
  | { type: "agent.thinking"; threadId: string; runId: string; role: Role; text: string }
  | { type: "agent.tool"; threadId: string; runId: string; role: Role; name: string; input: unknown; id: string; messageId: string }
  | { type: "agent.tool_result"; threadId: string; runId: string; id: string; isError: boolean; preview: string; messageId: string }
  | { type: "finding"; finding: Finding }
  | { type: "question.ask"; question: Question }
  | { type: "question.resolved"; questionId: string; answer: string }
  | { type: "director.delta"; text: string }
  | { type: "director.message"; message: DirectorMessage }
  | { type: "director.tool"; name: string; input: unknown }
  | { type: "director.busy"; busy: boolean }
  | { type: "log"; level: "info" | "warn" | "error"; message: string };

export type ClientCommand =
  | { type: "prompt.new"; text: string; workspace?: string; images?: ImageAttachment[] }
  | { type: "question.answer"; questionId: string; answer: string }
  | { type: "thread.inject"; threadId: string; message: string; mode: "append" | "interrupt"; images?: ImageAttachment[] }
  | { type: "thread.interrupt"; threadId: string }
  | { type: "thread.resume"; threadId: string; message?: string }
  | { type: "thread.cancel"; threadId: string }
  | { type: "thread.markDone"; threadId: string }
  | { type: "thread.close"; threadId: string }
  | { type: "thread.restore"; threadId: string }
  | { type: "thread.dismiss"; threadId: string }
  | { type: "thread.history"; threadId: string }
  | { type: "thread.approve"; threadId: string; approved: boolean; feedback?: string }
  | { type: "approval.set"; on: boolean }
  | { type: "thread.changes"; threadId: string }
  | { type: "snapshot.request" };

// ---- client-only view models ----

// `id` (when present) is the stable DB message-row id used to dedup a live-streamed
// item against the same message re-delivered by thread.history. The tool_result's
// separate `id` is the SDK tool-use id (correlates a result to its tool call); its
// `messageId` is the DB row id used for the same dedup.
export type FeedItem =
  | { kind: "text"; at: number; role: Role; runId: string; id?: string; text: string }
  | { kind: "tool"; at: number; role: Role; runId: string; id?: string; name: string; input: unknown }
  | { kind: "tool_result"; at: number; runId: string; id: string; messageId?: string; isError: boolean; preview: string }
  | { kind: "finding"; at: number; finding: Finding }
  | { kind: "system"; at: number; id?: string; text: string; role?: Role; attachments?: AttachmentRef[] };

export interface DirectorItem {
  id: string;
  kind: "user" | "director" | "tool";
  text: string;
  toolName?: string;
  attachments?: AttachmentRef[];
  at: number;
}
