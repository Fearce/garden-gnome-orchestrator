import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { isMemoryFile, memoryChunks, parseMemory, type ParsedMemory } from "./corpus.js";

// The derived search index over the memory directory. It is synchronous (better-sqlite3) and is only ever
// opened inside the memory worker thread, never on the server's event loop. Deleting the file loses
// nothing a model did not produce: the next sync rebuilds every chunk, and only the retrieval cards (the
// model-written paraphrases) have to be generated again.

const SCHEMA_VERSION = "2";
const KIND_WEIGHT: Record<string, number> = { head: 1.25, card: 1.0, body: 1.0 };
const TRIGGER_BONUS = 0.6;
const EXCERPT_CHARS = 700;
const STOP = new Set(
  ("a about after again all also am an and any are as at be because been before being both but by can could did do does doing done " +
    "down during each few for from further had has have having he her here hers him his how i if in into is it its itself just let " +
    "like make me more most my no nor not now of off on once only or other our ours out over own please same she should so some " +
    "such than that the their theirs them then there these they this those through to too under until up us very was we were what " +
    "when where which while who whom why will with would you your yours").split(" "),
);

export interface IndexedFile {
  file: string;
  name: string;
  description: string;
  type: string;
  createdAt: string;
  lastVerified: string;
  source: string;
  size: number;
  mtimeMs: number;
}

export interface SearchCandidate extends IndexedFile {
  /** Lexical relevance, higher is better; comparable only within one query. */
  score: number;
  /** Share of the query's terms that appear anywhere in this memory, 0..1. */
  coverage: number;
  /** The query matched one of the memory's declared trigger phrases. */
  triggerHit: boolean;
  excerpt: string;
}

export interface SyncResult {
  files: number;
  added: number;
  changed: number;
  removed: number;
  ms: number;
}

export interface CardJob {
  file: string;
  hash: string;
  name: string;
  description: string;
  triggers: string[];
  body: string;
}

export interface CardInput {
  file: string;
  hash: string;
  text: string;
  model: string;
}

export interface UsageRecord {
  provider: "claude" | "codex";
  model: string;
  purpose: string;
  inputTokens: number;
  outputTokens: number;
  ok: boolean;
}

export interface UsageSummary {
  provider: string;
  model: string;
  purpose: string;
  calls: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
}

export interface IndexStatus {
  files: number;
  chunks: number;
  cards: number;
  staleCards: number;
  missingCards: number;
  lastSyncAt: number | null;
  usageToday: UsageSummary[];
  usage7d: UsageSummary[];
}

export function queryTerms(text: string): string[] {
  const seen = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 2 || STOP.has(raw) || /^\d+$/.test(raw) && raw.length < 3) continue;
    seen.add(raw);
    if (seen.size >= 48) break;
  }
  return [...seen];
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

export class MemoryIndexStore {
  private readonly db: Database.Database;
  private triggers: Array<{ file: string; terms: string[] }> | null = null;

  constructor(dbPath: string, private readonly memoryDir: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.migrate();
  }

  close(): void {
    if (this.db.open) this.db.close();
  }

