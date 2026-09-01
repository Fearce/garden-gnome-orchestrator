import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CoworkMessage, CoworkSession } from "../src/types.js";

// Standalone tsx gates may compile imported JSX with the classic runtime even though Vite uses the
// automatic runtime. Match the existing model-request UI gate and make React explicit first.
Object.assign(globalThis, {
  React,
  document: { baseURI: "http://localhost/", visibilityState: "visible", addEventListener: () => {} },
});
const { useStore } = await import("../src/store.js");
const { CoWork, NewCoworkModal } = await import("../src/components/CoWork.js");

const at = Date.now();
const session: CoworkSession = {
  id: "cowork-ui-session",
  name: "Polish persistent chat",
  autoNamed: false,
  workspace: "test-workspace/garden",
  state: "idle",
  requestedProvider: "codex",
  requestedModel: "gpt-5.6-sol",
  provider: "codex",
  model: "gpt-5.6-sol",
  effort: "high",
  account: "Codex test",
  agentSessionId: "linked-provider-session",
  activeTurnId: null,
  error: null,
  createdAt: at - 60_000,
  updatedAt: at,
};
const messages: CoworkMessage[] = [
  {
    id: "user-1",
    sessionId: session.id,
    turnId: "turn-1",
    role: "user",
    kind: "text",
    content: "Tighten the mobile Co-work layout.",
    meta: null,
    partial: false,
    createdAt: at - 2_000,
    updatedAt: at - 2_000,
  },
  {
    id: "tool-1",
    sessionId: session.id,
    turnId: "turn-1",
    role: "coworker",
    kind: "tool",
    content: "Bash",
    meta: { id: "tool-call", name: "Bash", input: { command: "npm run typecheck" } },
    partial: false,
    createdAt: at - 1_500,
    updatedAt: at - 1_500,
  },
  {
    id: "reply-1",
    sessionId: session.id,
    turnId: "turn-1",
    role: "coworker",
    kind: "text",
    content: "Changed the responsive shell. **Typecheck passed.**",
    meta: null,
    partial: false,
    createdAt: at - 1_000,
    updatedAt: at - 1_000,
  },
  {
    id: "steer-failed",
    sessionId: session.id,
    turnId: "turn-1",
    role: "user",
    kind: "text",
    content: "Use the alternate token.",
    meta: { steeringMode: "append", delivery: "failed" },
    partial: false,
    createdAt: at - 900,
    updatedAt: at - 900,
  },
];

function render(): string {
  return renderToStaticMarkup(React.createElement(CoWork));
}

const ssrState = useStore.getInitialState();
Object.assign(ssrState, {
  coworkSessions: { [session.id]: session },
  coworkMessages: { [session.id]: messages },
  coworkTurns: {},
  selectedCoworkId: session.id,
  outboundMessages: [],
  coworkActionError: null,
});

const ready = render();
assert.match(ready, /cowork-shell has-session/, "selected session must open the conversation desk");
assert.match(ready, /Polish persistent chat/, "session name remains visible");
assert.match(ready, /garden/, "workspace identity remains visible");
assert.match(ready, /codex.*gpt-5\.6-sol/s, "resolved provider/model remains visible");
assert.match(ready, /Tighten the mobile Co-work layout/, "owner message renders durably");
assert.match(ready, /Changed the responsive shell/, "Co-worker reply renders durably");
assert.match(ready, /<strong>Typecheck passed\.<\/strong>/, "agent markdown is rendered as conversation content");
assert.match(ready, /<details class="cowork-detail tool"/, "tool activity is present but collapsed");
assert.match(ready, /Delivery failed/, "a failed live direction remains clear after reload");
assert.match(ready, /What should we work on next\?/, "completed turn hands the composer back to the owner");
assert.match(ready, /context linked/, "resumable context is disclosed");
assert.doesNotMatch(ready, />Stop</, "an idle session does not show interruption controls");

