import type { FastifyRequest } from "fastify";

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
