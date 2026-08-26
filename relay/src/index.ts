import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import {
  ADMIN_COOKIE,
  AdminSessions,
  JoinThrottle,
  SECURITY_HEADERS,
  clientIp,
  cookieValue,
  sanitizeName,
  secretEquals,
} from "./access.js";
import { assertConfigured, config } from "./config.js";
import { RelayCore } from "./core.js";
import { PersistedHistory } from "./history.js";
import { MemberStore } from "./members.js";
import { RELAY_PROTOCOL } from "./protocol.js";
import type { ClientFrame, JoinResponse, ServerFrame } from "./protocol.js";
import { adminPage, publicPage } from "./status.js";

assertConfigured();

const history = new PersistedHistory(join(config.dataDir, "history.json"));
const members = new MemberStore(join(config.dataDir, "members.json"), config.tokenTtlMs);
const core = new RelayCore({ history });
const joins = new JoinThrottle(config.joinAttemptsPerHour);
const adminSessions = new AdminSessions(config.adminSessionMs);

// ---- helpers ----------------------------------------------------------------------------------------

/** The address to hold accountable, resolved by `access.ts` rather than read straight off the header —
 *  `X-Forwarded-For` is client-supplied and the join throttle is the only brute-force defence there is. */
function callerIp(req: IncomingMessage): string {
  return clientIp(req.socket.remoteAddress, req.headers["x-forwarded-for"], config.trustedProxyHops);
}

/** Bearer token from the Authorization header. The token never travels in the URL: Caddy logs request
 *  lines, and a logged credential is a leaked credential. */
function bearer(req: IncomingMessage): string {
  const raw = req.headers.authorization;
  return typeof raw === "string" && raw.startsWith("Bearer ") ? raw.slice(7).trim() : "";
}

function send(res: ServerResponse, code: number, type: string, body: string, extra: Record<string, string> = {}): void {
  res.writeHead(code, { ...SECURITY_HEADERS, "content-type": type, ...extra });
  res.end(body);
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  send(res, code, "application/json; charset=utf-8", JSON.stringify(body));
}

function sendHtml(res: ServerResponse, code: number, html: string, extra: Record<string, string> = {}): void {
  send(res, code, "text/html; charset=utf-8", html, extra);
}

/** Read a small JSON request body. Anything past the cap DESTROYS the request rather than draining it —
 *  the only POST the relay accepts carries two short strings, so a caller still streaming at that point
 *  is spending our memory and connection budget on purpose. */
function readJsonBody(req: IncomingMessage, cap = 8192): Promise<Record<string, unknown> | null> {
  return new Promise((resolveBody) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
      if (raw.length <= cap) return;
      raw = "";
      req.destroy();
      resolveBody(null);
    });
    req.on("end", () => {
      try {
        const v = JSON.parse(raw) as unknown;
        resolveBody(v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
      } catch {
        resolveBody(null);
      }
    });
    req.on("error", () => resolveBody(null));
    req.on("close", () => resolveBody(null));
  });
}

function statusView(admin: boolean) {
  return {
    officeName: config.officeName,
    online: core.online(),
    shared: core.sharedRepos(),
    members: members.list(),
    rooms: history.activeRooms(),
    admin,
  };
}

/**
 * Does this request carry the admin key itself? Header (for the API) or `?key=` (so the owner can just
 * open the page on a phone). Disabled outright when no ADMIN_TOKEN is configured — a blank key must
 * never pass.
 */
function hasAdminKey(req: IncomingMessage, url: URL): boolean {
  if (!config.adminToken) return false;
  const header = bearer(req) || String(req.headers["x-admin-token"] ?? "");
  return secretEquals(header, config.adminToken) || secretEquals(url.searchParams.get("key") ?? "", config.adminToken);
}

/**
 * Admin access for a READ. The owner-session cookie counts here, so a browser that traded `?key=` for a
 * cookie keeps working without the credential in every subsequent URL.
 *
 * Mutations deliberately do NOT accept it and call `hasAdminKey` directly: a cookie that authorises
 * `DELETE /api/members/:id` would make revocation forgeable from any page the owner happens to visit,
 * and the documented way to revoke is already an explicit `x-admin-token` header.
 */
function isAdminRead(req: IncomingMessage, url: URL): boolean {
  if (!config.adminToken) return false;
  return hasAdminKey(req, url) || adminSessions.valid(cookieValue(req.headers.cookie, ADMIN_COOKIE));
}

/** `Set-Cookie` for a freshly minted owner session. Host-only, unreadable from script, and not sent on
 *  any cross-site navigation — the relay is opened directly, never linked into. */
