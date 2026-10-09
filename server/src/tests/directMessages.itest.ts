import assert from "node:assert/strict";
import Fastify from "fastify";
import { Db } from "../db/db.js";
import { EventHub } from "../events.js";
import { FileMemoryService } from "../memory/memory.js";
import { ThreadManager } from "../orchestrator/threadManager.js";
import type { AccountManager } from "../accounts/accountManager.js";
import { DirectMessages } from "../office/directMessages.js";
import { registerDirectMessageRoutes } from "../office/directMessageRoutes.js";

const db = new Db(":memory:");
const hub = new EventHub();
const accounts = { onUsageRefresh() {}, effectiveUtilization: () => null, soonestResetAt: () => null, hasHeadroom: () => true, setPingInterval() {}, applyEnabled() {}, applyWeeklySafetyPct() {}, setSpreadUsage() {}, setProviderRuntime: async () => {} };
const manager = new ThreadManager(db, hub, new FileMemoryService("unused-inbox-fixture"), accounts as unknown as AccountManager);
const app = Fastify();
let checks = 0;
function check(label: string, action: () => void) { action(); checks++; console.log(`PASS ${label}`); }
try {
  const a = db.createThread({ title: "Parser", workspace: "C:/example/parser", rawPrompt: "fixture" });
  const b = db.createThread({ title: "Renderer", workspace: "C:/example/renderer", rawPrompt: "fixture" });
  const c = db.createThread({ title: "Observer", workspace: "C:/example/parser", rawPrompt: "fixture" });
  for (const thread of [a, b, c]) db.createRun({ threadId: thread.id, role: "implementor", model: "fixture", account: "fixture", effort: "low" });
  manager.setOfficeName(a.id, "implementor", "Aster Ink");
  manager.setOfficeName(b.id, "implementor", "Copper Vale");
  const from = { threadId: a.id, role: "implementor" as const };
  const to = { threadId: b.id, role: "implementor" as const };
  const other = { threadId: c.id, role: "implementor" as const };
  let steered = 0;
  const internal = manager as unknown as { live: Map<string, unknown>; sendCommunication: () => void; track: (id: string, handle: unknown) => void; withOfficeNote: (thread: typeof a, role: string, text: string, tools: boolean) => string; inboxResumeKickoff: (threadId: string, role: string, message: string | unknown[]) => string | unknown[]; capSupervisor?: NodeJS.Timeout };
  const handle = { send: () => { steered++; } };
  internal.track(b.id, handle);
  internal.live.set(b.id, { run: handle, runId: "fixture", accountId: "fixture" });
  internal.sendCommunication = () => { steered++; };
  const letter = manager.directSend(from, to, "  Can you check the interface?\nÅngström ✅  ");
  check("quiet send never steers live recipient", () => assert.equal(steered, 0));
  const inputHooks = manager as any;
  inputHooks.receiptLanes.set(handle, { threadId: b.id, runId: "fixture", recipient: "implementor", provider: "codex" });
  const scheduled = inputHooks.prepareRunInput(handle, "Continue the existing work.");
  check("already scheduled input includes incoming mail without waking or acknowledging", () => {
    assert.ok(scheduled.includes("Quiet gnome inbox") && scheduled.includes("Can you check the interface?"));
    assert.ok(scheduled.includes("Continue the existing work."));
    assert.equal(manager.directRead(to).unread, 1);
    assert.equal(steered, 0);
    assert.ok(!inputHooks.prepareRunInput({}, "Other agent").includes("Quiet gnome inbox"));
  });
  manager.chatPost({ threadId: a.id, role: "implementor", scope: "general", body: "Office context fixture" });
  manager.chatPost({ threadId: c.id, role: "implementor", scope: "project", body: "Other repo fixture" });
  check("scheduled inputs include office context and exclude another repository's team chat", () => {
    const next = inputHooks.prepareRunInput(handle, "Continue");
    assert.ok(next.includes("Office context fixture"));
    assert.ok(!next.includes("Other repo fixture"));
    assert.equal(manager.directRead(to).unread, 1);
    assert.equal(steered, 0);
  });
  check("a later scheduled input previews only chat this run has not already seen", () => {
    const again = inputHooks.prepareRunInput(handle, "Continue again");
    assert.ok(!again.includes("Office context fixture"));
    manager.chatPost({ threadId: a.id, role: "implementor", scope: "general", body: "Second office fixture" });
    const fresh = inputHooks.prepareRunInput(handle, "Continue once more");
    assert.ok(fresh.includes("Second office fixture") && !fresh.includes("Office context fixture"));
  });
  const neighbour = db.createThread({ title: "Neighbour", workspace: "C:/example/renderer", rawPrompt: "fixture" });
  const steeredBeforePush = steered;
  manager.chatPost({ threadId: neighbour.id, role: "implementor", scope: "project", body: "Pushed team fixture" });
  check("a team post already pushed into the run is not repeated in its next preview", () => {
    assert.equal(steered, steeredBeforePush + 1);
    assert.ok(!inputHooks.prepareRunInput(handle, "After the push").includes("Pushed team fixture"));
  });
  steered = steeredBeforePush;
  check("sender identity and exact trimmed body persisted", () => { assert.equal(letter.senderName, "Aster Ink"); assert.equal(letter.body, "Can you check the interface?\nÅngström ✅"); });
  check("recipient owns unread message; sender sees sent history", () => { assert.equal(manager.directRead(to).unread, 1); assert.equal(manager.directRead(from).messages[0]?.id, letter.id); assert.equal(manager.directRead(from).unread, 0); });
  check("other gnome and other role cannot read it", () => { assert.equal(manager.directRead(other).messages.length, 0); assert.equal(manager.directRead({ ...to, role: "qa" }).messages.length, 0); });
  check("reading never acknowledges", () => assert.equal(manager.directRead(to).unread, 1));
  check("sender cannot acknowledge recipient mail", () => { assert.equal(manager.directAcknowledge(from, letter.id), 0); assert.equal(manager.directRead(to).unread, 1); });
  const later = manager.directInbox.send(null, to, "Owner follow-up");
  check("acknowledgement limited through id, idempotent", () => { assert.equal(manager.directAcknowledge(to, letter.id), 1); assert.equal(manager.directAcknowledge(to, letter.id), 0); assert.equal(manager.directRead(to).unread, 1); assert.ok(manager.directRead(from).messages[0]?.readAt); });
  check("invalid address and empty/oversized mail refused", () => { assert.throws(() => manager.directSend(from, { threadId: "missing", role: "implementor" }, "Hi")); assert.throws(() => manager.directSend(from, to, " ")); assert.throws(() => manager.directSend(from, to, "x".repeat(2001))); });
  const token = manager.directInbox.capability(from);
  const recipientToken = manager.directInbox.capability(to);
  check("capability identifies only issuing gnome", () => { assert.deepEqual(manager.directInbox.identify(token), from); assert.equal(manager.directInbox.identify("bogus"), null); });
  const reopened = new DirectMessages(db, (id, role) => manager.officeName(id, role));
  check("new service retains messages, read state and capabilities", () => { assert.equal(reopened.list(to).messages.length, 2); assert.deepEqual(reopened.identify(recipientToken), to); assert.equal(reopened.list(to).unread, 1); });
  registerDirectMessageRoutes(app, manager, cookie => cookie === "owner=fixture");
  await app.ready();
  const owner = { cookie: "owner=fixture" };
  const agent = { authorization: `Bearer ${token}` };
  const recipient = { authorization: `Bearer ${recipientToken}` };
  const query = new URLSearchParams(to).toString();
  const unauth = await app.inject({ url: "/api/gnome-inbox/directory" });
  check("owner route requires session", () => assert.equal(unauth.statusCode, 401));
  const inspect = await app.inject({ url: `/api/gnome-inbox/messages?${query}`, headers: owner });
  check("owner inspection leaves unread status intact", () => { assert.equal(inspect.statusCode, 200); assert.equal(inspect.json().unread, 1); assert.equal(manager.directRead(to).unread, 1); });
  const cross = await app.inject({ method: "POST", url: "/api/gnome-inbox/messages", headers: { ...owner, "sec-fetch-site": "cross-site" }, payload: { recipient: to, body: "Forbidden" } });
  check("cross-site write refused", () => assert.equal(cross.statusCode, 403));
  const forge = await app.inject({ method: "POST", url: "/api/gnome-inbox/agent/messages", headers: agent, payload: { recipient: to, body: "Ping", sender: other } });
  check("capability cannot forge sender", () => assert.equal(forge.statusCode, 400));
  const readOther = await app.inject({ url: `/api/gnome-inbox/agent/messages?${query}`, headers: agent });
  check("capability cannot select another inbox", () => assert.equal(readOther.statusCode, 400));
  const wrongAck = await app.inject({ method: "POST", url: "/api/gnome-inbox/agent/ack", headers: agent, payload: { throughId: later.id } });
  check("agent acknowledgement cannot consume someone else's mail", () => { assert.equal(wrongAck.json().acknowledged, 0); assert.equal(manager.directRead(to).unread, 1); });
  const sent = await app.inject({ method: "POST", url: "/api/gnome-inbox/agent/messages", headers: agent, payload: { recipient: to, body: "Scoped ping" } });
  check("scoped HTTP send uses bound sender without interruption", () => { assert.equal(sent.statusCode, 200); assert.deepEqual(sent.json().sender, from); assert.equal(steered, 0); });
  const acked = await app.inject({ method: "POST", url: "/api/gnome-inbox/agent/ack", headers: recipient, payload: { throughId: sent.json().id } });
  check("recipient can acknowledge HTTP mail", () => { assert.equal(acked.json().acknowledged, 2); assert.equal(manager.directRead(to).unread, 0); });
  const directory = await app.inject({ url: "/api/gnome-inbox/agent/directory", headers: agent });
  check("agent directory omits other unread counts and remotes", () => { assert.equal(directory.statusCode, 200); assert.ok(directory.json().every((entry: Record<string, unknown>) => !("unread" in entry) && !("instance" in entry))); });
  const stale = db.createThread({ title: "Long finished", workspace: "C:/example/old", rawPrompt: "fixture" });
  db.createRun({ threadId: stale.id, role: "implementor", model: "fixture", account: "fixture", effort: "low" });
  manager.setOfficeName(stale.id, "implementor", "Dusty Fern");
  const dayAgo = Date.now() - 25 * 60 * 60 * 1000;
  db.raw.prepare("UPDATE agent_runs SET started_at=?, ended_at=? WHERE thread_id=?").run(dayAgo - 60_000, dayAgo, stale.id);
  const ownerDirectory = await app.inject({ url: "/api/gnome-inbox/directory", headers: owner });
  check("directory hides gnomes idle for 24h+ and keeps recent ones", () => {
    const names = ownerDirectory.json().map((entry: { name: string }) => entry.name);
    assert.ok(names.includes("Aster Ink") && names.includes("Copper Vale"));
    assert.ok(!names.includes("Dusty Fern"));
    assert.ok(!manager.directDirectory().some(entry => entry.threadId === stale.id));
  });
  check("hidden idle gnome can still receive mail by address", () => assert.equal(manager.directSend(from, { threadId: stale.id, role: "implementor" }, "Still reachable").recipientName, "Dusty Fern"));
  check("recent directory activity preserves long runs, cutoff boundaries and role isolation", () => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const long = db.createRun({ threadId: stale.id, role: "qa", model: "fixture", account: "fixture", effort: "low" });
    db.raw.prepare("UPDATE agent_runs SET started_at=?, ended_at=?, state='done' WHERE id=?").run(cutoff - 10 * 86400_000, cutoff, long.id);
    const future = db.createRun({ threadId: c.id, role: "qa", model: "fixture", account: "fixture", effort: "low" });
    db.raw.prepare("UPDATE agent_runs SET started_at=?, ended_at=? WHERE id=?").run(cutoff + 1, cutoff - 1, future.id);
    const recent = db.recentAgentKeys(cutoff);
    assert.ok(recent.has(`${stale.id}::qa`));
    assert.ok(!recent.has(`${stale.id}::implementor`));
    assert.ok(!recent.has(`${c.id}::qa`));
    const legacy = db.raw.prepare(`SELECT thread_id, role FROM agent_runs GROUP BY thread_id, role
      HAVING max(coalesce(ended_at, started_at)) >= ?`).all(cutoff) as { thread_id: string; role: string }[];
    assert.deepEqual([...recent].sort(), legacy.map(row => `${row.thread_id}::${row.role}`).sort());
    const original = db.raw.prepare.bind(db.raw);
    const plans: string[] = [];
    db.raw.prepare = ((sql: string) => {
      if (sql.includes("SELECT thread_id, role FROM agent_runs")) {
        plans.push(...(original(`EXPLAIN QUERY PLAN ${sql}`).all(cutoff, cutoff, cutoff) as { detail: string }[]).map(row => row.detail));
      }
      return original(sql);
    }) as typeof db.raw.prepare;
    try { db.recentAgentKeys(cutoff); } finally { db.raw.prepare = original; }
    assert.ok(plans.some(plan => /SEARCH agent_runs.*started_at>/.test(plan)), plans.join("; "));
    assert.ok(plans.some(plan => /SEARCH agent_runs.*state=.*ended_at>/.test(plan)), plans.join("; "));
    assert.ok(!plans.some(plan => /SCAN agent_runs/.test(plan)), plans.join("; "));
  });
  for (let index = 0; index < 105; index++) manager.directSend(from, to, `letter ${index}`);
  check("automatic unread preview is incoming-only and bounded", () => {
    assert.equal(manager.directInbox.unreadPreview(to).length, 20);
    assert.equal(manager.directInbox.unreadPreview(from).length, 0);
    assert.ok(manager.directInbox.unreadPreview(to).every(letter => letter.senderName === "Aster Ink" || letter.senderName === "Owner"));
  });
  const latest = manager.directRead(to);
  const older = manager.directRead(to, latest.messages[0]!.id);
  check("pagination is bounded, chronological and lossless", () => { assert.equal(latest.messages.length, 100); assert.equal(latest.hasMore, true); assert.equal(older.messages.length, 8); assert.equal(older.hasMore, false); assert.ok(older.messages.at(-1)!.id < latest.messages[0]!.id); });
  const kickoff = internal.withOfficeNote(a, "implementor", "KICKOFF", false);
  check("CLI kickoff exposes scoped inbox actions", () => { assert.ok(kickoff.includes("gnome-inbox.cjs")); assert.ok(kickoff.includes(token)); assert.ok(kickoff.includes("ack <through-id>")); });
  check("resumed CLI kickoff gains mailbox access and preserves attachments", () => {
    const text = internal.inboxResumeKickoff(a.id, "implementor", "CONTINUE");
    assert.ok(typeof text === "string" && text.startsWith("CONTINUE\n\n") && text.includes(token));
    const image = { type: "image", source: { type: "base64", data: "fixture" } };
    const blocks = internal.inboxResumeKickoff(a.id, "implementor", [image]);
    assert.ok(Array.isArray(blocks));
    assert.deepEqual(blocks[0], image);
    assert.ok(JSON.stringify(blocks[1]).includes(token));
  });
  db.deleteThread(b.id);
  check("deleted recipient loses mail and capability", () => { assert.equal(manager.directInbox.identify(recipientToken), null); assert.throws(() => manager.directRead(to)); });
  console.log(`${checks} inbox integration checks passed`);
} finally {
  const internal = manager as unknown as { capSupervisor?: NodeJS.Timeout };
  if (internal.capSupervisor) clearInterval(internal.capSupervisor);
  await app.close();
  db.raw.close();
}
