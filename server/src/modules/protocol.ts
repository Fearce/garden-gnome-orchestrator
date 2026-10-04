import { join } from "node:path";
import type { ModuleId } from "./catalog.js";

/** Header carrying the per-worker secret. A worker listens on loopback only, and still refuses any request
 *  without its token, so another local program cannot drive cameras or Script Hub through it. */
export const WORKER_TOKEN_HEADER = "x-ggo-module-token";

/** What a running worker publishes about itself in `worker.json`, the file GGO reads to reach it. */
export interface WorkerRecord {
  module: ModuleId;
  pid: number;
  port: number;
  token: string;
  /** The GGO build the worker loaded. A worker outlives GGO restarts, so a deploy can leave it on old code. */
  build: string;
  startedAt: number;
}

/** `GET /_worker/health`. */
export interface WorkerHealth {
  ok: true;
  module: ModuleId;
  pid: number;
  build: string;
  startedAt: number;
  lastActivityAt: number;
  /** Why the worker must not be stopped for idleness or an update, e.g. "recording 2 cameras". */
  busy: string | null;
  openStreams: number;
  rssBytes: number;
  idleExitMs: number;
}

export interface ModulePaths {
  dir: string;
  record: string;
  lock: string;
  log: string;
  config: string;
}

export function modulePaths(dataDir: string, id: ModuleId): ModulePaths {
  const dir = join(dataDir, "modules", id);
  return {
    dir,
    record: join(dir, "worker.json"),
    lock: join(dir, "worker.lock"),
    log: join(dir, "worker.log"),
    config: join(dir, "config.json"),
  };
}

/** Present while a module holds user-started work (a recording) that must outlive crashes and restarts. */
export const ARMED_FILE_NAME = "armed.json";

/** Idle workers exit after this long without a request, an open stream or busy work. */
export const DEFAULT_IDLE_EXIT_MS = 10 * 60_000;
