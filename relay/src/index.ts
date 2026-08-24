import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
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

// ---- helpers ----------------------------------------------------------------------------------------

/** Compare two secrets without leaking their length or a prefix match through timing. */
function secretEquals(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/** The client's address as Caddy reports it. The relay only ever sits behind the reverse proxy on the
 *  box, so the forwarded header is the real one; the socket address would be the proxy for everybody. */
function clientIp(req: IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  const first = Array.isArray(fwd) ? fwd[0] : fwd?.split(",")[0];
  return (first ?? req.socket.remoteAddress ?? "unknown").trim();
}

/** Bearer token from the Authorization header. The token never travels in the URL: Caddy logs request
 *  lines, and a logged credential is a leaked credential. */
function bearer(req: IncomingMessage): string {
  const raw = req.headers.authorization;
  return typeof raw === "string" && raw.startsWith("Bearer ") ? raw.slice(7).trim() : "";
}

const joinAttempts = new Map<string, number[]>();

/** True when this address has burned through its hourly allowance of wrong join codes. */
function joinRateLimited(ip: string): boolean {
  const cutoff = Date.now() - 3600_000;
  const recent = (joinAttempts.get(ip) ?? []).filter((t) => t > cutoff);
  joinAttempts.set(ip, recent);
  return recent.length >= config.joinAttemptsPerHour;
}

function noteJoinAttempt(ip: string): void {
  joinAttempts.set(ip, [...(joinAttempts.get(ip) ?? []), Date.now()]);
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(text);
}

function sendHtml(res: ServerResponse, code: number, html: string): void {
  res.writeHead(code, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(html);
}

/** Read a small JSON request body. Anything past the cap is refused rather than buffered — the only
 *  POST the relay accepts carries two short strings. */
function readJsonBody(req: IncomingMessage, cap = 8192): Promise<Record<string, unknown> | null> {
  return new Promise((resolveBody) => {
    let raw = "";
    let over = false;
    req.on("data", (chunk: Buffer) => {
      if (over) return;
      raw += chunk.toString("utf8");
      if (raw.length > cap) {
        over = true;
        raw = "";
      }
    });
    req.on("end", () => {
      if (over) return resolveBody(null);
      try {
        const v = JSON.parse(raw) as unknown;
        resolveBody(v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
      } catch {
        resolveBody(null);
      }
    });
    req.on("error", () => resolveBody(null));
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

/** Admin surfaces accept the key as a header (for the API) or `?key=` (so the owner can just open the
 *  page on a phone). Disabled outright when no ADMIN_TOKEN is configured — a blank key must never pass. */
function isAdmin(req: IncomingMessage, url: URL): boolean {
  if (!config.adminToken) return false;
  const header = bearer(req) || String(req.headers["x-admin-token"] ?? "");
  return secretEquals(header, config.adminToken) || secretEquals(url.searchParams.get("key") ?? "", config.adminToken);
}

// ---- HTTP -------------------------------------------------------------------------------------------

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (req.method === "GET" && path === "/api/health") {
    const online = core.online();
    return sendJson(res, 200, {
      ok: true,
      office: config.officeName,
      protocol: RELAY_PROTOCOL,
      instancesOnline: online.length,
      agentsOnline: online.reduce((n, o) => n + o.agents, 0),
      sharedRepos: core.sharedRepos().length,
      members: members.list().length,
      uptimeSec: Math.round(process.uptime()),
    });
  }

  if (req.method === "POST" && path === "/api/join") {
    const ip = clientIp(req);
    if (joinRateLimited(ip)) return sendJson(res, 429, { error: "Too many join attempts — wait an hour and try again." });
    const body = await readJsonBody(req);
    const code = String(body?.code ?? "");
    if (!secretEquals(code, config.joinCode)) {
      noteJoinAttempt(ip);
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
    if (!isAdmin(req, url)) return sendJson(res, 401, { error: "admin key required" });
    const id = path.slice("/api/members/".length);
    const removed = members.remove(id);
    if (removed) console.log(`[relay] revoked member ${id}`);
    return sendJson(res, removed ? 200 : 404, { ok: removed });
  }

  if (req.method === "GET" && path === "/api/members") {
    if (!isAdmin(req, url)) return sendJson(res, 401, { error: "admin key required" });
    return sendJson(res, 200, { members: members.list(), online: core.online() });
  }

  if (req.method === "GET" && path === "/admin") {
    if (!isAdmin(req, url)) return sendHtml(res, 401, publicPage(statusView(false)));
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
  const nameHeader = String(req.headers["x-office-instance"] ?? "");
  if (nameHeader) members.rename(member.id, nameHeader);
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req, { id: member.id, name: nameHeader.trim().slice(0, 40) || member.name });
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
