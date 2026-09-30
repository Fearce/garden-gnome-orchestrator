/**
 * The ⛏ tools toggle hides tool mechanics, never what an agent says.
 *
 * Reported with tools filtered out: a 💭 line from the implementor vanished — "I found two manual deploy
 * scripts in the repo… Before writing the workflow, I'll verify which host is currently serving
 * gnomerang.com." That line is narration. Opus 5.5 writes its progress updates inside thinking blocks,
 * and the toggle hid every reasoning row, live draft and persisted alike, together with the tool calls.
 *
 * This gate classifies every feed kind, then drives the real store over a fake socket through both
 * paths a row reaches the panel by — replayed history and the live stream — for every role, and renders
 * the real detail panel with tools hidden and shown.
 */
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentRun, FeedItem, Message, Role, Thread } from "../src/types.js";
// ThreadDetail's graph reaches a component stylesheet plain Node cannot load. Must precede the
// dynamic component import below — see ssrCssStub.mjs.
import "./ssrCssStub.mjs";
import { isToolActivity } from "../src/lib/feedFilter.js";

const storage = new Map<string, string>();
Object.assign(globalThis, {
  React,
  document: { baseURI: "http://localhost/", visibilityState: "visible", addEventListener: () => {}, removeEventListener: () => {} },
  location: { protocol: "http:", host: "localhost", search: "", pathname: "/" },
  localStorage: {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
  },
});

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(): void {}
  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: 1000 });
  }
}
Object.defineProperty(globalThis, "WebSocket", { value: FakeWebSocket, configurable: true });

const { connect, useStore } = await import("../src/store.js");
const { ThreadDetail } = await import("../src/components/ThreadDetail.js");
connect();
const socket = FakeWebSocket.instances[0]!;
socket.readyState = FakeWebSocket.OPEN;
socket.onopen?.();
const deliver = (event: Record<string, unknown>): void => socket.onmessage?.({ data: JSON.stringify(event) });

const at = 1_795_000_000_000;
const THREAD = "tools-filter-task";
const ROLES: Role[] = ["planner", "researcher", "implementor", "qa", "reviewer", "reader"];
const NARRATION =
  "I found two manual deploy scripts in the repo—one for the old Sprogbroen edge and one for Leon's Hetzner server. Before writing the workflow, I'll verify which host is currently serving gnomerang.com.";

const runOf = (role: Role): AgentRun => ({
  id: `run-${role}`,
  threadId: THREAD,
  role,
  model: "claude-opus-5-5",
  account: "personal",
  effort: "high",
  state: "running",
  startedAt: at,
  endedAt: null,
});
const thread = {
  id: THREAD,
  title: "Deploy gnomerang.com from CI",
  brief: "",
  rawPrompt: "",
  workspace: "fixture-workspace/gnomerang",
  state: "implementing",
  createdAt: at - 1_000,
  updatedAt: at,
} as Thread;

function render(showTools: boolean): string {
  storage.set("orch-show-tools", showTools ? "1" : "0");
  // SSR reads zustand's server snapshot, which is the initial state — mirror what the socket built.
  Object.assign(useStore.getInitialState(), useStore.getState());
  return renderToStaticMarkup(React.createElement(ThreadDetail));
}
const rendered = (html: string, text: string): boolean => html.includes(text);

console.log("A. only tool calls and their results count as tool activity");
const kinds: FeedItem[] = [
  { kind: "text", at, role: "implementor", runId: "r", text: "prose" },
  { kind: "thinking", at, role: "implementor", runId: "r", text: "narration" },
  { kind: "tool", at, role: "implementor", runId: "r", name: "Bash", input: { command: "ls" } },
  { kind: "tool_result", at, runId: "r", id: "t", isError: false, preview: "ok" },
  { kind: "system", at, text: "note" },
  {
    kind: "finding",
    at,
    finding: { id: "f", threadId: THREAD, fromRunId: "r", fromRole: "qa", kind: "note", summary: "s", detail: null, severity: "info", routed: false, createdAt: at },
  } as FeedItem,
];
assert.deepEqual(
  kinds.map((k) => [k.kind, isToolActivity(k)]),
  [
    ["text", false],
    ["thinking", false],
    ["tool", true],
    ["tool_result", true],
    ["system", false],
    ["finding", false],
  ],
);

useStore.setState({
  selectedThreadId: THREAD,
  threads: { [THREAD]: thread },
  runs: Object.fromEntries(ROLES.map((r) => [`run-${r}`, runOf(r)])),
  threadFeeds: {},
  threadDrafts: {},
  thinkingDrafts: {},
  outboundMessages: [],
});

