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
import { randomUUID } from "node:crypto";
import {
  isAuthed,
  authMode,
  cookieValue,
  AUTH_COOKIE,
  SESSION_COOKIE,
  OAUTH_STATE_COOKIE,
  googleAuthUrl,
  signState,
  checkState,
  exchangeCodeForEmail,
  makeSession,
} from "./auth.js";

async function main(): Promise<void> {
  const db = new Db(config.dbPath);
  const hub = new EventHub();
  const memory = new FileMemoryService();
  const accounts = new AccountManager(config.accounts, hub, config.accountPingMs);
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

  // ---- access auth: Google OIDC (email allowlist) / legacy shared-token / none ----
  const cookie30d = (name: string, value: string) =>
    `${name}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 30}`;

  app.get("/api/me", async (req) => ({
    authed: isAuthed(req.headers.cookie),
    required: authMode() !== "none",
    mode: authMode(),
  }));

  const callbackUri = (req: { headers: { host?: string; "x-forwarded-proto"?: string | string[] } }) =>
    `${config.publicOrigin || `${(req.headers["x-forwarded-proto"] as string) || "http"}://${req.headers.host}`}/api/auth/callback`;

  app.get<{ Querystring: { select?: string } }>("/api/auth/google", async (req, reply) => {
    if (authMode() !== "google") return reply.code(404).send({ error: "google auth not configured" });
    const nonce = randomUUID();
    reply.header("set-cookie", `${OAUTH_STATE_COOKIE}=${nonce}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600`);
    return reply.redirect(googleAuthUrl(callbackUri(req), signState(nonce), req.query.select ? "select_account" : undefined));
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>("/api/auth/callback", async (req, reply) => {
    if (authMode() !== "google") return reply.redirect("/");
    const clearState = `${OAUTH_STATE_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
    const fail = (e: string) => {
      reply.header("set-cookie", clearState);
      return reply.redirect(`/?e=${e}`);
    };
    // state must match both our signature AND the per-browser cookie nonce (CSRF binding)
    if (req.query.error || !req.query.code || !checkState(req.query.state, cookieValue(req.headers.cookie, OAUTH_STATE_COOKIE))) {
      return fail("auth");
    }
    const email = await exchangeCodeForEmail(req.query.code, callbackUri(req));
    if (!email) return fail("auth");
    if (email.toLowerCase() !== config.allowedEmail) return fail("forbidden");
    reply.header("set-cookie", [clearState, cookie30d(SESSION_COOKIE, makeSession(email))]);
    return reply.redirect("/");
  });

  // Legacy shared-token login (only when AUTH_TOKEN mode is active).
  app.post<{ Body: { token?: string } }>("/api/login", async (req, reply) => {
    if (authMode() !== "token") return { ok: authMode() === "none" };
    if (req.body && config.authToken && req.body.token === config.authToken) {
      reply.header("set-cookie", cookie30d(AUTH_COOKIE, config.authToken));
      return { ok: true };
    }
    return reply.code(401).send({ ok: false, error: "invalid token" });
  });

  app.get("/api/logout", async (_req, reply) => {
    reply.header("set-cookie", [
      `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
      `${AUTH_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
    ]);
    return reply.redirect("/");
  });

  // Serve pasted-image bytes on demand (refs travel over WS; bytes stay off it).
  const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
  app.get<{ Params: { id: string } }>("/api/attachment/:id", async (req, reply) => {
    if (!isAuthed(req.headers.cookie)) return reply.code(401).send({ error: "unauthorized" });
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
        authMode() === "google"
          ? `  access: Google sign-in required — allowlisted to ${config.allowedEmail}`
          : authMode() === "token"
            ? `  access: AUTH_TOKEN required (LAN/tablet access enabled)`
            : ``,
        config.hostWarning ? `  ⚠ ${config.hostWarning}` : ``,
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
