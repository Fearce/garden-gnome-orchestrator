import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";
import type { ModuleId } from "../catalog.js";
import type { Router } from "./router.js";

/** What the worker host hands each module. */
export interface WorkerContext {
  module: ModuleId;
  dataDir: string;
  moduleDir: string;
  configPath: string;
  hubUrl: string;
  log(line: string): void;
  /** Declare (or clear, with null) user-started work GGO must keep running across crashes and restarts. */
  setArmed(reason: string | null): Promise<void>;
  /** The armed reason left by an earlier worker, so user-started work resumes after a crash or reboot. */
  armedReason(): Promise<string | null>;
}

export interface ModuleHost {
  router: Router;
  /** Why this worker must not exit or be replaced right now; null when it is free to go. */
  busy(): string | null;
  /** A browser stream the console relays (camera frames). */
  onStream?(socket: WebSocket, req: IncomingMessage): void;
  /** Stop every child process and timer; called before the worker exits. */
  shutdown(): Promise<void>;
}

export type ModuleFactory = (ctx: WorkerContext) => Promise<ModuleHost>;