console.log("B. replayed history: every role's narration survives the toggle, its tools do not");
const messages: Message[] = ROLES.flatMap((role, i): Message[] => [
  { id: `think-${role}`, threadId: THREAD, runId: `run-${role}`, role, kind: "thinking", content: `💬 ${role} narrates step ${i}`, createdAt: at + i * 10 + 1 },
  { id: `text-${role}`, threadId: THREAD, runId: `run-${role}`, role, kind: "text", content: `${role} reports in prose`, createdAt: at + i * 10 + 2 },
  { id: `tool-${role}`, threadId: THREAD, runId: `run-${role}`, role, kind: "tool", content: `ToolCallBy_${role}`, createdAt: at + i * 10 + 3 },
  { id: `result-${role}`, threadId: THREAD, runId: `run-${role}`, role, kind: "result", content: `ResultPreviewFor_${role}`, createdAt: at + i * 10 + 4 },
]);
messages.push({ id: "think-circled", threadId: THREAD, runId: "run-implementor", role: "implementor", kind: "thinking", content: NARRATION, createdAt: at + 100 });
messages.push({ id: "director-note", threadId: THREAD, runId: null, role: "director", kind: "system", content: "Director steering note", createdAt: at + 101 });
deliver({
  type: "thread.history",
  threadId: THREAD,
  messages,
  runs: ROLES.map(runOf),
  findings: [],
  implementationMemos: [],
  deliverableSummary: null,
  brief: "The owner's brief.",
  hasMoreMessages: false,
});

const hidden = render(false);
assert.ok(rendered(hidden, "verify which host is currently serving gnomerang.com"), "the reported narration stays visible with tools hidden");
for (const role of ROLES) {
  assert.ok(rendered(hidden, `${role} narrates step`), `${role} reasoning stays visible with tools hidden`);
  assert.ok(rendered(hidden, `${role} reports in prose`), `${role} prose stays visible with tools hidden`);
  assert.ok(!rendered(hidden, `ToolCallBy_${role}`), `${role} tool call is hidden`);
  assert.ok(!rendered(hidden, `ResultPreviewFor_${role}`), `${role} tool result is hidden`);
}
assert.ok(rendered(hidden, "Director steering note"), "director rows are untouched by the toggle");
assert.ok(!rendered(hidden, "tools &amp; reasoning hidden"), "the panel no longer claims reasoning is hidden");

const shown = render(true);
for (const role of ROLES) {
  assert.ok(rendered(shown, `ToolCallBy_${role}`) && rendered(shown, `ResultPreviewFor_${role}`), `${role} tools return when the toggle is on`);
  assert.ok(rendered(shown, `${role} narrates step`), `${role} reasoning shows with tools on too`);
}

console.log("C. the live stream: a reasoning draft and its committed row both survive the toggle");
for (const role of ROLES) {
  deliver({ type: "agent.thinking", threadId: THREAD, runId: `run-${role}`, role, text: `Live draft from ${role}` });
  const live = render(false);
  assert.ok(rendered(live, `Live draft from ${role}`), `${role}'s streaming reasoning draft stays visible with tools hidden`);
  deliver({ type: "agent.reasoning", threadId: THREAD, runId: `run-${role}`, role, text: `Committed reasoning from ${role}`, messageId: `live-think-${role}` });
  deliver({ type: "agent.tool", threadId: THREAD, runId: `run-${role}`, role, name: `LiveTool_${role}`, input: { command: "git status" }, id: `tu-${role}`, messageId: `live-tool-${role}` });
  deliver({ type: "agent.tool_result", threadId: THREAD, runId: `run-${role}`, id: `tu-${role}`, isError: false, preview: `LivePreview_${role}`, messageId: `live-result-${role}` });
  const committed = render(false);
  assert.ok(!rendered(committed, `Live draft from ${role}`), `${role}'s draft is replaced by the committed row`);
  assert.ok(rendered(committed, `Committed reasoning from ${role}`), `${role}'s committed reasoning stays visible with tools hidden`);
  assert.ok(!rendered(committed, `LiveTool_${role}`) && !rendered(committed, `LivePreview_${role}`), `${role}'s live tool call and result are hidden`);
}

console.log("D. a feed of nothing but tool activity says what is hidden");
useStore.setState({
  threadFeeds: {
    [THREAD]: [
      { kind: "tool", at, role: "implementor", runId: "run-implementor", id: "only-tool", name: "OnlyTool", input: {} },
      { kind: "tool_result", at: at + 1, runId: "run-implementor", id: "only-tu", isError: false, preview: "OnlyPreview" },
    ],
  },
  thinkingDrafts: {},
  // Finished runs, so no launching run claims the empty panel with its startup row.
  runs: Object.fromEntries(ROLES.map((r) => [`run-${r}`, { ...runOf(r), state: "done", endedAt: at + 500 }])),
});
const onlyTools = render(false);
assert.ok(!rendered(onlyTools, "OnlyTool") && !rendered(onlyTools, "OnlyPreview"));
assert.ok(rendered(onlyTools, "Nothing to show"), "an all-tools feed with tools hidden shows the empty state");

console.log("\nTools-filter narration checks passed.");
