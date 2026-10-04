// The Online Office relay's routing rules: who sees a message, who shows up in the roster, and what a
// joining instance is replayed. Pure — no socket, no disk, no clock.
// Run: npx tsx src/core.test.ts   (or, from server/: npm run test:relay-core)

import assert from "node:assert/strict";
import { MemoryHistory, RelayCore } from "./core.js";
import type { RelayPeer } from "./core.js";
import { CHAT_MAX_CHARS, DIRECTORS_ROOM, OFFICE_ROOM, ROOM_HISTORY, relayRepoRoom } from "./protocol.js";
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
    repoKey: "github.com/acme/map-overlay",
    repoLabel: "Acme/map-overlay",
    ...over,
  };
}

function newCore() {
  let n = 0;
  return new RelayCore({ history: new MemoryHistory(ROOM_HISTORY), now: () => 1_000 + n, newId: () => `m${++n}` });
}

const chats = (frames: ServerFrame[]) => frames.filter((f) => f.t === "chat");

// Director work is distinct from the crew's work, and changes without a roster change.
{
  const core = newCore();
  const owner = fakePeer("rest-owner"), visitor = fakePeer("rest-visitor");
  core.attach(owner); core.attach(visitor);
  core.onFrame(visitor.connId, { t: "presence", agents: [agent()], director: { name: "Visitor", busy: false } });
  assert.equal(core.directorsFor(owner.instanceId)[0]?.busy, false, "a director can sit while a worker runs");
  owner.drain();
  core.onFrame(visitor.connId, { t: "presence", agents: [agent()], director: { name: "Visitor", busy: true } });
  const frame = owner.drain().find(f => f.t === "presence");
  assert.equal(frame?.t === "presence" && frame.directors?.[0]?.busy, true, "own work wakes the director immediately");
  core.onFrame(visitor.connId, { t: "presence", agents: [], director: { name: "Legacy" } });
  assert.equal(core.directorsFor(owner.instanceId)[0]?.busy, undefined, "old peers remain compatible without claiming activity");
}
const presences = (frames: ServerFrame[]) => frames.filter((f) => f.t === "presence");

// A joining instance gets a welcome carrying its identity and the office backlog.
{
  const core = newCore();
  const robin = fakePeer("i-robin", "Robin's tower");
  core.attach(robin);
  const welcome = robin.sent.find((f) => f.t === "welcome");
  assert.ok(welcome && welcome.t === "welcome");
  assert.equal(welcome.instanceName, "Robin's tower");
  assert.deepEqual(welcome.recent, []);
}

// An office message reaches the other instance and NEVER echoes back to the sender (which already
// persisted its own copy locally — an echo would double every line in the console feed).
{
  const core = newCore();
  const robin = fakePeer("i-robin");
  const sam = fakePeer("i-sam");
  core.attach(robin);
  core.attach(sam);
  robin.drain();
  sam.drain();

  assert.equal(core.onFrame(robin.connId, { t: "chat", room: OFFICE_ROOM, body: "morning", senderName: "Rune", role: "implementor" }), null);
  assert.equal(chats(robin.drain()).length, 0);
  const got = chats(sam.drain());
  assert.equal(got.length, 1);
  assert.equal(got[0]!.t === "chat" && got[0]!.msg.body, "morning");
  assert.equal(got[0]!.t === "chat" && got[0]!.msg.instanceId, "i-robin");
}

// A repo-room message reaches only instances that currently have an agent in THAT repository — the
// whole reason rooms are keyed on repo identity rather than broadcast to everyone.
{
  const core = newCore();
  const robin = fakePeer("i-robin");
  const sam = fakePeer("i-sam");
  const stranger = fakePeer("i-stranger");
  for (const p of [robin, sam, stranger]) core.attach(p);

  core.onFrame(robin.connId, { t: "presence", agents: [agent()] });
  core.onFrame(sam.connId, { t: "presence", agents: [agent({ key: "t9::implementor", name: "Sif" })] });
  core.onFrame(stranger.connId, { t: "presence", agents: [agent({ key: "t7::qa", repoKey: "github.com/other/thing", repoLabel: "other/thing" })] });
  robin.drain();
  sam.drain();
  stranger.drain();

  const room = relayRepoRoom("github.com/acme/map-overlay");
  assert.equal(core.onFrame(robin.connId, { t: "chat", room, body: "taking parser.ts", senderName: "Rune", role: "implementor" }), null);
  assert.equal(chats(sam.drain()).length, 1);
  assert.equal(chats(stranger.drain()).length, 0, "an instance in a different repo must not see the room");
  assert.equal(chats(robin.drain()).length, 0);
}

