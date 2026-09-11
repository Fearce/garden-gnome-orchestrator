/**
 * Gate: the Co-work QoL surfaces that a screenshot cannot check.
 *
 *   npm run test:cowork-ui --prefix server   (runs this after the main Co-work UI gate)
 *
 * Four claims, each of which failed silently before it was written down:
 *
 * 1. THE TRANSCRIPT FOLD. `groupCoworkTranscript` is what turns a wall of tool boxes back into a
 *    conversation. Its two hard parts are both invisible in a render: a result is paired with its call
 *    by the provider's tool id and NOT by adjacency (parallel tool use returns out of order, and an
 *    early result can arrive before its own call row), and a burst is closed by PROSE, because that is
 *    where the agent stopped working and started talking.
 * 2. LEAVING THE TAB COSTS NOTHING. The desk stays mounted behind a `hidden` attribute, and the scroll
 *    position / expanded bursts live in the STORE. `.cowork-shell` sets `display: grid`, which beats
 *    the UA rule behind `hidden`, so the explicit `[hidden]` rule is load-bearing: without it the
 *    hidden desk renders on top of the task board.
 * 3. THE BOARD CARDS ARE DISPLAY-ONLY. A Co-work session owns no thread. A card that grew a "mark
 *    done", a QA pip or a findings list would be the exact defect the lane exists to prevent.
 * 4. THE DIRECTOR IS NEVER BLOCKED. The rail is a sibling of the board and is not gated on Co-work
 *    state in any way, which is what makes a live turn non-modal.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CoworkMessage, CoworkSession } from "../src/types.js";
import "./ssrCssStub.mjs";

Object.assign(globalThis, {
  React,
  document: { baseURI: "http://localhost/", visibilityState: "visible", addEventListener: () => {} },
});

const { groupCoworkTranscript, toolBurstLabel, toolBurstTools, toolCallSummary, toolResultSummary } =
  await import("../src/lib/coworkTranscript.js");
const { useStore } = await import("../src/store.js");
const { CoworkBoardCards } = await import("../src/components/CoworkCards.js");

const at = Date.now();
let seq = 0;
const message = (input: Partial<CoworkMessage> & Pick<CoworkMessage, "role" | "kind" | "content">): CoworkMessage => {
  seq += 1;
  return {
    id: `m${seq}`,
    sessionId: "s1",
    turnId: "turn-1",
    meta: null,
    partial: false,
    createdAt: at + seq * 1_000,
    updatedAt: at + seq * 1_000,
    ...input,
  };
};

// ---- 1. the transcript fold ------------------------------------------------------------------
const transcript: CoworkMessage[] = [
  message({ role: "user", kind: "text", content: "Tighten the layout." }),
  message({ role: "coworker", kind: "tool", content: "Read", meta: { id: "a", name: "Read", input: { file_path: "web/src/App.tsx" } } }),
  message({ role: "coworker", kind: "tool", content: "Bash", meta: { id: "b", name: "Bash", input: { command: "npm run typecheck" } } }),
  // Out of order on purpose: `b` returns before `a`, which is what parallel tool use actually does.
  message({ role: "coworker", kind: "tool_result", content: "ok\nno errors", meta: { id: "b", isError: false } }),
  message({ role: "coworker", kind: "tool_result", content: "export function App() {}", meta: { id: "a", isError: false } }),
  message({ role: "coworker", kind: "text", content: "Read the shell; typecheck is clean." }),
  message({ role: "coworker", kind: "tool", content: "Edit", meta: { id: "c", name: "Edit", input: { file_path: "web/src/App.tsx" } } }),
  message({ role: "coworker", kind: "tool_result", content: "denied", meta: { id: "c", isError: true } }),
  message({ role: "coworker", kind: "text", content: "Done." }),
];
const items = groupCoworkTranscript(transcript);
assert.deepEqual(
  items.map((item) => item.kind),
  ["message", "tools", "message", "tools", "message"],
  "prose closes a tool burst; consecutive calls fold into one",
);
const firstBurst = items[1];
assert.ok(firstBurst?.kind === "tools");
assert.equal(firstBurst.calls.length, 2, "two consecutive calls are one burst");
assert.equal(firstBurst.calls[0]!.result, "export function App() {}", "a result finds its call by tool id, not by adjacency");
assert.equal(firstBurst.calls[1]!.result, "ok\nno errors", "the out-of-order result lands on the right call too");
assert.equal(firstBurst.calls.filter((call) => call.failed).length, 0, "a successful pair is not marked failed");
const secondBurst = items[3];
assert.ok(secondBurst?.kind === "tools");
assert.equal(secondBurst.calls[0]!.failed, true, "a failing tool result marks its call");

// A result whose call has not been seen yet still pairs, rather than rendering as an orphan payload.
const early = groupCoworkTranscript([
  message({ role: "coworker", kind: "tool_result", content: "early", meta: { id: "z", isError: false } }),
  message({ role: "coworker", kind: "tool", content: "Grep", meta: { id: "z", name: "Grep", input: { pattern: "cowork" } } }),
]);
assert.equal(early.length, 1, "an early result does not become its own row");
assert.ok(early[0]?.kind === "tools" && early[0].calls[0]!.result === "early", "it is folded into the call when the call arrives");

// A result with no tool id at all cannot be paired; showing it beats silently dropping it.
const orphan = groupCoworkTranscript([message({ role: "coworker", kind: "tool_result", content: "unpairable" })]);
assert.deepEqual(orphan.map((item) => item.kind), ["message"], "an unpairable tool result is still shown");

assert.match(toolBurstLabel(firstBurst), /^worked \d+s · 2 calls$/, "a folded burst says how long it took and how much it did");
assert.deepEqual(toolBurstTools(firstBurst), ["Bash", "Read"], "the burst names the tools it used");
assert.equal(toolCallSummary(firstBurst.calls[1]!), "npm run typecheck", "the collapsed row says what the call did");
assert.equal(toolResultSummary(firstBurst.calls[1]!), "ok", "and one line of what came back");
assert.equal(
  toolResultSummary({ ...firstBurst.calls[0]!, result: null }),
  "running…",
  "a call still in flight says so instead of reading as empty output",
);

// ---- 2. leaving the tab costs nothing ---------------------------------------------------------
const here = dirname(fileURLToPath(import.meta.url));
// Normalize line endings: this repo holds a mix of CRLF and LF sources, and a `\n`-anchored source
// assertion that silently only ever matches one of them is not a gate.
const read = (rel: string): string => readFileSync(join(here, "..", rel), "utf8").replace(/\r\n/g, "\n");
const boardSource = read("src/components/Board.tsx");
const coworkSource = read("src/components/CoWork.tsx");
const transcriptSource = read("src/components/CoworkTranscript.tsx");
const storeSource = read("src/store.ts");
const appSource = read("src/App.tsx");
const cssSource = read("src/styles.css");

assert.match(
  boardSource,
  /\(coworkOpened \|\| boardView === "cowork"\) && <CoWork hidden=\{boardView !== "cowork"\} \/>/,
  "the Co-work desk stays mounted behind `hidden` instead of being unmounted on every view switch",
);
assert.match(cssSource, /\.cowork-shell\[hidden\] \{ display: none; \}/,
  ".cowork-shell sets display:grid, so the hidden desk needs an explicit rule or it covers the task board");
assert.match(storeSource, /coworkScroll: Record<string, \{ top: number; stuck: boolean \}>/,
  "scroll position is per session and lives in the store, which outlives the component");
assert.match(storeSource, /coworkOpenTools: Record<string, true>/, "expanded tool bursts survive the same trip");
assert.match(transcriptSource, /rememberCoworkScroll/, "the transcript writes its position back to that store slice");
assert.match(transcriptSource, /stuck\.current = nearBottom/, "scrolling up stops the auto-stick");
assert.match(transcriptSource, /cowork-jump/, "and offers a way back to the live end");

// ---- 3. the board cards are display-only -------------------------------------------------------
const session: CoworkSession = {
  id: "s1",
  name: "Pair on the shell",
  autoNamed: false,
  workspace: "/repo/garden-gnome-orchestrator",
  state: "running",
  requestedProvider: null,
  requestedModel: null,
  provider: "claude",
  model: "claude-opus-5",
  effort: "high",
  account: "primary",
  agentSessionId: "provider-session",
  activeTurnId: "turn-1",
  error: null,
  createdAt: at - 600_000,
  updatedAt: at - 1_000,
  activeTurnStartedAt: at - 125_000,
  lastActivityAt: at - 1_000,
  lastSnippet: "Reading the responsive shell now.",
  lastSnippetRole: "coworker",
};
const ssr = useStore.getInitialState();
Object.assign(ssr, { coworkSessions: { [session.id]: session } });
const cards = renderToStaticMarkup(React.createElement(CoworkBoardCards));

assert.match(cards, /Pair on the shell/, "a live session gets a card on the board");
assert.match(cards, /garden-gnome-orchestrator/, "the card names its repo");
assert.match(cards, /working/, "the card names its state");
assert.match(cards, /Reading the responsive shell now/, "the card carries the last-message snippet");
assert.match(cards, /2m|125s|2:05/, "a live card runs an elapsed clock off the turn start");
assert.match(cards, />Steer</, "steering is reachable from the card");
assert.match(cards, />Stop</, "so is stopping the live turn");
for (const forbidden of ["Mark done", "mark-done", "QA", "findings", "Retry"]) {
  assert.ok(!cards.includes(forbidden), `a Co-work card must not expose pipeline control "${forbidden}" - it owns no task`);
}
const cardSource = read("src/components/CoworkCards.tsx");
assert.ok(!/threads|markDone|retryThread|cancelThread/.test(cardSource), "the card component never reaches into task state");
assert.match(cardSource, /sendCowork/, "card steering goes through the same command path as the composer");

Object.assign(ssr, { coworkSessions: { [session.id]: { ...session, state: "idle" as const, activeTurnId: null, activeTurnStartedAt: null } } });
const idleCards = renderToStaticMarkup(React.createElement(CoworkBoardCards));
assert.match(idleCards, /idle/, "a recently-used idle session still shows, so returning to it is one click");
assert.ok(!idleCards.includes(">Stop<"), "an idle session offers no stop control");

Object.assign(ssr, { coworkSessions: {} });
assert.equal(renderToStaticMarkup(React.createElement(CoworkBoardCards)), "", "no sessions means no section, not an empty heading");

// ---- 4. the director is never blocked ----------------------------------------------------------
// The rail is a SIBLING of the board and is rendered unconditionally, which is what makes a live
// Co-work turn non-modal: whatever the board is showing, the director is still there to talk to.
assert.match(appSource, /\n\s*<Director \/>\n\s*<Board \/>/, "the director rail is a sibling of the board, not something a board view can replace");
const directorLine = appSource.split("\n").find((line) => line.includes("<Director />"))!;
assert.equal(directorLine.trim(), "<Director />", "the director rail is rendered unconditionally - no view, state or session may gate it");
assert.match(appSource, /className=\{"mnav-btn" \+ \(pane === "director" \? " on" : ""\)\}/,
  "the phone nav always offers the director pane, including while a Co-work turn streams");

// ---- the two hand-offs -------------------------------------------------------------------------
assert.match(coworkSource, /Promote to task/, "a session can graduate into pipeline work");
assert.match(coworkSource, /promoteCowork/, "through the promote command, which composes the brief server-side");
assert.match(coworkSource, /openSummary\(selected\.id\)/, "and the session trail is reachable on demand");
assert.match(transcriptSource, /cowork_session_summary/, "an auto-posted trail renders as a document, not a one-line system rule");

console.log("Co-work transcript/board gate passed - tool folding, retained scroll + expansion, display-only cards, and a non-modal director.");
