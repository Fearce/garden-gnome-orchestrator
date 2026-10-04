import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

Object.assign(globalThis, {
  React,
  document: { baseURI: "http://localhost/", visibilityState: "visible", addEventListener: () => {} },
});

const { useStore } = await import("../src/store.js");
const { Office } = await import("../src/components/Office.js");

const state = useStore.getInitialState();
const at = Date.now();
const soloWorkspace = "C:\\workspaces\\solo-project";
const soloRoom = "repo:c:/workspaces/solo-project";

// A lone task still paces rather than huddles, but its gnome is a direct shortcut to that task's
// repository room. No collaboration row exists yet — that is the exact case that previously fell
// through to the generic Office room.
Object.assign(state, {
  threads: {
    "solo-thread": {
      id: "solo-thread",
      title: "Solo navigation",
      state: "building",
      workspace: soloWorkspace,
      brief: "Test direct Office navigation",
      rawPrompt: "Test direct Office navigation",
      createdAt: at,
      updatedAt: at,
    },
  },
  runs: {
    "solo-run": {
      id: "solo-run",
      threadId: "solo-thread",
      role: "implementor",
      model: "gpt-5.6-sol",
      state: "running",
      startedAt: at,
    },
  },
  chat: [],
  chatRooms: [],
  roomHistory: {},
  officeRoom: null,
});

const officeStrip = renderToStaticMarkup(React.createElement(Office));
const escapedRoom = soloRoom.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
assert.match(
  officeStrip,
  new RegExp(`class="office-walker"[^>]*data-office-room="${escapedRoom}"`),
  "a lone worker gnome targets its repository room instead of the generic office",
);

const here = dirname(fileURLToPath(import.meta.url));
const officeSource = readFileSync(join(here, "..", "src", "components", "Office.tsx"), "utf8");
assert.match(
  officeSource,
  /onClick=\{\(\) => openOffice\(repoRoom\(w\.workspace\)\)\}/,
  "the lone worker click opens the computed repository room",
);

