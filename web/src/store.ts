import { create } from "zustand";
import { apiUrl, wsUrl } from "./lib/base.js";
import type {
  AccountDTO,
  BoardView,
  CodexUsageDTO,
  GrokUsageDTO,
  ZaiUsageDTO,
  AgentRun,
  ChatMessage,
  ChatRoomSummary,
  ClientCommand,
  CoworkMessage,
  CoworkSession,
  CoworkSteeringMode,
  CoworkTurn,
  DirectorItem,
  Effort,
  DirectorMessage,
  DirectorStatus,
  FeedItem,
  FileAttachment,
  Finding,
  GitSummary,
  GitStatus,
  GitFileDiff,
  ImageAttachment,
  ImplementationMemo,
  RepoActionResult,
  RepoCommitDetail,
  RepoOp,
  RepoRef,
  RepoState,
  Message,
  MessageCursor,
  ModelStat,
  OnlineOfficeDTO,
  OperatorNote,
  OrchestratorSettings,
  Question,
  Role,
  ScheduledTask,
  ServerEvent,
  SettingsPatch,
  SupervisorSnapshot,
  TaskSearchHit,
  Thread,
} from "./types.js";
import { agentKey, GENERAL_ROOM, THREAD_HISTORY_PAGE_SIZE } from "./types.js";
import { notify } from "./lib/notify.js";
import { applyTheme, DEFAULT_THEME, isThemeId, type ThemeId } from "./lib/theme.js";
import { mergeImplementationMemos } from "./implementationMemos.js";

interface ThreadDraft {
  runId: string;
  role: Role;
  text: string;
}

export type OutboundDeliveryStatus = "sending" | "failed";

interface OutboundBase {
  id: string;
  content: string;
  createdAt: number;
  status: OutboundDeliveryStatus;
  error?: string;
}

/** Client-held owner messages. They render immediately, then disappear only when the matching
 * persisted server row (same id) comes back. Task injects use the persisted feed echo/action receipt. */
export type OutboundMessage =
  | (OutboundBase & { surface: "director" })
  | (OutboundBase & { surface: "office"; room: string })
  | (OutboundBase & { surface: "supervisor"; targetIds: string[] })
  | (OutboundBase & { surface: "cowork"; sessionId: string; mode?: "turn" | CoworkSteeringMode; attachments?: FileAttachment[] })
  | (OutboundBase & { surface: "task"; threadId: string; mode: "append" | "interrupt" | "queue" });

/** Cache key for a Git-console diff. A file's working-tree diff and the same file inside a commit are
 *  different content, so the commit id (when there is one) is part of the key. */
export function repoDiffKey(file: string, commit: string | null | undefined): string {
  return commit ? `${commit}:${file}` : file;
}

interface State {
  connected: boolean;
  // A newer web bundle is live on the server (version.ts spotted a hash change). Drives the quiet
  // top-bar "refresh for the new build" badge; an idle tab still auto-reloads, so this mainly persists
  // for an operator who's mid-typing and shouldn't be yanked out from under.
  updateReady: boolean;
  // New upstream commits are available on the tracked git branch (update.ts poll). When `available`,
  // the same top-bar badge offers to pull+rebuild+reload — always on a click, never automatically.
  gitUpdate: GitUpdate | null;
  // A badge-triggered git update is running (pull + rebuild, possibly a server restart). The badge
  // shows a spinner and is disabled while true.
  updateApplying: boolean;
  // Last git-update failure message (pull rejected, build failed), surfaced on the badge; null when none.
  updateError: string | null;
  authed: boolean;
  authRequired: boolean;
  authGoogle: boolean;
  authPassword: boolean;
  authError: string | null;
  accounts: AccountDTO[];
  codexUsage: CodexUsageDTO | null;
  grokUsage: GrokUsageDTO | null;
  zaiUsage: ZaiUsageDTO | null;
  threads: Record<string, Thread>;
  runs: Record<string, AgentRun>;
  findings: Finding[];
  questions: Question[];
  director: DirectorItem[];
  directorDraft: string;
  directorBusy: boolean;
  directorStatus: DirectorStatus | null;
  // Owner messages awaiting a durable server echo. Kept outside server-owned histories so a hello
  // snapshot can reconcile them by id without ever persisting client-only delivery state.
  outboundMessages: OutboundMessage[];
  // Console-wide search — the whole director conversation across every task, plus the tasks whose
  // title, brief or conversation matches (the snapshot carries only the recent director slice and no
  // task conversations, so both come from a server query; the server match is ASCII case-insensitive).
  // Null when the search box is empty/closed; `searching` gates the spinner between request and reply.
  directorSearch: { query: string; results: DirectorMessage[]; tasks: TaskSearchHit[]; searching: boolean } | null;
  threadFeeds: Record<string, FeedItem[]>;
  // Task history is fetched newest-first in bounded pages. The cursor tracks the oldest durable message
  // already merged for each task; live feed entries never move it backward.
  threadHistoryCursors: Record<string, MessageCursor>;
  threadHistoryHasMore: Record<string, boolean>;
  threadHistoryLoading: Record<string, boolean>;
  // How many EXTRA older pages the owner has loaded for a task. Raises that task's feed retention caps
  // so the fetched page survives the merge instead of being trimmed straight back off.
  threadHistoryPages: Record<string, number>;
  threadDrafts: Record<string, ThreadDraft | undefined>;
  // Live reasoning stream (agent.thinking deltas) awaiting its durable agent.reasoning commit — kept
  // separate from threadDrafts (the response-text draft) so reasoning and answer stream independently.
  thinkingDrafts: Record<string, ThreadDraft | undefined>;
  selectedThreadId: string | null;
  coworkSessions: Record<string, CoworkSession>;
  coworkMessages: Record<string, CoworkMessage[]>;
  coworkTurns: Record<string, CoworkTurn[]>;
  selectedCoworkId: string | null;
  coworkCreating: boolean;
  coworkActionError: string | null;
  implementationMemos: Record<string, ImplementationMemo[]>;
  approvalMode: boolean;
  // Server-authoritative pipeline settings (broadcast over WS); the panel edits these via setSettings.
  settings: OrchestratorSettings;
  // Latest Codex "Test connection" verdict (null until a test runs). Cleared while a test is in flight.
  codexTest: { ok: boolean; message: string } | null;
  codexTesting: boolean;
  discordTest: { ok: boolean; message: string } | null;
  discordTesting: boolean;
  // Client-only view settings, persisted in localStorage under `director_settings` — they only change
  // what this browser shows, so they never round-trip to the server.
  showCompleted: boolean;
  verbosity: Verbosity;
  // The board's sort order while drag-and-drop is off (the dropdown in the board header drives this).
  taskSort: TaskSort;
  // When on, the board stops auto-sorting by recency and honors the manual drag order in `taskOrder`.
  taskDragAndDrop: boolean;
  // Which look the console wears (Settings → Appearance). "classic" is the original console and puts
  // NO attribute on <html>, so choosing it can't change a single existing rule — see lib/theme.ts.
  theme: ThemeId;
  // The manual board order (active thread ids, front-to-back). Only consulted while taskDragAndDrop is
  // on; persisted under `orch-task-order` so a reorder survives reloads. Stale/new ids are reconciled
  // against the live thread set at render time, so this list is allowed to drift out of sync.
  taskOrder: string[];
  pendingPlans: Record<string, string>;
  threadChanges: Record<string, { diff: string; log: string }>;
  // The real-git "Changes" surface, keyed by threadId. `gitSummaries` is the compact chip header (fetched
  // per visible card, refreshed on demand); `gitStatus` is the full drawer payload (loaded when a drawer
  // opens); `gitDiffs` caches each file's lazily-expanded unified diff (threadId → path → diff).
  gitSummaries: Record<string, GitSummary>;
  gitStatus: Record<string, GitStatus>;
  gitDiffs: Record<string, Record<string, GitFileDiff>>;
  // The repo-level Git console, keyed by repo root. `repoDiffs` is keyed by repo → diffKey(file, commit)
  // so a file's working-tree diff and the same file inside a commit never collide. `repoResult` is the
  // last action's outcome (the activity line); `repoBusy` is true while one is in flight, which is what
  // disables the action buttons.
  repos: RepoRef[];
  /** The repo of the task the console was opened from — what the picker opens on. */
  repoPreferred: string | null;
  /** A repo.list request is in flight. The console keeps BOTH the list and the preference from the
   *  previous time it was opened, so without this it would auto-select from stale data before this
   *  open's answer — and then keep that stale choice, since auto-selection only happens once. */
  repoListPending: boolean;
  /** The `forThread` of the request in flight. The first list costs a disk scan, so the answer to a
   *  PREVIOUS open can arrive after this one's request; a reply that doesn't echo this is discarded. */
  repoListFor: string | null;
  repoStates: Record<string, RepoState>;
  repoDiffs: Record<string, Record<string, GitFileDiff>>;
  repoCommits: Record<string, Record<string, RepoCommitDetail>>;
  repoResult: (RepoActionResult & { action: string; at: number }) | null;
  repoBusy: boolean;
  // The op the last `repoAction` sent — what a "Do it anyway" re-issues with force after the live-agent
  // gate blocked it. Kept in the store rather than the component so it survives a re-render of the panel.
  repoLastOp: RepoOp | null;
  railHidden: boolean;
  detailWidth: number;
  directorWidth: number;
  // The office: recent chat across all rooms (live feed), the project-room roll-up (drives the
  // per-task Chatroom button), and full per-room history fetched on demand for the expanded view.
  chat: ChatMessage[];
  chatRooms: ChatRoomSummary[];
  roomHistory: Record<string, ChatMessage[]>;
  // Per-room lazy-load state for the expanded chatroom: whether still-older messages exist to fetch as
  // the user scrolls up, and whether a page request is currently in flight (so a burst of scroll events
  // doesn't fire duplicate fetches). Absent room => not yet loaded / unknown.
  roomHasMore: Record<string, boolean>;
  roomLoading: Record<string, boolean>;
  // Assigned/picked office names keyed by agentKey(thread, role) — each role is a distinct agent; the
  // default for an unlisted agent is gnomeName(thread, role). Resolve via agentName().
  nameOverrides: Record<string, string>;
  // Office panel UI: which room is open (room key) — null = closed. The strip, the task buttons, and
  // the card chips all drive this so one panel serves every entry point.
  officeRoom: string | null;
  // The latest server-pushed user notice (token-safety auto-stop / token-reset auto-resume), shown as a
  // dismissible banner. Null when none/dismissed; only the most recent is held (a new one replaces an open
  // banner). `level` drives the banner's tone (warn = amber alert, info = neutral).
  notice: { level: "info" | "warn"; title: string; message: string } | null;
  // Recurring/scheduled tasks (server-authoritative, broadcast over WS). Managed from the Scheduled Tasks
  // view; `boardView` toggles the center pane between the live task board and that view.
  schedules: ScheduledTask[];
  // The owner's note list (server-authoritative): short pointers agents leave for them — a branch to
  // review, a PR to merge — shown in the Notes board view, cleared by the owner one note at a time.
  notes: OperatorNote[];
  // Director Supervisor: the watchdog's live state (enabled, in-flight-pass flag, budget, recent audit
  // trail) — server-authoritative, shown in the Supervisor board view. Neutral/off until hello lands.
  supervisor: SupervisorSnapshot;
  // The Online Office: this machine's link to a shared relay, and the agents other machines have working
  // right now. Server-authoritative — never mirrored locally on write; the `office.online` broadcast is
  // the only writer. Neutral (off, nobody remote) until the socket's hello lands.
  onlineOffice: OnlineOfficeDTO;
  // A join attempt is in flight / why the last one was refused. Kept here rather than in the panel:
  // the answer arrives as its own `office.join.result` frame, because two attempts with the same wrong
  // code produce an identical office DTO and a panel watching only that could never un-busy.
  officeJoining: boolean;
  officeJoinError: string | null;
  boardView: BoardView;
  // Auto model selection's scoreboard: per-model averages over every graded auto-picked task. Rendered
  // read-only in Settings so the selection loop's learning is visible, and rebroadcast on each grading.
  modelStats: ModelStat[];