  /** Bring the index in line with the directory: new and edited files are re-chunked, vanished files
   *  are dropped. Unchanged files cost one stat each. */
  sync(force = false): SyncResult {
    const started = Date.now();
    const known = new Map<string, { mtime: number; size: number; hash: string }>();
    for (const row of this.db.prepare("SELECT file, mtime_ms, size, hash FROM files").all() as Array<{ file: string; mtime_ms: number; size: number; hash: string }>) {
      known.set(row.file, { mtime: row.mtime_ms, size: row.size, hash: row.hash });
    }
    let entries: string[] = [];
    try {
      entries = readdirSync(this.memoryDir).filter(isMemoryFile);
    } catch {
      entries = [];
    }
    const present = new Set<string>();
    let added = 0;
    let changed = 0;
    const apply = this.db.transaction((work: Array<() => void>) => work.forEach((step) => step()));
    const work: Array<() => void> = [];
    for (const file of entries) {
      let stats;
      try {
        stats = statSync(join(this.memoryDir, file));
      } catch {
        continue;
      }
      if (!stats.isFile()) continue;
      present.add(file);
      const prior = known.get(file);
      if (!force && prior && prior.mtime === stats.mtimeMs && prior.size === stats.size) continue;
      let text: string;
      try {
        text = readFileSync(join(this.memoryDir, file), "utf8");
      } catch {
        continue;
      }
      const hash = hashText(text);
      if (!force && prior && prior.hash === hash) {
        work.push(() => this.db.prepare("UPDATE files SET mtime_ms = ?, size = ? WHERE file = ?").run(stats.mtimeMs, stats.size, file));
        continue;
      }
      if (prior) changed++;
      else added++;
      const parsed = parseMemory(file, text);
      work.push(() => this.writeFile(parsed, hash, stats.mtimeMs, stats.size));
    }
    const gone = [...known.keys()].filter((file) => !present.has(file));
    for (const file of gone) work.push(() => this.dropFile(file, true));
    if (work.length) {
      apply(work);
      this.triggers = null;
    }
    this.db.prepare("INSERT INTO meta(key, value) VALUES('last_sync_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(Date.now()));
    return { files: present.size, added, changed, removed: gone.length, ms: Date.now() - started };
  }

  search(query: string, limit = 20): SearchCandidate[] {
    const terms = queryTerms(query);
    if (!terms.length) return [];
    const match = terms.map((term) => `"${term.replace(/"/g, "")}"`).join(" OR ");
    const rows = this.db
      .prepare(
        `SELECT c.file AS file, c.kind AS kind, c.text AS text, bm25(chunks_fts) AS rank
           FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid
          WHERE chunks_fts MATCH ? ORDER BY rank LIMIT 600`,
      )
      .all(match) as Array<{ file: string; kind: string; text: string; rank: number }>;
    const best = new Map<string, { score: number; excerpt: string | null; terms: Set<string> }>();
    for (const row of rows) {
      const score = -row.rank * (KIND_WEIGHT[row.kind] ?? 1);
      const entry = best.get(row.file) ?? { score: 0, excerpt: null, terms: new Set<string>() };
      entry.score = Math.max(entry.score, score);
      if (row.kind === "body" && entry.excerpt == null) entry.excerpt = row.text;
      const lower = row.text.toLowerCase();
      for (const term of terms) if (lower.includes(term)) entry.terms.add(term);
      best.set(row.file, entry);
    }
    const triggerFiles = this.triggerMatches(terms);
    const top = best.size ? Math.max(...[...best.values()].map((entry) => entry.score)) : 1;
    for (const file of triggerFiles) {
      const entry = best.get(file) ?? { score: 0, excerpt: null, terms: new Set<string>() };
      entry.score += top * TRIGGER_BONUS;
      best.set(file, entry);
    }
    const ranked = [...best.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, limit);
    const fileRow = this.db.prepare("SELECT * FROM files WHERE file = ?");
    const firstBody = this.db.prepare("SELECT text FROM chunks WHERE file = ? AND kind = 'body' ORDER BY seq LIMIT 1");
    const out: SearchCandidate[] = [];
    for (const [file, entry] of ranked) {
      const row = fileRow.get(file) as FileRow | undefined;
      if (!row) continue;
      const excerpt = entry.excerpt ?? (firstBody.get(file) as { text: string } | undefined)?.text ?? "";
      out.push({
        ...toIndexedFile(row),
        score: Math.round(entry.score * 1000) / 1000,
        coverage: Math.round((entry.terms.size / terms.length) * 1000) / 1000,
        triggerHit: triggerFiles.has(file),
        excerpt: trimExcerpt(excerpt, row.name, row.description),
      });
    }
    return out;
  }

  file(file: string): IndexedFile | null {
    const row = this.db.prepare("SELECT * FROM files WHERE file = ?").get(file) as FileRow | undefined;
    return row ? toIndexedFile(row) : null;
  }

  /** Memories by frontmatter name or file stem, for read-by-name. */
  findByName(name: string): string | null {
    const row = this.db.prepare("SELECT file FROM files WHERE name = ? OR file = ? OR file = ? LIMIT 1").get(name, name, `${name}.md`) as { file: string } | undefined;
    return row?.file ?? null;
  }

  list(offset: number, limit: number, filter = ""): { total: number; files: IndexedFile[] } {
    const like = `%${filter.replace(/[%_]/g, "")}%`;
    const where = filter ? "WHERE name LIKE ? OR description LIKE ? OR file LIKE ?" : "";
    const params = filter ? [like, like, like] : [];
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM files ${where}`).get(...params) as { n: number }).n;
    const rows = this.db.prepare(`SELECT * FROM files ${where} ORDER BY mtime_ms DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as FileRow[];
    return { total, files: rows.map(toIndexedFile) };
  }

  /** Memories whose current text has no retrieval card yet (or only a card for an older text). */
  cardJobs(limit: number, exclude: readonly string[] = []): CardJob[] {
    const skip = new Set(exclude);
    const rows = (this.db
      .prepare(
        `SELECT f.file, f.hash FROM files f LEFT JOIN cards c ON c.file = f.file
          WHERE c.file IS NULL OR c.hash <> f.hash ORDER BY (c.file IS NULL) DESC, f.mtime_ms DESC LIMIT ?`,
      )
      .all(limit + skip.size) as Array<{ file: string; hash: string }>).filter((row) => !skip.has(row.file)).slice(0, limit);
    const jobs: CardJob[] = [];
    for (const row of rows) {
      let text: string;
      try {
        text = readFileSync(join(this.memoryDir, row.file), "utf8");
      } catch {
        continue;
      }
      if (hashText(text) !== row.hash) continue;
      const parsed = parseMemory(row.file, text);
      jobs.push({ file: row.file, hash: row.hash, name: parsed.name, description: parsed.description, triggers: parsed.triggers, body: parsed.body });
    }
    return jobs;
  }

  storeCards(cards: CardInput[]): number {
    const current = this.db.prepare("SELECT hash FROM files WHERE file = ?");
    let stored = 0;
    this.db.transaction(() => {
      for (const card of cards) {
        const row = current.get(card.file) as { hash: string } | undefined;
        if (!row || row.hash !== card.hash || !card.text.trim()) continue;
        this.db
          .prepare("INSERT INTO cards(file, hash, text, model, created_at) VALUES(?, ?, ?, ?, ?) ON CONFLICT(file) DO UPDATE SET hash = excluded.hash, text = excluded.text, model = excluded.model, created_at = excluded.created_at")
          .run(card.file, card.hash, card.text.trim(), card.model, Date.now());
        this.deleteChunks(card.file, "card");
        this.insertChunk(card.file, "card", 0, card.text.trim());
        stored++;
      }
    })();
    return stored;
  }

  recordUsage(record: UsageRecord): void {
    const day = new Date().toISOString().slice(0, 10);
    this.db
      .prepare(
        `INSERT INTO usage(day, provider, model, purpose, calls, failures, input_tokens, output_tokens) VALUES(?, ?, ?, ?, 1, ?, ?, ?)
         ON CONFLICT(day, provider, model, purpose) DO UPDATE SET calls = calls + 1, failures = failures + excluded.failures,
           input_tokens = input_tokens + excluded.input_tokens, output_tokens = output_tokens + excluded.output_tokens`,
      )
      .run(day, record.provider, record.model, record.purpose, record.ok ? 0 : 1, Math.max(0, Math.round(record.inputTokens)), Math.max(0, Math.round(record.outputTokens)));
  }

  status(): IndexStatus {
    const count = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    const lastSync = this.db.prepare("SELECT value FROM meta WHERE key = 'last_sync_at'").get() as { value: string } | undefined;
    const today = new Date().toISOString().slice(0, 10);
    const weekAgo = new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10);
    return {
      files: count("SELECT COUNT(*) AS n FROM files"),
      chunks: count("SELECT COUNT(*) AS n FROM chunks"),
      cards: count("SELECT COUNT(*) AS n FROM cards c JOIN files f ON f.file = c.file AND f.hash = c.hash"),
      staleCards: count("SELECT COUNT(*) AS n FROM cards c JOIN files f ON f.file = c.file AND f.hash <> c.hash"),
      missingCards: count("SELECT COUNT(*) AS n FROM files f LEFT JOIN cards c ON c.file = f.file WHERE c.file IS NULL"),
      lastSyncAt: lastSync ? Number(lastSync.value) : null,
      usageToday: this.usageSince(today),
      usage7d: this.usageSince(weekAgo),
    };
  }

