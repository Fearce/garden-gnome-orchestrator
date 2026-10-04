import type Database from "better-sqlite3";
import type { Message, Thread, ThreadSummary } from "../types.js";

// In-memory copies of two small, hot tables, so the reads that run on every connect, every periodic
// sweep and every crash-log line stop going to disk.
//
// Why this matters here: `threads` is ~1k rows but ~900 pages, because each row carries a brief and a
// `stage_outputs` blob on overflow pages, and every listing walks them. Under this box's memory pressure
// those pages fall out of cache, and each listing becomes hundreds of random reads on the event loop —
// the 1-9s stalls in crash.log, whose stall profiles named `listThreads -> all` first (2026-09-26).
//
// Correctness does not depend on callers remembering to invalidate: TEMP triggers report every write this
// connection makes, whatever statement made it, and `PRAGMA data_version` reports any other connection's
// commit. Inside a transaction a mirror declines to answer, because it may hold rows that could still roll
// back or miss rows written a moment ago; the caller then reads SQLite directly.

/** Call `onWrite(key)` for every row this connection inserts, updates or deletes in `table`: a Db method,
 *  a raw statement in a migration or test, a foreign-key cascade, or another trigger (the one that stamps
 *  `threads.latest_message_preview` on each message). TEMP triggers belong to this connection only and
 *  are never written to the database file. */
function watchTableWrites(raw: Database.Database, table: string, keyColumn: string, onWrite: (key: string) => void): void {
  const fn = `ggo_${table}_written`;
  raw.function(fn, { deterministic: false }, (key: unknown) => {
    if (typeof key === "string") onWrite(key);
    return null;
  });
  raw.exec(`
    CREATE TEMP TRIGGER IF NOT EXISTS ggo_${table}_mirror_ai AFTER INSERT ON main.${table}
      BEGIN SELECT ${fn}(new.${keyColumn}); END;
    CREATE TEMP TRIGGER IF NOT EXISTS ggo_${table}_mirror_au AFTER UPDATE ON main.${table}
      BEGIN SELECT ${fn}(old.${keyColumn}); SELECT ${fn}(new.${keyColumn}) WHERE new.${keyColumn} IS NOT old.${keyColumn}; END;
    CREATE TEMP TRIGGER IF NOT EXISTS ggo_${table}_mirror_ad AFTER DELETE ON main.${table}
      BEGIN SELECT ${fn}(old.${keyColumn}); END;
  `);
}

/** Call `onDelete(threadId)` for every message this connection deletes: a retry reset, a task delete's
 *  cascade, a raw statement. Inserts, the hottest write in the database, fire nothing. */
export function watchMessageDeletes(raw: Database.Database, onDelete: (threadId: string) => void): void {
  raw.function("ggo_message_deleted", { deterministic: false }, (threadId: unknown) => {
    if (typeof threadId === "string") onDelete(threadId);
    return null;
  });
  raw.exec(`
    CREATE TEMP TRIGGER IF NOT EXISTS ggo_messages_deleted AFTER DELETE ON main.messages
      BEGIN SELECT ggo_message_deleted(old.thread_id); END;
  `);
}

/** Commits by another connection to the same file never fire this connection's triggers. */
class ForeignCommitWatch {
  private readonly version: Database.Statement;
  private seen: unknown = null;

  constructor(raw: Database.Database) {
    this.version = raw.prepare("PRAGMA data_version").pluck();
  }

  /** True on the first call, then whenever another connection has committed since the previous call. */
  changed(): boolean {
    const now = this.version.get();
    const changed = now !== this.seen;
    this.seen = now;
    return changed;
  }
}

/** One `threads` row in both shapes the listings return. `seq` is the rowid, i.e. insert order. */
export interface ListedThread {
  seq: number;
  thread: Thread;
  summary: ThreadSummary;
}

export interface ThreadListingReader {
  all(): ListedThread[];
  one(id: string): ListedThread | null;
}

const newestFirst = (a: ListedThread, b: ListedThread): number => b.thread.createdAt - a.thread.createdAt || b.seq - a.seq;

