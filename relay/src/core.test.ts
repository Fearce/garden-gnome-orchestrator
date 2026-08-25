// The Online Office relay's routing rules: who sees a message, who shows up in the roster, and what a
// joining instance is replayed. Pure — no socket, no disk, no clock.
// Run: npx tsx src/core.test.ts   (or, from server/: npm run test:relay-core)

import assert from "node:assert/strict";
import { MemoryHistory, RelayCore } from "./core.js";
import type { RelayPeer } from "./core.js";
import { OFFICE_ROOM, ROOM_HISTORY, relayRepoRoom } from "./protocol.js";
import type { RelayAgent, ServerFrame } from "./protocol.js";

/** A connected instance that records everything the core sends it. */
function fakePeer(instanceId: string, instanceName = instanceId): RelayPeer & { sent: ServerFrame[]; drain(): ServerFrame[] } {
  const sent: ServerFrame[] = [];
  return {
    connId: `conn-${instanceId}-${sent.length}`,
    instanceId,
    instanceName,
    send: (f) => sent.push(f),
    sent,
    drain() {
      const out = [...sent];
      sent.length = 0;
      return out;
    },
  };
}

function agent(over: Partial<RelayAgent> = {}): RelayAgent {
  return {
    key: "t1::implementor",
    name: "Rune",
    role: "implementor",
    title: "Fix the marker parser",
    repoKey: "github.com/fearce/card-marker",
    repoLabel: "Fearce/card-marker",
    ...over,
  };
}

function newCore() {
  let n = 0;
  return new RelayCore({ history: new MemoryHistory(ROOM_HISTORY), now: () => 1_000 + n, newId: () => `m${++n}` });
}

const chats = (frames: ServerFrame[]) => frames.filter((f) => f.t === "chat");
const presences = (frames: ServerFrame[]) => frames.filter((f) => f.t === "presence");

// A joining instance gets a welcome carrying its identity and the office backlog.
{
  const core = newCore();
  const kevin = fakePeer("i-kevin", "Kevin's tower");
  core.attach(kevin);
  const welcome = kevin.sent.find((f) => f.t === "welcome");
  assert.ok(welcome && welcome.t === "welcome");
  assert.equal(welcome.instanceName, "Kevin's tower");
  assert.deepEqual(welcome.recent, []);
}

// An office message reaches the other instance and NEVER echoes back to the sender (which already
// persisted its own copy locally — an echo would double every line in the console feed).
{
  const core = newCore();
  const kevin = fakePeer("i-kevin");
  const mikkel = fakePeer("i-mikkel");
  core.attach(kevin);
  core.attach(mikkel);
  kevin.drain();
  mikkel.drain();

  assert.equal(core.onFrame(kevin.connId, { t: "chat", room: OFFICE_ROOM, body: "morning", senderName: "Rune", role: "implementor" }), null);
  assert.equal(chats(kevin.drain()).length, 0);
  const got = chats(mikkel.drain());
  assert.equal(got.length, 1);
  assert.equal(got[0]!.t === "chat" && got[0]!.msg.body, "morning");
  assert.equal(got[0]!.t === "chat" && got[0]!.msg.instanceId, "i-kevin");
}

// A repo-room message reaches only instances that currently have an agent in THAT repository — the
// whole reason rooms are keyed on repo identity rather than broadcast to everyone.
{
  const core = newCore();
  const kevin = fakePeer("i-kevin");
  const mikkel = fakePeer("i-mikkel");
  const stranger = fakePeer("i-stranger");
  for (const p of [kevin, mikkel, stranger]) core.attach(p);

  core.onFrame(kevin.connId, { t: "presence", agents: [agent()] });
  core.onFrame(mikkel.connId, { t: "presence", agents: [agent({ key: "t9::implementor", name: "Sif" })] });
  core.onFrame(stranger.connId, { t: "presence", agents: [agent({ key: "t7::qa", repoKey: "github.com/other/thing", repoLabel: "other/thing" })] });
  kevin.drain();
  mikkel.drain();
  stranger.drain();

  const room = relayRepoRoom("github.com/fearce/card-marker");
  assert.equal(core.onFrame(kevin.connId, { t: "chat", room, body: "taking parser.ts", senderName: "Rune", role: "implementor" }), null);
  assert.equal(chats(mikkel.drain()).length, 1);
  assert.equal(chats(stranger.drain()).length, 0, "an instance in a different repo must not see the room");
  assert.equal(chats(kevin.drain()).length, 0);
}

