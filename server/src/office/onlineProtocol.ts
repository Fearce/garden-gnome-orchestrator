// The wire contract between an orchestrator instance and the Online Office relay.
//
// MIRRORED BYTE-FOR-BYTE in `server/src/office/onlineProtocol.ts`. The two packages deliberately do not
// import each other (the relay ships as a ~40 MB container with one dependency; the orchestrator server
// carries the Agent SDK and a native sqlite build), so this file is copied the same way `types.ts` is
// copied into `web/src/types.ts`. Change one, change the other, and bump PROTOCOL when the change is
// not backward-compatible — the relay refuses a mismatched major so a stale client fails loudly at the
// handshake instead of silently dropping frames.

export const RELAY_PROTOCOL = 1;

/** The room every joined instance is in: the cross-machine equivalent of the local general office. */
export const OFFICE_ROOM = "office";

/** The people's room: the humans running these consoles talking to each other, not their agents.
 *
 *  Membership is OPT-IN and that is load-bearing — an instance is in it only once it has declared a
 *  `director` on a presence frame. A console that predates this feature files an unrecognised room into
 *  its own general office as agent chatter, so it must never be sent a line from here. Opt-in is also
 *  what keeps this additive: no PROTOCOL bump, and therefore no office-wide outage while machines
 *  redeploy one at a time. */
export const DIRECTORS_ROOM = "directors";

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
  /** The OTHER identities this checkout answers to — its remotes besides the one `repoKey` came from.
   *  A fork is why this exists: `upstream/gg` and `contributor/gg` are one codebase and two keys, so
   *  keying on `repoKey` alone puts the two people editing it in rooms that never meet. An instance
   *  that knows the link declares it here and the relay joins it to the other side's room too — one
   *  side knowing is enough. OPTIONAL on purpose: a client that predates this simply sends none, which
   *  is exactly today's behaviour, so no PROTOCOL bump (a bump disconnects every peer until it
   *  redeploys — for this feature that would break the very office it repairs). */
  repoAliases?: string[];
}

/** A human at one of these consoles, as everyone else sees them. One per connected instance that has
 *  declared a director — the roster the directors' room is a conversation between. `agents` is how many
 *  workers that machine has going right now, which is the one piece of context worth showing beside a
 *  name in a room that is deliberately not about any particular repository. */
export interface RelayDirector {
  instanceId: string;
  instanceName: string;
  name: string; // the director persona's own name on that machine
  agents: number;
  since: number; // when that instance connected
  busy?: boolean; // The director's own turn, independent of its workers. Optional for older peers.
}

/** An agent as seen by everyone else: the reporter's own presence entry, stamped with who reported it. */
export interface RelayPresentAgent extends RelayAgent {
  instanceId: string;
  instanceName: string;
}

/** One complete chat line from the relay. Clients submit bounded chunks, but the relay reassembles them
 *  before routing/persisting history, so receivers never render orphan fragments. */
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

/** A relay that routes Director-sharing frames says so in `welcome.features`. A console never sends a
 *  `share.*` frame to a relay that did not, because an older relay answers an unknown frame with an error
 *  and drops it, so the recipient would wait out its timeout for a reply that can never come. */
export const RELAY_FEATURE_DIRECTOR_SHARING = "director-sharing";

/** One subscription a donor console currently offers as Director capacity. Discovery only: the relay and
 *  the recipient use it to list and address capacity, but the DONOR re-checks every request against its
 *  own durable share record, so a stale copy of this (a cached roster, a relay that has not seen the
 *  expiry yet) can never authorise a model call. `shareId` is minted afresh on every opt-in, which is
 *  what makes an offer discovered before a stop or an expiry useless after a later re-share. */
export interface RelayShareOffer {
  shareId: string;
  providerLabel: string; // e.g. "OpenAI API"
  model: string;
  expiresAt: number; // epoch ms, the donor's deadline
  maxConcurrent: number;
  inFlight: number;
}

/** An offer as everyone else sees it: stamped by the relay with the donor instance that advertised it. */
export interface RelaySharePresent extends RelayShareOffer {
  instanceId: string;
  instanceName: string;
  donorName: string; // the donor console's director persona, for attribution
}

/** One chat-completions message of a shared Director call. Text only: the donor forwards it verbatim and
 *  never adds its own system prompt, memory, tools or files. */
export interface RelayShareMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Why a shared call did not produce a reply. Stable codes: the recipient's Director words its note from
 *  them, and none of them carries provider-side detail that could expose the donor's account. */
