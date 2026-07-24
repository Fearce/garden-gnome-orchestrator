import "dotenv/config";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { Account } from "./accounts/account.js";

// Parse a numeric env var, falling back when unset OR non-numeric — so a typo'd value can't become a
// NaN that a `<= 0` guard lets through (e.g. a polling interval; setInterval(fn, NaN) fires every tick).
function numEnv(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return v != null && Number.isFinite(n) ? n : fallback;
}

const here = dirname(fileURLToPath(import.meta.url));
// src/config.ts (dev) or dist/config.js (prod) — parent is the server root either way.
const serverRoot = resolve(here, "..");
// Where the SQLite DB + crash log live. Defaults to server/data; DATA_DIR overrides it so an isolated
// instance (a test run, a second copy) can keep its own state instead of sharing the live database.
const dataDir = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : resolve(serverRoot, "data");

/**
 * Accounts from ACCOUNT_<n>_TOKEN / ACCOUNT_<n>_LABEL / ACCOUNT_<n>_ID env vars
 * (tokens from `claude setup-token`, one per subscription). With 2+ the
 * orchestrator load-balances by burn ratio; with 0 it falls back to a single
 * account using CLAUDE_CODE_OAUTH_TOKEN or the inherited CLI login.
 */
function loadAccounts(): Account[] {
  const accts: Account[] = [];
  for (let i = 1; i <= 8; i++) {
    const token = process.env[`ACCOUNT_${i}_TOKEN`];
    if (!token) continue;
    accts.push({
      id: process.env[`ACCOUNT_${i}_ID`] ?? `acct${i}`,
      label: process.env[`ACCOUNT_${i}_LABEL`] ?? `account ${i}`,
      token,
    });
  }
  if (accts.length) return accts;
  return [{ id: "default", label: "logged-in", token: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "" }];
}

// LAN exposure safety: the orchestrator drives bypassPermissions agents, so we
// refuse to bind a non-localhost host unless AUTH_TOKEN gates it.
const requestedHost = process.env.HOST ?? "127.0.0.1";
const localOnly = ["127.0.0.1", "localhost", "::1"].includes(requestedHost);
const authPassword = process.env.AUTH_PASSWORD || process.env.AUTH_TOKEN || undefined;
const googleClientId = process.env.GOOGLE_CLIENT_ID || undefined;
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET || undefined;
const authConfigured = !!authPassword || !!(googleClientId && googleClientSecret);
const exposeBlocked = !localOnly && !authConfigured;

