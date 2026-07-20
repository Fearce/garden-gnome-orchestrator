import { create } from "zustand";
import { apiUrl, wsUrl } from "./lib/base.js";
import type {
  AccountDTO,
  CodexUsageDTO,
  GrokUsageDTO,
  AgentRun,
  ChatMessage,
  ChatRoomSummary,
  ClientCommand,
  DirectorItem,
  Effort,
  DirectorMessage,
  FeedItem,
  Finding,
  GitSummary,
  GitStatus,
  GitFileDiff,
  ImageAttachment,
  Message,
  OrchestratorSettings,
  Question,
  Role,
  ScheduledTask,
  ServerEvent,
  SettingsPatch,
  Thread,
} from "./types.js";
import { agentKey, GENERAL_ROOM } from "./types.js";
import { notify } from "./lib/notify.js";

interface ThreadDraft {
  runId: string;
  role: Role;
  text: string;
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
  threads: Record<string, Thread>;
  runs: Record<string, AgentRun>;
  findings: Finding[];
  questions: Question[];
  director: DirectorItem[];
  directorDraft: string;
  directorBusy: boolean;
  // Director-conversation search — matches span the WHOLE conversation across every task (the snapshot
  // only carries the recent slice, so old mentions are found via a server query; the server match is
  // ASCII case-insensitive). Null when the search box is empty/closed; `searching` gates the spinner
  // between the request and its reply.
  directorSearch: { query: string; results: DirectorMessage[]; searching: boolean } | null;
  threadFeeds: Record<string, FeedItem[]>;
  threadDrafts: Record<string, ThreadDraft | undefined>;
  selectedThreadId: string | null;
  approvalMode: boolean;
  // Server-authoritative pipeline settings (broadcast over WS); the panel edits these via setSettings.
  settings: OrchestratorSettings;
  // Latest Codex "Test connection" verdict (null until a test runs). Cleared while a test is in flight.
  codexTest: { ok: boolean; message: string } | null;
  codexTesting: boolean;
  // Client-only view settings, persisted in localStorage under `director_settings` — they only change
  // what this browser shows, so they never round-trip to the server.
  showCompleted: boolean;
  verbosity: Verbosity;
  // The board's sort order while drag-and-drop is off (the dropdown in the board header drives this).
  taskSort: TaskSort;
  // When on, the board stops auto-sorting by recency and honors the manual drag order in `taskOrder`.
  taskDragAndDrop: boolean;
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
  boardView: "tasks" | "schedules";

