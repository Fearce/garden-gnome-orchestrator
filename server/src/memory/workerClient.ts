import { watch, type FSWatcher } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type { CardInput, CardJob, IndexStatus, IndexedFile, SearchCandidate, SyncResult, UsageRecord } from "./indexStore.js";
import type { LunaRequest, LunaResult, WorkerOp, WorkerReply } from "./workerProtocol.js";

const RUNNING_FROM_SOURCE = import.meta.url.endsWith(".ts");
const WORKER_URL = new URL(`./memoryWorker${RUNNING_FROM_SOURCE ? ".ts" : ".js"}`, import.meta.url);
// Under tsx (dev, tests) a worker thread does not inherit tsx's resolver, so the `.js` specifiers in the
// worker's imports would miss their `.ts` sources; register tsx inside the thread before loading it.
const TSX_BOOTSTRAP = `
const { workerData } = require("node:worker_threads");
import(workerData.tsxApi).then((api) => { api.register(); return import(workerData.entry); });
`;
/** Without a working directory watcher, re-scan at most this often before answering. */
const UNWATCHED_RESYNC_MS = 60_000;

export interface MemoryWorkerOptions {
  /** Terminate the worker after this long with nothing in flight. */
  idleMs?: number;
  requestTimeoutMs?: number;
  /** A sync found new, edited or deleted memory files (whoever wrote them). */
  onIndexChanged?: (result: SyncResult) => void;
}

/** The server-side handle on the memory worker thread. The thread starts on the first request, brings the
 *  index up to date before it answers, and is terminated after `idleMs` without work. A directory watcher
 *  marks the index dirty when a memory file changes, so a quiet directory costs nothing per query. */
export class MemoryWorkerClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>();
  private idleTimer: NodeJS.Timeout | null = null;
  private watcher: FSWatcher | null = null;
  private dirty = true;
  private lastSyncAt = 0;
  private syncing: Promise<SyncResult> | null = null;
  private lastSync: SyncResult | null = null;
  private readonly idleMs: number;
  private readonly requestTimeoutMs: number;

  constructor(
    private readonly dbPath: string,
    private readonly memoryDir: string,
    private readonly options: MemoryWorkerOptions = {},
  ) {
    this.idleMs = options.idleMs ?? 180_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
  }

  get running(): boolean {
    return this.worker != null;
  }

  get lastSyncResult(): SyncResult | null {
    return this.lastSync;
  }

  markDirty(): void {
    this.dirty = true;
  }

  async sync(force = false): Promise<SyncResult> {
    if (force) this.dirty = true;
    return this.ensureFresh(force);
  }

  async search(query: string, limit: number): Promise<SearchCandidate[]> {
    await this.ensureFresh();
    return this.call<SearchCandidate[]>({ op: "search", query, limit });
  }

  async file(file: string): Promise<IndexedFile | null> {
    await this.ensureFresh();
    return this.call<IndexedFile | null>({ op: "file", file });
  }

  async findByName(name: string): Promise<string | null> {
    await this.ensureFresh();
    return this.call<string | null>({ op: "findByName", name });
  }

  async list(offset: number, limit: number, filter: string): Promise<{ total: number; files: IndexedFile[] }> {
    await this.ensureFresh();
    return this.call({ op: "list", offset, limit, filter });
  }

  async cardJobs(limit: number, exclude: string[] = []): Promise<CardJob[]> {
    await this.ensureFresh();
    return this.call<CardJob[]>({ op: "cardJobs", limit, exclude });
  }

  storeCards(cards: CardInput[]): Promise<number> {
    return this.call<number>({ op: "storeCards", cards });
  }

  recordUsage(record: UsageRecord): Promise<void> {
    return this.call<void>({ op: "usage", record });
  }

  async status(): Promise<IndexStatus> {
    await this.ensureFresh();
    return this.call<IndexStatus>({ op: "status" });
  }

  luna(request: LunaRequest): Promise<LunaResult | null> {
    return this.call<LunaResult | null>({ op: "luna", request }, request.timeoutMs + 5_000);
  }

  async close(): Promise<void> {
    this.watcher?.close();
    this.watcher = null;
    await this.stopWorker();
  }

  private async ensureFresh(force = false): Promise<SyncResult> {
    this.watch();
    const stale = !this.watcher && Date.now() - this.lastSyncAt > UNWATCHED_RESYNC_MS;
    if (!this.dirty && !stale && this.lastSync && !force) return this.lastSync;
    if (this.syncing) return this.syncing;
    this.dirty = false;
    this.syncing = this.call<SyncResult>({ op: "sync", force }, 300_000)
      .then((result) => {
        this.lastSync = result;
        if (result.added || result.changed || result.removed) this.options.onIndexChanged?.(result);
        this.lastSyncAt = Date.now();
        return result;
      })
      .catch((err: unknown) => {
        this.dirty = true;
        throw err;
      })
      .finally(() => (this.syncing = null));
    return this.syncing;
  }

  private watch(): void {
    if (this.watcher) return;
    try {
      this.watcher = watch(this.memoryDir, { persistent: false }, (_event, name) => {
        if (!name || String(name).toLowerCase().endsWith(".md")) this.dirty = true;
      });
      this.watcher.on("error", () => {
        this.watcher?.close();
        this.watcher = null;
        this.dirty = true;
      });
    } catch {
      this.watcher = null;
    }
  }

  private call<T>(op: WorkerOp, timeoutMs = this.requestTimeoutMs): Promise<T> {
    const worker = this.ensureWorker();
    const id = this.nextId++;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`memory worker did not answer ${op.op} within ${timeoutMs}ms`));
        this.armIdle();
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      worker.postMessage({ ...op, id });
    });
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const workerData = { dbPath: this.dbPath, memoryDir: this.memoryDir };
    const worker = RUNNING_FROM_SOURCE
      ? new Worker(TSX_BOOTSTRAP, { eval: true, workerData: { ...workerData, tsxApi: pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm/api")).href, entry: WORKER_URL.href } })
      : new Worker(WORKER_URL, { workerData });
    worker.unref();
    worker.on("message", (reply: WorkerReply) => this.onReply(reply));
    worker.on("error", (err: unknown) => this.onExit(worker, err instanceof Error ? err : new Error(String(err))));
    worker.on("exit", (code) => this.onExit(worker, new Error(`memory worker exited with code ${code}`)));
    this.worker = worker;
    return worker;
  }

  private onReply(reply: WorkerReply): void {
    const entry = this.pending.get(reply.id);
    if (!entry) return;
    this.pending.delete(reply.id);
    clearTimeout(entry.timer);
    if (reply.ok) entry.resolve(reply.value);
    else entry.reject(new Error(reply.error));
    this.armIdle();
  }

  private onExit(worker: Worker, err: Error): void {
    if (this.worker !== worker) return;
    this.worker = null;
    this.dirty = true;
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
      this.pending.delete(id);
    }
  }

  private armIdle(): void {
    if (this.pending.size || !this.worker) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.stopWorker(), this.idleMs);
    this.idleTimer.unref();
  }

  private async stopWorker(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const worker = this.worker;
    if (!worker || this.pending.size) return;
    this.worker = null;
    const exited = new Promise<void>((resolve) => worker.once("exit", () => resolve()));
    worker.postMessage({ op: "close" });
    const timer = setTimeout(() => void worker.terminate(), 5_000);
    await exited;
    clearTimeout(timer);
  }
}
