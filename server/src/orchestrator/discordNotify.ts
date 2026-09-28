// Phone notifications: the three moments the owner personally cares about — a task finished, a task
// needs their input, a task failed — posted as a Discord message by a bot they already have on their
// phone — as a DM to the owner when their user ID is set, else in a channel. Everything else `notifyExternal` sends is pipeline chatter (cap failover, account resume) and
// deliberately never reaches here; a channel that buzzes for routine routing stops being read.
//
// The push preview on a phone comes from `content`, NOT from an embed, so the essential line lives in
// content and the embed only carries the detail (park reason / question / error) and the repo. Best-
// effort end to end: no token, no destination, or the toggle off → nothing is sent and nothing throws.
// The same bot also carries the director's replies back to a DM the owner wrote it (`discordInbox.ts`).

import { basename } from "node:path";

const API_BASE = "https://discord.com/api/v10";

/** Discord's own limits, minus a little headroom for the markdown we wrap around the text. */
const MAX_CONTENT = 1900;
const MAX_DESCRIPTION = 3800;
const MAX_FOOTER = 2000;

/** A burst of settling tasks must not grow an unbounded backlog of HTTP calls behind a rate limit. */
const MAX_QUEUED = 25;
const RATE_LIMIT_RETRIES = 2;
const REQUEST_TIMEOUT_MS = 8000;

export type OwnerNoticeKind = "done" | "input" | "failed";

/** One owner-facing event. `detail` is the "why" (the park reason, the question, the error). */
export interface OwnerNotice {
  kind: OwnerNoticeKind;
  title: string;
  detail?: string | null;
  /** The task's workspace path — shown as the repo name in the embed footer. */
  repo?: string | null;
}

export interface DiscordConfig {
  enabled: boolean;
  token?: string;
  channelId?: string;
  /** The owner's own Discord user — when set, notices go to their DMs and `channelId` is ignored. */
  userId?: string;
}

/** Where one send goes: a DM needs its channel opened first, a guild channel is posted to directly. */
type Destination = { dm: true; userId: string } | { dm: false; channelId: string };

function destinationOf(cfg: DiscordConfig): Destination | null {
  if (cfg.userId) return { dm: true, userId: cfg.userId };
  if (cfg.channelId) return { dm: false, channelId: cfg.channelId };
  return null;
}

interface DiscordEmbed {
  color: number;
  description?: string;
  footer?: { text: string };
}

export interface DiscordMessage {
  content: string;
  embeds?: DiscordEmbed[];
}

const STYLE: Record<OwnerNoticeKind, { lead: string; color: number }> = {
  // GitHub's own state palette — the same green/amber/red the console already uses for these states,
  // so a glance at the phone reads the same as a glance at the board.
  done: { lead: "✅ **Done**", color: 0x2ea043 },
  input: { lead: "🔔 **Needs you**", color: 0xd29922 },
  failed: { lead: "❌ **Failed**", color: 0xda3633 },
};

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/** The Discord payload for one notice. Pure — this is what the gate asserts on. */
export function formatNotice(notice: OwnerNotice): DiscordMessage {
  const style = STYLE[notice.kind];
  const title = clip(notice.title || "(untitled task)", 200);
  const content = clip(`${style.lead} — ${title}`, MAX_CONTENT);
  const description = notice.detail ? clip(notice.detail, MAX_DESCRIPTION) : "";
  const repo = notice.repo ? clip(basename(notice.repo.replace(/[\\/]+$/, "")), MAX_FOOTER) : "";
  if (!description && !repo) return { content };
  const embed: DiscordEmbed = { color: style.color };
  if (description) embed.description = description;
  if (repo) embed.footer = { text: repo };
  return { content, embeds: [embed] };
}

/**
 * The channel id out of whatever the operator pasted. Discord's UI hands you three shapes and only one
 * of them is the bare id: "Copy Channel ID" gives the snowflake, "Copy Link" gives
 * `…/channels/<guild>/<channel>`, and typing `#name` in the app leaves `<#channel>` — a link stored
 * verbatim 404s on every single notice, which looks like a broken feature rather than a bad paste. The
 * channel is the LAST snowflake in all three; anything with no snowflake in it degrades to its digits.
 */
