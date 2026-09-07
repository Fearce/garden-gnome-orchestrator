import { createHash, randomUUID } from "node:crypto";
import { lstat, realpath, readdir, open, rename, unlink, link } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { Db } from "../db/db.js";
import { resolveRepoRoot, runGit } from "../gitService.js";

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
const SKIP = new Set([".git", "node_modules", "dist", "build", "vendor", ".next", ".venv", "__pycache__"]);
export class IdeError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); }
}
export interface IdeWorkspace { id: string; path: string; name: string; tasks: { id: string; title: string }[] }
export interface IdeFile { path: string; text: string; version: string }
const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";

/** Reject aliases as well as traversal: NTFS streams, device names, trailing dots/spaces,
 * symlinks/junctions and Git internals must never become an alternate filesystem route. */
export function pathParts(path: string, allowRoot = false): string[] {
  if (allowRoot && path === "") return [];
  if (!path || path.length > 2000 || /[\\:\x00-\x1f]/.test(path)) throw new IdeError("Use a relative path with forward slashes.");
  const parts = path.split("/");
  if (parts.some(p => !p || p === "." || p === ".." || /[. ]$/.test(p) || p.toLowerCase() === ".git" || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p))) {
    throw new IdeError("That path is not an editable workspace path.");
  }
  return parts;
}

export class IdeService {
  private writes = new Map<string, Promise<unknown>>();
  private roots = new Map<string, { source: string; workspace: IdeWorkspace }>();
  constructor(private readonly db: Pick<Db, "listThreads" | "listCoworkSessions" | "kvGet">, private readonly self: string) {}

  private registered() {
    let recent: string[] = [];
    try { const value: unknown = JSON.parse(this.db.kvGet("setting_recent_repos") ?? "[]"); if (Array.isArray(value)) recent = value.filter((p): p is string => typeof p === "string"); } catch { /* no recent entries */ }
    const threads = this.db.listThreads();
    const paths = [...new Set([this.self, ...recent, ...threads.map(t => t.workspace), ...this.db.listCoworkSessions().map(s => s.workspace)].filter(Boolean))];
    return { paths, threads };
  }

  /** Only registered workspaces. A request cannot nominate an arbitrary directory. */
  async workspaces(): Promise<IdeWorkspace[]> {
    const { paths, threads } = this.registered();
    const result = new Map<string, IdeWorkspace>();
    for (const path of paths) {
      try {
        const root = await realpath(path);
        if (!(await lstat(root)).isDirectory()) continue;
        const id = hash(process.platform === "win32" ? root.toLowerCase() : root).slice(0, 24);
        if (!result.has(id)) result.set(id, { id, path: root, name: basename(root), tasks: threads.filter(t => resolve(t.workspace) === resolve(path)).map(t => ({ id: t.id, title: t.title })) });
        this.roots.set(id, { source: path, workspace: result.get(id)! });
      } catch { /* stale registered path */ }
    }
    for (const id of this.roots.keys()) if (!result.has(id)) this.roots.delete(id);
    return [...result.values()];
  }

  async workspace(id: string): Promise<IdeWorkspace> {
    const cached = this.roots.get(id);
    if (cached && this.registered().paths.includes(cached.source)) {
      // Revalidate the selected root and registration on EVERY request. Cached identity saves
      // statting every other task workspace, without retaining access to a revoked/moved root.
      try {
        if (await realpath(cached.source) === cached.workspace.path && (await lstat(cached.workspace.path)).isDirectory()) return cached.workspace;
      } catch { /* refresh stale root mapping below */ }
    }
    const ws = (await this.workspaces()).find(w => w.id === id);
    if (!ws) throw new IdeError("Workspace is no longer registered in GGO.", 403);
    return ws;
  }

