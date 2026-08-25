import { CHAT_MAX_CHARS, OFFICE_ROOM, PRESENCE_MAX_AGENTS, RELAY_PROTOCOL, relayRepoRoom } from "./protocol.js";
import type { ClientFrame, RelayAgent, RelayChat, RelayPresentAgent, ServerFrame } from "./protocol.js";

/** One live connection, as the routing core sees it. The transport (a real WebSocket, or a fake in the
 *  test) is behind `send` so every routing decision in this file is testable without a socket. */
export interface RelayPeer {
  connId: string;
  instanceId: string;
  instanceName: string;
  send(frame: ServerFrame): void;
}

/** Where a room's recent lines live. In the relay process this is backed by a debounced JSON file so a
 *  restart doesn't erase the context a joining agent reads; the test swaps in a plain in-memory one. */
export interface RoomHistory {
  push(room: string, msg: RelayChat): void;
  recent(room: string): RelayChat[];
}

export class MemoryHistory implements RoomHistory {
  private readonly rooms = new Map<string, RelayChat[]>();
  constructor(private readonly cap: number) {}
  push(room: string, msg: RelayChat): void {
    const list = this.rooms.get(room) ?? [];
    list.push(msg);
    if (list.length > this.cap) list.splice(0, list.length - this.cap);
    this.rooms.set(room, list);
  }
  recent(room: string): RelayChat[] {
    return [...(this.rooms.get(room) ?? [])];
  }
  /** Every room that has ever held a line, newest-active first — the status page's room list. */
  roomKeys(): string[] {
    return [...this.rooms.entries()]
      .sort((a, b) => (b[1][b[1].length - 1]?.at ?? 0) - (a[1][a[1].length - 1]?.at ?? 0))
      .map(([room]) => room);
  }
}

interface PeerState {
  peer: RelayPeer;
  agents: RelayAgent[];
  rooms: Set<string>; // office + one per repo this instance has an agent in
  since: number;
}

/** A repo room key is agent-supplied, so it is validated rather than trusted: the identity normalizer
 *  only ever produces lowercase host/owner/repo (or `name:<leaf>`), and anything else is a client bug or
 *  an attempt to fan a message into a room nobody would look at. */
const REPO_ROOM_RE = /^repo:[a-z0-9][a-z0-9._+\-/:@]{0,199}$/;

const clip = (s: unknown, n: number): string => (typeof s === "string" ? s.replace(/\s+$/, "").slice(0, n) : "");

/**
 * The Online Office's routing brain: who is online, which repos they are in, and who each chat line
 * reaches. Deliberately free of transport, storage and clock concerns — the relay process wires those in.
 *
 * Two rules shape everything here. **Nothing an instance sent ever comes back to it** — not live chat,
 * not replayed history, not its own agents in a roster — because it already holds that locally and an
 * echo reads as a coworker on another machine. And a message to a repo room reaches only the instances
 * that currently have an agent in that repository — so two people working unrelated repos never see each
 * other's coordination chatter, which is the whole point of keying rooms on repo identity.
 */
export class RelayCore {
  private readonly peers = new Map<string, PeerState>();
  private readonly history: RoomHistory;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(opts: { history: RoomHistory; now?: () => number; newId?: () => string }) {
    this.history = opts.history;
    this.now = opts.now ?? (() => Date.now());
    this.newId = opts.newId ?? (() => Math.random().toString(36).slice(2) + Date.now().toString(36));
  }

  /** Register a freshly-authenticated connection: it gets the office backlog and the current roster, and
   *  everyone else learns it is here. A second connection from the same instance (a reconnect that raced
   *  its own close) replaces the older one rather than doubling that instance in the roster. */
  attach(peer: RelayPeer): void {
    for (const [connId, st] of this.peers) {
      if (st.peer.instanceId === peer.instanceId && connId !== peer.connId) this.peers.delete(connId);
    }
    this.peers.set(peer.connId, { peer, agents: [], rooms: new Set([OFFICE_ROOM]), since: this.now() });
    peer.send({
      t: "welcome",
      protocol: RELAY_PROTOCOL,
      instanceId: peer.instanceId,
      instanceName: peer.instanceName,
      presence: this.rosterFor(peer.instanceId),
      recent: this.othersOnly(this.history.recent(OFFICE_ROOM), peer.instanceId),
    });
    this.broadcastPresence();
  }

  detach(connId: string): void {
    if (this.peers.delete(connId)) this.broadcastPresence();
  }

  /** Route one inbound frame. Returns an error string when the frame was rejected (the caller logs it and
   *  answers the peer), or null when it was handled. */
  onFrame(connId: string, frame: ClientFrame): string | null {
    const st = this.peers.get(connId);
    if (!st) return "unknown connection";
    switch (frame?.t) {
      case "ping":
        st.peer.send({ t: "pong" });
        return null;
      case "presence":
        this.applyPresence(st, Array.isArray(frame.agents) ? frame.agents : []);
        return null;
      case "chat":
        return this.applyChat(st, frame);
      default:
        return "unknown frame";
    }
  }

