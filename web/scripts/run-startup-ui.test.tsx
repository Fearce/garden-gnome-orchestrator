/**
 * A launched run is visible before it says anything.
 *
 * Reported: "I just interrupt -> pin model -> resume for a couple of tasks. But they've just been dead
 * silent for 5 minutes now, not sure they actually started on this new model". Both had: runs 40f6fd63 and
 * c091e95d existed on claude-opus-5-5 within 40s of the pin, but a Claude CLI start on the busy box took
 * ~3 minutes to even reach its SessionStart hooks, and the feed showed nothing until the first tool call
 * 4.5–5 minutes later. The run row already knew the model; the panel just never said so.
 *
 * This gate renders the real detail panel over a seeded store and checks the three states a new run
 * passes through: launching, session up but silent, and speaking.
 */
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentRun, FeedItem, Thread } from "../src/types.js";
// ThreadDetail's graph reaches a component stylesheet plain Node cannot load. Must precede the
// dynamic component import below — see ssrCssStub.mjs.
import "./ssrCssStub.mjs";
import { silentLiveRun } from "../src/lib/runStartup.js";

Object.assign(globalThis, {
  React,
  document: { baseURI: "http://localhost/", visibilityState: "visible", addEventListener: () => {}, removeEventListener: () => {} },
});
const { useStore } = await import("../src/store.js");
const { ThreadDetail } = await import("../src/components/ThreadDetail.js");

const at = 1_780_000_000_000;
const THREAD = "thread-repinned";

const run = (over: Partial<AgentRun> & Pick<AgentRun, "id" | "model" | "startedAt">): AgentRun => ({
  threadId: THREAD,
  role: "implementor",
  account: "personal",
  effort: null,
  state: "done",
  endedAt: over.startedAt + 60_000,
  ...over,
});

// The reported shape: a Sonnet run interrupted by the pin, then the Opus run the pin launched.
const sonnetRun = run({ id: "run-sonnet", model: "claude-sonnet-5", effort: "medium", startedAt: at, state: "interrupted" });
const opusRun = run({ id: "run-opus", model: "claude-opus-5-5", effort: "high", startedAt: at + 120_000, endedAt: null, state: "starting" });

const priorFeed: FeedItem[] = [
  { kind: "text", at: at + 1_000, role: "implementor", runId: sonnetRun.id, id: "m-sonnet", text: "Checking the build-probe log." },
  { kind: "system", at: at + 119_000, id: "m-pin", text: "◆ Task implementor pinned to Claude · claude-opus-5-5." },
];

const thread: Thread = {
  ...(useStore.getInitialState().threads["seed"] ?? {}),
  id: THREAD,
  title: "Complete Spirit Sword implementation",
  brief: "",
  rawPrompt: "",
  workspace: "fixture-workspace/repinned",
  state: "implementing",
  createdAt: at - 1_000,
  updatedAt: at + 120_000,
} as Thread;

function render(opus: AgentRun, feed: FeedItem[], extra: Record<string, unknown> = {}): string {
  const state = useStore.getInitialState();
  Object.assign(state, {
    selectedThreadId: THREAD,
    threads: { [THREAD]: thread },
    runs: { [sonnetRun.id]: sonnetRun, [opus.id]: opus },
    threadFeeds: { [THREAD]: feed },
    threadHistoryLoaded: { [THREAD]: true },
    threadDrafts: {},
    thinkingDrafts: {},
    outboundMessages: [],
    // The startup row must name the model even with the per-row model labels switched off: which
    // model started is the whole question it answers.
    settings: { ...state.settings, showAgentModel: false },
    ...extra,
  });
  return renderToStaticMarkup(React.createElement(ThreadDetail));
}

const startupRow = (html: string): string | undefined => {
  const start = html.indexOf('class="fi system run-startup"');
  if (start < 0) return undefined;
  return html.slice(start, html.indexOf("</div></div>", start));
};

console.log("A. a launched run that has not spoken names its model");
const launching = startupRow(render(opusRun, priorFeed));
assert.ok(launching, "a starting run with no output must render a startup row — the reported dead silence");
assert.match(launching, /Opus 5\.5 High/, "the row names the model the run was launched on");
assert.match(launching, /[Ss]tarting/, "a run still in `starting` says it is starting");
assert.doesNotMatch(launching, /Sonnet/, "the interrupted run's model must not leak into the new run's row");

console.log("B. a session that is up but still silent says so");
const firstTurn = startupRow(render({ ...opusRun, state: "running" }, priorFeed));
assert.ok(firstTurn, "a running run with no output still has nothing else in the feed to show");
assert.match(firstTurn, /Opus 5\.5 High/);
assert.match(firstTurn, /first output/, "once the CLI is up the row says it is waiting for the model's first output");

console.log("C. the row gives way to the run's own output");
const spoke = [...priorFeed, { kind: "tool", at: at + 300_000, role: "implementor", runId: opusRun.id, id: "m-opus", name: "Bash", input: { command: "git status" } } as FeedItem];
assert.equal(startupRow(render({ ...opusRun, state: "running" }, spoke)), undefined, "the first feed item from the run retires the startup row");
const streaming = render({ ...opusRun, state: "running" }, priorFeed, {
  threadDrafts: { [THREAD]: { runId: opusRun.id, role: "implementor", text: "Looking at the lane B logs" } },
});
assert.equal(startupRow(streaming), undefined, "a streaming draft is output too — no startup row beside it");

console.log("D. nothing live, nothing claimed");
assert.equal(startupRow(render({ ...opusRun, state: "done", endedAt: at + 200_000 }, priorFeed)), undefined, "a finished run is not starting");
assert.equal(silentLiveRun([sonnetRun], priorFeed, new Set()), undefined, "an interrupted run is not starting either");

assert.equal(
  startupRow(render(opusRun, [], { threadHistoryLoaded: {} })),
  undefined,
  "before the task's history has loaded an empty feed proves nothing — the run may already have spoken",
);

console.log("E. the newest live run is the one reported");
const qaRun = run({ id: "run-qa", role: "qa", model: "claude-sonnet-5", effort: "medium", startedAt: at + 400_000, endedAt: null, state: "starting" });
assert.equal(silentLiveRun([{ ...opusRun, state: "running" }, qaRun], [...priorFeed], new Set())?.run.id, qaRun.id, "a QA pass launched after the implementor is the one currently silent");
assert.equal(silentLiveRun([opusRun], priorFeed, new Set())?.phase, "launching");
assert.equal(silentLiveRun([{ ...opusRun, state: "running" }], priorFeed, new Set())?.phase, "first-turn");

console.log("\nRun startup checks passed.");
