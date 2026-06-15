import { create } from "zustand";
import type {
  AccountDTO,
  AgentRun,
  ClientCommand,
  DirectorItem,
  DirectorMessage,
  FeedItem,
  Finding,
  Message,
  Question,
  Role,
  ServerEvent,
  Thread,
} from "./types.js";

interface ThreadDraft {
  runId: string;
  role: Role;
  text: string;
}

interface State {
  connected: boolean;
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

  select: (id: string | null) => void;
  sendPrompt: (text: string, workspace?: string) => void;
  answer: (questionId: string, answer: string) => void;
  inject: (threadId: string, message: string, mode: "append" | "interrupt") => void;
  interrupt: (threadId: string) => void;
  resume: (threadId: string, message?: string) => void;
  cancel: (threadId: string) => void;
}

const FEED_CAP = 500;

let socket: WebSocket | null = null;

function sendCommand(cmd: ClientCommand): void {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(cmd));
}

export const useStore = create<State>((set) => ({
  connected: false,
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

  select: (id) => {
    set({ selectedThreadId: id });
    if (id) sendCommand({ type: "thread.history", threadId: id });
  },
  sendPrompt: (text, workspace) => sendCommand({ type: "prompt.new", text, workspace: workspace || undefined }),
  answer: (questionId, answer) => sendCommand({ type: "question.answer", questionId, answer }),
  inject: (threadId, message, mode) => sendCommand({ type: "thread.inject", threadId, message, mode }),
  interrupt: (threadId) => sendCommand({ type: "thread.interrupt", threadId }),
  resume: (threadId, message) => sendCommand({ type: "thread.resume", threadId, message }),
  cancel: (threadId) => sendCommand({ type: "thread.cancel", threadId }),
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
        at: m.createdAt,
      }));
      useStore.setState({ threads, runs, findings: ev.findings, questions: ev.questions, director, accounts: ev.accounts });
      break;
    }
    case "accounts":
      useStore.setState({ accounts: ev.accounts });
      break;
    case "thread.upsert":
      useStore.setState((s) => ({ threads: { ...s.threads, [ev.thread.id]: ev.thread } }));
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
      break;
    case "question.resolved":
      useStore.setState((s) => ({ questions: s.questions.filter((q) => q.id !== ev.questionId) }));
      break;
    case "director.delta":
      useStore.setState((s) => ({ directorDraft: s.directorDraft + ev.text }));
      break;
    case "director.message":
      useStore.setState((s) => ({
        director: [...s.director, { id: ev.message.id, kind: ev.message.role, text: ev.message.content, at: ev.message.createdAt }],
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

export function connect(): void {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const url = `${proto}://${location.host}/ws`;
  const ws = new WebSocket(url);
  socket = ws;
  ws.onopen = () => useStore.setState({ connected: true });
  ws.onclose = () => {
    useStore.setState({ connected: false });
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
