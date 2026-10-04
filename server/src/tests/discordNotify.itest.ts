/**
 * Integration test — Discord phone notifications (`orchestrator/discordNotify.ts` + the ThreadManager
 * routing that feeds it).
 *
 * The feature's whole value is that the channel is worth reading: it buzzes for the three moments the
 * owner acts on (a task finished, a task needs them, a task failed) and stays silent for everything the
 * pipeline handles itself. That policy lives in ThreadManager — `notifyOwner` posts to Discord,
 * `notifyExternal` does not — so a routing regression is invisible to any test of the module alone.
 * Section D drives the REAL transitions and asserts what did and did not reach the channel.
 *
 * WHAT IS REAL: a real on-disk SQLite Db, a real ThreadManager and a real AccountManager (never started,
 * so no pings/timers). No agents are spawned and no HTTPS leaves the box — global `fetch` is stubbed and
 * every request is recorded, which is also how the voice-gateway probe inside the `done` path is answered.
 *
 * Scenarios:
 *   A. FORMAT   — the push preview lives in `content`; the embed carries detail + repo + a per-kind color.
 *   B. GATING   — the toggle off, or no token/channel, sends nothing at all (and warns once, not per task).
 *   C. TRANSPORT— the right URL + `Bot` auth; a 429 retries; a refusal is explained and can't mute the next one;
 *                 a user id DMs the owner (opening the DM channel once) instead of posting in the channel.
 *   D. ROUTING  — done/review/failed/ask_user post; a cap-park and ordinary pipeline chatter do NOT.
 *   E. REMINDERS— a scheduled reminder's own text reaches the DM, and its sender learns whether it did.
 *
 * Run:  npm run test:discord-notify   (from server/)   — or:  npx tsx src/tests/discordNotify.itest.ts
 * Exits non-zero if any assertion fails. Self-contained: throwaway DB in a temp dir, removed on exit.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { formatNotice, formatReminder, parseChannelId, parseUserId, DiscordNotifier } = await import("../orchestrator/discordNotify.js");
const { Db } = await import("../db/db.js");
const { EventHub } = await import("../events.js");
const { FileMemoryService } = await import("../memory/memory.js");
const { AccountManager } = await import("../accounts/accountManager.js");
const { ResetStagger } = await import("../accounts/resetStagger.js");
const { ThreadManager } = await import("../orchestrator/threadManager.js");
const { config } = await import("../config.js");
import type { Thread } from "../types.js";
import type { DiscordConfig, OwnerNotice } from "../orchestrator/discordNotify.js";

// ---- tiny assertion harness ------------------------------------------------------------------------
let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    failures.push(label + (detail ? ` — ${detail}` : ""));
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---- the fetch stub: records every Discord POST, answers the voice probe ------------------------------
interface Posted {
  url: string;
  auth: string;
  content: string;
  embed?: { color: number; description?: string; footer?: { text: string } };
  /** Set on a DM-open call (`POST /users/@me/channels`). */
  recipient?: string;
}
const realFetch = globalThis.fetch;
let posted: Posted[] = [];
/** Statuses to answer with, consumed in order; anything past the end is a 200. */
let statuses: number[] = [];
let inFlight = 0;
let maxInFlight = 0;

globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const href = String(url);
  // completionAnnouncement probes the voice gateway inside the `done` path — report voice mode OFF so it
  // returns null without a model call, exactly as it does on a box with no gateway running.
  if (!href.includes("discord.com")) return new Response("", { status: 503 });
  const body = JSON.parse(String(init?.body ?? "{}")) as { content: string; embeds?: Posted["embed"][]; recipient_id?: string };
  posted.push({
    url: href,
    auth: String((init?.headers as Record<string, string> | undefined)?.authorization ?? ""),
    content: body.content,
    embed: body.embeds?.[0],
    recipient: body.recipient_id,
  });
  inFlight++;
  maxInFlight = Math.max(maxInFlight, inFlight);
  await new Promise((r) => setTimeout(r, 5)); // a real POST takes time; this is what makes overlap observable
  inFlight--;
  const status = statuses.shift() ?? 200;
  if (status === 429) return new Response(JSON.stringify({ retry_after: 0.25 }), { status: 429 });
  if (status === 403 && body.content !== undefined && href.includes("/channels/dm-")) {
    return new Response(JSON.stringify({ message: "Cannot send messages to this user", code: 50007 }), { status: 403 });
  }
  // Opening a DM answers with the DM channel object — its id is where the message then goes.
  if (href.endsWith("/users/@me/channels")) return new Response(JSON.stringify({ id: `dm-${body.recipient_id}` }), { status });
  return new Response("", { status });
}) as typeof fetch;

