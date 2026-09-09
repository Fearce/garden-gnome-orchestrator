const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const Database = require("better-sqlite3");

const SERVER_DIR = path.resolve(__dirname, "..");
const LOCK_DB = path.join(SERVER_DIR, "data", "gates-run-lock.sqlite");
const OWNER_FILE = path.join(SERVER_DIR, "data", "gates-run-owner.json");

function readOwner(ownerPath = OWNER_FILE) {
  try {
    const parsed = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
    if (parsed?.version !== 1 || typeof parsed.token !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

function removeOwnedMetadata(ownerPath, token) {
  const current = readOwner(ownerPath);
  if (!current || current.token !== token) return;
  try {
    fs.unlinkSync(ownerPath);
  } catch {
    // Diagnostics never own the lease. A later owner overwrites this file.
  }
}

function isBusyError(err) {
  return err?.code === "SQLITE_BUSY" || /database is locked/i.test(String(err?.message ?? err));
}

/**
 * Claim the one machine-local full-suite lease.
 *
 * SQLite owns the actual lock: its transaction is released by the OS even if the
 * runner is killed, so this never has to guess whether a pidfile is stale. The JSON
 * file is diagnostics only and is never trusted to grant or deny the lease.
 */
function acquireGateRunLease(options = {}) {
  const lockDbPath = options.lockDbPath ?? LOCK_DB;
  const ownerPath = options.ownerPath ?? OWNER_FILE;
  const now = options.now ?? Date.now();
  const token = options.token ?? randomUUID();
  const owner = {
    version: 1,
    token,
    pid: options.pid ?? process.pid,
    startedAt: now,
    startedAtIso: new Date(now).toISOString(),
    command: options.command ?? process.argv.join(" "),
  };

  fs.mkdirSync(path.dirname(lockDbPath), { recursive: true });
  fs.mkdirSync(path.dirname(ownerPath), { recursive: true });

  let db;
  try {
    db = new Database(lockDbPath, { timeout: options.timeoutMs ?? 0 });
    db.pragma("journal_mode = DELETE");
    db.exec("CREATE TABLE IF NOT EXISTS lease_guard (id INTEGER PRIMARY KEY CHECK (id = 1))");
    db.exec("BEGIN EXCLUSIVE");
  } catch (err) {
    try {
      db?.close();
    } catch {
      // The lock attempt already failed; preserve its useful error below.
    }
    if (isBusyError(err)) return { acquired: false, owner: readOwner(ownerPath) };
    throw err;
  }

  try {
    fs.writeFileSync(ownerPath, `${JSON.stringify(owner, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } finally {
      db.close();
    }
    throw err;
  }

  let released = false;
  return {
    acquired: true,
    owner,
    release() {
      if (released) return;
      released = true;
      try {
        db.exec("ROLLBACK");
      } finally {
        try {
          db.close();
        } finally {
          removeOwnedMetadata(ownerPath, token);
        }
      }
    },
  };
}

module.exports = {
  LOCK_DB,
  OWNER_FILE,
  acquireGateRunLease,
  readOwner,
  removeOwnedMetadata,
};
