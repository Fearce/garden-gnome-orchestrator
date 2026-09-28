// Discord DMs to the director: the owner writes the notification bot privately and the message lands in
// the director chat as if typed into the console; the director's replies for that turn go back to the DM.
//
// The bot is the same one `discordNotify.ts` posts through. Receiving needs Discord's Gateway (a
// WebSocket session), because the REST API has no way to be told about a new DM. Only the DIRECT_MESSAGES
// intent is requested: a DM's content reaches a bot without the privileged MESSAGE_CONTENT intent, so
// the inbox works on a bot whose owner never ticked that box. Only the configured owner user id is ever
// listened to — anyone else who DMs the bot is ignored, since a DM here can dispatch work on this box.

import { WebSocket } from "ws";
import type { EventHub } from "../events.js";
import type { ImageAttachment, ImageMediaType } from "../types.js";
import { MAX_IMAGE_BASE64_BYTES } from "../attachments.js";

const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
const API_BASE = "https://discord.com/api/v10";
const INTENT_DIRECT_MESSAGES = 1 << 12;

const OP = { dispatch: 0, heartbeat: 1, identify: 2, resume: 6, reconnect: 7, invalidSession: 9, hello: 10, heartbeatAck: 11 } as const;

/** Close codes after which reconnecting cannot help — the token, the intents or the bot itself is wrong. */
const FATAL_CLOSE: Record<number, string> = {
  4004: "Discord rejected the bot token — check it in Settings.",
  4010: "Discord refused the gateway shard setup.",
  4011: "Discord says this bot needs sharding.",
  4012: "Discord refused the gateway API version.",
  4013: "Discord refused the requested intents.",
  4014: "Discord refused the Direct Messages intent for this bot.",
};
/** Close codes where the session is gone and must be re-identified rather than resumed. */
const FRESH_SESSION_CLOSE = new Set([4007, 4009]);

