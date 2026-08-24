/**
 * Integration test — the Online Office (cross-machine agent coordination).
 *
 * The contract, in three parts:
 *  1. A repository's IDENTITY, not its local path, is what two machines agree on. `C:\repos\card-marker`
 *     and `~/dev/card-marker` must produce the same room key, or the whole feature never groups anybody.
 *  2. The client half really talks to a relay: it exchanges a join code for a device token, advertises
 *     the agents this instance has working (with their repo identity resolved), receives remote chat and
 *     remote presence, and treats a 401 as "re-join", not as something to retry forever.
 *  3. ThreadManager treats a remote agent as a repo peer: the office switches ON for a task that is alone
 *     in its checkout but shares the repository with someone else's machine, a remote line is persisted
 *     into the local project room exactly once however often the relay replays it, and it is pushed into
 *     the live implementor.
 *
 * WHAT IS REAL vs. STUBBED
 *  - REAL: `repoIdentity` over throwaway git repos, the `OnlineOffice` client and its WebSocket, a real
 *    `Db`/`EventHub`, and ThreadManager's real `repoPeers`/`officeNote`/`officeRoster`/`receiveRemoteChat`.
 *  - STUBBED: the relay is a ~40-line fake in this file (the real one's routing has its own gate,
 *    `test:relay-core`), and the live agent handles are recording objects placed in the real maps. No
 *    `claude` subprocess, no network beyond loopback — a FREE gate.
 *
 * Run:  npm run test:online-office   (from server/)   — or:  npx tsx src/tests/onlineOffice.itest.ts
 */

process.env.CAP_RETRY_MS = "0";
process.env.ACCOUNT_PING_MS = "3600000";
process.env.FAST_ACCOUNT_PING_MS = "3600000";

import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type { AccountManager } from "../accounts/accountManager.js";
import type { OnlineOffice as OnlineOfficeType } from "../office/onlineOffice.js";
import type { ClientFrame, RelayChat, RelayPresentAgent, ServerFrame } from "../office/onlineProtocol.js";
import { runGit } from "../gitService.js";

const { Db } = await import("../db/db.js");
const { EventHub } = await import("../events.js");
const { FileMemoryService } = await import("../memory/memory.js");
const { ThreadManager } = await import("../orchestrator/threadManager.js");
const { OnlineOffice, normalizeRelayUrl } = await import("../office/onlineOffice.js");
const { forgetRepoIdentity, normalizeRemote, remoteLabel, repoIdentity } = await import("../office/repoIdentity.js");
const { OFFICE_ROOM, RELAY_PROTOCOL, relayRepoRoom } = await import("../office/onlineProtocol.js");
const { GENERAL_ROOM, repoRoom } = await import("../types.js");

// ---- tiny assertion harness ------------------------------------------------------------------------
let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    failures.push(label + (detail ? ` — ${detail}` : ""));
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll until `cond` holds or the deadline passes — the client connects asynchronously. */
async function until(cond: () => boolean, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(25);
  }
  return cond();
}

class StubAccounts {
  onUsageRefresh(_cb: () => void): void {}
  effectiveUtilization(): number | null {
    return null;
  }
  soonestResetAt(): number | null {
    return null;
  }
  hasHeadroom(): boolean {
    return true;
  }
  setPingInterval(_ms: number): void {}
  applyEnabled(_id: string, _enabled: boolean): void {}
  applyWeeklySafetyPct(_id: string, _pct: number): void {}
  setSpreadUsage(_on: boolean): void {}
}

// ---- the fake relay --------------------------------------------------------------------------------

const JOIN_CODE = "correct-horse-battery";

/** A minimal stand-in for the relay: the join exchange and an authenticated socket, nothing more. It
 *  records the frames the client sends and can push any frame back. `reject401` makes it behave like a
 *  relay whose operator revoked this device. */