// Direct rooms are intentionally absent from the durable collaboration-room list until somebody
// speaks. They still need a visible selected tab; an invisible active room would make the owner hunt
// through the generic Office immediately after clicking the gnome.
Object.assign(state, { officeRoom: soloRoom });
const directOffice = renderToStaticMarkup(React.createElement(Office));
assert.match(directOffice, /solo-project/, "a new direct room gets a visible contextual tab");
assert.match(directOffice, /This agent&#x27;s project chat/, "the panel labels direct agent chat clearly");
assert.match(directOffice, /Message this project&#x27;s agent as director/, "the composer targets the selected agent's repository");

// A message's gnome opens the task that posted it. Only a task this console holds can be opened: a
// line from another machine, or from a task no longer loaded, keeps a plain gnome.
Object.assign(state, {
  chat: [
    { id: "m-local", room: soloRoom, scope: "project", role: "implementor", kind: "chat", threadId: "solo-thread", body: "local line", createdAt: at },
    { id: "m-gone", room: soloRoom, scope: "project", role: "qa", kind: "chat", threadId: "gone-thread", body: "gone line", createdAt: at + 1 },
    { id: "m-remote", room: soloRoom, scope: "project", role: "planner", kind: "chat", threadId: "solo-thread", remoteInstance: "Sam's laptop", body: "remote line", createdAt: at + 2 },
  ],
});
const messagePanel = renderToStaticMarkup(React.createElement(Office));
const avatarsIn = (id: string) => {
  const start = messagePanel.indexOf(`data-message-id="${id}"`);
  const end = messagePanel.indexOf("data-message-id=", start + 1);
  return messagePanel.slice(start, end < 0 ? undefined : end).split('class="office-msg-avatar"').length - 1;
};
assert.equal(avatarsIn("m-local"), 1, "a local task's message gnome is a button that opens the task");
assert.match(messagePanel, /title="Open “Solo navigation”"/, "…titled with the task it opens");
assert.equal(avatarsIn("m-gone"), 0, "a message from an unloaded task keeps a plain gnome");
assert.equal(avatarsIn("m-remote"), 0, "a message from another machine keeps a plain gnome");
assert.match(
  officeSource,
  /setBoardView\("tasks"\);\s*select\(threadId\);\s*close\(\);/,
  "opening a message's task switches to the task board, selects it and closes the modal panel",
);
Object.assign(state, { chat: [] });

// ---- the Online Office section: the people, not their agents ---------------------------------------

// The Online Office has no pill of its own: the top bar's room belongs to the agents working. While
// nobody else is at a console, the director gnome is the door to the general office chat.
Object.assign(state, { officeRoom: null });
const aloneStrip = renderToStaticMarkup(React.createElement(Office));
assert.doesNotMatch(aloneStrip, /office-online|office-director-online/, "no Online Office marker while this machine is the only one");
assert.match(
  aloneStrip,
  /class="office-walker office-director[^"]*"[^>]*data-office-room="general"/,
  "alone, the director gnome opens the general office",
);

// Two other directors show up. The director gnome becomes a click straight into the directors'
// room — reachable without first having a task or a shared repository.
Object.assign(state, {
  onlineOffice: {
    ...state.onlineOffice,
    enabled: true,
    joined: true,
    state: "online",
    instanceName: "Robin's tower",
    directors: [
      { instanceId: "inst-sam", instanceName: "Sam's laptop", name: "Sam", agents: 2, since: at },
      { instanceId: "inst-ada", instanceName: "Ada's box", name: "Ada", agents: 0, since: at },
    ],
  },
});
const peopleStrip = renderToStaticMarkup(React.createElement(Office));
assert.match(
  peopleStrip,
  /class="office-walker office-director[^"]*"[^>]*data-office-room="directors"/,
  "with other directors online, the director gnome opens the directors' room",
);
assert.doesNotMatch(peopleStrip, /class="office-online"/, "…instead of a separate Online Office pill");
assert.match(peopleStrip, /<span class="office-director-online">2<\/span>/, "…and carries a count of who else is on");
assert.match(peopleStrip, /Sam on Sam&#x27;s laptop — 2 agents working/, "…naming each person, their machine and what they have running");
assert.match(peopleStrip, /Ada on Ada&#x27;s box — nothing running/, "…including a director with nothing started");

// Opening it: its own tab, its own copy, and — the containment that makes the room worth having — no
// project-room machinery reading "directors" as a repository.
Object.assign(state, { officeRoom: "directors" });
const directorsPanel = renderToStaticMarkup(React.createElement(Office));
assert.match(directorsPanel, /class="office-tab directors on"/, "the Directors tab is the selected one");
assert.match(directorsPanel, /Directors <span class="office-tab-n">3<\/span>/, "…counting the other directors plus you");
assert.match(directorsPanel, /the people running these consoles, across machines/, "the panel says who is in the room");
assert.match(directorsPanel, /Message the other directors/, "…and the composer targets them, not an agent");
assert.doesNotMatch(
  directorsPanel,
  /class="office-panel-sub">[^<]*(?:project|repository)/i,
  "no repo-room copy leaks into a room that has no repository",
);

// ---- a busy huddle draws its whole crowd --------------------------------------------------------------

// Five tasks in one repo used to render as four gnomes (a hard slice(0, 4)), which read as "four agents
// here". Everyone is drawn up to six; past that the tail folds into a "+N" so the pill never under-reads.
const busyWorkspace = "C:\\workspaces\\busy-repo";
function huddleWith(localCount: number, remoteCount = 0): { gnomes: number; more: string | null } {
  const threads: Record<string, unknown> = {};
  const runs: Record<string, unknown> = {};
  for (let i = 0; i < localCount; i++) {
    threads[`busy-${i}`] = {
      id: `busy-${i}`, title: `Busy ${i}`, state: "building", workspace: busyWorkspace,
      brief: "crowd", rawPrompt: "crowd", createdAt: at, updatedAt: at,
    };
    runs[`busy-run-${i}`] = { id: `busy-run-${i}`, threadId: `busy-${i}`, role: "implementor", model: "claude-opus", state: "running", startedAt: at + i };
  }
  const remoteAgents = Array.from({ length: remoteCount }, (_, i) => ({
    key: `remote-${i}`, name: `Remote ${i}`, role: "qa", title: "remote", repoKey: "busy-key", repoLabel: "busy-repo",
    instanceId: "inst-sam", instanceName: "Sam's laptop",
  }));
  Object.assign(state, {
    officeRoom: null,
    threads,
    runs,
    onlineOffice: {
      ...state.onlineOffice,
      remoteAgents,
      sharedRepos: remoteCount ? [{ repoKey: "busy-key", repoLabel: "busy-repo", workspaces: [busyWorkspace] }] : [],
    },
  });
  const strip = renderToStaticMarkup(React.createElement(Office));
  const start = strip.indexOf('class="office-huddle-gnomes"');
  assert.ok(start >= 0, `a ${localCount}+${remoteCount} crowd renders as a huddle`);
  const huddle = strip.slice(start, strip.indexOf('class="office-huddle-tag"', start));
  const more = huddle.match(/class="office-crowd-more">\+(\d+)</);
  return { gnomes: huddle.split("<svg").length - 1, more: more ? more[1]! : null };
}
assert.deepEqual(huddleWith(4), { gnomes: 4, more: null }, "four tasks in a repo draw four gnomes");
assert.deepEqual(huddleWith(5), { gnomes: 5, more: null }, "five tasks in a repo draw five gnomes, not four");
assert.deepEqual(huddleWith(6), { gnomes: 6, more: null }, "six still fit without a count");
assert.deepEqual(huddleWith(9), { gnomes: 5, more: "4" }, "past six, five gnomes plus +4 account for all nine");
assert.deepEqual(huddleWith(3, 2), { gnomes: 5, more: null }, "local and remote agents share the crowd budget");
assert.deepEqual(huddleWith(4, 4), { gnomes: 5, more: "3" }, "a mixed crowd past six folds its tail into +N");

console.log("Office navigation UI gate passed - lone gnomes open their own visible project chat directly, the director gnome opens the directors' room while others are online, and a busy huddle accounts for every agent.");
