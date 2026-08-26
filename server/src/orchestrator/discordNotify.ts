// Phone notifications: the three moments the owner personally cares about — a task finished, a task
// needs their input, a task failed — posted as a Discord message by a bot they already have on their
// phone. Everything else `notifyExternal` sends is pipeline chatter (cap failover, account resume) and
// deliberately never reaches here; a channel that buzzes for routine routing stops being read.
//
// The push preview on a phone comes from `content`, NOT from an embed, so the essential line lives in
// content and the embed only carries the detail (park reason / question / error) and the repo. Best-
// effort end to end: no token, no channel, or the toggle off → nothing is sent and nothing throws.

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
  const ids = raw.match(/\d{15,25}/g);
  return (ids ? ids[ids.length - 1]! : raw.replace(/\D/g, "")).slice(0, 32);
}

/** What a failed send means in the owner's terms — a 403 is an invite problem, not a token problem. */
function explainStatus(status: number, body: string): string {
  if (status === 401) return "Discord rejected the bot token (401) — check the token.";
  if (status === 403) return "The bot can't post in that channel (403) — invite it to the server and give it Send Messages.";
  if (status === 404) return "No such channel (404) — check the channel ID.";
  return `Discord refused the message (${status})${body ? ` — ${clip(body, 200)}` : ""}.`;
}

export type SendResult = { ok: true } | { ok: false; message: string };

/**
 * Posts owner notices to one Discord channel. Sends are serialized through a promise chain: Discord
 * rate-limits per channel, and a settling burst that fires them in parallel earns a 429 for messages
 * that would each have gone through fine on their own.
 */
export class DiscordNotifier {
  private chain: Promise<void> = Promise.resolve();
  private queued = 0;
  private warnedIncomplete = false;

  constructor(
    private readonly config: () => DiscordConfig,
    private readonly log: (level: "info" | "warn", message: string) => void,
  ) {}

  /** Fire-and-forget: never throws, never blocks the caller's settle path. */
  notify(notice: OwnerNotice): void {
    const cfg = this.config();
    if (!cfg.enabled) return;
    if (!cfg.token || !cfg.channelId) {
      // Once per gap, not once per task — an unconfigured toggle would otherwise fill the log.
      if (!this.warnedIncomplete) {
        this.warnedIncomplete = true;
        this.log("warn", `Discord notifications are on but ${cfg.token ? "no channel ID is set" : "no bot token is set"} — nothing sent.`);
      }
      return;
    }
    this.warnedIncomplete = false;
    if (this.queued >= MAX_QUEUED) {
      this.log("warn", `Discord notification dropped — ${MAX_QUEUED} already queued.`);
      return;
    }
    this.queued += 1;
    // A rejection here would poison the chain and silently mute every LATER notice, so the whole step
    // is swallowed — a lost ping must never cost the next one.
    this.chain = this.chain.then(async () => {
      try {
        const result = await this.send(cfg.token!, cfg.channelId!, formatNotice(notice));
        if (!result.ok) this.log("warn", `Discord notification failed: ${result.message}`);
      } catch (e) {
        this.log("warn", `Discord notification failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        this.queued -= 1;
      }
    });
  }

  /** Post a one-off test message with the settings as they stand, and report what happened. */
  async test(): Promise<SendResult> {
    const cfg = this.config();
    if (!cfg.token) return { ok: false, message: "No bot token — paste one (or set DISCORD_BOT_TOKEN) first." };
    if (!cfg.channelId) return { ok: false, message: "No channel ID — paste the Discord channel's ID first." };
    const result = await this.send(cfg.token, cfg.channelId, {
      content: "🔔 **Test** — orchestrator notifications are wired up.",
    });
    return result.ok ? { ok: true } : result;
  }

  /** One POST, retrying a 429 in place for as long as Discord's own Retry-After says to. */
  private async send(token: string, channelId: string, message: DiscordMessage): Promise<SendResult> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(`${API_BASE}/channels/${encodeURIComponent(channelId)}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bot ${token}` },
          body: JSON.stringify(message),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (e) {
        return { ok: false, message: `Couldn't reach Discord — ${e instanceof Error ? e.message : String(e)}.` };
      }
      if (res.ok) return { ok: true };
      if (res.status === 429 && attempt < RATE_LIMIT_RETRIES) {
        await sleep(await retryAfterMs(res));
        continue;
      }
      return { ok: false, message: explainStatus(res.status, await res.text().catch(() => "")) };
    }
  }
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
