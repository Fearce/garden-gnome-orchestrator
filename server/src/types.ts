// Shared domain types — the contract the whole server builds against.

export type Role = "director" | "planner" | "researcher" | "implementor" | "qa" | "reader" | "reviewer";

/** Every role, as a value — for the places a role arrives as a free string from outside this process
 *  (the Online Office relay carries another instance's role name) and has to be narrowed before use. */
export const ROLES = ["director", "planner", "researcher", "implementor", "qa", "reader", "reviewer"] as const;

export function isRole(v: string): v is Role {
  return (ROLES as readonly string[]).includes(v);
}

/** Dispatch lane. Absent/null = the normal task-aware implementation route (planner/QA optional); 'read' = the cheap
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
  | "reviewing" // the owner delegated their review: an auto-reviewer is deciding accept-as-done vs. hand back
  | "done"
  | "failed"
  | "cancelled"
  | "closed"; // soft-closed: kept in the DB (restorable) but off the main board; auto-purged after 30d

export type Effort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
/** Canonical cross-provider ordering. `ultra` is a Codex CLI execution tier (reasoning plus automatic
 * delegation), not a Claude SDK effort; provider-specific helpers below expose only valid subsets. */
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

/** Coerce an unsupported Claude tier downward without ever spending more effort than requested. */
export function resolveClaudeEffort(model: string, effort: Effort): Effort {
  const supported = claudeEffortsForModel(model);
  if (supported.includes(effort)) return effort;
  const requested = EFFORTS.indexOf(effort);
  return [...supported].reverse().find((tier) => EFFORTS.indexOf(tier) < requested) ?? "high";
}
/** All Codex CLI effort values. `ultra` adds automatic delegation and is advertised only by selected
 * models in the CLI catalog; callers must use the model-specific live capability set when available. */
export const CODEX_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type CodexEffort = (typeof CODEX_EFFORTS)[number];
const CODEX_PRE_MAX_EFFORTS: CodexEffort[] = ["low", "medium", "high", "xhigh"];
const CODEX_MAX_EFFORTS: CodexEffort[] = ["low", "medium", "high", "xhigh", "max"];

/** Cold-start fallback before the CLI catalog is available. Sol, Terra, and Daybreak advertise Ultra;
 * the rest of the GPT-5.6 family reaches Max, while earlier general models stop at Extra High. */
export function codexEffortsForModel(model: string): readonly CodexEffort[] {
  const id = model.trim();
  if (/^(?:gpt-5\.6-(?:sol|terra)|gpt-daybreak-blue-latest)(?:[-.]|$)/i.test(id)) return CODEX_EFFORTS;
  if (/^(?:gpt-5\.6|gpt-reserve|codex-auto-review)(?:[-.]|$)/i.test(id)) return CODEX_MAX_EFFORTS;
  return CODEX_PRE_MAX_EFFORTS;
}

