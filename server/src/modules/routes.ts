import { randomBytes } from "node:crypto";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { WebSocket, type RawData } from "ws";
import { isCrossSiteRequest } from "../crossSite.js";
import { isModuleId, MODULE_LABELS, type ModuleId } from "./catalog.js";
import { WORKER_TOKEN_HEADER } from "./protocol.js";
import { ModuleError, type ModuleSupervisor, type WorkerConnection } from "./supervisor.js";

/** How long the console waits for a worker to begin answering. Camera discovery is the slowest route. */
const RESPONSE_TIMEOUT_MS = 90_000;
const TICKET_TTL_MS = 60_000;
// `range` and the content-range/disposition answers let a <video> seek a recording and a download keep its name.
const PASSED_REQUEST_HEADERS = ["accept", "accept-encoding", "content-type", "last-event-id", "range"];
const PASSED_RESPONSE_HEADERS = ["content-type", "content-length", "content-encoding", "vary", "x-frame-at", "accept-ranges", "content-range", "content-disposition"];
const MAX_STREAM_BUFFERED_BYTES = 4 * 1024 * 1024;

/**
 * The console's door to the module workers. Every route needs the owner's session and refuses cross-site
 * requests; the worker itself is loopback-only and wants its own token, which never leaves this process.
 * Requests are piped, not buffered, so a large Script Hub payload or a camera frame costs this event loop
 * only the copy. A worker that is down is started on the first request that needs it, never before.
 */
export function registerModuleRoutes(app: FastifyInstance, supervisor: ModuleSupervisor, isAuthed: (cookie?: string) => boolean): void {
  const tickets = new Map<string, { module: ModuleId; expiresAt: number }>();

  void app.register(async (routes) => {
    routes.addHook("onRequest", async (req, reply) => {
      reply.header("cache-control", "no-store");
      if (!isAuthed(req.headers.cookie)) return reply.code(401).send({ error: "unauthorized" });
      if (isStreamHandshake(req) ? isNamedCrossSite(req) : isCrossSiteRequest(req)) return reply.code(403).send({ error: "Cross-site module requests are refused." });
    });
    routes.setErrorHandler((error, _req, reply) => {
      const status = error instanceof ModuleError ? error.status : 500;
      return reply.code(status).send({ error: error instanceof Error ? error.message : String(error) });
    });

    routes.get("/api/modules/services", () => supervisor.statuses());

    routes.get("/api/modules/:id/service", (req) => supervisor.status(moduleParam(req)));

    routes.post("/api/modules/:id/service/:action", async (req) => {
      const id = moduleParam(req);
      const action = (req.params as { action: string }).action;
      const force = (req.body as { force?: unknown } | null)?.force === true;
      if (action === "start") await supervisor.ensure(id);
      else if (action === "restart") await supervisor.restart(id);
      else if (action === "stop") await supervisor.stop(id, { force });
      else throw new ModuleError(`unknown service action ${action}`, 404);
      supervisor.syncArmedWatch();
      return supervisor.status(id);
    });

    routes.post("/api/modules/:id/ticket", (req) => {
      const id = moduleParam(req);
      const now = Date.now();
      for (const [key, ticket] of tickets) if (ticket.expiresAt < now) tickets.delete(key);
      const ticket = randomBytes(18).toString("base64url");
      tickets.set(ticket, { module: id, expiresAt: now + TICKET_TTL_MS });
      return { ticket };
    });

    // A WebSocket handshake ignores CORS, so the cookie alone is not enough: it also needs a fresh ticket.
    routes.get("/api/modules/:id/stream", { websocket: true }, (socket, req) => {
      const id = (req.params as { id?: string }).id;
      const ticket = String((req.query as { ticket?: unknown }).ticket ?? "");
      const issued = tickets.get(ticket);
      tickets.delete(ticket);
      if (!isModuleId(id) || !issued || issued.module !== id || issued.expiresAt < Date.now()) {
        socket.close(4403, "ticket");
        return;
      }
      void relayStream(supervisor, id, socket);
    });

    routes.all("/api/modules/:id/api/*", async (req, reply) => {
      const id = moduleParam(req);
      const path = forwardedPath(req.url);
      let connection = await supervisor.ensure(id);
      try {
        await proxy(connection, req, reply, path);
      } catch (error) {
        if (!isRefused(error) || reply.raw.headersSent) throw error;
        // The cached worker died since its last health check; find or start a fresh one and retry once.
        supervisor.forget(id);
        connection = await supervisor.ensure(id);
        await proxy(connection, req, reply, path);
      }
      supervisor.syncArmedWatch();
      return reply;
    });
  });
}

/**
 * The picture socket's handshake. Chromium sends no Sec-Fetch-Site on a WebSocket handshake, and the deck's
 * reverse proxy rewrites Host, so the Origin-vs-Host fallback would refuse the owner's own cameras there.
 * The single-use ticket is what stops another site: only our own page can read the ticket POST's answer.
 */
function isStreamHandshake(req: FastifyRequest): boolean {
  return req.method === "GET" && /^\/api\/modules\/[^/]+\/stream(?:\?|$)/.test(req.url);
}