  select: (id: string | null) => void;
  // Search the whole director conversation (across every task) for a substring, or clear the search.
  searchDirector: (query: string) => void;
  clearDirectorSearch: () => void;
  sendPrompt: (text: string, workspace?: string, images?: ImageAttachment[]) => void;
  sendDirect: (text: string, workspace?: string, images?: ImageAttachment[]) => void;
  answer: (questionId: string, answer: string) => void;
  inject: (threadId: string, message: string, mode: "append" | "interrupt" | "queue", images?: ImageAttachment[]) => void;
  interrupt: (threadId: string) => void;
  resume: (threadId: string, message?: string) => void;
  cancel: (threadId: string) => void;
  retry: (threadId: string) => void;
  rename: (threadId: string, title: string) => void;
  markDone: (threadId: string) => void;
  close: (threadId: string) => void;
  restore: (threadId: string) => void;
  dismiss: (threadId: string) => void;
  setApproval: (on: boolean) => void;
  setSettings: (patch: SettingsPatch) => void;
  testCodex: (apiKey?: string) => void;
  setAccountEnabled: (id: string, enabled: boolean) => void;
  setShowCompleted: (v: boolean) => void;
  setVerbosity: (v: Verbosity) => void;
  setTaskSort: (v: TaskSort) => void;
  setTaskDragAndDrop: (v: boolean) => void;
  setTaskOrder: (ids: string[]) => void;
  approve: (threadId: string, approved: boolean, feedback?: string) => void;
  loadChanges: (threadId: string) => void;
  loadGitSummary: (threadId: string) => void;
  loadGitStatus: (threadId: string) => void;
  loadGitDiff: (threadId: string, path: string) => void;
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
  postChat: (room: string, body: string) => void;
  // Dismiss the current notice banner.
  clearNotice: () => void;
  // Scheduled tasks: switch the center pane, and CRUD the recurring dispatches (server is authoritative —
  // each mutation is optimism-free and reconciled by the `schedules` broadcast).
  setBoardView: (v: "tasks" | "schedules") => void;
  createSchedule: (input: { title: string; workspace: string; prompt: string; cron: string; enabled?: boolean; effort?: Effort | null }) => void;
  updateSchedule: (id: string, patch: { title?: string; workspace?: string; prompt?: string; cron?: string; enabled?: boolean; effort?: Effort | null }) => void;
  deleteSchedule: (id: string) => void;
  runSchedule: (id: string) => void;
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
}
const VIEW_DEFAULTS: ViewSettings = { showCompleted: true, verbosity: "full", taskDragAndDrop: false, taskSort: "created_desc" };
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
    };
  } catch {
    return VIEW_DEFAULTS;
  }
};
const saveViewSettings = (v: ViewSettings): void => lsSet(VIEW_SETTINGS_KEY, JSON.stringify(v));

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
const DEFAULT_SETTINGS: OrchestratorSettings = {
  plannerEnabled: true,
  researcherEnabled: true,
  qaEnabled: true,
  autoPush: true,
  directorName: "ChangeNameInSettings",
  maxQaRounds: 4,
  maxConcurrent: 3,
  selfImproveEnabled: false,
  tokenLimitEnabled: false,
  tokenLimitPercent: 80,
  autoResumeOnTokenReset: false,
  autoResumeThresholdPercent: 80,
  fastUsagePolling: false,
  codexEnabled: false,
  codexModel: "gpt-5.5",
  codexEffort: "high",
  hasOpenaiKey: false,
  openaiKeyLast4: null,
  codexChatgptLogin: false,
  grokEnabled: false,
  grokModel: "grok-4.5",
  grokEffort: "high",
  grokSignedIn: false,
  grokAccount: null,
  skipDirector: false,
  showComposerModelPicker: true,
  showAgentModel: true,
  skipDirectorEffort: "auto",
  xhighEnabled: false,
  skipDirectorRetitle: true,
  maxRecentRepos: 5,
  recentRepos: [],
  modelOverrides: {},
  accountEffortCaps: {},
  modelDefaults: {},
  claudeModels: [],
  codexModels: [],
  grokModels: [],
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
    socket.send(JSON.stringify(cmd));
    return true;
  }
  return false;
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
  threads: {},
  runs: {},
  findings: [],
  questions: [],
  director: [],
  directorDraft: "",
  directorBusy: false,
  directorSearch: null,
  threadFeeds: {},
  threadDrafts: {},
  selectedThreadId: null,
  approvalMode: false,
  settings: DEFAULT_SETTINGS,
  codexTest: null,
  codexTesting: false,
  showCompleted: loadViewSettings().showCompleted,
  verbosity: loadViewSettings().verbosity,
  taskSort: loadViewSettings().taskSort,
  taskDragAndDrop: loadViewSettings().taskDragAndDrop,
  taskOrder: loadTaskOrder(),
  pendingPlans: {},
  threadChanges: {},
  gitSummaries: {},
  gitStatus: {},
  gitDiffs: {},
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
  boardView: "tasks",

  select: (id) => {
    set({ selectedThreadId: id });
    if (id) sendCommand({ type: "thread.history", threadId: id });
  },
  searchDirector: (query) => {
    const q = query.trim();
    if (!q) {
      set({ directorSearch: null });
      return;
    }
    // Keep the prior results visible while a new query for the same string is in flight (no flash);
    // a changed query starts empty. The reply reconciles both via the echoed query.
    set((s) => ({
      directorSearch: { query: q, results: s.directorSearch?.query === q ? s.directorSearch.results : [], searching: true },
    }));
    sendCommand({ type: "director.search", query: q });
  },
  clearDirectorSearch: () => set({ directorSearch: null }),
  sendPrompt: (text, workspace, images) =>
    sendCommand({ type: "prompt.new", text, workspace: workspace || undefined, images: images?.length ? images : undefined }),
  sendDirect: (text, workspace, images) =>
    sendCommand({ type: "prompt.direct", text, workspace: workspace || undefined, images: images?.length ? images : undefined }),
  answer: (questionId, answer) => sendCommand({ type: "question.answer", questionId, answer }),
  inject: (threadId, message, mode, images) =>
    sendCommand({ type: "thread.inject", threadId, message, mode, images: images?.length ? images : undefined }),
  interrupt: (threadId) => sendCommand({ type: "thread.interrupt", threadId }),
  resume: (threadId, message) => sendCommand({ type: "thread.resume", threadId, message }),
  cancel: (threadId) => sendCommand({ type: "thread.cancel", threadId }),
  retry: (threadId) => sendCommand({ type: "thread.retry", threadId }),
  rename: (threadId, title) => sendCommand({ type: "thread.rename", threadId, title }),
  markDone: (threadId) => sendCommand({ type: "thread.markDone", threadId }),
  close: (threadId) => sendCommand({ type: "thread.close", threadId }),
  restore: (threadId) => sendCommand({ type: "thread.restore", threadId }),
  dismiss: (threadId) => sendCommand({ type: "thread.dismiss", threadId }),
  setApproval: (on) => sendCommand({ type: "approval.set", on }),
  // Optimistic: reflect the change locally at once, then send it. The server's `settings` broadcast
  // confirms (and reconciles any clamp, e.g. an out-of-range number) for every connected client.
  setSettings: (patch) => {
    // Reflect the writable view fields locally at once; the raw key is write-only and never held in
    // client state (the server confirms it via hasOpenaiKey/openaiKeyLast4 on its settings broadcast).
    const { openaiApiKey: _key, ...local } = patch;
    set((s) => ({ settings: { ...s.settings, ...local } }));
    sendCommand({ type: "settings.set", settings: patch });
  },
  testCodex: (apiKey) => {
    set({ codexTesting: true, codexTest: null });
    sendCommand({ type: "codex.test", apiKey: apiKey?.trim() || undefined });
  },
  setAccountEnabled: (id, enabled) => {
    // Optimistic: flip the strip locally; the server's `accounts` broadcast confirms (and snaps back
    // a refused toggle — e.g. trying to disable the last enabled account).
    set((s) => ({ accounts: s.accounts.map((a) => (a.id === id ? { ...a, enabled } : a)) }));
    sendCommand({ type: "account.set", id, enabled });
  },
  setShowCompleted: (v) =>
    set((s) => {
      saveViewSettings({ showCompleted: v, verbosity: s.verbosity, taskSort: s.taskSort, taskDragAndDrop: s.taskDragAndDrop });
      return { showCompleted: v };
    }),
  setVerbosity: (v) =>
    set((s) => {
      saveViewSettings({ showCompleted: s.showCompleted, verbosity: v, taskSort: s.taskSort, taskDragAndDrop: s.taskDragAndDrop });
      return { verbosity: v };
    }),
  setTaskSort: (v) =>
    set((s) => {
      saveViewSettings({ showCompleted: s.showCompleted, verbosity: s.verbosity, taskSort: v, taskDragAndDrop: s.taskDragAndDrop });
      return { taskSort: v };
    }),
  setTaskDragAndDrop: (v) =>
    set((s) => {
      saveViewSettings({ showCompleted: s.showCompleted, verbosity: s.verbosity, taskSort: s.taskSort, taskDragAndDrop: v });
      return { taskDragAndDrop: v };
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
    if (text) sendCommand({ type: "chat.post", room, body: text });
  },
  clearNotice: () => set({ notice: null }),
  setBoardView: (v) => set({ boardView: v }),
  createSchedule: (input) => sendCommand({ type: "schedule.create", ...input }),
  updateSchedule: (id, patch) => sendCommand({ type: "schedule.update", id, patch }),
  deleteSchedule: (id) => sendCommand({ type: "schedule.delete", id }),
  runSchedule: (id) => sendCommand({ type: "schedule.run", id }),
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
  if (f.kind === "text" || f.kind === "tool" || f.kind === "tool_result") return f.runId;
  if (f.kind === "finding") return f.finding.fromRunId ?? "other";
  return "other";
}

