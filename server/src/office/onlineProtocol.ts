// The wire contract between an orchestrator instance and the Online Office relay.
//
// MIRRORED BYTE-FOR-BYTE from `relay/src/protocol.ts`. The two packages deliberately do not
// import each other (the relay ships as a ~40 MB container with one dependency; the orchestrator server
// carries the Agent SDK and a native sqlite build), so this file is copied the same way `types.ts` is
// copied into `web/src/types.ts`. Change one, change the other, and bump PROTOCOL when the change is
// not backward-compatible — the relay refuses a mismatched major so a stale client fails loudly at the
// handshake instead of silently dropping frames.

export const RELAY_PROTOCOL = 1;

/** The room every joined instance is in: the cross-machine equivalent of the local general office. */
export const OFFICE_ROOM = "office";

/** The room key for one repository IDENTITY (not a local path — see repoIdentity.ts). */
export function relayRepoRoom(repoKey: string): string {
  return `repo:${repoKey}`;
}

/** One agent an instance reports as working right now. `key` is stable for the life of that agent so the
 *  relay can tell "still the same worker" from "a new one joined" across presence frames. */
export interface RelayAgent {
  key: string; // `${threadId}::${role}` on the reporting instance
  name: string; // the office name the agent goes by
  role: string;
  title: string; // the task it is working on
  repoKey: string; // canonical repository identity
  repoLabel: string; // human-readable repo name, e.g. "Fearce/card-marker"
}

/** An agent as seen by everyone else: the reporter's own presence entry, stamped with who reported it. */
export interface RelayPresentAgent extends RelayAgent {
  instanceId: string;
  instanceName: string;
}

/** One chat line on the relay. Bodies are clipped at the relay, so a client never has to trust another
 *  client's length; `repoLabel` rides along so a receiver can name the repo even when it has no checkout
 *  of it under that name. */
export interface RelayChat {
  id: string;
  room: string;
  repoLabel?: string | null;
  body: string;
  senderName: string;
  role: string;
  instanceId: string;
  instanceName: string;
  at: number;
}

export const CHAT_MAX_CHARS = 2000;
export const PRESENCE_MAX_AGENTS = 64;
/** Recent lines the relay keeps per room, replayed to an instance when it enters that room. */
export const ROOM_HISTORY = 60;

export type ClientFrame =
  | { t: "presence"; agents: RelayAgent[] }
  | { t: "chat"; room: string; body: string; senderName: string; role: string; repoLabel?: string | null }
  | { t: "ping" };

export type ServerFrame =
  | { t: "welcome"; protocol: number; instanceId: string; instanceName: string; presence: RelayPresentAgent[]; recent: RelayChat[] }
  | { t: "presence"; agents: RelayPresentAgent[] }
  /** The recent backlog of a room this instance has just entered (its first agent in that repo). */
  | { t: "history"; room: string; messages: RelayChat[] }
  | { t: "chat"; msg: RelayChat }
  | { t: "pong" }
  | { t: "error"; message: string };

/** What `POST /api/join` answers with — the one-time exchange of a join code for a durable device token. */
export interface JoinResponse {
  instanceId: string;
  instanceName: string;
  token: string;
  expiresAt: number;
  protocol: number;
}
