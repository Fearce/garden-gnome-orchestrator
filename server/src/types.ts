// Shared domain types — the contract the whole server builds against.

export type Role = "director" | "planner" | "researcher" | "implementor" | "qa" | "reader";

/** Dispatch lane. Absent/null = the normal planner→implementor→QA pipeline; 'read' = the cheap
 *  single-agent read-only reader lane (dispatch_read) — one Sonnet reader answers a lookup and escalates
 *  rather than half-answering, no QA. Persisted on the thread so it survives resume and drives the badge. */
export type ThreadLane = "read";

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
export const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];
export type CodexEffort = "low" | "medium" | "high" | "xhigh";
export const CODEX_EFFORTS: CodexEffort[] = ["low", "medium", "high", "xhigh"];

export type AgentRunState =
  | "starting"
  | "running"
  | "idle"
  | "interrupted"
  | "done"
  | "error";

export type Severity = "info" | "note" | "warning" | "critical";

/** A normal blackboard finding, or a `deliverable` — a file the agent produced that the owner can
 *  view/download from the right panel. A deliverable carries a `path` (absolute or workspace-relative)
 *  and a human `label`; everything else (summary/detail/severity) behaves like an ordinary finding. */
export type FindingKind = "finding" | "deliverable";

export interface Thread {
  id: string;
  title: string;
  state: ThreadState;
  workspace: string; // target repo cwd for the implementor
  brief: string; // enriched brief that kicked off the pipeline
  rawPrompt: string; // the user's original ask
  error?: string | null;
  effortOverride?: Effort | null; // operator-pinned implementor effort, snapshotted at a skip-director dispatch — beats the planner's pick
  closedAt?: number | null; // when soft-closed (state === "closed"); drives the 30-day auto-purge clock
  closedPrevState?: ThreadState | null; // the state a closed task came from — 'done' means it finished correctly (drives the closed-card checkmark)
  lane?: ThreadLane | null; // dispatch lane: null = normal pipeline, 'read' = the read-only reader lane (drives the card's READ badge)
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
  kind: FindingKind; // 'finding' (default) or 'deliverable' (a produced file surfaced for view/download)
  summary: string;
  detail?: string | null;
  path?: string | null; // deliverable only — file path (absolute or relative to the task workspace)
  label?: string | null; // deliverable only — human-readable label, e.g. "Design comparison report"
  severity: Severity;
  routed: boolean; // delivered/injected somewhere already
  createdAt: number;
}

export type MessageKind = "text" | "tool" | "result" | "system";

// ---- The office: cross-agent chat rooms ----

/** Which room a chat message belongs to. 'general' is the office everyone shares; 'project' is the
 *  per-repository room agents form when 2+ of them work the same workspace concurrently. */
export type ChatScope = "general" | "project";

/** A keyset cursor into a room's history: fetch the page of messages strictly older than this
 *  (created_at, id) pair. Mirrored in web/src/types.ts. */
export interface ChatCursor {
  createdAt: number;
  id: string;
}

/** How many chat messages one history page holds — the initial chatroom open and each scroll-up
 *  load fetch this many, instead of the whole (potentially months-long) room at once. */
export const CHAT_PAGE_SIZE = 50;

/** One message in the office. Sent by an agent run (role/threadId/runId set) or by the orchestrator
 *  itself (kind 'system' — e.g. the notice posted when a project group forms). `room` is the durable
 *  key: "general", or "repo:<normalized-workspace>" for a project room. */
export interface ChatMessage {
  id: string;
  room: string;
  scope: ChatScope;
  workspace?: string | null; // display path of the repo, for a project room
  threadId?: string | null;
  runId?: string | null;
  role: Role | "system";
  kind: "chat" | "system";
  body: string;
  senderName?: string | null; // the gnome name the sender went by (stamped at post time)
  createdAt: number;
}

// Friendly office names for the gnomes — one per AGENT (a task's planner, researcher, implementor and
// QA are distinct agents, so each gets its own name; they were never really one person). A deterministic
// default is derived from the (thread, role) pair (gnomeName, mirrored in web/src/types.ts); an agent
// can pick its own via the office_set_name tool. Nordic/tomte flavored to match the mascot.
export const GNOME_NAMES = [
  "Pip", "Nim", "Bram", "Tova", "Fen", "Sol", "Rune", "Liv", "Ask", "Eir",
  "Odd", "Sten", "Tor", "Una", "Yara", "Knut", "Hilda", "Mads", "Sif", "Juni",
  "Lumi", "Pax", "Wren", "Zia", "Ole", "Greta", "Finn", "Bo", "Vik", "Saga",
] as const;