// Entering a repo room replays that room's backlog — and only to the instance that just entered.
{
  const core = newCore();
  const robin = fakePeer("i-robin");
  const sam = fakePeer("i-sam");
  core.attach(robin);
  core.attach(sam);
  core.onFrame(robin.connId, { t: "presence", agents: [agent()] });
  const room = relayRepoRoom("github.com/acme/map-overlay");
  core.onFrame(robin.connId, { t: "chat", room, body: "claiming parser.ts", senderName: "Rune", role: "implementor" });
  robin.drain();
  sam.drain();

  core.onFrame(sam.connId, { t: "presence", agents: [agent({ key: "t9::implementor" })] });
  const replay = sam.sent.filter((f) => f.t === "history");
  assert.equal(replay.length, 1);
  assert.equal(replay[0]!.t === "history" && replay[0]!.room, room);
  assert.equal(replay[0]!.t === "history" && replay[0]!.messages.length, 1);
  assert.equal(robin.sent.filter((f) => f.t === "history").length, 0);

  // Re-sending the same presence must not replay it again — an agent would read its teammates' lines twice.
  sam.drain();
  core.onFrame(sam.connId, { t: "presence", agents: [agent({ key: "t9::implementor" })] });
  assert.equal(sam.sent.filter((f) => f.t === "history").length, 0);
}

// Presence broadcasts on a real change, and stays silent when an instance re-reports the same agents
// (the client publishes on a timer, so an unchanged snapshot must cost nothing).
{
  const core = newCore();
  const robin = fakePeer("i-robin");
  const sam = fakePeer("i-sam");
  core.attach(robin);
  core.attach(sam);
  robin.drain();
  sam.drain();

  core.onFrame(robin.connId, { t: "presence", agents: [agent()] });
  assert.equal(presences(sam.drain()).length, 1);
  robin.drain();

  core.onFrame(robin.connId, { t: "presence", agents: [agent()] });
  assert.equal(presences(sam.drain()).length, 0, "an unchanged presence snapshot must not re-broadcast");

  core.onFrame(robin.connId, { t: "presence", agents: [] });
  assert.equal(presences(sam.drain()).length, 1);
}

// An instance is never handed its OWN agents. It already has them, and a console that receives them
// treats its own workers as coworkers on another machine — which is not cosmetic: a peer is what switches
// the office on, so every lone agent would believe it had a teammate (itself).
{
  const core = newCore();
  const robin = fakePeer("i-robin", "Robin");
  const sam = fakePeer("i-sam", "Sam");
  core.attach(robin);
  core.attach(sam);
  robin.drain();
  sam.drain();
  core.onFrame(robin.connId, { t: "presence", agents: [agent()] });

  const toRobin = presences(robin.drain()).pop();
  assert.deepEqual(toRobin!.t === "presence" && toRobin!.agents, [], "an instance must not see itself in the roster");
  const toSam = presences(sam.drain()).pop();
  assert.equal(toSam!.t === "presence" && toSam!.agents.length, 1, "…while everyone else sees it");
  assert.equal(core.roster().length, 1, "the status page still sees the whole picture");

  // The same rule on the welcome frame — a joiner's first roster comes from there, not a broadcast.
  const late = fakePeer("i-robin", "Robin");
  Object.assign(late, { connId: "conn-robin-late" });
  core.attach(late);
  const welcome = late.sent.find((f) => f.t === "welcome");
  assert.deepEqual(welcome!.t === "welcome" && welcome!.presence, [], "a reconnecting instance is not welcomed with itself");
}

