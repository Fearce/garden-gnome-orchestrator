import type { IncomingHttpHeaders } from "node:http";
import type { FastifyInstance } from "fastify";
import { isLoopbackAddress } from "./orchestrator/restartCoordinator.js";

/**
 * Remote access through a tunnel (Tailscale Funnel/Serve, cloudflared, a local reverse proxy).
 *
 * A tunnel daemon runs on this machine, so every request it relays arrives from loopback and would
 * otherwise pass for a local caller. What tells them apart is the forwarding header the daemon adds to
 * name the real client; a local child process (deploy script, probe) sends none. A tunnelled request
 * is therefore handled as internet traffic: Google sign-in only, every API route behind the session,
 * and closed entirely when Google sign-in is not configured. See docs/remote-access.md.
 */

type RequestLike = { ip: string; headers: IncomingHttpHeaders };

const FORWARDING_HEADERS = [
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "forwarded",
  "x-real-ip",
  "cf-connecting-ip",
  "tailscale-user-login",
  "tailscale-funnel-request",
] as const;

// Routes a signed-out browser needs to reach the sign-in screen and finish Google sign-in.
const SIGN_IN_ROUTES = new Set(["/api/me", "/api/auth/google", "/api/auth/callback", "/api/logout"]);
// The built console's static files (the @fastify/static wildcard). Unmatched URLs fall through to the
// SPA shell or an /api 404 and are allowed too: neither reaches a handler. The wildcard also matches
// unknown /api paths, which stay gated so an API miss never answers a signed-out stranger differently.
const STATIC_ROUTE = "/*";

function isStaticAsset(route: string | undefined, url: string): boolean {
  if (route === undefined) return true;
  return route === STATIC_ROUTE && !url.startsWith("/api");
}

/** Relayed by a local tunnel or proxy: loopback source plus a header naming some other client. */
export function isTunneled(req: RequestLike): boolean {
  return isLoopbackAddress(req.ip) && FORWARDING_HEADERS.some((name) => req.headers[name] !== undefined);
}

/** A process on this machine talking to the server directly, not through a tunnel. */
export function isDirectLocal(req: RequestLike): boolean {
  return isLoopbackAddress(req.ip) && !isTunneled(req);
}

/** What the sign-in screen offers this request. A tunnel never gets the password form. */
export function loginOptions(
  req: RequestLike,
  auth: { google: boolean; password: boolean },
): { required: boolean; google: boolean; password: boolean } {
  if (isTunneled(req)) return { required: true, google: auth.google, password: false };
  return { required: auth.google || auth.password, google: auth.google, password: auth.password };
}

/** Extra Set-Cookie attributes for a request that reached us over HTTPS through a tunnel. */
export function remoteCookieAttributes(req: RequestLike): string {
  return isTunneled(req) && req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
}

export function registerRemoteGate(
  app: FastifyInstance,
  auth: { googleEnabled: () => boolean; isAuthed: (cookie: string | undefined) => boolean },
): void {
  app.addHook("onRequest", async (req, reply) => {
    if (!isTunneled(req)) return;
    if (!auth.googleEnabled()) {
      return reply.code(403).send({ error: "remote access needs Google sign-in configured on the server" });
    }
    const route = req.routeOptions.url;
    if (isStaticAsset(route, req.url) || (route !== undefined && SIGN_IN_ROUTES.has(route))) return;
    if (!auth.isAuthed(req.headers.cookie)) return reply.code(401).send({ error: "unauthorized" });
  });
}
