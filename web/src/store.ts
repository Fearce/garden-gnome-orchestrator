import { create } from "zustand";
import type {
  AccountDTO,
  AgentRun,
  ClientCommand,
  DirectorItem,
  DirectorMessage,
  FeedItem,
  Finding,
  ImageAttachment,
  Message,
  Question,
  Role,
  ServerEvent,
  Thread,
} from "./types.js";
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
  pendingPlans: Record<string, string>;
  threadChanges: Record<string, { diff: string; log: string }>;
  railHidden: boolean;
  detailWidth: number;
  directorWidth: number;

  select: (id: string | null) => void;
  sendPrompt: (text: string, workspace?: string, images?: ImageAttachment[]) => void;
  answer: (questionId: string, answer: string) => void;
  inject: (threadId: string, message: string, mode: "append" | "interrupt", images?: ImageAttachment[]) => void;
  interrupt: (threadId: string) => void;
  resume: (threadId: string, message?: string) => void;
  cancel: (threadId: string) => void;
  dismiss: (threadId: string) => void;
  setApproval: (on: boolean) => void;
  approve: (threadId: string, approved: boolean, feedback?: string) => void;
  loadChanges: (threadId: string) => void;
  toggleRail: () => void;
  setDetailWidth: (px: number) => void;
  setDirectorWidth: (px: number) => void;
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

// Cap each agent RUN's feed items INDEPENDENTLY (not one global cap) so a chatty
// implementor/QA run can't evict the finished planner/researcher output you want to
// scroll back and read. A bounded run (planner ~tens of items) is never trimmed.
// FEED_HARD_CAP is an absolute per-thread backstop for pathological many-run threads.
const PER_RUN_CAP = 800;
const FEED_HARD_CAP = 5000;

let socket: WebSocket | null = null;

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
  pendingPlans: {},
  threadChanges: {},
  railHidden: lsBool("orch-rail-hidden", false),
  detailWidth: lsNum("orch-detail-w", 480),
  directorWidth: lsNum("orch-rail-w", 384),

  select: (id) => {
    set({ selectedThreadId: id });
    if (id) sendCommand({ type: "thread.history", threadId: id });
  },
  sendPrompt: (text, workspace, images) =>
    sendCommand({ type: "prompt.new", text, workspace: workspace || undefined, images: images?.length ? images : undefined }),
  answer: (questionId, answer) => sendCommand({ type: "question.answer", questionId, answer }),
  inject: (threadId, message, mode, images) =>
    sendCommand({ type: "thread.inject", threadId, message, mode, images: images?.length ? images : undefined }),
  interrupt: (threadId) => sendCommand({ type: "thread.interrupt", threadId }),
  resume: (threadId, message) => sendCommand({ type: "thread.resume", threadId, message }),
  cancel: (threadId) => sendCommand({ type: "thread.cancel", threadId }),
  dismiss: (threadId) => sendCommand({ type: "thread.dismiss", threadId }),
  setApproval: (on) => sendCommand({ type: "approval.set", on }),
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
      useStore.setState({ threads, runs, findings: ev.findings, questions: ev.questions, director, accounts: ev.accounts, approvalMode: ev.approvalMode });
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
    case "plan.ready":
      useStore.setState((s) => ({ pendingPlans: { ...s.pendingPlans, [ev.threadId]: ev.brief } }));
      notify("Plan ready for approval", "Review and approve to start building.");
      break;
    case "approval.mode":
      useStore.setState({ approvalMode: ev.on });
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
    case "thread.removed":
      // The server permanently deleted this task. Prune every id-keyed slice so no view holds a
      // dangling reference, and clear the selection if the open task is the one that vanished.
      useStore.setState((s) => {
        const dropKey = <T,>(rec: Record<string, T>): Record<string, T> => {
          if (!(ev.threadId in rec)) return rec;
          const { [ev.threadId]: _gone, ...rest } = rec;
          return rest;
        };
        return {
          threads: dropKey(s.threads),
          threadFeeds: dropKey(s.threadFeeds),
          threadDrafts: dropKey(s.threadDrafts),
          pendingPlans: dropKey(s.pendingPlans),
          threadChanges: dropKey(s.threadChanges),
          runs: Object.fromEntries(Object.entries(s.runs).filter(([, r]) => r.threadId !== ev.threadId)),
          findings: s.findings.filter((f) => f.threadId !== ev.threadId),
          questions: s.questions.filter((q) => q.threadId !== ev.threadId),
          selectedThreadId: s.selectedThreadId === ev.threadId ? null : s.selectedThreadId,
        };
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
  if (m.role === "user") return { kind: "system", at: m.createdAt, id: m.id, text: m.content };
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
      return { kind: "system", at: m.createdAt, id: m.id, text: m.content };
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
    const r = await fetch("/api/me");
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
    const r = await fetch("/api/login", {
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
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const url = `${proto}://${location.host}/ws`;
  const ws = new WebSocket(url);
  socket = ws;
  ws.onopen = () => useStore.setState({ connected: true });
  ws.onclose = (e) => {
    useStore.setState({ connected: false });
    if (e.code === 4401) {
      useStore.setState({ authRequired: true, authed: false });
      return; // auth lost — show login instead of reconnect-looping
    }
    setTimeout(connect, 1200);
  };
  ws.onmessage = (e) => {
    try {
      applyEvent(JSON.parse(e.data) as ServerEvent);
    } catch {
      /* ignore malformed */
    }
  };
}