// Nor its own chat, when a room's backlog is replayed. Live chat skips the sender in applyChat, but a
// replay has no sender to skip — so without this an instance re-imports its own posts as a teammate's
// every time it enters a room, which includes the first connect after every restart.
{
  const core = newCore();
  const room = relayRepoRoom("github.com/acme/map-overlay");
  const robin = fakePeer("i-robin", "Robin");
  const sam = fakePeer("i-sam", "Sam");
  core.attach(robin);
  core.attach(sam);
  // Both are in the repo room, and each says one thing.
  core.onFrame(robin.connId, { t: "presence", agents: [agent()] });
  core.onFrame(sam.connId, { t: "presence", agents: [agent({ key: "t9::implementor" })] });
  core.onFrame(robin.connId, { t: "chat", room, body: "I'll take parser.ts", senderName: "Rune", role: "implementor" });
  core.onFrame(sam.connId, { t: "chat", room, body: "taking exporter.ts", senderName: "Sif", role: "implementor" });

  // Robin reconnects and re-enters the room: the replay must hold Sam's line and NOT Robin's own.
  const again = { ...fakePeer("i-robin", "Robin"), connId: "conn-robin-again" };
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
  const robin = fakePeer("i-robin");
  const sam = fakePeer("i-sam");
  core.attach(robin);
  core.attach(sam);
  core.onFrame(robin.connId, { t: "presence", agents: [agent()] });
  assert.equal(core.roster().length, 1);
  core.detach(robin.connId);
  assert.equal(core.roster().length, 0);
  const last = presences(sam.sent).pop();
  assert.deepEqual(last!.t === "presence" && last!.agents, []);
}

// A reconnect that races its own close must not leave the instance in the roster twice.
{
  const core = newCore();
  const first = fakePeer("i-robin");
  const second = { ...fakePeer("i-robin"), connId: "conn-robin-2" };
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
  const robin = fakePeer("i-robin", "Robin");
  const sam = fakePeer("i-sam", "Sam");
  core.attach(robin);
  core.attach(sam);
  core.onFrame(robin.connId, { t: "presence", agents: [agent(), agent({ key: "t2::qa", role: "qa" })] });
  assert.deepEqual(core.sharedRepos(), [], "two agents of the SAME instance are not a collaboration");
  core.onFrame(sam.connId, { t: "presence", agents: [agent({ key: "t9::implementor" })] });
  const shared = core.sharedRepos();
  assert.equal(shared.length, 1);
  assert.deepEqual(shared[0]!.instances.sort(), ["Robin", "Sam"]);
}

// Room keys arrive from a client, so they are validated, not trusted.
{
  const core = newCore();
  const robin = fakePeer("i-robin");
  core.attach(robin);
  for (const room of ["", "repo:", "general", "repo:../../etc", "repo:UPPER/case", "x".repeat(400)]) {
    assert.ok(core.onFrame(robin.connId, { t: "chat", room, body: "hi", senderName: "Rune", role: "implementor" }), `room "${room}" must be refused`);
  }
  assert.equal(core.onFrame(robin.connId, { t: "chat", room: relayRepoRoom("github.com/a/b"), body: "hi", senderName: "Rune", role: "implementor" }), null);
}

// Oversized legacy bodies are refused instead of silently clipped. Current clients split them into
// bounded frames; the relay withholds every fragment, accepts out-of-order delivery idempotently, then
// routes ONE exact logical message (Unicode, Markdown and newlines included).
{
  const core = newCore();
  const robin = fakePeer("i-robin");
  const sam = fakePeer("i-sam");
  core.attach(robin);
  core.attach(sam);
  sam.drain();
  assert.ok(core.onFrame(robin.connId, { t: "chat", room: OFFICE_ROOM, body: "   \n  ", senderName: "Rune", role: "implementor" }));
  assert.match(
    core.onFrame(robin.connId, { t: "chat", room: OFFICE_ROOM, body: "z".repeat(CHAT_MAX_CHARS + 1), senderName: "Rune", role: "implementor" }) ?? "",
    /bounded chunks/,
  );
  assert.equal(chats(sam.drain()).length, 0, "a rejected frame must not publish a clipped prefix");

  const body = `First — Ångström 東京 \`src/search.py\`\n${"x".repeat(4_300)}\n- final ✅`;
  const parts = [body.slice(0, 1_900), body.slice(1_900, 3_800), body.slice(3_800)];
  const frame = (chunkIndex: number) => ({
    t: "chat" as const,
    room: OFFICE_ROOM,
    body: parts[chunkIndex]!,
    senderName: "Rune",
    role: "implementor",
    messageId: "long-sol-message",
    chunkIndex,
    chunkCount: parts.length,
  });
  assert.equal(core.onFrame(robin.connId, frame(1)), null);
  assert.equal(core.onFrame(robin.connId, frame(0)), null);
  assert.equal(chats(sam.drain()).length, 0, "incomplete chunks never become orphan chat rows");
  assert.equal(core.onFrame(robin.connId, frame(2)), null);
  const got = chats(sam.drain());
  assert.equal(got.length, 1);
  assert.equal(got[0]!.t === "chat" && got[0]!.msg.body, body);
  assert.equal(core.onFrame(robin.connId, frame(2)), null, "a repeated final chunk is idempotent");
  assert.equal(chats(sam.drain()).length, 0, "a repeated final chunk cannot duplicate the message");
}