export class ThreadListingMirror {
  private readonly rows = new Map<string, ListedThread>();
  private readonly dirty = new Set<string>();
  private readonly foreign: ForeignCommitWatch;
  private ordered: ListedThread[] | null = null;

  constructor(
    private readonly raw: Database.Database,
    private readonly read: ThreadListingReader,
  ) {
    this.foreign = new ForeignCommitWatch(raw);
    watchTableWrites(raw, "threads", "id", (id) => this.dirty.add(id));
  }

  /** Every task, newest first (ties in insert order, newest first), or null inside a transaction. Treat
   *  the entries as read-only: they are shared with every other caller. */
  list(): readonly ListedThread[] | null {
    if (this.raw.inTransaction) return null;
    if (this.foreign.changed()) this.reload();
    else this.refreshDirty();
    return (this.ordered ??= [...this.rows.values()].sort(newestFirst));
  }

  private reload(): void {
    this.rows.clear();
    this.dirty.clear();
    for (const row of this.read.all()) this.rows.set(row.thread.id, row);
    this.ordered = null;
  }

  private refreshDirty(): void {
    if (!this.dirty.size) return;
    for (const id of this.dirty) {
      const row = this.read.one(id);
      if (row) this.rows.set(id, row);
      else this.rows.delete(id);
    }
    this.dirty.clear();
    this.ordered = null;
  }
}

/** `kv` holds ~120 settings-like values, a few of them 50-130KB (`office_names`, provider model lists),
 *  and many are re-read on every call of a hot path. A missing key is remembered as null too. */
export class KvMirror {
  private readonly values = new Map<string, string | null>();
  private readonly foreign: ForeignCommitWatch;

  constructor(
    private readonly raw: Database.Database,
    private readonly read: (key: string) => string | null,
  ) {
    this.foreign = new ForeignCommitWatch(raw);
    watchTableWrites(raw, "kv", "key", (key) => this.values.delete(key));
  }

  get(key: string): string | null {
    if (this.raw.inTransaction) return this.read(key);
    if (this.foreign.changed()) this.values.clear();
    if (this.values.has(key)) return this.values.get(key)!;
    const value = this.read(key);
    this.values.set(key, value);
    return value;
  }
}

/** One recorded tool call, as `ToolCallDigest` reads it. `seq` is the message rowid. */
export interface ToolCallRow {
  seq: number;
  role: Message["role"];
  content: string;
}

/** Per-task state folded from the task's recorded tool calls. Each read after the first reads only the
 *  calls recorded since the previous one, so asking every few seconds costs nothing once the task's
 *  history is folded. A deleted message (a retry reset deletes them all) or another connection's commit
 *  discards the folded state, and the next read starts again from the task's first call. Inside a
 *  transaction the read is uncached, because a rolled-back insert fires no delete trigger. Treat the
 *  returned state as read-only: it is the cached copy. */
export class ToolCallDigest<T> {
  private readonly folded = new Map<string, { seq: number; state: T }>();
  private readonly foreign: ForeignCommitWatch;

  constructor(
    private readonly raw: Database.Database,
    private readonly readAfter: (threadId: string, afterSeq: number) => ToolCallRow[],
    private readonly start: () => T,
    private readonly add: (state: T, call: ToolCallRow) => void,
  ) {
    this.foreign = new ForeignCommitWatch(raw);
  }

  read(threadId: string): T {
    if (this.raw.inTransaction) return this.fold({ seq: 0, state: this.start() }, threadId).state;
    if (this.foreign.changed()) this.folded.clear();
    const entry = this.fold(this.folded.get(threadId) ?? { seq: 0, state: this.start() }, threadId);
    this.folded.set(threadId, entry);
    return entry.state;
  }

  forget(threadId: string): void {
    this.folded.delete(threadId);
  }

  private fold(entry: { seq: number; state: T }, threadId: string): { seq: number; state: T } {
    for (const call of this.readAfter(threadId, entry.seq)) {
      this.add(entry.state, call);
      entry.seq = Math.max(entry.seq, call.seq);
    }
    return entry;
  }
}
