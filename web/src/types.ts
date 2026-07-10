// Mirror of the server's protocol + domain types (kept in sync by hand).

export type Role = "director" | "planner" | "researcher" | "implementor" | "qa";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];
export type CodexEffort = "low" | "medium" | "high" | "xhigh";
export const CODEX_EFFORTS: CodexEffort[] = ["low", "medium", "high", "xhigh"];

export type ThreadState =
  | "intake"
  | "enriching"
  | "queued"
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

/** A normal blackboard finding, or a `deliverable` — a file the agent produced, surfaced in the
 *  right panel's Deliverables section for inline preview / download (mirrors the server's FindingKind). */
export type FindingKind = "finding" | "deliverable";

export interface Thread {
  id: string;
  title: string;
  state: ThreadState;
  workspace: string;
  brief: string;
  rawPrompt: string;
  error?: string | null;
  closedAt?: number | null;
  closedPrevState?: ThreadState | null; // the state a closed task came from — 'done' marks a successful close
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
  kind: FindingKind; // 'finding' (default) or 'deliverable' (a produced file surfaced for view/download)
  summary: string;
  detail?: string | null;
  path?: string | null; // deliverable only — file path (absolute or relative to the task workspace)
  label?: string | null; // deliverable only — human-readable label
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
  // The task this message's turn dispatched, if any — lets a search hit jump to the task. May dangle
  // (the task was purged); the UI only offers the jump when the thread still exists in the store.
  threadId?: string | null;
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

// ---- the office: cross-agent chat ----

export type ChatScope = "general" | "project";

/** A keyset cursor into a room's history — fetch the page just older than this (createdAt, id).
 *  Mirrors ChatCursor in server/src/types.ts. */
export interface ChatCursor {
  createdAt: number;
  id: string;
}

/** Messages per history page — mirrors CHAT_PAGE_SIZE in server/src/types.ts. Bounds the pre-load
 *  placeholder slice so the initial view already matches the first fetched page (no shrink flash). */
export const CHAT_PAGE_SIZE = 50;

export interface ChatMessage {
  id: string;
  room: string;
  scope: ChatScope;
  workspace?: string | null;
  threadId?: string | null;
  runId?: string | null;
  role: Role | "system";
  kind: "chat" | "system";
  body: string;
  senderName?: string | null;
  createdAt: number;
}

// Mirror of the server's GNOME_NAMES + gnomeName + agentKey (server/src/types.ts) so the office UI shows
// the same default name the agent itself was told. Each role in a task is a distinct agent with its own
// name, keyed by (thread, role); picked-name overrides arrive via `nameOverrides`/chat.name.
export const GNOME_NAMES = [
  "Pip", "Nim", "Bram", "Tova", "Fen", "Sol", "Rune", "Liv", "Ask", "Eir",
  "Odd", "Sten", "Tor", "Una", "Yara", "Knut", "Hilda", "Mads", "Sif", "Juni",
  "Lumi", "Pax", "Wren", "Zia", "Ole", "Greta", "Finn", "Bo", "Vik", "Saga",
] as const;

/** Identity key for one agent — a (thread, role) pair. Mirrors the server; the `nameOverrides` map is
 *  keyed by this, so distinct roles of one task never collapse to a single name. */
export function agentKey(threadId: string, role: Role): string {
  return `${threadId}::${role}`;
}

/** Mirror of the server's ROLE_RANK — offsets each role's default name so a task's roles map to
 *  consecutive (distinct) names. */
const ROLE_RANK: Record<Role, number> = { director: 0, planner: 1, researcher: 2, implementor: 3, qa: 4 };

export function gnomeName(threadId: string, role: Role): string {
  let h = 0;
  for (let i = 0; i < threadId.length; i++) h = (h * 31 + threadId.charCodeAt(i)) >>> 0;
  return GNOME_NAMES[(h + ROLE_RANK[role]) % GNOME_NAMES.length]!;
}

/** The office name to show for one of a task's agents: its picked/assigned override, else the
 *  deterministic per-(thread, role) default. The single place the UI resolves a name. */
export function agentName(overrides: Record<string, string>, threadId: string, role: Role): string {
  return overrides[agentKey(threadId, role)] ?? gnomeName(threadId, role);
}

export interface ChatRoomSummary {
  room: string;
  workspace: string;
  threadIds: string[];
  messageCount: number;
  lastAt: number;
}

export const GENERAL_ROOM = "general";

/** Normalize a workspace path to a stable room/grouping key — mirrors the server's normalizeWorkspace
 *  so the office UI groups exactly the same gnomes the server forms project rooms for. */
export function normalizeWorkspace(p: string): string {
  return p.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
}

export function repoRoom(workspace: string): string {
  return "repo:" + normalizeWorkspace(workspace);
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
  enabled: boolean; // operator toggle — disabled accounts are held out of dispatch/failover
  holdUntil?: number | null; // 5h window idle (stagger hold-off) — the next window starts at this epoch ms
  updatedAt: number;
  error?: string | null;
}

/** Codex (ChatGPT-plan) usage windows — mirrors the server's CodexUsageDTO. `fiveHour` is the rolling
 *  5-hour window, `sevenDay` the weekly one, both 0-100 used-percent with epoch-ms resets. Sourced from
 *  the codex session rollouts AND a periodic live app-server read, so it stays current between runs. */
export interface CodexUsageDTO {
  fiveHour: number | null;
  sevenDay: number | null;
  fiveHourReset: number | null;
  sevenDayReset: number | null;
  planType: string | null;
  updatedAt: number;
}

/** Operator-tunable pipeline settings — server-authoritative (persisted in the DB kv table, broadcast
 *  to every client). Mirrors the server's OrchestratorSettings. */
export interface OrchestratorSettings {
  plannerEnabled: boolean;
  researcherEnabled: boolean;
  qaEnabled: boolean;
  autoPush: boolean;
  directorName: string; // the director persona's display name, operator-set (default "ChangeNameInSettings")
  maxQaRounds: number;
  maxConcurrent: number;
  // Token-usage safety limit: opt-in auto-stop when live utilization reaches the threshold. Disabled by
  // default; the percent is clamped 50–99 (default 80) and compared against the live rate-limit burn.
  tokenLimitEnabled: boolean;
  tokenLimitPercent: number;
  // Auto-resume on token-window reset: when usage crosses the threshold, arm a wakeup at the reset that
  // resumes work frozen on the cap. Opt-in (off by default); the percent is clamped 50–95 (default 80).
  autoResumeOnTokenReset: boolean;
  autoResumeThresholdPercent: number;
  // Subscriptions: which provider backs the implementor (server-authoritative hard gate). Claude is the
  // default backend; individual Claude accounts toggle via AccountDTO.enabled (account.set), not here.
  codexEnabled: boolean;
  codexModel: string;
  codexEffort: CodexEffort;
  hasOpenaiKey: boolean; // read-only: a key is stored (raw key never reaches the client)
  openaiKeyLast4?: string | null; // read-only: last 4 chars for the masked field
  codexChatgptLogin: boolean; // read-only: a ChatGPT-plan `codex login` is available (preferred over a key)
  // Composer state persisted server-side (survives across the HTTP/HTTPS surfaces, which don't share
  // localStorage): the skip-director mode, the recent-repo chip cap, and the recent-repo list itself.
  skipDirector: boolean;
  showComposerModelPicker: boolean; // when on, the director composer exposes compact Claude/Codex implementor model dropdowns
  showAgentModel: boolean; // when on, agent labels in the thread feed append the run's model + effort — "QA (Tor, Opus 4.8 High)"
  skipDirectorEffort: Effort | "auto"; // composer's implementor effort for skip-director dispatches — "auto" leaves it to the planner
  xhighEnabled: boolean; // read-only: the server's ENABLE_XHIGH opt-in is on, so the xhigh tier is offerable
  skipDirectorRetitle: boolean; // when skip-director is on, mint a real title via a cheap Haiku call instead of the raw first line
  maxRecentRepos: number;
  recentRepos: string[];
  // Per-(subscription × role) model picks. See ModelOverrides. modelDefaults/claudeModels/codexModels
  // are read-only (server-derived): the built-in per-role defaults and the pickable model lists.
  modelOverrides: ModelOverrides;
  modelDefaults: Partial<Record<Role, string>>;
  claudeModels: string[];
  codexModels: string[];
}

/** The five agent roles a model can be picked for. Mirrors the server's MODEL_ROLES. */
export const MODEL_ROLES: Role[] = ["director", "planner", "researcher", "implementor", "qa"];

/** Which model each role runs on, per subscription. Keyed by subscription id — a Claude account id,
 *  "codex", or "default" (the global per-role fallback). Mirrors the server's ModelOverrides. */
export type ModelOverrides = Record<string, Partial<Record<Role, string>>>;

/** Subscription-id sentinels for the model matrix (mirror the server). */
export const DEFAULT_SUB_ID = "default";
export const CODEX_SUB_ID = "codex";

/** A settings.set patch: writable fields plus the write-only raw OpenAI key (never read back). */
export type SettingsPatch = Partial<
  Omit<OrchestratorSettings, "hasOpenaiKey" | "openaiKeyLast4" | "codexChatgptLogin" | "xhighEnabled" | "modelDefaults" | "claudeModels" | "codexModels">
> & { openaiApiKey?: string };

/** Flagship Codex models suggested when the live list hasn't loaded yet (most-capable first). */
export const CODEX_MODELS = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.1-codex-max",
  "gpt-5.3-codex",
  "gpt-5.2-codex",
  "gpt-5.1-codex-mini",
  "codex-mini-latest",
] as const;

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
  | { type: "chat.history"; room: string; messages: ChatMessage[]; hasMore: boolean }
  | { type: "chat.name"; threadId: string; role: Role; name: string }
  | { type: "plan.ready"; threadId: string; brief: string }
  | { type: "approval.mode"; on: boolean }
  | { type: "settings"; settings: OrchestratorSettings }
  | { type: "codex.test.result"; ok: boolean; message: string }
  | { type: "thread.changes"; threadId: string; diff: string; log: string }
  | { type: "thread.upsert"; thread: Thread }
  | { type: "thread.removed"; threadId: string }
  // A cancelled task was restarted from scratch: prune its now-deleted runs/findings/feed (keeping the
  // thread row) before the fresh pipeline streams in.
  | { type: "thread.reset"; threadId: string }
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
  // Reply to a director.search: whole-conversation matches (newest-first) for `query`; the echoed
  // query lets the client drop a stale reply if the operator has retyped since.
  | { type: "director.results"; query: string; messages: DirectorMessage[] }
  // A user-facing notification (token-safety auto-stop = warn; token-reset auto-resume = info). Shown as a
  // dismissible banner + desktop notify.
  | { type: "notice"; level: "info" | "warn"; title: string; message: string }
  // Voice mode: spoken completion line for a finished task — consumed by the voice-gateway, ignored here.
  | { type: "voice.announce"; threadId: string; text: string }
  | { type: "log"; level: "info" | "warn" | "error"; message: string };

