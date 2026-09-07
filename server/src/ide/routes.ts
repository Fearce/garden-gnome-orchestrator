import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { IdeError, IdeService } from "./service.js";

const querySchema = z.object({ workspace: z.string().regex(/^[a-f0-9]{24}$/), path: z.string().max(2000).default("") });
export function registerIdeRoutes(app: FastifyInstance, service: IdeService, isAuthed: (cookie?: string) => boolean): void {
  void app.register(async routes => {
    routes.addHook("onRequest", async (req, reply) => {
      reply.header("cache-control", "no-store");
      if (!isAuthed(req.headers.cookie)) return reply.code(401).send({ error: "unauthorized" });
      // Cookie authentication must not make cross-site writes possible, even on a LAN.
      if (req.headers["sec-fetch-site"] === "cross-site") return reply.code(403).send({ error: "Cross-site IDE requests are refused." });
      if (req.headers.origin) {
        try { if (new URL(req.headers.origin).host !== req.headers.host) return reply.code(403).send({ error: "Origin does not match this console." }); }
        catch { return reply.code(403).send({ error: "Invalid origin." }); }
      }
    });
    routes.setErrorHandler((error, _req, reply) => {
      const code = (error as NodeJS.ErrnoException).code;
      const status = error instanceof IdeError ? error.status : error instanceof z.ZodError ? 400 : code === "ENOENT" ? 404 : code === "EACCES" || code === "EPERM" ? 403 : code === "EEXIST" ? 409 : 500;
      const message = error instanceof IdeError ? error.message : error instanceof z.ZodError ? "Invalid IDE request." : code === "ENOENT" ? "File or folder no longer exists." : code === "EEXIST" ? "A file already exists at that path." : "Filesystem operation failed. Check workspace permissions and retry.";
      return reply.code(status).send({ error: message });
    });
    routes.get("/api/ide/workspaces", () => service.workspaces());
    routes.get("/api/ide/tree", req => { const q = querySchema.parse(req.query); return service.tree(q.workspace, q.path); });
    routes.get("/api/ide/file", req => { const q = querySchema.parse(req.query); return service.read(q.workspace, q.path); });
    routes.get("/api/ide/repo", req => { const q = querySchema.parse(req.query); return service.repo(q.workspace); });
    routes.get("/api/ide/git-diff", req => { const q = querySchema.extend({ staged: z.enum(["true", "false"]) }).parse(req.query); return service.gitDiff(q.workspace, q.path, q.staged === "true"); });
    routes.get("/api/ide/search", req => {
      const q = querySchema.extend({ query: z.string().min(1).max(200), content: z.enum(["true", "false"]).default("false") }).parse(req.query);
      return service.search(q.workspace, q.query, q.content === "true");
    });
    routes.put("/api/ide/file", { bodyLimit: 13 * 1024 * 1024 }, req => {
      const b = querySchema.extend({ text: z.string().max(2 * 1024 * 1024), version: z.string().regex(/^[a-f0-9]{64}$/).nullable() }).parse(req.body);
      return service.save(b.workspace, b.path, b.text, b.version);
    });
  });
}
