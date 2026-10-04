import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import type Database from "better-sqlite3";

// SQLite checkpoints the WAL inside whichever commit crosses 1000 pages, on the committing connection, so
// on the server that copy and its fsync ran on the event loop. Under load it was most of the write cost:
// 42 of 8,000 inserts took 5-494ms with it, none with it off (2026-10-04), and crash.log blamed
// `addMessage` for stalls up to 2.8s. A worker thread with its own connection runs PASSIVE checkpoints,
// which never block a writer or a reader, and the server connection's auto-checkpoint is off only while
// that worker is up.

const SQLITE_DEFAULT_AUTOCHECKPOINT = 1000;

const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const Database = require(workerData.driver);
const db = new Database(workerData.file, { fileMustExist: true });
db.pragma("wal_checkpoint(PASSIVE)");
parentPort.postMessage("ready");
setInterval(() => db.pragma("wal_checkpoint(PASSIVE)"), workerData.intervalMs);
`;

export interface WalCheckpointerOptions {
  intervalMs?: number;
  restartDelayMs?: number;
  onFault: (label: string, err: unknown) => void;
}

export class WalCheckpointer {
  private worker: Worker | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly intervalMs: number;
  private readonly restartDelayMs: number;

  constructor(
    private readonly raw: Database.Database,
    private readonly file: string,
    private readonly options: WalCheckpointerOptions,
  ) {
    this.intervalMs = options.intervalMs ?? 1000;
    this.restartDelayMs = options.restartDelayMs ?? 30_000;
  }

  start(): void {
    this.stopped = false;
    this.spawn();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    await this.worker?.terminate();
  }

  private spawn(): void {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { driver: createRequire(import.meta.url).resolve("better-sqlite3"), file: this.file, intervalMs: this.intervalMs },
    });
    this.worker = worker;
    worker.unref();
    let failure: unknown = null;
    worker.on("message", (message) => {
      if (message === "ready" && !this.stopped) this.setAutoCheckpoint(0);
    });
    worker.on("error", (err) => (failure = err));
    worker.once("exit", (code) => this.onExit(worker, failure ?? new Error(`checkpoint worker exited with code ${code}`)));
  }

  private onExit(worker: Worker, failure: unknown): void {
    if (this.worker !== worker) return;
    this.worker = null;
    this.setAutoCheckpoint(SQLITE_DEFAULT_AUTOCHECKPOINT);
    if (this.stopped) return;
    this.options.onFault(`WAL checkpoint worker stopped; SQLite auto-checkpoint is back on, retrying in ${this.restartDelayMs}ms`, failure);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopped) this.spawn();
    }, this.restartDelayMs);
    this.restartTimer.unref();
  }

  private setAutoCheckpoint(pages: number): void {
    if (this.raw.open) this.raw.pragma(`wal_autocheckpoint = ${pages}`);
  }
}
