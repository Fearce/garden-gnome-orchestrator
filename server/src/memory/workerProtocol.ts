import type { CardInput, UsageRecord } from "./indexStore.js";

export interface LunaRequest {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  prompt: string;
  timeoutMs: number;
}

export interface LunaResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

type Op =
  | { op: "sync"; force: boolean }
  | { op: "search"; query: string; limit: number }
  | { op: "file"; file: string }
  | { op: "findByName"; name: string }
  | { op: "list"; offset: number; limit: number; filter: string }
  | { op: "cardJobs"; limit: number; exclude: string[] }
  | { op: "storeCards"; cards: CardInput[] }
  | { op: "usage"; record: UsageRecord }
  | { op: "status" }
  | { op: "luna"; request: LunaRequest };

export type WorkerOp = Op;
export type WorkerRequest = (Op & { id: number }) | { op: "close" };
export type WorkerReply = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: string };