  /** Replace an instance's reported agents. Rebuilds its room set: entering a repo room replays that
   *  room's backlog to it alone, so a fresh agent starts with what its remote teammates already said. */
  private applyPresence(st: PeerState, agents: RelayAgent[]): void {
    const clean = agents
      .slice(0, PRESENCE_MAX_AGENTS)
      .map((a) => ({
        key: clip(a.key, 200),
        name: clip(a.name, 40) || "agent",
        role: clip(a.role, 24) || "implementor",
        title: clip(a.title, 160),
        repoKey: clip(a.repoKey, 200).toLowerCase(),
        repoLabel: clip(a.repoLabel, 120),
      }))
      .filter((a) => a.key && a.repoKey);

    const rooms = new Set<string>([OFFICE_ROOM]);
    for (const a of clean) {
      const room = relayRepoRoom(a.repoKey);
      if (REPO_ROOM_RE.test(room)) rooms.add(room);
    }
    const entered = [...rooms].filter((r) => !st.rooms.has(r));
    const changed = JSON.stringify(st.agents) !== JSON.stringify(clean);
    st.agents = clean;
    st.rooms = rooms;
    for (const room of entered) {
      const messages = this.othersOnly(this.history.recent(room), st.peer.instanceId);
      if (messages.length) st.peer.send({ t: "history", room, messages });
    }
    if (changed) this.broadcastPresence();
  }

  private applyChat(st: PeerState, frame: Extract<ClientFrame, { t: "chat" }>): string | null {
    const room = clip(frame.room, 220);
    if (room !== OFFICE_ROOM && !REPO_ROOM_RE.test(room)) return `bad room "${room}"`;
    const body = clip(frame.body, CHAT_MAX_CHARS).trim();
    if (!body) return "empty message";
    const msg: RelayChat = {
      id: this.newId(),
      room,
      repoLabel: clip(frame.repoLabel, 120) || null,
      body,
      senderName: clip(frame.senderName, 40) || "agent",
      role: clip(frame.role, 24) || "implementor",
      instanceId: st.peer.instanceId,
      instanceName: st.peer.instanceName,
      at: this.now(),
    };
    this.history.push(room, msg);
    for (const other of this.peers.values()) {
      if (other.peer.instanceId === st.peer.instanceId) continue; // the sender already has its own copy
      if (!other.rooms.has(room)) continue;
      other.peer.send({ t: "chat", msg });
    }
    return null;
  }

  /** Every agent every connected instance is reporting, stamped with its instance. The status pages want
   *  this whole picture; an instance never does — see `rosterFor`. */
  roster(): RelayPresentAgent[] {
    const out: RelayPresentAgent[] = [];
    for (const st of this.peers.values()) {
      for (const a of st.agents) out.push({ ...a, instanceId: st.peer.instanceId, instanceName: st.peer.instanceName });
    }
    return out;
  }

  /** The roster as ONE instance must see it: everyone but itself. An instance already knows its own
   *  agents — handing them back makes it treat its own workers as coworkers on another machine, which
   *  is not a cosmetic duplicate: peers are what switch the office on, so a lone agent would be told it
   *  has a teammate (itself) and every "someone joined" push would be about itself. */
  rosterFor(instanceId: string): RelayPresentAgent[] {
    return this.roster().filter((a) => a.instanceId !== instanceId);
  }

  /** The same rule for replayed chat. A room's backlog holds the entering instance's OWN lines, and
   *  unlike live chat (which skips the sender in `applyChat`) a replay has no sender to skip — so
   *  without this an instance re-imports its own posts as a remote teammate's, on every reconnect. */
  private othersOnly(messages: RelayChat[], instanceId: string): RelayChat[] {
    return messages.filter((m) => m.instanceId !== instanceId);
  }

  /** The connected instances, for the status page and `/api/health`. */
  online(): { instanceId: string; instanceName: string; agents: number; repos: string[]; since: number }[] {
    return [...this.peers.values()].map((st) => ({
      instanceId: st.peer.instanceId,
      instanceName: st.peer.instanceName,
      agents: st.agents.length,
      repos: [...new Set(st.agents.map((a) => a.repoLabel || a.repoKey))],
      since: st.since,
    }));
  }

  /** Repo identities that two or more DIFFERENT instances are in right now — the collaborations the
   *  office exists for, and the headline number on the status page. */
  sharedRepos(): { repoKey: string; repoLabel: string; instances: string[] }[] {
    const byRepo = new Map<string, { label: string; instances: Set<string> }>();
    for (const st of this.peers.values()) {
      for (const a of st.agents) {
        const e = byRepo.get(a.repoKey) ?? { label: a.repoLabel || a.repoKey, instances: new Set<string>() };
        e.instances.add(st.peer.instanceName);
        byRepo.set(a.repoKey, e);
      }
    }
    return [...byRepo.entries()]
      .filter(([, e]) => e.instances.size >= 2)
      .map(([repoKey, e]) => ({ repoKey, repoLabel: e.label, instances: [...e.instances] }));
  }

  private broadcastPresence(): void {
    const all = this.roster();
    for (const st of this.peers.values()) {
      st.peer.send({ t: "presence", agents: all.filter((a) => a.instanceId !== st.peer.instanceId) });
    }
  }
}
