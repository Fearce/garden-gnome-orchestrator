import { z } from "zod";
import type {
  AgentRun,
  DirectorMessage,
  Finding,
  Message,
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
  stale?: boolean; // usage is from a snapshot/old cache, not a live read
  rateLimited: boolean;
  resetsAt?: number | null;
  active: boolean; // last/preferred account for dispatch
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
  z.object({ type: z.literal("thread.history"), threadId: z.string() }),
  z.object({ type: z.literal("thread.approve"), threadId: z.string(), approved: z.boolean(), feedback: z.string().optional() }),
  z.object({ type: z.literal("approval.set"), on: z.boolean() }),
  z.object({ type: z.literal("thread.changes"), threadId: z.string() }),
  z.object({ type: z.literal("snapshot.request") }),
]);

export type ClientCommand = z.infer<typeof clientCommandSchema>;
