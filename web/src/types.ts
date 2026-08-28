// Mirror of the server's protocol + domain types (kept in sync by hand).

export type Role = "director" | "planner" | "researcher" | "implementor" | "qa" | "reader" | "reviewer";

/** Every role, as a value — for narrowing a role name that arrived as a free string from outside this
 *  process (the Online Office carries another machine's role names). Mirrored in server/src/types.ts. */
export const ROLES = ["director", "planner", "researcher", "implementor", "qa", "reader", "reviewer"] as const;

/** Dispatch lane: undefined/null = the normal pipeline, 'read' = the read-only reader lane (dispatch_read). */
export type ThreadLane = "read";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
/** Cross-provider ordering. Ultra is Codex-only; Claude controls must use CLAUDE_EFFORTS. */
export const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max", "ultra"];
export const CLAUDE_EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];
const CLAUDE_BASE_EFFORTS: Effort[] = ["low", "medium", "high"];
const CLAUDE_MAX_EFFORTS: Effort[] = ["low", "medium", "high", "max"];

/** Exact documented effort set for a Claude model. Unknown/older ids get the universally safe base set. */
export function claudeEffortsForModel(model: string): readonly Effort[] {
  const id = model.trim().toLowerCase();
  if (/^claude-(?:fable-5|mythos-5|opus-5|opus-4-(?:7|8)|sonnet-5)(?:[-.]|$)/.test(id)) return CLAUDE_EFFORTS;
  if (/^claude-(?:opus-4-6|sonnet-4-6|mythos-preview)(?:[-.]|$)/.test(id)) return CLAUDE_MAX_EFFORTS;
  return CLAUDE_BASE_EFFORTS;
}
export type CodexEffort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
/** All Codex CLI effort values. The settings payload carries each live model's exact subset. */
export const CODEX_EFFORTS: CodexEffort[] = ["low", "medium", "high", "xhigh", "max", "ultra"];
const CODEX_PRE_MAX_EFFORTS: CodexEffort[] = ["low", "medium", "high", "xhigh"];
const CODEX_MAX_EFFORTS: CodexEffort[] = ["low", "medium", "high", "xhigh", "max"];

/** Cold-start mirror of server/src/types.ts; prefer settings.codexModelEfforts once connected. */
export function codexEffortsForModel(model: string): readonly CodexEffort[] {
  const id = model.trim();
  if (/^(?:gpt-5\.6-(?:sol|terra)|gpt-daybreak-blue-latest)(?:[-.]|$)/i.test(id)) return CODEX_EFFORTS;
  if (/^(?:gpt-5\.6|gpt-reserve|codex-auto-review)(?:[-.]|$)/i.test(id)) return CODEX_MAX_EFFORTS;
  return CODEX_PRE_MAX_EFFORTS;
}
export const GROK_EFFORTS = ["low", "medium", "high", "xhigh"] as const;
export type GrokEffort = (typeof GROK_EFFORTS)[number];
const GROK_PRE_XHIGH_EFFORTS: GrokEffort[] = ["low", "medium", "high"];

/** Grok 4.6+ accepts xhigh; older cached models safely stop at high. */
export function grokEffortsForModel(model: string): readonly GrokEffort[] {
  const match = /^grok-(\d+)\.(\d+)(?:[-.]|$)/i.exec(model.trim());
  const supportsXhigh = !!match && (Number(match[1]) > 4 || (Number(match[1]) === 4 && Number(match[2]) >= 6));
  return supportsXhigh ? GROK_EFFORTS : GROK_PRE_XHIGH_EFFORTS;
}

export const ZAI_EFFORTS = ["low", "medium", "high"] as const;
export type ZaiEffort = (typeof ZAI_EFFORTS)[number];

/** Live backend/model for the director. This is server runtime state, not a settings-derived guess. */
export interface DirectorStatus {
  provider: ImplementorProvider;
  model: string;
  accountLabel: string;
}

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
  | "reviewing" // the owner delegated their review: an auto-reviewer is deciding accept-as-done vs. hand back
  | "done"
  | "failed"
  | "cancelled"
  | "closed";

export type AgentRunState = "starting" | "running" | "idle" | "interrupted" | "done" | "error";
export type Severity = "info" | "note" | "warning" | "critical";

export interface ThreadActionResult {
  ok: boolean;
  state?: ThreadState;
  error?: string;
  message?: string;
}

/** A normal blackboard finding, or a `deliverable` — a file the agent produced, surfaced in the
 *  right panel's Deliverables section for inline preview / download (mirrors the server's FindingKind). */
export type FindingKind = "finding" | "deliverable";

