import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runChild } from "../childRunner.js";
import { MODULE_IDS, type ModuleId } from "./catalog.js";
import { ARMED_FILE_NAME, DEFAULT_IDLE_EXIT_MS, WORKER_TOKEN_HEADER, modulePaths, type WorkerHealth, type WorkerRecord } from "./protocol.js";
import { spawnDetached, workerEnvironment } from "./spawnDetached.js";

export interface WorkerConnection {
  port: number;
  token: string;
  health: WorkerHealth;
}

export type ServiceState = "stopped" | "starting" | "running" | "unresponsive";

export interface ServiceStatus {
  module: ModuleId;
  state: ServiceState;
  pid: number | null;
  startedAt: number | null;
  /** The worker runs code from an older GGO build; restart it to update. */
  stale: boolean;
  busy: string | null;
  /** The worker has user-started work (a recording) that GGO restores if the worker dies. */
  armed: string | null;
  rssBytes: number | null;
  lastError: string | null;
}

export class ModuleError extends Error {
  constructor(message: string, public readonly status = 503) { super(message); }
}

interface SupervisorOptions {
  dataDir: string;
  /** Build id of this GGO process; workers report theirs so a stale one can be retired. */
  build: string;
  hubUrl: string;
  idleExitMs?: number;
  log?: (line: string) => void;
}

const HEALTH_TIMEOUT_MS = 2_000;
const START_TIMEOUT_MS = 20_000;
const ARMED_WATCH_MS = 60_000;
/** A worker that answered its health check this recently is used without asking again. */
const CONNECTION_REUSE_MS = 10_000;
/** A worker log past this size is moved to `worker.log.1` before the next start, keeping one old copy. */
const LOG_ROTATE_BYTES = 4 * 1024 * 1024;

/**
 * Starts, finds and stops the module workers. Nothing here runs until a module is asked for: no timer, no
 * process, no file watch. The one exception is a module holding user-started work (an armed recording),
 * which gets a once-a-minute liveness check so that work survives a worker crash or a reboot.
 */
export class ModuleSupervisor {
  private readonly starting = new Map<ModuleId, Promise<WorkerConnection>>();
  /** Modules whose worker process is being launched right now; `starting` also covers a mere health re-check. */
  private readonly launching = new Set<ModuleId>();
  private readonly lastError = new Map<ModuleId, string>();
  private readonly known = new Map<ModuleId, { connection: WorkerConnection; checkedAt: number }>();
  private armedTimer: NodeJS.Timeout | null = null;
  private readonly entry = resolveWorkerEntry();

  constructor(private readonly options: SupervisorOptions) {}

  /** A running, healthy worker for `id`, starting one if needed. Concurrent callers share one start. */
  ensure(id: ModuleId): Promise<WorkerConnection> {
    const known = this.known.get(id);
    if (known && Date.now() - known.checkedAt < CONNECTION_REUSE_MS) return Promise.resolve(known.connection);
    const pending = this.starting.get(id);
    if (pending) return pending;
    const attempt = this.connectOrStart(id)
      .then((connection) => {
        this.known.set(id, { connection, checkedAt: Date.now() });
        return connection;
      })
      .finally(() => this.starting.delete(id));
    this.starting.set(id, attempt);
    return attempt;
  }

  /** Forget a cached connection, after a request to it failed to connect. */
  forget(id: ModuleId): void {
    this.known.delete(id);
  }

  /** Where every module stands, without starting anything. */
  async statuses(): Promise<ServiceStatus[]> {
    return Promise.all(MODULE_IDS.map((id) => this.status(id)));
  }

  async status(id: ModuleId): Promise<ServiceStatus> {
    const armed = await this.armedReason(id);
    const base: ServiceStatus = { module: id, state: "stopped", pid: null, startedAt: null, stale: false, busy: null, armed, rssBytes: null, lastError: this.lastError.get(id) ?? null };
    if (this.launching.has(id)) return { ...base, state: "starting" };
    const record = await this.readRecord(id);
    if (!record) return base;
    const health = await this.health(record);
    if (!health) {
      const alive = await isLiveNodeProcess(record.pid);
      return alive ? { ...base, state: "unresponsive", pid: record.pid, startedAt: record.startedAt } : base;
    }
    return {
      ...base,
      state: "running",
      pid: health.pid,
      startedAt: health.startedAt,
      stale: this.isStale(health.build),
      busy: health.busy,
      rssBytes: health.rssBytes,
    };
  }

