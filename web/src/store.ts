import { create } from "zustand";
import { apiUrl, wsUrl } from "./lib/base.js";
import type {
  AccountDTO,
  AgentRun,
  ChatMessage,
  ChatRoomSummary,
  ClientCommand,
  DirectorItem,
  DirectorMessage,
  FeedItem,
  Finding,
  ImageAttachment,
  Message,
  OrchestratorSettings,
  Question,
  Role,
  ServerEvent,
  SettingsPatch,
  Thread,
} from "./types.js";
import { GENERAL_ROOM } from "./types.js";
import { notify } from "./lib/notify.js";

interface ThreadDraft {
  runId: string;
  role: Role;
  text: string;
}

interface State {
  connected: boolean;
  authed: boolean;
  authRequired: boolean;
  authGoogle: boolean;
  authPassword: boolean;
  authError: string | null;
  accounts: AccountDTO[];
  threads: Record<string, Thread>;
  runs: Record<string, AgentRun>;
  findings: Finding[];
  questions: Question[];
  director: DirectorItem[];
  directorDraft: string;
  directorBusy: boolean;
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
  pendingPlans: Record<string, string>;
  threadChanges: Record<string, { diff: string; log: string }>;
  railHidden: boolean;
  detailWidth: number;
  directorWidth: number;
  // The office: recent chat across all rooms (live feed), the project-room roll-up (drives the
  // per-task Chatroom button), and full per-room history fetched on demand for the expanded view.
  chat: ChatMessage[];
  chatRooms: ChatRoomSummary[];
  roomHistory: Record<string, ChatMessage[]>;
  // Picked office names (threadId → name); the default for an unlisted task is gnomeName(threadId).
  nameOverrides: Record<string, string>;
  // Office panel UI: which room is open (room key) — null = closed. The strip, the task buttons, and
  // the card chips all drive this so one panel serves every entry point.
  officeRoom: string | null;