  select: (id: string | null) => void;
  // Fetch the next older page of the selected task's durable feed. A no-op while a page is in flight or
  // once the server has said there is no earlier history.
  loadOlderThreadHistory: (threadId: string) => boolean;
  selectCowork: (id: string | null) => void;
  createCowork: (input: { name?: string; workspace: string; provider?: CoworkSession["requestedProvider"]; model?: string | null }) => boolean;
  sendCowork: (sessionId: string, text: string, mode?: "turn" | CoworkSteeringMode, attachments?: FileAttachment[]) => boolean;
  stopCowork: (sessionId: string) => void;
  renameCowork: (sessionId: string, name: string) => void;
  deleteCowork: (sessionId: string) => void;
  clearCoworkError: () => void;
  // Search the whole director conversation and every task (title, brief, conversation), or clear it.
  searchDirector: (query: string) => void;
  clearDirectorSearch: () => void;
  sendPrompt: (text: string, workspace?: string, images?: ImageAttachment[]) => boolean;
  sendDirect: (text: string, workspace?: string, images?: ImageAttachment[]) => boolean;
  // Stop the director when it's busy but spinning (looping without replying or dispatching).
  cancelDirector: () => void;
  answer: (questionId: string, answer: string) => void;
  inject: (
    threadId: string,
    message: string,
    mode: "append" | "interrupt" | "queue",
    images?: ImageAttachment[],
    recipient?: "implementor" | "qa" | "reviewer",
  ) => Promise<boolean>;
  interrupt: (threadId: string) => void;
  resume: (threadId: string, message?: string) => void;
  setDeadline: (threadId: string, deadlineAt: number | null) => Promise<boolean>;
  cancel: (threadId: string) => void;
  retry: (threadId: string) => void;
  rename: (threadId: string, title: string) => void;
  markDone: (threadId: string) => void;
  autoReview: (threadId: string) => void;
  close: (threadId: string) => void;
  restore: (threadId: string) => void;
  dismiss: (threadId: string) => void;
  setApproval: (on: boolean) => void;
  setSettings: (patch: SettingsPatch) => void;
  testCodex: (apiKey?: string) => void;
  testDiscord: () => void;
  setAccountEnabled: (id: string, enabled: boolean) => void;
  setAccountWeeklySafety: (id: string, weeklySafetyPct: number) => void;
  setShowCompleted: (v: boolean) => void;
  setVerbosity: (v: Verbosity) => void;
  setTaskSort: (v: TaskSort) => void;
  setTaskDragAndDrop: (v: boolean) => void;
  setTheme: (v: ThemeId) => void;
  setTaskOrder: (ids: string[]) => void;
  approve: (threadId: string, approved: boolean, feedback?: string) => void;
  loadChanges: (threadId: string) => void;
  loadGitSummary: (threadId: string) => void;
  loadGitStatus: (threadId: string) => void;
  loadGitDiff: (threadId: string, path: string) => void;
  // The Git console. `repoAction` marks the console busy until the server's repo.result lands, so the
  // buttons can't be double-fired against a repo mid-checkout.
  loadRepos: (rescan?: boolean, forThread?: string | null) => void;
  loadRepoState: (path: string) => void;
  loadRepoDiff: (path: string, file: string, commit?: string) => void;
  loadRepoCommit: (path: string, hash: string) => void;
  repoAction: (path: string, op: RepoOp, force?: boolean) => void;
  clearRepoResult: () => void;
  toggleRail: () => void;
  setDetailWidth: (px: number) => void;
  setDirectorWidth: (px: number) => void;
  // Open the office panel on a room (defaults to the general room); fetches that room's newest page.
  openOffice: (room?: string) => void;
  // Fetch the next-older page of a room's history (called as the user scrolls toward the top). No-op if a
  // page is already loading or the room has no older messages left.
  loadMoreRoom: (room: string) => void;
  closeOffice: () => void;
  // Post into a room as the director (the human) — reaches the live agents there so they self-coordinate.
  postChat: (room: string, body: string) => boolean;
  // Dismiss the current notice banner.
  clearNotice: () => void;
  // Scheduled tasks: switch the center pane, and CRUD the recurring dispatches (server is authoritative —
  // each mutation is optimism-free and reconciled by the `schedules` broadcast).
  setBoardView: (v: BoardView) => void;
  createSchedule: (input: { title: string; workspace: string; prompt: string; cron: string; enabled?: boolean; effort?: Effort | null }) => void;
  updateSchedule: (id: string, patch: { title?: string; workspace?: string; prompt?: string; cron?: string; enabled?: boolean; effort?: Effort | null }) => void;
  deleteSchedule: (id: string) => void;
  runSchedule: (id: string) => void;
  // The owner's note list — same optimism-free contract: send, let the `notes` broadcast reconcile.
  addNote: (body: string, url?: string) => void;
  deleteNote: (id: string) => void;
  clearNotes: () => void;
  sendSupervisorMessage: (content: string, targetIds: string[]) => boolean;
  runSupervisorNow: () => void;
  // The Online Office's three operator actions. Same optimism-free contract as everything else
  // server-authoritative: send, and let the `office.online` broadcast reconcile.
  joinOnlineOffice: (input: { url: string; code: string; instanceName: string }) => void;
  leaveOnlineOffice: () => void;
  setOnlineOffice: (patch: { enabled?: boolean; instanceName?: string }) => void;
  // Flag that a fresh web build is available (set by version.ts when the served bundle hash changes).
  setUpdateReady: (v: boolean) => void;
  // Record the latest git-update poll result (set by update.ts).
  setGitUpdate: (v: GitUpdate) => void;
  // Pull + rebuild the checkout and reload onto the new build. Triggered by a badge click only.
  applyGitUpdate: () => Promise<void>;
}

// What the git-update poll reports to the badge: whether the checkout is behind its upstream and by
// how much, plus a little context for the tooltip.
export interface GitUpdate {
  available: boolean;
  behind: number;
  branch: string | null;
  remoteSubject: string | null;
}

const lsBool = (k: string, d: boolean): boolean => {
  try {
    const v = localStorage.getItem(k);
    return v == null ? d : v === "1";
  } catch {
    return d;
  }
};
const lsNum = (k: string, d: number): number => {
  try {
    const v = localStorage.getItem(k);
    const n = v == null ? d : Number(v);
    return Number.isFinite(n) ? n : d;
  } catch {
    return d;
  }
};
const lsSet = (k: string, v: string): void => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* private mode */
  }
};

export type Verbosity = "compact" | "full";

// How the board orders tasks when drag-and-drop is off. "created_desc" (newest first) is the default;
// the rest mirror the sort dropdown's options. Persisted in ViewSettings so the choice survives reloads.
export type TaskSort = "created_desc" | "created_asc" | "updated" | "status" | "workspace" | "title";
const TASK_SORTS: readonly TaskSort[] = ["created_desc", "created_asc", "updated", "status", "workspace", "title"];
const isTaskSort = (v: unknown): v is TaskSort => typeof v === "string" && (TASK_SORTS as readonly string[]).includes(v);

// Client-only view settings live together under one stable localStorage key (per the brief), separate
// from the server-authoritative pipeline settings. Defaults: keep finished tasks visible, full output.
const VIEW_SETTINGS_KEY = "director_settings";
interface ViewSettings {
  showCompleted: boolean;
  verbosity: Verbosity;
  // Off by default: the board keeps its automatic most-recent-first ordering until the owner opts in.
  taskDragAndDrop: boolean;
  // Which comparator the board sorts by. Fully authoritative when drag-and-drop is off; when it's on, its
  // primary key still groups the board live while manual drag orders cards within an equal-rank group.
  taskSort: TaskSort;
  // The console's look. Read at boot by the inline script in index.html too, which paints the theme
  // before the bundle runs — keep the stored key and shape in step with it.
  theme: ThemeId;
}
const VIEW_DEFAULTS: ViewSettings = { showCompleted: true, verbosity: "full", taskDragAndDrop: false, taskSort: "created_desc", theme: DEFAULT_THEME };
const loadViewSettings = (): ViewSettings => {
  try {
    const raw = localStorage.getItem(VIEW_SETTINGS_KEY);
    if (!raw) return VIEW_DEFAULTS;
    const v = JSON.parse(raw) as Partial<ViewSettings>;
    return {
      showCompleted: typeof v.showCompleted === "boolean" ? v.showCompleted : VIEW_DEFAULTS.showCompleted,
      verbosity: v.verbosity === "compact" || v.verbosity === "full" ? v.verbosity : VIEW_DEFAULTS.verbosity,
      taskDragAndDrop: typeof v.taskDragAndDrop === "boolean" ? v.taskDragAndDrop : VIEW_DEFAULTS.taskDragAndDrop,
      taskSort: isTaskSort(v.taskSort) ? v.taskSort : VIEW_DEFAULTS.taskSort,
      theme: isThemeId(v.theme) ? v.theme : VIEW_DEFAULTS.theme,
    };
  } catch {
    return VIEW_DEFAULTS;
  }
};
const saveViewSettings = (v: ViewSettings): void => lsSet(VIEW_SETTINGS_KEY, JSON.stringify(v));
/** Every view setting shares one localStorage record, so each setter has to write the OTHER four back
 *  untouched. Spelling them out per setter is what loses a field the moment a fifth one is added, so
 *  the patch is merged against live state here instead. */
const persistView = (s: ViewSettings, patch: Partial<ViewSettings>): void =>
  saveViewSettings({ showCompleted: s.showCompleted, verbosity: s.verbosity, taskSort: s.taskSort, taskDragAndDrop: s.taskDragAndDrop, theme: s.theme, ...patch });