export function parseChannelId(raw: string): string {
  return lastSnowflake(raw);
}

/** The user id out of a bare "Copy User ID" snowflake or a `<@id>` / `<@!id>` mention. */
export function parseUserId(raw: string): string {
  return lastSnowflake(raw);
}

function lastSnowflake(raw: string): string {
  const ids = raw.match(/\d{15,25}/g);
  return (ids ? ids[ids.length - 1]! : raw.replace(/\D/g, "")).slice(0, 32);
}

/** What a failed send means in the owner's terms — a 403 is an invite problem, not a token problem. */
function explainStatus(status: number, body: string): string {
  if (status === 401) return "Discord rejected the bot token (401) — check the token.";
  // 50007: the recipient's privacy settings refuse DMs from this bot, or it shares no server with them.
  if (body.includes("50007")) return "Discord won't let the bot DM you — share a server with it and allow DMs from that server's members.";
  if (status === 403) return "The bot can't post in that channel (403) — invite it to the server and give it Send Messages.";
  if (status === 404) return "No such channel (404) — check the channel ID.";
  return `Discord refused the message (${status})${body ? ` — ${clip(body, 200)}` : ""}.`;
}

export type SendResult = { ok: true } | { ok: false; message: string };

/**
 * Posts owner notices to the owner's DMs or one Discord channel. Sends are serialized through a promise chain: Discord
 * rate-limits per channel, and a settling burst that fires them in parallel earns a 429 for messages
 * that would each have gone through fine on their own.
 */
export class DiscordNotifier {
  private chain: Promise<void> = Promise.resolve();
  private queued = 0;
  private warnedIncomplete = false;
  /** userId → the DM channel Discord opened for it; opening is idempotent, so this only saves a call. */
  private readonly dmChannels = new Map<string, string>();

  constructor(
    private readonly config: () => DiscordConfig,
    private readonly log: (level: "info" | "warn", message: string) => void,
  ) {}

  /** Fire-and-forget: never throws, never blocks the caller's settle path. */
  notify(notice: OwnerNotice): void {
    const cfg = this.config();
    if (!cfg.enabled) return;
    const destination = destinationOf(cfg);
    if (!cfg.token || !destination) {
      // Once per gap, not once per task — an unconfigured toggle would otherwise fill the log.
      if (!this.warnedIncomplete) {
        this.warnedIncomplete = true;
        this.log("warn", `Discord notifications are on but ${cfg.token ? "no user or channel ID is set" : "no bot token is set"} — nothing sent.`);
      }
      return;
    }
    this.warnedIncomplete = false;
    this.enqueue("notification", async () => {
      const result = await this.deliver(cfg.token!, destination, formatNotice(notice));
      if (!result.ok) this.log("warn", `Discord notification failed: ${result.message}`);
    });
  }

  /** A director reply into the DM channel the owner wrote from, split to fit Discord's message limit.
   *  Rides the same serialized chain as the notices, so a long answer's parts arrive in order. */
  reply(channelId: string, text: string): void {
    const token = this.config().token;
    if (!token) return;
    for (const part of splitForDiscord(text)) {
      this.enqueue("reply", async () => {
        const { result } = await this.post(token, `channels/${encodeURIComponent(channelId)}/messages`, {
          content: part,
          allowed_mentions: { parse: [] },
        });
        if (!result.ok) this.log("warn", `Discord reply failed: ${result.message}`);
      });
    }
  }

  /** The "typing…" indicator in a DM channel; Discord shows it for ~10s or until the next message. */
  typing(channelId: string): void {
    const token = this.config().token;
    if (token) void this.post(token, `channels/${encodeURIComponent(channelId)}/typing`, {});
  }

