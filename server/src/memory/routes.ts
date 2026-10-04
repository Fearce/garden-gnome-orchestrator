import type { FastifyInstance, FastifyRequest } from "fastify";
import { basename } from "node:path";
import { z } from "zod";
import { isCrossSiteRequest } from "../crossSite.js";
import { isDirectLocal } from "../remoteAccess.js";
import { promptRecallBlock, sessionRecallBlock } from "./agentHooks.js";
import { MEMORY_TYPES } from "./corpus.js";
import type { MemoryEndpoint } from "./endpoint.js";
import type { FileMemoryService } from "./memory.js";
import type { MemorySettingsStore } from "./settings.js";

const fileParams = z.object({ file: z.string().min(1).max(200) });
const listQuery = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  filter: z.string().max(200).default(""),
});
const searchBody = z.object({
  query: z.string().trim().min(1).max(4000),
  mode: z.enum(["search", "prompt", "session"]).default("search"),
  limit: z.number().int().min(1).max(15).default(8),
});
const createBody = z.object({
  type: z.enum(MEMORY_TYPES),
  name: z.string().trim().min(3).max(80),
  description: z.string().trim().min(10).max(200),
  body: z.string().trim().min(10).max(20_000),
  triggers: z.array(z.string().trim().min(2).max(120)).max(12).optional(),
});
const updateBody = z.object({
  type: z.enum(MEMORY_TYPES).optional(),
  name: z.string().trim().min(3).max(80).optional(),
  description: z.string().trim().min(10).max(200).optional(),
  body: z.string().trim().min(10).max(20_000).optional(),
});
const settingsBody = z.object({
  modelRanking: z.boolean().optional(),
  cards: z.boolean().optional(),
  extraction: z.boolean().optional(),
  lunaFallback: z.boolean().optional(),
  agentRecall: z.boolean().optional(),
});
/** A hook script runs under its own wall-clock deadline, so it passes the share of it recall may use. */
const hookTimeout = z.number().int().min(1_000).max(15_000).optional();
const hookRecallBody = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("prompt"), prompt: z.string().max(200_000), timeoutMs: hookTimeout }),
  z.object({ mode: z.literal("session"), cwd: z.string().min(1).max(1_000), timeoutMs: hookTimeout }),
]);
const hookSearchBody = z.object({
  query: z.string().trim().min(1).max(4000),
  k: z.number().int().min(1).max(15).default(6),
  mode: z.enum(["search", "prompt", "session"]).default("search"),
});
const hookExtractBody = z.object({
  source: z.string().trim().min(1).max(60),
  sessionId: z.string().max(200).nullable().default(null),
  text: z.string().max(400_000),
});

interface MemoryRouteDeps {
  memory: FileMemoryService;
  settings: MemorySettingsStore;
  endpoint: MemoryEndpoint;
  isAuthed: (cookie?: string) => boolean;
}

/**
 * The owner's memory over HTTP. `/api/memory/*` serves the console (session cookie, same-site only);
 * `/api/memory/hook/*` serves the user-level hook scripts on this machine, which hold the per-boot token
 * from the memory directory's endpoint file and are refused unless they connect directly on loopback.
 */
export function registerMemoryRoutes(app: FastifyInstance, deps: MemoryRouteDeps): void {
  void app.register(async (routes) => {
    routes.addHook("onRequest", async (req, res) => {
      res.header("cache-control", "no-store");
      if (isHookRoute(req)) {
        if (!isDirectLocal(req) || !deps.endpoint.accepts(req.headers.authorization)) return res.code(401).send({ error: "unauthorized" });
        return;
      }
      if (!deps.isAuthed(req.headers.cookie)) return res.code(401).send({ error: "unauthorized" });
      if (isCrossSiteRequest(req)) return res.code(403).send({ error: "Cross-site memory requests are refused." });
    });
    routes.setErrorHandler((error, _req, res) => {
      if (error instanceof z.ZodError) return res.code(400).send({ error: `Invalid memory request: ${error.issues.map((i) => i.path.join(".") || "body").join(", ")}.` });
      return res.code(500).send({ error: `The memory request failed: ${error instanceof Error ? error.message : String(error)}` });
    });
    registerConsoleRoutes(routes, deps);
    registerHookRoutes(routes, deps);
  });
}