function adminCookieHeader(id: string): string {
  const maxAge = Math.floor(config.adminSessionMs / 1000);
  return `${ADMIN_COOKIE}=${id}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
}

// ---- HTTP -------------------------------------------------------------------------------------------

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (req.method === "GET" && path === "/api/health") {
    const online = core.online();
    // The same three counts the public page shows, and no more: how many devices have EVER joined is a
    // membership fact, and membership facts live behind the admin key.
    return sendJson(res, 200, {
      ok: true,
      office: config.officeName,
      protocol: RELAY_PROTOCOL,
      instancesOnline: online.length,
      agentsOnline: online.reduce((n, o) => n + o.agents, 0),
      sharedRepos: core.sharedRepos().length,
      ...(isAdminRead(req, url) ? { members: members.list().length } : {}),
      uptimeSec: Math.round(process.uptime()),
    });
  }

  if (req.method === "POST" && path === "/api/join") {
    const ip = callerIp(req);
    if (joins.limited(ip)) return sendJson(res, 429, { error: "Too many join attempts — wait an hour and try again." });
    const body = await readJsonBody(req);
    const code = String(body?.code ?? "");
    if (!secretEquals(code, config.joinCode)) {
      joins.record(ip);
      console.warn(`[relay] rejected join from ${ip}`);
      return sendJson(res, 401, { error: "That join code isn't right." });
    }
    const { member, token } = members.join(String(body?.name ?? ""));
    console.log(`[relay] "${member.name}" joined (${member.id}) from ${ip}`);
    const answer: JoinResponse = {
      instanceId: member.id,
      instanceName: member.name,
      token,
      expiresAt: member.expiresAt,
      protocol: RELAY_PROTOCOL,
    };
    return sendJson(res, 200, answer);
  }

  if (req.method === "DELETE" && path.startsWith("/api/members/")) {
    if (!hasAdminKey(req, url)) return sendJson(res, 401, { error: "admin key required" });
    const id = path.slice("/api/members/".length);
    const removed = members.remove(id);
    if (removed) console.log(`[relay] revoked member ${id}`);
    return sendJson(res, removed ? 200 : 404, { ok: removed });
  }

  if (req.method === "GET" && path === "/api/members") {
    if (!isAdminRead(req, url)) return sendJson(res, 401, { error: "admin key required" });
    return sendJson(res, 200, { members: members.list(), online: core.online() });
  }

  if (req.method === "GET" && path === "/admin") {
    // A key in the URL is traded once for a session cookie and redirected away, so it stops appearing in
    // the address bar, the browser's history and every subsequent proxy log line. A curl with the header
    // is answered directly — no redirect, no cookie to keep.
    if (config.adminToken && url.searchParams.has("key") && hasAdminKey(req, url)) {
      return send(res, 303, "text/plain; charset=utf-8", "", {
        location: "/admin",
        "set-cookie": adminCookieHeader(adminSessions.mint()),
      });
    }
    if (!isAdminRead(req, url)) return sendHtml(res, 401, publicPage(statusView(false)));
    return sendHtml(res, 200, adminPage(statusView(true)));
  }

  if (req.method === "GET" && path === "/") return sendHtml(res, 200, publicPage(statusView(false)));

  return sendJson(res, 404, { error: "not found" });
}

const server = createServer((req, res) => {
  handle(req, res).catch((e: unknown) => {
    console.error("[relay] request failed", e);
    if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
  });
});

// Node's defaults give an anonymous caller five minutes of held connection per request. Every route here
// answers in milliseconds from a body of at most a few hundred bytes, so a request that takes longer is
// a slow-loris, not a user. The three must stay in this order — a `headersTimeout` at or below
// `keepAliveTimeout` closes a reused connection mid-request. An established WebSocket is unaffected: the
// socket leaves the HTTP server's bookkeeping at the upgrade, which the gate holds one open to prove.
server.keepAliveTimeout = 5_000;
server.headersTimeout = 10_000;
server.requestTimeout = 15_000;

// ---- WebSocket --------------------------------------------------------------------------------------

const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname.replace(/\/+$/, "") !== "/ws") {
    socket.destroy();
    return;
  }
  const member = members.verify(bearer(req));
  if (!member) {
    // A revoked or lapsed token must be told so explicitly: the client turns a 401 into "re-join in
    // Settings" rather than retrying forever against a door that will never open.
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  const nameHeader = sanitizeName(String(req.headers["x-office-instance"] ?? ""));
  if (nameHeader) members.rename(member.id, nameHeader);
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req, { id: member.id, name: nameHeader || member.name });
  });
});

let connSeq = 0;
const alive = new WeakMap<WebSocket, boolean>();

wss.on("connection", (ws: WebSocket, _req: IncomingMessage, who: { id: string; name: string }) => {
  const connId = `c${++connSeq}`;
  alive.set(ws, true);
  ws.on("pong", () => alive.set(ws, true));

  const send = (frame: ServerFrame): void => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
  };
  core.attach({ connId, instanceId: who.id, instanceName: who.name, send });
  console.log(`[relay] ${who.name} connected (${connId})`);

  ws.on("message", (data) => {
    let frame: ClientFrame;
    try {
      frame = JSON.parse(String(data)) as ClientFrame;
    } catch {
      send({ t: "error", message: "malformed frame" });
      return;
    }
    const err = core.onFrame(connId, frame);
    if (err) send({ t: "error", message: err });
  });

  ws.on("close", () => {
    core.detach(connId);
    console.log(`[relay] ${who.name} disconnected (${connId})`);
  });
  ws.on("error", () => ws.terminate());
});

// A half-open connection (a laptop that slept, a NAT that dropped the flow) would otherwise sit in the
// roster forever, showing a teammate as present when nobody is there. Ping every 30s and drop anything
// that misses one round.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!alive.get(ws)) {
      ws.terminate();
      continue;
    }
    alive.set(ws, false);
    ws.ping();
  }
}, 30_000);
heartbeat.unref();

// ---- lifecycle --------------------------------------------------------------------------------------

server.listen(config.port, () => {
  console.log(`[relay] ${config.officeName} listening on :${config.port} (protocol v${RELAY_PROTOCOL}, data ${config.dataDir})`);
  if (!config.adminToken) console.warn("[relay] ADMIN_TOKEN is unset — /admin and the member API are disabled.");
});

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    console.log(`[relay] ${sig} — flushing state and closing.`);
    members.flush();
    history.flush();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