  private enqueue(what: string, step: () => Promise<void>): void {
    if (this.queued >= MAX_QUEUED) {
      this.log("warn", `Discord ${what} dropped — ${MAX_QUEUED} already queued.`);
      return;
    }
    this.queued += 1;
    // A rejection here would poison the chain and silently mute every LATER send, so the whole step
    // is swallowed — a lost ping must never cost the next one.
    this.chain = this.chain.then(async () => {
      try {
        await step();
      } catch (e) {
        this.log("warn", `Discord ${what} failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        this.queued -= 1;
      }
    });
  }

  /** Post a one-off test message with the settings as they stand, and report what happened. */
  async test(): Promise<SendResult> {
    const cfg = this.config();
    if (!cfg.token) return { ok: false, message: "No bot token — paste one (or set DISCORD_BOT_TOKEN) first." };
    const destination = destinationOf(cfg);
    if (!destination) return { ok: false, message: "No user or channel ID — paste your Discord user ID (or a channel's) first." };
    const result = await this.deliver(cfg.token, destination, {
      content: "🔔 **Test** — orchestrator notifications are wired up.",
    });
    return result.ok ? { ok: true } : result;
  }

  private async deliver(token: string, destination: Destination, message: DiscordMessage): Promise<SendResult> {
    let channelId: string;
    if (destination.dm) {
      const dm = await this.dmChannel(token, destination.userId);
      if ("message" in dm) return { ok: false, message: dm.message };
      channelId = dm.channelId;
    } else {
      channelId = destination.channelId;
    }
    return (await this.post(token, `channels/${encodeURIComponent(channelId)}/messages`, message)).result;
  }

  /** The DM channel with `userId`, opened on first use. A 404 here means the USER id is wrong. */
  private async dmChannel(token: string, userId: string): Promise<{ channelId: string } | { message: string }> {
    const cached = this.dmChannels.get(userId);
    if (cached) return { channelId: cached };
    const { result, body } = await this.post(token, "users/@me/channels", { recipient_id: userId });
    if (!result.ok) {
      return { message: result.message.includes("(404)") ? "No such Discord user (404) — check your user ID." : result.message };
    }
    const id = (body as { id?: unknown } | null)?.id;
    if (typeof id !== "string" || !id) return { message: "Discord opened no DM channel for that user." };
    this.dmChannels.set(userId, id);
    return { channelId: id };
  }

  /** One POST, retrying a 429 in place for as long as Discord's own Retry-After says to. */
  private async post(token: string, path: string, payload: unknown): Promise<{ result: SendResult; body?: unknown }> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(`${API_BASE}/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bot ${token}` },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (e) {
        return { result: { ok: false, message: `Couldn't reach Discord — ${e instanceof Error ? e.message : String(e)}.` } };
      }
      if (res.ok) return { result: { ok: true }, body: await res.json().catch(() => null) };
      if (res.status === 429 && attempt < RATE_LIMIT_RETRIES) {
        await sleep(await retryAfterMs(res));
        continue;
      }
      return { result: { ok: false, message: explainStatus(res.status, await res.text().catch(() => "")) } };
    }
  }
}

/** `text` in parts of at most MAX_CONTENT characters, cut at a paragraph, line or word break where one
 *  is near, so a long director answer reads as consecutive messages rather than words sliced in half. */
export function splitForDiscord(text: string): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > MAX_CONTENT) {
    const window = rest.slice(0, MAX_CONTENT);
    const breaks = [window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(" ")];
    const cut = breaks.find((i) => i > MAX_CONTENT / 2) ?? MAX_CONTENT;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

/** Discord answers a 429 with `retry_after` seconds in the body (and the header); clamped so a bad
 *  value can't park a send for minutes. */
async function retryAfterMs(res: Response): Promise<number> {
  const header = Number(res.headers.get("retry-after"));
  let seconds = Number.isFinite(header) && header > 0 ? header : 0;
  if (!seconds) {
    const body = (await res.json().catch(() => null)) as { retry_after?: number } | null;
    seconds = typeof body?.retry_after === "number" ? body.retry_after : 1;
  }
  return Math.min(Math.max(seconds, 0.25), 10) * 1000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