function reset(next: number[] = []): void {
  posted = [];
  statuses = next;
  maxInFlight = 0;
}

/** Let the notifier's serialized send chain drain (it is deliberately fire-and-forget). */
async function settle(): Promise<void> {
  for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 12));
}

const warnings: string[] = [];
function notifierFor(cfg: DiscordConfig): InstanceType<typeof DiscordNotifier> {
  return new DiscordNotifier(
    () => cfg,
    (level, message) => {
      if (level === "warn") warnings.push(message);
    },
  );
}
const NOTICE: OwnerNotice = { kind: "done", title: "Ship the thing", repo: "C:\\repos\\garden-gnome" };

// ---- A. the payload --------------------------------------------------------------------------------
console.log("\nA. the message a phone actually shows");
{
  const done = formatNotice({ kind: "done", title: "Ship the thing", repo: "C:\\repos\\garden-gnome" });
  // A phone's push preview is built from `content`; an embed-only message previews as "sent an embed".
  check("the state and the title are both in content", done.content.includes("Done") && done.content.includes("Ship the thing"));
  check("the repo shows as its folder name, not the full path", done.embeds?.[0]?.footer?.text === "garden-gnome");
  check("a done notice is green", done.embeds?.[0]?.color === 0x2ea043);

  const input = formatNotice({ kind: "input", title: "Menu ingest", detail: "Which currency should prices use?" });
  check("a needs-you notice is amber", input.embeds?.[0]?.color === 0xd29922);
  check("the reason it needs you is the embed description", input.embeds?.[0]?.description === "Which currency should prices use?");

  const fail = formatNotice({ kind: "failed", title: "Nightly sweep", detail: "workspace does not exist" });
  check("a failed notice is red", fail.embeds?.[0]?.color === 0xda3633);

  const bare = formatNotice({ kind: "done", title: "No detail, no repo" });
  check("no detail and no repo means no empty embed", bare.embeds === undefined);

  const huge = formatNotice({ kind: "failed", title: "T".repeat(500), detail: "e".repeat(9000), repo: "/x/y" });
  check("the title is clipped inside Discord's content limit", huge.content.length <= 2000);
  check("the detail is clipped inside Discord's embed limit", (huge.embeds?.[0]?.description ?? "").length <= 4096);

  check("an empty title still says something", formatNotice({ kind: "done", title: "" }).content.includes("untitled"));

  // Discord's UI hands the operator three shapes and only one is the bare id. A link stored verbatim
  // 404s on every notice, which reads as a broken feature rather than a bad paste.
  const CHANNEL = "200000000000000002";
  check("a bare channel id is kept", parseChannelId(CHANNEL) === CHANNEL);
  check("Copy Link gives guild/channel — the CHANNEL is the last one", parseChannelId(`https://discord.com/channels/300000000000000003/${CHANNEL}`) === CHANNEL);
  check("a <#id> mention is unwrapped", parseChannelId(`<#${CHANNEL}>`) === CHANNEL);
  check("surrounding whitespace/quotes don't survive", parseChannelId(` "${CHANNEL}" `) === CHANNEL);
  check("nothing id-shaped degrades to empty, not to junk", parseChannelId("#general") === "");

  const USER = "100000000000000001";
  check("a bare user id is kept", parseUserId(USER) === USER);
  check("a <@!id> user mention is unwrapped", parseUserId(`<@!${USER}>`) === USER);
}

