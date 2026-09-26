import type { FastifyInstance } from "fastify";

// Cloudflare Tunnel can forward this mount directly to GGO. Its path matcher preserves the prefix,
// so strip it before routing; the root/LAN routes continue to use the exact same handlers and auth.
export const CONSOLE_MOUNT = "/orchestrator";
export function rewriteConsoleUrl(request: { url?: string }): string {
  const url = request.url ?? "/";
  return url.startsWith(CONSOLE_MOUNT + "/") ? url.slice(CONSOLE_MOUNT.length) : url;
}

export function registerConsoleMount(app: FastifyInstance): void {
  app.get(CONSOLE_MOUNT, async (request, reply) => {
    const query = request.originalUrl.indexOf("?");
    return reply.redirect(CONSOLE_MOUNT + "/" + (query < 0 ? "" : request.originalUrl.slice(query)), 308);
  });
  app.addHook("onSend", async (request, reply, payload) => {
    const location = reply.getHeader("location");
    if (request.originalUrl.startsWith(CONSOLE_MOUNT + "/") && typeof location === "string"
      && location.startsWith("/") && !location.startsWith("//")
      && location !== CONSOLE_MOUNT && !location.startsWith(CONSOLE_MOUNT + "/")) {
      reply.header("location", CONSOLE_MOUNT + location);
    }
    return payload;
  });
}