const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];
const MAX_IMAGES = 8;
/** An image this big in bytes would exceed the provider's base64 limit once encoded. */
const MAX_IMAGE_BYTES = Math.floor((MAX_IMAGE_BASE64_BYTES * 3) / 4);
const IMAGE_TYPES = new Set<string>(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const TYPING_REFRESH_MS = 8_000;
/** A DM sent while GGO was down is still acted on after a restart — but not one so old that the work it
 *  asks for may no longer be wanted; those get a "resend it" reply instead. */
const MAX_CATCH_UP_AGE_MS = 60 * 60 * 1000;
const DISCORD_EPOCH_MS = 1420070400000n;

export interface InboxConfig {
  enabled: boolean;
  token?: string;
  /** The owner's Discord user id — the only author whose DMs are accepted. */
  userId?: string;
}

interface DiscordAttachment {
  url: string;
  filename: string;
  contentType: string | null;
  size: number;
}

/** One owner DM, lifted out of a gateway MESSAGE_CREATE. */
export interface OwnerDm {
  messageId: string;
  channelId: string;
  text: string;
  attachments: DiscordAttachment[];
}

/** The owner DM inside a MESSAGE_CREATE payload, or null for anything else (a guild message, a bot, a
 *  stranger, an empty message). Pure — this is what the gate asserts the filter on. */
export function ownerDmFrom(payload: unknown, ownerId: string): OwnerDm | null {
  const m = payload as {
    id?: unknown; channel_id?: unknown; guild_id?: unknown; content?: unknown;
    author?: { id?: unknown; bot?: unknown }; attachments?: unknown;
  } | null;
  if (!m || typeof m.id !== "string" || typeof m.channel_id !== "string") return null;
  if (m.guild_id) return null;
  if (!ownerId || m.author?.id !== ownerId || m.author?.bot) return null;
  const text = typeof m.content === "string" ? m.content.trim() : "";
  const attachments = Array.isArray(m.attachments) ? m.attachments.map(toAttachment).filter((a): a is DiscordAttachment => !!a) : [];
  if (!text && attachments.length === 0) return null;
  return { messageId: m.id, channelId: m.channel_id, text, attachments };
}

function toAttachment(raw: unknown): DiscordAttachment | null {
  const a = raw as { url?: unknown; filename?: unknown; content_type?: unknown; size?: unknown } | null;
  if (!a || typeof a.url !== "string") return null;
  return {
    url: a.url,
    filename: typeof a.filename === "string" ? a.filename : "attachment",
    contentType: typeof a.content_type === "string" ? a.content_type.split(";")[0]!.trim().toLowerCase() : null,
    size: typeof a.size === "number" ? a.size : 0,
  };
}

/** What the director receives for one DM: the text, the images it can see, and a line naming whatever
 *  had to be left out, so it never answers as if it had seen a file it didn't. */
export async function directorInputFor(dm: OwnerDm, fetchImpl: typeof fetch = fetch): Promise<{ text: string; images: ImageAttachment[] }> {
  const images: ImageAttachment[] = [];
  const skipped: string[] = [];
  for (const a of dm.attachments) {
    const image = images.length < MAX_IMAGES && a.contentType && IMAGE_TYPES.has(a.contentType) && a.size <= MAX_IMAGE_BYTES
      ? await downloadImage(a, fetchImpl)
      : null;
    if (image) images.push(image);
    else skipped.push(a.filename);
  }
  const lines = [dm.text || (images.length ? "(sent an image)" : "(sent an attachment)")];
  if (skipped.length) lines.push(`[Attachments not passed on from Discord: ${skipped.join(", ")} — only PNG/JPEG/GIF/WebP images up to ${Math.floor(MAX_IMAGE_BYTES / (1024 * 1024))}MB come through.]`);
  return { text: lines.join("\n\n"), images };
}

async function downloadImage(a: DiscordAttachment, fetchImpl: typeof fetch): Promise<ImageAttachment | null> {
  try {
    const res = await fetchImpl(a.url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > MAX_IMAGE_BYTES) return null;
    return { name: a.filename, mediaType: a.contentType as ImageMediaType, dataBase64: bytes.toString("base64") };
  } catch {
    return null;
  }
}

/** The subset of a `ws` socket the gateway uses — a test hands in a scripted fake. */
export interface GatewaySocket {
  send(data: string): void;
  close(code?: number): void;
  on(event: "open", cb: () => void): unknown;
  on(event: "message", cb: (data: unknown) => void): unknown;
  on(event: "close", cb: (code: number) => void): unknown;
  on(event: "error", cb: (e: Error) => void): unknown;
}

export interface InboxHost {
  config(): InboxConfig;
  onOwnerDm(dm: OwnerDm): void;
  /** The newest DM already handed to the director, which a fresh session catches up from. */
  lastSeenId(): string | null;
  /** DMs that arrived while GGO was down, too old to act on unasked; `newestId` is the last of them. */
  onStaleDms(channelId: string, count: number, newestId: string): void;
  /** A one-line, owner-readable connection state, shown under the Settings toggle. */
  status(text: string): void;
  log(level: "info" | "warn", message: string): void;
}

interface GatewayFrame {
  op: number;
  d?: unknown;
  s?: number | null;
  t?: string | null;
}

/**
 * One Discord Gateway session for the bot: HELLO → IDENTIFY (or RESUME) → heartbeats, reconnecting with
 * backoff on any drop and resuming the session where Discord allows, so a DM sent across a blip is
 * replayed rather than lost. `reconcile()` is called whenever settings change and connects, reconnects
 * (a new token or owner) or disconnects to match.
 */
export class DiscordInbox {
  private socket: GatewaySocket | null = null;
  /** The config the inbox last acted on — a settings broadcast that changed nothing here is a no-op, and
   *  a fatal close (a bad token) stays stopped until the token or owner actually changes. */
  private configKey: string | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private awaitingAck = false;
  private seq: number | null = null;
  private sessionId: string | null = null;
  private resumeUrl: string | null = null;
  private attempt = 0;
  private stopped = true;
  private botName: string | undefined;

  constructor(
    private readonly host: InboxHost,
    private readonly openSocket: (url: string) => GatewaySocket = (url) => new WebSocket(url, { handshakeTimeout: 15_000 }),
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  reconcile(): void {
    const cfg = this.host.config();
    const key = JSON.stringify([cfg.enabled, cfg.token ?? "", cfg.userId ?? ""]);
    if (key === this.configKey) return;
    this.configKey = key;
    this.stop();
    if (!cfg.enabled) return this.host.status("Off.");
    if (!cfg.token) return this.host.status("Waiting for a bot token.");
    if (!cfg.userId) return this.host.status("Waiting for your Discord user ID — only your DMs are listened to.");
    this.stopped = false;
    this.sessionId = null;
    this.seq = null;
    this.attempt = 0;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000);
  }

  private connect(): void {
    if (this.stopped) return;
    this.host.status("Connecting to Discord…");
    const url = this.sessionId && this.resumeUrl ? `${this.resumeUrl}/?v=10&encoding=json` : GATEWAY_URL;
    const socket = this.openSocket(url);
    this.socket = socket;
    socket.on("message", (data) => {
      if (this.socket === socket) this.onFrame(String(data));
    });
    socket.on("error", (e) => {
      if (this.socket === socket) this.host.log("warn", `Discord inbox: ${e.message}`);
    });
    socket.on("close", (code) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.onClose(code);
    });
  }

  private onFrame(raw: string): void {
    let frame: GatewayFrame;
    try {
      frame = JSON.parse(raw) as GatewayFrame;
    } catch {
      return;
    }
    if (typeof frame.s === "number") this.seq = frame.s;
    switch (frame.op) {
      case OP.hello:
        this.startHeartbeat(Number((frame.d as { heartbeat_interval?: unknown })?.heartbeat_interval) || 41_250);
        this.identifyOrResume();
        return;
      case OP.heartbeatAck:
        this.awaitingAck = false;
        return;
      case OP.heartbeat:
        this.sendHeartbeat();
        return;
      case OP.reconnect:
        this.dropSocket(4000);
        return;
      case OP.invalidSession:
        if (frame.d !== true) this.sessionId = null;
        this.dropSocket(4000);
        return;
      case OP.dispatch:
        this.onDispatch(frame.t ?? "", frame.d);
        return;
    }
  }

  private onDispatch(type: string, data: unknown): void {
    if (type === "READY") {
      const ready = data as { session_id?: string; resume_gateway_url?: string; user?: { username?: string } };
      this.sessionId = ready.session_id ?? null;
      this.resumeUrl = ready.resume_gateway_url?.replace(/\/+$/, "") ?? null;
      this.connected(ready.user?.username);
      // A fresh session replays nothing, so a DM sent while GGO restarted would be lost without this.
      void this.catchUp().catch((e) => this.host.log("warn", `Discord inbox catch-up failed: ${e instanceof Error ? e.message : String(e)}`));
    } else if (type === "RESUMED") {
      this.connected();
    } else if (type === "MESSAGE_CREATE") {
      const dm = ownerDmFrom(data, this.host.config().userId ?? "");
      if (dm) this.host.onOwnerDm(dm);
    }
  }

  private connected(name?: string): void {
    if (name) this.botName = name;
    this.attempt = 0;
    this.host.status(`Listening — DM ${this.botName ? `@${this.botName}` : "the bot"} to talk to the director.`);
  }

  private async catchUp(): Promise<void> {
    const { token, userId } = this.host.config();
    const after = this.host.lastSeenId();
    if (!token || !userId || !after) return;
    const channel = (await this.rest(token, "POST", "users/@me/channels", { recipient_id: userId })) as { id?: string } | null;
    if (!channel?.id) return;
    const messages = await this.rest(token, "GET", `channels/${channel.id}/messages?after=${after}&limit=50`);
    const missed = (Array.isArray(messages) ? messages : [])
      .map((m) => ownerDmFrom(m, userId))
      .filter((dm): dm is OwnerDm => !!dm)
      .sort((a, b) => compareSnowflakes(a.messageId, b.messageId));
    const now = Date.now();
    const stale = missed.filter((dm) => now - snowflakeTime(dm.messageId) > MAX_CATCH_UP_AGE_MS);
    if (stale.length) this.host.onStaleDms(channel.id, stale.length, stale[stale.length - 1]!.messageId);
    for (const dm of missed) if (!stale.includes(dm)) this.host.onOwnerDm(dm);
  }

  private async rest(token: string, method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const res = await this.fetchImpl(`${API_BASE}/${path}`, {
      method,
      headers: { authorization: `Bot ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Discord ${method} ${path.split("?")[0]} answered ${res.status}`);
    return res.json();
  }

  private identifyOrResume(): void {
    const token = this.host.config().token ?? "";
    if (this.sessionId) {
      this.send({ op: OP.resume, d: { token, session_id: this.sessionId, seq: this.seq } });
      return;
    }
    this.send({
      op: OP.identify,
      d: { token, intents: INTENT_DIRECT_MESSAGES, properties: { os: process.platform, browser: "ggo", device: "ggo" } },
    });
  }

  private startHeartbeat(intervalMs: number): void {
    this.clearHeartbeat();
    this.awaitingAck = false;
    const beat = (): void => {
      // No ACK since the last beat means a zombied connection: Discord's documented cure is to drop it
      // and resume, otherwise the socket looks open while every DM is silently missed.
      if (this.awaitingAck) return this.dropSocket(4000);
      this.sendHeartbeat();
      this.heartbeat = setTimeout(beat, intervalMs);
    };
    this.heartbeat = setTimeout(beat, Math.floor(intervalMs * Math.random()));
  }

  private sendHeartbeat(): void {
    this.awaitingAck = true;
    this.send({ op: OP.heartbeat, d: this.seq });
  }

  private send(frame: GatewayFrame): void {
    try {
      this.socket?.send(JSON.stringify(frame));
    } catch (e) {
      this.host.log("warn", `Discord inbox send failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Close our end and let `onClose` schedule the reconnect — used for every "start over" the protocol asks for. */
  private dropSocket(code: number): void {
    const socket = this.socket;
    if (!socket) return;
    this.socket = null;
    socket.close(code);
    this.onClose(code);
  }

  private onClose(code: number): void {
    this.clearTimers();
    if (this.stopped) return;
    const fatal = FATAL_CLOSE[code];
    if (fatal) {
      this.stopped = true;
      this.host.status(fatal);
      this.host.log("warn", `Discord inbox stopped: ${fatal} (close ${code})`);
      return;
    }
    if (FRESH_SESSION_CLOSE.has(code)) this.sessionId = null;
    const delay = RECONNECT_DELAYS_MS[Math.min(this.attempt, RECONNECT_DELAYS_MS.length - 1)]!;
    this.attempt += 1;
    this.host.status(`Disconnected from Discord (close ${code}) — reconnecting in ${Math.round(delay / 1000)}s.`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private clearHeartbeat(): void {
    if (this.heartbeat) clearTimeout(this.heartbeat);
    this.heartbeat = null;
  }

  private clearTimers(): void {
    this.clearHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
}

export function compareSnowflakes(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

function snowflakeTime(id: string): number {
  return Number((BigInt(id) >> 22n) + DISCORD_EPOCH_MS);
}

export interface ReplyTransport {
  reply(channelId: string, text: string): void;
  typing(channelId: string): void;
}

/**
 * Carries the director's answers back to the DM a turn came from. A DM opens a window on its channel;
 * every director text posted while the window is open is relayed, and the window closes when the
 * director goes idle. That also relays the answer to a console message that steered the same turn —
 * one conversation, both surfaces — while console-only turns never leak to the phone.
 */
export class DiscordReplyRelay {
  private channelId: string | null = null;
  private typingTimer: NodeJS.Timeout | null = null;

  constructor(
    hub: EventHub,
    private readonly directorBusy: () => boolean,
    private readonly transport: ReplyTransport,
  ) {
    hub.subscribe((event) => {
      if (!this.channelId) return;
      if (event.type === "director.message" && event.message.role === "director" && event.message.kind === "text") {
        this.transport.reply(this.channelId, event.message.content);
      } else if (event.type === "director.busy" && !event.busy) {
        this.close();
      }
    });
  }

  /** Called just before a DM is handed to the director. */
  open(channelId: string): void {
    this.channelId = channelId;
    this.transport.typing(channelId);
    if (!this.typingTimer) {
      this.typingTimer = setInterval(() => {
        if (this.channelId && this.directorBusy()) this.transport.typing(this.channelId);
      }, TYPING_REFRESH_MS);
    }
  }

  /** Called right after the hand-off: a DM the director refused outright (a restart in progress) never
   *  made it busy, so no idle edge will come to close the window. */
  handedOff(): void {
    if (!this.directorBusy()) this.close();
  }

  private close(): void {
    this.channelId = null;
    if (this.typingTimer) clearInterval(this.typingTimer);
    this.typingTimer = null;
  }
}

export interface DiscordInboxDeps {
  hub: EventHub;
  config: () => InboxConfig;
  status: (text: string) => void;
  transport: ReplyTransport;
  directorBusy: () => boolean;
  lastSeen: { get(): string | null; set(id: string): void };
  toDirector: (text: string, images: ImageAttachment[], messageId: string) => void;
}

/** Builds the inbox + reply relay and keeps the inbox matched to settings as they change. */
export function startDiscordInbox(deps: DiscordInboxDeps): DiscordInbox {
  const relay = new DiscordReplyRelay(deps.hub, deps.directorBusy, deps.transport);
  // Image downloads are async, so DMs are handed over in a chain — two quick messages keep their order.
  let handoff: Promise<void> = Promise.resolve();
  const markSeen = (id: string): void => {
    const seen = deps.lastSeen.get();
    if (!seen || compareSnowflakes(id, seen) > 0) deps.lastSeen.set(id);
  };
  const inbox = new DiscordInbox({
    config: deps.config,
    status: deps.status,
    log: (level, message) => deps.hub.log(level, message),
    lastSeenId: () => deps.lastSeen.get(),
    onStaleDms: (channelId, count, newestId) => {
      markSeen(newestId);
      deps.transport.reply(
        channelId,
        `GGO was offline when you sent ${count === 1 ? "a message" : `${count} messages`} over an hour ago, so I didn't act on ${count === 1 ? "it" : "them"}. Resend anything you still want done.`,
      );
    },
    onOwnerDm: (dm) => {
      markSeen(dm.messageId);
      handoff = handoff
        .then(() => directorInputFor(dm))
        .then(({ text, images }) => {
          relay.open(dm.channelId);
          deps.toDirector(text, images, `discord-${dm.messageId}`);
          relay.handedOff();
        })
        .catch((e) => deps.hub.log("warn", `Discord DM not delivered to the director: ${e instanceof Error ? e.message : String(e)}`));
    },
  });
  deps.hub.subscribe((event) => {
    if (event.type === "settings") inbox.reconcile();
  });
  inbox.reconcile();
  return inbox;
}