Object.assign(ssrState, {
  coworkSessions: {
    [session.id]: { ...session, provider: null, model: null, agentSessionId: null, updatedAt: at + 1 },
  },
});
const pinnedBeforeStart = render();
assert.match(pinnedBeforeStart, /codex.*gpt-5\.6-sol.*pinned/s, "an explicit model pin is visible before the first turn resolves");

Object.assign(ssrState, {
  coworkSessions: {
    [session.id]: { ...session, state: "running", activeTurnId: "turn-2", updatedAt: at + 2 },
  },
});
const running = render();
assert.match(running, /Co-worker is working/, "a live turn has clear progress");
assert.match(running, /cowork-stop[\s\S]*? Stop/, "a live turn exposes interruption");
assert.match(running, />Queue</, "a live turn can queue owner direction without stopping");
assert.match(running, />Inject</, "a live turn can accept immediate owner direction");
assert.match(running, /Interrupt &amp; inject/, "a live turn can be superseded with new owner direction");
assert.match(running, /Add direction to the active work slice/, "the live composer stays available for collaboration");
assert.doesNotMatch(running, /<textarea[^>]*disabled/, "the live prompt field is not frozen while the Co-worker works");

Object.assign(ssrState, {
  coworkSessions: {
    [session.id]: { ...session, state: "error", error: "Pinned model capacity is exhausted.", updatedAt: at + 2 },
  },
});
const failed = render();
assert.match(failed, /Turn stopped/, "failure is presented as a turn outcome, not a dead session");
assert.match(failed, /Pinned model capacity is exhausted/, "the actionable error is not hidden");
assert.match(failed, /conversation is intact/i, "recovery semantics are explicit");
assert.match(failed, /What should we work on next\?/, "the next instruction stays available after failure");

Object.assign(ssrState, { selectedCoworkId: null });
const list = render();
assert.match(list, /Choose a Co-work session/, "session history has a deliberate unselected state");
assert.match(list, /New Co-work session/, "a new-session action is always reachable");

const modal = renderToStaticMarkup(React.createElement(NewCoworkModal, { onClose: () => {} }));
assert.match(modal, /New Co-work session/, "creation flow is fully rendered");
assert.match(modal, /Workspace/, "creation requires the safe workspace flow");
assert.match(modal, /Auto.*best available route/s, "creation exposes automatic routing");
assert.match(modal, /Browse folders/, "the existing folder picker is available");

const here = dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(join(here, "..", "src", "App.tsx"), "utf8");
const boardSource = readFileSync(join(here, "..", "src", "components", "Board.tsx"), "utf8");
const coworkSource = readFileSync(join(here, "..", "src", "components", "CoWork.tsx"), "utf8");
const storeSource = readFileSync(join(here, "..", "src", "store.ts"), "utf8");
const cssSource = readFileSync(join(here, "..", "src", "styles.css"), "utf8");
assert.match(coworkSource, /exact model is pinned/i, "explicit model semantics are disclosed");
assert.match(coworkSource, /small, useful increments/i, "the empty state promises collaborative slices rather than autonomous completion");
for (const mode of ["queue", "append", "interrupt"]) {
  assert.match(coworkSource, new RegExp(`submit\\(\\"${mode}\\"\\)`), `${mode} control dispatches its distinct steering mode`);
}
assert.match(storeSource, /type: "cowork\.steer"/, "live Co-work directions use the typed steering command instead of opening another turn");
assert.match(appSource, /openBoardView\("cowork"\)/, "mobile navigation links directly to Co-work");
assert.match(boardSource, /view: "cowork", label: "Co-work"/, "desktop board navigation includes Co-work");
assert.match(cssSource, /\.cowork-shell\.has-session \.cowork-session-list \{ display: none; \}/, "mobile selected-session layout swaps the rail for the conversation");
assert.match(cssSource, /\.cowork-back/, "mobile conversation has an in-view back control");

console.log("Co-work UI gate passed - session creation, durable transcript, live, error/recovery, desktop, and mobile states are covered.");
