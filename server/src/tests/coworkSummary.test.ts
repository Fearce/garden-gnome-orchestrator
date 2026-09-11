/**
 * Gate: the deterministic Co-work session trail (`orchestrator/coworkSummary.ts`).
 *
 *   npm run test:cowork-summary --prefix server
 *
 * This module is the one place a Co-work conversation gets read back and turned into prose the owner
 * acts on: the trail a timeboxed/abandoned session leaves behind, and the brief a promoted task is
 * dispatched with. It has no model call by design, so everything it claims has to come out of the
 * durable transcript. Three things are checked because getting them wrong is silent and expensive:
 *
 *   1. A COMMIT IS ONLY REAL IF GIT SAID SO. The trail reads git's own `[branch sha] subject` receipt
 *      out of the tool RESULT, never out of the command that was attempted. A `git commit` blocked by
 *      a pre-commit hook is the normal case in this repo, and reporting it as landed would send the
 *      owner looking for a commit that does not exist.
 *   2. UNDELIVERED STEERING IS NOT A DECISION. A direction whose delivery failed never reached the
 *      agent, so nothing in the tree reflects it. Folding it into "what was asked" would brief a
 *      promoted task on an instruction that was never carried out.
 *   3. A READ IS NOT A WRITE. "Files changed" is derived from write-tool calls only; a summary that
 *      lists every file the agent looked at tells the owner nothing about where work landed.
 */

import assert from "node:assert/strict";
import { isAbsolute } from "node:path";
import type { CoworkMessage, CoworkSession, CoworkTurn } from "../types.js";
import {
  commitsMade,
  coworkTaskTitle,
  renderCoworkSummary,
  renderCoworkTaskBrief,
  summarizeCoworkSession,
  touchedFiles,
} from "../orchestrator/coworkSummary.js";

const WORKSPACE = isAbsolute("/repo/garden") ? "/repo/garden" : "C:\\repo\\garden";
const at = 1_700_000_000_000;
let seq = 0;

function message(input: Partial<CoworkMessage> & Pick<CoworkMessage, "role" | "kind" | "content">): CoworkMessage {
  seq += 1;
  return {
    id: `m${seq}`,
    sessionId: "session-1",
    turnId: "turn-1",
    meta: null,
    partial: false,
    createdAt: at + seq * 1_000,
    updatedAt: at + seq * 1_000,
    ...input,
  };
}

const session: CoworkSession = {
  id: "session-1",
  name: "Responsive shell",
  autoNamed: false,
  workspace: WORKSPACE,
  state: "idle",
  requestedProvider: null,
  requestedModel: null,
  provider: "claude",
  model: "claude-opus-5",
  effort: "high",
  account: "primary",
  agentSessionId: "provider-session",
  activeTurnId: null,
  error: null,
  createdAt: at,
  updatedAt: at + 600_000,
  activeTurnStartedAt: null,
  lastActivityAt: at + 600_000,
  lastSnippet: "Done.",
  lastSnippetRole: "coworker",
};

const turns: CoworkTurn[] = [
  {
    id: "turn-1",
    sessionId: "session-1",
    state: "done",
    provider: "claude",
    model: "claude-opus-5",
    effort: "high",
    account: "primary",
    agentSessionId: "provider-session",
    error: null,
    costUsd: 0.4,
    numTurns: 12,
    tokenUsage: null,
    startedAt: at,
    endedAt: at + 300_000,
  },
  {
    id: "turn-2",
    sessionId: "session-1",
    state: "timeboxed",
    provider: "claude",
    model: "claude-opus-5",
    effort: "high",
    account: "primary",
    agentSessionId: "provider-session",
    error: null,
    costUsd: 0.35,
    numTurns: 9,
    tokenUsage: null,
    startedAt: at + 300_000,
    endedAt: at + 600_000,
  },
];

const messages: CoworkMessage[] = [
  message({ role: "user", kind: "text", content: "Tighten the mobile Co-work layout." }),
  message({
    role: "coworker",
    kind: "tool",
    content: "Read",
    meta: { id: "t1", name: "Read", input: { file_path: `${WORKSPACE}/web/src/components/CoWork.tsx` } },
  }),
  message({
    role: "coworker",
    kind: "tool",
    content: "Edit",
    meta: { id: "t2", name: "Edit", input: { file_path: `${WORKSPACE}/web/src/components/CoWork.tsx` } },
  }),
  message({
    role: "coworker",
    kind: "tool",
    content: "Edit",
    meta: { id: "t3", name: "Edit", input: { file_path: `${WORKSPACE}/web/src/components/CoWork.tsx` } },
  }),
  message({
    role: "coworker",
    kind: "tool",
    content: "Write",
    meta: { id: "t4", name: "Write", input: { file_path: `${WORKSPACE}/web/src/styles.css` } },
  }),
  message({
    role: "user",
    kind: "text",
    content: "Also fix the header.",
    meta: { steeringMode: "append", delivery: "delivered" },
  }),
  message({
    role: "user",
    kind: "text",
    content: "Switch to the other account.",
    meta: { steeringMode: "append", delivery: "failed" },
  }),
  message({
    role: "coworker",
    kind: "tool",
    content: "Bash",
    meta: { id: "t5", name: "Bash", input: { command: "git commit -m 'fix: tighten layout'" } },
  }),
  message({
    role: "coworker",
    kind: "tool_result",
    content: "[master a1b2c3d4] fix: tighten layout\n 2 files changed, 40 insertions(+)",
    meta: { id: "t5", isError: false },
  }),
  message({
    role: "coworker",
    kind: "tool",
    content: "Bash",
    meta: { id: "t6", name: "Bash", input: { command: "git commit -m 'wip'" } },
  }),
  message({
    role: "coworker",
    kind: "tool_result",
    content: "[deadbeef1] wip: never landed\nhook refused the commit",
    meta: { id: "t6", isError: true },
  }),
  message({ role: "coworker", kind: "text", content: "Streamed opening that gets superseded.", turnId: "turn-2", partial: true }),
  message({ role: "coworker", kind: "text", content: "Layout is tighter and the header now wraps.", turnId: "turn-2" }),
  message({ role: "system", kind: "system", content: "This collaborative work slice reached its hand-back boundary." }),
];

