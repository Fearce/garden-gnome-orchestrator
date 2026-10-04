import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isCrossSiteRequest } from "./crossSite.js";
import { isDirectLocal, isTunneled } from "./remoteAccess.js";

/**
 * Server half of the optional desktop app (desktop/). The app is an ordinary client of this console; these
 * routes only bridge what a separate program needs:
 *  - a one-time sign-in TICKET, so the browser can hand its session to the app ("Open in desktop", and
 *    Google sign-in, which Google refuses inside an embedded browser and the app therefore runs in the
 *    system browser);
 *  - PRESENCE, so the web console offers "Open in desktop" only on a machine where the app has run and
 *    so registered its `ggo://` link handler.
 * Nothing here runs unless a client calls it, so a web-only install pays nothing.
 */

const TICKET_TTL_MS = 2 * 60_000;
const TICKET = /^[A-Za-z0-9_-]{43}$/;
const THREAD_ID = /^[A-Za-z0-9-]{8,64}$/;
const PRESENCE_KEY = "desktop_clients";
const PRESENCE_TTL_MS = 60 * 24 * 3600_000;
/** Refresh a machine's stored timestamp at most this often, so app launches do not churn kv writes. */
const PRESENCE_REFRESH_MS = 3600_000;
const MAX_MACHINES = 16;
const DESKTOP_UA = /\bGGODesktop\/([0-9A-Za-z.+-]{1,32})/;

/** The Google sign-in cookie that marks a sign-in started by the desktop app. */
export const DESKTOP_SIGN_IN_COOKIE = "orch_oauth_desktop";

export function isDesktopClient(userAgent: string | undefined): boolean {
  return !!userAgent && DESKTOP_UA.test(userAgent);
}

export interface DesktopTickets {
  mint(): string;
  /** True once per ticket, within its lifetime. */
  redeem(ticket: string): boolean;
}

/** In memory on purpose: a ticket lives two minutes, and a restart that drops one costs one retry. Shared by
 *  the HTTP and HTTPS listeners, so a ticket minted on one redeems on the other. */
export function createDesktopTickets(now: () => number = Date.now): DesktopTickets {
  const live = new Map<string, number>();
  const prune = () => {
    for (const [ticket, expires] of live) if (expires <= now()) live.delete(ticket);
  };
  return {
    mint() {
      prune();
      const ticket = randomBytes(32).toString("base64url");
      live.set(ticket, now() + TICKET_TTL_MS);
      return ticket;
    },
    redeem(ticket) {
      const expires = live.get(ticket);
      live.delete(ticket);
      return expires !== undefined && expires > now();
    },
  };
}

export interface DesktopRouteDeps {
  isAuthed: (cookie: string | undefined) => boolean;
  /** A Set-Cookie value carrying a fresh owner session for this request (same attributes as a login). */
  sessionCookie: (req: FastifyRequest) => string;
  kv: { get(key: string): string | null; set(key: string, value: string): void };
  tickets: DesktopTickets;
  now?: () => number;
}

type Presence = Record<string, { lastSeenAt: number; version: string }>;

/** Which machine a request comes from, as far as a `ggo://` handler is concerned. A tunnel is nobody's. */
function machineKey(req: FastifyRequest): string | null {
  if (isTunneled(req)) return null;
  return isDirectLocal(req) ? "local" : req.ip;
}

function readPresence(deps: DesktopRouteDeps): Presence {
  try {
    const parsed = JSON.parse(deps.kv.get(PRESENCE_KEY) ?? "{}") as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Presence) : {};
  } catch {
    return {};
  }
}