// An agent entry with no repo identity is dropped rather than creating an unroutable room.
{
  const core = newCore();
  const robin = fakePeer("i-robin");
  core.attach(robin);
  core.onFrame(robin.connId, { t: "presence", agents: [agent({ repoKey: "" }), agent({ key: "" })] });
  assert.deepEqual(core.roster(), []);
}

// ---- forks: one codebase, two remote identities ------------------------------------------------------
// The live defect this covers (2026-08-26): Robin's checkout advertised `Fearce/garden-gnome-orchestrator`
// and Sam's advertised `octo/garden-gnome-orchestrator` — the same repository through a fork —
// so three agents edited one codebase in two rooms that could not see each other. Every existing check
// read green, because the OTHER shared repo (`Acme/map-overlay`) matched on both sides.

const UP = "github.com/fearce/garden-gnome-orchestrator";
const FORK = "github.com/octo/garden-gnome-orchestrator";

/** Robin (has the fork configured as a second remote) and Sam (knows only the fork). */
function forkPair(opts: { withAlias: boolean }) {
  const core = newCore();
  const robin = fakePeer("i-robin", "Robin");
  const sam = fakePeer("i-sam", "Sam's workstation");
  core.attach(robin);
  core.attach(sam);
  core.onFrame(robin.connId, {
    t: "presence",
    agents: [agent({ key: "t-k::implementor", name: "Wren", repoKey: UP, repoLabel: "Fearce/garden-gnome-orchestrator", ...(opts.withAlias ? { repoAliases: [FORK] } : {}) })],
  });
  core.onFrame(sam.connId, {
    t: "presence",
    agents: [agent({ key: "t-m::implementor", name: "Sten", repoKey: FORK, repoLabel: "octo/garden-gnome-orchestrator" })],
  });
  robin.drain();
  sam.drain();
  return { core, robin, sam };
}

// Without the link declared, the two never meet — this is the bug, pinned so the fix can't silently rot.
{
  const { core, robin, sam } = forkPair({ withAlias: false });
  core.onFrame(sam.connId, { t: "chat", room: relayRepoRoom(FORK), body: "claiming web/", senderName: "Sten", role: "implementor" });
  assert.deepEqual(chats(robin.drain()), [], "no alias declared ⇒ the fork's line must not reach the upstream room");
  core.onFrame(robin.connId, { t: "chat", room: relayRepoRoom(UP), rooms: [relayRepoRoom(UP)], body: "claiming office/", senderName: "Wren", role: "implementor" });
  assert.deepEqual(chats(sam.drain()), []);
  assert.deepEqual(core.sharedRepos(), [], "and the collaboration is invisible in the headline count");
}