// The manual board order persists on its own key (it's a list, not a flag, and churns far more often
// than the view toggles). A bad/old payload degrades to "no manual order" — the board then renders by
// recency until the next drag rewrites it.
const TASK_ORDER_KEY = "orch-task-order";
const loadTaskOrder = (): string[] => {
  try {
    const raw = localStorage.getItem(TASK_ORDER_KEY);
    if (!raw) return [];
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};
const saveTaskOrder = (ids: string[]): void => lsSet(TASK_ORDER_KEY, JSON.stringify(ids));

// Until the first `hello` arrives the panel shows these neutral defaults (everything on); the server's
// real values overwrite them the instant the socket connects.
/** What the Online Office looks like before the socket's hello lands, and whenever it is switched off.
 *  Must read as "not joined, nobody remote" — the panel's Join form is what should show on a fresh
 *  console, not a half-populated connected state. */
const IDLE_SUPERVISOR: SupervisorSnapshot = {
  enabled: false,
  running: false,
  manualSweep: null,
  watching: 0,
  lastCheckAt: null,
  budget: { date: "", checkinsToday: 0, costUsdToday: 0, tokensToday: 0, maxCheckinsPerDay: 0, maxCostUsdPerDay: 0, maxTokensPerDay: 0 },
  chat: [],
  events: [],
};

const OFFLINE_OFFICE: OnlineOfficeDTO = {
  enabled: false,
  url: "",
  instanceName: "",
  joined: false,
  state: "off",
  error: null,
  connectedAt: null,
  remoteAgents: [],
  directors: [],
  sharedRepos: [],
};

const DEFAULT_SETTINGS: OrchestratorSettings = {
  conciseAgentCommunication: true,
  plannerEnabled: true,
  researcherEnabled: true,
  qaEnabled: true,
  differentProviderQa: false,
  qaAppliesFixes: false,
  autoPush: true,
  directorName: "ChangeNameInSettings",
  maxQaRounds: 4,
  maxReviewFixRounds: 1,
  maxConcurrent: 3,
  maxConcurrentPerRepo: 0,
  selfImproveEnabled: false,
  autoModelSelection: false,
  tokenLimitEnabled: false,
  tokenLimitPercent: 80,
  autoResumeOnTokenReset: false,
  autoResumeThresholdPercent: 80,
  fastUsagePolling: false,
  spreadUsage: false,
  codexEnabled: false,
  codexModel: "gpt-5.6-sol",
  codexEffort: "ultra",
  codexWeeklySafetyPct: 100,
  hasOpenaiKey: false,
  openaiKeyLast4: null,
  codexChatgptLogin: false,
  grokEnabled: false,
  grokModel: "grok-4.6",
  grokEffort: "xhigh",
  grokWeeklySafetyPct: 100,
  grokSignedIn: false,
  grokAccount: null,
  zaiEnabled: false,
  zaiModel: "glm-4.7",
  zaiEffort: "high",
  zaiWeeklySafetyPct: 100,
  zaiKeyPresent: false,
  zaiKeyLast4: null,
  zaiModels: [],
  discordNotify: false,
  discordChannelId: "",
  discordTokenPresent: false,
  discordTokenLast4: null,
  skipDirector: false,
  showComposerPickers: false,
  showAgentModel: true,
  skipDirectorEffort: "auto",
  taskDurationMinutes: 0,
  taskAgentCount: 1,
  xhighEnabled: false,
  skipDirectorRetitle: true,
  maxRecentRepos: 5,
  recentRepos: [],
  modelOverrides: {},
  accountEffortCaps: {},
  modelDefaults: {},
  claudeModels: [],
  codexModels: [],
  codexModelEfforts: {},
  grokModels: [],
  directorSupervisorEnabled: false,
};

// A server that predates the settings broadcast (or any partial payload) must never null out the
// settings object — every key stays defined so the toggles/panel can read it without guarding.
const mergeSettings = (incoming: Partial<OrchestratorSettings> | undefined): OrchestratorSettings => ({
  ...DEFAULT_SETTINGS,
  ...(incoming ?? {}),
});

// Cap each agent RUN's feed items INDEPENDENTLY (not one global cap) so a chatty
// implementor/QA run can't evict the finished planner/researcher output you want to
// scroll back and read. A bounded run (planner ~tens of items) is never trimmed.
// FEED_HARD_CAP is an absolute per-thread backstop for pathological many-run threads.
const PER_RUN_CAP = 800;
const FEED_HARD_CAP = 5000;

let socket: WebSocket | null = null;
const pendingThreadActions: Array<{
  threadId: string;
  action: string;
  clientId?: string;
  timer: ReturnType<typeof setTimeout>;
  resolve: (ok: boolean) => void;
}> = [];

// A browser may report its socket as OPEN after an intermediary has already dropped the
// connection. The watchdog intentionally needs time to prove that condition and reconnect, so
// don't label a write undelivered before its idempotent receipt has had a chance to replay.
const OUTBOUND_CONFIRM_MS = 60_000;
const outboundTimers = new Map<string, ReturnType<typeof setTimeout>>();
// Keep the exact wire command beside its optimistic bubble. Every command stored here has a
// clientId, so replaying it after a reconnect is safe: the server returns the original receipt
// instead of performing the owner action twice.
const outboundCommands = new Map<string, ClientCommand>();
const OUTBOUND_OUTBOX_KEY = "orch-outbound-outbox-v1";

type PersistedOutbound = {
  message: OutboundMessage;
  command: ClientCommand;
};

// Only persist text-only owner commands. This covers Director, Supervisor, and Office messages —
// the writes an operator most needs to survive a reload — while deliberately not putting dropped
// image/file attachment bytes into localStorage.
function canPersistOutbound(message: OutboundMessage, command: ClientCommand): boolean {
  if (message.surface === "supervisor" || message.surface === "office") return true;
  return message.surface === "director" &&
    (command.type === "prompt.new" || command.type === "prompt.direct") &&
    !command.images?.length;
}

function storedOutbound(): PersistedOutbound[] {
  try {
    const raw = localStorage.getItem(OUTBOUND_OUTBOX_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is PersistedOutbound => {
      if (!entry || typeof entry !== "object") return false;
      const { message, command } = entry as Partial<PersistedOutbound>;
      return !!message && !!command && typeof message.id === "string" && message.status === "sending" &&
        typeof command === "object" && "clientId" in command && command.clientId === message.id;
    });
  } catch {
    return [];
  }
}

function persistOutbound(message: OutboundMessage, command: ClientCommand): void {
  if (!canPersistOutbound(message, command)) return;
  try {
    const entries = storedOutbound().filter((entry) => entry.message.id !== message.id);
    entries.push({ message, command });
    localStorage.setItem(OUTBOUND_OUTBOX_KEY, JSON.stringify(entries));
  } catch {
    // Storage is an extra durability layer; the in-memory outbox still retries in private mode.
  }
}

function forgetPersistedOutbound(id: string): void {
  try {
    const entries = storedOutbound().filter((entry) => entry.message.id !== id);
    if (entries.length) localStorage.setItem(OUTBOUND_OUTBOX_KEY, JSON.stringify(entries));
    else localStorage.removeItem(OUTBOUND_OUTBOX_KEY);
  } catch {
    /* private mode or a full storage quota */
  }
}

function restorePersistedOutbound(): OutboundMessage[] {
  const restored = storedOutbound();
  for (const { message, command } of restored) outboundCommands.set(message.id, command);
  return restored.map(({ message }) => message);
}

function newOutboundId(): string {
  // randomUUID is secure-context-only in several mobile browsers, while the console deliberately
  // supports authenticated LAN HTTP. getRandomValues is available there; retain a last-resort fill so
  // a legacy WebView still produces a syntactically valid correlation id instead of dropping Send.
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function clearOutboundTimer(id: string): void {
  const timer = outboundTimers.get(id);
  if (timer) clearTimeout(timer);
  outboundTimers.delete(id);
}

function scheduleOutboundConfirmation(id: string): void {
  clearOutboundTimer(id);
  outboundTimers.set(
    id,
    setTimeout(() => {
      failOutbound(id, "No server receipt arrived after reconnecting. The message was not delivered; resend it when the console is online.");
    }, OUTBOUND_CONFIRM_MS),
  );
}

function addOutbound(message: OutboundMessage): void {
  useStore.setState((s) => ({ outboundMessages: [...s.outboundMessages, message] }));
}

function failOutbound(id: string, error: string): void {
  clearOutboundTimer(id);
  outboundCommands.delete(id);
  forgetPersistedOutbound(id);
  useStore.setState((s) => ({
    outboundMessages: s.outboundMessages.map((message) =>
      message.id === id ? { ...message, status: "failed", error } : message,
    ),
  }));
}

function acknowledgeOutbound(ids: Iterable<string>): Set<string> {
  const received = new Set(ids);
  for (const id of received) {
    clearOutboundTimer(id);
    outboundCommands.delete(id);
    forgetPersistedOutbound(id);
  }
  return received;
}

function sendOutbound(message: OutboundMessage, command: ClientCommand): boolean {
  addOutbound(message);
  outboundCommands.set(message.id, command);
  persistOutbound(message, command);
  const sent = sendCommand(command);
  // A closed/half-closed socket means the browser has no way to know whether a write reached the
  // server. Keep the idempotent command queued and let onopen replay it; marking it failed here was
  // the actual message-loss path behind the red "Not delivered" bubble.
  if (sent) scheduleOutboundConfirmation(message.id);
  else if (!socket || socket.readyState === WebSocket.CLOSED) connect();
  return true;
}

function replaySendingOutbound(): void {
  for (const message of useStore.getState().outboundMessages) {
    if (message.status !== "sending") continue;
    const command = outboundCommands.get(message.id);
    if (!command) {
      failOutbound(message.id, "The console lost this unconfirmed message before it could be replayed. Resend it when the console is online.");
      continue;
    }
    if (sendCommand(command)) scheduleOutboundConfirmation(message.id);
  }
}

function failSendingOutbound(error: string): void {
  const pending = useStore.getState().outboundMessages.filter((message) => message.status === "sending");
  for (const message of pending) failOutbound(message.id, error);
}

// Keep the proxied WS tunnel alive and self-heal missed events. A reverse proxy
// (Nginx proxy_read_timeout 60s) silently half-closes an idle WS during the
// cancel->inject pause; the browser never fires onclose, so the new implementor
// run's run.upsert is lost and its timer stays frozen at 0. HEARTBEAT_MS keeps
// bidirectional traffic flowing (snapshot.request -> hello, which re-syncs runs
// with authoritative startedAt); the watchdog force-closes a dead-but-not-closed
// socket once no server message has arrived for STALE_MS, triggering reconnect.
const HEARTBEAT_MS = 20_000;
const WATCHDOG_MS = 10_000;
const STALE_MS = 35_000;
let lastRecvAt = 0;
let heartbeat: ReturnType<typeof setInterval> | null = null;
let watchdog: ReturnType<typeof setInterval> | null = null;

function clearTimers(): void {
  if (heartbeat) clearInterval(heartbeat);
  if (watchdog) clearInterval(watchdog);
  heartbeat = null;
  watchdog = null;
}

/** Returns whether the command actually went out — callers with optimistic in-flight state (e.g. the
 *  chatroom's per-room loading flag) roll back when the socket was closed and the send was dropped. */
function sendCommand(cmd: ClientCommand): boolean {
  if (socket && socket.readyState === WebSocket.OPEN) {
    try {
      socket.send(JSON.stringify(cmd));
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function sendThreadActionCommand(cmd: ClientCommand, action: string, threadId: string): Promise<boolean> {
  if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.resolve(false);
  return new Promise((resolve) => {
    const pending = {
      threadId,
      action,
      clientId: "clientId" in cmd ? cmd.clientId : undefined,
      resolve,
      timer: setTimeout(() => {
        const i = pendingThreadActions.indexOf(pending);
        if (i >= 0) pendingThreadActions.splice(i, 1);
        resolve(false);
      }, 30_000),
    };
    pendingThreadActions.push(pending);
    try {
      socket!.send(JSON.stringify(cmd));
    } catch {
      const i = pendingThreadActions.indexOf(pending);
      if (i >= 0) pendingThreadActions.splice(i, 1);
      clearTimeout(pending.timer);
      resolve(false);
    }
  });
}

function resolvePendingThreadAction(threadId: string, action: string, ok: boolean, clientId?: string): void {
  const index = pendingThreadActions.findIndex(
    (pending) =>
      pending.threadId === threadId &&
      pending.action === action &&
      (clientId === undefined || pending.clientId === clientId),
  );
  if (index < 0) return;
  const [pending] = pendingThreadActions.splice(index, 1);
  if (!pending) return;
  clearTimeout(pending.timer);
  pending.resolve(ok);
}

function failPendingThreadActions(): void {
  for (const pending of pendingThreadActions.splice(0)) {
    clearTimeout(pending.timer);
    pending.resolve(false);
  }
}

export const useStore = create<State>((set) => ({
  connected: false,
  updateReady: false,
  gitUpdate: null,
  updateApplying: false,
  updateError: null,
  authed: false,
  authRequired: false,
  authGoogle: false,
  authPassword: false,
  authError: null,
  accounts: [],
  codexUsage: null,
  grokUsage: null,
  zaiUsage: null,
  threads: {},
  runs: {},
  findings: [],
  questions: [],
  director: [],
  directorDraft: "",
  directorBusy: false,
  directorStatus: null,
  // Text-only owner messages survive a reload until their durable server receipt arrives. Their
  // idempotent commands were restored into outboundCommands before this state is created.
  outboundMessages: restorePersistedOutbound(),
  directorSearch: null,
  threadFeeds: {},
  threadHistoryCursors: {},
  threadHistoryHasMore: {},
  threadHistoryLoading: {},
  threadHistoryPages: {},
  threadDrafts: {},
  thinkingDrafts: {},
  selectedThreadId: null,
  coworkSessions: {},
  coworkMessages: {},
  coworkTurns: {},
  selectedCoworkId: null,
  coworkCreating: false,
  coworkActionError: null,
  implementationMemos: {},
  approvalMode: false,
  settings: DEFAULT_SETTINGS,
  codexTest: null,
  codexTesting: false,
  discordTest: null,
  discordTesting: false,
  showCompleted: loadViewSettings().showCompleted,
  verbosity: loadViewSettings().verbosity,
  taskSort: loadViewSettings().taskSort,
  taskDragAndDrop: loadViewSettings().taskDragAndDrop,
  theme: loadViewSettings().theme,
  taskOrder: loadTaskOrder(),
  pendingPlans: {},
  threadChanges: {},
  gitSummaries: {},
  gitStatus: {},
  gitDiffs: {},
  repos: [],
  repoPreferred: null,
  repoListPending: false,
  repoListFor: null,
  repoStates: {},
  repoDiffs: {},
  repoCommits: {},
  repoResult: null,
  repoBusy: false,
  repoLastOp: null,
  railHidden: lsBool("orch-rail-hidden", false),
  detailWidth: lsNum("orch-detail-w", 480),
  directorWidth: lsNum("orch-rail-w", 384),
  chat: [],
  chatRooms: [],
  roomHistory: {},
  roomHasMore: {},
  roomLoading: {},
  nameOverrides: {},
  officeRoom: null,
  notice: null,
  schedules: [],
  notes: [],
  supervisor: IDLE_SUPERVISOR,
  onlineOffice: OFFLINE_OFFICE,
  officeJoining: false,
  officeJoinError: null,
  modelStats: [],
  boardView: "tasks",

  select: (id) => {
    const sent = id ? sendCommand({ type: "thread.history", threadId: id }) : false;
    set((s) => ({
      selectedThreadId: id,
      ...(id && sent ? { threadHistoryLoading: { ...s.threadHistoryLoading, [id]: true } } : {}),
    }));
  },
  loadOlderThreadHistory: (threadId) => {
    const s = useStore.getState();
    if (s.threadHistoryLoading[threadId] || s.threadHistoryHasMore[threadId] === false) return false;
    const before = s.threadHistoryCursors[threadId];
    // No first page yet: select()'s initial request is responsible for it.
    if (!before) return false;
    const sent = sendCommand({ type: "thread.history", threadId, before });
    if (sent) set({ threadHistoryLoading: { ...s.threadHistoryLoading, [threadId]: true } });
    return sent;
  },
  selectCowork: (id) => {
    set({ selectedCoworkId: id, coworkActionError: null });
    if (id) sendCommand({ type: "cowork.history", sessionId: id });
  },
  createCowork: ({ name, workspace, provider, model }) => {
    const path = workspace.trim();
    if (!path) return false;
    const clientId = newOutboundId();
    set({ coworkCreating: true, coworkActionError: null });
    const sent = sendCommand({
      type: "cowork.create",
      workspace: path,
      ...(name?.trim() ? { name: name.trim() } : {}),
      ...(provider && model ? { provider, model } : {}),
      clientId,
    });
    if (!sent) set({ coworkCreating: false, coworkActionError: "Not delivered — the console is reconnecting." });
    return sent;
  },
  sendCowork: (sessionId, text, mode = "turn", attachments = []) => {
    const content = text.trim() || (attachments.length === 1
      ? `Review the attached file ${JSON.stringify(attachments[0]!.name)}.`
      : attachments.length
        ? `Review the ${attachments.length} attached files.`
        : "");
    if (!content) return false;
    const clientId = newOutboundId();
    set({ coworkActionError: null });
    return sendOutbound(
      {
        id: clientId,
        surface: "cowork",
        sessionId,
        content,
        mode,
        attachments: attachments.length ? attachments : undefined,
        createdAt: Date.now(),
        status: "sending",
      },
      mode === "turn"
        ? { type: "cowork.send", sessionId, text: content, attachments: attachments.length ? attachments : undefined, clientId }
        : { type: "cowork.steer", sessionId, text: content, mode, attachments: attachments.length ? attachments : undefined, clientId },
    );
  },
  stopCowork: (sessionId) => {
    set({ coworkActionError: null });
    sendCommand({ type: "cowork.stop", sessionId });
  },
  renameCowork: (sessionId, name) => sendCommand({ type: "cowork.rename", sessionId, name: name.trim() }),
  deleteCowork: (sessionId) => sendCommand({ type: "cowork.delete", sessionId }),
  clearCoworkError: () => set({ coworkActionError: null }),
  searchDirector: (query) => {
    const q = query.trim();
    if (!q) {
      set({ directorSearch: null });
      return;
    }
    // Keep the prior results visible while a new query for the same string is in flight (no flash);
    // a changed query starts empty. The reply reconciles both via the echoed query.
    set((s) => {
      const same = s.directorSearch?.query === q ? s.directorSearch : null;
      return { directorSearch: { query: q, results: same?.results ?? [], tasks: same?.tasks ?? [], searching: true } };
    });
    sendCommand({ type: "director.search", query: q });
  },
  clearDirectorSearch: () => set({ directorSearch: null }),
  sendPrompt: (text, workspace, images) => {
    const content = text.trim();
    if (!content) return false;
    const clientId = newOutboundId();
    return sendOutbound(
      { id: clientId, surface: "director", content, createdAt: Date.now(), status: "sending" },
      { type: "prompt.new", text: content, workspace: workspace || undefined, images: images?.length ? images : undefined, clientId },
    );
  },
  sendDirect: (text, workspace, images) => {
    const content = text.trim();
    if (!content) return false;
    const clientId = newOutboundId();
    return sendOutbound(
      { id: clientId, surface: "director", content, createdAt: Date.now(), status: "sending" },
      { type: "prompt.direct", text: content, workspace: workspace || undefined, images: images?.length ? images : undefined, clientId },
    );
  },
  cancelDirector: () => sendCommand({ type: "director.cancel" }),
  answer: (questionId, answer) => sendCommand({ type: "question.answer", questionId, answer }),
  inject: (threadId, message, mode, images, recipient) => {
    const content = message.trim();
    if (!content) return Promise.resolve(false);
    const clientId = newOutboundId();
    addOutbound({ id: clientId, surface: "task", threadId, mode, content, createdAt: Date.now(), status: "sending" });
    return sendThreadActionCommand(
      { type: "thread.inject", threadId, message: content, mode, recipient, images: images?.length ? images : undefined, clientId },
      "inject",
      threadId,
    ).then((ok) => {
      if (!ok) failOutbound(clientId, "The task did not confirm this instruction. Review its state, then retry if needed.");
      return ok;
    });
  },
  interrupt: (threadId) => sendCommand({ type: "thread.interrupt", threadId }),
  resume: (threadId, message) => sendCommand({ type: "thread.resume", threadId, message }),
  setDeadline: (threadId, deadlineAt) =>
    sendThreadActionCommand({ type: "thread.deadline", threadId, deadlineAt }, "deadline", threadId),
  cancel: (threadId) => sendCommand({ type: "thread.cancel", threadId }),
  retry: (threadId) => sendCommand({ type: "thread.retry", threadId }),
  rename: (threadId, title) => sendCommand({ type: "thread.rename", threadId, title }),
  markDone: (threadId) => sendCommand({ type: "thread.markDone", threadId }),
  autoReview: (threadId) => sendCommand({ type: "thread.autoReview", threadId }),
  close: (threadId) => sendCommand({ type: "thread.close", threadId }),
  restore: (threadId) => sendCommand({ type: "thread.restore", threadId }),
  dismiss: (threadId) => sendCommand({ type: "thread.dismiss", threadId }),
  setApproval: (on) => sendCommand({ type: "approval.set", on }),
  // Optimistic: reflect the change locally at once, then send it. The server's `settings` broadcast
  // confirms (and reconciles any clamp, e.g. an out-of-range number) for every connected client.
  setSettings: (patch) => {
    // Reflect the writable view fields locally at once; the raw key is write-only and never held in
    // client state (the server confirms it via hasOpenaiKey/openaiKeyLast4 on its settings broadcast).
    const { openaiApiKey: _key, discordBotToken: _bot, ...local } = patch;
    set((s) => ({ settings: { ...s.settings, ...local } }));
    sendCommand({ type: "settings.set", settings: patch });
  },
  testCodex: (apiKey) => {
    set({ codexTesting: true, codexTest: null });
    sendCommand({ type: "codex.test", apiKey: apiKey?.trim() || undefined });
  },
  testDiscord: () => {
    set({ discordTesting: true, discordTest: null });
    sendCommand({ type: "discord.test" });
  },
  setAccountEnabled: (id, enabled) => {
    // Optimistic: flip the strip locally; the server's `accounts` broadcast confirms (and snaps back
    // a refused toggle — e.g. trying to disable the last enabled account).
    set((s) => ({ accounts: s.accounts.map((a) => (a.id === id ? { ...a, enabled } : a)) }));
    sendCommand({ type: "account.set", id, enabled });
  },
  setAccountWeeklySafety: (id, weeklySafetyPct) => {
    // Optimistic: reflect the new ceiling locally; the server's `accounts` broadcast confirms the clamped value.
    set((s) => ({ accounts: s.accounts.map((a) => (a.id === id ? { ...a, weeklySafetyPct } : a)) }));
    sendCommand({ type: "account.setSafety", id, weeklySafetyPct });
  },
  setShowCompleted: (v) =>
    set((s) => {
      persistView(s, { showCompleted: v });
      return { showCompleted: v };
    }),
  setVerbosity: (v) =>
    set((s) => {
      persistView(s, { verbosity: v });
      return { verbosity: v };
    }),
  setTaskSort: (v) =>
    set((s) => {
      persistView(s, { taskSort: v });
      return { taskSort: v };
    }),
  setTaskDragAndDrop: (v) =>
    set((s) => {
      persistView(s, { taskDragAndDrop: v });
      return { taskDragAndDrop: v };
    }),
  setTheme: (v) =>
    set((s) => {
      persistView(s, { theme: v });
      // Animated, because this one is the owner watching the console change under their own click.
      applyTheme(v, true);
      return { theme: v };
    }),
  setTaskOrder: (ids) => {
    saveTaskOrder(ids);
    set({ taskOrder: ids });
  },
  approve: (threadId, approved, feedback) => sendCommand({ type: "thread.approve", threadId, approved, feedback }),
  loadChanges: (threadId) => sendCommand({ type: "thread.changes", threadId }),
  loadGitSummary: (threadId) => sendCommand({ type: "thread.gitSummary", threadId }),
  loadGitStatus: (threadId) => sendCommand({ type: "thread.git", threadId }),
  loadGitDiff: (threadId, path) => sendCommand({ type: "thread.gitDiff", threadId, path }),
  loadRepos: (rescan = false, forThread = null) => {
    set({ repoListPending: true, repoListFor: forThread, repoPreferred: null });
    sendCommand({ type: "repo.list", rescan, ...(forThread ? { forThread } : {}) });
  },
  loadRepoState: (path) => sendCommand({ type: "repo.state", path }),
  loadRepoDiff: (path, file, commit) => sendCommand({ type: "repo.diff", path, file, ...(commit ? { commit } : {}) }),
  loadRepoCommit: (path, hash) => sendCommand({ type: "repo.commit", path, hash }),
  repoAction: (path, op, force = false) => {
    set({ repoBusy: true, repoResult: null, repoLastOp: op });
    sendCommand({ type: "repo.action", path, op, force });
  },
  clearRepoResult: () => set({ repoResult: null }),
  toggleRail: () =>
    set((s) => {
      const v = !s.railHidden;
      lsSet("orch-rail-hidden", v ? "1" : "0");
      return { railHidden: v };
    }),
  setDetailWidth: (px) => {
    lsSet("orch-detail-w", String(Math.round(px)));
    set({ detailWidth: px });
  },
  setDirectorWidth: (px) => {
    lsSet("orch-rail-w", String(Math.round(px)));
    set({ directorWidth: px });
  },
  openOffice: (room) => {
    const r = room ?? GENERAL_ROOM;
    // Fresh open pulls just the newest page; older messages load on demand as the user scrolls up. Only
    // arm the loading flag if the request actually went out — a dropped send (socket down) leaves it clear
    // so a stuck flag can't permanently disable scroll-up for the room.
    const sent = sendCommand({ type: "chat.history", room: r });
    set((s) => ({ officeRoom: r, roomLoading: { ...s.roomLoading, [r]: sent } }));
  },
  loadMoreRoom: (room) => {
    const s = useStore.getState();
    if (s.roomLoading[room] || s.roomHasMore[room] === false) return;
    const hist = s.roomHistory[room];
    const oldest = hist && hist.length ? hist[0] : undefined;
    // No history yet means the initial open is still pending — that fetch covers this.
    if (!oldest) return;
    const sent = sendCommand({ type: "chat.history", room, before: { createdAt: oldest.createdAt, id: oldest.id } });
    if (sent) set({ roomLoading: { ...s.roomLoading, [room]: true } });
  },
  closeOffice: () => set({ officeRoom: null }),
  postChat: (room, body) => {
    const text = body.trim();
    if (!text) return false;
    const clientId = newOutboundId();
    return sendOutbound(
      { id: clientId, surface: "office", room, content: text, createdAt: Date.now(), status: "sending" },
      { type: "chat.post", room, body: text, clientId },
    );
  },
  clearNotice: () => set({ notice: null }),
  setBoardView: (v) => set({ boardView: v }),
  createSchedule: (input) => sendCommand({ type: "schedule.create", ...input }),
  updateSchedule: (id, patch) => sendCommand({ type: "schedule.update", id, patch }),
  deleteSchedule: (id) => sendCommand({ type: "schedule.delete", id }),
  runSchedule: (id) => sendCommand({ type: "schedule.run", id }),
  addNote: (body, url) => {
    const text = body.trim();
    const link = url?.trim();
    if (text || link) sendCommand({ type: "note.create", body: text || link!, ...(link ? { url: link } : {}) });
  },
  deleteNote: (id) => sendCommand({ type: "note.delete", id }),
  clearNotes: () => sendCommand({ type: "note.clear" }),
  sendSupervisorMessage: (content, targetIds) => {
    const text = content.trim();
    if (!text) return false;
    const clientId = newOutboundId();
    return sendOutbound(
      { id: clientId, surface: "supervisor", content: text, targetIds: [...targetIds], createdAt: Date.now(), status: "sending" },
      { type: "supervisor.message", content: text, targetIds, clientId },
    );
  },
  runSupervisorNow: () => sendCommand({ type: "supervisor.runNow" }),
  joinOnlineOffice: ({ url, code, instanceName }) => {
    set({ officeJoining: true, officeJoinError: null });
    sendCommand({ type: "office.join", url: url.trim(), code: code.trim(), instanceName: instanceName.trim() });
  },
  leaveOnlineOffice: () => {
    set({ officeJoinError: null });
    sendCommand({ type: "office.leave" });
  },
  setOnlineOffice: (patch) => sendCommand({ type: "office.set", ...patch }),
  setUpdateReady: (v) => set({ updateReady: v }),
  setGitUpdate: (v) => set({ gitUpdate: v }),
  applyGitUpdate: async () => {
    if (useStore.getState().updateApplying) return; // guard against a double-click
    set({ updateApplying: true, updateError: null });
    try {
      const res = await fetch(apiUrl("/api/update/apply"), {
        method: "POST",
      });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; needsManualRestart?: boolean };
      if (!res.ok || !j.ok) {
        set({ updateApplying: false, updateError: j.error || "Update failed — check the server log." });
        return;
      }
      // Success: the server rebuilt (and may be restarting). Wait for it to answer again, then reload
      // onto the new build. A backend-only change with no reachable hub can't auto-restart — surface
      // that the server still needs a manual restart, but reload so the rebuilt web is at least current.
      await waitForServer();
      if (j.needsManualRestart) {
        useStore.setState({
          notice: { level: "warn", title: "Updated — restart needed", message: "Pulled and rebuilt, but backend code changed and no script-hub was reachable to restart it. Restart the orchestrator to fully apply." },
        });
      }
      location.reload();
    } catch {
      set({ updateApplying: false, updateError: "Update failed — check the server log." });
    }
  },
}));

/** Poll /api/health until the server answers (it may be mid-restart) or we give up, so a reload lands
 *  on a live server rather than a connection error. */
async function waitForServer(timeoutMs = 90_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(apiUrl("/api/health"), { cache: "no-store" });
      if (r.ok) return;
    } catch {
      /* still down — keep waiting */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** Which agent RUN a feed item belongs to. Keyed by runId (stable on the item) so retention
 *  never depends on run-arrival timing; a tool_result is grouped with its own run's items. */
export function feedBucket(f: FeedItem): string {
  if (f.kind === "text" || f.kind === "thinking" || f.kind === "tool" || f.kind === "tool_result") return f.runId;
  if (f.kind === "finding") return f.finding.fromRunId ?? "other";
  return "other";
}

/** The stable DB message-row id of a feed item, if it has one. Live-streamed items and the
 *  same message re-delivered by thread.history share this id, so it's how we dedup the two. */
export function feedMessageId(f: FeedItem): string | undefined {
  if (f.kind === "text" || f.kind === "thinking" || f.kind === "tool" || f.kind === "system") return f.id;
  if (f.kind === "tool_result") return f.messageId;
  return undefined;
}

/** Keep the oldest durable cursor after a reconnect replays the newest page over already-paginated
 * history. UUID order is the stable tie-break when messages share one millisecond. */
function olderMessageCursor(current: MessageCursor | undefined, next: MessageCursor): MessageCursor {
  if (!current) return next;
  if (next.createdAt < current.createdAt || (next.createdAt === current.createdAt && next.id < current.id)) return next;
  return current;
}

/** Enforce the per-run and absolute feed caps on an already-chronological list. Used by both
 *  the live append path and the thread.history merge so a long-running thread re-fetched on
 *  reconnect can't balloon the feed past the render backstop.
 *
 *  `olderPages` is how many extra history pages the OWNER has explicitly loaded for this task, and
 *  it raises both caps by exactly that much. Without it the caps silently discard the page that was
 *  just fetched (they drop each bucket's OLDEST overflow, which is precisely the older page), so
 *  "Load earlier history" appeared to do nothing while the cursor kept consuming real history. */
function capFeed(items: FeedItem[], olderPages = 0): FeedItem[] {
  const grow = Math.max(0, olderPages) * THREAD_HISTORY_PAGE_SIZE;
  const perRunCap = PER_RUN_CAP + grow;
  const hardCap = FEED_HARD_CAP + grow;
  const totals = new Map<string, number>();
  for (const f of items) {
    const b = feedBucket(f);
    totals.set(b, (totals.get(b) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  const kept: FeedItem[] = [];
  for (const f of items) {
    const b = feedBucket(f);
    const total = totals.get(b)!;
    const idxInBucket = seen.get(b) ?? 0;
    seen.set(b, idxInBucket + 1);
    if (total > perRunCap && idxInBucket < total - perRunCap) continue; // drop this bucket's oldest overflow
    kept.push(f);
  }
  return kept.length > hardCap ? kept.slice(kept.length - hardCap) : kept;
}

function pushFeed(threadId: string, item: FeedItem, receivedOutboundId?: string): void {
  useStore.setState((s) => {
    const existing = s.threadFeeds[threadId] ?? [];
    const id = feedMessageId(item);
    const outboundMessages = receivedOutboundId
      ? s.outboundMessages.filter((message) => message.id !== receivedOutboundId)
      : s.outboundMessages;
    if (id && existing.some((f) => feedMessageId(f) === id)) return receivedOutboundId ? { outboundMessages } : {}; // history already merged this row
    return {
      threadFeeds: { ...s.threadFeeds, [threadId]: capFeed([...existing, item], s.threadHistoryPages[threadId] ?? 0) },
      outboundMessages,
    };
  });
}

function taskDeliveryMatchesMessage(delivery: OutboundMessage, message: Message): boolean {
  return (
    delivery.surface === "task" &&
    delivery.threadId === message.threadId &&
    message.role === "director" &&
    message.kind === "system" &&
    message.content.includes(delivery.content)
  );
}

const CHAT_CAP = 1500;
const ROOM_CAP = 800;

/** Fold a live project-room message into the room roll-up: bump count/lastAt and register a new
 *  participant — a local task, or the machine an Online Office line came from. (General-room messages
 *  aren't per-task collaborations, so they don't roll up.) Registering the remote machine here is what
 *  makes a cross-machine room's chatroom tab appear as it happens rather than only after a reload. */
function upsertRoom(rooms: ChatRoomSummary[], m: ChatMessage): ChatRoomSummary[] {
  if (m.scope !== "project") return rooms;
  const i = rooms.findIndex((r) => r.room === m.room);
  if (i < 0) {
    return [
      {
        room: m.room,
        workspace: m.workspace ?? "",
        threadIds: m.threadId ? [m.threadId] : [],
        remoteInstances: m.remoteInstance ? [m.remoteInstance] : [],
        messageCount: 1,
        lastAt: m.createdAt,
      },
      ...rooms,
    ];
  }
  const cur = rooms[i]!;
  const threadIds = m.threadId && !cur.threadIds.includes(m.threadId) ? [...cur.threadIds, m.threadId] : cur.threadIds;
  const remoteInstances =
    m.remoteInstance && !cur.remoteInstances.includes(m.remoteInstance) ? [...cur.remoteInstances, m.remoteInstance] : cur.remoteInstances;
  const next = { ...cur, threadIds, remoteInstances, messageCount: cur.messageCount + 1, lastAt: Math.max(cur.lastAt, m.createdAt) };
  return [next, ...rooms.slice(0, i), ...rooms.slice(i + 1)];
}

function applyEvent(ev: ServerEvent): void {
  switch (ev.type) {
    case "hello": {
      const threads: Record<string, Thread> = {};
      for (const t of ev.threads) threads[t.id] = t;
      const runs: Record<string, AgentRun> = {};
      for (const r of ev.runs) runs[r.id] = r;
      const coworkSessions: Record<string, CoworkSession> = {};
      for (const session of ev.coworkSessions ?? []) coworkSessions[session.id] = session;
      const director: DirectorItem[] = ev.director.map((m: DirectorMessage) => ({
        id: m.id,
        kind: m.role,
        text: m.content,
        attachments: m.attachments,
        at: m.createdAt,
      }));
      const received = acknowledgeOutbound([
        ...ev.director.map((message) => message.id),
        ...(ev.chat ?? []).map((message) => message.id),
        ...(ev.supervisor?.chat ?? []).map((turn) => turn.id),
      ]);
      // Only adopt settings when the frame actually carries them. A server mid-deploy (version skew)
      // omits the field; mergeSettings(undefined) would hand back all-defaults and snap the toggles back
      // on every heartbeat — keep the live values until a frame that truly has settings arrives.
      useStore.setState((s) => ({
        threads,
        runs,
        coworkSessions,
        coworkCreating: false,
        findings: ev.findings,
        questions: ev.questions,
        director,
        directorStatus: ev.directorStatus ?? null,
        accounts: ev.accounts,
        codexUsage: ev.codexUsage ?? null,
        grokUsage: ev.grokUsage ?? null,
        zaiUsage: ev.zaiUsage ?? null,
        approvalMode: ev.approvalMode,
        outboundMessages: s.outboundMessages.filter((message) => !received.has(message.id)),
        ...(ev.settings ? { settings: mergeSettings(ev.settings) } : {}),
        ...(ev.chat ? { chat: ev.chat } : {}),
        ...(ev.chatRooms ? { chatRooms: ev.chatRooms } : {}),
        ...(ev.nameOverrides ? { nameOverrides: ev.nameOverrides } : {}),
        ...(ev.schedules ? { schedules: ev.schedules } : {}),
        ...(ev.modelStats ? { modelStats: ev.modelStats } : {}),
        ...(ev.notes ? { notes: ev.notes } : {}),
        ...(ev.onlineOffice ? { onlineOffice: ev.onlineOffice } : {}),
        ...(ev.supervisor ? { supervisor: ev.supervisor } : {}),
      }));
      // A (re)connect clears any per-room loading flags: a request in flight when the socket dropped
      // never gets its reply, and a stuck flag would permanently block that room's scroll-up.
      useStore.setState({ roomLoading: {} });
      // If the office panel is open, re-pull the open room so it reflects anything that streamed
      // while the socket was gone (mirrors the thread.history re-fetch above).
      const openRoom = useStore.getState().officeRoom;
      if (openRoom && sendCommand({ type: "chat.history", room: openRoom }))
        useStore.setState((s) => ({ roomLoading: { ...s.roomLoading, [openRoom]: true } }));
      // hello also fires on WS reconnect (server restart / network blip). The feed kept its
      // pre-disconnect items but missed anything that streamed while we were gone — re-fetch
      // the open thread's history; the id-keyed merge fills the gap without dropping live items.
      const selected = useStore.getState().selectedThreadId;
      if (selected && sendCommand({ type: "thread.history", threadId: selected })) {
        useStore.setState((s) => ({ threadHistoryLoading: { ...s.threadHistoryLoading, [selected]: true } }));
      }
      const selectedCowork = useStore.getState().selectedCoworkId;
      if (selectedCowork && coworkSessions[selectedCowork]) sendCommand({ type: "cowork.history", sessionId: selectedCowork });
      break;
    }
    case "cowork.session":
      useStore.setState((s) => ({ coworkSessions: { ...s.coworkSessions, [ev.session.id]: ev.session } }));
      break;
    case "cowork.removed":
      useStore.setState((s) => {
        const { [ev.sessionId]: _session, ...coworkSessions } = s.coworkSessions;
        const { [ev.sessionId]: _messages, ...coworkMessages } = s.coworkMessages;
        const { [ev.sessionId]: _turns, ...coworkTurns } = s.coworkTurns;
        return {
          coworkSessions,
          coworkMessages,
          coworkTurns,
          selectedCoworkId: s.selectedCoworkId === ev.sessionId ? null : s.selectedCoworkId,
        };
      });
      break;
    case "cowork.message":
      clearOutboundTimer(ev.message.id);
      useStore.setState((s) => {
        const current = s.coworkMessages[ev.message.sessionId] ?? [];
        const index = current.findIndex((message) => message.id === ev.message.id);
        const messages = index < 0
          ? [...current, ev.message]
          : current.map((message, i) => (i === index ? ev.message : message));
        messages.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
        return {
          coworkMessages: { ...s.coworkMessages, [ev.message.sessionId]: messages },
          outboundMessages: s.outboundMessages.filter((message) => message.id !== ev.message.id),
        };
      });
      break;
    case "cowork.delta":
    case "cowork.thinking":
      useStore.setState((s) => {
        const current = s.coworkMessages[ev.sessionId] ?? [];
        const existing = current.find((message) => message.id === ev.messageId);
        const kind = ev.type === "cowork.delta" ? "text" : "thinking";
        const message: CoworkMessage = existing
          ? { ...existing, content: existing.content + ev.text, partial: true, updatedAt: Date.now() }
          : {
              id: ev.messageId,
              sessionId: ev.sessionId,
              turnId: ev.turnId,
              role: "coworker",
              kind,
              content: ev.text,
              meta: null,
              partial: true,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            };
        return {
          coworkMessages: {
            ...s.coworkMessages,
            [ev.sessionId]: existing
              ? current.map((item) => (item.id === ev.messageId ? message : item))
              : [...current, message],
          },
        };
      });
      break;
    case "cowork.history":
      useStore.setState((s) => ({
        ...(ev.session ? { coworkSessions: { ...s.coworkSessions, [ev.sessionId]: ev.session } } : {}),
        coworkMessages: { ...s.coworkMessages, [ev.sessionId]: ev.messages },
        coworkTurns: { ...s.coworkTurns, [ev.sessionId]: ev.turns },
        outboundMessages: s.outboundMessages.filter(
          (delivery) => delivery.surface !== "cowork" || delivery.sessionId !== ev.sessionId || !ev.messages.some((message) => message.id === delivery.id),
        ),
      }));
      for (const message of ev.messages) clearOutboundTimer(message.id);
      break;
    case "cowork.action":
      if (ev.clientId && !ev.ok) failOutbound(ev.clientId, ev.error ?? "The Co-worker command failed.");
      useStore.setState((s) => ({
        coworkCreating: ev.action === "create" ? false : s.coworkCreating,
        coworkActionError: ev.ok ? null : ev.error ?? "The Co-worker command failed.",
        ...(ev.result.session ? { coworkSessions: { ...s.coworkSessions, [ev.result.session.id]: ev.result.session } } : {}),
        ...(ev.ok && ev.action === "create" && ev.result.session ? { selectedCoworkId: ev.result.session.id } : {}),
      }));
      if (ev.ok && ev.action === "create" && ev.result.session) sendCommand({ type: "cowork.history", sessionId: ev.result.session.id });
      break;
    case "grok.usage":
      useStore.setState({ grokUsage: ev.usage });
      break;
    case "codex.usage":
      useStore.setState({ codexUsage: ev.usage });
      break;
    case "zai.usage":
      useStore.setState({ zaiUsage: ev.usage });
      break;
    case "accounts":
      useStore.setState({ accounts: ev.accounts });
      break;
    case "office.online":
      useStore.setState({ onlineOffice: ev.office });
      break;
    case "office.join.result":
      useStore.setState({ officeJoining: false, officeJoinError: ev.ok ? null : ev.error });
      break;
    case "notes":
      useStore.setState({ notes: ev.notes });
      break;
    case "schedules":
      useStore.setState({ schedules: ev.schedules });
      break;
    case "supervisor":
      {
        const received = acknowledgeOutbound(ev.supervisor.chat.map((turn) => turn.id));
        useStore.setState((s) => ({
          supervisor: ev.supervisor,
          outboundMessages: s.outboundMessages.filter((message) => !received.has(message.id)),
        }));
      }
      break;
    case "model.stats":
      useStore.setState({ modelStats: ev.stats });
      break;
    case "chat.message":
      clearOutboundTimer(ev.message.id);
      useStore.setState((s) => {
        // A reconnect races the relay/history replay on real networks. IDs are the durable identity;
        // never let the same frame create two bubbles while the follow-up chat.history is in flight.
        const isNew = !s.chat.some((m) => m.id === ev.message.id);
        const chat = isNew ? [...s.chat, ev.message] : s.chat;
        const capped = chat.length > CHAT_CAP ? chat.slice(chat.length - CHAT_CAP) : chat;
        // Append to a room's loaded history too, so a live message shows without a re-fetch. Trim the
        // oldest to bound a chatty room — but NOT the room the panel is currently showing: the user may
        // have scrolled up and paginated older pages in, and clipping the top would both drop that loaded
        // history and shove the load-more cursor (roomHistory[room][0]) forward, re-fetching what was
        // clipped. A background room isn't being scrolled, so capping it is safe (re-open refetches).
        const room = ev.message.room;
        const hist = s.roomHistory[room];
        const grown = hist ? (hist.some((m) => m.id === ev.message.id) ? hist : [...hist, ev.message]) : undefined;
        const trimmable = room !== s.officeRoom && grown && grown.length > ROOM_CAP;
        const roomHistory = grown
          ? { ...s.roomHistory, [room]: trimmable ? grown.slice(grown.length - ROOM_CAP) : grown }
          : s.roomHistory;
        return {
          chat: capped,
          chatRooms: isNew ? upsertRoom(s.chatRooms, ev.message) : s.chatRooms,
          roomHistory,
          outboundMessages: s.outboundMessages.filter((message) => message.id !== ev.message.id),
        };
      });
      break;
    case "chat.name":
      useStore.setState((s) => ({ nameOverrides: { ...s.nameOverrides, [agentKey(ev.threadId, ev.role)]: ev.name } }));
      break;
    case "chat.history": {
      // Merge by id rather than replace: a live chat.message for this room can land between the
      // chat.history request and its reply, and a blind replace would drop it until the next message.
      // This same merge serves both the initial newest page and each older scroll-up page.
      const received = acknowledgeOutbound(ev.messages.map((message) => message.id));
      useStore.setState((s) => {
        const byId = new Map((s.roomHistory[ev.room] ?? []).map((m) => [m.id, m]));
        for (const message of ev.messages) byId.set(message.id, message);
        const merged = [...byId.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
        return {
          roomHistory: { ...s.roomHistory, [ev.room]: merged },
          roomHasMore: { ...s.roomHasMore, [ev.room]: ev.hasMore },
          roomLoading: { ...s.roomLoading, [ev.room]: false },
          outboundMessages: s.outboundMessages.filter((message) => !received.has(message.id)),
        };
      });
      break;
    }
    case "plan.ready":
      useStore.setState((s) => ({ pendingPlans: { ...s.pendingPlans, [ev.threadId]: ev.brief } }));
      notify("Plan ready for approval", "Review and approve to start building.");
      break;
    case "approval.mode":
      useStore.setState({ approvalMode: ev.on });
      break;
    case "settings":
      useStore.setState({ settings: mergeSettings(ev.settings) });
      break;
    case "codex.test.result":
      useStore.setState({ codexTest: { ok: ev.ok, message: ev.message }, codexTesting: false });
      break;
    case "discord.test.result":
      useStore.setState({ discordTest: { ok: ev.ok, message: ev.message }, discordTesting: false });
      break;
    case "thread.changes":
      useStore.setState((s) => ({ threadChanges: { ...s.threadChanges, [ev.threadId]: { diff: ev.diff, log: ev.log } } }));
      break;
    case "thread.gitSummary":
      useStore.setState((s) => ({ gitSummaries: { ...s.gitSummaries, [ev.threadId]: ev.summary } }));
      break;
    case "thread.git":
      useStore.setState((s) => ({ gitStatus: { ...s.gitStatus, [ev.threadId]: ev.status } }));
      break;
    case "thread.gitDiff":
      useStore.setState((s) => ({
        gitDiffs: { ...s.gitDiffs, [ev.threadId]: { ...(s.gitDiffs[ev.threadId] ?? {}), [ev.path]: ev.diff } },
      }));
      break;
    case "repo.list":
      useStore.setState((s) =>
        // Not the reply to the request in flight — an earlier open's answer, arriving late. Taking it
        // would auto-select the wrong repo AND clear the pending flag the real answer still needs.
        ev.forThread !== s.repoListFor ? {} : { repos: ev.repos, repoPreferred: ev.preferred, repoListPending: false },
      );
      break;
    case "repo.state":
      useStore.setState((s) => ({ repoStates: { ...s.repoStates, [ev.path]: ev.state } }));
      break;
    case "repo.diff":
      useStore.setState((s) => ({
        repoDiffs: { ...s.repoDiffs, [ev.path]: { ...(s.repoDiffs[ev.path] ?? {}), [repoDiffKey(ev.file, ev.commit)]: ev.diff } },
      }));
      break;
    case "repo.commit":
      useStore.setState((s) => ({
        repoCommits: { ...s.repoCommits, [ev.path]: { ...(s.repoCommits[ev.path] ?? {}), [ev.detail.hash]: ev.detail } },
      }));
      break;
    case "repo.result":
      useStore.setState((s) => {
        if (!ev.result.ok) return { repoBusy: false, repoResult: { ...ev.result, action: ev.action, at: Date.now() } };
        // The repo moved, so the per-task Changes surfaces that read the same repo are stale too. The
        // drawer caches are DROPPED — both re-fetch themselves whenever a drawer/diff is opened. The card
        // chips are RE-REQUESTED instead of dropped: a chip only fetches its summary on mount, so
        // clearing it would make every chip on the board disappear until the card remounted.
        const { [ev.path]: _stale, ...repoDiffs } = s.repoDiffs;
        for (const threadId of Object.keys(s.gitSummaries)) sendCommand({ type: "thread.gitSummary", threadId });
        return { repoBusy: false, repoResult: { ...ev.result, action: ev.action, at: Date.now() }, repoDiffs, gitStatus: {}, gitDiffs: {} };
      });
      break;
    case "thread.upsert":
      useStore.setState((s) => {
        const prev = s.threads[ev.thread.id];
        if (prev && prev.state !== ev.thread.state) notifyThreadState(ev.thread);
        return { threads: { ...s.threads, [ev.thread.id]: ev.thread } };
      });
      break;
    case "thread.removed":
      // A task was permanently dismissed server-side. Prune EVERY id-keyed slice so no dangling
      // state references the deleted thread, and clear selection if it was the open one.
      useStore.setState((s) => {
        const drop = <V,>(rec: Record<string, V>): Record<string, V> => {
          if (!(ev.threadId in rec)) return rec;
          const { [ev.threadId]: _omit, ...rest } = rec;
          return rest;
        };
        const runs: Record<string, AgentRun> = {};
        for (const [id, run] of Object.entries(s.runs)) {
          if (run.threadId !== ev.threadId) runs[id] = run;
        }
        return {
          threads: drop(s.threads),
          threadFeeds: drop(s.threadFeeds),
          threadHistoryCursors: drop(s.threadHistoryCursors),
          threadHistoryHasMore: drop(s.threadHistoryHasMore),
          threadHistoryLoading: drop(s.threadHistoryLoading),
          threadHistoryPages: drop(s.threadHistoryPages),
          implementationMemos: drop(s.implementationMemos),
          threadDrafts: drop(s.threadDrafts),
          thinkingDrafts: drop(s.thinkingDrafts),
          pendingPlans: drop(s.pendingPlans),
          threadChanges: drop(s.threadChanges),
          gitSummaries: drop(s.gitSummaries),
          gitStatus: drop(s.gitStatus),
          gitDiffs: drop(s.gitDiffs),
          runs,
          findings: s.findings.filter((f) => f.threadId !== ev.threadId),
          questions: s.questions.filter((q) => q.threadId !== ev.threadId),
          selectedThreadId: s.selectedThreadId === ev.threadId ? null : s.selectedThreadId,
        };
      });
      break;
    case "thread.reset":
      // Keep implementationMemos here: Retry clears the transient run/feed rows, but each prior work
      // revision remains part of the audit trail and the new implementor pass appends another revision.
      // A cancelled task was restarted from scratch server-side: its prior runs/findings/feed were
      // deleted. Prune that stale slice so the fresh pipeline's events repopulate cleanly — but KEEP
      // the thread row (its state updates via thread.upsert) and the selection (mirrors thread.removed
      // minus the thread drop).
      useStore.setState((s) => {
        const drop = <V,>(rec: Record<string, V>): Record<string, V> => {
          if (!(ev.threadId in rec)) return rec;
          const { [ev.threadId]: _omit, ...rest } = rec;
          return rest;
        };
        const runs: Record<string, AgentRun> = {};
        for (const [id, run] of Object.entries(s.runs)) {
          if (run.threadId !== ev.threadId) runs[id] = run;
        }
        return {
          runs,
          findings: s.findings.filter((f) => f.threadId !== ev.threadId),
          questions: s.questions.filter((q) => q.threadId !== ev.threadId),
          threadFeeds: drop(s.threadFeeds),
          threadHistoryCursors: drop(s.threadHistoryCursors),
          threadHistoryHasMore: drop(s.threadHistoryHasMore),
          threadHistoryLoading: drop(s.threadHistoryLoading),
          threadHistoryPages: drop(s.threadHistoryPages),
          threadDrafts: drop(s.threadDrafts),
          thinkingDrafts: drop(s.thinkingDrafts),
          pendingPlans: drop(s.pendingPlans),
          threadChanges: drop(s.threadChanges),
          gitSummaries: drop(s.gitSummaries),
          gitStatus: drop(s.gitStatus),
          gitDiffs: drop(s.gitDiffs),
        };
      });
      // If this task is open, re-pull its (now-empty) history so the director-brief row that anchors
      // the feed reappears immediately — the fresh pipeline's live events then stream in beneath it.
      if (useStore.getState().selectedThreadId === ev.threadId && sendCommand({ type: "thread.history", threadId: ev.threadId })) {
        useStore.setState((s) => ({ threadHistoryLoading: { ...s.threadHistoryLoading, [ev.threadId]: true } }));
      }
      break;
    case "thread.history": {
      // Merge the authoritative DB history with whatever streamed live, keyed by stable id —
      // NOT all-or-nothing. The old guard dropped the full history whenever live events had
      // already populated the feed (the ~20-message / reconnect bug). The DB row wins on a
      // collision; live-only artifacts (in-flight tool_results, system notes) are preserved.
      const receivedTaskIds = acknowledgeOutbound(
        useStore
          .getState()
          .outboundMessages.filter(
            (delivery) =>
              delivery.surface === "task" &&
              delivery.threadId === ev.threadId &&
              ev.messages.some((message) => taskDeliveryMatchesMessage(delivery, message)),
          )
          .map((delivery) => delivery.id),
      );
      useStore.setState((s) => {
        const dbItems: FeedItem[] = [];
        for (const m of ev.messages) {
          const fi = messageToFeed(m);
          if (fi) dbItems.push(fi);
        }
        for (const f of ev.findings) dbItems.push({ kind: "finding", at: f.createdAt, finding: f });
        // The original brief the director wrote isn't a Message row — it rides on the history event.
        // Synthesize a stable director-tagged row so it anchors the DIRECTOR filter at the top.
        if (ev.brief.trim()) {
          dbItems.push({
            kind: "system",
            at: s.threads[ev.threadId]?.createdAt ?? 0,
            id: "brief:" + ev.threadId,
            text: ev.brief,
            role: "director",
          });
        }

        const dbMessageIds = new Set<string>();
        const dbFindingIds = new Set<string>();
        for (const it of dbItems) {
          const mid = feedMessageId(it);
          if (mid) dbMessageIds.add(mid);
          if (it.kind === "finding") dbFindingIds.add(it.finding.id);
        }

        const liveOnly = (s.threadFeeds[ev.threadId] ?? []).filter((it) => {
          const mid = feedMessageId(it);
          if (mid) return !dbMessageIds.has(mid);
          if (it.kind === "finding") return !dbFindingIds.has(it.finding.id);
          return true;
        });

        // An explicit older-history request buys one more page of retention; a reconnect replay of the
        // newest page keeps whatever the owner had already expanded to.
        const olderPages = (s.threadHistoryPages[ev.threadId] ?? 0) + (ev.before && ev.messages.length ? 1 : 0);
        const merged = capFeed([...dbItems, ...liveOnly].sort((a, b) => a.at - b.at), olderPages);
        const first = ev.messages[0];
        const cursor = first ? olderMessageCursor(s.threadHistoryCursors[ev.threadId], { createdAt: first.createdAt, id: first.id }) : s.threadHistoryCursors[ev.threadId];
        const replayedNewestPage = !ev.before && !!first && !!cursor &&
          (cursor.createdAt < first.createdAt || (cursor.createdAt === first.createdAt && cursor.id < first.id));
        return {
          threadFeeds: { ...s.threadFeeds, [ev.threadId]: merged },
          threadHistoryPages: { ...s.threadHistoryPages, [ev.threadId]: olderPages },
          ...(cursor ? { threadHistoryCursors: { ...s.threadHistoryCursors, [ev.threadId]: cursor } } : {}),
          threadHistoryHasMore: {
            ...s.threadHistoryHasMore,
            [ev.threadId]: replayedNewestPage ? s.threadHistoryHasMore[ev.threadId] ?? false : ev.hasMoreMessages ?? false,
          },
          threadHistoryLoading: { ...s.threadHistoryLoading, [ev.threadId]: false },
          implementationMemos: {
            ...s.implementationMemos,
            [ev.threadId]: mergeImplementationMemos(s.implementationMemos[ev.threadId] ?? [], ev.implementationMemos ?? []),
          },
          outboundMessages: s.outboundMessages.filter((message) => !receivedTaskIds.has(message.id)),
        };
      });
      break;
    }
    case "thread.memo":
      useStore.setState((s) => ({
        implementationMemos: {
          ...s.implementationMemos,
          [ev.threadId]: mergeImplementationMemos(s.implementationMemos[ev.threadId] ?? [], [ev.memo]),
        },
      }));
      break;
    case "thread.message": {
      // A server-originated thread message (e.g. a director inject) — show it in the feed live.
      // messageToFeed + the id-keyed dedup in pushFeed keep it from doubling on a later history merge.
      const fi = messageToFeed(ev.message);
      const delivery = useStore.getState().outboundMessages.find((candidate) => taskDeliveryMatchesMessage(candidate, ev.message));
      if (delivery) clearOutboundTimer(delivery.id);
      if (fi) pushFeed(ev.threadId, fi, delivery?.id);
      break;
    }
    case "thread.action":
      resolvePendingThreadAction(ev.threadId, ev.action, ev.ok, ev.clientId);
      if (ev.clientId) {
        if (ev.ok) {
          const received = acknowledgeOutbound([ev.clientId]);
          useStore.setState((s) => ({ outboundMessages: s.outboundMessages.filter((message) => !received.has(message.id)) }));
        } else {
          failOutbound(ev.clientId, ev.error ?? ev.message ?? "The task rejected this instruction.");
        }
      }
      if (!ev.ok) {
        const message = ev.error ?? ev.message ?? "The task state changed before the server could apply that control.";
        useStore.setState({ notice: { level: "warn", title: "Task control failed", message } });
        notify("Task control failed", message);
      }
      break;
    case "run.upsert":
      useStore.setState((s) => ({ runs: { ...s.runs, [ev.run.id]: ev.run } }));
      break;
    case "agent.delta":
      useStore.setState((s) => ({
        threadDrafts: {
          ...s.threadDrafts,
          [ev.threadId]: {
            runId: ev.runId,
            role: ev.role,
            text: (s.threadDrafts[ev.threadId]?.runId === ev.runId ? s.threadDrafts[ev.threadId]!.text : "") + ev.text,
          },
        },
      }));
      break;
    case "agent.text":
      useStore.setState((s) => ({ threadDrafts: { ...s.threadDrafts, [ev.threadId]: undefined } }));
      pushFeed(ev.threadId, { kind: "text", at: Date.now(), role: ev.role, runId: ev.runId, id: ev.messageId, text: ev.text });
      break;
    case "agent.tool":
      pushFeed(ev.threadId, { kind: "tool", at: Date.now(), role: ev.role, runId: ev.runId, id: ev.messageId, name: ev.name, input: ev.input });
      break;
    case "agent.tool_result":
      pushFeed(ev.threadId, { kind: "tool_result", at: Date.now(), runId: ev.runId, id: ev.id, messageId: ev.messageId, isError: ev.isError, preview: ev.preview });
      break;
    case "agent.thinking":
      // Live reasoning stream — accumulate into a per-thread draft (like agent.delta) so a long-thinking
      // Grok run shows activity instead of a blank feed. Committed + cleared by agent.reasoning.
      useStore.setState((s) => ({
        thinkingDrafts: {
          ...s.thinkingDrafts,
          [ev.threadId]: {
            runId: ev.runId,
            role: ev.role,
            text: (s.thinkingDrafts[ev.threadId]?.runId === ev.runId ? s.thinkingDrafts[ev.threadId]!.text : "") + ev.text,
          },
        },
      }));
      break;
    case "agent.reasoning":
      // A completed reasoning burst persisted server-side — clear the live draft and pin it durably.
      useStore.setState((s) => ({ thinkingDrafts: { ...s.thinkingDrafts, [ev.threadId]: undefined } }));
      pushFeed(ev.threadId, { kind: "thinking", at: Date.now(), role: ev.role, runId: ev.runId, id: ev.messageId, text: ev.text });
      break;
    case "finding":
      useStore.setState((s) => ({ findings: [...s.findings, ev.finding] }));
      pushFeed(ev.finding.threadId, { kind: "finding", at: Date.now(), finding: ev.finding });
      break;
    case "question.ask":
      useStore.setState((s) => ({ questions: [...s.questions, ev.question] }));
      notify("Claude needs you", `${ev.question.header}: ${ev.question.question}`);
      break;
    case "question.resolved":
      useStore.setState((s) => ({ questions: s.questions.filter((q) => q.id !== ev.questionId) }));
      break;
    case "director.delta":
      useStore.setState((s) => ({ directorDraft: s.directorDraft + ev.text }));
      break;
    case "director.message":
      clearOutboundTimer(ev.message.id);
      useStore.setState((s) => {
        const item: DirectorItem = {
          id: ev.message.id,
          kind: ev.message.role,
          text: ev.message.content,
          attachments: ev.message.attachments,
          at: ev.message.createdAt,
        };
        const existing = s.director.findIndex((entry) => entry.id === item.id);
        const director = existing < 0
          ? [...s.director, item]
          : s.director.map((entry, index) => (index === existing ? item : entry));
        return {
          director,
          outboundMessages: s.outboundMessages.filter((message) => message.id !== ev.message.id),
          directorDraft: ev.message.role === "director" ? "" : s.directorDraft,
        };
      });
      break;
    case "director.tool":
      useStore.setState((s) => ({
        director: [
          ...s.director,
          { id: crypto.randomUUID(), kind: "tool", text: summarizeToolInput(ev.input), toolName: ev.name, at: Date.now() },
        ],
      }));
      break;
    case "director.busy":
      useStore.setState({ directorBusy: ev.busy });
      break;
    case "director.status":
      useStore.setState({ directorStatus: ev.status });
      break;
    case "director.results":
      useStore.setState((s) => {
        // Drop a reply for a query the operator has since retyped or cleared.
        if (!s.directorSearch || s.directorSearch.query !== ev.query) return {};
        return { directorSearch: { query: ev.query, results: ev.messages, tasks: ev.tasks ?? [], searching: false } };
      });
      break;
    case "notice":
      // A user-facing notification (token-safety auto-stop / token-reset auto-resume). Show the
      // always-visible banner AND fire the opt-in desktop notify, so it's seen whether or not
      // notifications are enabled.
      useStore.setState({ notice: { level: ev.level, title: ev.title, message: ev.message } });
      notify(ev.title, ev.message);
      break;
    // `log` events are intentionally ignored client-side — there is no log surface in the UI, and
    // buffering them was dead state. Re-add a slice here if a log panel is ever built.
    default:
      break;
  }
}

function notifyThreadState(t: Thread): void {
  if (t.state === "done") notify("✓ Task done", t.title);
  else if (t.state === "review") notify("⚠ Task needs your review", t.title);
  else if (t.state === "failed") notify("✗ Task failed", t.title);
}

function messageToFeed(m: Message): FeedItem | null {
  if (m.role === "user") return { kind: "system", at: m.createdAt, id: m.id, text: m.content, attachments: m.attachments };
  const role = m.role as Role;
  switch (m.kind) {
    case "text":
      return { kind: "text", at: m.createdAt, role, runId: m.runId ?? "", id: m.id, text: m.content };
    case "thinking":
      return { kind: "thinking", at: m.createdAt, role, runId: m.runId ?? "", id: m.id, text: m.content };
    case "tool":
      return { kind: "tool", at: m.createdAt, role, runId: m.runId ?? "", id: m.id, name: m.content, input: undefined };
    case "result":
      // Persisted tool-result preview. `id` doubles as the React key here; `messageId` carries
      // the dedup key. isError isn't stored, so a reloaded result renders without the error tint.
      return { kind: "tool_result", at: m.createdAt, runId: m.runId ?? "", id: m.id, messageId: m.id, isError: false, preview: m.content };
    case "system":
      return { kind: "system", at: m.createdAt, id: m.id, text: m.content, role: m.role === "director" ? "director" : undefined, attachments: m.attachments };
    default:
      return null;
  }
}

function summarizeToolInput(input: unknown): string {
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    if (typeof o.query === "string") return o.query;
    if (typeof o.title === "string") return o.title;
    if (typeof o.question === "string") return o.question;
    if (typeof o.threadId === "string") return o.threadId.slice(0, 8);
  }
  return "";
}

/** Boot: check auth; connect the WS if allowed, else surface the login screen. */
export async function init(): Promise<void> {
  try {
    const r = await fetch(apiUrl("/api/me"));
    const j = (await r.json()) as { authed?: boolean; required?: boolean; google?: boolean; password?: boolean };
    if (j.required && !j.authed) {
      const err = new URLSearchParams(location.search).get("e");
      if (err) history.replaceState(null, "", location.pathname); // consume once — don't wedge the login screen
      useStore.setState({ authRequired: true, authed: false, authGoogle: !!j.google, authPassword: !!j.password, authError: err });
      return;
    }
    useStore.setState({ authRequired: false, authed: true });
  } catch {
    /* server unreachable (dev) — try to connect anyway */
  }
  connect();
}

export async function login(password: string): Promise<{ ok: boolean; retryMs?: number }> {
  try {
    const r = await fetch(apiUrl("/api/login"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; retryMs?: number };
    if (r.ok && j.ok) {
      await init();
      return { ok: true };
    }
    return { ok: false, retryMs: typeof j.retryMs === "number" ? j.retryMs : undefined };
  } catch {
    return { ok: false };
  }
}

export function connect(): void {
  clearTimers(); // never let a prior socket's intervals outlive it and stack
  const ws = new WebSocket(wsUrl());
  socket = ws;
  ws.onopen = () => {
    useStore.setState({ connected: true });
    lastRecvAt = Date.now();
    // Ask for the authoritative snapshot first: it may already contain the receipt from a message
    // that reached the server just before the old tunnel died. Then replay anything still missing.
    sendCommand({ type: "snapshot.request" });
    replaySendingOutbound();
    heartbeat = setInterval(() => sendCommand({ type: "snapshot.request" }), HEARTBEAT_MS);
    watchdog = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN && Date.now() - lastRecvAt > STALE_MS) ws.close();
    }, WATCHDOG_MS);
  };
  ws.onclose = (e) => {
    clearTimers();
    failPendingThreadActions();
    useStore.setState({ connected: false });
    if (e.code === 4401) {
      failSendingOutbound("Your session expired before the server confirmed this message. Sign in, then resend it.");
      useStore.setState({ authRequired: true, authed: false });
      return; // auth lost — show login instead of reconnect-looping
    }
    setTimeout(connect, 1200);
  };
  ws.onmessage = (e) => {
    lastRecvAt = Date.now();
    try {
      applyEvent(JSON.parse(e.data) as ServerEvent);
    } catch {
      /* ignore malformed */
    }
  };
}

// A refocused/rewoken tab may have missed events while backgrounded (proxy timed the
// WS out, or the OS suspended timers). Fire one snapshot.request on re-show for an
// instant authoritative resync; if the socket is already dead the watchdog/onclose
// path reconnects shortly after.
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") sendCommand({ type: "snapshot.request" });
  });
}
