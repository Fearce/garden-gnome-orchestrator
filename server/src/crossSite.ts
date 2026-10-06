import type { FastifyInstance, FastifyRequest } from "fastify";
import { isLoopbackHost, isTunneled } from "./remoteAccess.js";

/**
 * Whether a cookie-authenticated request came from another site, so its write must be refused.
 * Sec-Fetch-Site is the authority: the browser sets it and the deck's reverse proxy forwards it
 * unchanged, while that proxy rewrites Host, so comparing Origin with Host would refuse the console's
 * own requests. Origin vs Host is only the fallback for a client that sends no Sec-Fetch-Site.
 */
export function isCrossSiteRequest(req: FastifyRequest): boolean {
  const site = req.headers["sec-fetch-site"];
  if (site) return site !== "same-origin" && site !== "none";
  if (!req.headers.origin) return false;
  try {
    return new URL(req.headers.origin).host !== req.headers.host;
  } catch {
    return true;
  }
}

/** WebSocket upgrades are GETs, but browsers can open them across origins and read the reply. */
export function isCrossSiteSocket(req: FastifyRequest): boolean {
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") return true;
  const origin = req.headers.origin;
  // Non-browser clients do not send Origin. The WebSocket route still requires a session.
  if (!origin) return false;
  try {
    const source = new URL(origin);
    if (!(["http:", "https:"].includes(source.protocol)) || source.origin !== origin) return true;
    const matchesHost = (host: string | string[] | undefined) => {
      if (typeof host !== "string" || host.includes(",")) return false;
      try { return new URL(`${source.protocol}//${host}`).host === source.host; }
      catch { return false; }
    };
    if (matchesHost(req.headers.host)) return false;
    // A same-origin proxy may rewrite Host before forwarding the upgrade.
    if (isTunneled(req) && matchesHost(req.headers["x-forwarded-host"])) return false;
    // The local Deck and Vite dev server use different loopback ports from GGO.
    return !(isLoopbackHost(source.host) && isLoopbackHost(req.headers.host));
  } catch {
    return true;
  }
}

/** Refuse browser requests before local auto sign-in can mint a session for them. */
export function registerBrowserOriginGuard(app: FastifyInstance): void {
  app.addHook("onRequest", async (req, reply) => {
    const route = req.routeOptions.url;
    if (route === "/ws") {
      if (isCrossSiteSocket(req)) return reply.code(403).send({ error: "cross-site WebSocket refused" });
      return;
    }
    if (!route?.startsWith("/api/") || route === "/api/auth/google" || route === "/api/auth/callback") return;
    if (isCrossSiteRequest(req)) return reply.code(403).send({ error: "cross-site API request refused" });
  });
}