// One side knowing the link is enough, and it works in BOTH directions.
{
  const { core, robin, sam } = forkPair({ withAlias: true });

  // fork → upstream. Robin joined the fork's room via that alias, so it simply receives it.
  core.onFrame(sam.connId, { t: "chat", room: relayRepoRoom(FORK), body: "claiming web/", senderName: "Sten", role: "implementor" });
  const toRobin = chats(robin.drain());
  assert.equal(toRobin.length, 1, "the fork's line reaches the upstream side exactly once");
  assert.ok(toRobin[0]!.t === "chat" && toRobin[0]!.msg.body === "claiming web/");

  // upstream → fork. Sam's client predates aliases: it matches an incoming room against its own key
  // exactly, so the relay must stamp the line with the room HE knows the repo by, not the sender's.
  core.onFrame(robin.connId, {
    t: "chat",
    room: relayRepoRoom(UP),
    rooms: [relayRepoRoom(UP), relayRepoRoom(FORK)],
    body: "claiming office/",
    senderName: "Wren",
    role: "implementor",
  });
  const toSam = chats(sam.drain());
  assert.equal(toSam.length, 1, "delivered ONCE, not once per room in the group");
  assert.ok(toSam[0]!.t === "chat");
  assert.equal(toSam[0]!.msg.room, relayRepoRoom(FORK), "stamped with the receiver's own room");
  assert.equal(toSam[0]!.msg.body, "claiming office/");

  // One shared repository, not two — the number the status page and /api/health report.
  const shared = core.sharedRepos();
  assert.equal(shared.length, 1, JSON.stringify(shared));
  assert.equal(shared[0]!.repoKey, UP, "the representative is the lexicographically smallest key, so it is stable");
  assert.equal(shared[0]!.repoLabel, "Fearce/garden-gnome-orchestrator");
  assert.deepEqual([...shared[0]!.instances].sort(), ["Robin", "Sam's workstation"]);
}

// A copy is filed under every room in the group, so the side that only knows the OTHER name still gets
// the backlog when it enters — and the copies share ONE id, which is what the client's durable dedup keys on.
{
  const { core, robin } = forkPair({ withAlias: true });
  core.onFrame(robin.connId, {
    t: "chat",
    room: relayRepoRoom(UP),
    rooms: [relayRepoRoom(UP), relayRepoRoom(FORK)],
    body: "history please",
    senderName: "Wren",
    role: "implementor",
  });
  const late = fakePeer("i-late", "A third machine");
  core.attach(late);
  core.onFrame(late.connId, { t: "presence", agents: [agent({ key: "t-l::implementor", repoKey: FORK, repoLabel: "octo/garden-gnome-orchestrator" })] });
  const replay = late.sent.filter((f) => f.t === "history");
  assert.equal(replay.length, 1, "entering the fork's room replays what was said under the upstream name");
  assert.ok(replay[0]!.t === "history" && replay[0]!.messages.length === 1);
  assert.equal(replay[0]!.t === "history" && replay[0]!.messages[0]!.body, "history please");
}

// An unrelated repository must not be pulled in by someone else's alias list.
{
  const { core, robin } = forkPair({ withAlias: true });
  const other = fakePeer("i-other", "Someone else");
  core.attach(other);
  core.onFrame(other.connId, { t: "presence", agents: [agent({ key: "t-o::implementor", repoKey: "github.com/someone/utilities", repoLabel: "someone/utilities" })] });
  other.drain();
  core.onFrame(robin.connId, {
    t: "chat",
    room: relayRepoRoom(UP),
    rooms: [relayRepoRoom(UP), relayRepoRoom(FORK)],
    body: "not for you",
    senderName: "Wren",
    role: "implementor",
  });
  assert.deepEqual(chats(other.drain()), [], "a repo outside the group hears nothing");
}

// Aliases are agent-supplied, so they are cleaned and capped exactly like `repoKey` is.
{
  const core = newCore();
  const robin = fakePeer("i-robin");
  core.attach(robin);
  core.onFrame(robin.connId, {
    t: "presence",
    agents: [agent({ repoKey: UP, repoAliases: ["repo:../../etc", "UPPER/Case", "", "github.com/a/b", UP, "github.com/a/b"] })],
  });
  const seen = core.roster()[0]!.repoAliases ?? [];
  assert.deepEqual(seen, ["upper/case", "github.com/a/b"], "junk dropped, lowercased, de-duped, self excluded");

  const core2 = newCore();
  const p = fakePeer("i-cap");
  core2.attach(p);
  core2.onFrame(p.connId, { t: "presence", agents: [agent({ repoKey: UP, repoAliases: Array.from({ length: 40 }, (_, i) => `github.com/o/r${i}`) })] });
  assert.equal((core2.roster()[0]!.repoAliases ?? []).length, 8, "capped, so one client can't fan itself into 40 rooms");
}