/** The stable DB message-row id of a feed item, if it has one. Live-streamed items and the
 *  same message re-delivered by thread.history share this id, so it's how we dedup the two. */
export function feedMessageId(f: FeedItem): string | undefined {
  if (f.kind === "text" || f.kind === "tool" || f.kind === "system") return f.id;
  if (f.kind === "tool_result") return f.messageId;
  return undefined;
}

/** Enforce the per-run and absolute feed caps on an already-chronological list. Used by both
 *  the live append path and the thread.history merge so a long-running thread re-fetched on
 *  reconnect (listMessages has no SQL LIMIT) can't balloon the feed past the render backstop. */
function capFeed(items: FeedItem[]): FeedItem[] {
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
    if (total > PER_RUN_CAP && idxInBucket < total - PER_RUN_CAP) continue; // drop this bucket's oldest overflow
    kept.push(f);
  }
  return kept.length > FEED_HARD_CAP ? kept.slice(kept.length - FEED_HARD_CAP) : kept;
}

function pushFeed(threadId: string, item: FeedItem): void {
  useStore.setState((s) => {
    const existing = s.threadFeeds[threadId] ?? [];
    const id = feedMessageId(item);
    if (id && existing.some((f) => feedMessageId(f) === id)) return {}; // history already merged this row
    return { threadFeeds: { ...s.threadFeeds, [threadId]: capFeed([...existing, item]) } };
  });
}

