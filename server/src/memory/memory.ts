import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { config } from "../config.js";

export interface MemorySearchHit {
  name: string;
  description: string;
  path: string;
  score: number;
}

export interface MemoryService {
  search(query: string, k?: number): Promise<MemorySearchHit[]>;
  /** Full content of one memory file by its frontmatter name, filename, or path. Scoped to the memory dir. */
  read(nameOrPath: string): string | null;
  index(): string;
}

const STOP = new Set([
  "the", "a", "an", "and", "or", "to", "of", "in", "on", "for", "is", "are", "be",
  "with", "this", "that", "it", "as", "at", "by", "from", "we", "i", "you", "do",
  "if", "so", "but", "not", "no", "my", "me", "our", "your",
]);

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOP.has(t));
}

interface MemoryDoc {
  name: string;
  description: string;
  path: string;
  haystack: Set<string>;
}

/**
 * Lexical search over the user's global memory dir. Dependency-free (no pgvector /
 * Ollama call to guess), so it degrades gracefully if those are down: reads the
 * markdown memory files, parses frontmatter name/description, and ranks by token
 * overlap. The director can then Read specific files for full detail.
 */
export class FileMemoryService implements MemoryService {
  private cache: { at: number; docs: MemoryDoc[] } | null = null;
  private readonly ttlMs = 60_000;

  constructor(private readonly dir: string = config.memoryDir) {}

  index(): string {
    const p = join(this.dir, "MEMORY.md");
    if (!existsSync(p)) return "(no MEMORY.md index found)";
    const text = readFileSync(p, "utf8");
    return text.length > 8000 ? text.slice(0, 8000) + "\n…(truncated)" : text;
  }

  async search(query: string, k = 6): Promise<MemorySearchHit[]> {
    const docs = this.load();
    const terms = tokenize(query);
    if (!terms.length) return [];
    const scored = docs.map((d) => {
      let score = 0;
      for (const t of terms) {
        if (d.haystack.has(t)) score += 1;
        if (d.name.includes(t)) score += 1; // name match is a strong signal
      }
      return { name: d.name, description: d.description, path: d.path, score };
    });
    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  read(nameOrPath: string): string | null {
    const raw = (nameOrPath ?? "").trim();
    if (!raw) return null;
    // 1) exact frontmatter-name match (what search_memory returns as `name`).
    const byName = this.load().find((d) => d.name === raw);
    if (byName) return readSafe(byName.path);
    // 2) treat as a filename: strip to basename + safe chars so it can't escape the memory dir.
    const base = basename(raw).replace(/\.md$/i, "").replace(/[^a-z0-9_-]/gi, "");
    if (!base) return null;
    const p = join(this.dir, `${base}.md`);
    if (existsSync(p) && statSync(p).isFile()) return readSafe(p);
    return null;
  }

  private load(): MemoryDoc[] {
    const now = Date.now();
    if (this.cache && now - this.cache.at < this.ttlMs) return this.cache.docs;
    const docs: MemoryDoc[] = [];
    if (existsSync(this.dir)) {
      for (const entry of readdirSync(this.dir)) {
        if (!entry.endsWith(".md")) continue;
        if (entry === "MEMORY.md" || entry.startsWith("ARCHIVE")) continue;
        const path = join(this.dir, entry);
        try {
          if (!statSync(path).isFile()) continue;
          const body = readFileSync(path, "utf8");
          const description = matchFrontmatter(body, "description") ?? "";
          const name = matchFrontmatter(body, "name") ?? entry.replace(/\.md$/, "");
          const haystack = new Set([...tokenize(name), ...tokenize(description), ...tokenize(body.slice(0, 1200))]);
          docs.push({ name, description, path, haystack });
        } catch {
          /* skip unreadable file */
        }
      }
    }
    this.cache = { at: now, docs };
    return docs;
  }
}

function readSafe(path: string): string | null {
  try {
    const body = readFileSync(path, "utf8");
    return body.length > 20000 ? body.slice(0, 20000) + "\n…(truncated)" : body;
  } catch {
    return null;
  }
}

function matchFrontmatter(body: string, key: string): string | null {
  const m = body.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return m && m[1] ? m[1].trim() : null;
}
