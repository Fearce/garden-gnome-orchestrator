import { z } from "zod";
import type { CodexUsageDTO } from "../agents/codexUsage.js";
import type {
  AgentRun,
  ChatMessage,
  ChatRoomSummary,
  DirectorMessage,
  Finding,
  Message,
  OrchestratorSettings,
  Question,
  Role,
  Thread,
} from "../types.js";

// ---- Server -> Client events (outbound; not validated) ----

export interface AccountDTO {
  id: string;
  label: string;
  fiveHour: number | null; // utilization 0-100
  sevenDay: number | null; // utilization 0-100
  fiveHourReset?: number | null; // epoch ms the 5h window rolls over
  sevenDayReset?: number | null; // epoch ms the weekly window rolls over
  stale?: boolean; // usage is from a snapshot/old cache, not a live read
  rateLimited: boolean;
  resetsAt?: number | null;
  active: boolean; // last/preferred account for dispatch
  enabled: boolean; // operator toggle — a disabled account is held out of dispatch/failover
  updatedAt: number;
  error?: string | null;
}

export type { CodexUsageDTO } from "../agents/codexUsage.js";

export type ServerEvent =
  | {
      type: "hello";
      threads: Thread[];
      runs: AgentRun[];
      findings: Finding[];
      questions: Question[];
      director: DirectorMessage[];
      accounts: AccountDTO[];
      codexUsage: CodexUsageDTO | null;
      approvalMode: boolean;
      settings: OrchestratorSettings;
      chat: ChatMessage[];
      chatRooms: ChatRoomSummary[];
      nameOverrides: Record<string, string>;
    }
  | { type: "accounts"; accounts: AccountDTO[] }
  | { type: "codex.usage"; usage: CodexUsageDTO | null }
  | { type: "chat.message"; message: ChatMessage }
  | { type: "chat.history"; room: string; messages: ChatMessage[] }
  | { type: "chat.name"; threadId: string; name: string }
  | { type: "plan.ready"; threadId: string; brief: string }
  | { type: "approval.mode"; on: boolean }
  | { type: "settings"; settings: OrchestratorSettings }
  | { type: "codex.test.result"; ok: boolean; message: string }
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

// ---- Client -> Server commands (inbound; zod-validated) ----

const imageAttachmentSchema = z.object({
  name: z.string(),
  mediaType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
  dataBase64: z.string(),
});
const imagesField = z.array(imageAttachmentSchema).max(8).optional();

export const clientCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("prompt.new"), text: z.string().min(1), workspace: z.string().optional(), images: imagesField }),
  // Skip-director mode: bypass the Sonnet director and dispatch the message straight into the pipeline
  // (its first active stage — planner if enabled, else the implementor). workspace is required since
  // there's no director to resolve one.
  z.object({ type: z.literal("prompt.direct"), text: z.string().min(1), workspace: z.string().optional(), images: imagesField }),
  z.object({ type: z.literal("question.answer"), questionId: z.string(), answer: z.string() }),
  z.object({
    type: z.literal("thread.inject"),
    threadId: z.string(),
    message: z.string().min(1),
    mode: z.enum(["append", "interrupt"]).default("append"),
    images: imagesField,
  }),
  z.object({ type: z.literal("thread.interrupt"), threadId: z.string() }),
  z.object({ type: z.literal("thread.resume"), threadId: z.string(), message: z.string().optional() }),
  z.object({ type: z.literal("thread.cancel"), threadId: z.string() }),
  z.object({ type: z.literal("thread.markDone"), threadId: z.string() }),
  z.object({ type: z.literal("thread.close"), threadId: z.string() }),
  z.object({ type: z.literal("thread.restore"), threadId: z.string() }),
  z.object({ type: z.literal("thread.dismiss"), threadId: z.string() }),
  z.object({ type: z.literal("thread.history"), threadId: z.string() }),
  z.object({ type: z.literal("thread.approve"), threadId: z.string(), approved: z.boolean(), feedback: z.string().optional() }),
  z.object({ type: z.literal("approval.set"), on: z.boolean() }),
  z.object({
    type: z.literal("settings.set"),
    settings: z
      .object({
        plannerEnabled: z.boolean(),
        researcherEnabled: z.boolean(),
        qaEnabled: z.boolean(),
        autoPush: z.boolean(),
        maxQaRounds: z.number().int().min(1).max(12),
        maxConcurrent: z.number().int().min(1).max(20),
        codexEnabled: z.boolean(),
        codexModel: z.string().min(1).max(64),
        // Write-only: the raw OpenAI key is accepted here and stored server-side, never echoed back.
        // An empty string clears it. The broadcast OrchestratorSettings carries only hasOpenaiKey/last4.
        openaiApiKey: z.string().max(300),
      })
      .partial(),
  }),
  // Validate the stored (or just-typed) OpenAI key against the API; replies with codex.test.result.
  z.object({ type: z.literal("codex.test"), apiKey: z.string().max(300).optional() }),
  // Toggle a Claude account in/out of the dispatch+failover rotation (per-account subscription switch).
  z.object({ type: z.literal("account.set"), id: z.string(), enabled: z.boolean() }),
  z.object({ type: z.literal("thread.changes"), threadId: z.string() }),
  // Fetch the full message history for one office room (the expanded chatroom view / a task's button).
  z.object({ type: z.literal("chat.history"), room: z.string().min(1).max(300) }),
  // Post into a room AS THE DIRECTOR (the human): lands in the chat and is pushed to the live agents
  // in that room so they self-coordinate who acts on it. room "general" = the whole office.
  z.object({ type: z.literal("chat.post"), room: z.string().min(1).max(300), body: z.string().min(1).max(2000) }),
  z.object({ type: z.literal("snapshot.request") }),
]);

export type ClientCommand = z.infer<typeof clientCommandSchema>;
