import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { RemoteControlError, type RemoteControlService } from "./service.js";

const configPatchSchema = z.object({
  enabled: z.boolean(),
  ffmpegPath: z.string().min(1).max(1000).nullable(),
  encoder: z.enum(["h264_nvenc", "libx264"]).nullable(),
  display: z.number().int().min(0).max(15),
  quality: z.enum(["sharp", "smooth", "saver"]),
  customFfmpegPath: z.string().max(1000).nullable(),
}).partial().strict();

/**
 * Remote control's HTTP setup surface and its stream socket. Every route needs the owner's session;
 * the socket additionally needs a single-use ticket from `POST /ticket`, because a WebSocket handshake
 * is not bound by CORS and a cookie alone would let another site open one in the owner's browser.
 */
export function registerRemoteControlRoutes(app: FastifyInstance, service: RemoteControlService, isAuthed: (cookie?: string) => boolean): void {
  void app.register(async (routes) => {
    routes.addHook("onRequest", async (req, reply) => {
      reply.header("cache-control", "no-store");
      if (!isAuthed(req.headers.cookie)) return reply.code(401).send({ error: "unauthorized" });
      // Sec-Fetch-Site survives the deck's proxy (which rewrites Host), so it is the cross-site check here.
      const site = req.headers["sec-fetch-site"];
      if (site && site !== "same-origin" && site !== "none") return reply.code(403).send({ error: "Cross-site remote-control requests are refused." });
    });
    routes.setErrorHandler((error, _req, reply) => {
      const status = error instanceof RemoteControlError ? error.status : error instanceof z.ZodError ? 400 : 500;
      const message = error instanceof z.ZodError ? "Invalid remote-control request." : error instanceof Error ? error.message : String(error);
      return reply.code(status).send({ error: message });
    });

    routes.get("/api/remote-control/status", () => service.status());
    routes.post("/api/remote-control/check", () => service.check());
    routes.post("/api/remote-control/install-ffmpeg", () => {
      service.startInstall();
      return service.status().install;
    });
    routes.get("/api/remote-control/thumbnail", async (req, reply) => {
      const q = z.object({ display: z.coerce.number().int().min(0).max(15), ffmpeg: z.string().min(1).max(1000) }).parse(req.query);
      const jpeg = await service.thumbnail(q.display, q.ffmpeg);
      return reply.type("image/jpeg").send(jpeg);
    });
    routes.put("/api/remote-control/config", async (req) => service.saveConfig(configPatchSchema.parse(req.body)));
    routes.post("/api/remote-control/disconnect", () => {
      service.disconnect();
      return { ok: true };
    });
    routes.post("/api/remote-control/ticket", () => ({ ticket: service.issueTicket() }));

    routes.get("/api/remote-control/stream", { websocket: true }, (socket, req) => {
      const ticket = z.object({ ticket: z.string().max(100).optional() }).safeParse(req.query);
      if (!ticket.success || !service.redeemTicket(ticket.data.ticket)) {
        socket.close(4403, "ticket");
        return;
      }
      service.attach(socket, { address: clientAddress(req), userAgent: String(req.headers["user-agent"] ?? "") }).catch((error: Error) => {
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify({ t: "error", message: error.message }));
          socket.close(4500, "failed");
        }
      });
    });
  });
}

/** Who is connecting, for the session record. Proxies in front of GGO name the real client. */
function clientAddress(req: FastifyRequest): string {
  const forwarded = req.headers["cf-connecting-ip"] ?? req.headers["x-forwarded-for"];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
  return first || req.ip;
}
