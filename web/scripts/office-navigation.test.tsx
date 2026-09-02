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

console.log("Office navigation UI gate passed - lone gnomes open their own visible project chat directly.");
