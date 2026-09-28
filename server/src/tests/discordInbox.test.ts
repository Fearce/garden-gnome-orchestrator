/**
 * Gate — Discord DMs to the director (`orchestrator/discordInbox.ts`, the `discord` source in
 * `director.ts`, and `DiscordNotifier.reply`).
 *
 * WHAT IS REAL: the gateway state machine (driven through a scripted socket, no network), the DM filter,
 * the reply relay over a real EventHub, and a real Director + ThreadManager on a throwaway DB whose model
 * run is a stub that records what it was sent. Global `fetch` is never touched: every REST call goes
 * through an injected recorder.
 *
 *   A. FILTER   — only the owner's own DMs pass; guild messages, strangers, bots and empty messages don't.
 *   B. GATEWAY  — IDENTIFY with the DM intent, heartbeats, READY status, reconnect + RESUME, a fatal
 *                 close stops for good until the config changes, and disable disconnects.
 *   C. CATCH-UP — a fresh session hands over DMs sent while GGO was down; old ones get a "resend" reply.
 *   D. INPUT    — images are downloaded for the director; anything else is named, not silently dropped.
 *   E. END TO END — a DM becomes a director turn tagged [DISCORD]; that turn's replies go back to the
 *                 DM, the window closes when the director goes idle, and a console turn never leaks.
 *   F. SPLIT    — a long reply is cut into Discord-sized parts at a break.
 *
 * Run: npm run test:discord-inbox (from server/). Exits non-zero on any failure.
 */
process.env.CAP_RETRY_MS = "0";
process.env.ACCOUNT_PING_MS = "3600000";
process.env.FAST_ACCOUNT_PING_MS = "3600000";

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountManager } from "../accounts/accountManager.js";
import type { UserContent } from "../agents/runner.js";
import type { Scheduler } from "../orchestrator/scheduler.js";
import type { OperatorNotes } from "../orchestrator/notes.js";
import type { GatewaySocket, InboxConfig, InboxHost, OwnerDm } from "../orchestrator/discordInbox.js";

const { ownerDmFrom, directorInputFor, DiscordInbox, startDiscordInbox } = await import("../orchestrator/discordInbox.js");
const { splitForDiscord } = await import("../orchestrator/discordNotify.js");
const { Db } = await import("../db/db.js");
const { EventHub } = await import("../events.js");
const { FileMemoryService } = await import("../memory/memory.js");
const { ThreadManager } = await import("../orchestrator/threadManager.js");
const { Director } = await import("../orchestrator/director.js");

const OWNER = "111909686583828480";
const STRANGER = "222222222222222222";
const DM_CHANNEL = "1500000000000000001";
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

/** A snowflake minted `agoMs` in the past, so catch-up can tell fresh from stale. */
function snowflake(agoMs: number, n = 0): string {
  return String(((BigInt(Date.now() - agoMs) - 1420070400000n) << 22n) + BigInt(n));
}

function dmPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: snowflake(0), channel_id: DM_CHANNEL, content: "start a task", author: { id: OWNER }, attachments: [], ...over };
}

// ---- A. FILTER ----------------------------------------------------------------------------------------
assert.equal(ownerDmFrom(dmPayload(), OWNER)?.text, "start a task", "the owner's DM passes");
assert.equal(ownerDmFrom(dmPayload({ guild_id: "9" }), OWNER), null, "a server message is not a DM");
assert.equal(ownerDmFrom(dmPayload({ author: { id: STRANGER } }), OWNER), null, "a stranger's DM is ignored");
assert.equal(ownerDmFrom(dmPayload({ author: { id: OWNER, bot: true } }), OWNER), null, "a bot author is ignored");
assert.equal(ownerDmFrom(dmPayload({ content: "   " }), OWNER), null, "an empty message is ignored");
assert.equal(ownerDmFrom(dmPayload(), ""), null, "no owner configured → nothing passes");
assert.equal(
  ownerDmFrom(dmPayload({ content: "", attachments: [{ url: "https://cdn/x.png", filename: "x.png", content_type: "image/png", size: 3 }] }), OWNER)?.attachments.length,
  1,
  "an image-only DM passes",
);

// ---- B. GATEWAY ---------------------------------------------------------------------------------------
class FakeSocket implements GatewaySocket {
  readonly sent: Array<{ op: number; d: unknown }> = [];
  closedWith: number | null = null;
  private readonly handlers = new Map<string, (...args: unknown[]) => void>();
  constructor(readonly url: string) {}
  send(data: string): void { this.sent.push(JSON.parse(data)); }
  close(code?: number): void { this.closedWith = code ?? 1000; }
  on(event: string, cb: (...args: never[]) => void): unknown {
    this.handlers.set(event, cb as (...args: unknown[]) => void);
    return this;
  }
  frame(f: Record<string, unknown>): void { this.handlers.get("message")?.(JSON.stringify(f)); }
  serverClose(code: number): void { this.handlers.get("close")?.(code); }
}

