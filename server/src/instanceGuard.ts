import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface InstanceGuard {
  readonly path: string;
  release(): void;
}

function lockBusy(error: unknown): boolean {
  const value = error as { code?: unknown; message?: unknown };
  return value?.code === "SQLITE_BUSY" || /database is locked/i.test(String(value?.message ?? ""));
}

/**
 * Acquire the one process allowed to open and reconcile an orchestrator data directory.
 *
 * The lock lives in a separate SQLite file, so holding its exclusive transaction never blocks normal
 * application reads/writes. SQLite/Windows releases it when the process dies, including a forced tree
 * kill; there is no stale PID file to mistake for a live owner. A loser closes without opening the real
 * orchestrator database, which is the ordering that prevents duplicate boot recovery mutations.
 */
export function acquireInstanceGuard(path: string): InstanceGuard | null {
  mkdirSync(dirname(path), { recursive: true });
  let db: Database.Database | null = null;
  try {
    db = new Database(path, { timeout: 0 });
    db.pragma("journal_mode = DELETE");
    db.exec(`
      CREATE TABLE IF NOT EXISTS owner (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        pid INTEGER NOT NULL,
        acquired_at INTEGER NOT NULL
      );
    `);
    db.exec("BEGIN EXCLUSIVE");
    db.prepare(
      `INSERT INTO owner(singleton, pid, acquired_at) VALUES(1, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET pid=excluded.pid, acquired_at=excluded.acquired_at`,
    ).run(process.pid, Date.now());

    let released = false;
    const owned = db;
    return {
      path,
      release: () => {
        if (released) return;
        released = true;
        try {
          if (owned.inTransaction) owned.exec("ROLLBACK");
        } finally {
          owned.close();
        }
      },
    };
  } catch (error) {
    try {
      db?.close();
    } catch {
      /* preserve the acquisition error */
    }
    if (lockBusy(error)) return null;
    throw error;
  }
}