// Backward compatibility: a client that sends no aliases and no `rooms` behaves exactly as it always did.
{
  const core = newCore();
  const robin = fakePeer("i-robin");
  const sam = fakePeer("i-sam");
  core.attach(robin);
  core.attach(sam);
  for (const p of [robin, sam]) core.onFrame(p.connId, { t: "presence", agents: [agent()] });
  robin.drain();
  sam.drain();
  core.onFrame(robin.connId, { t: "chat", room: relayRepoRoom("github.com/acme/map-overlay"), body: "same as ever", senderName: "Rune", role: "implementor" });
  const got = chats(sam.drain());
  assert.equal(got.length, 1);
  assert.equal(got[0]!.t === "chat" && got[0]!.msg.room, relayRepoRoom("github.com/acme/map-overlay"));
  assert.equal(core.sharedRepos().length, 1);
}

// ---- the directors' room: the humans, and only the ones who asked to be in it ----------------------

// Declaring a director is what joins the room, and it does not depend on having any agent working —
// two people deciding what to start is exactly when the room earns its keep.
{
  const core = newCore();
  const robin = fakePeer("i-robin", "Robin's tower");
  const sam = fakePeer("i-sam", "Sam's laptop");
  core.attach(robin);
  core.attach(sam);
  core.onFrame(robin.connId, { t: "presence", agents: [], director: { name: "Robin" } });
  core.onFrame(sam.connId, { t: "presence", agents: [], director: { name: "Sam" } });
  robin.drain();
  sam.drain();

  assert.equal(core.onFrame(robin.connId, { t: "chat", room: DIRECTORS_ROOM, body: "deploying in 5", senderName: "Robin", role: "director" }), null);
  const got = chats(sam.drain());
  assert.equal(got.length, 1, "the other director hears it");
  assert.equal(got[0]!.t === "chat" && got[0]!.msg.room, DIRECTORS_ROOM);
  assert.equal(got[0]!.t === "chat" && got[0]!.msg.senderName, "Robin");
  assert.deepEqual(chats(robin.drain()), [], "and it never echoes back to the sender");

  const roster = core.directorsFor("i-robin");
  assert.deepEqual(
    roster.map((d) => [d.name, d.instanceName, d.agents]),
    [["Sam", "Sam's laptop", 0]],
    "the roster is everyone BUT you, agents or no agents",
  );
  assert.equal(core.directors().length, 2, "…while the whole-office view holds both");
}

// The opt-in is a containment, not a nicety: a console that predates the room files an unrecognised
// room into its own general office as agent chatter, so it must never be sent a line from here.
{
  const core = newCore();
  const robin = fakePeer("i-robin");
  const legacy = fakePeer("i-legacy");
  core.attach(robin);
  core.attach(legacy);
  core.onFrame(robin.connId, { t: "presence", agents: [], director: { name: "Robin" } });
  core.onFrame(legacy.connId, { t: "presence", agents: [agent()] }); // no director — an older client
  robin.drain();
  legacy.drain();

  core.onFrame(robin.connId, { t: "chat", room: DIRECTORS_ROOM, body: "just us", senderName: "Robin", role: "director" });
  assert.deepEqual(chats(legacy.drain()), [], "a client that never declared a director hears nothing");
  assert.equal(
    core.onFrame(legacy.connId, { t: "chat", room: DIRECTORS_ROOM, body: "let me in", senderName: "Sif", role: "implementor" }),
    "declare a director before posting to the directors' room",
    "…and cannot post into it either",
  );
  assert.deepEqual(chats(robin.drain()), [], "so nothing reached the room");
  assert.deepEqual(core.directorsFor("i-robin"), [], "…and it is not listed as a person in the office");
}