  private usageSince(day: string): UsageSummary[] {
    return this.db
      .prepare(
        `SELECT provider, model, purpose, SUM(calls) AS calls, SUM(failures) AS failures, SUM(input_tokens) AS inputTokens,
                SUM(output_tokens) AS outputTokens FROM usage WHERE day >= ? GROUP BY provider, model, purpose ORDER BY provider, purpose`,
      )
      .all(day) as UsageSummary[];
  }

  private triggerMatches(queryTermList: string[]): Set<string> {
    if (!this.triggers) {
      const rows = this.db.prepare("SELECT file, phrase FROM triggers").all() as Array<{ file: string; phrase: string }>;
      this.triggers = rows.map((row) => ({ file: row.file, terms: queryTerms(row.phrase) })).filter((t) => t.terms.length >= 2);
    }
    const query = new Set(queryTermList);
    const hits = new Set<string>();
    for (const trigger of this.triggers) if (trigger.terms.every((term) => query.has(term))) hits.add(trigger.file);
    return hits;
  }

  private writeFile(memory: ParsedMemory, hash: string, mtimeMs: number, size: number): void {
    this.dropFile(memory.file, false);
    this.db
      .prepare(
        `INSERT INTO files(file, hash, mtime_ms, size, name, description, type, created_at, last_verified, source, indexed_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(memory.file, hash, mtimeMs, size, memory.name, memory.description, memory.type, memory.createdAt, memory.lastVerified, memory.source, Date.now());
    memoryChunks(memory).forEach((chunk, seq) => this.insertChunk(memory.file, chunk.kind, seq, chunk.text));
    const card = this.db.prepare("SELECT text FROM cards WHERE file = ?").get(memory.file) as { text: string } | undefined;
    if (card) this.insertChunk(memory.file, "card", 0, card.text);
    const addTrigger = this.db.prepare("INSERT INTO triggers(file, phrase) VALUES(?, ?)");
    for (const phrase of memory.triggers) addTrigger.run(memory.file, phrase);
  }

  /** Remove a file's rows. A card survives an edit (it is regenerated in the background and keeps the
   *  memory findable by paraphrase meanwhile) but not a deletion. */
  private dropFile(file: string, deleted: boolean): void {
    this.deleteChunks(file, null);
    this.db.prepare("DELETE FROM triggers WHERE file = ?").run(file);
    this.db.prepare("DELETE FROM files WHERE file = ?").run(file);
    if (deleted) this.db.prepare("DELETE FROM cards WHERE file = ?").run(file);
  }

  private insertChunk(file: string, kind: string, seq: number, text: string): void {
    const id = this.db.prepare("INSERT INTO chunks(file, kind, seq, text) VALUES(?, ?, ?, ?)").run(file, kind, seq, text).lastInsertRowid;
    this.db.prepare("INSERT INTO chunks_fts(rowid, text) VALUES(?, ?)").run(id, text);
  }

  private deleteChunks(file: string, kind: string | null): void {
    const rows = (kind
      ? this.db.prepare("SELECT id, text FROM chunks WHERE file = ? AND kind = ?").all(file, kind)
      : this.db.prepare("SELECT id, text FROM chunks WHERE file = ?").all(file)) as Array<{ id: number; text: string }>;
    const ftsDelete = this.db.prepare("INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', ?, ?)");
    const rowDelete = this.db.prepare("DELETE FROM chunks WHERE id = ?");
    for (const row of rows) {
      ftsDelete.run(row.id, row.text);
      rowDelete.run(row.id);
    }
  }

  private migrate(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const version = this.db.prepare("SELECT value FROM meta WHERE key = 'schema'").get() as { value: string } | undefined;
    if (version && version.value !== SCHEMA_VERSION) {
      // Cards and usage are kept across a schema change; only the derived rows are rebuilt.
      this.db.exec("DROP TABLE IF EXISTS chunks_fts; DROP TABLE IF EXISTS chunks; DROP TABLE IF EXISTS triggers; DROP TABLE IF EXISTS files;");
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files(
        file TEXT PRIMARY KEY, hash TEXT NOT NULL, mtime_ms REAL NOT NULL, size INTEGER NOT NULL, name TEXT NOT NULL,
        description TEXT NOT NULL, type TEXT NOT NULL, created_at TEXT NOT NULL, last_verified TEXT NOT NULL,
        source TEXT NOT NULL, indexed_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS chunks(id INTEGER PRIMARY KEY, file TEXT NOT NULL, kind TEXT NOT NULL, seq INTEGER NOT NULL, text TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS chunks_file ON chunks(file, kind);
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text, content='chunks', content_rowid='id', tokenize='porter unicode61');
      CREATE TABLE IF NOT EXISTS triggers(file TEXT NOT NULL, phrase TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS triggers_file ON triggers(file);
      CREATE TABLE IF NOT EXISTS cards(file TEXT PRIMARY KEY, hash TEXT NOT NULL, text TEXT NOT NULL, model TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS usage(
        day TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, purpose TEXT NOT NULL, calls INTEGER NOT NULL,
        failures INTEGER NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
        PRIMARY KEY(day, provider, model, purpose));
    `);
    this.db.prepare("INSERT INTO meta(key, value) VALUES('schema', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(SCHEMA_VERSION);
  }
}

interface FileRow {
  file: string;
  name: string;
  description: string;
  type: string;
  created_at: string;
  last_verified: string;
  source: string;
  size: number;
  mtime_ms: number;
}

function toIndexedFile(row: FileRow): IndexedFile {
  return {
    file: row.file,
    name: row.name,
    description: row.description,
    type: row.type,
    createdAt: row.created_at,
    lastVerified: row.last_verified,
    source: row.source,
    size: row.size,
    mtimeMs: row.mtime_ms,
  };
}

/** A body chunk minus the name/description header it carries for indexing, capped for a prompt. */
function trimExcerpt(text: string, name: string, description: string): string {
  const header = `${name}\n${description}`.trim();
  const body = text.startsWith(header) ? text.slice(header.length).trim() : text;
  return body.length > EXCERPT_CHARS ? `${body.slice(0, EXCERPT_CHARS).trimEnd()}…` : body;
}