function recordPresence(deps: DesktopRouteDeps, key: string, version: string, now: number): void {
  const presence = readPresence(deps);
  const seen = presence[key];
  if (seen && seen.version === version && now - seen.lastSeenAt < PRESENCE_REFRESH_MS) return;
  presence[key] = { lastSeenAt: now, version };
  const kept = Object.entries(presence)
    .filter(([, entry]) => now - entry.lastSeenAt < PRESENCE_TTL_MS)
    .sort(([, a], [, b]) => b.lastSeenAt - a.lastSeenAt)
    .slice(0, MAX_MACHINES);
  deps.kv.set(PRESENCE_KEY, JSON.stringify(Object.fromEntries(kept)));
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * The page the system browser lands on after a desktop-started Google sign-in, carrying a fresh ticket
 * back into the app. Only the OAuth callback renders it: a standalone route would let any page that
 * steers the owner's signed-in browser there mint a ticket for an app on another machine.
 */
export function desktopHandoffPage(tickets: DesktopTickets): string {
  const href = escapeHtml(`ggo://auth?ticket=${tickets.mint()}`);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Opening GG Orchestrator</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="0;url=${href}">
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0e1016;color:#eef0f6;font:15px/1.5 "Inter Tight","Segoe UI",sans-serif}
main{width:min(420px,90vw)}h1{font-size:22px;font-weight:600;margin:0 0 8px}p{color:#a6abb8;margin:0 0 20px}
a{display:inline-block;padding:9px 16px;border-radius:6px;background:#f2b54a;color:#2a2010;font-weight:600;text-decoration:none}
</style></head>
<body><main><h1>You're signed in</h1><p>Returning to the GG Orchestrator desktop app. If your browser asks, allow it to open the app. You can close this tab afterwards.</p>
<a href="${href}">Open GG Orchestrator</a></main></body></html>`;
}

/** Where a redeemed ticket lands: the console root, relative so a mounted console stays under its mount. */
function consoleLocation(thread: string | undefined, error?: string): string {
  if (error) return `../../?e=${error}`;
  return thread && THREAD_ID.test(thread) ? `../../?thread=${thread}` : "../../";
}

export function registerDesktopRoutes(app: FastifyInstance, deps: DesktopRouteDeps): void {
  const now = deps.now ?? Date.now;
  const authed = (req: FastifyRequest) => deps.isAuthed(req.headers.cookie);
  const unauthorized = (reply: FastifyReply) => reply.code(401).send({ error: "unauthorized" });

  // The web console asks once per load whether to offer "Open in desktop" here.
  app.get("/api/desktop/availability", async (req, reply) => {
    if (!authed(req)) return unauthorized(reply);
    reply.header("cache-control", "no-store");
    const key = machineKey(req);
    const seen = key ? readPresence(deps)[key] : undefined;
    return { available: !!seen && now() - seen.lastSeenAt < PRESENCE_TTL_MS };
  });

  // The desktop app's console page reports in once per load; its user agent names the app.
  app.post("/api/desktop/presence", async (req, reply) => {
    const version = DESKTOP_UA.exec(req.headers["user-agent"] ?? "")?.[1];
    if (!version) return reply.code(403).send({ error: "only the desktop app registers itself" });
    if (!authed(req)) return unauthorized(reply);
    if (isCrossSiteRequest(req)) return reply.code(403).send({ error: "cross-site requests are refused" });
    const key = machineKey(req);
    if (key) recordPresence(deps, key, version, now());
    return { ok: true };
  });

  app.post("/api/desktop/ticket", async (req, reply) => {
    if (!authed(req)) return unauthorized(reply);
    if (isCrossSiteRequest(req)) return reply.code(403).send({ error: "cross-site requests are refused" });
    reply.header("cache-control", "no-store");
    return { ticket: deps.tickets.mint() };
  });

  app.get<{ Querystring: { ticket?: string; thread?: string } }>("/api/desktop/redeem", async (req, reply) => {
    reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer");
    const ticket = req.query.ticket ?? "";
    if (!TICKET.test(ticket) || !deps.tickets.redeem(ticket)) return reply.redirect(consoleLocation(undefined, "desktop"));
    reply.header("set-cookie", deps.sessionCookie(req));
    return reply.redirect(consoleLocation(req.query.thread));
  });
}