export type ClientCommand =
  | { type: "prompt.new"; text: string; workspace?: string; images?: ImageAttachment[] }
  | { type: "prompt.direct"; text: string; workspace?: string; images?: ImageAttachment[] }
  | { type: "question.answer"; questionId: string; answer: string }
  | { type: "thread.inject"; threadId: string; message: string; mode: "append" | "interrupt" | "queue"; images?: ImageAttachment[] }
  | { type: "thread.interrupt"; threadId: string }
  | { type: "thread.resume"; threadId: string; message?: string }
  | { type: "thread.cancel"; threadId: string }
  | { type: "thread.retry"; threadId: string }
  | { type: "thread.rename"; threadId: string; title: string }
  | { type: "thread.markDone"; threadId: string }
  | { type: "thread.close"; threadId: string }
  | { type: "thread.restore"; threadId: string }
  | { type: "thread.dismiss"; threadId: string }
  | { type: "thread.history"; threadId: string }
  | { type: "thread.approve"; threadId: string; approved: boolean; feedback?: string }
  | { type: "approval.set"; on: boolean }
  | { type: "settings.set"; settings: SettingsPatch }
  | { type: "codex.test"; apiKey?: string }
  | { type: "account.set"; id: string; enabled: boolean }
  | { type: "thread.changes"; threadId: string }
  | { type: "director.search"; query: string }
  | { type: "chat.history"; room: string; before?: ChatCursor }
  | { type: "chat.post"; room: string; body: string }
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