  select: (id: string | null) => void;
  sendPrompt: (text: string, workspace?: string, images?: ImageAttachment[]) => void;
  sendDirect: (text: string, workspace?: string, images?: ImageAttachment[]) => void;
  answer: (questionId: string, answer: string) => void;
  inject: (threadId: string, message: string, mode: "append" | "interrupt", images?: ImageAttachment[]) => void;
  interrupt: (threadId: string) => void;
  resume: (threadId: string, message?: string) => void;
  cancel: (threadId: string) => void;
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
  approve: (threadId: string, approved: boolean, feedback?: string) => void;
  loadChanges: (threadId: string) => void;
  toggleRail: () => void;
  setDetailWidth: (px: number) => void;
  setDirectorWidth: (px: number) => void;
  // Open the office panel on a room (defaults to the general room); fetches that room's full history.
  openOffice: (room?: string) => void;
  closeOffice: () => void;
  // Post into a room as the director (the human) — reaches the live agents there so they self-coordinate.
  postChat: (room: string, body: string) => void;
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

// Client-only view settings live together under one stable localStorage key (per the brief), separate
// from the server-authoritative pipeline settings. Defaults: keep finished tasks visible, full output.
const VIEW_SETTINGS_KEY = "director_settings";
interface ViewSettings {
  showCompleted: boolean;
  verbosity: Verbosity;
}
const VIEW_DEFAULTS: ViewSettings = { showCompleted: true, verbosity: "full" };
const loadViewSettings = (): ViewSettings => {
  try {
    const raw = localStorage.getItem(VIEW_SETTINGS_KEY);
    if (!raw) return VIEW_DEFAULTS;
    const v = JSON.parse(raw) as Partial<ViewSettings>;
    return {
      showCompleted: typeof v.showCompleted === "boolean" ? v.showCompleted : VIEW_DEFAULTS.showCompleted,
      verbosity: v.verbosity === "compact" || v.verbosity === "full" ? v.verbosity : VIEW_DEFAULTS.verbosity,
    };
  } catch {
    return VIEW_DEFAULTS;
  }
};
const saveViewSettings = (v: ViewSettings): void => lsSet(VIEW_SETTINGS_KEY, JSON.stringify(v));

// Until the first `hello` arrives the panel shows these neutral defaults (everything on); the server's
// real values overwrite them the instant the socket connects.
const DEFAULT_SETTINGS: OrchestratorSettings = {
  plannerEnabled: true,
  researcherEnabled: true,
  qaEnabled: true,
  autoPush: true,
  maxQaRounds: 4,
  maxConcurrent: 3,
  codexEnabled: false,
  codexModel: "gpt-5.5",
  hasOpenaiKey: false,
  openaiKeyLast4: null,
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

function sendCommand(cmd: ClientCommand): void {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(cmd));
}

export const useStore = create<State>((set) => ({
  connected: false,
  authed: false,
  authRequired: false,
  authGoogle: false,
  authPassword: false,
  authError: null,
  accounts: [],
  threads: {},
  runs: {},
  findings: [],
  questions: [],
  director: [],
  directorDraft: "",
  directorBusy: false,
  threadFeeds: {},
  threadDrafts: {},
  selectedThreadId: null,
  approvalMode: false,
  settings: DEFAULT_SETTINGS,
  codexTest: null,
  codexTesting: false,
  showCompleted: loadViewSettings().showCompleted,
  verbosity: loadViewSettings().verbosity,
  pendingPlans: {},
  threadChanges: {},
  railHidden: lsBool("orch-rail-hidden", false),
  detailWidth: lsNum("orch-detail-w", 480),
  directorWidth: lsNum("orch-rail-w", 384),
  chat: [],
  chatRooms: [],
  roomHistory: {},
  nameOverrides: {},
  officeRoom: null,

  select: (id) => {
    set({ selectedThreadId: id });
    if (id) sendCommand({ type: "thread.history", threadId: id });
  },
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
      saveViewSettings({ showCompleted: v, verbosity: s.verbosity });
      return { showCompleted: v };
    }),
  setVerbosity: (v) =>
    set((s) => {
      saveViewSettings({ showCompleted: s.showCompleted, verbosity: v });
      return { verbosity: v };
    }),
  approve: (threadId, approved, feedback) => sendCommand({ type: "thread.approve", threadId, approved, feedback }),
  loadChanges: (threadId) => sendCommand({ type: "thread.changes", threadId }),
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
    set({ officeRoom: r });
    sendCommand({ type: "chat.history", room: r }); // pull the room's full history for the expanded view
  },
  closeOffice: () => set({ officeRoom: null }),
  postChat: (room, body) => {
    const text = body.trim();
    if (text) sendCommand({ type: "chat.post", room, body: text });
  },
}));

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
      useStore.setState({ threads, runs, findings: ev.findings, questions: ev.questions, director, accounts: ev.accounts, approvalMode: ev.approvalMode, ...(ev.settings ? { settings: mergeSettings(ev.settings) } : {}), ...(ev.chat ? { chat: ev.chat } : {}), ...(ev.chatRooms ? { chatRooms: ev.chatRooms } : {}), ...(ev.nameOverrides ? { nameOverrides: ev.nameOverrides } : {}) });
      // If the office panel is open, re-pull the open room so it reflects anything that streamed
      // while the socket was gone (mirrors the thread.history re-fetch above).
      const openRoom = useStore.getState().officeRoom;
      if (openRoom) sendCommand({ type: "chat.history", room: openRoom });
      // hello also fires on WS reconnect (server restart / network blip). The feed kept its
      // pre-disconnect items but missed anything that streamed while we were gone — re-fetch
      // the open thread's history; the id-keyed merge fills the gap without dropping live items.
      const selected = useStore.getState().selectedThreadId;
      if (selected) sendCommand({ type: "thread.history", threadId: selected });
      break;
    }
    case "accounts":
      useStore.setState({ accounts: ev.accounts });
      break;
    case "chat.message":
      useStore.setState((s) => {
        const chat = [...s.chat, ev.message];
        const capped = chat.length > CHAT_CAP ? chat.slice(chat.length - CHAT_CAP) : chat;
        // Append to the open room's loaded history too, so a live message shows without a re-fetch.
        // Capped per-room so a long-open, chatty room can't grow this slice without bound.
        const hist = s.roomHistory[ev.message.room];
        const grown = hist ? [...hist, ev.message] : undefined;
        const roomHistory = grown
          ? { ...s.roomHistory, [ev.message.room]: grown.length > ROOM_CAP ? grown.slice(grown.length - ROOM_CAP) : grown }
          : s.roomHistory;
        return { chat: capped, chatRooms: upsertRoom(s.chatRooms, ev.message), roomHistory };
      });
      break;
    case "chat.name":
      useStore.setState((s) => ({ nameOverrides: { ...s.nameOverrides, [ev.threadId]: ev.name } }));
      break;
    case "chat.history":
      // Merge by id rather than replace: a live chat.message for this room can land between the
      // chat.history request and its reply, and a blind replace would drop it until the next message.
      useStore.setState((s) => {
        const ids = new Set(ev.messages.map((m) => m.id));
        const extra = (s.roomHistory[ev.room] ?? []).filter((m) => !ids.has(m.id));
        const merged = [...ev.messages, ...extra].sort((a, b) => a.createdAt - b.createdAt);
        return { roomHistory: { ...s.roomHistory, [ev.room]: merged } };
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
          runs,
          findings: s.findings.filter((f) => f.threadId !== ev.threadId),
          questions: s.questions.filter((q) => q.threadId !== ev.threadId),
          selectedThreadId: s.selectedThreadId === ev.threadId ? null : s.selectedThreadId,
        };
      });
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