function isHookRoute(req: FastifyRequest): boolean {
  return (req.routeOptions.url ?? req.url).startsWith("/api/memory/hook/");
}

function registerConsoleRoutes(routes: FastifyInstance, { memory, settings }: MemoryRouteDeps): void {
  routes.get("/api/memory/status", () => memory.status());
  routes.get("/api/memory/settings", () => settings.get());
  routes.put("/api/memory/settings", (req) => {
    const next = settings.update(settingsBody.parse(req.body));
    memory.settingsChanged();
    return next;
  });
  routes.post("/api/memory/search", async (req) => {
    const b = searchBody.parse(req.body);
    const result = await memory.recall(b.query, b.mode, b.limit, 20_000);
    return { ...result, memories: result.memories.map(publicHit) };
  });
  routes.get("/api/memory/files", (req) => {
    const q = listQuery.parse(req.query);
    return memory.list(q.offset, q.limit, q.filter);
  });
  routes.get("/api/memory/files/:file", async (req, res) => {
    const found = await memory.get(fileParams.parse(req.params).file);
    return found ?? res.code(404).send({ error: "No such memory." });
  });
  routes.post("/api/memory/files", async (req) => {
    const file = await memory.create(createBody.parse(req.body));
    return { ok: true, file };
  });
  routes.patch("/api/memory/files/:file", async (req, res) => {
    const { file } = fileParams.parse(req.params);
    const ok = await memory.update(file, updateBody.parse(req.body));
    return ok ? { ok: true, file } : res.code(404).send({ error: "No such memory." });
  });
  routes.delete("/api/memory/files/:file", async (req, res) => {
    const moved = await memory.remove(fileParams.parse(req.params).file);
    return moved ? { ok: true, trashedAs: basename(moved) } : res.code(404).send({ error: "No such memory." });
  });
  routes.post("/api/memory/reindex", async () => {
    await memory.reindex();
    return { ok: true };
  });
}

function registerHookRoutes(routes: FastifyInstance, { memory, settings }: MemoryRouteDeps): void {
  routes.post("/api/memory/hook/recall", async (req) => {
    const b = hookRecallBody.parse(req.body);
    const context =
      b.mode === "prompt" ? await promptRecallBlock(memory, b.prompt, memory.dir, b.timeoutMs) : await sessionRecallBlock(memory, b.cwd, memory.dir, b.timeoutMs);
    return { context };
  });
  routes.post("/api/memory/hook/search", async (req) => {
    const b = hookSearchBody.parse(req.body);
    return { hits: await memory.search(b.query, b.k, b.mode) };
  });
  routes.post("/api/memory/hook/extract", async (req) => {
    const b = hookExtractBody.parse(req.body);
    if (!settings.get().extraction) return { outcome: "disabled" };
    return { outcome: await memory.enqueueExtraction(b) };
  });
  routes.get("/api/memory/hook/status", () => memory.status());
  routes.post("/api/memory/hook/forget", async (req, res) => {
    const moved = await memory.remove(fileParams.parse(req.body).file);
    return moved ? { ok: true, trashedAs: basename(moved) } : res.code(404).send({ error: "No such memory." });
  });
  routes.post("/api/memory/hook/changed", () => {
    memory.changed();
    return { ok: true };
  });
}

function publicHit(memory: { file: string; name: string; description: string; type: string; lastVerified: string; score: number; judgedBy: "model" | "lexical" }) {
  return { file: memory.file, name: memory.name, description: memory.description, type: memory.type, lastVerified: memory.lastVerified, score: memory.score, judgedBy: memory.judgedBy };
}
