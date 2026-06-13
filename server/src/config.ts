import "dotenv/config";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// src/config.ts (dev) or dist/config.js (prod) — parent is the server root either way.
const serverRoot = resolve(here, "..");

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
  models: {
    director: "claude-sonnet-4-6",
    planner: "claude-opus-4-8",
    researcher: "claude-sonnet-4-6",
    implementor: "claude-opus-4-8",
  },
} as const;

export type RoleModelKey = keyof typeof config.models;
