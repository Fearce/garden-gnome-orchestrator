import type { FastifyInstance } from "fastify";
import type { Db } from "../db/db.js";
import { runChild } from "../childRunner.js";
import { CloudError, CloudSessionService, githubRepository } from "./service.js";

export function registerCloudSessionRoutes(app: FastifyInstance, service: CloudSessionService, db: Pick<Db, "getThread" | "listRuns">, isAuthed: (cookie?: string) => boolean): void {
  app.register(async (routes) => {
    routes.addHook("preHandler", async (req, reply) => {
      reply.header("cache-control", "no-store");
      if (!isAuthed(req.headers.cookie)) return reply.code(401).send({ error: "unauthorized" });
    });
    routes.setErrorHandler((error, _req, reply) => {
      reply.code(error instanceof CloudError ? error.status : 500).send({ error: error instanceof CloudError ? error.message : "Cloud session request failed." });
    });
    routes.get("/api/cloud-sessions", async () => service.snapshot());
    routes.put<{ Body: Record<string, unknown> }>("/api/cloud-sessions/connections", async (req) => {
      if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) throw new CloudError("Expected a connection object.");
      return service.save(req.body);
    });
    routes.delete<{ Params: { id: string } }>("/api/cloud-sessions/connections/:id", async (req) => {
      service.remove(req.params.id);
      return { ok: true };
    });
    routes.post<{ Body: Record<string, unknown> }>("/api/cloud-sessions/jobs", async (req) => {
      if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) throw new CloudError("Expected a task object.");
      if (req.body.sourceThreadId !== undefined) {
        if (typeof req.body.sourceThreadId !== "string") throw new CloudError("Invalid source task.");
        const thread = db.getThread(req.body.sourceThreadId);
        if (!thread) throw new CloudError("Source task not found.", 404);
        if (thread.state !== "paused" || db.listRuns(thread.id).some(r => ["starting", "running", "waiting"].includes(r.state))) throw new CloudError("Interrupt the local task before sending it to cloud.", 409);
        if (thread.modelRequest || thread.subTask || thread.lane === "read") throw new CloudError("Create a separate cloud task for a task with a pinned model or special lane.", 409);
        const remote = await runChild("git", ["config", "--get", "remote.origin.url"], { cwd: thread.homeWorkspace || thread.workspace, urgent: true });
        if (remote.code !== 0 || remote.timedOut || githubRepository(remote.stdout) !== service.connectionRepository(String(req.body.connectionId))) throw new CloudError("The routine must be attached to this task's GitHub repository.", 409);
        // Recheck after the async git read so a concurrently resumed task cannot dispatch twice.
        if (db.getThread(thread.id)?.state !== "paused" || db.listRuns(thread.id).some(r => ["starting", "running", "waiting"].includes(r.state))) throw new CloudError("The local task resumed; interrupt it before offloading.", 409);
      }
      return service.submit(req.body);
    });
  });
}
