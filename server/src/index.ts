import Fastify from "fastify";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { config } from "./config.js";
import { Db } from "./db/db.js";
import { EventHub } from "./events.js";
import { FileMemoryService } from "./memory/memory.js";
import { ThreadManager } from "./orchestrator/threadManager.js";
import { Director } from "./orchestrator/director.js";
import { registerWs } from "./ws/hub.js";

async function main(): Promise<void> {
  const db = new Db(config.dbPath);
  const hub = new EventHub();
  const memory = new FileMemoryService();
  const manager = new ThreadManager(db, hub, memory);
  const director = new Director(manager, db, hub);

  const app = Fastify({ logger: false });

  await app.register(websocket);
  registerWs(app, { db, hub, manager, director });

  app.get("/api/health", async () => ({
    ok: true,
    auth: config.oauthToken ? "oauth-token" : "inherited-cli-login",
    models: config.models,
  }));

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
