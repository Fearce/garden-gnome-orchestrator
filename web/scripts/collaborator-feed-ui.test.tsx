/**
 * A shotgun task's collaborators must be visible in the lead's panel.
 *
 * A multi-agent task shows as ONE card. Each extra agent is a hidden child thread (`parentId`), so
 * the panel showed only the lead's own feed. Reported against a live 2-agent task (1a67d70b): "I
 * started this prompt with 2 agents but only see Lumi posting". The second agent (Tor) had been
 * working and talking for an hour.
 *
 * This gate renders the real detail panel over a seeded store: the collaborator's rows appear in the
 * lead's feed under the collaborator's own name, and its assignment brief does not pose as a director
 * message.
 */
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentRun, FeedItem, Thread } from "../src/types.js";
import "./ssrCssStub.mjs";
import { collaboratorIdsOf, historyFloor, mergeCollaboratorFeeds } from "../src/lib/collaboratorFeed.js";

Object.assign(globalThis, {
  React,
  document: { baseURI: "http://localhost/", visibilityState: "visible", addEventListener: () => {}, removeEventListener: () => {} },
});
const { useStore } = await import("../src/store.js");
const { ThreadDetail } = await import("../src/components/ThreadDetail.js");
const { agentName } = await import("../src/types.js");

const at = 1_790_000_000_000;
const LEAD = "lead-thread";
const KID = "kid-thread";

const baseThread = (over: Partial<Thread>): Thread =>
  ({
    brief: "",
    rawPrompt: "",
    workspace: "fixture-workspace/d2r",
    state: "implementing",
    createdAt: at,
    updatedAt: at + 5_000,
    ...over,
  }) as Thread;

const lead = baseThread({ id: LEAD, title: "Develop the bot", agentCount: 2 });
const kid = baseThread({
  id: KID,
  title: "Nightmare/Hell economy",
  parentId: LEAD,
  createdAt: at + 100,
  assignment: { title: "Nightmare/Hell economy", objective: "price potions", files: ["src/economy.cs"] },
});
const other = baseThread({ id: "unrelated", title: "Someone else's task", createdAt: at + 50 });

const run = (id: string, threadId: string, model: string): AgentRun => ({
  id,
  threadId,
  role: "implementor",
  model,
  account: "personal",
  effort: null,
  state: "running",
  startedAt: at,
  endedAt: null,
});

const leadFeed: FeedItem[] = [
  { kind: "system", at, id: "brief:" + LEAD, text: "The owner's original brief.", role: "director" },
  { kind: "text", at: at + 1_000, role: "implementor", runId: "run-lead", id: "m-lead", text: "Lead line about Act II quests." },
];
const kidFeed: FeedItem[] = [
  { kind: "system", at: at + 100, id: "brief:" + KID, text: "ASSIGNMENT BRIEF FOR THE COLLABORATOR", role: "director" },
  { kind: "text", at: at + 2_000, role: "implementor", runId: "run-kid", id: "m-kid", text: "Collaborator line about potion prices." },
  { kind: "system", at: at + 3_000, id: "sys-kid", text: "Route selected for the share" },
];

console.log("A. the pure merge");
const threads = { [LEAD]: lead, [KID]: kid, unrelated: other };
assert.deepEqual(collaboratorIdsOf(threads, LEAD), [KID], "only this lead's children count as collaborators");
assert.deepEqual(collaboratorIdsOf(threads, KID), [], "a collaborator has no collaborators of its own");
const merged = mergeCollaboratorFeeds(leadFeed, [{ threadId: KID, items: kidFeed }]);
assert.deepEqual(
  merged.items.map((f) => (f.kind === "system" || f.kind === "text" ? f.id : "")),
  ["brief:" + LEAD, "m-lead", "m-kid", "sys-kid"],
  "collaborator rows interleave by time, and its assignment brief is left out",
);
assert.equal(merged.sourceOf.get(merged.items[2]!), KID, "each collaborator row remembers which thread wrote it");
assert.equal(merged.sourceOf.get(merged.items[1]!), undefined, "the lead's own rows carry no source");
assert.equal(mergeCollaboratorFeeds(leadFeed, []).items, leadFeed, "an ordinary task keeps its feed untouched");

console.log("A2. the history floor: pages are message counts, not time spans");
const busy: FeedItem[] = [{ kind: "text", at: at + 9_000, role: "implementor", id: "busy-newest-page-start", text: "b" }];
const quiet: FeedItem[] = [{ kind: "text", at: at + 1_000, role: "implementor", id: "quiet-old", text: "q" }];
assert.equal(historyFloor([{ items: busy, hasMore: true }, { items: quiet, hasMore: false }]), at + 9_000, "the busy feed with older pages sets the floor");
assert.equal(historyFloor([{ items: busy, hasMore: false }, { items: quiet, hasMore: false }]), undefined, "fully loaded feeds need no floor");
const floored = mergeCollaboratorFeeds(busy, [{ threadId: KID, items: quiet }], at + 9_000);
assert.deepEqual(
  floored.items.map((f) => (f.kind === "text" ? f.id : "")),
  ["busy-newest-page-start"],
  "the quiet agent's older row waits below the floor, so it cannot pose as the only activity of that hour",
);

console.log("B. the rendered panel shows both agents by name");
const state = useStore.getInitialState();
Object.assign(state, {
  selectedThreadId: LEAD,
  threads,
  runs: { "run-lead": run("run-lead", LEAD, "claude-opus-5-5"), "run-kid": run("run-kid", KID, "gpt-6-sol") },
  threadFeeds: { [LEAD]: leadFeed, [KID]: kidFeed },
  threadDrafts: { [KID]: { runId: "run-kid", role: "implementor", text: "Tor is typing a live draft" } },
  outboundMessages: [],
});
const html = renderToStaticMarkup(React.createElement(ThreadDetail));
const leadName = agentName({}, LEAD, "implementor");
const kidName = agentName({}, KID, "implementor");
assert.notEqual(leadName, kidName, "fixture sanity: the two agents have different default names");

const rowFor = (text: string): string => {
  const end = html.indexOf(text);
  assert.ok(end > 0, `expected the lead's panel to render: ${text}`);
  const start = html.lastIndexOf('<div class="fi', end);
  return html.slice(start, end);
};
assert.ok(rowFor("Lead line about Act II quests").includes(`(${leadName}`), "the lead's row names the lead");
const kidRow = rowFor("Collaborator line about potion prices");
assert.ok(kidRow.includes(`(${kidName}`), "the collaborator's row names the collaborator, not the lead");
assert.ok(!kidRow.includes(`(${leadName}`), "the collaborator's row must not borrow the lead's name");
assert.ok(rowFor("Tor is typing a live draft").includes(`(${kidName}`), "a collaborator's live draft streams into the lead's panel too");
assert.ok(!html.includes("ASSIGNMENT BRIEF FOR THE COLLABORATOR"), "the collaborator's assignment brief does not pose as a director message");
assert.ok(html.includes(`${kidName} · Nightmare/Hell economy`), "the agents strip names the collaborator beside its share");
assert.ok(html.includes(`${kidName} · Route selected for the share`), "a collaborator's system row names the collaborator");
assert.ok(html.includes(`${leadName} +1`), "the implementor chip covers both agents, so it says so");

console.log("\nCollaborator feed checks passed.");