// ---- B. gating -------------------------------------------------------------------------------------
console.log("\nB. nothing is sent unless it is switched on AND configured");
{
  reset();
  notifierFor({ enabled: false, token: "t", channelId: "1" }).notify(NOTICE);
  await settle();
  check("the toggle off sends nothing", posted.length === 0);

  reset();
  warnings.length = 0;
  const half = notifierFor({ enabled: true, token: undefined, channelId: "1" });
  half.notify(NOTICE);
  half.notify(NOTICE);
  await settle();
  check("on but no token sends nothing", posted.length === 0);
  check("a missing token warns ONCE, not once per task", warnings.length === 1, `warned ${warnings.length}×`);
  check("the warning names what is missing", warnings[0]?.includes("bot token") === true);

  reset();
  warnings.length = 0;
  notifierFor({ enabled: true, token: "t", channelId: "" }).notify(NOTICE);
  await settle();
  check("on but no channel sends nothing", posted.length === 0);
  check("the warning names the channel, not the token", warnings[0]?.includes("channel") === true);
}

// ---- C. transport ----------------------------------------------------------------------------------
console.log("\nC. the HTTP call, and what happens when Discord says no");
{
  reset();
  notifierFor({ enabled: true, token: "tok-123", channelId: "200000000000000002" }).notify(NOTICE);
  await settle();
  check("posts to the channel's messages endpoint", posted[0]?.url.endsWith("/channels/200000000000000002/messages") === true);
  check("authenticates as a BOT, not a bearer token", posted[0]?.auth === "Bot tok-123");

  reset([429]);
  notifierFor({ enabled: true, token: "t", channelId: "1" }).notify(NOTICE);
  await settle();
  check("a rate limit is retried in place, not dropped", posted.length === 2, `${posted.length} attempt(s)`);

  reset([403]);
  warnings.length = 0;
  const refused = notifierFor({ enabled: true, token: "t", channelId: "1" });
  refused.notify(NOTICE);
  await settle();
  check("a 403 is explained as an invite problem, not a token problem", warnings[0]?.includes("Send Messages") === true, warnings[0]);

  // The failure above must not poison the shared send chain — that would mute every LATER notice silently.
  reset();
  refused.notify(NOTICE);
  await settle();
  check("a refused send doesn't mute the next one", posted.length === 1);

  reset();
  const busy = notifierFor({ enabled: true, token: "t", channelId: "1" });
  for (let i = 0; i < 4; i++) busy.notify({ ...NOTICE, title: `task ${i}` });
  await settle();
  check("a settling burst is sent, all of it", posted.length === 4, `${posted.length} sent`);
  check("…serialized, so Discord doesn't rate-limit them against each other", maxInFlight === 1, `${maxInFlight} concurrent`);

  reset([401]);
  const result = await notifierFor({ enabled: true, token: "bad", channelId: "1" }).test();
  check("the test button reports a bad token in the owner's words", !result.ok && result.message.includes("401"));
  const unset = await notifierFor({ enabled: true, token: undefined, channelId: "1" }).test();
  check("the test button says what is missing before it sends", !unset.ok && unset.message.includes("bot token"));

  reset();
  const dm = notifierFor({ enabled: true, token: "t", channelId: "200000000000000002", userId: "100000000000000001" });
  dm.notify(NOTICE);
  await settle();
  check("a user id opens a DM with that user", posted[0]?.url.endsWith("/users/@me/channels") === true && posted[0]?.recipient === "100000000000000001");
  check("…and the notice goes to the DM, not the channel", posted.length === 2 && posted[1]?.url.endsWith("/channels/dm-100000000000000001/messages") === true, posted.map((p) => p.url).join(", "));
  check("…with the notice itself intact", posted[1]?.content === formatNotice(NOTICE).content);

  reset();
  dm.notify(NOTICE);
  await settle();
  check("the DM channel is opened once, not once per notice", posted.length === 1 && posted[0]?.url.endsWith("/channels/dm-100000000000000001/messages") === true);

  reset([200, 403]);
  const blocked = await notifierFor({ enabled: true, token: "t", userId: "222222222222222222" }).test();
  check("a DM the owner's privacy settings refuse is explained as such", !blocked.ok && blocked.message.includes("DM"), blocked.ok ? "ok" : blocked.message);

  reset([404]);
  const nobody = await notifierFor({ enabled: true, token: "t", userId: "333333333333333333" }).test();
  check("an unknown user id is named as the user id, not the channel", !nobody.ok && nobody.message.includes("user ID"), nobody.ok ? "ok" : nobody.message);
}