/** One collaborator's share of a SHOTGUN task. Mirrors the server's ShotgunAssignment byte-for-byte.
 *  The file list is the ownership contract that keeps parallel agents out of each other's files. */
export interface ShotgunAssignment {
  title: string;
  objective: string;
  files: string[];
}

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
  lane?: ThreadLane | null; // 'read' = the read-only reader lane — drives the card's READ badge
  // Timed task: the wall-clock work window. `deadlineAt` is absolute once work starts, so the card's
  // countdown is just (deadlineAt - now) and survives reload/restart. Null also covers a queued window.
  durationMs?: number | null;
  deadlineAt?: number | null;
  // Shotgun: the requested collaborator count, and — on a COLLABORATOR — its lead plus its owned share.
  // A thread with a parentId is hidden from the main board and rendered inside its lead's detail panel.
  agentCount?: number | null;
  parentId?: string | null;
  assignment?: ShotgunAssignment | null;
  createdAt: number;
  updatedAt: number;
}

/** A recurring dispatch: a prompt that runs in a target repo on a cron schedule. Mirrors the server's
 *  ScheduledTask. Each fire creates a normal task through the standard pipeline. */
export interface ScheduledTask {
  id: string;
  title: string;
  workspace: string;
  prompt: string;
  cron: string;
  enabled: boolean;
  effort?: Effort | null;
  lastRunAt?: number | null;
  nextRunAt?: number | null;
  lastThreadId?: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Which pane the center board shows: the live task lanes, the owner's note list, or the schedules. */
export type BoardView = "tasks" | "notes" | "schedules" | "supervisor";

/** Hard ceiling on a note's body — enforced server-side by truncation. Mirrors server/src/types.ts. */
export const NOTE_MAX_CHARS = 255;

/** One line on the operator's note list: a pointer an agent left for the owner — a branch pushed, a PR
 *  opened — that they click, act on, and delete. Server-authoritative; mirrors server/src/types.ts. */
export interface OperatorNote {
  id: string;
  body: string;
  url?: string | null; // the click target (http/https only)
  threadId?: string | null; // the task that left it; null when the owner or director wrote it
  threadTitle?: string | null; // snapshot, so the note still reads after that task is purged
  workspace?: string | null; // snapshot of the repo it came from
  fromRole?: Role | null; // null for the owner's own note
  fromName?: string | null; // the agent's office name
  createdAt: number;
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
  tokenUsage?: TokenUsage | null;
  error?: string | null;
  /** The runner read this run's ending as a usage cap (mirrors the server field). */
  capFlagged?: boolean | null;
  startedAt: number;
  endedAt?: number | null;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
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

/** Where a task's text matched the search — the server picks the most informative site as the snippet
 *  source, and the console labels the hit with it. */
export type TaskMatchSite = "title" | "brief" | "conversation";

/** One task matched by the search box, beside the director-conversation hits. The search spans each
 *  task's whole conversation and not just its title and brief, because the word the owner remembers a
 *  task by is often one an agent coined while working — a folder it created, a file it generated. */
export interface TaskSearchHit {
  threadId: string;
  title: string;
  state: ThreadState;
  workspace: string;
  createdAt: number;
  where: TaskMatchSite;
  // A window around the first match, cut server-side (a matching tool-output message is often
  // megabytes). Empty when only the title matched — the highlighted title is the evidence.
  snippet: string;
  // Matching messages in the task's conversation: what tells the task that did the work apart from
  // one that merely mentioned it. 0 for a title/brief-only match.
  messageHits: number;
}

export interface Message {
  id: string;
  threadId: string;
  runId?: string | null;
  role: Role | "user";
  kind: "text" | "tool" | "result" | "system" | "thinking";
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
  remoteInstance?: string | null; // set when the line came from another machine's orchestrator (its name)
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
const ROLE_RANK: Record<Role, number> = { director: 0, planner: 1, researcher: 2, implementor: 3, qa: 4, reader: 5, reviewer: 6 };

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
  remoteInstances: string[]; // distinct other machines whose agents have participated (Online Office)
  messageCount: number;
  lastAt: number;
}

/** Whether a project room is a real collaboration — the test every chatroom surface gates on. Among
 *  purely local tasks it takes two; one machine on the far side of the Online Office is already one,
 *  since a project room only exists here for a repo this machine works — and that machine may be the
 *  only party that has spoken yet. Mirrored from server/src/types.ts. */
export function isCollaborationRoom(r: Pick<ChatRoomSummary, "threadIds" | "remoteInstances">): boolean {
  return r.remoteInstances.length > 0 || r.threadIds.length >= 2;
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
  weeklySafetyPct: number; // 1-100 soft weekly-utilization ceiling; at/above it new tasks route to another sub (100 = off)
  holdUntil?: number | null; // 5h window idle (stagger hold-off) — the next window starts at this epoch ms
  // Model-scoped pool caps (Fable's separately-gated allowance): dispatch resolves `fallback` in place
  // of `model` on this sub until `resetsAt`. The account's normal windows are unaffected.
  modelLimits?: { model: string; fallback: string; resetsAt: number }[];
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
  fiveHourResetEstimated?: boolean;
  sevenDayReset: number | null;
  planType: string | null;
  updatedAt: number;
  wakeAt?: number | null; // 5h window idle — a cheap wake turn is scheduled at this epoch ms (stagger slot)
}

/** Grok (SuperGrok) usage — mirrors the server's GrokUsageDTO. Weekly used-% comes from the CLI log /
 *  winpty scrape; monthly credits from the OAuth HTTP billing endpoint. */
export interface GrokUsageDTO {
  signedIn: boolean;
  email: string | null;
  tier: number | null;
  plan: string | null; // e.g. "SuperGrok"
  sevenDay: number | null; // weekly used-percent (0-100), else null
  sevenDayReset: number | null; // epoch ms the weekly window resets, else null
  monthlyUsed: number | null; // monthly credit units used, else null
  monthlyLimit: number | null; // monthly credit unit cap, else null
  monthlyReset: number | null; // epoch ms the monthly billing period ends, else null
  capUntil: number | null; // epoch ms a usage-cap rejection is latched until, else null
  stale?: boolean; // the reading hasn't refreshed recently
  error?: string | null; // soft failure when meters are missing
  updatedAt: number;
}

/** z.ai (GLM Coding Plan) usage — mirrors the server's ZaiUsageDTO. 5-hour + weekly used-% and resets come
 *  from the plan's real quota endpoint; `plan` is the tier (lite/pro/max). */
export interface ZaiUsageDTO {
  configured: boolean; // an API key is available (env or kv)
  plan: string | null; // plan tier: "lite" | "pro" | "max"
  fiveHour: number | null; // 5-hour window used-percent (0-100), else null
  fiveHourReset: number | null; // epoch ms the 5-hour window resets, else null
  sevenDay: number | null; // weekly window used-percent (0-100), else null
  sevenDayReset: number | null; // epoch ms the weekly window resets, else null
  capUntil: number | null; // epoch ms a usage-cap rejection is latched until, else null
  stale?: boolean;
  error?: string | null;
  updatedAt: number;
}

/** Operator-tunable pipeline settings — server-authoritative (persisted in the DB kv table, broadcast
 *  to every client). Mirrors the server's OrchestratorSettings. */
export interface OrchestratorSettings {
  plannerEnabled: boolean;
  researcherEnabled: boolean;
  qaEnabled: boolean;
  differentProviderQa: boolean; // off (default) → QA runs on the default backend. on → QA is routed to a DIFFERENT enabled provider than the implementor (cross-provider review); falls back to normal QA when no other provider is enabled+ready.
  qaAppliesFixes: boolean; // off (default) → QA reports findings back to the implementor. on → QA fixes issues directly, then QA re-checks until a pass makes no code changes.
  autoPush: boolean;
  directorName: string; // the director persona's display name, operator-set (default "ChangeNameInSettings")
  maxQaRounds: number;
  maxReviewFixRounds: number; // implementor fix-rounds the auto-reviewer may trigger when it hands a task back (default 1; 0 = hand straight back to the owner)
  maxConcurrent: number;
  maxConcurrentPerRepo: number; // max pipelines running at once for a single repo; 0 (default) = unlimited (only the global maxConcurrent applies)
  selfImproveEnabled: boolean; // opt-in (off by default): completed tasks get one extra implementor round that builds the tools/skills/memories the session showed were missing
  autoModelSelection: boolean; // opt-in: smart-pick one sticky director target (re-pick on cap), plus each implementor's model/effort from every dispatchable backend; implementor outcomes feed later picks.
  // Token-usage safety limit: opt-in auto-stop when live utilization reaches the threshold. Disabled by
  // default; the percent is clamped 50–99 (default 80) and compared against the live rate-limit burn.
  tokenLimitEnabled: boolean;
  tokenLimitPercent: number;
  // Auto-resume on token-window reset: when usage crosses the threshold, arm a wakeup at the reset that
  // resumes work frozen on the cap. Opt-in (off by default); the percent is clamped 50–95 (default 80).
  autoResumeOnTokenReset: boolean;
  autoResumeThresholdPercent: number;
  // Fast usage polling: opt-in tighter cadence for the account usage ping. Off (default) = 10-min
  // ping; on = ~30s so the top-bar usage strip tracks the live burn within ~1-2% of Claude's own UI.
  fastUsagePolling: boolean;
  // Spread usage: off (default) = burn the soonest-resetting provider/sub first; on = always dispatch to
  // the provider (Claude sub, Codex, or Grok) with the lowest weekly usage, balancing burn evenly across
  // every enabled platform.
  spreadUsage: boolean;
  // Subscriptions: which provider backs the implementor (server-authoritative hard gate). Claude is the
  // default backend; individual Claude accounts toggle via AccountDTO.enabled (account.set), not here.
  codexEnabled: boolean;
  codexModel: string;
  codexEffort: CodexEffort;
  codexWeeklySafetyPct: number; // 1-100 soft weekly ceiling (100 = off): above it, tasks route off Codex to another backend
  hasOpenaiKey: boolean; // read-only: a key is stored (raw key never reaches the client)
  openaiKeyLast4?: string | null; // read-only: last 4 chars for the masked field
  codexChatgptLogin: boolean; // read-only: a ChatGPT-plan `codex login` is available (preferred over a key)
  grokEnabled: boolean; // xAI Grok (SuperGrok): when on (with a `grok login`), it joins the implementor backends
  grokModel: string;
  grokEffort: GrokEffort;
  grokWeeklySafetyPct: number; // 1-100 soft weekly ceiling (100 = off): above it, tasks route off Grok
  grokSignedIn: boolean; // read-only: a `grok login` (auth.json) is present, so Grok can authenticate
  grokAccount?: string | null; // read-only: the signed-in Grok account email
  // Zhipu z.ai (GLM Coding Plan): when on (with an API key) it joins the implementor backends. Runs on the
  // Claude Agent SDK via z.ai's Anthropic-compatible endpoint, so it keeps the bus/office MCP tools.
  zaiEnabled: boolean;
  zaiModel: string;
  zaiEffort: ZaiEffort; // z.ai reasoning-effort cap (low/medium/high)
  zaiWeeklySafetyPct: number; // 1-100 soft weekly ceiling (100 = off): above it, tasks route off z.ai
  zaiKeyPresent: boolean; // read-only: an API key is stored (raw key never reaches the client)
  zaiKeyLast4?: string | null; // read-only: last 4 chars for the masked field
  // Phone notifications: post to a Discord channel when a task settles done, needs your input (a review
  // park or an agent's question), or fails. Pipeline chatter is never posted.
  discordNotify: boolean;
  discordChannelId: string; // the channel notices go to (a pasted link is reduced to its id server-side); empty falls back to the server's DISCORD_CHANNEL_ID
  discordTokenPresent: boolean; // read-only: a bot token is stored (raw token never reaches the client)
  discordTokenLast4?: string | null; // read-only: last 4 chars for the masked field
  // Composer state persisted server-side (survives across the HTTP/HTTPS surfaces, which don't share
  // localStorage): the skip-director mode, the recent-repo chip cap, and the recent-repo list itself.
  skipDirector: boolean;
  showComposerPickers: boolean; // when on, the director composer exposes the quick model + effort dropdowns (default off — hidden)
  showAgentModel: boolean; // when on, agent labels in the thread feed append the run's model + effort — "QA (Tor, Opus 4.8 High)"
  skipDirectorEffort: Effort | "auto"; // composer's implementor effort for skip-director dispatches — "auto" inherits a planner pick only when planning runs
  taskDurationMinutes: number; // TIMED: minutes of wall-clock work window for the next dispatch; 0 = an ordinary task
  taskAgentCount: number; // SHOTGUN: agents working the objective at once; 1 = an ordinary task
  xhighEnabled: boolean; // read-only: the server's ENABLE_XHIGH opt-in is on, so the xhigh tier is offerable
  skipDirectorRetitle: boolean; // when skip-director is on, mint a real title via a cheap Haiku call instead of the raw first line
  maxRecentRepos: number;
  recentRepos: string[];
  // Per-(subscription × role) model picks. See ModelOverrides. modelDefaults/claudeModels/codexModels
  // are read-only (server-derived): the built-in per-role defaults and the pickable model lists.
  modelOverrides: ModelOverrides;
  // Per-Claude-account MAX reasoning-effort cap ({accountId → effort}). The director/planner picks the
  // per-task effort; this caps it per sub (absent/`max` = uncapped). Codex/Grok caps live in codexEffort/
  // grokEffort. Writable via settings.set.
  accountEffortCaps: Record<string, Effort>;
  modelDefaults: Partial<Record<Role, string>>;
  claudeModels: string[];
  codexModels: string[];
  codexModelEfforts: Record<string, CodexEffort[]>; // exact live Codex CLI effort set per model
  grokModels: string[]; // read-only: pickable Grok model ids
  zaiModels: string[]; // read-only: pickable z.ai GLM model ids
  // Director Supervisor watchdog (off by default) — see server/src/orchestrator/supervisor.ts.
  directorSupervisorEnabled: boolean;
}

/** The five agent roles a model can be picked for. Mirrors the server's MODEL_ROLES. */
export const MODEL_ROLES: Role[] = ["director", "planner", "researcher", "implementor", "qa"];

/** Which model each role runs on, per subscription. Keyed by subscription id — a Claude account id,
 *  "codex", or "default" (the global per-role fallback). Mirrors the server's ModelOverrides. */
export type ModelOverrides = Record<string, Partial<Record<Role, string>>>;

/** The implementor backends (mirrors the server's ImplementorProvider). */
export type ImplementorProvider = "claude" | "codex" | "grok" | "zai";

/** Auto model selection's scoreboard row: how one model has actually performed on auto-picked tasks.
 *  100 = the task was accepted with no human involvement; each QA fix-round past the first costs 12.
 *  Averages cover graded tasks whose whole implementation ran on this one model. Mirrors the server. */
export interface ModelStat {
  provider: ImplementorProvider;
  model: string;
  picks: number;
  avgScore: number;
  doneRate: number; // 0-1
  avgQaRounds: number;
  avgCostUsd: number;
  avgTotalTokens: number | null;
  avgInputTokens: number | null;
  avgOutputTokens: number | null;
  avgCacheTokens: number | null;
  avgReasoningTokens: number | null;
  tokenSampleRate: number;
  avgMinutes: number;
}

/** Subscription-id sentinels for the model matrix (mirror the server). */
export const DEFAULT_SUB_ID = "default";
export const CODEX_SUB_ID = "codex";
export const GROK_SUB_ID = "grok";
export const ZAI_SUB_ID = "zai";

/** A settings.set patch: writable fields plus the write-only raw keys (never read back). */
export type SettingsPatch = Partial<
  Omit<
    OrchestratorSettings,
    | "hasOpenaiKey"
    | "openaiKeyLast4"
    | "codexChatgptLogin"
    | "grokSignedIn"
    | "grokAccount"
    | "zaiKeyPresent"
    | "zaiKeyLast4"
    | "discordTokenPresent"
    | "discordTokenLast4"
    | "xhighEnabled"
    | "modelDefaults"
    | "claudeModels"
    | "codexModels"
    | "codexModelEfforts"
    | "grokModels"
    | "zaiModels"
  >
> & { openaiApiKey?: string; zaiApiKey?: string; discordBotToken?: string };

/** Flagship Codex models suggested when the live list hasn't loaded yet (most-capable first). */
export const CODEX_MODELS = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-daybreak-blue-latest",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex-spark",
] as const;

/** Grok models suggested when the live list hasn't loaded yet. */
export const GROK_MODELS = ["grok-4.6"] as const;

/** z.ai (GLM) models suggested for the picker — the plan's fixed GLM id set (most-capable first curated). */
export const ZAI_MODELS = ["glm-5.1", "glm-5-turbo", "glm-4.7", "glm-4.5-air"] as const;

// ---- the real-git "Changes" surface (mirrors server/src/gitService.ts) ----

export type GitFileStatus = "added" | "modified" | "deleted" | "renamed" | "untracked" | "conflicted";

export interface GitFile {
  path: string;
  status: GitFileStatus;
  added: number; // -1 for a binary file
  removed: number;
  binary: boolean;
  oldPath?: string; // the pre-rename path, when status is "renamed"
}

export interface GitCommit {
  hash: string;
  subject: string;
  author: string;
  at: number; // epoch ms
  local: boolean; // committed but not yet on the push remote
}

/** "commit-only" is the Vota steady state (neutral, no push nag); "unpushed" = local commits to push;
 *  "pushed" = in sync; "no-remote" = no push target configured. Mirrors the server's PushState. */
export type PushState = "pushed" | "unpushed" | "commit-only" | "no-remote";

export interface GitStatus {
  isRepo: boolean;
  repoRoot: string | null;
  branch: string | null;
  detached: boolean;
  branches: string[];
  upstreamRef: string | null;
  pushRef: string | null;
  behind: number;
  unpushed: number;
  isVota: boolean;
  pushState: PushState;
  hasUncommitted: boolean;
  files: GitFile[];
  commits: GitCommit[];
  /** True when a resolvable dispatch baseline scoped files/commits to this task's net changes. False for a
   *  legacy task whose baseline was never recorded — the drawer's History then shows an explicit "no diff
   *  anchor recorded" state instead of a repo-wide commit dump. Mirrors the server's GitStatus. */
  hasDiffAnchor: boolean;
  error: string | null;
}

export interface GitSummary {
  isRepo: boolean;
  fileCount: number; // task-scoped: files THIS task changed
  added: number;
  removed: number;
  commitCount: number; // task-scoped: commits attributed to this task
  branch: string | null;
  unpushed: number;
  isVota: boolean;
  pushState: PushState;
}

export interface GitFileDiff {
  path: string;
  binary: boolean;
  patch: string;
  truncated: boolean;
}

// ---- the repo-level Git console (mirrors server/src/git/repoOps.ts + orchestrator/repoConsole.ts) ----

export interface RepoRef {
  path: string; // the resolved repo ROOT — the identity every repo command uses
  name: string;
  taskCount: number; // tasks in this console living in this repo
  activeCount: number; // …of which have an agent live in the workspace right now
  isSelf: boolean; // the orchestrator's own checkout
  discovered: boolean; // found by scanning the disk, not known from a dispatch
}

export interface RepoBranch {
  name: string;
  current: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  at: number; // epoch ms of the branch tip
  gone: boolean; // the upstream is configured but no longer on the remote
}

export interface RepoRemote {
  name: string;
  url: string;
}

/** A task with an agent live in this repo — what the console names before a destructive action. */
export interface RepoBusyTask {
  id: string;
  title: string;
  state: ThreadState;
}

export interface RepoState {
  path: string;
  name: string;
  isRepo: boolean;
  error: string | null;
  branch: string | null;
  detached: boolean;
  branches: RepoBranch[];
  remoteBranches: string[];
  remotes: RepoRemote[];
  upstreamRef: string | null;
  pushRef: string | null;
  ahead: number; // commits a Push would send
  behind: number; // commits a Pull would take
  isVota: boolean;
  pushState: PushState;
  files: GitFile[];
  commits: GitCommit[];
  lastFetchAt: number | null;
  /** Browser URL for the repo on its host, deep-linked to the current branch; null when the remote
   *  isn't a recognizable web host. */
  webUrl: string | null;
  busy: RepoBusyTask[];
}

export interface RepoCommitDetail {
  hash: string;
  fullHash: string;
  subject: string;
  body: string;
  author: string;
  email: string;
  at: number;
  files: GitFile[];
  isMerge: boolean;
  error: string | null;
}

export interface RepoActionResult {
  ok: boolean;
  message: string;
  /** Refused by the live-agent gate rather than by git — the console offers an explicit override. */
  blocked: boolean;
}

export type RepoOp =
  | { action: "fetch"; prune?: boolean }
  | { action: "pull"; rebase?: boolean }
  | { action: "push"; setUpstream?: boolean }
  | { action: "checkout"; branch: string; create?: boolean; from?: string }
  | { action: "deleteBranch"; branch: string; force?: boolean }
  | { action: "commit"; summary: string; description?: string; paths: string[] }
  | { action: "discard"; paths: string[] };

// ---- The Online Office (cross-machine coordination) ----
// Mirrored from server/src/office/onlineOffice.ts + onlineProtocol.ts.

/** One agent working on somebody else's machine, as the relay reports it. Its `repoLabel` is the shared
 *  repository identity — the thing two checkouts on two machines agree on, unlike a local path. */
export interface RelayPresentAgent {
  key: string;
  name: string;
  role: string;
  title: string;
  repoKey: string;
  repoLabel: string;
  instanceId: string;
  instanceName: string;
}

export interface OnlineOfficeDTO {
  enabled: boolean;
  url: string;
  instanceName: string;
  joined: boolean; // a device token is held — Join has succeeded at least once
  state: "off" | "connecting" | "online" | "error";
  error: string | null;
  connectedAt: number | null;
  remoteAgents: RelayPresentAgent[];
  sharedRepos: SharedRepo[]; // repos this machine and at least one other are both working right now
}

/** A repository whose work is split across machines. `workspaces` are the LOCAL checkouts that resolve to
 *  it — what lets the office strip stand a remote agent next to the local worker it collides with, which
 *  a repo label alone cannot do: the two sides agree on the remote, never on the path. */
export interface SharedRepo {
  repoKey: string;
  repoLabel: string;
  workspaces: string[];
}

export type ServerEvent =
  | {
      type: "hello";
      threads: Thread[];
      runs: AgentRun[];
      findings: Finding[];
      questions: Question[];
      director: DirectorMessage[];
      directorStatus: DirectorStatus | null;
      accounts: AccountDTO[];
      codexUsage: CodexUsageDTO | null;
      grokUsage: GrokUsageDTO | null;
      zaiUsage: ZaiUsageDTO | null;
      approvalMode: boolean;
      settings: OrchestratorSettings;
      chat: ChatMessage[];
      chatRooms: ChatRoomSummary[];
      nameOverrides: Record<string, string>;
      schedules: ScheduledTask[];
      modelStats: ModelStat[];
      notes: OperatorNote[];
      onlineOffice: OnlineOfficeDTO;
      supervisor: SupervisorSnapshot;
    }
  | { type: "office.online"; office: OnlineOfficeDTO }
  | { type: "office.join.result"; ok: boolean; error: string | null }
  | { type: "accounts"; accounts: AccountDTO[] }
  | { type: "model.stats"; stats: ModelStat[] }
  | { type: "schedules"; schedules: ScheduledTask[] }
  | { type: "notes"; notes: OperatorNote[] }
  | { type: "supervisor"; supervisor: SupervisorSnapshot }
  | { type: "codex.usage"; usage: CodexUsageDTO | null }
  | { type: "grok.usage"; usage: GrokUsageDTO | null }
  | { type: "zai.usage"; usage: ZaiUsageDTO | null }
  | { type: "chat.message"; message: ChatMessage }
  | { type: "chat.history"; room: string; messages: ChatMessage[]; hasMore: boolean }
  | { type: "chat.name"; threadId: string; role: Role; name: string }
  | { type: "plan.ready"; threadId: string; brief: string }
  | { type: "approval.mode"; on: boolean }
  | { type: "settings"; settings: OrchestratorSettings }
  | { type: "codex.test.result"; ok: boolean; message: string }
  | { type: "discord.test.result"; ok: boolean; message: string }
  | { type: "thread.changes"; threadId: string; diff: string; log: string }
  | { type: "thread.git"; threadId: string; status: GitStatus }
  | { type: "thread.gitSummary"; threadId: string; summary: GitSummary }
  | { type: "thread.gitDiff"; threadId: string; path: string; diff: GitFileDiff }
  // ---- the repo-level Git console ----
  // `preferred` = the repo of the task the console was opened from, resolved server-side; null when
  // no task was open or its workspace isn't a checkout. `forThread` echoes the request so a slow
  // earlier reply can be discarded.
  | { type: "repo.list"; repos: RepoRef[]; preferred: string | null; forThread: string | null }
  | { type: "repo.state"; path: string; state: RepoState }
  // `commit` echoes which side the diff came from (working tree vs. inside a commit) so the cache can be
  // keyed without guessing which request a reply answers.
  | { type: "repo.diff"; path: string; file: string; commit: string | null; diff: GitFileDiff }
  | { type: "repo.commit"; path: string; detail: RepoCommitDetail }
  | { type: "repo.result"; path: string; action: string; result: RepoActionResult }
  | { type: "thread.upsert"; thread: Thread }
  | { type: "thread.removed"; threadId: string }
  // A cancelled task was restarted from scratch: prune its now-deleted runs/findings/feed (keeping the
  // thread row) before the fresh pipeline streams in.
  | { type: "thread.reset"; threadId: string }
  | { type: "thread.message"; threadId: string; message: Message }
  | { type: "thread.action"; threadId: string; action: string; ok: boolean; state?: ThreadState; error?: string; message?: string; result: ThreadActionResult }
  | { type: "thread.history"; threadId: string; messages: Message[]; findings: Finding[]; brief: string }
  | { type: "run.upsert"; run: AgentRun }
  | { type: "agent.delta"; threadId: string; runId: string; role: Role; text: string }
  | { type: "agent.text"; threadId: string; runId: string; role: Role; text: string; messageId: string }
  | { type: "agent.thinking"; threadId: string; runId: string; role: Role; text: string }
  | { type: "agent.reasoning"; threadId: string; runId: string; role: Role; text: string; messageId: string }
  | { type: "agent.tool"; threadId: string; runId: string; role: Role; name: string; input: unknown; id: string; messageId: string }
  | { type: "agent.tool_result"; threadId: string; runId: string; id: string; isError: boolean; preview: string; messageId: string }
  | { type: "finding"; finding: Finding }
  | { type: "question.ask"; question: Question }
  | { type: "question.resolved"; questionId: string; answer: string }
  | { type: "director.delta"; text: string }
  | { type: "director.message"; message: DirectorMessage }
  | { type: "director.tool"; name: string; input: unknown }
  | { type: "director.busy"; busy: boolean }
  | { type: "director.status"; status: DirectorStatus | null }
  // Reply to a director.search: everything matching `query`, newest-first — director-conversation hits
  // in `messages`, matching tasks in `tasks`. The echoed query lets the client drop a stale reply if
  // the operator has retyped since.
  | { type: "director.results"; query: string; messages: DirectorMessage[]; tasks: TaskSearchHit[] }
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
  | { type: "thread.autoReview"; threadId: string }
  | { type: "thread.close"; threadId: string }
  | { type: "thread.restore"; threadId: string }
  | { type: "thread.dismiss"; threadId: string }
  | { type: "thread.history"; threadId: string }
  | { type: "thread.approve"; threadId: string; approved: boolean; feedback?: string }
  | { type: "approval.set"; on: boolean }
  | { type: "settings.set"; settings: SettingsPatch }
  | { type: "codex.test"; apiKey?: string }
  | { type: "discord.test" }
  | { type: "account.set"; id: string; enabled: boolean }
  | { type: "account.setSafety"; id: string; weeklySafetyPct: number }
  | { type: "thread.changes"; threadId: string }
  | { type: "thread.git"; threadId: string }
  | { type: "thread.gitSummary"; threadId: string }
  | { type: "thread.gitDiff"; threadId: string; path: string }
  | { type: "repo.list"; rescan?: boolean; forThread?: string }
  | { type: "repo.state"; path: string }
  | { type: "repo.diff"; path: string; file: string; commit?: string }
  | { type: "repo.commit"; path: string; hash: string }
  | { type: "repo.action"; path: string; op: RepoOp; force?: boolean }
  | { type: "director.cancel" }
  | { type: "director.search"; query: string }
  | { type: "chat.history"; room: string; before?: ChatCursor }
  | { type: "chat.post"; room: string; body: string }
  | { type: "schedule.create"; title: string; workspace: string; prompt: string; cron: string; enabled?: boolean; effort?: Effort | null }
  | { type: "schedule.update"; id: string; patch: { title?: string; workspace?: string; prompt?: string; cron?: string; enabled?: boolean; effort?: Effort | null } }
  | { type: "schedule.delete"; id: string }
  | { type: "schedule.run"; id: string }
  | { type: "office.join"; url: string; code: string; instanceName: string }
  | { type: "office.leave" }
  | { type: "office.set"; enabled?: boolean; instanceName?: string }
  | { type: "note.create"; body: string; url?: string }
  | { type: "note.delete"; id: string }
  | { type: "note.clear" }
  | { type: "supervisor.runNow" }
  | { type: "snapshot.request" };

// ---- Director Supervisor: a lightweight watchdog over active tasks (mirrors server/src/types.ts) ----

export type SupervisorTrigger = "state_change" | "stall_sweep" | "manual";
export type SupervisorEventKind = "check" | "action" | "skip" | "error";
export type SupervisorAction = "comment" | "inject_correction" | "trigger_recovery" | "alert" | "cleanup";

export interface SupervisorEvent {
  id: string;
  threadId?: string | null;
  threadTitle?: string | null;
  workspace?: string | null;
  trigger: SupervisorTrigger;
  kind: SupervisorEventKind;
  action?: SupervisorAction | null;
  summary: string;
  detail?: string | null;
  usedAgent: boolean;
  costUsd?: number | null;
  totalTokens?: number | null;
  model?: string | null;
  notifiedDiscord: boolean;
  createdAt: number;
}

export interface SupervisorSnapshot {
  enabled: boolean;
  running: boolean;
  watching: number;
  lastCheckAt?: number | null;
  budget: {
    date: string;
    checkinsToday: number;
    costUsdToday: number;
    tokensToday: number;
    maxCheckinsPerDay: number;
    maxCostUsdPerDay: number;
    maxTokensPerDay: number;
  };
  events: SupervisorEvent[];
}

// ---- client-only view models ----

// `id` (when present) is the stable DB message-row id used to dedup a live-streamed
// item against the same message re-delivered by thread.history. The tool_result's
// separate `id` is the SDK tool-use id (correlates a result to its tool call); its
// `messageId` is the DB row id used for the same dedup.
export type FeedItem =
  | { kind: "text"; at: number; role: Role; runId: string; id?: string; text: string }
  | { kind: "thinking"; at: number; role: Role; runId: string; id?: string; text: string }
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
