import { CHAT_MAX_CHARS, CHAT_MAX_CHUNKS, OFFICE_ROOM, PRESENCE_MAX_AGENTS, RELAY_PROTOCOL, relayRepoRoom } from "./protocol.js";
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

type ChatFrame = Extract<ClientFrame, { t: "chat" }>;
type CleanChat = Pick<ChatFrame, "room" | "body" | "senderName" | "role"> & {
  rooms: string[];
  repoLabel: string | null;
};

interface PendingChat {
  clean: Omit<CleanChat, "body">;
  chunks: Array<string | undefined>;
}

/** A repo room key is agent-supplied, so it is validated rather than trusted: the identity normalizer
 *  only ever produces lowercase host/owner/repo (or `name:<leaf>`), and anything else is a client bug or
 *  an attempt to fan a message into a room nobody would look at. */
const REPO_ROOM_RE = /^repo:[a-z0-9][a-z0-9._+\-/:@]{0,199}$/;

/**
 * The same contract as `REPO_ROOM_RE`, one level down: the KEY a room is built from, which the identity
 * normalizer only ever emits as lowercase `host/owner/repo` or `name:<leaf>`.
 *
 * Validating the wrapped room instead is not equivalent, and quietly lets junk through: `relayRepoRoom`
 * on a key of `repo:../../etc` yields `repo:repo:../../etc`, whose first character after the prefix is
 * the harmless `r`, so the room test passes something the room test would have refused directly.
 */
const REPO_KEY_RE = /^(?:name:[a-z0-9][a-z0-9._+-]*|[a-z0-9][a-z0-9._+\-/@]*\/[a-z0-9._+\-/@]+)$/;

/** A checkout with more remotes than this is pathological, and every alias costs a room membership and a
 *  history fan-out — so the list is bounded here rather than trusted. */
const MAX_REPO_ALIASES = 8;
/** Per connection, an abusive client may not reserve unbounded partial-message buffers. */
const MAX_PENDING_CHAT = 32;
/** Completed ids make a duplicate/replayed final chunk idempotent; insertion order bounds the memory. */
const COMPLETED_CHAT_IDS = 2048;

const clip = (s: unknown, n: number): string => (typeof s === "string" ? s.replace(/\s+$/, "").slice(0, n) : "");

/** Agent-supplied ROOM names for one chat line, held to the same shape and cap as the keys they wrap. */
const cleanRooms = (raw: unknown, exclude: string): string[] => {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const r of raw) {
    const room = clip(r, 220);
    if (!room || room === exclude || out.includes(room) || !REPO_ROOM_RE.test(room)) continue;
    out.push(room);
    if (out.length >= MAX_REPO_ALIASES) break;
  }
  return out;
};

