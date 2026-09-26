import type { IncomingHttpHeaders } from "node:http";
import type { FastifyInstance } from "fastify";
import { CONSOLE_MOUNT } from "./webMount.js";
import { isLoopbackAddress } from "./orchestrator/restartCoordinator.js";

/**
 * Remote access through a tunnel (Tailscale Funnel/Serve, cloudflared, a local reverse proxy).
 *
 * A tunnel daemon runs on this machine, so every request it relays arrives from loopback and would
 * otherwise pass for a local caller. What tells them apart is the forwarding header the daemon adds to
 * name the real client; a local child process (deploy script, probe) sends none. A tunnelled request
 * is therefore handled as internet traffic: Google sign-in only, every API route behind the session,
 * and closed entirely when Google sign-in is not configured. See docs/remote-access.md.
 *
 * Opt-in per install: all of this is inert unless REMOTE_ACCESS=1, so an install already fronted by
 * its own reverse proxy keeps behaving exactly as before.
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
const SIGN_IN_ROUTES = new Set([CONSOLE_MOUNT, "/api/me", "/api/auth/google", "/api/auth/callback", "/api/logout"]);
// The built console's static files (the @fastify/static wildcard). Unmatched URLs fall through to the
// SPA shell or an /api 404 and are allowed too: neither reaches a handler. The wildcard also matches
// unknown /api paths, which stay gated so an API miss never answers a signed-out stranger differently.
const STATIC_ROUTE = "/*";

function isStaticAsset(route: string | undefined, url: string): boolean {
  if (route === undefined) return true;
  return route === STATIC_ROUTE && !url.startsWith("/api");
}

/** Has this install opted into the remote link? Read per call, after dotenv has loaded server/.env. */
export function remoteAccessEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.REMOTE_ACCESS === "1";
}

/** Relayed by a local tunnel or proxy: loopback source plus a header naming some other client.
 *  Always false unless remote access is enabled, which keeps every rule below off for other installs. */
export function isTunneled(req: RequestLike): boolean {
  return remoteAccessEnabled() && isLoopbackAddress(req.ip) && hasForwardingHeaders(req);
}

function hasForwardingHeaders(req: RequestLike): boolean {
  return FORWARDING_HEADERS.some((name) => req.headers[name] !== undefined);
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

/** A Host header naming this machine. A DNS-rebinding page reaches 127.0.0.1 under its OWN name. */
export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.replace(/:\d+$/, "");
  return name === "localhost" || name === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(name);
}

/**
 * With the remote link on, the console never asks for sign-in on localhost: the owner at this PC is
 * signed in without a prompt, and only the public link asks for Google. Only a direct loopback
 * connection (never a tunnel, never the LAN) that also names this machine as its Host qualifies. The
 * minted session is put on the request, so every existing cookie check (routes, WebSocket) accepts
 * it, and returned as a cookie so the browser's WebSocket upgrade carries it too.
 */
export function registerLocalAutoSignIn(
  app: FastifyInstance,
  deps: { enabled: () => boolean; isAuthed: (cookie: string | undefined) => boolean; sessionCookie: () => string },
): void {
  app.addHook("onRequest", async (req, reply) => {
    // Forwarding headers disqualify on their own, whether or not REMOTE_ACCESS is on: a proxy that
    // rewrites Host to localhost must never turn into a free session.
    if (!deps.enabled() || !isLoopbackAddress(req.ip) || hasForwardingHeaders(req) || !isLoopbackHost(req.headers.host)) return;
    if (deps.isAuthed(req.headers.cookie)) return;
    const cookie = deps.sessionCookie();
    const pair = cookie.slice(0, cookie.indexOf(";") < 0 ? cookie.length : cookie.indexOf(";"));
    req.headers.cookie = req.headers.cookie ? `${req.headers.cookie}; ${pair}` : pair;
    reply.header("set-cookie", cookie);
  });
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
