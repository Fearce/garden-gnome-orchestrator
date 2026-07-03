import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, resolve } from "node:path";
import { config } from "../config.js";

type Env = Record<string, string | undefined>;

/**
 * Agent shells inherit the orchestrator service environment, which can be thinner than an
 * interactive terminal PATH. Prepend deterministic tool locations so repo-local instructions can
 * call globally managed CLIs such as `graphify` without depending on how the service was started.
 */
export function withAgentToolPath(base: Env = process.env): Env {
  const env: Env = { ...base };
  const pathKeys = Object.keys(env).filter((k) => k.toLowerCase() === "path");
  const key = preferredPathKey(pathKeys);
  const existing = pathKeys.flatMap((k) => splitPaths(env[k]));
  for (const k of pathKeys) {
    if (k !== key) delete env[k];
  }

  env[key] = uniquePaths([...agentToolDirs(), ...existing]).join(delimiter);
  return env;
}

function preferredPathKey(keys: string[]): string {
  if (process.platform !== "win32") return keys[0] ?? "PATH";
  return keys.find((k) => k === "Path") ?? keys[0] ?? "Path";
}

function agentToolDirs(): string[] {
  const repoRoot = resolve(config.serverRoot, "..");
  return [
    ...splitPaths(process.env.AGENT_EXTRA_PATHS),
    ...splitPaths(process.env.GRAPHIFY_BIN_DIR),
    ...[
      resolve(config.serverRoot, "node_modules", ".bin"),
      resolve(repoRoot, "node_modules", ".bin"),
      ...globalNodeBinDirs(),
    ].filter((p) => existsSync(p)),
  ];
}

function globalNodeBinDirs(): string[] {
  if (process.platform === "win32") {
    return [
      resolve(process.execPath, ".."),
      process.env.APPDATA ? resolve(process.env.APPDATA, "npm") : resolve(homedir(), "AppData", "Roaming", "npm"),
    ];
  }

  return [
    resolve(homedir(), ".npm-global", "bin"),
    resolve(homedir(), ".local", "bin"),
    resolve(resolve(process.execPath, "..", ".."), "bin"),
    "/usr/local/bin",
    "/opt/homebrew/bin",
  ];
}

function splitPaths(value: string | undefined): string[] {
  return value
    ? value
        .split(delimiter)
        .map((p) => p.trim())
        .filter(Boolean)
    : [];
}

function uniquePaths(paths: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of paths) {
    const key = normalizePathKey(p);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

function normalizePathKey(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  return process.platform === "win32" ? trimmed.toLowerCase() : trimmed;
}
