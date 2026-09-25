import type { FastifyInstance } from "fastify";

/** Optional navigation only. Authentication/isolation belongs to the personal
 * instance gateway, never to a client-provided return URL or this metadata. */
export function portalLink(env: NodeJS.ProcessEnv = process.env): { enabled: boolean; url?: string; label?: string; environment?: string } {
  if (!env.GGO_PORTAL_URL) return { enabled: false };
  try {
    const url = new URL(env.GGO_PORTAL_URL);
    if (url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))) return { enabled: false };
    return { enabled: true, url: url.href, label: (env.GGO_PORTAL_LABEL || "Admin workspace").slice(0, 50), environment: (env.GGO_ENVIRONMENT_LABEL || "Personal GGO").slice(0, 80) };
  } catch { return { enabled: false }; }
}
export function registerPortalLink(app: FastifyInstance, isAuthed: (cookie: string | undefined) => boolean): void {
  app.get("/api/portal", async (req, reply) => {
    reply.header("cache-control", "no-store");
    if (!isAuthed(req.headers.cookie)) return reply.code(401).send({ error: "unauthorized" });
    return portalLink();
  });
}