/** Agent-supplied repo keys, cleaned to the same shape `repoKey` is held to and capped. */
const cleanKeys = (raw: unknown, exclude: string): string[] => {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const k of raw) {
    const key = clip(k, 200).toLowerCase();
    if (!key || key === exclude || out.includes(key)) continue;
    if (!REPO_KEY_RE.test(key)) continue;
    out.push(key);
    if (out.length >= MAX_REPO_ALIASES) break;
  }
  return out;
};

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
  private readonly pendingChat = new Map<string, PendingChat>();
  private readonly completedChat = new Set<string>();
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
      if (st.peer.instanceId === peer.instanceId && connId !== peer.connId) {
        this.peers.delete(connId);
        this.clearPendingChat(st.peer.instanceId);
      }
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
    const st = this.peers.get(connId);
    if (this.peers.delete(connId)) {
      if (st) this.clearPendingChat(st.peer.instanceId);
      this.broadcastPresence();
    }
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
        repoAliases: cleanKeys(a.repoAliases, clip(a.repoKey, 200).toLowerCase()),
      }))
      .filter((a) => a.key && a.repoKey);

    // An instance is in a room per identity its checkouts answer to, not just per `repoKey`: the side
    // that knows a fork and its upstream are one repository joins BOTH rooms, which is what lets it hear
    // the other side at all. The other side needs to know nothing.
    const rooms = new Set<string>([OFFICE_ROOM]);
    for (const a of clean) {
      for (const key of [a.repoKey, ...a.repoAliases]) {
        const room = relayRepoRoom(key);
        if (REPO_ROOM_RE.test(room)) rooms.add(room);
      }
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

  private applyChat(st: PeerState, frame: ChatFrame): string | null {
    const room = clip(frame.room, 220);
    if (room !== OFFICE_ROOM && !REPO_ROOM_RE.test(room)) return `bad room "${room}"`;
    const accepted = this.acceptChatBody(st, frame, room);
    if (typeof accepted === "string") return accepted;
    if (!accepted) return null; // a valid chunked message that is not complete yet
    const msg: RelayChat = {
      id: this.newId(),
      room: accepted.room,
      repoLabel: accepted.repoLabel,
      body: accepted.body,
      senderName: accepted.senderName,
      role: accepted.role,
      instanceId: st.peer.instanceId,
      instanceName: st.peer.instanceName,
      at: this.now(),
    };
    // The rooms this one line belongs to: the sender's own, plus any it declared as the same repository.
    // The general office never fans out — it is one room by definition.
    const group = accepted.room === OFFICE_ROOM ? [accepted.room] : [accepted.room, ...accepted.rooms];
    // Filed under every room in the group, so a peer that only knows the OTHER name still gets the
    // backlog when it enters. The copies share one id, which is what the receiver's durable dedup keys on.
    for (const r of group) this.history.push(r, { ...msg, room: r });
    for (const other of this.peers.values()) {
      if (other.peer.instanceId === st.peer.instanceId) continue; // the sender already has its own copy
      // Deliver ONCE, stamped with the room THIS peer knows the repo by — a client that predates aliases
      // matches an incoming room against its own key exactly, and would file an unrecognised one nowhere.
      const seenAs = group.find((r) => other.rooms.has(r));
      if (seenAs) other.peer.send({ t: "chat", msg: { ...msg, room: seenAs } });
    }
    return null;
  }

  /** Validate one client frame and, for a long message, reassemble every bounded chunk before exposing
   * anything to history or another peer. The old relay clipped at 2,000 characters here; that made the
   * remote office silently disagree with the sender's durable local row. Oversized legacy frames now
   * fail loudly, while current clients send optional id/index/count metadata and produce one exact row. */
  private acceptChatBody(st: PeerState, frame: ChatFrame, room: string): CleanChat | string | null {
    if (typeof frame.body !== "string") return "message body must be text";
    const meta = [frame.messageId, frame.chunkIndex, frame.chunkCount];
    const hasChunkMeta = meta.some((v) => v !== undefined);
    const clean = {
      room,
      rooms: room === OFFICE_ROOM ? [] : cleanRooms(frame.rooms, room),
      senderName: clip(frame.senderName, 40) || "agent",
      role: clip(frame.role, 24) || "implementor",
      repoLabel: clip(frame.repoLabel, 120) || null,
    };

    if (!hasChunkMeta) {
      if (frame.body.length > CHAT_MAX_CHARS) {
        return `message exceeds ${CHAT_MAX_CHARS} characters; send it as bounded chunks`;
      }
      const body = frame.body.trim();
      return body ? { ...clean, body } : "empty message";
    }

    if (meta.some((v) => v === undefined)) return "messageId, chunkIndex and chunkCount must be sent together";
    const messageId = frame.messageId!;
    const chunkIndex = frame.chunkIndex!;
    const chunkCount = frame.chunkCount!;
    if (!/^[A-Za-z0-9._:-]{1,100}$/.test(messageId)) return "bad chunk messageId";
    if (!Number.isInteger(chunkCount) || chunkCount < 2 || chunkCount > CHAT_MAX_CHUNKS) return "bad chunkCount";
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= chunkCount) return "bad chunkIndex";
    if (!frame.body || frame.body.length > CHAT_MAX_CHARS) return `chat chunks must contain 1-${CHAT_MAX_CHARS} characters`;

    const key = `${st.peer.instanceId}:${messageId}`;
    if (this.completedChat.has(key)) return null;
    let pending = this.pendingChat.get(key);
    if (!pending) {
      const prefix = `${st.peer.instanceId}:`;
      const held = [...this.pendingChat.keys()].filter((k) => k.startsWith(prefix)).length;
      if (held >= MAX_PENDING_CHAT) return `too many incomplete chat messages (max ${MAX_PENDING_CHAT})`;
      pending = { clean, chunks: new Array<string | undefined>(chunkCount) };
      this.pendingChat.set(key, pending);
    } else {
      if (pending.chunks.length !== chunkCount || JSON.stringify(pending.clean) !== JSON.stringify(clean)) {
        return "chunk metadata changed within one message";
      }
    }

    const prior = pending.chunks[chunkIndex];
    if (prior !== undefined && prior !== frame.body) return "chunk payload changed on retry";
    pending.chunks[chunkIndex] = frame.body;
    // `new Array(n)` is sparse: Array#some/every skip holes, so checking `part === undefined` with
    // either would falsely call an out-of-order 2/3 message complete. Count populated indices instead.
    if (pending.chunks.filter((part) => part !== undefined).length !== pending.chunks.length) return null;

    this.pendingChat.delete(key);
    this.rememberCompletedChat(key);
    const body = pending.chunks.join("");
    if (!body.trim()) return "empty message";
    return { ...pending.clean, body };
  }

  private rememberCompletedChat(key: string): void {
    this.completedChat.add(key);
    if (this.completedChat.size <= COMPLETED_CHAT_IDS) return;
    const oldest = this.completedChat.values().next().value as string | undefined;
    if (oldest) this.completedChat.delete(oldest);
  }

  private clearPendingChat(instanceId: string): void {
    const prefix = `${instanceId}:`;
    for (const key of this.pendingChat.keys()) if (key.startsWith(prefix)) this.pendingChat.delete(key);
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
    const canonical = this.repoGroups();
    const byRepo = new Map<string, { label: string; instances: Set<string> }>();
    for (const st of this.peers.values()) {
      for (const a of st.agents) {
        const group = canonical.get(a.repoKey) ?? a.repoKey;
        const e = byRepo.get(group) ?? { label: a.repoLabel || group, instances: new Set<string>() };
        // The representative's own label reads best ("Fearce/gg", not whichever fork spoke first).
        if (a.repoKey === group && a.repoLabel) e.label = a.repoLabel;
        e.instances.add(st.peer.instanceName);
        byRepo.set(group, e);
      }
    }
    return [...byRepo.entries()]
      .filter(([, e]) => e.instances.size >= 2)
      .map(([repoKey, e]) => ({ repoKey, repoLabel: e.label, instances: [...e.instances] }));
  }

  /**
   * The identity keys connected instances have declared to be the SAME repository, each mapped to one
   * representative (the lexicographically smallest, so the answer doesn't depend on who connected first).
   *
   * Counting without this reports a fork and its upstream as two separate repositories — so a real
   * cross-machine collaboration shows up as "0 shared repos" on the status page and in `/api/health`,
   * which is exactly the reading that made this defect look like an absence of activity.
   */
  private repoGroups(): Map<string, string> {
    const parent = new Map<string, string>();
    const find = (k: string): string => {
      const up = parent.get(k) ?? k;
      if (up === k) return k;
      const root = find(up);
      parent.set(k, root);
      return root;
    };
    const union = (a: string, b: string): void => {
      const [ra, rb] = [find(a), find(b)];
      if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
    };
    for (const st of this.peers.values()) {
      for (const a of st.agents) {
        if (!parent.has(a.repoKey)) parent.set(a.repoKey, a.repoKey);
        for (const alias of a.repoAliases ?? []) {
          if (!parent.has(alias)) parent.set(alias, alias);
          union(a.repoKey, alias);
        }
      }
    }
    return new Map([...parent.keys()].map((k) => [k, find(k)]));
  }

  private broadcastPresence(): void {
    const all = this.roster();
    for (const st of this.peers.values()) {
      st.peer.send({ t: "presence", agents: all.filter((a) => a.instanceId !== st.peer.instanceId) });
    }
  }
}