// ---- D. routing — the invariant that keeps the channel worth reading --------------------------------
console.log("\nD. which pipeline events reach the phone");

type Priv = {
  setState(id: string, state: Thread["state"], error?: string | null): void;
  notifyExternal(text: string): void;
};

const dir = mkdtempSync(join(tmpdir(), "discord-notify-"));
const db = new Db(join(dir, "t.sqlite"));
const hub = new EventHub();
const memory = new FileMemoryService();
const accounts = new AccountManager(config.accounts, hub, config.accountPingMs, {
  stagger: new ResetStagger(),
  persist: { load: () => null, save: () => {} },
});
// NB: accounts.start() is deliberately NOT called — no pings/timers, so the process stays deterministic.
const manager = new ThreadManager(db, hub, memory, accounts);
const priv = manager as unknown as Priv;
manager.setSettings({ discordNotify: true, discordChannelId: "200000000000000002", discordBotToken: "tok-abc" });

function newThread(title: string): string {
  return db.createThread({ title, workspace: dir, rawPrompt: "x" }).id;
}
/** Run one transition and report what it posted. */
async function afterTransition(run: () => void): Promise<Posted[]> {
  reset();
  run();
  await settle();
  return posted;
}

{
  const sent = await afterTransition(() => priv.setState(newThread("Ship the thing"), "done"));
  check("a finished task reaches the phone", sent.length === 1 && (sent[0]?.content ?? "").includes("Ship the thing"));
  check("…and reads as done", sent[0]?.content.includes("Done") === true);
  // The operator's token must BEAT the env fallback. Not academic: this box carries a machine-wide
  // DISCORD_BOT_TOKEN for a different bot, which dotenv can't override — so the settings value is the
  // only way the intended bot posts, and "it posted at all" would pass while the wrong bot spoke.
  // The detail is MASKED: when this fails, whatever won is a real bot token from the environment, and a
  // failure message is exactly the string that ends up pasted into a log or a report.
  check("the token typed into Settings beats the env fallback", sent[0]?.auth === "Bot tok-abc", `used ••••${(sent[0]?.auth ?? "").slice(-4)}`);
  check("…and so does the channel typed into Settings", sent[0]?.url.endsWith("/channels/200000000000000002/messages") === true);
}
{
  const sent = await afterTransition(() => priv.setState(newThread("Menu ingest"), "review", "QA found two blockers."));
  check("a task parked for review reaches the phone", sent.length === 1 && (sent[0]?.content ?? "").includes("Needs you"));
  check("…carrying the reason it parked", sent[0]?.embed?.description === "QA found two blockers.");
}
{
  const sent = await afterTransition(() => priv.setState(newThread("Nightly sweep"), "failed", "workspace does not exist"));
  check("a failed task reaches the phone", sent.length === 1 && (sent[0]?.content ?? "").includes("Failed"));
}
{
  // The cap supervisor resumes this one by itself, so buzzing a phone about it is a false alarm — and it
  // re-fires every time a re-capping task re-parks.
  const sent = await afterTransition(() => priv.setState(newThread("Capped task"), "review", "⏳ Auto-resume pending — every Claude subscription was rate-limited mid-task."));
  check("a cap-park does NOT reach the phone", sent.length === 0, `${sent.length} posted`);
}
{
  const sent = await afterTransition(() => priv.notifyExternal("↪ account freed up — auto-resuming \"Capped task\"."));
  check("ordinary pipeline chatter does NOT reach the phone", sent.length === 0, `${sent.length} posted`);
}
{
  const id = newThread("Ulduar vehicles");
  const sent = await afterTransition(() => {
    void manager.askUser({ threadId: id, header: "Missing creds", question: "Which Discord bot should post?", options: [], multiSelect: false });
  });
  check("an agent's question reaches the phone", sent.length === 1 && (sent[0]?.content ?? "").includes("Needs you"));
  check("…titled with the TASK, so the board and the phone agree", sent[0]?.content.includes("Ulduar vehicles") === true);
  check("…and carrying the question itself", sent[0]?.embed?.description?.includes("Which Discord bot should post?") === true);
  check("the task is parked awaiting the owner", db.getThread(id)?.state === "awaiting_user");
}
{
  // A question the DIRECTOR asks has no task behind it — the header is then the only subject there is.
  const sent = await afterTransition(() => {
    void manager.askUser({ threadId: null, header: "Which repo?", question: "Two checkouts match that name.", options: [], multiSelect: false });
  });
  check("a director-scoped question still reaches the phone", sent.length === 1 && (sent[0]?.content ?? "").includes("Which repo?"));
}
{
  manager.setSettings({ discordUserId: "<@100000000000000001>" });
  const sent = await afterTransition(() => priv.setState(newThread("Straight to my DMs"), "done"));
  check("a user id set in Settings moves notices to the owner's DMs", sent.at(-1)?.url.endsWith("/channels/dm-100000000000000001/messages") === true, sent.map((p) => p.url).join(", "));
  check("…and the pasted mention was stored as the bare id", manager.settings().discordUserId === "100000000000000001");
  check("…with nothing posted in the channel", !sent.some((p) => p.url.includes("/channels/200000000000000002/")));
  manager.setSettings({ discordUserId: "" });
}
{
  manager.setSettings({ discordNotify: false });
  const sent = await afterTransition(() => priv.setState(newThread("After the toggle"), "done"));
  check("turning the toggle off stops it, without a restart", sent.length === 0, `${sent.length} posted`);
}