/** The identity key for one agent: a (thread, role) pair. Each role in a task is a fresh agent with its
 *  own office name, so names key off this — never the bare thread id. Mirrored in web/src/types.ts. */
export function agentKey(threadId: string, role: Role): string {
  return `${threadId}::${role}`;
}

/** Fixed pipeline order of a task's agents — drives the per-role name offset below so a task's roles map
 *  to CONSECUTIVE (hence distinct) default names. Mirrored in web/src/types.ts. */
const ROLE_RANK: Record<Role, number> = { director: 0, planner: 1, researcher: 2, implementor: 3, qa: 4, reader: 5 };

/** Deterministic default office name for one agent (a task's role): the task's base name (hashed from
 *  its id) stepped forward by the role's pipeline rank. Because the five roles occupy consecutive slots
 *  in a 30-name ring, a single task's agents can never share a default name — no hash-collision edge.
 *  Stable across the agent's life and mirrored byte-for-byte in web/src/types.ts so the agent's name and
 *  the UI's agree. Cross-task collisions (two live gnomes) are resolved by ThreadManager's
 *  ensureLiveNamesUnique pass, which re-derives uniqueness across the whole live set on every go-live. */
export function gnomeName(threadId: string, role: Role): string {
  let h = 0;
  for (let i = 0; i < threadId.length; i++) h = (h * 31 + threadId.charCodeAt(i)) >>> 0;
  return GNOME_NAMES[(h + ROLE_RANK[role]) % GNOME_NAMES.length]!;
}

/** A rolled-up view of a project (per-repo) room — enough for the client to decide which tasks show
 *  a "Chatroom" button (those whose id is in `threadIds`) without holding the full message history. */
export interface ChatRoomSummary {
  room: string;
  workspace: string;
  threadIds: string[]; // distinct tasks that have participated (sent or were announced into the room)
  messageCount: number;
  lastAt: number;
}

/** Normalize a workspace path to a stable room/grouping key — lowercased, forward slashes, no trailing
 *  separator — so "C:\\Repo\\" and "c:/repo" land in the same project room. Mirrored byte-for-byte in
 *  web/src/types.ts so server grouping and the office UI agree exactly. */
export function normalizeWorkspace(p: string): string {
  return p.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
}

export const GENERAL_ROOM = "general";

/** The project-room key for a workspace ("repo:<normalized>"). */
export function repoRoom(workspace: string): string {
  return "repo:" + normalizeWorkspace(workspace);
}

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
  // The task this message's conversation turn dispatched, if any — set when the director (or a
  // skip-director send) creates a thread, so a search hit can jump to the task it produced. Null for
  // pure chatter that spawned nothing, and left dangling (task may be gone) rather than cascade-deleted:
  // the director conversation is durable, so the UI just hides the jump when the thread no longer exists.
  threadId?: string | null;
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

/** The reader lane's lean disposition (the answer itself is posted as a finding, not returned here):
 *  did the reader answer the lookup read-only, or escalate because the task actually needs the full
 *  pipeline? runReader reads this to mark the task done vs. park it in 'review' for re-dispatch. */
