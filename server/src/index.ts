import Fastify from "fastify";
import type { FastifyInstance, FastifyServerOptions } from "fastify";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, dirname, basename, extname, relative } from "node:path";
import { config } from "./config.js";
import { buildInfo } from "./buildInfo.js";
import { installCrashGuards, logBoot, logCrash, logRestartReconcile, registerCrashContext, startMemoryMonitor } from "./crashLog.js";
import { Db } from "./db/db.js";
import { startSearchIndexBackfill } from "./db/searchIndex.js";
import { EventHub } from "./events.js";
import { FileMemoryService } from "./memory/memory.js";
import { AccountManager, type PersistedAccountUsage } from "./accounts/accountManager.js";
import { ResetStagger } from "./accounts/resetStagger.js";
import { publishAccountUsage } from "./accounts/usageSnapshot.js";
import { startCodexUsageMonitor } from "./agents/codexUsagePing.js";
import { startGrokUsageMonitor } from "./agents/grokUsagePing.js";
import { startZaiUsageMonitor } from "./agents/zaiUsagePing.js";
import { ThreadManager } from "./orchestrator/threadManager.js";
import { CoworkManager } from "./orchestrator/cowork.js";
import { Director } from "./orchestrator/director.js";
import { RepoConsole } from "./orchestrator/repoConsole.js";
import { OperatorNotes } from "./orchestrator/notes.js";
import { DeployGate, ACTIVE_TASK_STATES, isLoopbackAddress, duration } from "./orchestrator/deployGate.js";
import { Scheduler } from "./orchestrator/scheduler.js";
import { OnlineOffice } from "./office/onlineOffice.js";
import { SKIP as FS_SKIP } from "./workspace/findWorkspace.js";
import { startWebAutoBuild } from "./webAutoBuild.js";
import { refreshStatus, getStatus, applyUpdate, startUpdatePoll } from "./update.js";
import { registerWs } from "./ws/hub.js";
import { FreeProviderService } from "./freeProviders/service.js";
import { registerFreeProviderRoutes } from "./freeProviders/routes.js";
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
  const freeProviders = new FreeProviderService(db);
  const hub = new EventHub();
  const memory = new FileMemoryService();
  // One shared 5h-reset coordinator across every participant — the Claude subs AND Codex — so idle
  // window restarts are placed dynamically around each other's live reset phases (see resetStagger.ts).
  const stagger = new ResetStagger();
  // Persist each account's last usage read (kv) so a restart can restore the 5h window-start stagger
  // instead of boot-pinging every account — which would start all their windows in sync again.
  const accounts = new AccountManager(config.accounts, hub, config.accountPingMs, {
    stagger,
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
  // Republish every sub's usage to ~/.claude/state on each account-state change, so Claude Code's own
  // handoff hook can judge the account a session is actually burning instead of the single account in
  // the global credentials file (see accounts/usageSnapshot.ts).
  publishAccountUsage(accounts.usageSnapshot());
  hub.subscribe((e) => {
    if (e.type === "accounts") publishAccountUsage(accounts.usageSnapshot());
  });
  const manager = new ThreadManager(db, hub, memory, accounts, freeProviders);
  const cowork = new CoworkManager(db, hub, {
    prepare: (input) => manager.prepareCoworkerRun(input),
    taskConflict: (workspace) => manager.coworkTaskConflict(workspace),
    observeRateLimit: (target, info) => manager.coworkObserveRateLimit(target, info),
    isCapped: (target, agent) => manager.coworkRunCapped(target, agent),
    noteCap: (target, agent) => manager.coworkNoteCap(target, agent),
    releasedWorkspace: () => manager.coworkReleasedWorkspace(),
  });
  manager.attachCoworkWorkspaceGuard((workspace) => cowork.hasLiveWorkspace(workspace));
  // Crash records should show what the pipeline was DOING when it died, and a slow memory climb should be
  // visible in the log BEFORE an OOM abort — the two things missing when crashes vanished without a trace.
  registerCrashContext("active-work", () => `${manager.describeActiveWork()}; ${cowork.describeActiveWork()}`);
  // The manager's constructor has just reconciled whatever the previous process left mid-flight. Record it
  // beside the boot line so "did that bounce eat something?" is one grep, not a cross-table reconstruction.
  if (manager.bootReconcile) logRestartReconcile(manager.bootReconcile);
  startMemoryMonitor();
  // Recurring dispatches: fires a schedule's prompt through the normal pipeline on its cron cadence.
  // Standalone (depends only on manager.dispatch), so scheduled runs use whatever provider/model is
  // active, exactly like a hand-dispatched task. The director can also create/edit schedules via its tools.
  const scheduler = new Scheduler(db, hub, (input) => manager.dispatch(input));
  // The owner's note list. Stateless over (db, hub), so each agent's bus server builds its own rather
  // than routing every post through this instance; they can't diverge, and the pipeline stays untouched.
  const notes = new OperatorNotes(db, hub);
  const director = new Director(manager, db, hub, scheduler, notes);
  // The repo-level Git console (fetch/pull/push/branch/commit over any repo the console knows about).
  // Standalone: Db only, so it never entangles with the pipeline. It always offers the orchestrator's
  // own checkout (resolved from server/, so it holds in dev and in the built dist alike) even before any
  // task has been dispatched.
  const repos = new RepoConsole(db, config.serverRoot);
  // How often an AGENT may bounce this server. Deploying tree-kills the console and every live agent,
  // and with several tasks running — each finishing its own patch — that was landing every few minutes.
  // Standalone over (db, hub) like notes/scheduler: it reads the board through one count and owns the
  // restart itself, so a deploy held now still goes live without the agent waiting around for it.
  const deployGate = new DeployGate({
    db,
    hub,
    activeTasks: () => db.countThreadsInStates(ACTIVE_TASK_STATES),
    liveBuild: () => buildInfo(),
    window: { minIntervalMs: config.deployGate.minIntervalMs, minActiveTasks: config.deployGate.minActiveTasks },
    pollMs: config.deployGate.pollMs,
  });
  hub.log(
    "info",
    config.deployGate.minIntervalMs > 0
      ? `deploy gate: agents may bounce this server once per ${duration(config.deployGate.minIntervalMs)} while ${config.deployGate.minActiveTasks}+ tasks are running`
      : `deploy gate: off — every agent deploy restarts immediately (DEPLOY_GATE_MIN_INTERVAL_MS=0)`,
  );
  // The Online Office: this instance's link to the shared relay, where agents on OTHER machines working
  // the same repository show up as coworkers. Standalone over (db, hub) + three callbacks into the
  // manager — off entirely until the operator joins one in Settings.
  const onlineOffice = new OnlineOffice({
    db,
    hub,
    roster: () => manager.onlineRoster(),
    onRemoteChat: (msg, workspaces) => manager.receiveRemoteChat(msg, workspaces),
    onRemoteJoin: (repoLabel, workspaces, joiners) => manager.remoteTeammatesJoined(repoLabel, workspaces, joiners),
  });
  manager.attachOnlineOffice(onlineOffice);
  /**
   * None of these services is required to accept an HTTP/WebSocket connection.  In particular, some
   * immediately inspect local CLI logs, git state, or a large SQLite table; doing that before `listen()`
   * made a slow host look like the console was entirely down (the dashboard proxy got ECONNREFUSED).
   *
   * Start them after the listeners are live, one event-loop turn apart.  The stagger both gets the
   * operator back into the console promptly and prevents one optional monitor from monopolising boot.
   */
  const startBackgroundServices = (): void => {
    const starters: Array<() => void> = [
      () => onlineOffice.start(),
      () => accounts.start(),
      () => scheduler.start(),
      () => deployGate.start(),
      () => manager.startModelCatalog(),
      () => freeProviders.start(),
      () => startUpdatePoll(),
      () => startSearchIndexBackfill(db, (message) => hub.publish({ type: "log", level: "info", message })),
      () =>
        startCodexUsageMonitor(hub, {
          apiKey: () => manager.openaiApiKey(),
          configured: () => {
            const s = manager.settings();
            return s.codexEnabled || s.hasOpenaiKey || s.codexChatgptLogin;
          },
          stagger,
          runModel: () => manager.settings().codexModel,
          onUsageRefresh: () => manager.onCodexUsageRefresh(),
        }),
      () =>
        startGrokUsageMonitor(hub, {
          configured: () => {
            const s = manager.settings();
            return s.grokEnabled || s.grokSignedIn;
          },
        }),
      () =>
        startZaiUsageMonitor(hub, {
          apiKey: () => manager.zaiApiKey(),
          configured: () => {
            const s = manager.settings();
            return s.zaiEnabled || s.zaiKeyPresent;
          },
        }),
      () => startWebAutoBuild(),
    ];
    let index = 0;
    const startNext = (): void => {
      const start = starters[index++];
      if (!start) return;
      try {
        start();
      } catch (error) {
        logCrash("background service startup", error);
      }
      if (index < starters.length) setTimeout(startNext, 0).unref?.();
    };
    // Give the event loop a chance to accept the first dashboard connection before optional work begins.
    setTimeout(startNext, 2_000).unref?.();
  };

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
    registerWs(app, { db, hub, manager, director, accounts, scheduler, notes, repos, onlineOffice, cowork });
    registerFreeProviderRoutes(app, freeProviders, isAuthed);

    // `build` is which dist THIS process loaded, read once at boot — the fact that turns "is the live
    // server running current code?" into a comparison instead of an inference from mtimes.
    app.get("/api/health", async () => ({
      ok: true,
      auth: config.oauthToken ? "oauth-token" : "inherited-cli-login",
      models: config.models,
      build: buildInfo(),
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

    // Durable implementor handoffs are fetched independently of the chronological task feed so QA,
    // reviewer, and Supervisor traffic can never bury the owner's completion memo. The WebSocket
    // history carries the same rows for the live console; this route is the direct/auditable API view.
    app.get<{ Params: { id: string } }>("/api/threads/:id/implementation-memos", async (req, reply) => {
      if (!isAuthed(req.headers.cookie)) return reply.code(401).send({ error: "unauthorized" });
      if (!db.getThread(req.params.id)) return reply.code(404).send({ error: "not found" });
      reply.header("cache-control", "private, no-store");
      const memos = db.listImplementationMemos(req.params.id);
      return {
        threadId: req.params.id,
        current: memos.at(-1) ?? null,
        latestUseful: memos.findLast((memo) => memo.outcome === "completed" && !!memo.report) ?? null,
        memos,
      };
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

    // ---- the deploy gate: an agent asking to bounce this server onto the dist it just built ----
    // `npm run deploy` posts here instead of calling the script-hub directly, so several tasks each
    // shipping their own patch collapse into ONE restart while the owner is multitasking. Never a
    // refusal: the gate either bounces now or takes the restart over and fires it when the window opens.
    //
    // Loopback-or-authed rather than cookie-only: the caller is a local child process with no session,
    // and any local process could already POST the script-hub's own restart — so this is a coordination
    // point, not a privilege boundary. What it must exclude is the LAN, which this console is on.
    const deployGateReachable = (req: { ip: string; headers: { cookie?: string } }): boolean =>
      isLoopbackAddress(req.ip) || isAuthed(req.headers.cookie);

    app.post<{ Body: { label?: string; commit?: string; stampedAt?: number } }>("/api/deploy/restart", async (req, reply) => {
      if (!deployGateReachable(req)) return reply.code(401).send({ error: "unauthorized" });
      return deployGate.request(req.body ?? {});
    });

    // What the gate would do right now — read by `deploy -- --verify`, so a deferred deploy reads as
    // "staged, live at 14:20" instead of the alarming "your change is NOT running".
    app.get("/api/deploy/gate", async (req, reply) => {
      if (!deployGateReachable(req)) return reply.code(401).send({ error: "unauthorized" });
      reply.header("cache-control", "no-store");
      return deployGate.status();
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

    // Voice-mode settings (audio devices + wake phrases) — a thin pass-through to the gateway's
    // /api/settings, so the console's settings panel can edit them without a separate origin. The
    // POST forwards the gateway's status code (400 = validation, e.g. an empty wake-phrase list);
    // a longer timeout because a device switch reopens live audio streams.
    app.get("/api/voice/settings", async (req, reply) => {
      if (!isAuthed(req.headers.cookie)) return reply.code(401).send({ error: "unauthorized" });
      reply.header("cache-control", "no-store");
      try {
        return await voiceFetch("/api/settings");
      } catch {
        return reply.code(502).send({ error: "voice-gateway unreachable — start it in Script Hub" });
      }
    });

    app.post<{ Body: Record<string, unknown> }>("/api/voice/settings", async (req, reply) => {
      if (!isAuthed(req.headers.cookie)) return reply.code(401).send({ error: "unauthorized" });
      try {
        const res = await fetch(`${VOICE_GW}/api/settings`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(req.body ?? {}),
          signal: AbortSignal.timeout(5000),
        });
        return reply.code(res.status).send(await res.json());
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

    // Serve pasted attachment bytes on demand (refs travel over WS; bytes stay off it). Only the four
    // audited image types may render inline; every other owner file is forced to download, so HTML/SVG
    // or an executable can never become same-origin active content even if its supplied MIME lies.
    const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
    app.get<{ Params: { id: string }; Querystring: { download?: string } }>("/api/attachment/:id", async (req, reply) => {
      if (!isAuthed(req.headers.cookie)) return reply.code(401).send({ error: "unauthorized" });
      const a = db.getAttachment(req.params.id);
      if (!a) return reply.code(404).send({ error: "not found" });
      const inlineImage = ALLOWED_IMAGE_TYPES.has(a.mediaType);
      const response = reply
        .header("content-type", inlineImage ? a.mediaType : "application/octet-stream")
        .header("x-content-type-options", "nosniff")
        .header("cache-control", "private, max-age=31536000, immutable");
      if (!inlineImage || req.query.download !== undefined) {
        const fallback = a.name.replace(/["\\\r\n]/g, "_").replace(/[^\x20-\x7e]/g, "_").slice(0, 180) || "attachment";
        const headerName = Array.from(a.name.replace(/[\r\n]/g, "").slice(0, 240))
          .map((char) => {
            const point = char.codePointAt(0) ?? 0;
            return point >= 0xd800 && point <= 0xdfff ? "�" : char;
          })
          .join("");
        const encoded = encodeURIComponent(headerName);
        response.header("content-disposition", `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`);
      }
      return response.send(Buffer.from(a.data, "base64"));
    });

    if (process.env.ORCH_LAB_FIXTURES === "1") {
      app.post<{ Params: { id: string } }>("/api/lab/live-qa/:id", async (req, reply) => {
        if (!isAuthed(req.headers.cookie)) return reply.code(401).send({ error: "unauthorized" });
        const result = manager.installLabQaRun(req.params.id);
        return result.ok ? result : reply.code(409).send(result);
      });
    }

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
    // unmatched fragment — e.g. "C:\claude-o" → "C:\claude-orchestrator", "D:\proj" → "D:\projects".
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
          res.header("cache-control", hashedAsset ? "public, max-age=31536000, immutable" : "no-cache");
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
    startBackgroundServices();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("Failed to start server:", err);
    process.exit(1);
  }
}

installCrashGuards();
logBoot(); // before main(), so a startup that dies still leaves the boot bracketed in crash.log
void main();
