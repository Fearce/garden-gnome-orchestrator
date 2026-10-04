import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

// The memory corpus is a directory of Markdown files with a small frontmatter block — the format the
// Claude Code `/remember` and `/forget` commands, the PreCompact extractor and the memory audits already
// read and write. GGO keeps those files as the source of truth and builds everything else (the search
// index, the model-written retrieval cards) from them, so an index can always be rebuilt and nothing a
// person wrote lives only inside GGO's database.

/** Operational files that share the directory but are not memories (same list the recall hooks use). */
export const NON_MEMORY_FILES: ReadonlySet<string> = new Set(["MEMORY.md", "last-report.md", "extraction-log.md"]);
export const INDEX_FILE = "MEMORY.md";
/** Deleted memories are moved here rather than unlinked, so a mistaken delete is a file move away. */
export const TRASH_DIR = ".ggo-trash";
export const SAVED_SECTION = "## Saved from GGO";
export const REVIEW_SECTION = "## Auto-extracted (review pending)";
export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const LIST_ITEM = /^\s*-\s+(.*\S)\s*$/;
const KEY_VALUE = /^(\s*)([A-Za-z_][\w-]*):(.*)$/;
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}\.md$/;

export interface ParsedMemory {
  file: string;
  name: string;
  description: string;
  type: string;
  createdAt: string;
  lastVerified: string;
  source: string;
  /** Task phrasings the memory declares should summon it (`triggers:` list). */
  triggers: string[];
  /** Free-form topic tags (`tags:` list), indexed with the name. */
  tags: string[];
  related: string[];
  /** Everything after the frontmatter. */
  body: string;
}

export interface MemoryChunk {
  /** `head` carries the name, description and trigger phrases; `body` is a slice of the text. */
  kind: "head" | "body";
  text: string;
}

export function isMemoryFile(file: string): boolean {
  return SAFE_FILE.test(file) && !NON_MEMORY_FILES.has(file);
}

/** A caller-supplied file name, reduced to a bare memory file name or rejected. Never a path. */
export function safeMemoryFile(raw: string): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  const base = basename(trimmed.replace(/\\/g, "/"));
  const file = base.toLowerCase().endsWith(".md") ? base : `${base}.md`;
  return isMemoryFile(file) ? file : null;
}

export function parseMemory(file: string, text: string): ParsedMemory {
  const match = FRONTMATTER.exec(text);
  const { fields, lists } = parseFrontmatter(match ? match[1]! : "");
  const body = match ? text.slice(match[0].length) : text;
  const field = (key: string) => fields.get(key) ?? "";
  return {
    file,
    name: field("name") || field("title") || file.replace(/\.md$/i, ""),
    description: field("description"),
    type: field("type"),
    createdAt: field("created_at"),
    lastVerified: field("last_verified"),
    source: field("source"),
    triggers: lists.get("triggers") ?? [],
    tags: lists.get("tags") ?? [],
    related: lists.get("related") ?? [],
    body: body.trim(),
  };
}

/** Scalar fields and lists from a frontmatter block. The memories here write both `type: x` and the nested
 *  `metadata:` + `  type: x` form, and both `key: [a, b]` and block lists (`key:` then `  - a`); a
 *  top-level scalar wins over a nested one of the same name. */
function parseFrontmatter(frontmatter: string): { fields: Map<string, string>; lists: Map<string, string[]> } {
  const fields = new Map<string, string>();
  const nested = new Map<string, string>();
  const lists = new Map<string, string[]>();
  let block: string | null = null;
  for (const line of frontmatter.split(/\r?\n/)) {
    const item = LIST_ITEM.exec(line);
    if (item && block) {
      lists.set(block, [...(lists.get(block) ?? []), unquote(item[1]!)]);
      continue;
    }
    const pair = KEY_VALUE.exec(line);
    if (!pair) continue;
    const [, indent, key, raw] = pair as unknown as [string, string, string, string];
    const value = raw.trim();
    if (indent) {
      if (!nested.has(key)) nested.set(key, unquote(value));
      continue;
    }
    block = value ? null : key;
    if (value.startsWith("[")) lists.set(key, parseList(value));
    else fields.set(key, unquote(value));
  }
  for (const [key, value] of nested) if (!fields.get(key)) fields.set(key, value);
  return { fields, lists };
}

