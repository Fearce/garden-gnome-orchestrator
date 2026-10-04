import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { open, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { isModuleId, type ModuleId } from "../catalog.js";
import { ARMED_FILE_NAME, DEFAULT_IDLE_EXIT_MS, WORKER_TOKEN_HEADER, modulePaths, type WorkerHealth, type WorkerRecord } from "../protocol.js";
import { writeAtomic } from "./configStore.js";
import type { ModuleFactory, ModuleHost, WorkerContext } from "./context.js";
import { sendJson } from "./router.js";

const IDLE_CHECK_MS = 30_000;
const STREAM_PATH = "/_stream";

const FACTORIES: Record<ModuleId, () => Promise<ModuleFactory>> = {
  scripthub: async () => (await import("./scripthub/module.js")).createScriptHubModule,
  surveillance: async () => (await import("./surveillance/module.js")).createSurveillanceModule,
  home: async () => (await import("./home/module.js")).createHomeModule,
  sidekick: async () => (await import("./sidekick/module.js")).createSidekickModule,
};

class WorkerProcess {
  private readonly token = randomBytes(24).toString("hex");
  private readonly startedAt = Date.now();
  private lastActivityAt = Date.now();
  private inflight = 0;
  private openStreams = 0;
  private host: ModuleHost | null = null;
  private exiting = false;
  private readonly paths;
  private readonly server = createServer((req, res) => void this.onRequest(req, res));
  private readonly sockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  constructor(
    private readonly module: ModuleId,
    private readonly dataDir: string,
    private readonly build: string,
    private readonly hubUrl: string,
    private readonly idleExitMs: number,
  ) {
    this.paths = modulePaths(dataDir, module);
  }

  async run(): Promise<void> {
    mkdirSync(this.paths.dir, { recursive: true });
    if (!(await this.acquireLock())) {
      log(`another ${this.module} worker holds the lock; exiting`);
      process.exit(0);
    }
    this.host = await (await FACTORIES[this.module]())(this.context());
    this.server.on("upgrade", (req, socket, head) => this.onUpgrade(req, socket, head));
    const port = await new Promise<number>((resolve) => {
      this.server.listen(0, "127.0.0.1", () => resolve((this.server.address() as { port: number }).port));
    });
    const record: WorkerRecord = { module: this.module, pid: process.pid, port, token: this.token, build: this.build, startedAt: this.startedAt };
    await writeAtomic(this.paths.record, `${JSON.stringify(record)}\n`);
    setInterval(() => this.checkIdle(), IDLE_CHECK_MS).unref();
    for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"] as const) process.on(signal, () => void this.exit(`received ${signal}`));
    log(`${this.module} worker ready on 127.0.0.1:${port} (build ${this.build}, pid ${process.pid})`);
  }

  private context(): WorkerContext {
    return {
      module: this.module,
      dataDir: this.dataDir,
      moduleDir: this.paths.dir,
      configPath: this.paths.config,
      hubUrl: this.hubUrl,
      log,
      setArmed: async (reason) => {
        const file = join(this.paths.dir, ARMED_FILE_NAME);
        if (reason) await writeAtomic(file, `${JSON.stringify({ reason, at: Date.now() })}\n`);
        else await rm(file, { force: true });
      },
      armedReason: async () => {
        try {
          const armed = JSON.parse(await readFile(join(this.paths.dir, ARMED_FILE_NAME), "utf8")) as { reason?: unknown };
          return typeof armed.reason === "string" && armed.reason ? armed.reason : null;
        } catch {
          return null;
        }
      },
    };
  }

  private async onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.headers[WORKER_TOKEN_HEADER] !== this.token) return sendJson(res, 403, { error: "missing worker token" });
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/_worker/health") return sendJson(res, 200, this.health());
    if (url.pathname === "/_worker/shutdown" && req.method === "POST") {
      sendJson(res, 200, { ok: true });
      void this.exit("asked to shut down");
      return;
    }
    this.inflight += 1;
    this.lastActivityAt = Date.now();
    res.once("close", () => {
      this.inflight -= 1;
      this.lastActivityAt = Date.now();
    });
    const handled = await this.host!.router.handle(req, res, url).catch((error: Error) => {
      if (!res.headersSent) sendJson(res, 500, { error: error.message });
      return true;
    });
    if (!handled) sendJson(res, 404, { error: `no ${this.module} route ${url.pathname}` });
  }

  private onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.headers[WORKER_TOKEN_HEADER] !== this.token || url.pathname !== STREAM_PATH || !this.host?.onStream) {
      socket.destroy();
      return;
    }
    this.sockets.handleUpgrade(req, socket, head, (ws) => {
      this.openStreams += 1;
      this.lastActivityAt = Date.now();
      ws.once("close", () => {
        this.openStreams -= 1;
        this.lastActivityAt = Date.now();
      });
      this.host!.onStream!(ws, req);
    });
  }

  private health(): WorkerHealth {
    return {
      ok: true,
      module: this.module,
      pid: process.pid,
      build: this.build,
      startedAt: this.startedAt,
      lastActivityAt: this.lastActivityAt,
      busy: this.host?.busy() ?? null,
      openStreams: this.openStreams,
      rssBytes: process.memoryUsage.rss(),
      idleExitMs: this.idleExitMs,
    };
  }

  private checkIdle(): void {
    if (this.inflight > 0 || this.openStreams > 0 || this.host?.busy()) return;
    if (Date.now() - this.lastActivityAt >= this.idleExitMs) void this.exit(`idle for ${Math.round(this.idleExitMs / 60_000)} min`);
  }

  private async exit(reason: string): Promise<void> {
    if (this.exiting) return;
    this.exiting = true;
    log(`${this.module} worker exiting: ${reason}`);
    const force = setTimeout(() => process.exit(0), 10_000);
    force.unref();
    try {
      await this.host?.shutdown();
    } catch (error) {
      log(`shutdown error: ${(error as Error).message}`);
    }
    for (const client of this.sockets.clients) client.terminate();
    this.server.close();
    await this.releaseLock();
    process.exit(0);
  }

  /** The lock holds the owner's pid; a lock whose owner died is taken over. */
  private async acquireLock(): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(this.paths.lock, "wx");
        await handle.writeFile(String(process.pid));
        await handle.close();
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const owner = Number((await readFile(this.paths.lock, "utf8").catch(() => "")).trim());
        if (owner > 0 && owner !== process.pid && pidExists(owner)) return false;
        await rm(this.paths.lock, { force: true });
      }
    }
    return false;
  }

  private async releaseLock(): Promise<void> {
    const owner = Number((await readFile(this.paths.lock, "utf8").catch(() => "")).trim());
    if (owner === process.pid) await rm(this.paths.lock, { force: true });
    const record = await readFile(this.paths.record, "utf8").then((text) => JSON.parse(text) as WorkerRecord).catch(() => null);
    if (record?.pid === process.pid) await rm(this.paths.record, { force: true });
  }
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function log(line: string): void {
  process.stdout.write(`${new Date().toISOString()} ${line}\n`);
}

async function main(): Promise<void> {
  const id = process.argv[2];
  const dataDir = process.env.GGO_MODULE_DATA_DIR;
  if (!id || !isModuleId(id) || !dataDir) {
    log(`usage: worker <module> with GGO_MODULE_DATA_DIR set (got module=${id ?? ""})`);
    process.exit(2);
  }
  process.on("unhandledRejection", (reason) => log(`unhandled rejection: ${reason instanceof Error ? reason.stack : String(reason)}`));
  process.on("uncaughtException", (error) => {
    log(`uncaught exception: ${error.stack ?? error.message}`);
    process.exit(1);
  });
  const idle = Number(process.env.GGO_MODULE_IDLE_MS);
  const worker = new WorkerProcess(
    id,
    dataDir,
    process.env.GGO_MODULE_BUILD || "dev",
    process.env.SCRIPT_HUB_URL || "http://127.0.0.1:3939",
    Number.isFinite(idle) && idle > 0 ? idle : DEFAULT_IDLE_EXIT_MS,
  );
  await worker.run();
}

// The lock names this pid, so the next start takes it over once this process is gone.
void main().catch((error: Error) => {
  log(`worker failed to start: ${error.stack ?? error.message}`);
  process.exit(1);
});
