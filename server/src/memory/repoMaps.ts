import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { queryTerms } from "./indexStore.js";

/** Preserve repo-scoped map recall when native hooks replace the user's Python hook. No git subprocess. */
export async function repoMapContext(cwd: string, query?: string): Promise<string> {
  try {
    let root = resolve(cwd);
    for (;;) {
      if (await stat(join(root, ".git")).then(() => true, () => false)) break;
      const parent = dirname(root);
      if (parent === root) return "";
      root = parent;
    }
    const mapDir = join(root, "agent_docs", "maps");
    const names = (await readdir(mapDir)).filter((name) => name.endsWith(".md")).sort().slice(0, 80);
    const terms = query == null ? [] : queryTerms(query);
    const rows: Array<{ name: string; path: string; verified: string; score: number }> = [];
    for (const file of names) {
      const path = join(mapDir, file);
      if ((await stat(path)).size > 64_000) continue;
      const text = await readFile(path, "utf8");
      const name = /^subsystem:\s*(.+)$/m.exec(text)?.[1]?.trim().replace(/^['"]|['"]$/g, "") || basename(file, ".md");
      const searchable = `${name} ${text}`.toLowerCase();
      const score = terms.reduce((sum, term) => sum + Math.min(3, searchable.split(term).length - 1) * (name.toLowerCase().includes(term) ? 3 : 1), 0);
      if (query != null && score < 6) continue;
      rows.push({ name, path: relative(root, path).replace(/\\/g, "/"), verified: /^last_verified:\s*(.+)$/m.exec(text)?.[1]?.trim() || "unknown", score });
    }
    const shown = query == null ? rows : rows.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, 2);
    if (!shown.length) return "";
    return [
      query == null ? "## Subsystem maps available in this repo" : "## Subsystem maps matching this prompt",
      "",
      "Read and freshness-check these existing maps before exploring the subsystem again.",
      ...shown.map((row) => `- **${row.name}** — \`${row.path}\` (verified ${row.verified})`),
    ].join("\n");
  } catch {
    return "";
  }
}