const CHAT_CAP = 1500;
const ROOM_CAP = 800;

/** Fold a live project-room message into the room roll-up: bump count/lastAt and register a new
 *  participant task. (General-room messages aren't per-task collaborations, so they don't roll up.) */
function upsertRoom(rooms: ChatRoomSummary[], m: ChatMessage): ChatRoomSummary[] {
  if (m.scope !== "project") return rooms;
  const i = rooms.findIndex((r) => r.room === m.room);
  if (i < 0) {
    return [
      { room: m.room, workspace: m.workspace ?? "", threadIds: m.threadId ? [m.threadId] : [], messageCount: 1, lastAt: m.createdAt },
      ...rooms,
    ];
  }
  const cur = rooms[i]!;
  const threadIds = m.threadId && !cur.threadIds.includes(m.threadId) ? [...cur.threadIds, m.threadId] : cur.threadIds;
  const next = { ...cur, threadIds, messageCount: cur.messageCount + 1, lastAt: Math.max(cur.lastAt, m.createdAt) };
  return [next, ...rooms.slice(0, i), ...rooms.slice(i + 1)];
}

function applyEvent(ev: ServerEvent): void {
  switch (ev.type) {
    case "hello": {
      const threads: Record<string, Thread> = {};
      for (const t of ev.threads) threads[t.id] = t;
      const runs: Record<string, AgentRun> = {};
      for (const r of ev.runs) runs[r.id] = r;
      const director: DirectorItem[] = ev.director.map((m: DirectorMessage) => ({
        id: m.id,
        kind: m.role,
        text: m.content,
        attachments: m.attachments,
        at: m.createdAt,
      }));
      // Only adopt settings when the frame actually carries them. A server mid-deploy (version skew)
      // omits the field; mergeSettings(undefined) would hand back all-defaults and snap the toggles back
      // on every heartbeat — keep the live values until a frame that truly has settings arrives.
      useStore.setState({ threads, runs, findings: ev.findings, questions: ev.questions, director, accounts: ev.accounts, codexUsage: ev.codexUsage ?? null, grokUsage: ev.grokUsage ?? null, approvalMode: ev.approvalMode, ...(ev.settings ? { settings: mergeSettings(ev.settings) } : {}), ...(ev.chat ? { chat: ev.chat } : {}), ...(ev.chatRooms ? { chatRooms: ev.chatRooms } : {}), ...(ev.nameOverrides ? { nameOverrides: ev.nameOverrides } : {}), ...(ev.schedules ? { schedules: ev.schedules } : {}) });
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
      if (selected) sendCommand({ type: "thread.history", threadId: selected });
      break;
    }
    case "grok.usage":
      useStore.setState({ grokUsage: ev.usage });
      break;
    case "codex.usage":
      useStore.setState({ codexUsage: ev.usage });
      break;
    case "accounts":
      useStore.setState({ accounts: ev.accounts });
      break;
    case "schedules":
      useStore.setState({ schedules: ev.schedules });
      break;
    case "chat.message":
      useStore.setState((s) => {
        const chat = [...s.chat, ev.message];
        const capped = chat.length > CHAT_CAP ? chat.slice(chat.length - CHAT_CAP) : chat;
        // Append to a room's loaded history too, so a live message shows without a re-fetch. Trim the
        // oldest to bound a chatty room — but NOT the room the panel is currently showing: the user may
        // have scrolled up and paginated older pages in, and clipping the top would both drop that loaded
        // history and shove the load-more cursor (roomHistory[room][0]) forward, re-fetching what was
        // clipped. A background room isn't being scrolled, so capping it is safe (re-open refetches).
        const room = ev.message.room;
        const hist = s.roomHistory[room];
        const grown = hist ? [...hist, ev.message] : undefined;
        const trimmable = room !== s.officeRoom && grown && grown.length > ROOM_CAP;
        const roomHistory = grown
          ? { ...s.roomHistory, [room]: trimmable ? grown.slice(grown.length - ROOM_CAP) : grown }
          : s.roomHistory;
        return { chat: capped, chatRooms: upsertRoom(s.chatRooms, ev.message), roomHistory };
      });
      break;
    case "chat.name":
      useStore.setState((s) => ({ nameOverrides: { ...s.nameOverrides, [agentKey(ev.threadId, ev.role)]: ev.name } }));
      break;
    case "chat.history":
      // Merge by id rather than replace: a live chat.message for this room can land between the
      // chat.history request and its reply, and a blind replace would drop it until the next message.
      // This same merge serves both the initial newest page and each older scroll-up page.
      useStore.setState((s) => {
        const ids = new Set(ev.messages.map((m) => m.id));
        const extra = (s.roomHistory[ev.room] ?? []).filter((m) => !ids.has(m.id));
        const merged = [...ev.messages, ...extra].sort((a, b) => a.createdAt - b.createdAt);
        return {
          roomHistory: { ...s.roomHistory, [ev.room]: merged },
          roomHasMore: { ...s.roomHasMore, [ev.room]: ev.hasMore },
          roomLoading: { ...s.roomLoading, [ev.room]: false },
        };
      });
      break;
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
          threadDrafts: drop(s.threadDrafts),
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
          threadDrafts: drop(s.threadDrafts),
          pendingPlans: drop(s.pendingPlans),
          threadChanges: drop(s.threadChanges),
          gitSummaries: drop(s.gitSummaries),
          gitStatus: drop(s.gitStatus),
          gitDiffs: drop(s.gitDiffs),
        };
      });
      // If this task is open, re-pull its (now-empty) history so the director-brief row that anchors
      // the feed reappears immediately — the fresh pipeline's live events then stream in beneath it.
      if (useStore.getState().selectedThreadId === ev.threadId) sendCommand({ type: "thread.history", threadId: ev.threadId });
      break;
    case "thread.history":
      // Merge the authoritative DB history with whatever streamed live, keyed by stable id —
      // NOT all-or-nothing. The old guard dropped the full history whenever live events had
      // already populated the feed (the ~20-message / reconnect bug). The DB row wins on a
      // collision; live-only artifacts (in-flight tool_results, system notes) are preserved.
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

        const merged = capFeed([...dbItems, ...liveOnly].sort((a, b) => a.at - b.at));
        return { threadFeeds: { ...s.threadFeeds, [ev.threadId]: merged } };
      });
      break;
    case "thread.message": {
      // A server-originated thread message (e.g. a director inject) — show it in the feed live.
      // messageToFeed + the id-keyed dedup in pushFeed keep it from doubling on a later history merge.
      const fi = messageToFeed(ev.message);
      if (fi) pushFeed(ev.threadId, fi);
      break;
    }
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
      useStore.setState((s) => ({
        director: [
          ...s.director,
          {
            id: ev.message.id,
            kind: ev.message.role,
            text: ev.message.content,
            attachments: ev.message.attachments,
            at: ev.message.createdAt,
          },
        ],
        directorDraft: ev.message.role === "director" ? "" : s.directorDraft,
      }));
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
    case "director.results":
      useStore.setState((s) => {
        // Drop a reply for a query the operator has since retyped or cleared.
        if (!s.directorSearch || s.directorSearch.query !== ev.query) return {};
        return { directorSearch: { query: ev.query, results: ev.messages, searching: false } };
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
    heartbeat = setInterval(() => sendCommand({ type: "snapshot.request" }), HEARTBEAT_MS);
    watchdog = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN && Date.now() - lastRecvAt > STALE_MS) ws.close();
    }, WATCHDOG_MS);
  };
  ws.onclose = (e) => {
    clearTimers();
    useStore.setState({ connected: false });
    if (e.code === 4401) {
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