/** Coerce a stale or cross-model setting down to the nearest tier the selected Codex model accepts. */
export function resolveCodexEffort(model: string, effort: CodexEffort, live?: readonly CodexEffort[]): CodexEffort {
  const supported = live?.length ? live : codexEffortsForModel(model);
  if (supported.includes(effort)) return effort;
  const requested = CODEX_EFFORTS.indexOf(effort);
  return [...supported].reverse().find((tier) => CODEX_EFFORTS.indexOf(tier) < requested) ?? supported.at(-1) ?? "high";
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

/** z.ai is reached through the Claude SDK against an Anthropic-COMPATIBLE endpoint, so unlike Codex and
 *  Grok there is no per-model capability list to read: `effort` is passed to a server that documents no
 *  contract for it. These three are the tiers verified to round-trip; whether GLM honours `xhigh`/`max`
 *  or rejects them is unanswered, and can only be settled by a live run while the backend has headroom
 *  (it is capped as of 2026-08-27). Widen this only from such a run, never from the roster alone. */
export const ZAI_EFFORTS = ["low", "medium", "high"] as const;
export type ZaiEffort = (typeof ZAI_EFFORTS)[number];

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

/**
 * One collaborator's share of a SHOTGUN task: its own objective plus the files it EXCLUSIVELY owns.
 *
 * The file list is not documentation — it is the safety mechanism. Shotgun collaborators work the same
 * checkout on the same branch (the no-worktrees convention), so nothing merges their changes and two
 * agents editing one file destroy each other's work. Disjoint ownership is what prevents that, which is
 * why a decomposition whose file sets intersect is rejected outright (orchestrator/shotgun.ts).
 *
 * Lives here rather than beside that logic because it is persisted on the thread row and mirrored to the
 * client, so it is part of the shared contract. Mirrored byte-for-byte in web/src/types.ts.
 */
export interface ShotgunAssignment {
  title: string; // short board-lane title for the collaborator thread
  objective: string; // the collaborator's complete standalone brief
  files: string[]; // the paths it exclusively owns; nothing outside them may be edited
}

export interface Thread {
  id: string;
  title: string;
  state: ThreadState;
  workspace: string; // target repo cwd for the implementor
  brief: string; // enriched brief that kicked off the pipeline
  rawPrompt: string; // the user's original ask
  error?: string | null;
  /** Strict per-task implementor model request copied from the owner's Director prompt. `model` is the
   * canonical provider id resolved from the live system; null means the request is persisted but cannot
   * currently be resolved, which blocks clearly instead of falling back. */
  modelRequest?: ModelRequest | null;
  effortOverride?: Effort | null; // operator-pinned implementor effort, snapshotted at a skip-director dispatch — beats the planner's pick
  closedAt?: number | null; // when soft-closed (state === "closed"); drives the 30-day auto-purge clock
  closedPrevState?: ThreadState | null; // the state a closed task came from — 'done' means it finished correctly (drives the closed-card checkmark)
  lane?: ThreadLane | null; // dispatch lane: null = normal pipeline, 'read' = the read-only reader lane (drives the card's READ badge)
  baselineHead?: string | null; // repo HEAD sha captured at dispatch — the "before" point for scoping the Changes chip to this task's own diff; null when not a repo / legacy rows
  // ---- Timed task: a single task with a wall-clock work window (orchestrator/timedTasks.ts) ----
  durationMs?: number | null; // the window the owner asked for; null = an ordinary task with no window
  deadlineAt?: number | null; // absolute epoch ms once work starts; null while a timed task is queued (or for an ordinary task)
  // ---- Operator hard stop: independent of the timed-task work-window mode ----
  // Unlike deadlineAt, this is enforced immediately against a busy live run. The task is parked with
  // its resumable session/evidence intact when the instant arrives; null means no operator hard stop.
  activeDeadlineAt?: number | null;
  // ---- Shotgun task: N collaborators on one objective (orchestrator/shotgun.ts) ----
  agentCount?: number | null; // collaborators the owner asked for; null/1 = an ordinary single-agent task
  parentId?: string | null; // set on a COLLABORATOR: the lead task it belongs to (hidden from the board, shown inside the lead)
  assignment?: ShotgunAssignment | null; // a collaborator's owned share — objective + the files it exclusively owns
  /** Owner-facing projection of the durable deploy-only handoff stored in stage_outputs. */
  manualDeployment?: ManualDeploymentSummary | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * A recurring dispatch: a prompt run against a target repo on a cron schedule. Each fire creates a
 * normal task (Thread) via the standard pipeline — so it uses whichever providers/models are active,
 * exactly like a hand-dispatched task. Editable from the Scheduled Tasks view and via the director's
 * scheduling tools. Persisted in the `scheduled_tasks` table; mirrored in web/src/types.ts.
 */
export interface ScheduledTask {
  id: string;
  title: string; // board-lane title used for each dispatched run
  workspace: string; // target repo (absolute path) the prompt runs in
  prompt: string; // the brief handed to the pipeline on each fire
  cron: string; // 5-field cron expression (server-local time)
  enabled: boolean; // off → the schedule is kept but never fires
  effort?: Effort | null; // optional implementor effort override for each run; null = the planner decides
  lastRunAt?: number | null; // epoch ms of the last fire, or null if it hasn't run yet
  nextRunAt?: number | null; // epoch ms of the next fire while enabled, else null
  lastThreadId?: string | null; // the task id created by the most recent fire (jump target in the UI)
  createdAt: number;
  updatedAt: number;
}

/** The hard ceiling on a note's body, in characters. The whole point of the note list is that it can be
 *  skimmed in seconds, so this is enforced by TRUNCATION at the write boundary (never a rejection — a
 *  long note still carries its link). Mirrored in web/src/types.ts and in the bus tool's description. */
export const NOTE_MAX_CHARS = 255;

/**
 * One line on the operator's note list: a pointer an agent leaves for the owner — a branch pushed, a PR
 * opened, something to click, review and then delete. It is NOT a finding (findings are the agents'
 * shared blackboard, scoped to a task); this list is the owner's own, spans every task, and only they
 * clear it. Persisted in `operator_notes`; mirrored in web/src/types.ts.
 */
export interface OperatorNote {
  id: string;
  body: string; // the one-liner, hard-capped at NOTE_MAX_CHARS
  url?: string | null; // the click target (http/https only) — the branch/PR the note is about
  threadId?: string | null; // the task that left it; null when the owner or director wrote it
  threadTitle?: string | null; // snapshot of that task's title, so the note survives the task's purge
  workspace?: string | null; // snapshot of the repo it came from — which project this is about
  fromRole?: Role | null; // the agent role that posted it; null for the owner's own note
  fromName?: string | null; // that agent's office name, so the note reads as "Liv (implementor)"
  createdAt: number;
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
  tokenUsage?: TokenUsage | null;
  error?: string | null;
  /** Whether the RUNNER saw a usage cap during this run (`rateLimited` / a CLI backend's `capped`) — the
   *  flag every failover path keys on. Persisted because its absence is otherwise unprovable: a cap the
   *  runner failed to recognize looks exactly like a crash, and telling the two apart meant inferring from
   *  missing findings and kv latches that self-expire. Sticky for the whole run on Claude/z.ai; the CLI
   *  backends re-arm per turn, so theirs describes the last one. Null = no runner verdict was recorded —
   *  a row predating the flag, or one a restart/silent-run stamp closed out instead of its own agent. */
  capFlagged?: boolean | null;
  startedAt: number;
  endedAt?: number | null;
}

/** Provider-neutral token accounting captured from a run's terminal usage payload. Every category is
 *  preserved because subscription-backed models can have $0 nominal cost while consuming scarce plan
 *  allowance, and cache/reasoning ratios are useful evidence for later model + effort choices. */
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

/** The terminal disposition of one implementor run. `completed` requires an actual owner-facing
 * conclusion; a success-shaped provider envelope with no conclusion is recorded separately so the
 * console never invents a successful work memo from transport state alone. */
export type ImplementationMemoOutcome = "completed" | "failed" | "interrupted" | "no_conclusion";

/** Where the run's work went after it ended. `pending` is a truthful short-lived/default state when
 * the run ended before the pipeline could durably cross its next boundary. */
export type ImplementationMemoHandoff = "pending" | "qa" | "reviewer" | "review" | "done" | "resumed";

/** How the memo came to exist. `run` was captured as the run itself ended. `backfill` was reconstructed
 * once from durable run history for work that predates the feature, so its report is the run's last
 * durable prose and its `handoff` is derived from task state rather than observed at the boundary. */
export type ImplementationMemoSource = "run" | "backfill";

/** Deliverables are snapshotted into the memo so a from-scratch retry cannot erase the audit trail.
 * `available` is derived when read: false means the original finding/file card was later removed. */
export interface ImplementationMemoDeliverable {
  findingId: string;
  label: string;
  path: string;
  description?: string | null;
  available: boolean;
}

/** Durable owner-facing record of one implementor work revision. The report is the implementor's
 * actual final completion reply, not a generated summary; diagnostics preserve non-success outcomes. */
export interface ImplementationMemo {
  id: string;
  threadId: string;
  runId: string;
  workRevision: string;
  revision: number;
  outcome: ImplementationMemoOutcome;
  handoff: ImplementationMemoHandoff;
  source: ImplementationMemoSource;
  report?: string | null;
  diagnostic?: string | null;
  model: string;
  account?: string | null;
  deliverables: ImplementationMemoDeliverable[];
  startedAt: number;
  completedAt: number;
  createdAt: number;
  updatedAt: number;
}

export type MessageKind = "text" | "tool" | "result" | "system" | "thinking";

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
  remoteInstance?: string | null; // set when the line came from another machine's orchestrator (its name)
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
const ROLE_RANK: Record<Role, number> = { director: 0, planner: 1, researcher: 2, implementor: 3, qa: 4, reader: 5, reviewer: 6 };

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
  threadIds: string[]; // distinct LOCAL tasks that have participated (sent or were announced into the room)
  remoteInstances: string[]; // distinct other machines whose agents have participated (Online Office)
  messageCount: number;
  lastAt: number;
}

/** Whether a project room is a real collaboration — the test the console gates its chatroom surfaces on.
 *  Among purely local tasks it takes two. But a project room only exists HERE for a repo this machine is
 *  working (a remote line for a repo we don't have lands in the general room instead), so one machine on
 *  the far side of the Online Office is already a collaboration — and it may be the only party that has
 *  spoken yet, our own task having not replied. Gating on local `threadIds` alone hid every cross-machine
 *  conversation behind a tab that never appeared. */
export function isCollaborationRoom(r: Pick<ChatRoomSummary, "threadIds" | "remoteInstances">): boolean {
  return r.remoteInstances.length > 0 || r.threadIds.length >= 2;
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

/** Where a task's text matched the search — the console labels the hit with it, and the server picks
 *  the most informative one as the snippet source (the owner's own brief beats agent chatter, and a
 *  title match needs no snippet because the title is rendered highlighted anyway). */
export type TaskMatchSite = "title" | "brief" | "conversation";

/** One task matched by the console's search box, the other half of a search result beside the director
 *  conversation. The search spans a task's whole CONVERSATION and not just its title and brief, because
 *  the word the owner remembers is often one an agent coined mid-run — a project folder, a generated
 *  file — that appears nowhere in the prompt that started the task. */
export interface TaskSearchHit {
  threadId: string;
  title: string;
  state: ThreadState;
  workspace: string;
  createdAt: number;
  where: TaskMatchSite;
  // A window around the first match, cut server-side: a matching `result` message is routinely
  // megabytes of tool output, which must never reach the socket. Empty for a title-only match.
  snippet: string;
  // How many of the task's conversation messages match — the "worked on this a lot" signal that tells
  // a passing mention apart from the task that actually did the work. 0 for a title/brief-only match.
  messageHits: number;
}

export type ImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

/** A file the user pasted/dropped, carried inline (base64) from the GUI on send. The server persists
 * bytes once and sends only AttachmentRef over history/events. */
export interface FileAttachment {
  name: string;
  mediaType: string;
  dataBase64: string;
}

/** The image-only subset supported as a native multimodal provider content block. */
export interface ImageAttachment extends FileAttachment {
  mediaType: ImageMediaType;
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
  /** Set by a QA-fixes run when it actually changed the working tree. The pipeline uses this to send
   *  the changed work to another QA pass instead of bouncing it back through the implementor. */
  changed?: boolean;
  /** Present only when QA proves manual deployment is the sole remaining action. */
  manualDeployment?: ManualDeploymentClaim;
}

export interface ResearchOutput {
  summary: string;
  facts: { claim: string; source?: string }[]; // external claims, each with the source it came from
  memories: { name: string; gist: string }[];
  warnings: string[];
}

/** The reader lane's disposition. MCP-capable readers post the answer as a finding themselves; the
 *  answer field lets a read-only Codex fallback return the same payload for ThreadManager to post. */
export interface ReaderOutput {
  answered: boolean; // fully answered read-only and posted the answer as a finding
  escalated: boolean; // needs the full pipeline (edits/verification/depth) — posted a 'needs full pipeline' finding instead of half-answering
  answer: string; // complete owner-facing answer, or the escalation explanation; used by the Codex reader fallback
  reason?: string; // when escalated: the one-line reason
}

/** How broad/risky a task's own text reads, per `orchestrator/routeSelection.ts`'s deterministic
 *  classifier — "narrow" (implementor only), "standard" (the smallest added support, such as QA), or
 *  "broad" (planner + QA). */
export type RouteScope = "narrow" | "standard" | "broad";

/** The implementor capability floor attached to a task-aware route. `adaptive` leaves the existing
 * cheapest-capable selector in charge. `flagship` prevents outcome history or capacity balancing from
 * silently downgrading risk-bearing work below the policy-approved flagship set. */
export type ImplementorModelTier = "adaptive" | "flagship";

export interface ImplementorModelPolicy {
  tier: ImplementorModelTier;
  /** First choice when it is dispatchable with task-sized runway. This is a preference, not an owner pin:
   * a named policy-approved flagship fallback may run when the preferred model is unavailable. */
  preferredModel?: string;
  reason: string;
  signals: string[];
}

/** Reproducible non-semantic evidence behind the route. These counts also feed capacity reservation, so
 * a long multi-part brief without a planner still reserves more than a one-line edit. */
export interface RouteEvidence {
  wordCount: number;
  fileCount: number;
  compoundCount: number;
  riskCount: number;
}

/**
 * Task-aware pipeline route: whether THIS task benefits from the planner and/or QA, independent of
 * whether those roles are enabled (enabled = available; forcing them on every task regardless of size is
 * exactly what this decision replaces). Computed once per pipeline episode (sticky, like `planDone`) and
 * persisted so a resume never re-classifies mid-task. `reason`/`signals` are what the console shows the
 * owner so the pick is explainable, not a silent omission. See `orchestrator/routeSelection.ts`.
 */
export interface RouteDecision {
  usePlanner: boolean;
  useQa: boolean;
  scope: RouteScope;
  reason: string; // one-line, owner-facing explanation
  signals: string[]; // the matched signal names behind `reason`, for the console/audit trail
  /** Added in route policy v2. Optional only so persisted pre-v2 decisions can be upgraded safely. */
  modelPolicy?: ImplementorModelPolicy;
  evidence?: RouteEvidence;
  policyVersion?: number;
}

/** The auto-review verdict — the owner's own accept/hand-back decision, delegated to one agent. It is
 *  the ONLY thing that decides the outcome: `accept` settles the parked task 'done', anything else hands
 *  it back to 'review' with `issues` naming what a human still has to look at. */
export interface ReviewerOutput {
  accept: boolean; // the work genuinely satisfies the brief and can be accepted as finished
  summary: string; // what was verified and why it was (or wasn't) accepted
  issues?: QaIssue[]; // when not accepting: the concrete reasons, so the owner sees the list without re-reviewing
  manualDeployment?: ManualDeploymentClaim;
}

/** Structured evidence for the narrow terminal exception where all repository work is complete and
 * only an external/manual deployment remains. Incomplete evidence fails closed. */
export interface ManualDeploymentClaim {
  version: 1;
  commitSha: string;
  remoteRef: string;
  environment: string;
  instructions: string;
  verification: Array<{ command: string; outcome: "passed" }>;
  assertions: {
    implementationCommitted: true;
    requiredVerificationPassed: true;
    noUncommittedChanges: true;
    noMergeOrDivergence: true;
    credentialsAndDataReady: true;
    noOwnerDecisionRequired: true;
    noAdditionalBlockers: true;
    postDeployVerificationRequired: false;
  };
}

export type ManualDeploymentVerifier = "qa" | "reviewer" | "owner" | "implementor_no_qa";

/** Durable stage marker. A verified marker is a terminal fence for restart, Supervisor, and cap paths. */
export interface ManualDeployment {
  kind: "manual_deployment";
  version: 1;
  status: "declared" | "verified" | "invalidated";
  claim: ManualDeploymentClaim;
  declaredBy: "implementor" | "qa" | "reviewer";
  declaredRunId: string;
  declaredAt: number;
  verifiedBy?: ManualDeploymentVerifier;
  verifiedRunId?: string | null;
  verifiedAt?: number;
  invalidReason?: string;
}

export interface ManualDeploymentSummary {
  status: ManualDeployment["status"];
  commitSha: string;
  environment: string;
  instructions: string;
  verifiedAt?: number | null;
  invalidReason?: string | null;
}

/** Who requested one auto-review episode. `owner` covers the authenticated button/API and explicit
 * owner-directed Supervisor chat; only the unattended watchdog uses `supervisor`. `reconciled` marks
 * legacy outcomes recovered from the durable task/run trail during migration. */
export type AutoReviewSource = "owner" | "supervisor" | "reconciled";

/** Durable ownership and terminal outcome for the latest reviewable revision of one task. The task row
 * remains the owner-facing state/reason; this record is the idempotency authority that prevents the
 * unattended Supervisor from treating its own reviewer hand-back as a fresh review handoff. */
export interface AutoReviewEpisode {
  threadId: string;
  revision: string;
  status: "running" | "accepted" | "parked";
  source: AutoReviewSource;
  claimToken: string | null;
  attemptCount: number;
  reason: string | null;
  verdict: ReviewerOutput | null;
  verdictRunId: string | null;
  startedAt: number;
  settledAt: number | null;
  updatedAt: number;
}

// ---- Auto model selection: the pick, its grade, and the scoreboard the next pick reads ----

/** The implementor model auto-selection picked for ONE task: which backend, which model, how hard it
 *  should think, and the one-line reason. Persisted on the thread's stage outputs, because a resume must
 *  land on the SAME backend (session ids are provider-specific) and the grade written at settle has to
 *  name what was actually chosen. Absent = the setting was off, or the pick failed and normal
 *  usage-based routing decided. */
export interface ModelPick {
  provider: ImplementorProvider;
  model: string;
  effort: Effort;
  reason: string;
}

/** How a graded task ended. `cancelled` is recorded but never scored — the owner stopped it, which says
 *  nothing about the model. */
export type ModelOutcome = "done" | "review" | "failed" | "cancelled";

/**
 * One auto-selected task's record: what was picked, and how the work it produced actually turned out.
 * Written when the pick is made and completed when the task settles. Deliberately NOT foreign-keyed to
 * `threads`: a task is purged 30 days after it closes, and the entire point of this table is that the
 * lesson outlives the task it was learned from (the same reasoning as chat_messages).
 */
export interface ModelGrade {
  threadId: string;
  workspace: string; // normalized workspace — the repo the pick was made for
  title: string;
  provider: ImplementorProvider;
  model: string;
  effort: Effort;
  reason: string;
  outcome?: ModelOutcome | null; // null while the task is still running
  score?: number | null; // 0-100 quality score; null while ungraded or when the ending wasn't scoreable
  qaRounds?: number | null; // QA rounds the task consumed (0 = QA disabled / never reached it)
  costUsd?: number | null; // summed across ALL the task's agent runs at settle time — a cheap model that
  // needs three QA rounds is not cheap, and only the whole-task total says so
  numTurns?: number | null;
  tokenUsage?: TokenUsage | null; // whole-pipeline totals, durable after the source task is purged
  tokenUsageComplete?: boolean | null; // every run in the pipeline supplied usage; false = retain partial data but never compare it as a full cost
  durationMs?: number | null; // dispatch → settle wall-clock
  /** Every distinct model that actually ran the implementor role, comma-joined — a cap-failover can move
   *  the work off the picked model mid-task, and the record has to say so. */
  ranModels?: string | null;
  /** The single model the whole implementation ran on, else null. Only these rows feed the scoreboard:
   *  a task split across two models is evidence about neither. */
  gradedModel?: string | null;
  createdAt: number;
  gradedAt?: number | null;
}

/** Aggregated performance of one model — what the next selection reads, and what the Settings scoreboard
 *  renders. Averages are over graded, single-model tasks only. */
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
  tokenSampleRate: number; // 0-1 of graded tasks with complete whole-pipeline token telemetry
  avgMinutes: number;
}

/** The same durable evidence split by the auto-selected effort. Aggregate model stats remain useful
 *  with sparse history; this second view teaches the selector when low/medium/high actually paid off. */
export interface ModelEffortStat extends ModelStat {
  effort: Effort;
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
  // The reader's disposition when it escalated (needs implementation capability) — persisted BEFORE the task is
  // promoted into the normal route, so a restart landing in that gap can recover the exact escalation
  // (handleReadLane) instead of re-running the reader or leaving the task stuck in 'queued' forever.
  // originalBrief classifies the owner request rather than our appended reader handoff prose.
  readerEscalation?: { reason: string; answer: string; originalBrief?: string } | null;
  // Task-aware route (routeSelection.ts): whether the planner and/or QA run for THIS task, independent of
  // whether they're enabled. Computed once per pipeline episode and persisted so a resume never
  // reclassifies mid-task (the brief may since have grown an escalation block, which must not flip an
  // already-running episode's route).
  routeDecision?: RouteDecision | null;
  // An explicit owner injection asked to finish this task without QA. Unlike the route decision (an
  // automatic, sticky classification), this human override wins at every later implementor-to-QA
  // boundary, including after a server restart. A Retry wipes stage_outputs and resets it.
  ownerQaBypassedAt?: number;
  // Never inferred from ordinary findings or error prose; this versioned evidence is the only
  // automatic route from a deploy-only handoff to done.
  manualDeployment?: ManualDeployment | null;
  /** A malformed/rejected CLI/MCP declaration is kept so a no-QA completion cannot silently ignore
   * load-bearing evidence and take the ordinary done path. Cleared only by a new work episode. */
  manualDeploymentAttempt?: { runId: string; at: number; reason: string } | null;
  qaRoundsUsed?: number; // QA rounds already spent in the current implementor→QA episode — persisted so a
  // `qaCapRetryRound` is set when this already-charged QA attempt was provider-capped. It makes
  // auto-resume rerun QA directly (never the finished implementor), including at the normal round cap.
  qaCapRetryRound?: number;
  // A server restart can land while QA is live after the implementor has already completed. Preserve
  // that exact charged review so boot recovery resumes QA itself rather than replaying implementation.
  qaInterruptedRetryRound?: number;
  // An operator interrupted QA on purpose and wants this SAME task returned to implementation. This
  // marker makes the choice durable across a restart and lets a stale QA verdict be ignored safely.
  qaSuperseded?: { at: number; messages: string[]; attachmentIds?: string[] } | null;
  // QA produced a failing verdict and the normal implementor fix resume is being materialized. State
  // remains `qa` until the implementor handle is live, so this durable marker keeps that owed fix resume
  // recoverable across a restart and lets injections during the handoff join the same resume.
  qaFixHandoff?: { at: number; resumeNudge: string; messages?: string[]; attachmentIds?: string[] } | null;
  // server restart / cap-resume CONTINUES the maxQaRounds budget instead of resetting it to 1 (which let a
  // bouncing server re-run a fresh full QA pass on every resume and drain the backend). Reset by retry (blob nulled).
  qaCutoffResumes?: number; // continuations spent waking a QA run that stopped at its per-session turn ceiling
  // before it could return a verdict. Charged separately from qaRoundsUsed (a cutoff isn't a review↔fix cycle)
  // and persisted before each retry, so a restart mid-continuation can't re-enter the loop forever. Counts the
  // task's LIFETIME, which is what reconciles its QA launches; the budget is enforced against the field below.
  qaCutoffResumesThisRound?: number; // the same continuations, but only those spent on the review currently
  // running — zeroed the moment a round reaches a verdict. A cutoff is a property of ONE review, so the
  // allowance has to be too: enforcing the lifetime count meant a round-4 cutoff could be denied its
  // continuation because rounds 1 and 2 had each already used one, parking a task on the owner although no
  // single review ever failed twice. Every value it holds is also inside qaCutoffResumes, never on top of it.
  reviewFixing?: boolean; // an auto-review fix round owns the 'implementing' state right now. The auto-review
  // lane is in-process only (a restart during it re-parks for a fresh click), but its fix round runs under
  // 'implementing' — an AUTO_RESUME state — so without this marker a restart would auto-resume the task into
  // the normal pipeline instead, re-entering the QA loop the episode had already left behind.
  selfImproving?: boolean; // the opt-in post-task self-improvement round owns the slot right now. That round
  // starts only AFTER the task was accepted, and holds it in AUTO_RESUME states throughout ('qa' until its
  // implementor goes live, then 'implementing') — so it is the MARKER, never the state, that tells a restart
  // this work is already accepted. Without it a bounce auto-resumes the task back into the pipeline and
  // spends another implementor + QA round on it; with it the restart settles it where it was headed: done.
  autoResumeRevivals?: number; // times a boot has re-armed a restart auto-resume that an EARLIER boot promised
  // (state 'failed' + the auto-resuming marker) but died before delivering. Durable because the whole failure
  // mode is a process not surviving long enough to keep its own promise; reset by the next real interruption,
  // so it bounds one episode's consecutive misses rather than the task's lifetime.
  modelPick?: ModelPick | null; // the auto-selected implementor model for this task (null = selection ran but
  // produced nothing usable, so normal routing decides). Lives here rather than on the thread row because it
  // is a per-EPISODE decision: a retry nulls the blob and re-selects against the latest grades.
  qaSilentRetries?: number; // fresh-session retries spent after a QA run came back EMPTY (a warm --resume that
  // never reached the model: 0 turns, $0, no output). Also charged separately, and durable for the same
  // reason — a restart landing mid-retry must not hand the task an unbounded supply of full Opus reviews.
  // Counts the task's LIFETIME, which is what reconciles its QA launches; the budget is the field below.
  // ---- Timed task counters (orchestrator/timedTasks.ts). Durable because the whole point of a work
  //      window is that it survives what interrupts it: a restart, a turn ceiling, a provider hand-off
  //      and a cap park all re-enter the pipeline, and each must continue the SAME window rather than
  //      restart its budget. An in-memory counter would hand a bouncing server an unbounded loop.
  timedExtensions?: number; // extension rounds granted so far inside the window
  timedHollowRounds?: number; // consecutive rounds that returned instantly having produced nothing (the runaway guard)
  timedCompleteEarly?: boolean; // the implementor declared the objective complete — the window closes, whatever time is left
  timedFinalizing?: boolean; // the window has closed and the task is in its final integration/QA path; a restart must not re-open it
  // ---- Shotgun counters (orchestrator/shotgun.ts) ----
  shotgunPlanned?: boolean; // the decomposition step ran (true even when it declined to split) — sticky, so a resume never re-splits an already-running task
  shotgunChildren?: string[]; // the collaborator thread ids, so the barrier is re-derivable after a restart instead of living in memory
  shotgunDegraded?: string; // why this task ran single-agent after all (the owner-facing reason); absent when it genuinely parallelized
  shotgunAssignment?: ShotgunAssignment | null; // the LEAD's own share of the split, so a resume re-hands it the same scope
  shotgunIntegrated?: boolean; // the integration/reconcile pass ran — sticky, so a restart doesn't redo it
  /** A legacy/partial split was found without a complete durable ownership contract. It is quarantined
   *  for a human instead of resuming a lead alongside unknown peers in the shared working tree. */
  shotgunRecoveryBlocked?: string;
  qaSilentRetriesThisRound?: number; // the same retries, but only those spent on the review currently running
  // — zeroed the moment a round reaches a verdict, for the reason qaCutoffResumesThisRound exists. An empty
  // run is a property of ONE review too: a round whose retry WORKED still spent the lifetime count, so a
  // later round's first empty run was denied the retry and parked the task although no single review had
  // ever come back empty twice. Every value it holds is also inside qaSilentRetries, never on top of it.
}

/**
 * Operator-tunable pipeline settings, persisted server-side in the `kv` table and broadcast to every
 * client (mirrors `approvalMode`). Read live at dispatch/pipeline time, so a change applies to the
 * next task without a restart — the agent toggles in particular are meant to be flipped per task.
 */
export interface OrchestratorSettings {
  /** Wording-only policy for every owner-facing/operational agent channel. It never changes work depth,
   *  permissions, tools, or structured outputs. On by default; read live for each new/resumed turn. */
  conciseAgentCommunication: boolean;
  plannerEnabled: boolean; // off → skip the planner; the implementor runs straight from the brief
  researcherEnabled: boolean; // off → never run the researcher even if the planner routes to it
  qaEnabled: boolean; // off → skip the QA loop; the implementor's output is final
  differentProviderQa: boolean; // off (default) → QA runs on the default backend (Claude). on → QA is routed to a DIFFERENT enabled provider than the one that implemented the task (e.g. GPT/Codex reviews Claude's work, and vice-versa), for an independent cross-provider review. Falls back to normal QA when no other provider is enabled+ready.
  qaAppliesFixes: boolean; // off (default) → QA reports issues to the implementor. on → QA fixes issues itself, then another QA pass verifies each changed working tree until a pass makes no code changes.
  autoPush: boolean; // off → the implementor commits but does NOT push (overrides the push doctrine)
  directorName: string; // the director persona's display name, set by the operator (default "ChangeNameInSettings")
  maxQaRounds: number; // implementor↔QA fix-rounds before a task settles to review
  maxReviewFixRounds: number; // implementor fix-rounds the auto-reviewer may trigger when it hands a task back (default 1; 0 = hand straight back to the owner, the pre-fix-round behavior)
  selfImproveEnabled: boolean; // off (default) → opt-in; on → after a task completes, the implementor runs one extra round building the tools/skills/memories that would have made the task easier
  autoModelSelection: boolean; // off (default) → configured models + usage-aware provider routing. on → one smart call picks a sticky director model (re-picked on cap), and before each implementor starts a provider-neutral judge picks its model AND effort from every backend dispatchable right now. Implementor picks are graded for the next choice.
  maxConcurrent: number; // max pipelines running at once; further dispatches wait in 'queued'
  maxConcurrentPerRepo: number; // max pipelines running at once for a SINGLE repo (normalized workspace); 0 (default) = unlimited. Additional tasks for a repo already at its per-repo cap wait in 'queued' until one of that repo's tasks finishes — tasks in OTHER repos are unaffected (they still run up to maxConcurrent).
  // ---- Token-usage safety limit: opt-in auto-stop when live utilization reaches a threshold ----
  tokenLimitEnabled: boolean; // off (default) → never auto-stop; on → stop running agents at the threshold
  tokenLimitPercent: number; // % of the token (rate-limit) window that trips the stop — clamped 50–99, default 80
  // ---- Auto-resume on token-window reset: when usage is high, schedule a wakeup at the reset that
  //      resumes work that froze on the cap — so the orchestrator recovers AFK, no manual Resume. ----
  autoResumeOnTokenReset: boolean; // off (default) → opt-in; on → arm a reset-timed resume when usage crosses the threshold below
  autoResumeThresholdPercent: number; // % of the token window at which the resume is armed — clamped 50–95, default 80
  // ---- Fast usage polling: opt-in tighter cadence for the account usage ping ----
  fastUsagePolling: boolean; // off (default) → 10-min ping; on → poll every ~30s so the strip tracks the live burn within ~1-2%
  spreadUsage: boolean; // off (default) → burn the soonest-resetting provider/sub first; on → always dispatch to the provider (Claude sub, Codex, or Grok) with the lowest weekly usage, balancing burn across every enabled platform
  // ---- Subscriptions: which provider backs the implementor (hard routing gate at dispatch) ----
  // Claude is the default backend. Planner/researcher/QA start on Claude and fail over to an enabled
  // Codex/Grok CLI when every Claude sub is capped (structured-output adapters recover the role result).
  // Individual Claude accounts are toggled via AccountDTO.enabled (account.set), not a setting here.
  codexEnabled: boolean; // OpenAI Codex: when on (with a valid key), it becomes the implementor backend
  codexModel: string; // the resolved Codex implementor model (mirrors modelOverrides.codex.implementor; kept for the top-bar chip + back-compat)
  codexEffort: CodexEffort; // Codex CLI reasoning effort, applied via model_reasoning_effort
  codexWeeklySafetyPct: number; // 1-100 soft weekly ceiling (default 100 = off): at/above this Codex weekly utilization, new tasks route to another backend
  hasOpenaiKey: boolean; // read-only indicator — an OpenAI key is stored (the raw key is never broadcast)
  openaiKeyLast4?: string | null; // read-only — last 4 chars of the stored key, for the masked field
  codexChatgptLogin: boolean; // read-only — a ChatGPT-plan `codex login` is available; preferred over the key
  grokEnabled: boolean; // xAI Grok (SuperGrok): when on (with a `grok login`), it joins the implementor backends
  grokModel: string; // the resolved Grok implementor model (mirrors modelOverrides.grok.implementor; kept for the chip + back-compat)
  grokEffort: GrokEffort; // Grok CLI reasoning effort, applied via --reasoning-effort
  grokWeeklySafetyPct: number; // 1-100 soft weekly ceiling (default 100 = off): above it, new tasks route to another backend
  // The orchestrator scrapes SuperGrok's real weekly limit + reset from the CLI's `/usage show`
  // (grokUsagePing), so Grok auto-competes in provider routing by soonest weekly reset exactly like
  // Claude/Codex, auto-falling-back when a Grok turn is usage-rejected or its weekly window is exhausted.
  grokSignedIn: boolean; // read-only — a `grok login` (auth.json) is present, so Grok can authenticate
  grokAccount?: string | null; // read-only — the signed-in Grok account email, for the Subscriptions panel
  // Zhipu z.ai (GLM Coding Plan): when on (with an API key), it joins the implementor backends. Unlike
  // Codex/Grok it runs on the Claude Agent SDK path via z.ai's Anthropic-compatible endpoint, so it keeps
  // the in-process bus/office MCP tools and can also take failover for planner/researcher/QA.
  zaiEnabled: boolean;
  zaiModel: string; // the resolved z.ai GLM implementor model (mirrors modelOverrides.zai.implementor; kept for the chip + back-compat)
  zaiEffort: ZaiEffort; // z.ai reasoning effort cap (low/medium/high), applied to the SDK run like the other backends
  zaiWeeklySafetyPct: number; // 1-100 soft weekly ceiling (default 100 = off): at/above this z.ai weekly utilization, new tasks route to another backend
  zaiKeyPresent: boolean; // read-only — an API key is stored (env or kv); the raw key is never broadcast
  zaiKeyLast4?: string | null; // read-only — last 4 chars of the stored key, for the masked field
  zaiModels: string[]; // read-only: pickable z.ai GLM model ids (curated ∪ selected)
  // ---- Phone notifications: post to a Discord channel when a task finishes or needs you ----
  discordNotify: boolean; // off (default) → nothing is posted; on → a Discord message when a task settles done, needs your input (a review park or an agent's question), or fails. Pipeline chatter (cap failover, auto-resume) is never posted.
  discordChannelId: string; // the Discord channel the notices go to — accepts a bare id, a channel link or a <#id> mention, stored as the id; empty falls back to DISCORD_CHANNEL_ID
  discordTokenPresent: boolean; // read-only — a bot token is stored (env or kv); the raw token is never broadcast
  discordTokenLast4?: string | null; // read-only — last 4 chars of the stored token, for the masked field
  // ---- Composer state, persisted server-side (not localStorage) so it survives across the HTTP and
  //      HTTPS surfaces the console is served on — the two origins don't share localStorage. ----
  skipDirector: boolean; // composer's skip-director mode — persists so "on" stays on next time it opens
  showComposerPickers: boolean; // whether the director composer shows the quick model + effort dropdowns (default off — hidden)
  showAgentModel: boolean; // whether agent labels in the thread feed append the run's model + effort — "QA (Tor, Opus 4.8 High)"
  skipDirectorEffort: Effort | "auto"; // composer's implementor effort for skip-director dispatches — "auto" inherits a planner pick only when planning runs
  // The composer's task-mode picks, applied to the task the NEXT send dispatches (both director and
  // skip-director). Persisted like the effort pick so they survive a reload and the HTTP/HTTPS split —
  // and rendered lit while active, because a forgotten 8h window is an expensive surprise.
  taskDurationMinutes: number; // TIMED: minutes of wall-clock work window; 0 (default) = an ordinary task
  taskAgentCount: number; // SHOTGUN: agents to work the objective at once; 1 (default) = an ordinary task
  xhighEnabled: boolean; // read-only — the ENABLE_XHIGH opt-in is on, so the xhigh tier is offerable
  skipDirectorRetitle: boolean; // when skip-director is on, mint a real title via a cheap Haiku call instead of the raw first line (default on)
  maxRecentRepos: number; // how many recent-repo chips the composer shows (clamped 1–20, default 5)
  recentRepos: string[]; // recently-dispatched repo paths, most-recent first (capped at maxRecentRepos)
  // ---- Per-(subscription × role) model selection ----
  modelOverrides: ModelOverrides; // operator-picked models: {subId → {role → modelId}} (writable via settings.set)
  // Per-Claude-account MAX reasoning-effort cap ({accountId → effort}). The director/planner still picks
  // the per-task effort; this only caps it so a heavy tier never runs on a sub the operator wants cheap.
  // Absent/`max` = uncapped. Codex/Grok caps live in codexEffort/grokEffort. Writable via settings.set.
  accountEffortCaps: Record<string, Effort>;
  modelDefaults: Partial<Record<Role, string>>; // read-only: the built-in per-role defaults (config.models)
  claudeModels: string[]; // read-only: pickable Claude model ids (live ∪ curated ∪ selected), most-capable first
  codexModels: string[]; // read-only: pickable Codex/OpenAI model ids (live ∪ curated ∪ selected)
  codexModelEfforts: Record<string, CodexEffort[]>; // read-only: exact CLI-advertised effort set per Codex model
  grokModels: string[]; // read-only: pickable Grok model ids (curated ∪ live ∪ selected)
  // ---- Director Supervisor: a lightweight watchdog over active tasks (orchestrator/supervisor.ts) ----
  directorSupervisorEnabled: boolean; // off (default) — no background work at all. on — deterministic health checks plus an occasional cheap bounded agent check-in on tasks that look stalled, anomalous, or forgotten.
}

/** The implementor backend chosen at dispatch by the subscription toggles. */
export type ImplementorProvider = "claude" | "codex" | "grok" | "zai";

// ---- Co-work: durable, human-led coding conversations ----

/** Co-work is deliberately separate from ThreadState. A completed turn returns to `idle`; it never
 * enters QA/review/done or any other autonomous pipeline state. */
export type CoworkSessionState = "idle" | "running" | "stopping" | "error";
export type CoworkTurnState = "running" | "done" | "error" | "cancelled" | "interrupted" | "timeboxed";
export type CoworkMessageRole = "user" | "coworker" | "system";
export type CoworkMessageKind = "text" | "thinking" | "tool" | "tool_result" | "system";
/** Owner steering accepted while a Co-worker turn is live. Queue waits for the current safe unit,
 * append reaches the agent at its next live input point, and interrupt supersedes the active approach. */
export type CoworkSteeringMode = "queue" | "append" | "interrupt";

/** One long-lived human-led coding conversation. The requested fields preserve an explicit owner pin;
 * the actual fields become the sticky resolved target on the first turn, including for Auto. */
export interface CoworkSession {
  id: string;
  name: string;
  autoNamed: boolean;
  workspace: string;
  state: CoworkSessionState;
  requestedProvider: ImplementorProvider | null;
  requestedModel: string | null;
  provider: ImplementorProvider | null;
  model: string | null;
  effort: Effort | null;
  account: string | null; // sticky provider account id; required to resume a Claude session under the token that owns it
  agentSessionId: string | null;
  activeTurnId: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

/** One bounded work slice claimed by an initial owner prompt and optionally refined by live steering. */
export interface CoworkTurn {
  id: string;
  sessionId: string;
  state: CoworkTurnState;
  provider: ImplementorProvider | null;
  model: string | null;
  effort: Effort | null;
  account: string | null;
  agentSessionId: string | null;
  error: string | null;
  costUsd: number | null;
  numTurns: number | null;
  tokenUsage: TokenUsage | null;
  startedAt: number;
  endedAt: number | null;
}

/** A durable conversation item. `partial` rows are updated while output streams so a process restart
 * cannot erase a substantive reply that had already reached the browser. Tool metadata is full JSON;
 * the UI may collapse it, but persistence never truncates it. */
export interface CoworkMessage {
  id: string;
  sessionId: string;
  turnId: string | null;
  role: CoworkMessageRole;
  kind: CoworkMessageKind;
  content: string;
  attachments?: AttachmentRef[];
  meta: unknown | null;
  partial: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface CoworkActionResult {
  ok: boolean;
  session?: CoworkSession;
  error?: string;
}

/** An explicit owner model/capacity request. This is task-local and strict: automatic model/provider
 * routing remains unchanged for tasks without it, while a requested task never substitutes another
 * model on dispatch, failover, retry, or cap recovery. Mirrored in web/src/types.ts. */
export interface ModelRequest {
  requested: string;
  provider: ImplementorProvider | null;
  model: string | null;
  strict: true;
}

/** The backend/model the long-lived director is actually using right now. Unlike the configured model
 *  matrix this is runtime truth: cap failover and auto-selection can move the director between providers. */
export interface DirectorStatus {
  provider: ImplementorProvider;
  model: string;
  accountLabel: string;
}

/** The five agent roles a model can be picked for. Mirrored in web/src/types.ts. */
export const MODEL_ROLES: Role[] = ["director", "planner", "researcher", "implementor", "qa"];

/**
 * Which model each agent role runs on, per subscription. Keyed by subscription id — a Claude account
 * id (AccountDTO.id), the literal "codex" for the OpenAI backend, or "default" for the global per-role
 * fallback applied when a specific subscription has no override. Inner map is role → model id. A missing
 * entry falls through: subscription override → "default" override → the built-in config.models default.
 * Alternate providers never inherit a Claude default (a Claude model id would be invalid there); their
 * director row is meaningful through the provider-neutral command/native-tool director adapters.
 */
export const DEFAULT_SUB_ID = "default";
export const CODEX_SUB_ID = "codex";
export const GROK_SUB_ID = "grok";
export const ZAI_SUB_ID = "zai";
export type ModelOverrides = Record<string, Partial<Record<Role, string>>>;

export interface RateLimitInfo {
  status: "allowed" | "allowed_warning" | "rejected";
  resetsAt?: number;
  /** Whether `resetsAt` was supplied by the provider or is our bounded retry fallback. A real
   * provider-stated reset must win over a shorter, stale usage snapshot so routing never retries an
   * account before the provider said it would be available again. */
  resetSource?: "provider" | "fallback";
  rateLimitType?: "five_hour" | "seven_day" | "seven_day_opus" | "seven_day_sonnet" | "overage";
  utilization?: number;
}

// ---- Normalized agent stream events (decoupled from SDK message shapes) ----

export type AgentEvent =
  // sessionId is optional: Grok only reports it on the final `end` event, but we still emit `init` on the
  // first stream event so the run leaves "starting" during a multi-minute tool loop. A later `init` with
  // the real id overwrites when the CLI supplies it.
  | { type: "init"; sessionId?: string }
  | { type: "text_delta"; text: string }
  | { type: "text"; text: string }
  | { type: "thinking_delta"; text: string }
  // A completed reasoning segment persisted durably (kind: "thinking"). Grok's streaming-json exposes
  // no tool events, so reasoning is the only narrative of a long agentic run — emitting it durably (not
  // just as ephemeral thinking_delta) is what keeps a Grok transcript from looking empty after reload.
  | { type: "thinking"; text: string }
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
      // An SDK *error* result carries no `result` text at all — its diagnostic lives here (the CLI
      // backends, which build their own results, use `result` instead). Without this the only thing
      // left to persist for a failed Claude run is the subtype.
      errors?: string[];
      structuredOutput?: unknown;
      costUsd?: number;
      numTurns?: number;
      tokenUsage?: TokenUsage;
      // The turn was ABORTED (owner steering / a pause), not finished. The CLI ends an aborted turn with
      // a success-shaped, empty result, so without this flag nothing downstream can tell it from a run
      // that completed — which is how one office-chat post ended every implementor in a repo at once.
      aborted?: boolean;
      // The CLI's own verbatim reason for ending the turn ("completed", "aborted_tools", "max_turns",
      // "model_error", …). `aborted` is DERIVED from it against a hand-copied list, so carrying the raw
      // value is what makes "why wasn't this flagged?" a read rather than another paid SDK probe.
      terminalReason?: string;
    }
  | { type: "error"; message: string };

// ---- Director Supervisor: a lightweight watchdog over active tasks (orchestrator/supervisor.ts) ----
// Off by default (directorSupervisorEnabled above); when on it watches active tasks event-driven (thread
// state transitions) plus an adaptive-backoff periodic sweep for tasks that stopped producing events
// entirely, running cheap deterministic checks first and spending a bounded no-tools agent judgement
// call only when a task looks newly active, stalled, anomalous, or reaches review/done/error.

/** What caused one supervisor pass over a task: a live state transition, the periodic backoff sweep
 *  catching something the event path missed, or an operator-triggered "run now". */
export type SupervisorTrigger = "state_change" | "stall_sweep" | "manual";

/** What a pass concluded: 'check' = a deterministic, no-agent pass (routine, logged for transparency);
 *  'action' = it took one of the bounded actions below; 'skip' = a trigger fired and the (possibly
 *  agent-judged) verdict was "nothing warrants acting"; 'error' = the pass itself failed to complete. */
export type SupervisorEventKind = "check" | "action" | "skip" | "error";

/** The bounded, reversible action set a supervisor pass may take. 'comment' appends context as a normal
 *  finding; 'inject_correction' posts a `critical`-severity finding (interrupts a live run via the
 *  existing finding-routing path); 'trigger_recovery' calls the same `resumeThread` the manual Resume
 *  button uses; 'alert' surfaces a concise question/notice for the owner; 'cleanup' is a settle-time audit
 *  record with no tree/state mutation. Never a destructive action (no cancel/retry/delete). */
export type SupervisorAction = "comment" | "inject_correction" | "trigger_recovery" | "start_auto_review" | "alert" | "cleanup";

/** One durable row of the supervisor's own audit trail — a check, a skip, or a bounded action — so the
 *  console can show not just its current state but WHY it acted or didn't. Cascades with its thread like
 *  findings/agent_runs (task-scoped observability, not a ledger meant to outlive a purge); `threadId` is
 *  null only for a pass with no single task to point at. Mirrored in web/src/types.ts. */
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
  usedAgent: boolean; // whether the cheap bounded check-in ran (vs. a deterministic-only pass)
  costUsd?: number | null;
  totalTokens?: number | null;
  model?: string | null;
  notifiedDiscord: boolean;
  createdAt: number;
}

/** Lifecycle of one explicit owner -> supervisor conversation turn. `pending` is written before the
 * model call, so the UI and the durable record agree even when the provider is slow. A restart turns
 * an orphaned pending row into `failed` rather than risking a duplicate task action. */
export type SupervisorChatStatus = "pending" | "succeeded" | "failed" | "needs_input";

/** Existing-task operations the conversational supervisor may request. This is intentionally not a
 * dispatch surface: task creation stays in Director, and there is no cancel/retry/delete/mark-done
 * action in this vocabulary. */
export type SupervisorChatAction = "status" | "comment" | "steer" | "pause" | "resume" | "start_auto_review" | "escalate";

/** Snapshot of an explicitly selected target at send time. An empty list is retained for a board-wide
 * request; its server-resolved recipients and outcomes are recorded in actionResults. No FK is used by
 * the chat table, so the conversation remains readable after an old task is purged. */
export interface SupervisorChatTarget {
  threadId: string;
  title: string;
  state: ThreadState | null;
}

/** What the server actually did after validating the model's proposed action against fresh task
 * state. These rows, rather than the model's prose, are the authority for success/failure in the UI. */
export interface SupervisorChatActionResult {
  threadId: string;
  threadTitle: string;
  action: SupervisorChatAction;
  ok: boolean;
  message: string;
  state?: ThreadState | null;
}

/** One durable conversation turn: the owner's message plus the supervisor reply and execution audit.
 * Stored as one row so pending -> terminal is atomic and cannot leave an unmatched assistant bubble. */
export interface SupervisorChatTurn {
  id: string;
  content: string;
  targets: SupervisorChatTarget[];
  status: SupervisorChatStatus;
  response?: string | null;
  actionResults: SupervisorChatActionResult[];
  usedAgent: boolean;
  costUsd?: number | null;
  totalTokens?: number | null;
  model?: string | null;
  provider?: ImplementorProvider | null;
  createdAt: number;
  updatedAt: number;
}

/** The supervisor's live, whole-state snapshot broadcast to the console — small and bounded, like notes/
 *  schedules. `events` is the most recent slice (newest first), not the full audit trail. Mirrored in
 *  web/src/types.ts. */
export interface SupervisorSnapshot {
  enabled: boolean;
  running: boolean; // a pass is in flight right now (the "single active pass" guardrail, made visible)
  /** The latest operator-requested full pass. It reports progress separately from per-task audit rows
   * while still respecting the daily agent-check-in budget and cooldown guardrails. */
  manualSweep?: {
    state: "running" | "complete" | "stopped";
    startedAt: number;
    completedAt?: number | null;
    candidateCount: number;
    examinedCount: number;
    budgetLimitedCount: number;
    capacityLimitedCount: number;
    errorCount: number;
  } | null;
  watching: number; // tasks currently flagged with an owner-facing action, not yet settled
  lastCheckAt?: number | null;
  budget: {
    date: string; // YYYY-MM-DD, server-local — the check-in/cost/token window
    checkinsToday: number; // bounded agent check-ins actually run today
    costUsdToday: number;
    tokensToday: number;
    maxCheckinsPerDay: number;
    maxCostUsdPerDay: number;
    maxTokensPerDay: number;
  };
  /** Recent explicit owner conversation, oldest first. The full audit remains in SQLite. */
  chat: SupervisorChatTurn[];
  events: SupervisorEvent[];
}