const summary = summarizeCoworkSession({ session, turns, messages });

// --- 1. commits ------------------------------------------------------------------------------
assert.deepEqual(
  summary.commits,
  [{ sha: "a1b2c3d4", subject: "fix: tighten layout" }],
  "only git's own receipt from a SUCCESSFUL tool result counts as a commit",
);
for (const [receipt, why] of [
  ["[main (root-commit) 9f8e7d6] chore: init", "git's root-commit receipt form"],
  ["[detached HEAD 9f8e7d6] chore: init", "a commit made on a detached HEAD"],
] as const) {
  assert.equal(
    commitsMade([message({ role: "coworker", kind: "tool_result", content: receipt, meta: { id: "x", isError: false } })])[0]?.subject,
    "chore: init",
    `${why} is recognized: a receipt this misses is a commit the owner is told never happened`,
  );
}
assert.deepEqual(
  commitsMade([message({ role: "coworker", kind: "tool", content: "Bash", meta: { id: "y", name: "Bash", input: { command: "git commit -m x" } } })]),
  [],
  "an attempted commit command is never itself evidence that a commit landed",
);

// --- 2. directions ---------------------------------------------------------------------------
assert.deepEqual(
  summary.directions,
  ["Tighten the mobile Co-work layout.", "Also fix the header."],
  "delivered owner direction is what was asked; an undelivered one never reached the agent",
);

// --- 3. files --------------------------------------------------------------------------------
assert.deepEqual(
  summary.files,
  [
    { path: "web/src/components/CoWork.tsx", writes: 2 },
    { path: "web/src/styles.css", writes: 1 },
  ],
  "files changed are write-tool calls only, workspace-relative, busiest first",
);
const outside = touchedFiles(
  [message({ role: "coworker", kind: "tool", content: "Write", meta: { id: "o", name: "Write", input: { file_path: isAbsolute("/tmp/x.md") ? "/tmp/x.md" : "D:\\tmp\\x.md" } } })],
  WORKSPACE,
);
assert.ok(
  isAbsolute(outside[0]!.path) || outside[0]!.path.startsWith("D:"),
  "a path outside the workspace stays absolute rather than growing a ../.. prefix",
);

// --- the rest of the derived shape -----------------------------------------------------------
assert.equal(summary.outcomes.at(-1), "Layout is tighter and the header now wraps.", "a turn's closing block supersedes its partial stream");
assert.equal(summary.turns, 2, "turn count comes from the durable turn rows");
assert.equal(summary.toolCalls, 6, "tool-call count covers every call, not only writes");
assert.ok(Math.abs((summary.costUsd ?? 0) - 0.75) < 1e-9, "cost is summed across the session's turns");
assert.equal(summary.endedBecause, "timeboxed", "the last turn's non-done state is why the session sits where it does");
assert.equal(
  summarizeCoworkSession({ session, turns: [turns[0]!], messages }).endedBecause,
  null,
  "a session whose last turn simply finished needs no explanation",
);

// --- the rendered trail ----------------------------------------------------------------------
const markdown = renderCoworkSummary(summary);
assert.match(markdown, /Session summary: Responsive shell/, "the trail names its session");
assert.match(markdown, /hand-back boundary/, "a timeboxed session says so in the trail");
assert.match(markdown, /2 turns · 6 tool calls · 10m elapsed · \$0\.75/, "the trail leads with the facts an owner scans");
assert.match(markdown, /`web\/src\/components\/CoWork\.tsx` \(2 edits\)/, "repeated edits are visible in the trail");
assert.match(markdown, /`a1b2c3d4` fix: tighten layout/, "the landed commit is in the trail");
assert.doesNotMatch(markdown, /never landed/, "a refused commit never appears in the trail");
assert.doesNotMatch(markdown, /Switch to the other account/, "an undelivered direction never appears in the trail");

const empty = renderCoworkSummary(summarizeCoworkSession({ session, turns: [], messages: [] }));
assert.match(empty, /No file writes were recorded/, "an empty session states the absence rather than rendering a blank section");
assert.match(empty, /No commits were made/, "the same for commits, so an empty section is never mistaken for missing data");

// --- the promoted brief ----------------------------------------------------------------------
const brief = renderCoworkTaskBrief(summary, "Ship the responsive shell");
assert.ok(brief.startsWith("Ship the responsive shell"), "the objective leads the brief the implementor reads first");
assert.match(brief, /Promoted from the Co-work session \*\*Responsive shell\*\*/, "the brief discloses where its context came from");
assert.match(brief, /context to verify, not as work already/, "the brief forbids treating exploration as delivered work");
assert.match(brief, /`web\/src\/styles\.css`/, "the brief carries the files the exploration touched");
assert.match(brief, /`a1b2c3d4` fix: tighten layout/, "the brief carries the commits the exploration made");

assert.equal(coworkTaskTitle(summary), "Tighten the mobile Co-work layout", "a title comes from what the owner first asked for");
assert.equal(
  coworkTaskTitle({ ...summary, directions: [] }),
  "Responsive shell",
  "a conversation with no instruction falls back to its own name rather than an empty title",
);

console.log("Co-work summary gate passed - commits are proven by git's receipt, undelivered steering is excluded, writes only, and both renderers carry the trail.");
