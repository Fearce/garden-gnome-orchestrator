import type { IncomingMessage, ServerResponse } from "node:http";
import { promisify } from "node:util";
import { gzip } from "node:zlib";

const gzipAsync = promisify(gzip);

export class HttpError extends Error {
  constructor(public readonly status: number, message: string, public readonly extra: Record<string, unknown> = {}) {
    super(message);
  }
}

export interface ModuleRequest {
  method: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  raw: IncomingMessage;
  res: ServerResponse;
}

/** A handler returns a JSON body, or `STREAMED` once it has written `res` itself (SSE, images). */
export const STREAMED = Symbol("streamed");
export type Handler = (req: ModuleRequest) => Promise<unknown | typeof STREAMED> | unknown;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

const MAX_BODY_BYTES = 1024 * 1024;

/** The few verbs and `:param` paths a module needs, without pulling a framework into every worker. */
export class Router {
  private readonly routes: Route[] = [];

  get(path: string, handler: Handler): this { return this.add("GET", path, handler); }
  post(path: string, handler: Handler): this { return this.add("POST", path, handler); }
  put(path: string, handler: Handler): this { return this.add("PUT", path, handler); }
  delete(path: string, handler: Handler): this { return this.add("DELETE", path, handler); }

  private add(method: string, path: string, handler: Handler): this {
    const keys: string[] = [];
    const source = path.replace(/:([a-zA-Z]+)/g, (_m, key: string) => {
      keys.push(key);
      return "([^/]+)";
    });
    this.routes.push({ method, pattern: new RegExp(`^${source}$`), keys, handler });
    return this;
  }

  /** True when a route answered (even with an error); false when nothing matched the path. */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    let pathMatched = false;
    for (const route of this.routes) {
      const match = route.pattern.exec(url.pathname);
      if (!match) continue;
      pathMatched = true;
      if (route.method !== req.method) continue;
      const params = Object.fromEntries(route.keys.map((key, i) => [key, decodeURIComponent(match[i + 1] ?? "")]));
      try {
        const body = req.method === "GET" || req.method === "DELETE" ? undefined : await readJsonBody(req);
        const result = await route.handler({ method: req.method, params, query: url.searchParams, body, raw: req, res });
        if (result !== STREAMED) await sendJson(res, 200, result ?? { ok: true }, req);
      } catch (error) {
        if (res.headersSent) {
          res.destroy();
        } else if (error instanceof HttpError) {
          sendJson(res, error.status, { error: error.message, ...error.extra });
        } else {
          sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
        }
      }
      return true;
    }
    if (pathMatched) {
      sendJson(res, 405, { error: "method not allowed" });
      return true;
    }
    return false;
  }
}

const GZIP_FROM_BYTES = 32 * 1024;

/** JSON reply. A large body (Script Hub's full registry is ~700 KB) is gzipped here, in the worker, when the
 *  caller accepts it, so the console relays compressed bytes without spending its own thread on them. */
export async function sendJson(res: ServerResponse, status: number, body: unknown, req?: IncomingMessage): Promise<void> {
  const text = Buffer.from(JSON.stringify(body), "utf8");
  const headers: Record<string, string | number> = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
  let payload = text;
  if (text.length >= GZIP_FROM_BYTES && /\bgzip\b/.test(String(req?.headers["accept-encoding"] ?? ""))) {
    payload = await gzipAsync(text, { level: 6 });
    headers["content-encoding"] = "gzip";
    headers.vary = "accept-encoding";
  }
  headers["content-length"] = payload.length;
  res.writeHead(status, headers);
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "request body too large");
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "request body is not valid JSON");
  }
}
