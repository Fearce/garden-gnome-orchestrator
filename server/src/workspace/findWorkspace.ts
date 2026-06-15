import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface WorkspaceMatch {
  path: string;
  isGitRepo: boolean;
  score: number;
}

// Top-level / nested dirs that are never a workspace and would just slow the walk.
const SKIP = new Set([
  "node_modules", ".git", ".vs", ".vscode", ".idea", ".cache", "appdata",
  "windows", "program files", "program files (x86)", "programdata", "perflogs",
  "recovery", "msocache", "config.msi", "system volume information", "intel", "amd",
  "$recycle.bin", "dist", "build", "bin", "obj", "vendor",
]);

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

function scoreName(name: string, qTokens: string[]): number {
  const lname = name.toLowerCase();
  const nameTokens = tokenize(name);
  let score = 0;
  for (const qt of qTokens) {
    if (nameTokens.includes(qt)) score += 3; // whole-token match on the dir name
    else if (lname.includes(qt)) score += 2; // substring match
  }
  return score;
}

/**
 * Resolve a fuzzy project name to real on-disk directories. Walks each root to a
 * bounded depth, scores directory NAMES by query-token overlap, and prefers git
 * repos. Read-only (dir listing only); skips system/build noise and caps the walk
 * so it stays fast enough for an on-demand tool call.
 */
export function findWorkspaces(
  query: string,
  roots: string[],
  opts?: { maxDepth?: number; limit?: number; scanCap?: number; timeBudgetMs?: number },
): WorkspaceMatch[] {
  const maxDepth = opts?.maxDepth ?? 2;
  const limit = opts?.limit ?? 8;
  const budget = { n: opts?.scanCap ?? 6000 };
  // Hard wall-clock ceiling so a cold/slow/network-mounted drive can't block the
  // orchestrator's event loop — returns whatever was found so far.
  const deadline = Date.now() + (opts?.timeBudgetMs ?? 2500);
  const qTokens = tokenize(query);
  if (!qTokens.length) return [];

  const results: WorkspaceMatch[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth || budget.n <= 0 || Date.now() > deadline) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (budget.n <= 0 || Date.now() > deadline) return;
      if (!e.isDirectory()) continue;
      const lname = e.name.toLowerCase();
      if (lname.startsWith("$") || SKIP.has(lname)) continue;
      budget.n--;
      const full = join(dir, e.name);
      const score = scoreName(e.name, qTokens);
      if (score > 0) results.push({ path: full, isGitRepo: existsSync(join(full, ".git")), score });
      walk(full, depth + 1);
    }
  };

  for (const root of roots) {
    if (existsSync(root)) walk(root, 1);
  }

  // De-dup, then rank: score, then git repos, then shallower (shorter) paths.
  const byPath = new Map<string, WorkspaceMatch>();
  for (const m of results) if (!byPath.has(m.path) || byPath.get(m.path)!.score < m.score) byPath.set(m.path, m);
  return [...byPath.values()]
    .sort((a, b) => b.score - a.score || Number(b.isGitRepo) - Number(a.isGitRepo) || a.path.length - b.path.length)
    .slice(0, limit);
}