// ---- E. scheduled reminders ------------------------------------------------------------------------
console.log("\nE. a scheduled reminder reaches the DM with its own words");
{
  const msg = formatReminder("Domain renewal", "Renew the example.com domain before Oct 22.");
  check("the reminder text itself is in content, where the phone preview reads it", msg.content.includes("Renew the example.com domain before Oct 22."));
  check("…under its title", msg.content.includes("Domain renewal") && msg.content.indexOf("Domain renewal") < msg.content.indexOf("Renew the"));
  check("…and reads as a reminder", msg.content.includes("Reminder"));
  check("a long reminder still fits one Discord message", formatReminder("t".repeat(300), "x".repeat(5000)).content.length <= 2000);

  reset();
  const delivered = await notifierFor({ enabled: true, token: "t", userId: "100000000000000001" }).remind("Domain renewal", "Renew the example.com domain before Oct 22.");
  check("a reminder is DMed to the owner", delivered.ok && posted.at(-1)?.url.endsWith("/channels/dm-100000000000000001/messages") === true);
  check("…carrying the reminder text", posted.at(-1)?.content === msg.content);

  reset();
  const off = await notifierFor({ enabled: false, token: "t", userId: "1" }).remind("x", "y");
  check("the phone toggle off refuses a reminder, saying why", !off.ok && off.message.includes("off") && posted.length === 0);
  const noToken = await notifierFor({ enabled: true, userId: "1" }).remind("x", "y");
  check("a missing token is reported to the reminder's sender", !noToken.ok && noToken.message.includes("bot token"));

  reset([500]);
  const refused = await notifierFor({ enabled: true, token: "t", channelId: "1" }).remind("x", "y");
  check("a refused reminder is reported, not swallowed", !refused.ok && refused.message.includes("500"));

  // Through the real manager, as the scheduler calls it.
  manager.setSettings({ discordNotify: true, discordUserId: "100000000000000001" });
  reset();
  const live = await manager.remindOwner("Cloud credits", "Use them before Nov 5.");
  check("the manager sends a reminder with the settings as they stand", live.ok && posted.at(-1)?.content.includes("Use them before Nov 5.") === true, live.ok ? "" : live.message);
  manager.setSettings({ discordNotify: false, discordUserId: "" });
}

// ---- summary ----------------------------------------------------------------------------------------
globalThis.fetch = realFetch;
try {
  db.raw.close(); // release the sqlite file handle so Windows lets the temp dir go
} catch {
  /* already closed */
}
try {
  rmSync(dir, { recursive: true, force: true });
} catch {
  // Windows can still hold a transient lock on the just-closed DB file — the OS reaps the temp dir,
  // and a leftover throwaway dir must never fail the assertions themselves.
}
console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} checks passed, ${failed} failed`);
if (failed) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
process.exit(0);