  private async confined(root: string, path: string, newFile = false): Promise<string> {
    const parts = pathParts(path, true);
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      current = join(current, parts[i]!);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink()) throw new IdeError("Linked files and folders cannot be opened in the IDE.", 403);
        if (i < parts.length - 1 && !info.isDirectory()) throw new IdeError("Parent is not a folder.");
      } catch (e) { if (!(newFile && i === parts.length - 1 && missing(e))) throw e; }
    }
    const rel = relative(root, current);
    if (rel === ".." || rel.startsWith(`..${sep}`)) throw new IdeError("Path escapes workspace.", 403);
    return current;
  }

  async tree(id: string, path: string) {
    const ws = await this.workspace(id);
    const directory = await this.confined(ws.path, path);
    const entries = await readdir(directory, { withFileTypes: true });
    const visible = entries.filter(e => e.name.toLowerCase() !== ".git" && !e.isSymbolicLink() && (e.isFile() || e.isDirectory())).sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    return { entries: visible.slice(0, 2000).map(e => ({ name: e.name, path: [path, e.name].filter(Boolean).join("/"), directory: e.isDirectory() })), truncated: visible.length > 2000 };
  }

  private async readAt(root: string, path: string): Promise<IdeFile> {
    pathParts(path);
    const target = await this.confined(root, path);
    const file = await open(target, "r");
    try {
      const info = await file.stat();
      if (!info.isFile()) throw new IdeError("Only regular text files can be edited.");
      if (info.nlink > 1) throw new IdeError("Hard-linked files cannot be edited.", 403);
      if (info.size > MAX_FILE_BYTES) throw new IdeError("File exceeds the 2 MB editor limit.", 413);
      // Proportional allocation matters when search walks thousands of tiny source files.
      // The spare byte detects growth; stat detects shrink/replacement during the read.
      const data = Buffer.alloc(info.size + 1);
      const { bytesRead } = await file.read(data, 0, data.length, 0);
      if (bytesRead > MAX_FILE_BYTES) throw new IdeError("File exceeds the 2 MB editor limit.", 413);
      const after = await file.stat();
      const named = await lstat(target);
      const resolved = await realpath(target);
      const samePath = process.platform === "win32" ? resolved.toLowerCase() === target.toLowerCase() : resolved === target;
      if (!samePath || named.isSymbolicLink() || named.ino !== info.ino || named.dev !== info.dev) throw new IdeError("File path changed while reading. Refresh the explorer.", 409);
      if (bytesRead !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new IdeError("File changed while reading. Retry after the other writer finishes.", 409);
      const bytes = data.subarray(0, bytesRead);
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw new IdeError("This file is not UTF-8 text. Open it in a desktop editor.", 415); }
      if (text.includes("\0")) throw new IdeError("Binary files cannot be edited.", 415);
      return { path, text, version: hash(bytes) };
    } finally { await file.close(); }
  }

  async read(id: string, path: string) { return this.readAt((await this.workspace(id)).path, path); }

  async save(id: string, path: string, text: string, version: string | null): Promise<IdeFile> {
    pathParts(path);
    if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) throw new IdeError("File exceeds the 2 MB editor limit.", 413);
    if (text.includes("\0")) throw new IdeError("Binary content cannot be saved.");
    const ws = await this.workspace(id);
    const target = await this.confined(ws.path, path, true);
    const key = process.platform === "win32" ? target.toLowerCase() : target;
    const prior = this.writes.get(key) ?? Promise.resolve();
    const operation = prior.catch(() => {}).then(async () => {
      const check = async () => {
        await this.confined(ws.path, path, true);
        try {
          const current = await this.readAt(ws.path, path);
          if (current.version !== version) throw new IdeError("File changed on disk. Compare or reload it before saving; your draft is intact.", 409);
        } catch (e) {
          if (missing(e) && version === null) return;
          if (missing(e)) throw new IdeError("File was removed on disk. Your draft is intact.", 409);
          throw e;
        }
      };
      await check();
      const mode = version === null ? 0o600 : (await lstat(target)).mode;
      const temp = join(dirname(target), `.ggo-save-${randomUUID()}`);
      try {
        const handle = await open(temp, "wx", mode);
        try { await handle.writeFile(text, "utf8"); await handle.sync(); } finally { await handle.close(); }
        await check();
        // Creation is exclusive; existing files use atomic replacement. Never truncate the original.
        if (version === null) await link(temp, target);
        else await rename(temp, target);
        return { path, text, version: hash(text) };
      } finally { await unlink(temp).catch(() => {}); }
    });
    this.writes.set(key, operation);
    try { return await operation; } finally { if (this.writes.get(key) === operation) this.writes.delete(key); }
  }

  async search(id: string, query: string, content: boolean) {
    const ws = await this.workspace(id);
    if (!query.trim() || query.length > 200) throw new IdeError("Search needs 1–200 characters.");
    const hits: { path: string; line?: number; preview?: string }[] = [];
    const queue = [""];
    const needle = query.toLowerCase();
    const deadline = Date.now() + 4000;
    let scanned = 0, bytes = 0, skipped = 0;
    while (queue.length && hits.length < 200 && scanned < 10000 && bytes < 20 * MAX_FILE_BYTES && Date.now() < deadline) {
      const dir = queue.shift()!;
      let entries;
      try { entries = await readdir(await this.confined(ws.path, dir), { withFileTypes: true }); } catch { skipped++; continue; }
      for (const entry of entries) {
        if (++scanned > 10000 || hits.length >= 200 || bytes >= 20 * MAX_FILE_BYTES || Date.now() >= deadline) break;
        if (entry.isSymbolicLink() || SKIP.has(entry.name)) continue;
        const path = [dir, entry.name].filter(Boolean).join("/");
        if (entry.isDirectory()) { queue.push(path); continue; }
        if (!entry.isFile()) continue;
        if (!content) { if (path.toLowerCase().includes(needle)) hits.push({ path }); continue; }
        try {
          const file = await this.readAt(ws.path, path);
          bytes += Buffer.byteLength(file.text);
          const lines = file.text.split(/\r?\n/);
          for (let i = 0; i < lines.length && hits.length < 200; i++) if (lines[i]!.toLowerCase().includes(needle)) hits.push({ path, line: i + 1, preview: lines[i]!.slice(0, 220) });
        } catch { skipped++; }
      }
    }
    return { hits, truncated: queue.length > 0 || hits.length >= 200 || scanned >= 10000 || bytes >= 20 * MAX_FILE_BYTES || Date.now() >= deadline, skipped };
  }

  async repo(id: string) {
    const ws = await this.workspace(id);
    const root = await resolveRepoRoot(ws.path);
    if (!root) return { path: null, prefix: "" };
    const real = await realpath(root);
    const rel = relative(ws.path, real);
    if (rel === ".." || rel.startsWith(`..${sep}`) || resolve(ws.path, rel) !== real) return { path: null, prefix: "" };
    return { path: real, prefix: rel.replace(/\\/g, "/") };
  }

  async gitDiff(id: string, path: string, staged: boolean) {
    pathParts(path);
    const repo = await this.repo(id);
    if (!repo.path) throw new IdeError("No repository in this workspace.");
    // A tracked deletion can include a removed parent folder. Existing ancestors must still
    // pass the link checks; once a parent is absent Git reads the index/object, not a disk file.
    await this.confined(repo.path, path, true).catch(e => { if (!missing(e)) throw e; });
    const args = ["--literal-pathspecs", "diff", "--no-ext-diff", "--no-textconv", ...(staged ? ["--cached"] : []), "--", path];
    const result = await runGit(repo.path, args);
    if (result.code !== 0 || result.timedOut) throw new IdeError("Git could not read this diff. Refresh source control and retry.", 409);
    let patch = result.stdout;
    if (!staged && !patch) {
      const tracked = await runGit(repo.path, ["--literal-pathspecs", "ls-files", "--error-unmatch", "--", path]);
      if (tracked.code !== 0) {
        const file = await this.readAt(repo.path, path);
        const lines = file.text.split("\n"); if (lines.at(-1) === "") lines.pop();
        patch = `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n` + lines.map(l => `+${l}`).join("\n");
      }
    }
    return { patch: patch.slice(0, 200_000), truncated: patch.length > 200_000, binary: /Binary files .* differ|GIT binary patch/.test(patch) };
  }
}