function fakeRelay(opts: { reject401?: boolean } = {}) {
  const received: ClientFrame[] = [];
  let socket: WebSocket | null = null;
  let issued = "";
  let upgrades = 0;
  const wss = new WebSocketServer({ noServer: true });

  const http: Server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/join") {
      let raw = "";
      req.on("data", (c: Buffer) => (raw += c.toString()));
      req.on("end", () => {
        const body = JSON.parse(raw || "{}") as { code?: string; name?: string };
        if (body.code !== JOIN_CODE) {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "That join code isn't right." }));
          return;
        }
        issued = "tok-" + Math.random().toString(36).slice(2);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ instanceId: "remote-id", instanceName: body.name ?? "", token: issued, expiresAt: Date.now() + 8.64e7, protocol: RELAY_PROTOCOL }),
        );
      });
      return;
    }
    res.writeHead(404).end();
  });

  http.on("upgrade", (req: IncomingMessage, sock, head) => {
    upgrades++;
    const auth = String(req.headers.authorization ?? "");
    if (opts.reject401 || auth !== `Bearer ${issued}`) {
      sock.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      sock.destroy();
      return;
    }
    wss.handleUpgrade(req, sock, head, (ws) => {
      socket = ws;
      ws.on("message", (d) => received.push(JSON.parse(String(d)) as ClientFrame));
      const welcome: ServerFrame = { t: "welcome", protocol: RELAY_PROTOCOL, instanceId: "inst-local", instanceName: "This machine", presence: [], recent: [] };
      ws.send(JSON.stringify(welcome));
    });
  });

  return {
    received,
    upgrades: () => upgrades,
    async listen(): Promise<string> {
      await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
      const addr = http.address();
      return `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    },
    push(frame: ServerFrame): void {
      socket?.send(JSON.stringify(frame));
    },
    connected: () => !!socket && socket.readyState === socket.OPEN,
    presence: () => received.filter((f): f is Extract<ClientFrame, { t: "presence" }> => f.t === "presence"),
    chats: () => received.filter((f): f is Extract<ClientFrame, { t: "chat" }> => f.t === "chat"),
    async close(): Promise<void> {
      for (const c of wss.clients) c.terminate();
      wss.close();
      await new Promise<void>((r) => http.close(() => r()));
    },
  };
}

// ---- throwaway git repos ---------------------------------------------------------------------------

async function makeRepo(dir: string, remote?: string): Promise<string> {
  await runGit(dir, ["init", "-q"]);
  if (remote) await runGit(dir, ["remote", "add", "origin", remote]);
  return dir;
}

// ---- the ThreadManager harness (mirrors officeGating.itest.ts) --------------------------------------

function makeManagerHarness() {
  const dir = mkdtempSync(join(tmpdir(), "online-office-"));
  const db = new Db(join(dir, "orchestrator.sqlite"));
  const hub = new EventHub();
  const memory = new FileMemoryService(join(dir, "memory"));
  const mgr = new ThreadManager(db, hub, memory, new StubAccounts() as unknown as AccountManager);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = mgr as any;
  const sent: string[] = [];
  /** Managers created by `restart()`, so their timers can be cleared at dispose. `ThreadManager` is a
   *  dynamic import here (env must land before config.js evaluates), so it is a value, not a type. */
  const revived: InstanceType<typeof ThreadManager>[] = [];

  return {
    mgr,
    db,
    internals,
    sent,
    thread: (title: string, workspace: string) => db.createThread({ title, workspace, rawPrompt: "do the thing" }),
    /** A live implementor for `threadId`, recording everything pushed into its session. */
    seedLive(threadId: string): void {
      const run = db.createRun({ threadId, role: "implementor", model: "claude-x", account: "claude-max", effort: "high" });
      const agent = { send: (text: string) => sent.push(text) };
      internals.track(threadId, agent);
      internals.live.set(threadId, { run: agent, runId: run.id, accountId: "claude-max" });
    },
    /** Attach a stand-in online office reporting a fixed remote roster. */
    attachRemote(agents: RelayPresentAgent[], repoKeyOf: (workspace: string) => string | null): string[] {
      const posted: string[] = [];
      const fake = {
        remotePeers: (workspace: string) => agents.filter((a) => a.repoKey === repoKeyOf(workspace)),
        status: () => ({ remoteAgents: agents }),
        postChat: (input: { body: string }) => posted.push(input.body),
        refreshPresence: () => {},
      };
      mgr.attachOnlineOffice(fake as unknown as OnlineOfficeType);
      return posted;
    },
    /** A fresh ThreadManager over the SAME database — what a server bounce leaves behind. Every
     *  in-memory guard starts empty here; only what was persisted survives. */
    restart(): InstanceType<typeof ThreadManager> {
      if (internals.capSupervisor) clearInterval(internals.capSupervisor);
      const next = new ThreadManager(db, hub, memory, new StubAccounts() as unknown as AccountManager);
      revived.push(next);
      return next;
    },
    dispose() {
      if (internals.capSupervisor) clearInterval(internals.capSupervisor);
      for (const m of revived) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const i = m as any;
        if (i.capSupervisor) clearInterval(i.capSupervisor);
        if (i.tokenResumeTimer) clearTimeout(i.tokenResumeTimer);
      }
      db.raw.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function remoteAgent(over: Partial<RelayPresentAgent> = {}): RelayPresentAgent {
  return {
    key: "t-remote::implementor",
    name: "Sif",
    role: "implementor",
    title: "Rewrite the card exporter",
    repoKey: "github.com/fearce/card-marker",
    repoLabel: "Fearce/card-marker",
    instanceId: "inst-mikkel",
    instanceName: "Mikkel's laptop",
    ...over,
  };
}

// ---- tests -----------------------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("\n=== the online office — integration test ===\n");

  // -- Test A: a repository's identity is the same string from either machine ------------------------
  console.log("Test A — repo identity: every form of one remote collapses to one key");
  {
    const forms = [
      "git@github.com:Fearce/card-marker.git",
      "https://github.com/Fearce/card-marker",
      "https://github.com/Fearce/card-marker.git/",
      "ssh://git@github.com/Fearce/card-marker/",
      "https://someone@github.com/fearce/card-marker.git",
    ];
    const keys = new Set(forms.map((f) => normalizeRemote(f)));
    check("all five URL forms give one key", keys.size === 1 && [...keys][0] === "github.com/fearce/card-marker", [...keys].join(" | "));
    check("a different repo gives a different key", normalizeRemote("https://github.com/fearce/other") !== [...keys][0]);
    check("the label keeps the remote's own casing", remoteLabel("git@github.com:Fearce/card-marker.git") === "Fearce/card-marker");
    check("an explicit port isn't part of the identity", normalizeRemote("ssh://git@git.example.com:2222/team/app.git") === "git.example.com/team/app");
    check("junk is refused rather than becoming a room", normalizeRemote("not a url") === null && normalizeRemote("") === null);

    // A relay URL is what a human pastes, so it accepts the forms a human types.
    check("relay URL: bare host gets https", normalizeRelayUrl("office.example.com") === "https://office.example.com");
    check("relay URL: a wss:// paste becomes https", normalizeRelayUrl("wss://office.example.com/") === "https://office.example.com");
    check("relay URL: a trailing slash is dropped", normalizeRelayUrl("https://office.example.com/") === "https://office.example.com");
    check("relay URL: nonsense is refused", normalizeRelayUrl("   ") === null);
  }

  // -- Test B: identity resolved off a real checkout, including one with no remote -------------------
  console.log("\nTest B — repo identity over real checkouts");
  {
    const root = mkdtempSync(join(tmpdir(), "online-office-repos-"));
    try {
      const cloned = await makeRepo(mkdtempSync(join(root, "with-remote-")), "https://github.com/Fearce/card-marker.git");
      const scratch = await makeRepo(mkdtempSync(join(root, "card-marker-")));
      forgetRepoIdentity();
      const a = await repoIdentity(cloned);
      check("a checkout with a remote is keyed on the remote", a?.key === "github.com/fearce/card-marker", JSON.stringify(a));
      check("…and labelled for humans", a?.label === "Fearce/card-marker", JSON.stringify(a));
      const b = await repoIdentity(scratch);
      check("a repo with NO remote falls back to its folder name", !!b && b.key.startsWith("name:card-marker-"), JSON.stringify(b));
      const none = await repoIdentity(mkdtempSync(join(root, "not-a-repo-")));
      check("a workspace that isn't a repo has no identity", none === null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // -- Test C: the client half really talks to a relay ------------------------------------------------
  console.log("\nTest C — the client: join, advertise, receive");
  {
    const relay = fakeRelay();
    const url = await relay.listen();
    const dir = mkdtempSync(join(tmpdir(), "online-office-client-"));
    const db = new Db(join(dir, "orchestrator.sqlite"));
    const hub = new EventHub();
    const workspace = await makeRepo(mkdtempSync(join(dir, "repo-")), "git@github.com:Fearce/card-marker.git");
    const chats: { msg: RelayChat; workspaces: string[] }[] = [];
    const joins: { repoLabel: string; workspaces: string[]; joiners: RelayPresentAgent[] }[] = [];
    forgetRepoIdentity();

    const office: OnlineOfficeType = new OnlineOffice({
      db,
      hub,
      roster: () => [{ key: "t1::implementor", name: "Rune", role: "implementor", title: "Fix the parser", workspace }],
      onRemoteChat: (msg, workspaces) => chats.push({ msg, workspaces }),
      onRemoteJoin: (repoLabel, workspaces, joiners) => joins.push({ repoLabel, workspaces, joiners }),
    });
    try {
      office.start();
      check("before joining, the office reports itself off", office.status().state === "off" && !office.status().joined);

      const bad = await office.join({ url, code: "wrong", instanceName: "Kevin's tower" });
      check("a wrong join code is refused, with the relay's own reason", !bad.ok && /join code/i.test(bad.error ?? ""), bad.error);
      check("…and nothing is persisted", !db.kvGet("online_office_token"));

      const ok = await office.join({ url, code: JOIN_CODE, instanceName: "Kevin's tower" });
      check("the right code joins", ok.ok, ok.error);
      check("the device token is persisted for next time", !!db.kvGet("online_office_token"));
      check("the socket connects", await until(() => office.status().state === "online" && relay.connected()));

      check("presence is advertised", await until(() => relay.presence().length > 0));
      const agents = relay.presence().at(-1)!.agents;
      check("…with this instance's live agent", agents.length === 1 && agents[0]!.name === "Rune", JSON.stringify(agents));
      check("…keyed on the repo IDENTITY, not the local path", agents[0]!.repoKey === "github.com/fearce/card-marker", agents[0]?.repoKey);

      // A remote agent appears in the same repository → the caller is told, and it becomes a peer.
      relay.push({ t: "presence", agents: [remoteAgent()] });
      check("a remote agent in our repo is announced as a joiner", await until(() => joins.length === 1), JSON.stringify(joins));
      check("…naming the repo and our local workspace", joins[0]?.repoLabel === "Fearce/card-marker" && joins[0]?.workspaces[0] === workspace);
      check("…and shows up as a remote peer for that workspace", office.remotePeers(workspace).length === 1);
      check("…but not for a workspace we don't have", office.remotePeers("C:/nowhere").length === 0);
      check("the status DTO names the shared repo", office.status().sharedRepos.includes("Fearce/card-marker"));

      // The same roster again must NOT re-announce — presence is pushed on a timer.
      relay.push({ t: "presence", agents: [remoteAgent()] });
      await sleep(120);
      check("an unchanged remote roster announces nobody twice", joins.length === 1, `joins=${joins.length}`);

      // Inbound chat is routed to the local workspace behind that repo key.
      const room = relayRepoRoom("github.com/fearce/card-marker");
      relay.push({
        t: "chat",
        msg: { id: "m1", room, body: "taking exporter.ts", senderName: "Sif", role: "implementor", instanceId: "inst-mikkel", instanceName: "Mikkel's laptop", repoLabel: "Fearce/card-marker", at: Date.now() },
      });
      check("a remote line is delivered", await until(() => chats.length === 1));
      check("…resolved to the local checkout of that repo", chats[0]?.workspaces[0] === workspace, JSON.stringify(chats[0]?.workspaces));

      // A local post goes out to the relay, keyed on the same room.
      office.postChat({ workspace, body: "I'll take parser.ts", senderName: "Rune", role: "implementor" });
      check("a local team post reaches the relay", await until(() => relay.chats().length === 1));
      check("…in the repo's room", relay.chats()[0]?.room === room, relay.chats()[0]?.room);
      office.postChat({ workspace: null, body: "morning", senderName: "Rune", role: "implementor" });
      check("…and an office-wide post goes to the office room", await until(() => relay.chats().some((c) => c.room === OFFICE_ROOM)));

      // Leaving forgets the token — re-joining must need the code again.
      office.leave();
      check("leaving forgets the device token", !db.kvGet("online_office_token"));
      check("…and reports itself off", office.status().state === "off" && !office.status().joined);
    } finally {
      office.dispose();
      db.raw.close();
      await relay.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // -- Test D: a revoked device is a dead end, not a retry loop ---------------------------------------
  console.log("\nTest D — a 401 on connect means re-join, not retry forever");
  {
    const relay = fakeRelay({ reject401: true });
    const url = await relay.listen();
    const dir = mkdtempSync(join(tmpdir(), "online-office-401-"));
    const db = new Db(join(dir, "orchestrator.sqlite"));
    const hub = new EventHub();
    const office: OnlineOfficeType = new OnlineOffice({ db, hub, roster: () => [], onRemoteChat: () => {}, onRemoteJoin: () => {} });
    try {
      office.start();
      const ok = await office.join({ url, code: JOIN_CODE, instanceName: "Kevin's tower" });
      check("the join itself succeeds (the relay revoked it afterwards)", ok.ok, ok.error);
      check("the socket is refused and the office says so", await until(() => office.status().state === "error"));
      check("…with an owner-actionable reason", /re-join/i.test(office.status().error ?? ""), office.status().error ?? "(none)");
      check("…the dead token is discarded", !db.kvGet("online_office_token"));
      const seen = relay.upgrades();
      await sleep(400);
      check("…and it does NOT keep hammering the relay", relay.upgrades() === seen, `upgrades ${seen} → ${relay.upgrades()}`);
    } finally {
      office.dispose();
      db.raw.close();
      await relay.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // -- Test E: ThreadManager treats a remote agent as a repo peer -------------------------------------
  console.log("\nTest E — a remote agent switches the office ON and reaches the implementor");
  {
    const h = makeManagerHarness();
    const WS = "C:/repos/card-marker";
    try {
      const t = h.thread("Fix the marker parser", WS);
      h.seedLive(t.id);
      check("alone in the repo AND alone in the office → no office note", h.internals.officeNote(t, "implementor", true) === undefined);

      h.attachRemote([remoteAgent()], (ws) => (ws === WS ? "github.com/fearce/card-marker" : null));
      const note = h.internals.officeNote(t, "implementor", true) as string | undefined;
      check("a remote agent in the same repo switches the office on", typeof note === "string");
      check("…naming the machine it is on", !!note && note.includes("Mikkel's laptop"), note);
      check("…and warning about the REMOTE, not the working tree", !!note && note.includes("pull before you push") && !note.includes("step on each other"), note);

      const roster = h.mgr.officeRoster(t.id);
      const remote = roster.find((r) => r.instance);
      check("officeRoster lists the remote coworker", !!remote && remote.name === "Sif", JSON.stringify(remote));
      check("…flagged as being in the caller's repo", !!remote?.sameRepo);
      check("…with the repo label where a local peer has a path", remote?.workspace === "Fearce/card-marker");

      // A remote line lands in the local project room and is pushed into the live implementor.
      const room = relayRepoRoom("github.com/fearce/card-marker");
      const msg: RelayChat = {
        id: "m-remote-1", room, body: "taking exporter.ts", senderName: "Sif", role: "implementor",
        instanceId: "inst-mikkel", instanceName: "Mikkel's laptop", repoLabel: "Fearce/card-marker", at: Date.now(),
      };
      h.mgr.receiveRemoteChat(msg, [WS]);
      const inRoom = h.db.listRoomMessages(repoRoom(WS), 50).filter((m) => m.kind === "chat");
      check("a remote line is persisted into the local project room", inRoom.length === 1, `count=${inRoom.length}`);
      check("…attributed to the agent AND its machine", inRoom[0]?.senderName === "Sif @ Mikkel's laptop", inRoom[0]?.senderName ?? "");
      check("…and pushed into the live implementor", h.sent.some((s) => s.includes("taking exporter.ts")), JSON.stringify(h.sent));
      check("…telling it the collision is at the remote", h.sent.some((s) => s.includes("git status")), JSON.stringify(h.sent));

      // The relay replays a room's backlog on every entry, so the SAME id must not land twice.
      h.mgr.receiveRemoteChat(msg, [WS]);
      check("a replayed backlog line is not persisted twice", h.db.listRoomMessages(repoRoom(WS), 50).filter((m) => m.kind === "chat").length === 1);

      // …and a RESTART is an entry too. The relay replays the backlog on the first connect after a
      // bounce, so an in-memory-only dedup set would re-persist the whole room every time this server
      // is deployed — and re-push it at the auto-resumed implementors as if it were new traffic.
      const revived = h.restart();
      revived.receiveRemoteChat(msg, [WS]);
      check(
        "a backlog line replayed after a RESTART is not persisted twice",
        h.db.listRoomMessages(repoRoom(WS), 50).filter((m) => m.kind === "chat").length === 1,
        `count=${h.db.listRoomMessages(repoRoom(WS), 50).filter((m) => m.kind === "chat").length}`,
      );
      check(
        "…while a genuinely new line still lands after a restart",
        (() => {
          revived.receiveRemoteChat({ ...msg, id: "m-remote-after-restart", body: "rebased onto master" }, [WS]);
          return h.db.listRoomMessages(repoRoom(WS), 50).some((m) => m.body === "rebased onto master");
        })(),
      );

      // An office-wide remote line has no repo, so it belongs in the general room.
      h.mgr.receiveRemoteChat({ ...msg, id: "m-remote-2", room: OFFICE_ROOM, body: "morning all" }, []);
      check("an office-wide remote line lands in the general room", h.db.listRoomMessages(GENERAL_ROOM, 50).some((m) => m.body === "morning all"));

      // …and a remote join wakes the implementor the same way a local one does.
      h.sent.length = 0;
      h.mgr.remoteTeammatesJoined("Fearce/card-marker", [WS], [remoteAgent({ key: "t-remote-2::qa", role: "qa", name: "Tor" })]);
      check("a remote joiner wakes the live implementor", h.sent.some((s) => s.includes("Tor") && s.includes("Mikkel's laptop")), JSON.stringify(h.sent));
      check("…and is recorded in the project room", h.db.listRoomMessages(repoRoom(WS), 50).some((m) => m.kind === "system" && m.body.includes("Tor")));
    } finally {
      h.dispose();
    }
  }

  // -- Test F: a local team post is forwarded to the other machines -----------------------------------
  console.log("\nTest F — a local agent's team post goes out to the office");
  {
    const h = makeManagerHarness();
    const WS = "C:/repos/card-marker";
    try {
      const t = h.thread("Fix the marker parser", WS);
      h.seedLive(t.id);
      const posted = h.attachRemote([remoteAgent()], () => "github.com/fearce/card-marker");
      h.mgr.chatPost({ threadId: t.id, role: "implementor", scope: "project", body: "claiming parser.ts" });
      check("a team post is forwarded to the relay", posted.includes("claiming parser.ts"), JSON.stringify(posted));
      h.mgr.chatPost({ threadId: t.id, role: "implementor", scope: "general", body: "hello office" });
      check("…and so is an office post", posted.includes("hello office"), JSON.stringify(posted));
    } finally {
      h.dispose();
    }
  }

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  if (failed) {
    for (const f of failures) console.log(`  • ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

void main();