export type RelayShareErrorCode =
  | "offline" // the donor console is not connected to the relay
  | "not-shared" // no active share with that id (never shared, stopped, or re-shared under a new id)
  | "expired" // the share's deadline has passed
  | "busy" // the share's concurrency limit is reached
  | "rate-limited" // the share's hourly request limit, or the provider's own rate limit
  | "exhausted" // the provider reports the donor's quota or credit is used up
  | "provider-error" // the provider failed or refused the request
  | "too-large" // the request exceeds SHARE_CALL_MAX_CHARS
  | "cancelled" // the recipient cancelled the call
  | "timeout";

export interface RelayShareUsage {
  inputTokens: number;
  outputTokens: number;
}

/** Upper bound on one shared call's message text, summed over every message. Well inside the relay's
 *  socket payload cap even for multi-byte text, so a call is refused clearly instead of being dropped. */
export const SHARE_CALL_MAX_CHARS = 150_000;
/** Upper bound on message count, including the opening instructions and any omission marker. */
export const SHARE_CALL_MAX_MESSAGES = 400;
/** Upper bound on one reply's text. */
export const SHARE_REPLY_MAX_CHARS = 32_000;
export const SHARE_MAX_OFFERS = 8;
/** Calls one recipient may have outstanding through the relay at once, across every donor. */
export const SHARE_MAX_PENDING_CALLS = 4;

export const CHAT_MAX_CHARS = 2000;
/** Bounded client-to-relay chunks per logical message (128k UTF-16 code units at the current chunk cap). */
export const CHAT_MAX_CHUNKS = 64;
export const PRESENCE_MAX_AGENTS = 64;
/** Recent lines the relay keeps per room, replayed to an instance when it enters that room. */
export const ROOM_HISTORY = 60;

export type ClientFrame =
  /** `director` — when present — both names the human at this console and opts the instance into the
   *  directors' room. Optional, so a client that predates the room simply never enters it. */
  /** `shares` is the subscriptions this console currently offers as Director capacity. Optional: a console
   *  that predates sharing sends none, and the relay routes `share.*` frames only to a console offering one. */
  | { t: "presence"; agents: RelayAgent[]; director?: { name: string; busy?: boolean }; shares?: RelayShareOffer[] }
  /** `room` is the sender's own room and stays the addressing unit. `rooms` — when present — is every
   *  room the line belongs to (the sender's whole identity group), so one post reaches a fork's room as
   *  well as the upstream's. The relay still delivers ONE message with ONE id, stamped per receiver with
   *  the room THEY know it by, so a client that never heard of aliases files it correctly. */
  | {
      t: "chat";
      room: string;
      rooms?: string[];
      body: string;
      senderName: string;
      role: string;
      repoLabel?: string | null;
      /** Present together only when one logical body exceeds CHAT_MAX_CHARS. Optional keeps v1 peers compatible. */
      messageId?: string;
      chunkIndex?: number;
      chunkCount?: number;
    }
  /** Director sharing, sent only to a relay that advertised RELAY_FEATURE_DIRECTOR_SHARING. A call is
   *  addressed to the donor instance and the relay stamps who is calling, so a donor never trusts a
   *  self-declared identity. A reply is accepted only from the instance a pending call was sent to, and
   *  is delivered only to the instance that made that call. */
  | { t: "share.call"; to: string; callId: string; shareId: string; messages: RelayShareMessage[] }
  | {
      t: "share.reply";
      to: string;
      callId: string;
      ok: boolean;
      text?: string;
      code?: RelayShareErrorCode;
      message?: string;
      usage?: RelayShareUsage;
    }
  | { t: "share.cancel"; to: string; callId: string }
  | { t: "ping" };

/** `directors` rides along on the two frames that already carry a roster rather than becoming a frame of
 *  its own: an optional field is ignored by an older console, whereas an unknown frame type is one more
 *  thing every peer has to have redeployed before the office works again. */
export type ServerFrame =
  | {
      t: "welcome";
      protocol: number;
      instanceId: string;
      instanceName: string;
      presence: RelayPresentAgent[];
      recent: RelayChat[];
      directors?: RelayDirector[];
      features?: string[];
      shares?: RelaySharePresent[];
    }
  | { t: "presence"; agents: RelayPresentAgent[]; directors?: RelayDirector[]; shares?: RelaySharePresent[] }
  /** The recent backlog of a room this instance has just entered (its first agent in that repo). */
  | { t: "history"; room: string; messages: RelayChat[] }
  | { t: "chat"; msg: RelayChat }
  | { t: "share.call"; from: string; fromName: string; callId: string; shareId: string; messages: RelayShareMessage[] }
  | {
      t: "share.reply";
      from: string;
      callId: string;
      ok: boolean;
      text?: string;
      code?: RelayShareErrorCode;
      message?: string;
      usage?: RelayShareUsage;
    }
  | { t: "share.cancel"; from: string; callId: string }
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
