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

// ---- the Online Office section: the people, not their agents ---------------------------------------

// Nobody else is at a console, so there is nothing to draw. An empty "Online Office" pill in the top
// bar would be furniture in the one row the account chips have to fit into.
Object.assign(state, { officeRoom: null });
const aloneStrip = renderToStaticMarkup(React.createElement(Office));
assert.doesNotMatch(aloneStrip, /office-online/, "no Online Office section while this machine is the only one");

// Two other directors show up. The section is a click straight into the directors' room — the whole
// point is that it is reachable without first having a task or a shared repository.
Object.assign(state, {
  onlineOffice: {
    ...state.onlineOffice,
    enabled: true,
    joined: true,
    state: "online",
    instanceName: "Kevin's tower",
    directors: [
      { instanceId: "inst-mikkel", instanceName: "Mikkel's laptop", name: "Mikkel", agents: 2, since: at },
      { instanceId: "inst-ada", instanceName: "Ada's box", name: "Ada", agents: 0, since: at },
    ],
  },
});
const peopleStrip = renderToStaticMarkup(React.createElement(Office));
assert.match(
  peopleStrip,
  /class="office-online"[^>]*data-office-room="directors"/,
  "the Online Office section opens the directors' room",
);
assert.match(peopleStrip, /Online Office/, "…and is labelled as such in the strip");
assert.match(peopleStrip, /Mikkel on Mikkel&#x27;s laptop — 2 agents working/, "…naming each person, their machine and what they have running");
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

console.log("Office navigation UI gate passed - lone gnomes open their own visible project chat directly, and the Online Office section opens the directors' room.");
