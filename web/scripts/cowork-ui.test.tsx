import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CoworkMessage, CoworkSession } from "../src/types.js";
// CoWork's graph reaches a component stylesheet, which plain Node cannot load. Must precede the
// dynamic component import below — see ssrCssStub.mjs.
import "./ssrCssStub.mjs";

// Standalone tsx gates may compile imported JSX with the classic runtime even though Vite uses the
// automatic runtime. Match the existing model-request UI gate and make React explicit first.
Object.assign(globalThis, {
  React,
  document: { baseURI: "http://localhost/", visibilityState: "visible", addEventListener: () => {} },
});
const { useStore } = await import("../src/store.js");
const { CoworkPopup, NewCoworkModal } = await import("../src/components/CoWork.js");
const { NewCoworkButton } = await import("../src/components/NewCoworkButton.js");
const { ClosedCoworkCard, CoworkCard } = await import("../src/components/CoworkCards.js");

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
    attachments: [
      { id: "screenshot-1", name: "layout.png", mediaType: "image/png" },
      { id: "source-1", name: "header.tsx", mediaType: "text/plain" },
    ],
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
  return renderToStaticMarkup(React.createElement(CoworkPopup));
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
assert.match(ready, /class="scrim cowork-popup-scrim"/, "a selected session opens as a popup over the board");
assert.match(ready, /role="dialog" aria-modal="true" aria-label="Co-work: Polish persistent chat"/, "the popup is a named modal dialog");
assert.match(ready, /title="Close \(Esc\)" aria-label="Close conversation"/, "the popup has a visible close control");
assert.match(ready, /class="gnome cowork-chat-gnome"/, "the popup header carries the Co-worker gnome");
assert.match(ready, /Polish persistent chat/, "session name remains visible");
assert.match(ready, /garden/, "workspace identity remains visible");
assert.match(ready, /codex.*gpt-5\.6-sol/s, "resolved provider/model remains visible");
assert.match(ready, /Tighten the mobile Co-work layout/, "owner message renders durably");
assert.match(ready, /api\/attachment\/screenshot-1/, "a sent screenshot renders from durable attachment storage");
assert.match(ready, /header\.tsx/, "an ordinary sent file renders by name after reload");
assert.match(ready, /api\/attachment\/source-1\?download=1/, "ordinary files use the forced-download route");
assert.match(ready, /Changed the responsive shell/, "Co-worker reply renders durably");
assert.match(ready, /<strong>Typecheck passed\.<\/strong>/, "agent markdown is rendered as conversation content");
// Tool activity is FOLDED, not listed: one burst row carrying what it did, expandable on click. This
// replaced one <details> per call, which is what buried the conversation it was meant to explain.
assert.match(ready, /<div class="cowork-tools"/, "tool activity folds into a single collapsed burst");
assert.match(ready, /cowork-tools-label">worked [^<]*call/, "the folded burst says how long it worked and how many calls it made");
assert.match(ready, /aria-expanded="false"/, "the burst starts collapsed, so the transcript reads as conversation");
assert.doesNotMatch(ready, /npm run typecheck/, "a collapsed burst does not paint its raw tool input into the transcript");
assert.match(ready, /Delivery failed/, "a failed live direction remains clear after reload");
assert.match(ready, /What should we work on next\?/, "completed turn hands the composer back to the owner");
assert.match(ready, /context linked/, "resumable context is disclosed");
assert.match(ready, /Attach screenshots or files/, "the idle composer exposes a generic attachment picker");
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
assert.match(running, /Add direction or attach a file/, "the live composer stays available for text and attachment collaboration");
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
assert.equal(render(), "", "with no session open the popup renders nothing and the board stays in view");
const newButton = renderToStaticMarkup(React.createElement(NewCoworkButton));
assert.match(newButton, /New Co-work/, "a new-session action is reachable from the board");

// A session is a card IN the task lanes, and reads as its own kind of work.
const card = renderToStaticMarkup(React.createElement(CoworkCard, { session: { ...session, lastSnippet: "Changed the responsive shell.", lastSnippetRole: "coworker" } }));
assert.match(card, /class="cowork-card state-idle"/, "a session renders as a Co-work card");
assert.match(card, /class="gnome"/, "the card carries the Co-worker gnome");
assert.match(card, /class="cowork-chip">Co-work</, "the card is labelled as Co-work, not as a task");
assert.match(card, /Co-worker:<\/span> Changed the responsive shell/, "the card shows the latest conversational line");
assert.doesNotMatch(card, /Promote|QA|Mark done/i, "the card owns no pipeline semantics");
// It follows the board's rules like a task: a ✕ to close it, the grip when drag-to-reorder is on.
assert.match(card, /aria-label="Close Co-work session"/, "an idle session can be closed off the board");
const liveCard = renderToStaticMarkup(React.createElement(CoworkCard, { session: { ...session, state: "running", activeTurnId: "t" } }));
assert.doesNotMatch(liveCard, /aria-label="Close Co-work session"/, "a live turn cannot be closed, like a running task");
const draggable = renderToStaticMarkup(React.createElement(CoworkCard, { session, draggableCard: true, dragProps: { role: "button", tabIndex: 0 } }));
assert.match(draggable, /class="cowork-card state-idle draggable"/, "a Co-work card takes part in drag-to-reorder");
assert.match(draggable, /class="card-grip"/, "with the same grip a task card shows");
const closedRow = renderToStaticMarkup(React.createElement(ClosedCoworkCard, { session: { ...session, closedAt: at } }));
assert.match(closedRow, />Restore</, "a closed session can be restored to the board");
assert.match(closedRow, />Delete</, "or deleted for good");

const modal = renderToStaticMarkup(React.createElement(NewCoworkModal, { onClose: () => {} }));
assert.match(modal, /New Co-work session/, "creation flow is fully rendered");
assert.match(modal, /Workspace/, "creation requires the safe workspace flow");
assert.match(modal, /Auto.*best available route/s, "creation exposes automatic routing");
assert.match(modal, /Browse folders/, "the existing folder picker is available");

const here = dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(join(here, "..", "src", "App.tsx"), "utf8");
const boardSource = readFileSync(join(here, "..", "src", "components", "Board.tsx"), "utf8");
const coworkSource = readFileSync(join(here, "..", "src", "components", "CoWork.tsx"), "utf8");
const attachmentsSource = readFileSync(join(here, "..", "src", "lib", "attachments.tsx"), "utf8");
const storeSource = readFileSync(join(here, "..", "src", "store.ts"), "utf8");
const cssSource = readFileSync(join(here, "..", "src", "styles.css"), "utf8");
assert.match(coworkSource, /exact model is pinned/i, "explicit model semantics are disclosed");
assert.match(coworkSource, /small, useful increments/i, "the empty state promises collaborative slices rather than autonomous completion");
assert.match(coworkSource, /useCoworkAttachments/, "the Co-work composer owns paste, drop, and file-picker state");
assert.match(coworkSource, /onPaste=\{attachments\.onPaste\}/, "clipboard screenshots and files reach the attachment input");
assert.match(attachmentsSource, /function CoworkAttachButton[\s\S]*type="file"[\s\S]*multiple/, "the Co-work picker accepts multiple arbitrary files without an image-only filter");
assert.match(attachmentsSource, /generation\.current/, "an async file read is fenced when the owner switches sessions");
for (const mode of ["queue", "append", "interrupt"]) {
  assert.match(coworkSource, new RegExp(`submit\\(\\"${mode}\\"\\)`), `${mode} control dispatches its distinct steering mode`);
}
assert.match(storeSource, /type: "cowork\.steer"/, "live Co-work directions use the typed steering command instead of opening another turn");
// A server that predates the worktree option strips the flag and answers with an ordinary session in the
// chosen folder. The console compares the answer with the request so that can never read as success.
assert.match(storeSource, /coworkActionError: worktreeIgnored \?\?/, "an ignored worktree request surfaces as an error, not a silent plain session");
assert.match(storeSource, /attachments: attachments\.length \? attachments : undefined/, "initial and live Co-work commands carry their selected files");
// Co-work is not a tab any more: a tab hid every task while the owner paired.
assert.doesNotMatch(appSource, /openBoardView\("cowork"\)|value="cowork"/, "mobile navigation has no separate Co-work area");
assert.doesNotMatch(boardSource, /view: "cowork"/, "the board has no separate Co-work tab");
assert.match(boardSource, /<CoworkPopup \/>/, "the popup stays mounted after first use, so a draft survives close and reopen");
assert.match(boardSource, /const active = useMemo\(\(\) => \[\.\.\.activeThreads\.map\(taskItem\), \.\.\.cowork\.open\.map\(coworkItem\)\]/, "Co-work cards share the task list: one sort, one drag order, one pager");
assert.match(boardSource, /<ClosedSection threads=\{closed\} sessions=\{closedSessions\} \/>/, "closed sessions wait in the same Closed list as closed tasks");
assert.match(coworkSource, /window\.addEventListener\("keydown"/, "Esc closes the popup");
assert.match(coworkSource, /event\.defaultPrevented/, "an Esc a field already consumed does not also close the popup");
assert.match(cssSource, /--role-coworker:/, "the Co-worker has its own identity colour");
assert.match(cssSource, /\.cowork-popup \{ width: 100%; height: 100%; border: 0; border-radius: 0; \}/, "on a phone the popup takes the whole screen");

console.log("Co-work UI gate passed - popup conversation, board cards, session creation, durable transcript, live steering, attachments, and mobile states are covered.");