function unquote(value: string): string {
  const trimmed = value.trim();
  return /^(["']).*\1$/.test(trimmed) && trimmed.length >= 2 ? trimmed.slice(1, -1) : trimmed;
}

function parseList(value: string): string[] {
  const inner = value.trim().replace(/^\[|\]$/g, "");
  return inner.split(",").map(unquote).filter(Boolean);
}

/** The head chunk plus body slices on paragraph boundaries. Every body slice repeats the memory's name and
 *  description, so a section deep in a long file still carries the topic it belongs to. */
export function memoryChunks(memory: ParsedMemory, maxChars = 1600): MemoryChunk[] {
  const head = [memory.name, memory.description, ...memory.triggers, memory.tags.join(" ")].filter(Boolean).join("\n");
  const label = `${memory.name}\n${memory.description}`.trim();
  const chunks: MemoryChunk[] = [{ kind: "head", text: head }];
  const budget = Math.max(400, maxChars - label.length);
  let current = "";
  const flush = () => {
    if (current.trim()) chunks.push({ kind: "body", text: `${label}\n\n${current.trim()}` });
    current = "";
  };
  for (let paragraph of memory.body.split(/\r?\n\s*\r?\n/)) {
    while (paragraph.length > budget) {
      flush();
      current = paragraph.slice(0, budget);
      flush();
      paragraph = paragraph.slice(budget);
    }
    if (current && current.length + 2 + paragraph.length > budget) flush();
    current = current ? `${current}\n\n${paragraph}` : paragraph;
  }
  flush();
  return chunks;
}

export function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "memory";
}

export function today(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export interface NewMemory {
  name: string;
  description: string;
  type: MemoryType;
  body: string;
  triggers?: string[];
  /** Extra frontmatter lines, e.g. `source: auto-extracted`. Keys must be plain words. */
  extra?: Record<string, string>;
}

export function renderMemory(input: NewMemory, date = today()): string {
  const lines = [
    "---",
    `name: ${oneLine(input.name)}`,
    `description: ${oneLine(input.description)}`,
    `type: ${input.type}`,
    `created_at: ${date}`,
    `last_verified: ${date}`,
  ];
  for (const [key, value] of Object.entries(input.extra ?? {})) {
    if (/^[a-z_]+$/.test(key) && value.trim()) lines.push(`${key}: ${oneLine(value)}`);
  }
  const triggers = (input.triggers ?? []).map(oneLine).map((t) => t.replace(/:/g, " ")).filter(Boolean);
  if (triggers.length) lines.push("triggers:", ...triggers.map((t) => `  - ${t}`));
  lines.push("---", "", input.body.trim(), "");
  return lines.join("\n");
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export interface MemoryPatch {
  name?: string;
  description?: string;
  type?: MemoryType;
  body?: string;
}

/** Apply a patch while keeping every frontmatter line the patch does not own (related, triggers,
 *  source, custom keys) exactly as written, and stamp `last_verified`. */
export function patchMemoryText(text: string, patch: MemoryPatch, date = today()): string {
  const match = FRONTMATTER.exec(text);
  const body = patch.body !== undefined ? patch.body.trim() : (match ? text.slice(match[0].length) : text).trim();
  const owned: Record<string, string | undefined> = {
    name: patch.name !== undefined ? oneLine(patch.name) : undefined,
    description: patch.description !== undefined ? oneLine(patch.description) : undefined,
    type: patch.type,
    last_verified: date,
  };
  const lines = match ? match[1]!.split(/\r?\n/) : [];
  const seen = new Set<string>();
  const out = lines.map((line) => {
    const colon = line.indexOf(":");
    if (colon <= 0 || /^\s/.test(line)) return line;
    const key = line.slice(0, colon).trim();
    if (owned[key] === undefined) return line;
    seen.add(key);
    return `${key}: ${owned[key]}`;
  });
  for (const [key, value] of Object.entries(owned)) if (value !== undefined && !seen.has(key)) out.push(`${key}: ${value}`);
  return ["---", ...out, "---", "", body, ""].join("\n");
}

/** Insert a pointer line under `section` in the index text, creating the section at the end if needed. */
export function addIndexPointer(index: string, section: string, line: string, intro: string): string {
  if (index.includes(line)) return index;
  const at = index.indexOf(`\n${section}\n`);
  if (at < 0 && !index.startsWith(`${section}\n`)) return `${index.trimEnd()}\n\n${section}\n\n${intro}\n\n${line}\n`;
  const start = at < 0 ? 0 : at + 1;
  const afterHeading = start + section.length + 1;
  const next = index.indexOf("\n## ", afterHeading);
  const end = next < 0 ? index.length : next + 1;
  const sectionText = index.slice(start, end).trimEnd();
  return `${index.slice(0, start)}${sectionText}\n${line}\n${next < 0 ? "" : "\n"}${index.slice(end)}`;
}

/** Drop every index pointer that links to `file`. */
export function removeIndexPointers(index: string, file: string): string {
  const link = `](${file})`;
  return index.split("\n").filter((line) => !(line.trimStart().startsWith("- ") && line.includes(link))).join("\n");
}

/** Remove `file` from a memory's `related:` list, inline or block form; null when the list does not name it. */
export function dropRelated(text: string, file: string): string | null {
  const match = FRONTMATTER.exec(text);
  if (!match) return null;
  let changed = false;
  let inBlock = false;
  const lines: string[] = [];
  for (const line of match[1]!.split(/\r?\n/)) {
    const item = LIST_ITEM.exec(line);
    if (inBlock && item) {
      if (unquote(item[1]!) === file) changed = true;
      else lines.push(line);
      continue;
    }
    inBlock = /^related:\s*$/.test(line);
    const items = !inBlock && line.startsWith("related:") ? parseList(line.slice("related:".length)) : null;
    const kept = items?.filter((entry) => entry !== file);
    if (items && kept && kept.length !== items.length) {
      changed = true;
      lines.push(`related: [${kept.join(", ")}]`);
    } else lines.push(line);
  }
  if (!changed) return null;
  return `---\n${lines.join("\n")}\n---\n${text.slice(match[0].length)}`;
}

/** File access for one memory directory. Every write is a temp file + rename, so a reader (a recall hook,
 *  the index worker, another agent) never sees half a memory. */
export class MemoryCorpus {
  constructor(readonly dir: string) {}

  async listFiles(): Promise<string[]> {
    try {
      return (await readdir(this.dir)).filter(isMemoryFile).sort();
    } catch {
      return [];
    }
  }

  async read(file: string): Promise<string | null> {
    const safe = safeMemoryFile(file);
    if (!safe) return null;
    try {
      return await readFile(join(this.dir, safe), "utf8");
    } catch {
      return null;
    }
  }

  async create(input: NewMemory, section = SAVED_SECTION, intro = SAVED_INTRO): Promise<string> {
    await mkdir(this.dir, { recursive: true });
    const base = `${input.type}_${slugify(input.name)}`;
    const text = renderMemory(input);
    for (let n = 1; n < 500; n++) {
      const file = n === 1 ? `${base}.md` : `${base}_${n}.md`;
      try {
        await writeFile(join(this.dir, file), text, { encoding: "utf8", flag: "wx" });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw err;
      }
      await this.editIndex((index) => addIndexPointer(index, section, `- [${oneLine(input.name)}](${file}) — ${oneLine(input.description)}`, intro));
      return file;
    }
    throw new Error(`Could not find a free file name for ${base}.md`);
  }

  async update(file: string, patch: MemoryPatch): Promise<boolean> {
    const safe = safeMemoryFile(file);
    const text = safe ? await this.read(safe) : null;
    if (!safe || text == null) return false;
    await this.writeAtomic(join(this.dir, safe), patchMemoryText(text, patch));
    return true;
  }

  /** Move the memory into the trash, then drop its index pointer and the `related:` links to it. */
  async remove(file: string): Promise<string | null> {
    const safe = safeMemoryFile(file);
    if (!safe) return null;
    const from = join(this.dir, safe);
    try {
      if (!(await stat(from)).isFile()) return null;
    } catch {
      return null;
    }
    const trash = join(this.dir, TRASH_DIR);
    await mkdir(trash, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const to = join(trash, `${stamp}_${safe}`);
    await rename(from, to);
    await this.editIndex((index) => removeIndexPointers(index, safe));
    for (const other of await this.listFiles()) {
      const text = await this.read(other);
      const next = text == null ? null : dropRelated(text, safe);
      if (next != null) await this.writeAtomic(join(this.dir, other), next);
    }
    return to;
  }

  async editIndex(edit: (index: string) => string): Promise<void> {
    const path = join(this.dir, INDEX_FILE);
    let index = "";
    try {
      index = await readFile(path, "utf8");
    } catch {
      index = "# Memory index\n";
    }
    const next = edit(index);
    if (next !== index) await this.writeAtomic(path, next);
  }

  async appendLog(file: string, block: string, header: string): Promise<void> {
    const path = join(this.dir, file);
    let current = "";
    try {
      current = await readFile(path, "utf8");
    } catch {
      current = header;
    }
    await this.writeAtomic(path, `${current.trimEnd()}\n${block}`);
  }

  private async writeAtomic(path: string, text: string): Promise<void> {
    const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(temp, text, "utf8");
    await rename(temp, path);
  }
}

const SAVED_INTRO = "Memories saved through GGO (agents' `remember_memory` tool and Settings → Memory). Move a row to its proper section once you have reviewed it.";