// Entering the room replays its backlog — minus your own lines, which you already have. This is the
// same path a repo room uses, which is why the feature needed no new frame type.
{
  const core = newCore();
  const robin = fakePeer("i-robin");
  const sam = fakePeer("i-sam");
  core.attach(robin);
  core.attach(sam);
  core.onFrame(robin.connId, { t: "presence", agents: [], director: { name: "Robin" } });
  core.onFrame(sam.connId, { t: "presence", agents: [], director: { name: "Sam" } });
  core.onFrame(robin.connId, { t: "chat", room: DIRECTORS_ROOM, body: "morning", senderName: "Robin", role: "director" });
  core.onFrame(sam.connId, { t: "chat", room: DIRECTORS_ROOM, body: "morning back", senderName: "Sam", role: "director" });

  const back = fakePeer("i-robin", "Robin's tower"); // Robin reconnects after a bounce
  back.connId = "conn-robin-2";
  core.attach(back);
  back.drain();
  core.onFrame(back.connId, { t: "presence", agents: [], director: { name: "Robin" } });
  const replay = back.drain().filter((f) => f.t === "history");
  assert.equal(replay.length, 1, "the room he just entered is replayed");
  assert.equal(replay[0]!.t === "history" && replay[0]!.room, DIRECTORS_ROOM);
  const bodies = replay[0]!.t === "history" ? replay[0]!.messages.map((m) => m.body) : [];
  assert.deepEqual(bodies, ["morning back"], "his own line is not replayed back at him");
}

// The room belongs to no repository: a directors' line never fans out into a repo room, and a repo
// line never reaches the directors' room.
{
  const core = newCore();
  const robin = fakePeer("i-robin");
  const sam = fakePeer("i-sam");
  core.attach(robin);
  core.attach(sam);
  core.onFrame(robin.connId, { t: "presence", agents: [agent()], director: { name: "Robin" } });
  core.onFrame(sam.connId, { t: "presence", agents: [agent()], director: { name: "Sam" } });
  robin.drain();
  sam.drain();

  core.onFrame(robin.connId, {
    t: "chat",
    room: DIRECTORS_ROOM,
    rooms: [relayRepoRoom("github.com/acme/map-overlay")], // a client trying to fan it into a repo room
    body: "between us",
    senderName: "Robin",
    role: "director",
  });
  const seen = chats(sam.drain());
  assert.equal(seen.length, 1, "delivered exactly once");
  assert.equal(seen[0]!.t === "chat" && seen[0]!.msg.room, DIRECTORS_ROOM, "…and only ever as the directors' room");

  core.onFrame(robin.connId, { t: "chat", room: relayRepoRoom("github.com/acme/map-overlay"), body: "claiming parser.ts", senderName: "Rune", role: "implementor" });
  const repoLine = chats(sam.drain());
  assert.equal(repoLine.length, 1);
  assert.equal(repoLine[0]!.t === "chat" && repoLine[0]!.msg.room, relayRepoRoom("github.com/acme/map-overlay"), "repo traffic stays in the repo room");
}

// A rename reaches the other consoles: the roster is what the strip draws people from, so a director
// whose name changed must not sit there under the old one until something else moves.
{
  const core = newCore();
  const robin = fakePeer("i-robin");
  const sam = fakePeer("i-sam");
  core.attach(robin);
  core.attach(sam);
  core.onFrame(robin.connId, { t: "presence", agents: [], director: { name: "Robin" } });
  core.onFrame(sam.connId, { t: "presence", agents: [], director: { name: "Sam" } });
  robin.drain();
  core.onFrame(sam.connId, { t: "presence", agents: [], director: { name: "Sam the Deployer" } });
  const broadcast = presences(robin.drain()).at(-1);
  assert.ok(broadcast && broadcast.t === "presence");
  assert.deepEqual((broadcast.directors ?? []).map((d) => d.name), ["Sam the Deployer"]);
  // A name longer than the wire cap is clipped, never trusted at length.
  core.onFrame(sam.connId, { t: "presence", agents: [], director: { name: "M".repeat(200) } });
  assert.equal(core.directorsFor("i-robin")[0]!.name.length, 40, "the declared name is bounded");
}

// Leaving takes the person out of the room: a disconnect must update everyone else's roster, or the
// strip keeps drawing somebody who went home.
{
  const core = newCore();
  const robin = fakePeer("i-robin");
  const sam = fakePeer("i-sam");
  core.attach(robin);
  core.attach(sam);
  core.onFrame(robin.connId, { t: "presence", agents: [], director: { name: "Robin" } });
  core.onFrame(sam.connId, { t: "presence", agents: [], director: { name: "Sam" } });
  robin.drain();
  core.detach(sam.connId);
  const after = presences(robin.drain()).at(-1);
  assert.ok(after && after.t === "presence");
  assert.deepEqual(after.directors ?? [], [], "the departed director is gone from the roster");
}

console.log("relay core: all assertions passed");