export const config = {
  serverRoot,
  // The repo owner's display name, woven into agent prompts and user-facing strings so the
  // orchestrator reads as a shareable tool rather than one person's. Set OWNER_NAME in
  // server/.env; left unset it falls back to the neutral "the user".
  ownerName: process.env.OWNER_NAME?.trim() || "the user",
  // Optional substring: repos whose git origin URL contains it are commit-only (never pushed) by
  // agents. Lets you keep work/private repos from being pushed while every other repo auto-pushes.
  // Unset (default) = agents push every repo. Set NO_PUSH_REPO_PATTERN in server/.env to enable.
  noPushRepoPattern: process.env.NO_PUSH_REPO_PATTERN?.trim() || "",
  port: Number(process.env.PORT ?? 4317),
  // Second, TLS listener so the orchestrator can be embedded as a same-protocol
  // iframe inside the HTTPS Dashboard Deck (https://localhost:3940) — Chromium
  // silently blocks an http://:4317 frame under an https page as mixed content.
  // 4318 is taken by the Vite dev server, so default to 4319. We reuse the deck's
  // own self-signed pfx (already trusted in the browser for localhost) so no new
  // cert has to be accepted. Missing/unreadable cert → HTTPS is skipped, never
  // breaking the plain HTTP listener.
  httpsPort: Number(process.env.HTTPS_PORT ?? 4319),
  httpsPfxPath: process.env.HTTPS_PFX_PATH ?? resolve(serverRoot, "certs", "cert.pfx"),
  httpsPfxPassphrase: process.env.HTTPS_PFX_PASSPHRASE ?? "changeit",
  host: exposeBlocked ? "127.0.0.1" : requestedHost,
  authPassword,
  // Wrong-password lockout per client IP (anti-brute-force). A short PIN is safe behind this.
  loginCooldownMs: Number(process.env.LOGIN_COOLDOWN_MS ?? 30_000),
  googleClientId,
  googleClientSecret,
  allowedEmail: (process.env.ALLOWED_EMAIL || "you@example.com").toLowerCase(),
  // Public origin Google redirects back to (e.g. https://host.tailnet.ts.net). When set,
  // the OAuth redirect_uri is pinned to it instead of the request Host header, so the
  // registered URI can't diverge and a spoofed Host can't influence it. Localhost dev
  // leaves it unset and derives the origin from the request.
  publicOrigin: (process.env.PUBLIC_ORIGIN || "").replace(/\/$/, "") || undefined,
  sessionSecret: process.env.SESSION_SECRET || googleClientSecret || authPassword || "orchestrator-dev-secret",
  hostWarning: exposeBlocked
    ? `HOST=${requestedHost} requested but no auth is set — refusing to expose bypassPermissions agents on the LAN unauthenticated; bound to 127.0.0.1. Set AUTH_PASSWORD (or GOOGLE_CLIENT_ID/SECRET) to enable LAN access.`
    : undefined,
  dataDir,
  dbPath: resolve(dataDir, "orchestrator.sqlite"),
  webDist: resolve(serverRoot, "..", "web", "dist"),
  defaultWorkspace: process.env.DEFAULT_WORKSPACE ?? (process.platform === "win32" ? "C:\\" : homedir()),
  // Roots the director's find_workspace tool scans to resolve a project name → real path.
  // Split on ; (and : on non-Windows, where : isn't part of a drive-letter path).
  workspaceSearchRoots: (process.env.WORKSPACE_SEARCH_ROOTS || (process.platform === "win32" ? "C:\\;D:\\" : homedir()))
    .split(process.platform === "win32" ? ";" : /[;:]/)
    .map((s) => s.trim())
    .filter(Boolean),
  memoryDir: process.env.MEMORY_DIR ?? resolve(homedir(), ".claude", "memory"),
  oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN || undefined,
  accounts: loadAccounts(),
  accountPingMs: Number(process.env.ACCOUNT_PING_MS ?? 600_000),
  // The faster cadence the opt-in "Fast usage polling" setting switches the account ping to, so the
  // top-bar strip (utilization % + reset countdown) tracks Claude's own UI within ~1-2% instead of
  // lagging up to a full accountPingMs behind a live burn. A 1-token Haiku ping (~2/min/account), so
  // the extra cost/window budget is negligible; FAST_ACCOUNT_PING_MS overrides the 30s default.
  fastAccountPingMs: Number(process.env.FAST_ACCOUNT_PING_MS ?? 30_000),
  notifyWebhookUrl: process.env.NOTIFY_WEBHOOK_URL || undefined,
  models: {
    director: "claude-sonnet-4-6",
    planner: "claude-opus-4-8",
    researcher: "claude-sonnet-4-6",
    implementor: "claude-opus-4-8",
    qa: "claude-opus-4-8",
    // The single-agent read-only "reader" lane (dispatch_read). Sonnet, not Haiku: misrouting TO the
    // reader is the unsafe direction (it has no QA behind it), so it's biased to capability — a Sonnet
    // reader that occasionally escalates beats a Haiku one that half-answers. Configurable like any role.
    reader: "claude-sonnet-4-6",
  },
  // Fable access is gated by its OWN usage pool, separate from the normal 5h/weekly windows. When a
  // Fable run is rejected while those windows still show headroom, dispatch falls back to this model
  // on the SAME subscription until the Fable pool frees up (see fallbackModelFor / classifyCap).
  fableFallbackModel: process.env.FABLE_FALLBACK_MODEL?.trim() || "claude-opus-4-8",
  // ---- OpenAI Codex (second, optional agent backend) ----
  // Implementors can be routed here normally. Structured roles stay on Claude unless repeated transient
  // API failures force an outage failover, at which point the CLI's structured-output adapter takes over.
  codex: {
    // First-boot default + the flagship models the Subscriptions selector suggests. The field is
    // free-text (any model id the OpenAI key or ChatGPT-plan Codex login can access is accepted) —
    // these are just quick picks, most-capable first. Keep GPT-5.6 in this curated fallback because
    // ChatGPT-plan auth does not give us an OpenAI /v1/models list, even when Codex can run it.
    // Override the default with CODEX_MODEL.
    defaultModel: process.env.CODEX_MODEL?.trim() || "gpt-5.5",
    models: [
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.1-codex-max",
      "gpt-5.3-codex",
      "gpt-5.2-codex",
      "gpt-5.1-codex-mini",
      "codex-mini-latest",
    ] as const,
    // The Codex CLI is a global npm install; we spawn its bin/codex.js with this node binary directly
    // (PATH-independent, no .cmd shim). Override CODEX_BIN_JS to point at a different install.
    binJs:
      process.env.CODEX_BIN_JS ||
      resolve(process.env.APPDATA ?? resolve(homedir(), "AppData", "Roaming"), "npm", "node_modules", "@openai", "codex", "bin", "codex.js"),
    // A dedicated CODEX_HOME isolated from the operator's personal ~/.codex, so the orchestrator's
    // config/sessions don't inherit personal plugins/notify hooks (which would misfire under headless
    // `codex exec`). Auth is SEEDED into it — see sourceAuthHome — rather than relying on env vars
    // (the modern CLI authenticates only from <CODEX_HOME>/auth.json, not OPENAI_API_KEY).
    // NOTE: other tools on the machine may point their own Codex runs at this same <home>/auth.json.
    // Relocating CODEX_HOME_DIR or wiping the seeded login de-authenticates those consumers too, so
    // update any external wrapper that defaults to this directory in the same change.
    home: process.env.CODEX_HOME_DIR || resolve(dataDir, "codex-home"),
    // The operator's personal codex home, where `codex login` writes auth.json. A ChatGPT-plan login
    // there (auth_mode "chatgpt") is the PREFERRED Codex auth — it bills against the Plus/Pro/etc. plan,
    // so no usage-based API billing is needed — and is copied into the isolated home. Override with
    // CODEX_SOURCE_HOME (e.g. if the operator's codex login lives elsewhere).
    sourceAuthHome: process.env.CODEX_SOURCE_HOME || resolve(homedir(), ".codex"),
    // Fallback key when none is stored in the kv table — lets a key live in server/.env instead of the UI.
    // Used only when there's no ChatGPT login to prefer.
    envKey: process.env.OPENAI_API_KEY?.trim() || undefined,
    // A wedged `codex exec [resume]` can hang at 0% CPU emitting no JSONL — notably resuming a gpt-5
    // session that was interrupted mid-turn — which strands the task with no result FOREVER (the runner
    // only resolves on process exit). A no-output watchdog in codexRunner — one timer with two bounds —
    // kills such a turn so the run surfaces an error (and self-heals a wedged resume by retrying fresh):
    // firstEventMs bounds
    // spawn→first event (the wedge emits nothing, so a tight bound is safe — a healthy turn emits
    // thread.started within seconds); inactivityMs bounds the gap between events once streaming has begun.
    // The two bounds are asymmetric on purpose: the startup bound only ever fires on a genuine wedge (a
    // healthy turn always emits an early event), but the inactivity bound can FALSE-POSITIVE because Codex
    // emits a shell command as just item.started→item.completed with no output in between — a single long
    // silent command (a big `npm install`, full test suite, docker build) emits nothing for its whole run.
    // So the inactivity bound must exceed the longest single silent command a Codex implementor will run;
    // err generous (a too-tight bound kills GOOD work, whereas a too-loose one only delays surfacing a rare
    // mid-stream hang). Override via CODEX_FIRST_EVENT_MS / CODEX_INACTIVITY_MS; set either to 0 to disable.
    firstEventMs: numEnv(process.env.CODEX_FIRST_EVENT_MS, 60_000),
    inactivityMs: numEnv(process.env.CODEX_INACTIVITY_MS, 1_800_000),
  },
  // ---- xAI Grok (third, optional implementor backend) ----
  // The implementor can run on the Grok CLI (SuperGrok subscription) instead of Claude/Codex when the
  // Grok subscription is enabled in Settings. Like Codex it's a batch-oriented agentic CLI, authed by a
  // flat-fee `grok login` (OAuth, ~/.grok/auth.json) — no per-token API billing. Planner/researcher/QA
  // stay Claude by default (the Grok CLI has no in-process MCP bus tools).
  grok: {
    // First-boot default + the models the Subscriptions selector suggests. Free-text; a SuperGrok login
    // today exposes only grok-4.5, but the pickable list unions this with whatever ~/.grok/models_cache.json
    // reports live, so a newly-granted model shows up on its own. Override the default with GROK_MODEL.
    defaultModel: process.env.GROK_MODEL?.trim() || "grok-4.5",
    models: ["grok-4.5"] as const,
    // The Grok CLI is a native executable (no node shim). Spawned by absolute path so it's PATH-independent.
    // Override GROK_BIN to point at a different install.
    bin:
      process.env.GROK_BIN ||
      resolve(homedir(), ".grok", "bin", process.platform === "win32" ? "grok.exe" : "grok"),
    // ~/.grok — where `grok login` writes auth.json and the CLI caches models/sessions. Read (never written)
    // for the signed-in email/tier the usage chip surfaces. Override with GROK_HOME_DIR.
    home: process.env.GROK_HOME_DIR || resolve(homedir(), ".grok"),
    // No-output watchdog bounds, mirroring Codex: firstEventMs bounds spawn→first event (a wedged turn
    // emits nothing), inactivityMs bounds the gap between events once streaming has begun (must exceed the
    // longest single silent command a Grok implementor runs). Set either to 0 to disable.
    firstEventMs: numEnv(process.env.GROK_FIRST_EVENT_MS, 60_000),
    inactivityMs: numEnv(process.env.GROK_INACTIVITY_MS, 1_800_000),
    // A live-run rejection still latches a cap for this cooldown as a fallback — but the usage scrape
    // (below) also supplies the real weekly reset, so the cap normally clears at the true reset epoch.
    capCooldownMs: numEnv(process.env.GROK_CAP_COOLDOWN_MS, 60 * 60_000),
    // ---- Live SuperGrok usage (chip + provider routing) ----
    // Three sources, cheapest first (see grokUsagePing): (1) CLI unified.jsonl weekly creditUsagePercent,
    // (2) HTTP GET billingUrl with the OAuth token for monthly credits, (3) winpty TUI `/usage show` as a
    // Windows-only weekly fallback when the log is cold. The chip shows weekly + monthly gauges; routing
    // ranks Grok by soonest weekly reset like Claude/Codex.
    winpty: process.env.GROK_WINPTY || resolve("C:\\", "Program Files", "Git", "usr", "bin", "winpty.exe"),
    // OAuth-authed monthly credits endpoint (verified live against SuperGrok; no model turn).
    billingUrl: process.env.GROK_BILLING_URL?.trim() || "https://cli-chat-proxy.grok.com/v1/billing",
    // How often to re-poll log + HTTP. Both are cheap; default 60s so the chip stays live. The expensive
    // winpty fallback is separately rate-limited inside the monitor (~10 min). Set 0 to disable polling.
    usagePollMs: numEnv(process.env.GROK_USAGE_POLL_MS, 60_000),
    // Hard timeout for one winpty scrape (spawn → parse → kill), so a wedged TUI can never pile up.
    usageScrapeTimeoutMs: numEnv(process.env.GROK_USAGE_SCRAPE_TIMEOUT_MS, 30_000),
  },
  // ---- Zhipu z.ai GLM Coding Plan (fourth, optional implementor backend) ----
  // Unlike Codex/Grok, z.ai exposes an ANTHROPIC-COMPATIBLE endpoint, so the implementor reuses the Claude
  // Agent SDK path (AgentRun) with ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN pointed at z.ai — keeping the
  // in-process MCP bus/office tools, deliverables, resume and images for free (see .claude/rules/
  // model-backend-economics.md). It's a flat subscription (Lite/Pro/Max) with REAL 5-hour + weekly quota
  // windows (usageUrl below), so it competes in provider routing by soonest weekly reset like Claude/Codex/Grok.
  zai: {
    // The API key (`<id>.<secret>` from z.ai). The UI can store one in the kv table (setting key
    // `zai_api_key`, write-only); this env value is the fallback when none is stored there. Never
    // broadcast — only its presence + last 4 chars leave the server (settings()).
    apiKey: process.env.ZAI_API_KEY?.trim() || undefined,
    // Anthropic-compatible base URL. The Claude Agent SDK / CLI honor ANTHROPIC_BASE_URL, so pointing it
    // here (with the key as ANTHROPIC_AUTH_TOKEN) is the entire backend wiring.
    baseUrl: process.env.ZAI_BASE_URL?.trim() || "https://api.z.ai/api/anthropic",
    // First-boot default + the GLM models the Subscriptions selector suggests. Free-text (any id the key
    // can access is accepted). glm-4.6 is the proven, quota-efficient coding-plan default; the newer
    // glm-4.7 / glm-5.2 / glm-5-turbo are offered as pickable alternatives. Override with ZAI_MODEL.
    defaultModel: process.env.ZAI_MODEL?.trim() || "glm-4.6",
    models: ["glm-4.6", "glm-4.7", "glm-5.2", "glm-5-turbo"] as const,
    // z.ai's real usage/quota endpoint (Bearer key, no model turn): returns the 5-hour + weekly windows
    // (used-% + reset) and the plan tier — see zaiUsagePing. This is what feeds the chip + routing.
    usageUrl: process.env.ZAI_USAGE_URL?.trim() || "https://api.z.ai/api/monitor/usage/quota/limit",
    // How often to re-poll the quota endpoint (cheap HTTP GET). Default 60s so the chip stays live. 0 disables.
    usagePollMs: numEnv(process.env.ZAI_USAGE_POLL_MS, 60_000),
    // A live-run cap rejection latches for this cooldown as a fallback; the quota scrape normally supplies
    // the true 5h/weekly reset, so the latch clears at the real reset epoch when known.
    capCooldownMs: numEnv(process.env.ZAI_CAP_COOLDOWN_MS, 60 * 60_000),
    // z.ai recommends a long per-request timeout for agentic coding turns (its docs use 3,000,000ms).
    // Applied as API_TIMEOUT_MS in the run env only for a z.ai run.
    timeoutMs: numEnv(process.env.ZAI_TIMEOUT_MS, 3_000_000),
  },
  // When every Claude account is rate-limited mid-task, the task parks in 'review' with a cap marker
  // instead of stranding the owner to hand-resume it. A supervisor re-checks this often and resumes
  // each parked task the moment any account regains headroom (a window reset / a freed sub). Set
  // CAP_RETRY_MS=0 to disable the supervisor.
  capRetryMs: numEnv(process.env.CAP_RETRY_MS, 120_000),
  // A provider-side 5xx/overload/transport failure is retried on the same provider before the task is
  // handed to another enabled backend. Three consecutive failures means original + two retries.
  maxTransientApiFailures: Math.max(1, Math.floor(numEnv(process.env.API_ERROR_MAX_FAILURES, 3))),
  transientApiRetryBaseMs: Math.max(0, numEnv(process.env.API_ERROR_RETRY_BASE_MS, 1_500)),
  maxQaRounds: Number(process.env.MAX_QA_ROUNDS ?? 4),
  // Default ceiling on pipelines running at once; further dispatches wait in 'queued' until a slot
  // frees. Surfaced as an operator setting (persisted in kv) — this is just the first-boot default.
  maxConcurrent: Number(process.env.MAX_CONCURRENT ?? 3),
  // The implementor runs with a deterministic per-session turn ceiling. Hitting it ends the SDK run
  // with subtype "error_max_turns" — an involuntary cutoff, NOT a real finish — at a known point, so
  // the orchestrator can silently warm-resume the session and keep going (the implementor used to
  // hit an unpredictable SDK default mid-task and park on a manual Resume button).
  implementorMaxTurns: Number(process.env.IMPLEMENTOR_MAX_TURNS ?? 100),
  // Cap on consecutive turn-limit auto-resumes per implementor→QA loop, so a wedged implementor that
  // keeps hitting the ceiling without progressing can't spin forever — it settles to review instead.
  maxAutoResumes: Number(process.env.MAX_AUTO_RESUMES ?? 8),
  // The `xhigh` implementor effort tier maps to a Max-5-only Anthropic API effort. It's OFF by
  // default so the shared repo never selects or sends it for accounts without that subscription
  // (the planner can't emit it, and any stale/legacy xhigh is coerced down to `high` at dispatch).
  // Opt back in per-machine by setting ENABLE_XHIGH=true in a local, gitignored server/.env.
  enableXhigh: process.env.ENABLE_XHIGH === "true",
  // Resume strategy. A *recent* resume hits a still-warm prompt cache (≈1h TTL on a subscription),
  // so a normal full resume is cheap AND keeps full fidelity — we only compress once the cache has
  // likely gone cold. resumeWarmMinutes is that boundary (default 40, safely under the 1h TTL):
  // resume within it → full session resume; older → compressed resume (Haiku handoff + git, §5).
  // RESUME_FULL_SESSION=1 forces full resume regardless of age.
  resumeWarmMinutes: Number(process.env.RESUME_WARM_MINUTES ?? 40),
  resumeFullSession: process.env.RESUME_FULL_SESSION === "1",
};

export type RoleModelKey = keyof typeof config.models;

/**
 * The stand-in for a model whose own separately-metered usage pool (today: Fable's gated allowance) is
 * exhausted while the account's normal 5h/weekly windows still have headroom — or undefined when the
 * model has no separate pool, so a rejection on it means the account itself is capped. Matching on the
 * family keyword keeps a Fable version bump (claude-fable-5-1…) covered without a config change.
 */
export function fallbackModelFor(model: string): string | undefined {
  const fb = /fable/i.test(model) ? config.fableFallbackModel : undefined;
  return fb && fb !== model ? fb : undefined;
}
