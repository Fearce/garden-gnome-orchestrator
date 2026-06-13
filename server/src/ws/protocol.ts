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

export type ServerEvent =
  | { type: "hello"; threads: Thread[]; runs: AgentRun[]; findings: Finding[]; questions: Question[]; director: DirectorMessage[] }
  | { type: "thread.upsert"; thread: Thread }
  | { type: "thread.history"; threadId: string; messages: Message[]; findings: Finding[]; brief: string }
  | { type: "run.upsert"; run: AgentRun }
  | { type: "agent.delta"; threadId: string; runId: string; role: Role; text: string }
  | { type: "agent.text"; threadId: string; runId: string; role: Role; text: string }
  | { type: "agent.thinking"; threadId: string; runId: string; role: Role; text: string }
  | { type: "agent.tool"; threadId: string; runId: string; role: Role; name: string; input: unknown; id: string }
  | { type: "agent.tool_result"; threadId: string; runId: string; id: string; isError: boolean; preview: string }
  | { type: "finding"; finding: Finding }
  | { type: "question.ask"; question: Question }
  | { type: "question.resolved"; questionId: string; answer: string }
  | { type: "director.delta"; text: string }
  | { type: "director.message"; message: DirectorMessage }
  | { type: "director.tool"; name: string; input: unknown }
  | { type: "director.busy"; busy: boolean }
  | { type: "log"; level: "info" | "warn" | "error"; message: string };

// ---- Client -> Server commands (inbound; zod-validated) ----

export const clientCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("prompt.new"), text: z.string().min(1), workspace: z.string().optional() }),
  z.object({ type: z.literal("question.answer"), questionId: z.string(), answer: z.string() }),
  z.object({
    type: z.literal("thread.inject"),
    threadId: z.string(),
    message: z.string().min(1),
    mode: z.enum(["append", "interrupt"]).default("append"),
  }),
  z.object({ type: z.literal("thread.interrupt"), threadId: z.string() }),
  z.object({ type: z.literal("thread.resume"), threadId: z.string(), message: z.string().optional() }),
  z.object({ type: z.literal("thread.cancel"), threadId: z.string() }),
  z.object({ type: z.literal("thread.history"), threadId: z.string() }),
  z.object({ type: z.literal("snapshot.request") }),
]);

export type ClientCommand = z.infer<typeof clientCommandSchema>;
