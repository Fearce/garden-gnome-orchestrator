import { apiUrl } from "./base.js";

// Settings → Memory talks to /api/memory/* over plain HTTP: memory is file-backed and changes rarely, so
// it has no place in the WebSocket snapshot every client receives.

export type MemoryType = "user" | "feedback" | "project" | "reference";
export const MEMORY_TYPES: readonly MemoryType[] = ["user", "feedback", "project", "reference"];

export interface MemorySettings {
  modelRanking: boolean;
  cards: boolean;
  extraction: boolean;
  lunaFallback: boolean;
  agentRecall: boolean;
}

export interface ProviderState {
  available: boolean;
  detail: string;
  lastOkAt: number | null;
  lastError: string | null;
}

export interface UsageSummary {
  provider: string;
  model: string;
  purpose: string;
  calls: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
}

export type JobState = "idle" | "running" | "waiting-for-capacity" | "disabled";

export interface MemoryStatus {
  dir: string;
  indexPath: string;
  workerRunning: boolean;
  index: {
    files: number;
    chunks: number;
    cards: number;
    staleCards: number;
    missingCards: number;
    lastSyncAt: number | null;
    usageToday: UsageSummary[];
    usage7d: UsageSummary[];
  };
  providers: { haiku: ProviderState; luna: ProviderState } | null;
  cards: { state: JobState; builtThisRun: number; lastError: string | null; nextAttemptAt: number | null } | null;
  extraction: { pending: number; state: JobState; lastRunAt: number | null; lastAdded: number; lastError: string | null } | null;
  settings: MemorySettings;
}

export interface MemoryFile {
  file: string;
  name: string;
  description: string;
  type: string;
  createdAt: string;
  lastVerified: string;
  source: string;
  size: number;
  mtimeMs: number;
}

export type RecallMode = "search" | "prompt" | "session";

export interface RecallHit {
  file: string;
  name: string;
  description: string;
  type: string;
  lastVerified: string;
  score: number;
  judgedBy: "model" | "lexical";
}

export interface RecallResponse {
  memories: RecallHit[];
  model: string | null;
  fallbackReason: string | null;
  cached: boolean;
  ms: number;
}

export interface MemoryDraft {
  type: MemoryType;
  name: string;
  description: string;
  body: string;
}

async function call<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(apiUrl(path), {
    method: init?.method ?? "GET",
    cache: "no-store",
    headers: init?.body === undefined ? undefined : { "content-type": "application/json" },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data as T;
}

const filePath = (file: string) => `/api/memory/files/${encodeURIComponent(file)}`;

export const memoryApi = {
  status: () => call<MemoryStatus>("/api/memory/status"),
  setSettings: (patch: Partial<MemorySettings>) => call<MemorySettings>("/api/memory/settings", { method: "PUT", body: patch }),
  search: (query: string, mode: RecallMode, limit = 8) => call<RecallResponse>("/api/memory/search", { method: "POST", body: { query, mode, limit } }),
  list: (offset: number, limit: number, filter: string) =>
    call<{ total: number; files: MemoryFile[] }>(`/api/memory/files?offset=${offset}&limit=${limit}&filter=${encodeURIComponent(filter)}`),
  get: (file: string) => call<{ meta: MemoryFile | null; text: string }>(filePath(file)),
  create: (draft: MemoryDraft) => call<{ ok: true; file: string }>("/api/memory/files", { method: "POST", body: draft }),
  update: (file: string, draft: Partial<MemoryDraft>) => call<{ ok: true; file: string }>(filePath(file), { method: "PATCH", body: draft }),
  remove: (file: string) => call<{ ok: true; trashedAs: string }>(filePath(file), { method: "DELETE" }),
  reindex: () => call<{ ok: true }>("/api/memory/reindex", { method: "POST" }),
};

/** The body of a memory file: everything after its frontmatter. */
export function memoryBody(text: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text);
  return (match ? text.slice(match[0].length) : text).trim();
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}