  /**
   * Stop a worker. A busy one (recording) refuses unless `force`, so a stray click cannot end a recording.
   * A forced stop also ends the user-started work for good, unless `keepArmed` asks for it to come back
   * on the next worker (a restart).
   */
  async stop(id: ModuleId, options: { force?: boolean; keepArmed?: boolean } = {}): Promise<void> {
    this.known.delete(id);
    const paths = modulePaths(this.options.dataDir, id);
    const record = await this.readRecord(id);
    const health = record ? await this.health(record) : null;
    if (health?.busy && !options.force) throw new ModuleError(`${health.busy}. Stop that first, or stop the service anyway.`, 409);
    if (!options.keepArmed) await rm(join(paths.dir, ARMED_FILE_NAME), { force: true });
    if (!record) return;
    if (health) await this.request(record, "/_worker/shutdown", { method: "POST" }).catch(() => undefined);
    if (!(await this.waitForExit(record.pid, 8_000))) await killWorker(record.pid);
    await rm(paths.record, { force: true });
    this.syncArmedWatch();
  }

  async restart(id: ModuleId): Promise<WorkerConnection> {
    await this.stop(id, { force: true, keepArmed: true });
    return this.ensure(id);
  }

  /** At boot: bring back workers that hold user-started work, then keep an eye on them. */
  async resumeArmed(): Promise<void> {
    for (const id of MODULE_IDS) {
      const reason = await this.armedReason(id);
      if (!reason) continue;
      this.options.log?.(`[modules] ${id} has user-started work (${reason}); making sure its worker runs`);
      await this.ensure(id).catch((error: Error) => this.options.log?.(`[modules] ${id} could not resume: ${error.message}`));
    }
    this.syncArmedWatch();
  }

  /** Called after any module request: start or stop the liveness check to match the armed set. */
  syncArmedWatch(): void {
    void this.anyArmed().then((armed) => {
      if (armed && !this.armedTimer) {
        this.armedTimer = setInterval(() => void this.checkArmed(), ARMED_WATCH_MS);
        this.armedTimer.unref?.();
      } else if (!armed && this.armedTimer) {
        clearInterval(this.armedTimer);
        this.armedTimer = null;
      }
    });
  }

  dispose(): void {
    if (this.armedTimer) clearInterval(this.armedTimer);
    this.armedTimer = null;
  }

  private async checkArmed(): Promise<void> {
    for (const id of MODULE_IDS) {
      if (!(await this.armedReason(id))) continue;
      const record = await this.readRecord(id);
      if (record && (await this.health(record))) continue;
      this.options.log?.(`[modules] ${id} worker is gone while it held user-started work; restarting it`);
      await this.ensure(id).catch((error: Error) => this.options.log?.(`[modules] ${id} restart failed: ${error.message}`));
    }
    this.syncArmedWatch();
  }

  private async connectOrStart(id: ModuleId): Promise<WorkerConnection> {
    const existing = await this.readRecord(id);
    if (existing) {
      const health = await this.health(existing);
      if (health && (!this.isStale(health.build) || health.busy)) return { port: existing.port, token: existing.token, health };
      if (health) {
        this.options.log?.(`[modules] ${id} worker runs build ${health.build}; replacing it with ${this.options.build}`);
        await this.stop(id, { force: true, keepArmed: true });
      } else if (await isLiveNodeProcess(existing.pid)) {
        this.options.log?.(`[modules] ${id} worker pid ${existing.pid} stopped answering; replacing it`);
        await killWorker(existing.pid);
      }
    }
    this.launching.add(id);
    try {
      const connection = await this.start(id);
      this.lastError.delete(id);
      return connection;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError.set(id, message);
      throw new ModuleError(message);
    } finally {
      this.launching.delete(id);
    }
  }