/** Cross-site by the browser's own word only (as remote control's socket does): a missing Sec-Fetch-Site is not a refusal. */
function isNamedCrossSite(req: FastifyRequest): boolean {
  const site = req.headers["sec-fetch-site"];
  return site !== undefined && site !== "same-origin" && site !== "none";
}

function moduleParam(req: FastifyRequest): ModuleId {
  const id = (req.params as { id?: string }).id;
  if (!isModuleId(id)) throw new ModuleError(`unknown module ${id}`, 404);
  return id;
}

/**
 * The worker-side path, cut from the raw request URL so it stays percent-encoded. Fastify's `*` param is
 * decoded, and a decoded `%2F` or `%5C` would become a separator the worker's URL parser resolves `..` over.
 */
function forwardedPath(url: string): string {
  const match = /^[^?]*?\/api\/modules\/[^/?]+\/api(\/[^?]*)?(\?.*)?$/.exec(url);
  return `${match?.[1] || "/"}${match?.[2] ?? ""}`;
}

function isRefused(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ECONNREFUSED";
}

/** Pipe one request to the worker and its answer back. Resolves once the answer is fully relayed. */
function proxy(connection: WorkerConnection, req: FastifyRequest, reply: FastifyReply, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { [WORKER_TOKEN_HEADER]: connection.token };
    for (const name of PASSED_REQUEST_HEADERS) {
      const value = req.headers[name];
      if (typeof value === "string") headers[name] = value;
    }
    const body = req.body === undefined || req.method === "GET" || req.method === "HEAD" ? null : Buffer.from(JSON.stringify(req.body), "utf8");
    if (body) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(body.length);
    }
    const upstream = httpRequest({ host: "127.0.0.1", port: connection.port, path, method: req.method, headers });
    const timer = setTimeout(() => upstream.destroy(Object.assign(new Error(`${MODULE_LABELS[connection.health.module]} did not answer within ${RESPONSE_TIMEOUT_MS / 1000}s`), { code: "ETIMEDOUT" })), RESPONSE_TIMEOUT_MS);
    const abandon = () => upstream.destroy();
    req.raw.once("close", () => {
      if (!reply.raw.writableEnded) abandon();
    });
    upstream.once("response", (res) => {
      clearTimeout(timer);
      reply.hijack();
      reply.raw.writeHead(res.statusCode ?? 502, responseHeaders(res.headers));
      res.pipe(reply.raw);
      res.once("end", () => resolve());
      res.once("error", () => {
        reply.raw.destroy();
        resolve();
      });
      reply.raw.once("close", () => {
        res.destroy();
        resolve();
      });
    });
    upstream.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === "ETIMEDOUT") reject(new ModuleError(error.message, 504));
      else if (reply.raw.headersSent) resolve();
      else reject(error.code === "ECONNREFUSED" ? error : new ModuleError(`the module stopped answering: ${error.message}`, 502));
    });
    upstream.end(body ?? undefined);
  });
}

function responseHeaders(source: IncomingHttpHeaders): Record<string, string> {
  const headers: Record<string, string> = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
  for (const name of PASSED_RESPONSE_HEADERS) {
    const value = source[name];
    if (typeof value === "string") headers[name] = value;
  }
  // Server-Sent Events must not be held back by any buffering proxy in front of GGO.
  if (headers["content-type"]?.startsWith("text/event-stream")) headers["x-accel-buffering"] = "no";
  return headers;
}

/**
 * Relays a worker's stream (camera frames) to one browser. Frames are JPEG, so per-message compression is
 * switched off: deflating them would spend this event loop for nothing.
 */
async function relayStream(supervisor: ModuleSupervisor, id: ModuleId, browser: WebSocket): Promise<void> {
  let connection: WorkerConnection;
  try {
    connection = await supervisor.ensure(id);
  } catch (error) {
    if (browser.readyState === browser.OPEN) {
      browser.send(JSON.stringify({ t: "error", message: (error as Error).message }));
      browser.close(4503, "unavailable");
    }
    return;
  }
  if (browser.readyState !== browser.OPEN) return;
  const upstream = new WebSocket(`ws://127.0.0.1:${connection.port}/_stream`, { headers: { [WORKER_TOKEN_HEADER]: connection.token }, perMessageDeflate: false });
  const closeBoth = () => {
    if (browser.readyState === browser.OPEN || browser.readyState === browser.CONNECTING) browser.close(1000);
    if (upstream.readyState === upstream.OPEN || upstream.readyState === upstream.CONNECTING) upstream.terminate();
  };
  upstream.on("message", (data: RawData, isBinary: boolean) => {
    // The worker's socket drains into this relay even when the browser is slow. Bound the relay too,
    // otherwise camera frames accumulate in GGO itself despite the worker's own backpressure guard.
    if (browser.readyState === browser.OPEN && browser.bufferedAmount <= MAX_STREAM_BUFFERED_BYTES) browser.send(data as Buffer, { binary: isBinary, compress: false });
  });
  browser.on("message", (data: RawData, isBinary: boolean) => {
    if (upstream.readyState === upstream.OPEN) upstream.send(data as Buffer, { binary: isBinary });
  });
  upstream.on("error", () => {
    supervisor.forget(id);
    closeBoth();
  });
  upstream.on("close", closeBoth);
  browser.on("close", closeBoth);
  browser.on("error", closeBoth);
}
