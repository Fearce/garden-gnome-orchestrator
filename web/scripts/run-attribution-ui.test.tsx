/**
 * Which model wrote a line is a claim about the RUN, not about the role.
 *
 * A task routinely changes model mid-work — usage saving, a cap failover, an auto-resume onto another
 * subscription — and each launch is its own `agent_runs` row whose `model` is written once and never
 * rewritten. The feed used to label every row from the role's LATEST run, so the moment a task moved to
 * a cheaper model its whole history re-labelled to that model: reported as "that's falsifying data",
 * against a real task (6bf166a5) where the circled message's run was claude-opus-5 and the console said
 * Sonnet 5 Medium.
 *
 * This gate renders the real detail panel over a seeded store, so it covers the join as well as the
 * pieces: a run index that survives a bounded reconnect snapshot, and rows that resolve their own run.
 */
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentRun, FeedItem, Thread } from "../src/types.js";
// ThreadDetail's graph reaches a component stylesheet plain Node cannot load. Must precede the
// dynamic component import below — see ssrCssStub.mjs.
import "./ssrCssStub.mjs";
import { mergeRunIndex, pruneRunIndex, roleModelSummary, runModelLabel } from "../src/lib/runAttribution.js";

// Standalone tsx gates may compile imported JSX with the classic runtime even though Vite uses the
// automatic one. Match the sibling UI gates and make React explicit before importing the component.
Object.assign(globalThis, {
  React,
  document: { baseURI: "http://localhost/", visibilityState: "visible", addEventListener: () => {}, removeEventListener: () => {} },
});
const { useStore } = await import("../src/store.js");
const { ThreadDetail } = await import("../src/components/ThreadDetail.js");

const at = 1_780_000_000_000;
const THREAD = "thread-mixed-models";

const run = (over: Partial<AgentRun> & Pick<AgentRun, "id" | "model" | "startedAt">): AgentRun => ({
  threadId: THREAD,
  role: "implementor",
  account: "personal",
  effort: null,
  state: "done",
  endedAt: over.startedAt + 60_000,
  ...over,
});

// The shape that produced the report: an Opus stretch, then a Sonnet one, on one role.
const opusRun = run({ id: "run-opus", model: "claude-opus-5", effort: "high", startedAt: at });
const sonnetRun = run({ id: "run-sonnet", model: "claude-sonnet-5", effort: "medium", startedAt: at + 600_000, endedAt: null, state: "running" });

const feed: FeedItem[] = [
  { kind: "text", at: at + 1_000, role: "implementor", runId: opusRun.id, id: "m-opus", text: "ACK: You're right — I over-ran." },
  { kind: "text", at: at + 601_000, role: "implementor", runId: sonnetRun.id, id: "m-sonnet", text: "ACK: answering the real question now." },
  { kind: "text", at: at + 602_000, role: "implementor", runId: "run-never-loaded", id: "m-orphan", text: "A line whose run the console does not hold." },
];

const thread: Thread = {
  ...(useStore.getInitialState().threads["seed"] ?? {}),
  id: THREAD,
  title: "Investigate agents running long",
  brief: "",
  rawPrompt: "",
  workspace: "C:/repo",
  state: "implementing",
  createdAt: at - 1_000,
  updatedAt: at + 602_000,
} as Thread;

function render(): string {
  const state = useStore.getInitialState();
  Object.assign(state, {
    selectedThreadId: THREAD,
    threads: { [THREAD]: thread },
    runs: { [opusRun.id]: opusRun, [sonnetRun.id]: sonnetRun },
    threadFeeds: { [THREAD]: feed },
    outboundMessages: [],
    settings: { ...state.settings, showAgentModel: true },
  });
  return renderToStaticMarkup(React.createElement(ThreadDetail));
}

console.log("A. the feed attributes each row to the run that wrote it");
const html = render();
const rowFor = (text: string): string => {
  const end = html.indexOf(text);
  assert.ok(end > 0, `expected the feed to render: ${text}`);
  const start = html.lastIndexOf('<div class="fi text"', end);
  assert.ok(start >= 0, `expected a feed row around: ${text}`);
  return html.slice(start, end);
};

assert.match(rowFor("I over-ran"), /Opus 5 High/, "the Opus run's message must say Opus — the reported falsification");
assert.doesNotMatch(rowFor("I over-ran"), /Sonnet/, "a later Sonnet run must not restamp an earlier Opus message");
assert.match(rowFor("answering the real question now"), /Sonnet 5 Medium/, "the Sonnet run's own message keeps its real model");
assert.doesNotMatch(
  rowFor("run the console does not hold"),
  /role-model/,
  "an unresolvable run yields NO model — an unlabelled row is honest, a borrowed label is not",
);

console.log("B. the agent-filter chip covers a whole role, so it may not name one model");
assert.match(html, /Sonnet 5 Medium \+1/, "the chip names the current model and counts the others");
assert.match(html, /title="Ran on Sonnet 5 Medium, Opus 5 High"/, "the chip enumerates every model, newest first");

console.log("C. the setting still gates the label");
const off = ((): string => {
  const state = useStore.getInitialState();
  Object.assign(state, { settings: { ...state.settings, showAgentModel: false } });
  return renderToStaticMarkup(React.createElement(ThreadDetail));
})();
assert.doesNotMatch(off, /role-model/, "Show agent model off means no model anywhere in the panel");

console.log("D. the run index survives a bounded reconnect snapshot");
const held = { [opusRun.id]: opusRun, [sonnetRun.id]: sonnetRun };
// hello carries the newest runs fleet-wide; an older task's runs are simply not in it.
const afterHello = pruneRunIndex(mergeRunIndex(held, [run({ id: "run-other", model: "claude-opus-5", startedAt: at + 900_000, threadId: "other" })]), new Set([THREAD, "other"]));
assert.equal(runModelLabel(afterHello, opusRun.id), "Opus 5 High", "a reconnect must not drop the runs an open task already resolved");
const afterPurge = pruneRunIndex(afterHello, new Set([THREAD]));
assert.equal(afterPurge["run-other"], undefined, "runs for a task the board no longer lists are dropped, so a long-lived tab stays bounded");
assert.equal(runModelLabel(afterPurge, sonnetRun.id), "Sonnet 5 Medium", "the open task's own runs survive that prune");

console.log("E. a late history reply cannot reopen a run that has since ended");
const endedLive = { ...sonnetRun, state: "done" as const, endedAt: at + 700_000 };
const raced = mergeRunIndex({ [sonnetRun.id]: endedLive }, [sonnetRun]);
assert.equal(raced[sonnetRun.id]?.endedAt, at + 700_000, "keep the copy that is further along, not the one that arrived last");

console.log("F. the chip degrades to a plain label on a single-model role");
assert.deepEqual(roleModelSummary([opusRun], "implementor"), { label: "Opus 5 High" }, "one model means one plain label, no counter");
assert.equal(roleModelSummary([], "implementor"), undefined, "a role with no runs claims no model");

console.log("\nRun attribution checks passed.");