  private async start(id: ModuleId): Promise<WorkerConnection> {
    const paths = modulePaths(this.options.dataDir, id);
    await mkdir(paths.dir, { recursive: true });
    await rm(paths.record, { force: true });
    await rotateLog(paths.log);
    const pid = await spawnDetached({
      command: process.execPath,
      args: [...this.entry.nodeArgs, this.entry.file, id],
      cwd: this.entry.cwd,
      logFile: paths.log,
      env: workerEnvironment({
        GGO_MODULE_DATA_DIR: this.options.dataDir,
        GGO_MODULE_BUILD: this.options.build,
        GGO_MODULE_IDLE_MS: String(this.options.idleExitMs ?? DEFAULT_IDLE_EXIT_MS),
        SCRIPT_HUB_URL: this.options.hubUrl,
      }),
    });
    this.options.log?.(`[modules] started ${id} worker pid ${pid}`);
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await delay(150);
      const record = await this.readRecord(id);
      if (record) {
        const health = await this.health(record);
        if (health) return { port: record.port, token: record.token, health };
      }
      // A second worker that found one already running exits at once; its record is the live one.
      // This pid came from our own spawn. Checking existence is enough here; Windows tasklist
      // can take seconds and miss readiness (or falsely report an exit when enumeration times out).
      // Keep the executable-name check in killWorker, where pid reuse could kill an unrelated app.
      if (!pidExists(pid) && !record) throw new Error(`the ${id} worker exited during startup${await logTail(paths.log)}`);
    }
    throw new Error(`the ${id} worker did not answer within ${START_TIMEOUT_MS / 1000}s${await logTail(paths.log)}`);
  }

  async request(record: Pick<WorkerRecord, "port" | "token">, path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
    const { timeoutMs = HEALTH_TIMEOUT_MS, ...rest } = init;
    return fetch(`http://127.0.0.1:${record.port}${path}`, {
      ...rest,
      headers: { ...(rest.headers as Record<string, string> | undefined), [WORKER_TOKEN_HEADER]: record.token },
      signal: rest.signal ?? AbortSignal.timeout(timeoutMs),
    });
  }

  private async health(record: WorkerRecord): Promise<WorkerHealth | null> {
    try {
      const res = await this.request(record, "/_worker/health");
      if (!res.ok) return null;
      const body = (await res.json()) as WorkerHealth;
      return body.pid === record.pid ? body : null;
    } catch {
      return null;
    }
  }

  private isStale(build: string): boolean {
    return build !== this.options.build;
  }

  private async readRecord(id: ModuleId): Promise<WorkerRecord | null> {
    try {
      const record = JSON.parse(await readFile(modulePaths(this.options.dataDir, id).record, "utf8")) as WorkerRecord;
      return record.module === id && record.port > 0 && record.token ? record : null;
    } catch {
      return null;
    }
  }

  private async armedReason(id: ModuleId): Promise<string | null> {
    try {
      const armed = JSON.parse(await readFile(join(modulePaths(this.options.dataDir, id).dir, ARMED_FILE_NAME), "utf8")) as { reason?: string };
      return typeof armed.reason === "string" && armed.reason ? armed.reason : null;
    } catch {
      return null;
    }
  }

  private async anyArmed(): Promise<boolean> {
    for (const id of MODULE_IDS) if (await this.armedReason(id)) return true;
    return false;
  }

  private async waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!pidExists(pid)) return true;
      await delay(200);
    }
    return !pidExists(pid);
  }
}

function resolveWorkerEntry(): { file: string; nodeArgs: string[]; cwd: string } {
  const here = dirname(fileURLToPath(import.meta.url));
  const built = join(here, "worker", "main.js");
  const serverRoot = join(here, "..", "..");
  if (existsSync(built)) return { file: built, nodeArgs: [], cwd: serverRoot };
  // Running from source under tsx (dev server, gates): the worker needs the same loader.
  return { file: join(here, "worker", "main.ts"), nodeArgs: ["--import", "tsx"], cwd: serverRoot };
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Only a node.exe may be killed under a recorded pid: after a crash the pid can belong to anything. */
async function isLiveNodeProcess(pid: number): Promise<boolean> {
  if (!pidExists(pid)) return false;
  if (process.platform !== "win32") return true;
  const result = await runChild("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { timeoutMs: 8_000 });
  return /^"node\.exe"/im.test(result.stdout);
}

async function killWorker(pid: number): Promise<void> {
  if (!(await isLiveNodeProcess(pid))) return;
  if (process.platform === "win32") await runChild("taskkill", ["/F", "/T", "/PID", String(pid)], { timeoutMs: 10_000 });
  else process.kill(pid, "SIGKILL");
}

async function rotateLog(file: string): Promise<void> {
  const size = await stat(file).then((s) => s.size, () => 0);
  if (size > LOG_ROTATE_BYTES) await rename(file, `${file}.1`).catch(() => undefined);
}

async function logTail(file: string): Promise<string> {
  try {
    const text = (await readFile(file, "utf8")).trim().split(/\r?\n/).slice(-4).join(" | ");
    return text ? ` — last log lines: ${text.slice(-600)}` : "";
  } catch {
    return "";
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
