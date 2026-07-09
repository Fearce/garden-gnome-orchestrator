import Fastify from "fastify";
import type { FastifyInstance, FastifyServerOptions } from "fastify";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, dirname, basename, extname, relative } from "node:path";
import { config } from "./config.js";
import { installCrashGuards } from "./crashLog.js";
import { Db } from "./db/db.js";
import { EventHub } from "./events.js";
import { FileMemoryService } from "./memory/memory.js";
import { AccountManager, type PersistedAccountUsage } from "./accounts/accountManager.js";
import { startCodexUsageMonitor } from "./agents/codexUsagePing.js";
import { ThreadManager } from "./orchestrator/threadManager.js";
import { Director } from "./orchestrator/director.js";
import { SKIP as FS_SKIP } from "./workspace/findWorkspace.js";
import { startWebAutoBuild } from "./webAutoBuild.js";
import { refreshStatus, getStatus, applyUpdate, startUpdatePoll } from "./update.js";
import { registerWs } from "./ws/hub.js";
import { randomUUID } from "node:crypto";
import {
  isAuthed,
  authRequired,
  googleEnabled,
  passwordEnabled,
  checkPassword,
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

/** statSync().isDirectory() that swallows races/permission errors (returns false instead of throwing). */
function isDirSafe(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// The built bundle's main JS asset carries Vite's content hash, so its filename changes on every
// web build. Clients poll /api/version and reload when the hash they loaded no longer matches —
// so a deploy reaches an already-open tab/kiosk without a manual hard-refresh. Cached by index.html
// mtime so the common case is a cheap stat, not a re-read+re-parse on every poll.
let bundleCache: { mtimeMs: number; version: string } | null = null;
function webBundleVersion(): string | null {
  const indexPath = join(config.webDist, "index.html");
  try {
    const mtimeMs = statSync(indexPath).mtimeMs;
    if (bundleCache?.mtimeMs === mtimeMs) return bundleCache.version;
    const html = readFileSync(indexPath, "utf8");
    const version = html.match(/assets\/[A-Za-z0-9._-]+\.js/)?.[0].split("/").pop() ?? null;
    if (version) bundleCache = { mtimeMs, version };
    return version;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const db = new Db(config.dbPath);
  const hub = new EventHub();
  const memory = new FileMemoryService();
  // Persist each account's last usage read (kv) so a restart can restore the 5h window-start stagger
  // instead of boot-pinging every account — which would start all their windows in sync again.
  const accounts = new AccountManager(config.accounts, hub, config.accountPingMs, {
    persist: {
      load: (id) => {
        const v = db.kvGet(`account_usage_${id}`);
        if (!v) return null;
        try {
          return JSON.parse(v) as PersistedAccountUsage;
        } catch {
          return null;
        }
      },
      save: (id, usage) => db.kvSet(`account_usage_${id}`, JSON.stringify(usage)),
    },
  });
  const manager = new ThreadManager(db, hub, memory, accounts);
  const director = new Director(manager, db, hub);
  accounts.start();
  // Live pickable-model lists for the Settings dropdowns — needs a subscription token, so start it after
  // the account manager. Boot-fetches from the provider models endpoints, then refreshes on a slow timer.
  manager.startModelCatalog();
  startWebAutoBuild();
  // Poll git for new upstream commits so the console can surface a quiet "update available" badge.
  startUpdatePoll();

  // Codex usage: rollout-file snapshots from real runs (cheap 30s poll) PLUS a periodic live read via
  // the codex app-server's account/rateLimits/read RPC — free (no model turn), so the 5h/weekly meters
  // and reset countdowns stay current even when Codex hasn't run for hours (the old "stuck at 13%").
  startCodexUsageMonitor(hub, {
    apiKey: () => manager.openaiApiKey(),
    configured: () => {
      const s = manager.settings();
      return s.codexEnabled || s.hasOpenaiKey || s.codexChatgptLogin;
    },
  });

  // Shared across both listeners so the per-IP wrong-password cooldown can't be
  // sidestepped by alternating between the HTTP and HTTPS ports.
  const loginCooldown = new Map<string, number>();

  // Build a fully-wired Fastify instance. Called once per listener (HTTP :4317
  // and the optional HTTPS :httpsPort) so both share the same db/hub/manager/
  // director/accounts and the same route surface. The optional `https` field
  // (PFX buffer + passphrase) flips Fastify into TLS mode at runtime; we keep the
  // typed shape on the http server so both instances share one FastifyInstance type.
  type ListenerOptions = FastifyServerOptions & { https?: { pfx: Buffer; passphrase: string } };
  async function buildApp(serverOpts: ListenerOptions): Promise<FastifyInstance> {
    const app = Fastify(serverOpts);

    // Pasted images travel inline (base64) in a single prompt.new frame; lift the
    // default ws payload cap so a few screenshots don't get dropped on send.
    await app.register(websocket, { options: { maxPayload: 64 * 1024 * 1024 } });
    registerWs(app, { db, hub, manager, director, accounts });

    app.get("/api/health", async () => ({
      ok: true,
      auth: config.oauthToken ? "oauth-token" : "inherited-cli-login",
      models: config.models,
    }));

    // The current built-bundle hash, so an open client can detect a deploy and reload itself.
    app.get("/api/version", async (_req, reply) => {
      reply.header("cache-control", "no-store");
      return { web: webBundleVersion() };
    });

    // How far the checkout is behind its git upstream — drives the quiet top-bar "update available"
    // badge. `?refresh=1` forces a network fetch; otherwise it's served from the throttled cache (a
    // background poll keeps it warm). Read-only and auth-gated.
    app.get<{ Querystring: { refresh?: string } }>("/api/update/status", async (req, reply) => {
      if (!isAuthed(req.headers.cookie)) return reply.code(401).send({ error: "unauthorized" });
      reply.header("cache-control", "no-store");
      return req.query.refresh !== undefined ? await refreshStatus(true) : getStatus();
    });

    // Apply the update: `git pull --ff-only` + rebuild, and restart the process when server code
    // changed. ALWAYS user-initiated (a badge click) — never automatic. Auth-gated; the action runs
    // shell commands against this server's own checkout, so it must never be reachable unauthenticated.
    app.post("/api/update/apply", async (req, reply) => {
      if (!isAuthed(req.headers.cookie)) return reply.code(401).send({ error: "unauthorized" });
      const result = await applyUpdate();
      if (!result.ok) return reply.code(409).send(result);
      return result;
    });

    // ---- voice-gateway bridge: the composer's mic toggle → the local voice-gateway (:3960) ----
    // Bridged here (same origin) so the HTTPS deck surface reaches it without mixed content, behind
    // this console's auth gate. Short timeout: a stopped gateway must read as "off", never hang the UI.
    const VOICE_GW = process.env.VOICE_GATEWAY_URL || "http://127.0.0.1:3960";
    const voiceFetch = async (path: string, init?: RequestInit): Promise<unknown> => {
      const res = await fetch(`${VOICE_GW}${path}`, { ...init, signal: AbortSignal.timeout(1500) });
      return res.json();
    };

    app.get("/api/voice/status", async (req, reply) => {
      if (!isAuthed(req.headers.cookie)) return reply.code(401).send({ error: "unauthorized" });
      reply.header("cache-control", "no-store");
      try {
        return { up: true, ...(await voiceFetch("/api/status") as object) };
      } catch {
        return { up: false };
      }
    });

    app.post<{ Body: { on?: boolean } }>("/api/voice/wake", async (req, reply) => {
      if (!isAuthed(req.headers.cookie)) return reply.code(401).send({ error: "unauthorized" });
      try {
        return await voiceFetch("/api/wake", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ on: !!req.body?.on }),
        });
      } catch {
        return reply.code(502).send({ error: "voice-gateway unreachable — start it in Script Hub" });
      }
    });

    // ---- access auth: Google sign-in AND/OR a password (both valid) → signed session cookie ----
    const cookie30d = (name: string, value: string) =>
      `${name}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 30}`;

    app.get("/api/me", async (req) => ({
      authed: isAuthed(req.headers.cookie),
      required: authRequired(),
      google: googleEnabled(),
      password: passwordEnabled(),
    }));

    const callbackUri = (req: { headers: { host?: string; "x-forwarded-proto"?: string | string[] } }) =>
      `${config.publicOrigin || `${(req.headers["x-forwarded-proto"] as string) || "http"}://${req.headers.host}`}/api/auth/callback`;

    app.get<{ Querystring: { select?: string } }>("/api/auth/google", async (req, reply) => {
      if (!googleEnabled()) return reply.code(404).send({ error: "google auth not configured" });
      const nonce = randomUUID();
      reply.header("set-cookie", `${OAUTH_STATE_COOKIE}=${nonce}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600`);
      return reply.redirect(googleAuthUrl(callbackUri(req), signState(nonce), req.query.select ? "select_account" : undefined));
    });

    app.get<{ Querystring: { code?: string; state?: string; error?: string } }>("/api/auth/callback", async (req, reply) => {
      if (!googleEnabled()) return reply.redirect("/");
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

    // Password login with a per-IP wrong-password cooldown (anti-brute-force). On success it mints
    // the same signed session cookie as Google — the password itself is never stored in any cookie.
    app.post<{ Body: { password?: string; token?: string } }>("/api/login", async (req, reply) => {
      if (!passwordEnabled()) return { ok: !authRequired() };
      const ip = req.ip || "?";
      const now = Date.now();
      if (loginCooldown.size > 256) for (const [k, v] of loginCooldown) if (v <= now) loginCooldown.delete(k);
      // Keep this get→set window await-free: the per-IP cooldown's brute-force safety relies on it
      // running synchronously per request. If checkPassword ever becomes async (argon2/bcrypt), add
      // atomic locking here or a parallel burst from one IP could bypass the cooldown.
      const until = loginCooldown.get(ip) ?? 0;
      if (now < until) return reply.code(429).send({ ok: false, error: "too many attempts", retryMs: until - now });
      if (checkPassword(req.body?.password ?? req.body?.token)) {
        loginCooldown.delete(ip);
        reply.header("set-cookie", cookie30d(SESSION_COOKIE, makeSession(config.allowedEmail)));
        return { ok: true };
      }
      loginCooldown.set(ip, now + config.loginCooldownMs);
      return reply.code(401).send({ ok: false, error: "wrong password", retryMs: config.loginCooldownMs });
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

    // Serve a deliverable file (a finding of kind 'deliverable') for inline preview or download.
    // Security-critical: the path is agent-provided, so the resolved real path is confined to the
    // owning task's workspace — symlinks are resolved (realpathSync) and any escape via '..' / an
    // absolute path / a different drive is rejected. Auth-gated, files-only, size-capped.
    const MAX_DELIVERABLE_BYTES = 25 * 1024 * 1024;
    const DELIVERABLE_TYPES: Record<string, string> = {
      ".md": "text/markdown; charset=utf-8",
      ".markdown": "text/markdown; charset=utf-8",
      ".txt": "text/plain; charset=utf-8",
      ".log": "text/plain; charset=utf-8",
      ".csv": "text/csv; charset=utf-8",
      ".tsv": "text/tab-separated-values; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".yml": "text/plain; charset=utf-8",
      ".yaml": "text/plain; charset=utf-8",
      ".xml": "text/plain; charset=utf-8",
      ".html": "text/plain; charset=utf-8", // served as text (never as a live document) — preview/download only
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".pdf": "application/pdf",
    };
    app.get<{ Params: { id: string }; Querystring: { download?: string } }>("/api/deliverable/:id", async (req, reply) => {
      if (!isAuthed(req.headers.cookie)) return reply.code(401).send({ error: "unauthorized" });
      const finding = db.getFinding(req.params.id);
      if (!finding || finding.kind !== "deliverable" || !finding.path) return reply.code(404).send({ error: "not found" });
      const thread = db.getThread(finding.threadId);
      if (!thread) return reply.code(404).send({ error: "not found" });

      const candidate = isAbsolute(finding.path) ? finding.path : join(thread.workspace, finding.path);
      // Resolve symlinks on BOTH sides so the containment check can't be fooled by a link inside the
      // workspace pointing out of it, and so the comparison uses canonical, same-cased paths.
      let realWs: string;
      let realFile: string;
      try {
        realWs = realpathSync(thread.workspace);
        realFile = realpathSync(candidate);
      } catch {
        return reply.code(404).send({ error: "file not found" });
      }
      const rel = relative(realWs, realFile);
      if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
        return reply.code(403).send({ error: "path escapes the task workspace" });
      }

      let st;
      try {
        st = statSync(realFile);
      } catch {
        return reply.code(404).send({ error: "file not found" });
      }
      if (!st.isFile()) return reply.code(404).send({ error: "not a file" });
      if (st.size > MAX_DELIVERABLE_BYTES) return reply.code(413).send({ error: "file too large to serve" });

      const type = DELIVERABLE_TYPES[extname(realFile).toLowerCase()] ?? "application/octet-stream";
      reply
        .header("content-type", type)
        .header("x-content-type-options", "nosniff")
        .header("cache-control", "private, no-store");
      if (req.query.download !== undefined) {
        // Strip quotes/control chars from the filename so the header can't be broken out of.
        const safeName = basename(realFile).replace(/["\r\n]/g, "");
        reply.header("content-disposition", `attachment; filename="${safeName}"`);
      }
      return reply.send(readFileSync(realFile));
    });

    // Folder picker for the dispatch form: list child directories of an absolute path so
    // the user can browse to a repo instead of typing it. Auth-gated and dirs-only (never
    // exposes file contents), reusing the same system/build SKIP set as find_workspace.
    app.get<{ Querystring: { path?: string } }>("/api/fs/ls", async (req, reply) => {
      if (!isAuthed(req.headers.cookie)) return reply.code(401).send({ error: "unauthorized" });
      const path = (req.query.path || config.defaultWorkspace).trim() || config.defaultWorkspace;
      if (!isAbsolute(path)) return reply.code(400).send({ error: "path must be absolute" });
      if (!existsSync(path)) return reply.code(404).send({ error: "not found" });

      let dirs: { name: string; path: string }[];
      try {
        dirs = readdirSync(path, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .filter((e) => {
            const lname = e.name.toLowerCase();
            return !lname.startsWith("$") && !lname.startsWith(".") && !FS_SKIP.has(lname);
          })
          .map((e) => ({ name: e.name, path: join(path, e.name) }))
          .sort((a, b) => a.name.localeCompare(b.name));
      } catch {
        // Permission-denied / locked system dirs (EACCES): treat as an empty, navigable folder.
        dirs = [];
      }

      // dirname() is idempotent at a drive root (dirname("C:\\") === "C:\\"); null means "no Up".
      const up = dirname(path);
      return { path, parent: up === path ? null : up, dirs };
    });

    // Shell-style path completion for the dispatch path field. Unlike /api/fs/ls (which browses the
    // children of a confirmed directory), this takes a PARTIAL path, resolves it to the nearest
    // existing directory ancestor, and returns the child directories whose names start with the
    // unmatched fragment — e.g. "C:\claude-o" → "C:\claude-orchestrator", "D:\Wow" → "D:\MyProject".
    // Dirs only (workspace paths are always directories); symlinks are excluded (Dirent.isDirectory()
    // is false for a symlink, which is also how we avoid following them).
    const COMPLETE_LIMIT = 8;
    app.get<{ Querystring: { path?: string } }>("/api/fs/complete", async (req, reply) => {
      if (!isAuthed(req.headers.cookie)) return reply.code(401).send({ error: "unauthorized" });
      const raw = (req.query.path ?? "").trim();
      if (!raw || !isAbsolute(raw)) return { entries: [] };

      // Resolve (dir, fragment): a trailing separator or an exact existing dir means "list children"
      // (empty fragment); otherwise split into ancestor dir + the partial name to filter by.
      const endsWithSep = raw.endsWith("\\") || raw.endsWith("/");
      let dir: string;
      let fragment: string;
      if (!endsWithSep && existsSync(raw) && isDirSafe(raw)) {
        dir = raw;
        fragment = "";
      } else {
        dir = endsWithSep ? raw : dirname(raw);
        fragment = endsWithSep ? "" : basename(raw);
      }
      if (!existsSync(dir)) {
        console.log(`[INFO] fs/complete: "${raw}" → no existing ancestor (dir="${dir}")`);
        return { entries: [] };
      }

      const frag = fragment.toLowerCase();
      let entries: { name: string; path: string; isDir: boolean }[] = [];
      try {
        entries = readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isDirectory()) // dirs only; a symlink reports isSymbolicLink(), so it's excluded (and never followed)
          .filter((e) => {
            const lname = e.name.toLowerCase();
            if (lname.startsWith("$") || FS_SKIP.has(lname)) return false;
            // Hidden (dot) dirs only surface when the user is explicitly typing a dot-prefix.
            if (lname.startsWith(".") && !frag.startsWith(".")) return false;
            return lname.startsWith(frag);
          })
          .map((e) => ({ name: e.name, path: join(dir, e.name), isDir: true }))
          .sort((a, b) => a.name.localeCompare(b.name))
          .slice(0, COMPLETE_LIMIT);
      } catch {
        // Permission-denied / locked dirs (EACCES): nothing to suggest.
        entries = [];
      }
      console.log(`[INFO] fs/complete: "${raw}" → dir="${dir}" frag="${fragment}" ${entries.length} match(es)`);
      return { entries };
    });

    // Serve the built frontend in production (single origin). In dev, Vite serves it.
    if (existsSync(config.webDist)) {
      await app.register(fastifyStatic, {
        root: config.webDist,
        prefix: "/",
        // Take full control of Cache-Control via setHeaders — with the plugin's own cacheControl on
        // (its default), it stamps `public, max-age=0` on everything and wins over setHeaders.
        cacheControl: false,
        // Content-hashed assets (Vite's /assets/<name>-<hash>.<ext>) never change under a fixed URL,
        // so cache them hard. index.html and every other non-hashed file MUST revalidate — a cached
        // shell keeps pointing at a previous build's asset hashes, so the client never sees a deploy
        // (the recurring "I fixed it but my view is still the old one" bug).
        setHeaders: (res, filePath) => {
          const hashedAsset = /[\\/]assets[\\/]/.test(filePath) && !filePath.endsWith(".html");
          res.setHeader("cache-control", hashedAsset ? "public, max-age=31536000, immutable" : "no-cache");
        },
      });
      app.setNotFoundHandler((req, reply) => {
        if (req.raw.url && req.raw.url.startsWith("/api")) {
          reply.code(404).send({ error: "not found" });
          return;
        }
        // The SPA shell must always revalidate (the static plugin's setHeaders doesn't run on this
        // fallback path), else a stale index.html pins the client to an old bundle.
        reply.header("cache-control", "no-cache");
        reply.sendFile("index.html");
      });
    }

    return app;
  }

  // Optional TLS listener, reusing the deck's self-signed pfx. Read failures only
  // disable HTTPS — they never block the plain HTTP listener below.
  let httpsOpts: ListenerOptions | undefined;
  let httpsLoadError: string | undefined;
  try {
    const pfx = readFileSync(config.httpsPfxPath);
    httpsOpts = { logger: false, https: { pfx, passphrase: config.httpsPfxPassphrase } };
  } catch (err) {
    httpsLoadError = (err as Error).message;
  }

  const httpApp = await buildApp({ logger: false });
  const httpsApp = httpsOpts ? await buildApp(httpsOpts) : undefined;

  try {
    await httpApp.listen({ port: config.port, host: config.host });
    let httpsLine: string;
    if (httpsApp) {
      try {
        await httpsApp.listen({ port: config.httpsPort, host: config.host });
        httpsLine = `  https://${config.host}:${config.httpsPort}  (embeds in the HTTPS dashboard deck)`;
      } catch (err) {
        httpsLine = `  ⚠ HTTPS listener failed to bind :${config.httpsPort}: ${(err as Error).message}`;
      }
    } else {
      httpsLine = `  ⚠ HTTPS listener disabled: cannot read cert ${config.httpsPfxPath} (${httpsLoadError})`;
    }
    const apiKeyWarning = process.env.ANTHROPIC_API_KEY
      ? "  ⚠ ANTHROPIC_API_KEY is set in this shell; agents drop it and use your subscription."
      : "";
    // tsx watch (the `dev` scripts) watches this server's imported module graph. Since the
    // orchestrator is routinely pointed at its OWN repo, an implementor agent editing server/src
    // makes tsx SIGTERM-restart the process mid-run, killing every in-flight agent (they reboot as
    // "interrupted by a server restart"). npm exposes the launching script as npm_lifecycle_event,
    // inherited by this child through tsx — so we can warn precisely when running under watch and
    // point at `npm run serve` (no watch), the safe mode for live task pipelines.
    const underWatch = /(^|:)dev(:|$)/.test(process.env.npm_lifecycle_event ?? "");
    const watchWarning = underWatch
      ? "  ⚠ running under tsx watch — editing server/src restarts the server and KILLS in-flight tasks; use `npm run serve` for live pipelines"
      : "";
    // eslint-disable-next-line no-console
    console.log(
      [
        ``,
        `  GG Orchestrator server`,
        `  http://${config.host}:${config.port}   (ws: /ws)`,
        httpsLine,
        `  auth: ${config.oauthToken ? "CLAUDE_CODE_OAUTH_TOKEN" : "inherited Claude Code login"} (subscription, no API credits)`,
        `  accounts: ${config.accounts.length} (${config.accounts.map((a) => a.label).join(", ")})${config.accounts.length > 1 ? " — load-balancing by burn ratio" : ""}`,
        `  data: ${config.dbPath}`,
        watchWarning,
        authRequired()
          ? `  access: ${[googleEnabled() ? "Google sign-in" : null, passwordEnabled() ? "password" : null].filter(Boolean).join(" or ")} — allowlisted to ${config.allowedEmail}`
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

installCrashGuards();
void main();