export interface ReaderOutput {
  answered: boolean; // fully answered read-only and posted the answer as a finding
  escalated: boolean; // needs the full pipeline (edits/verification/depth) — posted a 'needs full pipeline' finding instead of half-answering
  reason?: string; // when escalated: the one-line reason
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
  readerDone?: boolean; // the read-lane reader stage ran (answered or escalated) — don't re-run/double-post on resume
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
  directorName: string; // the director persona's display name, set by the operator (default "ChangeNameInSettings")
  maxQaRounds: number; // implementor↔QA fix-rounds before a task settles to review
  selfImproveEnabled: boolean; // off (default) → opt-in; on → after a task completes, the implementor runs one extra round building the tools/skills/memories that would have made the task easier
  maxConcurrent: number; // max pipelines running at once; further dispatches wait in 'queued'
  // ---- Token-usage safety limit: opt-in auto-stop when live utilization reaches a threshold ----
  tokenLimitEnabled: boolean; // off (default) → never auto-stop; on → stop running agents at the threshold
  tokenLimitPercent: number; // % of the token (rate-limit) window that trips the stop — clamped 50–99, default 80
  // ---- Auto-resume on token-window reset: when usage is high, schedule a wakeup at the reset that
  //      resumes work that froze on the cap — so the orchestrator recovers AFK, no manual Resume. ----
  autoResumeOnTokenReset: boolean; // off (default) → opt-in; on → arm a reset-timed resume when usage crosses the threshold below
  autoResumeThresholdPercent: number; // % of the token window at which the resume is armed — clamped 50–95, default 80
  // ---- Fast usage polling: opt-in tighter cadence for the account usage ping ----
  fastUsagePolling: boolean; // off (default) → 10-min ping; on → poll every ~30s so the strip tracks the live burn within ~1-2%
  // ---- Subscriptions: which provider backs the implementor (hard routing gate at dispatch) ----
  // Claude is the default implementor and always powers planner/researcher/QA; individual Claude
  // accounts are toggled via the AccountDTO.enabled flag (account.set), not a setting here.
  codexEnabled: boolean; // OpenAI Codex: when on (with a valid key), it becomes the implementor backend
  codexModel: string; // the resolved Codex implementor model (mirrors modelOverrides.codex.implementor; kept for the top-bar chip + back-compat)
  codexEffort: CodexEffort; // Codex CLI reasoning effort, applied via model_reasoning_effort
  hasOpenaiKey: boolean; // read-only indicator — an OpenAI key is stored (the raw key is never broadcast)
  openaiKeyLast4?: string | null; // read-only — last 4 chars of the stored key, for the masked field
  codexChatgptLogin: boolean; // read-only — a ChatGPT-plan `codex login` is available; preferred over the key
  // ---- Composer state, persisted server-side (not localStorage) so it survives across the HTTP and
  //      HTTPS surfaces the console is served on — the two origins don't share localStorage. ----
  skipDirector: boolean; // composer's skip-director mode — persists so "on" stays on next time it opens
  showComposerModelPicker: boolean; // whether the director composer shows compact Claude/Codex implementor model dropdowns
  showAgentModel: boolean; // whether agent labels in the thread feed append the run's model + effort — "QA (Tor, Opus 4.8 High)"
  skipDirectorEffort: Effort | "auto"; // composer's implementor effort for skip-director dispatches — "auto" leaves it to the planner
  xhighEnabled: boolean; // read-only — the ENABLE_XHIGH opt-in is on, so the xhigh tier is offerable
  skipDirectorRetitle: boolean; // when skip-director is on, mint a real title via a cheap Haiku call instead of the raw first line (default on)
  maxRecentRepos: number; // how many recent-repo chips the composer shows (clamped 1–20, default 5)
  recentRepos: string[]; // recently-dispatched repo paths, most-recent first (capped at maxRecentRepos)
  // ---- Per-(subscription × role) model selection ----
  modelOverrides: ModelOverrides; // operator-picked models: {subId → {role → modelId}} (writable via settings.set)
  modelDefaults: Partial<Record<Role, string>>; // read-only: the built-in per-role defaults (config.models)
  claudeModels: string[]; // read-only: pickable Claude model ids (live ∪ curated ∪ selected), most-capable first
  codexModels: string[]; // read-only: pickable Codex/OpenAI model ids (live ∪ curated ∪ selected)
}

/** The implementor backend chosen at dispatch by the subscription toggles. */
export type ImplementorProvider = "claude" | "codex";

/** The five agent roles a model can be picked for. Mirrored in web/src/types.ts. */
export const MODEL_ROLES: Role[] = ["director", "planner", "researcher", "implementor", "qa"];

/**
 * Which model each agent role runs on, per subscription. Keyed by subscription id — a Claude account
 * id (AccountDTO.id), the literal "codex" for the OpenAI backend, or "default" for the global per-role
 * fallback applied when a specific subscription has no override. Inner map is role → model id. A missing
 * entry falls through: subscription override → "default" override → the built-in config.models default.
 * Codex only implements, so only its "implementor" entry is meaningful and it never inherits a Claude
 * default (a Claude model id would be invalid for the Codex CLI).
 */
export const DEFAULT_SUB_ID = "default";
export const CODEX_SUB_ID = "codex";
export type ModelOverrides = Record<string, Partial<Record<Role, string>>>;

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
