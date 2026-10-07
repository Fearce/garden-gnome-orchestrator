import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { isCrossSiteRequest } from "../crossSite.js";
import { ROLES } from "../types.js";
import type { ThreadManager } from "../orchestrator/threadManager.js";

const address = z.object({ threadId: z.string().min(1).max(200), role: z.enum(ROLES) }).strict();
const page = address.extend({ before: z.coerce.number().int().positive().optional() });
const send = z.object({ recipient: address, body: z.string().trim().min(1).max(2000) }).strict();
const ack = z.object({ throughId: z.number().int().positive() }).strict();

export function registerDirectMessageRoutes(app: FastifyInstance, manager: ThreadManager, isAuthed: (cookie?: string) => boolean): void {
  app.register(async routes => {
    routes.addHook("onRequest", async (req, reply) => {
      reply.header("cache-control", "no-store");
      if (isCrossSiteRequest(req)) return reply.code(403).send({ error: "Cross-site inbox requests are refused." });
      const agentPath = (req.url.split("?")[0] ?? "").startsWith("/api/gnome-inbox/agent/");
      if (agentPath) {
        if (!manager.directInbox.identify(req.headers.authorization?.replace(/^Bearer /, "") ?? "")) {
          return reply.code(401).send({ error: "Invalid inbox capability." });
        }
      } else if (!isAuthed(req.headers.cookie)) return reply.code(401).send({ error: "unauthorized" });
    });
    routes.setErrorHandler((error, _req, reply) => {
      if (error instanceof z.ZodError) return reply.code(400).send({ error: "Invalid inbox request." });
      if (error instanceof Error && (error.message.startsWith("Unknown local gnome") || error.message.startsWith("Messages must"))) return reply.code(400).send({ error: error.message });
      reply.code(500).send({ error: "Inbox request failed." });
    });
    const caller = (authorization?: string) => manager.directInbox.identify(authorization?.replace(/^Bearer /, "") ?? "")!;
    routes.get("/api/gnome-inbox/directory", () => manager.directDirectory());
    routes.get("/api/gnome-inbox/messages", req => {
      const query = page.parse(req.query);
      return manager.directInbox.list(query, query.before);
    });
    routes.post("/api/gnome-inbox/messages", req => {
      const body = send.parse(req.body);
      return manager.directInbox.send(null, body.recipient, body.body);
    });
    // Viewing as owner never acknowledges a gnome's unread mail.
    routes.get("/api/gnome-inbox/agent/directory", () => manager.directDirectory().map(({ unread: _unread, ...gnome }) => gnome));
    routes.get("/api/gnome-inbox/agent/messages", req => {
      const query = z.object({ before: z.coerce.number().int().positive().optional() }).strict().parse(req.query);
      return manager.directInbox.list(caller(req.headers.authorization), query.before);
    });
    routes.post("/api/gnome-inbox/agent/messages", req => {
      const body = send.parse(req.body);
      return manager.directInbox.send(caller(req.headers.authorization), body.recipient, body.body);
    });
    routes.post("/api/gnome-inbox/agent/ack", req => ({ acknowledged: manager.directInbox.acknowledge(caller(req.headers.authorization), ack.parse(req.body).throughId) }));
  });
}
