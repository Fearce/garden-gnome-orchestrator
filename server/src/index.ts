import Fastify from "fastify";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { config } from "./config.js";
import { Db } from "./db/db.js";
import { EventHub } from "./events.js";
import { FileMemoryService } from "./memory/memory.js";
import { AccountManager } from "./accounts/accountManager.js";
import { ThreadManager } from "./orchestrator/threadManager.js";
import { Director } from "./orchestrator/director.js";
import { registerWs } from "./ws/hub.js";

async function main(): Promise<void> {
  const db = new Db(config.dbPath);
  const hub = new EventHub();
  const memory = new FileMemoryService();
  const accounts = new AccountManager(config.accounts, hub, config.accountTickMs);
  const manager = new ThreadManager(db, hub, memory, accounts);
  const director = new Director(manager, db, hub);
  accounts.start();

  const app = Fastify({ logger: false });

  // Pasted images travel inline (base64) in a single prompt.new frame; lift the
  // default ws payload cap so a few screenshots don't get dropped on send.
  await app.register(websocket, { options: { maxPayload: 64 * 1024 * 1024 } });
  registerWs(app, { db, hub, manager, director, accounts });

  app.get("/api/health", async () => ({
    ok: true,
    auth: config.oauthToken ? "oauth-token" : "inherited-cli-login",
    models: config.models,
  }));

  // Serve pasted-image bytes on demand (refs travel over WS; bytes stay off it).
  const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
  app.get<{ Params: { id: string } }>("/api/attachment/:id", async (req, reply) => {
    const a = db.getAttachment(req.params.id);
    if (!a) return reply.code(404).send({ error: "not found" });
    const type = ALLOWED_IMAGE_TYPES.has(a.mediaType) ? a.mediaType : "application/octet-stream";
    return reply
      .header("content-type", type)
      .header("x-content-type-options", "nosniff")
      .header("cache-control", "private, max-age=31536000, immutable")
      .send(Buffer.from(a.data, "base64"));
  });

  // Serve the built frontend in production (single origin). In dev, Vite serves it.
  if (existsSync(config.webDist)) {
    await app.register(fastifyStatic, { root: config.webDist, prefix: "/" });
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.url && req.raw.url.startsWith("/api")) {
        reply.code(404).send({ error: "not found" });
        return;
      }
      reply.sendFile("index.html");
    });
  }

  try {
    await app.listen({ port: config.port, host: config.host });
    const apiKeyWarning = process.env.ANTHROPIC_API_KEY
      ? "  ⚠ ANTHROPIC_API_KEY is set in this shell; agents drop it and use your subscription."
      : "";
    // eslint-disable-next-line no-console
    console.log(
      [
        ``,
        `  Claude Orchestrator server`,
        `  http://${config.host}:${config.port}   (ws: /ws)`,
        `  auth: ${config.oauthToken ? "CLAUDE_CODE_OAUTH_TOKEN" : "inherited Claude Code login"} (subscription, no API credits)`,
        `  accounts: ${config.accounts.length} (${config.accounts.map((a) => a.label).join(", ")})${config.accounts.length > 1 ? " — load-balancing by burn ratio" : ""}`,
        `  data: ${config.dbPath}`,
        apiKeyWarning,
        ``,
      ]
        .filter((l) => l !== "")
        .join("\n"),
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("Failed to start server:", err);
    process.exit(1);
  }
}

void main();