// Entering a repo room replays that room's backlog — and only to the instance that just entered.
{
  const core = newCore();
  const kevin = fakePeer("i-kevin");
  const mikkel = fakePeer("i-mikkel");
  core.attach(kevin);
  core.attach(mikkel);
  core.onFrame(kevin.connId, { t: "presence", agents: [agent()] });
  const room = relayRepoRoom("github.com/fearce/card-marker");
  core.onFrame(kevin.connId, { t: "chat", room, body: "claiming parser.ts", senderName: "Rune", role: "implementor" });
  kevin.drain();
  mikkel.drain();

  core.onFrame(mikkel.connId, { t: "presence", agents: [agent({ key: "t9::implementor" })] });
  const replay = mikkel.sent.filter((f) => f.t === "history");
  assert.equal(replay.length, 1);
  assert.equal(replay[0]!.t === "history" && replay[0]!.room, room);
  assert.equal(replay[0]!.t === "history" && replay[0]!.messages.length, 1);
  assert.equal(kevin.sent.filter((f) => f.t === "history").length, 0);

  // Re-sending the same presence must not replay it again — an agent would read its teammates' lines twice.
  mikkel.drain();
  core.onFrame(mikkel.connId, { t: "presence", agents: [agent({ key: "t9::implementor" })] });
  assert.equal(mikkel.sent.filter((f) => f.t === "history").length, 0);
}

// Presence broadcasts on a real change, and stays silent when an instance re-reports the same agents
// (the client publishes on a timer, so an unchanged snapshot must cost nothing).
{
  const core = newCore();
  const kevin = fakePeer("i-kevin");
  const mikkel = fakePeer("i-mikkel");
  core.attach(kevin);
  core.attach(mikkel);
  kevin.drain();
  mikkel.drain();

  core.onFrame(kevin.connId, { t: "presence", agents: [agent()] });
  assert.equal(presences(mikkel.drain()).length, 1);
  kevin.drain();

  core.onFrame(kevin.connId, { t: "presence", agents: [agent()] });
  assert.equal(presences(mikkel.drain()).length, 0, "an unchanged presence snapshot must not re-broadcast");

  core.onFrame(kevin.connId, { t: "presence", agents: [] });
  assert.equal(presences(mikkel.drain()).length, 1);
}

// An instance is never handed its OWN agents. It already has them, and a console that receives them
// treats its own workers as coworkers on another machine — which is not cosmetic: a peer is what switches
// the office on, so every lone agent would believe it had a teammate (itself).
{
  const core = newCore();
  const kevin = fakePeer("i-kevin", "Kevin");
  const mikkel = fakePeer("i-mikkel", "Mikkel");
  core.attach(kevin);
  core.attach(mikkel);
  kevin.drain();
  mikkel.drain();
  core.onFrame(kevin.connId, { t: "presence", agents: [agent()] });

  const toKevin = presences(kevin.drain()).pop();
  assert.deepEqual(toKevin!.t === "presence" && toKevin!.agents, [], "an instance must not see itself in the roster");
  const toMikkel = presences(mikkel.drain()).pop();
  assert.equal(toMikkel!.t === "presence" && toMikkel!.agents.length, 1, "…while everyone else sees it");
  assert.equal(core.roster().length, 1, "the status page still sees the whole picture");

  // The same rule on the welcome frame — a joiner's first roster comes from there, not a broadcast.
  const late = fakePeer("i-kevin", "Kevin");
  Object.assign(late, { connId: "conn-kevin-late" });
  core.attach(late);
  const welcome = late.sent.find((f) => f.t === "welcome");
  assert.deepEqual(welcome!.t === "welcome" && welcome!.presence, [], "a reconnecting instance is not welcomed with itself");
}

// Nor its own chat, when a room's backlog is replayed. Live chat skips the sender in applyChat, but a
// replay has no sender to skip — so without this an instance re-imports its own posts as a teammate's
// every time it enters a room, which includes the first connect after every restart.
{
  const core = newCore();
  const room = relayRepoRoom("github.com/fearce/card-marker");
  const kevin = fakePeer("i-kevin", "Kevin");
  const mikkel = fakePeer("i-mikkel", "Mikkel");
  core.attach(kevin);
  core.attach(mikkel);
  // Both are in the repo room, and each says one thing.
  core.onFrame(kevin.connId, { t: "presence", agents: [agent()] });
  core.onFrame(mikkel.connId, { t: "presence", agents: [agent({ key: "t9::implementor" })] });
  core.onFrame(kevin.connId, { t: "chat", room, body: "I'll take parser.ts", senderName: "Rune", role: "implementor" });
  core.onFrame(mikkel.connId, { t: "chat", room, body: "taking exporter.ts", senderName: "Sif", role: "implementor" });

  // Kevin reconnects and re-enters the room: the replay must hold Mikkel's line and NOT his own.
  const again = { ...fakePeer("i-kevin", "Kevin"), connId: "conn-kevin-again" };
  core.attach(again);
  core.onFrame(again.connId, { t: "presence", agents: [agent()] });
  const replay = again.sent.find((f) => f.t === "history");
  assert.ok(replay && replay.t === "history", "the room's backlog is replayed on entry");
  assert.deepEqual(
    replay.messages.map((m) => m.senderName),
    ["Sif"],
    "a replayed backlog carries only the OTHER instances' lines",
  );
}

