import "dotenv/config";
import { dirname, resolve } from "node:path";
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

export const config = {
  serverRoot,
  port: Number(process.env.PORT ?? 4317),
  host: process.env.HOST ?? "127.0.0.1",
  dataDir: resolve(serverRoot, "data"),
  dbPath: resolve(serverRoot, "data", "orchestrator.sqlite"),
  webDist: resolve(serverRoot, "..", "web", "dist"),
  defaultWorkspace: process.env.DEFAULT_WORKSPACE ?? "C:\\",
  memoryDir: process.env.MEMORY_DIR ?? "C:\\Users\\user\\.claude\\memory",
  oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN || undefined,
  accounts: loadAccounts(),
  accountTickMs: Number(process.env.ACCOUNT_TICK_MS ?? 60_000),
  models: {
    director: "claude-sonnet-4-6",
    planner: "claude-opus-4-8",
    researcher: "claude-sonnet-4-6",
    implementor: "claude-opus-4-8",
    qa: "claude-opus-4-8",
  },
  maxQaRounds: Number(process.env.MAX_QA_ROUNDS ?? 4),
};

export type RoleModelKey = keyof typeof config.models;