function makeHost(cfg: InboxConfig, lastSeen: string | null = null) {
  const statuses: string[] = [];
  const dms: OwnerDm[] = [];
  const stale: Array<{ channelId: string; count: number; newestId: string }> = [];
  const host: InboxHost = {
    config: () => cfg,
    onOwnerDm: (dm) => dms.push(dm),
    status: (t) => statuses.push(t),
    log: () => {},
    lastSeenId: () => lastSeen,
    onStaleDms: (channelId, count, newestId) => stale.push({ channelId, count, newestId }),
  };
  return { host, statuses, dms, stale };
}

{
  const cfg: InboxConfig = { enabled: true, token: "tok", userId: OWNER };
  const { host, statuses, dms } = makeHost(cfg);
  const sockets: FakeSocket[] = [];
  const inbox = new DiscordInbox(host, (url) => {
    const s = new FakeSocket(url);
    sockets.push(s);
    return s;
  });
  inbox.reconcile();
  assert.equal(sockets.length, 1, "enabled + token + owner connects");
  const s0 = sockets[0]!;
  assert.match(s0.url, /gateway\.discord\.gg/);
  s0.frame({ op: 10, d: { heartbeat_interval: 60_000 } });
  const identify = s0.sent.find((f) => f.op === 2)?.d as { token: string; intents: number };
  assert.equal(identify.token, "tok", "IDENTIFY carries the token");
  assert.equal(identify.intents, 1 << 12, "only the Direct Messages intent — no privileged intents");
  s0.frame({ op: 1 });
  assert.ok(s0.sent.some((f) => f.op === 1), "a server heartbeat request is answered at once");
  s0.frame({ op: 0, s: 1, t: "READY", d: { session_id: "sess", resume_gateway_url: "wss://resume.example", user: { username: "kevclaude" } } });
  assert.match(statuses.at(-1)!, /Listening — DM @kevclaude/);
  s0.frame({ op: 0, s: 2, t: "MESSAGE_CREATE", d: dmPayload({ id: "5001" }) });
  s0.frame({ op: 0, s: 3, t: "MESSAGE_CREATE", d: dmPayload({ id: "5002", author: { id: STRANGER } }) });
  assert.deepEqual(dms.map((d) => d.messageId), ["5001"], "only the owner's DM is handed over");

  // Discord asks for a reconnect: the next socket goes to the resume URL and RESUMEs with the last seq.
  s0.frame({ op: 7 });
  assert.equal(s0.closedWith, 4000, "a reconnect request closes the old socket resumably");
  await new Promise((r) => setTimeout(r, 1_100));
  const s1 = sockets[1]!;
  assert.ok(s1, "reconnected after the backoff");
  assert.match(s1.url, /^wss:\/\/resume\.example\//, "reconnects to the session's resume URL");
  s1.frame({ op: 10, d: { heartbeat_interval: 60_000 } });
  const resume = s1.sent.find((f) => f.op === 6)?.d as { session_id: string; seq: number };
  assert.deepEqual([resume.session_id, resume.seq], ["sess", 3], "RESUME carries the session and last seq");

  // A bad token is fatal: no reconnect loop, the status says why, and a settings echo doesn't retry it.
  s1.serverClose(4004);
  await new Promise((r) => setTimeout(r, 1_200));
  assert.equal(sockets.length, 2, "a fatal close does not reconnect");
  assert.match(statuses.at(-1)!, /rejected the bot token/);
  inbox.reconcile();
  assert.equal(sockets.length, 2, "an unchanged config after a fatal close stays stopped");
  cfg.token = "tok2";
  inbox.reconcile();
  assert.equal(sockets.length, 3, "a new token reconnects");
  cfg.enabled = false;
  inbox.reconcile();
  assert.equal(sockets[2]!.closedWith, 1000, "disabling disconnects");
  assert.equal(statuses.at(-1), "Off.");

  const noOwner = makeHost({ enabled: true, token: "tok", userId: "" });
  const idle = new DiscordInbox(noOwner.host, () => assert.fail("must not connect without an owner id"));
  idle.reconcile();
  assert.match(noOwner.statuses.at(-1)!, /Waiting for your Discord user ID/);
}

// ---- C. CATCH-UP --------------------------------------------------------------------------------------
{
  const lastSeen = snowflake(3 * 60 * 60 * 1000, 0);
  const staleId = snowflake(2 * 60 * 60 * 1000, 1);
  const fresh1 = snowflake(60_000, 2);
  const fresh2 = snowflake(30_000, 3);
  const { host, dms, stale } = makeHost({ enabled: true, token: "tok", userId: OWNER }, lastSeen);
  const calls: string[] = [];
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method} ${url}`);
    if (url.endsWith("/users/@me/channels")) return new Response(JSON.stringify({ id: DM_CHANNEL }));
    // Discord returns newest first; the inbox must hand them over oldest first.
    return new Response(JSON.stringify([
      dmPayload({ id: fresh2, content: "second" }),
      dmPayload({ id: fresh1, content: "first" }),
      dmPayload({ id: snowflake(10_000, 4), author: { id: "1492466433605636157", bot: true }, content: "bot's own reply" }),
      dmPayload({ id: staleId, content: "old" }),
    ]));
  }) as typeof fetch;
  let socket: FakeSocket | null = null;
  const inbox = new DiscordInbox(host, (url) => (socket = new FakeSocket(url)), fakeFetch);
  inbox.reconcile();
  socket!.frame({ op: 0, s: 1, t: "READY", d: { session_id: "s", resume_gateway_url: "wss://r", user: { username: "kevclaude" } } });
  await settle();
  assert.ok(calls.some((c) => c.includes(`/channels/${DM_CHANNEL}/messages?after=${lastSeen}`)), "catch-up reads the DM channel after the last seen id");
  assert.deepEqual(dms.map((d) => d.text), ["first", "second"], "missed DMs are handed over oldest first, the bot's own skipped");
  assert.deepEqual(stale, [{ channelId: DM_CHANNEL, count: 1, newestId: staleId }], "an over-an-hour-old DM is reported, not acted on");
  inbox.stop();

  const first = makeHost({ enabled: true, token: "tok", userId: OWNER }, null);
  const noFetch = (async () => assert.fail("no catch-up before any DM was ever seen")) as typeof fetch;
  let s2: FakeSocket | null = null;
  const inbox2 = new DiscordInbox(first.host, (url) => (s2 = new FakeSocket(url)), noFetch);
  inbox2.reconcile();
  s2!.frame({ op: 0, s: 1, t: "READY", d: { session_id: "s" } });
  await settle();
  inbox2.stop();
}

// ---- D. INPUT -----------------------------------------------------------------------------------------
{
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const fetchImage = (async () => new Response(png)) as unknown as typeof fetch;
  const dm = ownerDmFrom(dmPayload({
    content: "what's wrong here?",
    attachments: [
      { url: "https://cdn/a.png", filename: "a.png", content_type: "image/png", size: 4 },
      { url: "https://cdn/log.txt", filename: "log.txt", content_type: "text/plain", size: 10 },
      { url: "https://cdn/huge.png", filename: "huge.png", content_type: "image/png", size: 50 * 1024 * 1024 },
    ],
  }), OWNER)!;
  const input = await directorInputFor(dm, fetchImage);
  assert.equal(input.images.length, 1, "the small image is passed on");
  assert.equal(input.images[0]!.dataBase64, png.toString("base64"));
  assert.equal(input.images[0]!.mediaType, "image/png");
  assert.match(input.text, /^what's wrong here\?/);
  assert.match(input.text, /log\.txt, huge\.png/, "files left out are named for the director");
}

// ---- E. END TO END through a real Director ------------------------------------------------------------
class StubAccounts {
  onUsageRefresh(_cb: () => void): void {}
  effectiveUtilization(): number | null { return null; }
  soonestResetAt(): number | null { return null; }
  hasHeadroom(): boolean { return true; }
  setPingInterval(_ms: number): void {}
  applyEnabled(_id: string, _enabled: boolean): void {}
  applyWeeklySafetyPct(_id: string, _pct: number): void {}
  setSpreadUsage(_on: boolean): void {}
  setProfileToken(_id: string, _token: string): void {}
  isModelLimited(_id: string, _model: string): boolean { return false; }
  auxToken(): string | undefined { return undefined; }
}

const dir = mkdtempSync(join(tmpdir(), "discord-inbox-"));
const db = new Db(join(dir, "orchestrator.sqlite"));
const mgr = new ThreadManager(db, new EventHub(), new FileMemoryService(join(dir, "memory")), new StubAccounts() as unknown as AccountManager);
try {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = mgr as any;
  const target = { key: "claude:test", provider: "claude", model: "test-model", accountId: "a", accountLabel: "a" };
  internals.directorTargets = () => [target];
  internals.directorTargetReady = () => true;
  const sentToModel: string[] = [];
  const asText = (c: UserContent): string => (typeof c === "string" ? c : JSON.stringify(c));
  internals.createDirectorAgent = () => ({
    finished: false, rateLimited: false, capped: false,
    onEvent: () => () => {}, onEnd: () => {},
    start(content: UserContent) { sentToModel.push(asText(content)); return this; },
    send(content: UserContent) { sentToModel.push(asText(content)); },
    stop: async () => {},
  });
  const director = new Director(mgr, db, internals.hub, {} as Scheduler, {} as OperatorNotes);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dInternals = director as any;
  dInternals.chooseTarget = async () => target;

  const replies: Array<{ channelId: string; text: string }> = [];
  const typing: string[] = [];
  let lastSeen: string | null = null;
  let socket: FakeSocket | null = null;
  const statuses: string[] = [];
  // The inbox is built by the same factory index.ts uses, over the manager's own config getter.
  db.kvSet("discord_bot_token", "tok");
  db.kvSet("setting_discord_user_id", OWNER);
  const inbox = startDiscordInbox({
    hub: internals.hub,
    config: () => mgr.discordInboxConfig(),
    status: (t) => statuses.push(t),
    transport: { reply: (channelId, text) => replies.push({ channelId, text }), typing: (c) => typing.push(c) },
    directorBusy: () => director.activeWorkCount() > 0,
    lastSeen: { get: () => lastSeen, set: (id) => (lastSeen = id) },
    toDirector: (text, images, messageId) => director.handleUserMessage(text, undefined, images, "discord", messageId),
  });
  // startDiscordInbox builds its own DiscordInbox with the real `ws`; swap in the scripted socket.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inboxInternals = inbox as any;
  inbox.stop();
  inboxInternals.openSocket = (url: string) => (socket = new FakeSocket(url));
  inboxInternals.configKey = null;
  inbox.reconcile();
  assert.equal(mgr.discordInboxConfig().enabled, true, "the inbox is on by default");

  socket!.frame({ op: 0, s: 1, t: "READY", d: { session_id: "s", user: { username: "kevclaude" } } });
  const dmId = snowflake(0, 7);
  socket!.frame({ op: 0, s: 2, t: "MESSAGE_CREATE", d: dmPayload({ id: dmId, content: "Fix the login bug in my web app" }) });
  await settle();
  assert.equal(sentToModel.length, 1, "the DM started a director turn");
  assert.match(sentToModel[0]!, /\nFix the login bug in my web app\n/);
  assert.match(sentToModel[0]!, /\[DISCORD — /, "the director is told the message came from Discord");
  assert.ok(db.directorMessage(`discord-${dmId}`), "the DM is in the director chat, keyed by its Discord id");
  assert.equal(lastSeen, dmId, "the DM is remembered for catch-up");
  assert.deepEqual(typing, [DM_CHANNEL], "the typing indicator shows at once");

  dInternals.postModelMessage("On it — dispatched *Fix login bug*.");
  assert.deepEqual(replies, [{ channelId: DM_CHANNEL, text: "On it — dispatched *Fix login bug*." }], "the director's reply goes back to the DM");

  // A replayed DM (a catch-up overlapping a live delivery) is not a second turn.
  socket!.frame({ op: 0, s: 3, t: "MESSAGE_CREATE", d: dmPayload({ id: dmId, content: "Fix the login bug in my web app" }) });
  await settle();
  assert.equal(sentToModel.length, 1, "the same Discord message never starts a second turn");

  director.cancelTurn();
  assert.equal(director.activeWorkCount(), 0);
  assert.match(replies.at(-1)!.text, /^Stopped that turn/, "the turn's closing note still reaches the DM");
  const relayed = replies.length;
  dInternals.run = undefined;
  director.handleUserMessage("a console-only question");
  await settle();
  dInternals.postModelMessage("console answer");
  assert.equal(replies.length, relayed, "once the Discord turn ended, a console turn's replies stay off Discord");
  director.cancelTurn();
  inbox.stop();
} finally {
  db.raw.close();
  rmSync(dir, { recursive: true, force: true });
}

// ---- F. SPLIT -----------------------------------------------------------------------------------------
{
  assert.deepEqual(splitForDiscord("short"), ["short"]);
  const para = "word ".repeat(300).trim();
  const parts = splitForDiscord(`${para}\n\n${para}`);
  assert.ok(parts.every((p) => p.length <= 1900), "every part fits Discord's limit");
  assert.equal(parts.join(" ").split(/\s+/).length, 600, "no word is lost or cut");
  assert.ok(parts.every((p) => !p.startsWith(" ") && !p.endsWith(" ")));
}

console.log("discord-inbox: all checks passed");
process.exit(0);