// A departing instance drops out of everyone's roster.
{
  const core = newCore();
  const kevin = fakePeer("i-kevin");
  const mikkel = fakePeer("i-mikkel");
  core.attach(kevin);
  core.attach(mikkel);
  core.onFrame(kevin.connId, { t: "presence", agents: [agent()] });
  assert.equal(core.roster().length, 1);
  core.detach(kevin.connId);
  assert.equal(core.roster().length, 0);
  const last = presences(mikkel.sent).pop();
  assert.deepEqual(last!.t === "presence" && last!.agents, []);
}

// A reconnect that races its own close must not leave the instance in the roster twice.
{
  const core = newCore();
  const first = fakePeer("i-kevin");
  const second = { ...fakePeer("i-kevin"), connId: "conn-kevin-2" };
  core.attach(first);
  core.onFrame(first.connId, { t: "presence", agents: [agent()] });
  core.attach(second);
  core.onFrame(second.connId, { t: "presence", agents: [agent()] });
  assert.equal(core.roster().length, 1);
  assert.equal(core.online().length, 1);
}

// sharedRepos is what the office exists for: a repo counts only when two DIFFERENT instances are in it.
{
  const core = newCore();
  const kevin = fakePeer("i-kevin", "Kevin");
  const mikkel = fakePeer("i-mikkel", "Mikkel");
  core.attach(kevin);
  core.attach(mikkel);
  core.onFrame(kevin.connId, { t: "presence", agents: [agent(), agent({ key: "t2::qa", role: "qa" })] });
  assert.deepEqual(core.sharedRepos(), [], "two agents of the SAME instance are not a collaboration");
  core.onFrame(mikkel.connId, { t: "presence", agents: [agent({ key: "t9::implementor" })] });
  const shared = core.sharedRepos();
  assert.equal(shared.length, 1);
  assert.deepEqual(shared[0]!.instances.sort(), ["Kevin", "Mikkel"]);
}

// Room keys arrive from a client, so they are validated, not trusted.
{
  const core = newCore();
  const kevin = fakePeer("i-kevin");
  core.attach(kevin);
  for (const room of ["", "repo:", "general", "repo:../../etc", "repo:UPPER/case", "x".repeat(400)]) {
    assert.ok(core.onFrame(kevin.connId, { t: "chat", room, body: "hi", senderName: "Rune", role: "implementor" }), `room "${room}" must be refused`);
  }
  assert.equal(core.onFrame(kevin.connId, { t: "chat", room: relayRepoRoom("github.com/a/b"), body: "hi", senderName: "Rune", role: "implementor" }), null);
}

// Bodies are clipped and whitespace-only ones refused, so one client can't spam another's session.
{
  const core = newCore();
  const kevin = fakePeer("i-kevin");
  const mikkel = fakePeer("i-mikkel");
  core.attach(kevin);
  core.attach(mikkel);
  mikkel.drain();
  assert.ok(core.onFrame(kevin.connId, { t: "chat", room: OFFICE_ROOM, body: "   \n  ", senderName: "Rune", role: "implementor" }));
  core.onFrame(kevin.connId, { t: "chat", room: OFFICE_ROOM, body: "z".repeat(9000), senderName: "Rune", role: "implementor" });
  const got = chats(mikkel.drain());
  assert.equal(got.length, 1);
  assert.equal(got[0]!.t === "chat" && got[0]!.msg.body.length, 2000);
}

// An agent entry with no repo identity is dropped rather than creating an unroutable room.
{
  const core = newCore();
  const kevin = fakePeer("i-kevin");
  core.attach(kevin);
  core.onFrame(kevin.connId, { t: "presence", agents: [agent({ repoKey: "" }), agent({ key: "" })] });
  assert.deepEqual(core.roster(), []);
}

console.log("relay core: all assertions passed");
