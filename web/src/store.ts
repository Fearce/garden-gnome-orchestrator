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
  authMode: string;
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
  logs: { level: string; message: string; at: number }[];
  approvalMode: boolean;
  pendingPlans: Record<string, string>;
  threadChanges: Record<string, { diff: string; log: string }>;

  select: (id: string | null) => void;
  sendPrompt: (text: string, workspace?: string, images?: ImageAttachment[]) => void;
  answer: (questionId: string, answer: string) => void;
  inject: (threadId: string, message: string, mode: "append" | "interrupt", images?: ImageAttachment[]) => void;
  interrupt: (threadId: string) => void;
  resume: (threadId: string, message?: string) => void;
  cancel: (threadId: string) => void;
  setApproval: (on: boolean) => void;
  approve: (threadId: string, approved: boolean, feedback?: string) => void;
  loadChanges: (threadId: string) => void;
}

const FEED_CAP = 500;

let socket: WebSocket | null = null;

function sendCommand(cmd: ClientCommand): void {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(cmd));
}

export const useStore = create<State>((set) => ({
  connected: false,
  authed: false,
  authRequired: false,
  authMode: "none",
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
  logs: [],
  approvalMode: false,
  pendingPlans: {},
  threadChanges: {},

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
  setApproval: (on) => sendCommand({ type: "approval.set", on }),
  approve: (threadId, approved, feedback) => sendCommand({ type: "thread.approve", threadId, approved, feedback }),
  loadChanges: (threadId) => sendCommand({ type: "thread.changes", threadId }),
}));

function pushFeed(threadId: string, item: FeedItem): void {
  useStore.setState((s) => {
    const prev = s.threadFeeds[threadId] ?? [];
    const next = prev.length >= FEED_CAP ? [...prev.slice(prev.length - FEED_CAP + 1), item] : [...prev, item];
    return { threadFeeds: { ...s.threadFeeds, [threadId]: next } };
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
      useStore.setState((s) => {
        if ((s.threadFeeds[ev.threadId]?.length ?? 0) > 0) return {};
        const items: FeedItem[] = [];
        for (const m of ev.messages) {
          const fi = messageToFeed(m);
          if (fi) items.push(fi);
        }
        for (const f of ev.findings) items.push({ kind: "finding", at: f.createdAt, finding: f });
        items.sort((a, b) => a.at - b.at);
        return { threadFeeds: { ...s.threadFeeds, [ev.threadId]: items } };
      });
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
      pushFeed(ev.threadId, { kind: "text", at: Date.now(), role: ev.role, runId: ev.runId, text: ev.text });
      break;
    case "agent.tool":
      pushFeed(ev.threadId, { kind: "tool", at: Date.now(), role: ev.role, runId: ev.runId, name: ev.name, input: ev.input });
      break;
    case "agent.tool_result":
      pushFeed(ev.threadId, { kind: "tool_result", at: Date.now(), runId: ev.runId, id: ev.id, isError: ev.isError, preview: ev.preview });
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
    case "log":
      useStore.setState((s) => ({ logs: [...s.logs.slice(-200), { level: ev.level, message: ev.message, at: Date.now() }] }));
      break;
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
  if (m.role === "user") return { kind: "system", at: m.createdAt, text: m.content };
  const role = m.role as Role;
  switch (m.kind) {
    case "text":
      return { kind: "text", at: m.createdAt, role, runId: m.runId ?? "", text: m.content };
    case "tool":
      return { kind: "tool", at: m.createdAt, role, runId: m.runId ?? "", name: m.content, input: undefined };
    case "system":
      return { kind: "system", at: m.createdAt, text: m.content };
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
    const j = (await r.json()) as { authed?: boolean; required?: boolean; mode?: string };
    if (j.required && !j.authed) {
      const err = new URLSearchParams(location.search).get("e");
      if (err) history.replaceState(null, "", location.pathname); // consume once — don't wedge the login screen
      if (j.mode === "google" && !err) {
        location.href = "/api/auth/google"; // skip-if-signed-in: instant when a Google session + consent exist
        return;
      }
      useStore.setState({ authRequired: true, authed: false, authMode: j.mode ?? "token", authError: err });
      return;
    }
    useStore.setState({ authRequired: false, authed: true, authMode: j.mode ?? "none" });
  } catch {
    /* server unreachable (dev) — try to connect anyway */
  }
  connect();
}

export async function login(token: string): Promise<boolean> {
  try {
    const r = await fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (!r.ok) return false;
    await init();
    return true;
  } catch {
    return false;
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
      if (useStore.getState().authMode === "google") {
        location.href = "/api/auth/google";
        return;
      }
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
