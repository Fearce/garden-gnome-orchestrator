import "dotenv/config";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { Account } from "./accounts/account.js";

const here = dirname(fileURLToPath(import.meta.url));
// src/config.ts (dev) or dist/config.js (prod) — parent is the server root either way.
const serverRoot = resolve(here, "..");

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
  port: Number(process.env.PORT ?? 4317),
  // Second, TLS listener so the orchestrator can be embedded as a same-protocol
  // iframe inside the HTTPS Dashboard Deck (https://localhost:3940) — Chromium
  // silently blocks an http://:4317 frame under an https page as mixed content.
  // 4318 is taken by the Vite dev server, so default to 4319. We reuse the deck's
  // own self-signed pfx (already trusted in the browser for localhost) so no new
  // cert has to be accepted. Missing/unreadable cert → HTTPS is skipped, never
  // breaking the plain HTTP listener.
  httpsPort: Number(process.env.HTTPS_PORT ?? 4319),
  httpsPfxPath:
    process.env.HTTPS_PFX_PATH ??
    resolve(homedir(), ".runtime", "workspace", "script-hub", "web", "certs", "certhub.pfx"),
  httpsPfxPassphrase: process.env.HTTPS_PFX_PASSPHRASE ?? "runtime",
  host: exposeBlocked ? "127.0.0.1" : requestedHost,
  authPassword,
  // Wrong-password lockout per client IP (anti-brute-force). A short PIN is safe behind this.
  loginCooldownMs: Number(process.env.LOGIN_COOLDOWN_MS ?? 30_000),
  googleClientId,
  googleClientSecret,
  allowedEmail: (process.env.ALLOWED_EMAIL || "user@example.com").toLowerCase(),
  // Public origin Google redirects back to (e.g. https://host.tailnet.ts.net). When set,
  // the OAuth redirect_uri is pinned to it instead of the request Host header, so the
  // registered URI can't diverge and a spoofed Host can't influence it. Localhost dev
  // leaves it unset and derives the origin from the request.
  publicOrigin: (process.env.PUBLIC_ORIGIN || "").replace(/\/$/, "") || undefined,
  sessionSecret: process.env.SESSION_SECRET || googleClientSecret || authPassword || "orchestrator-dev-secret",
  hostWarning: exposeBlocked
    ? `HOST=${requestedHost} requested but no auth is set — refusing to expose bypassPermissions agents on the LAN unauthenticated; bound to 127.0.0.1. Set AUTH_PASSWORD (or GOOGLE_CLIENT_ID/SECRET) to enable LAN access.`
    : undefined,
  dataDir: resolve(serverRoot, "data"),
  dbPath: resolve(serverRoot, "data", "orchestrator.sqlite"),
  webDist: resolve(serverRoot, "..", "web", "dist"),
  defaultWorkspace: process.env.DEFAULT_WORKSPACE ?? "C:\\",
  // Roots the director's find_workspace tool scans to resolve a project name → real path.
  workspaceSearchRoots: (process.env.WORKSPACE_SEARCH_ROOTS || "C:\\;D:\\")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean),
  memoryDir: process.env.MEMORY_DIR ?? resolve(homedir(), ".claude", "memory"),
  oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN || undefined,
  accounts: loadAccounts(),
  accountPingMs: Number(process.env.ACCOUNT_PING_MS ?? 600_000),
  notifyWebhookUrl: process.env.NOTIFY_WEBHOOK_URL || undefined,
  models: {
    director: "claude-sonnet-4-6",
    planner: "claude-opus-4-8",
    researcher: "claude-sonnet-4-6",
    implementor: "claude-opus-4-8",
    qa: "claude-opus-4-8",
  },
  maxQaRounds: Number(process.env.MAX_QA_ROUNDS ?? 4),
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
