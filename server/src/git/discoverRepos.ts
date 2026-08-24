import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { SKIP } from "../workspace/findWorkspace.js";

// Find the git repositories on this machine, so the Git console's picker offers them the way GitHub
// Desktop does — without anyone typing or browsing to a path.
//
// Async on purpose. The existing `findWorkspaces` walks with readdirSync, which is fine for a
// user-triggered lookup but would stall the event loop of a server streaming agent output for as long
// as the scan runs. This walk yields on every directory read, so a slow or network-mounted drive costs
// latency here and nowhere else.
//
// Bounded three ways — depth, directories visited, and wall clock — because the roots are whole drives.
// Hitting a bound returns what was found so far rather than failing: a partial list is still a useful
// picker, and the known repos (recent dispatches, task workspaces) are merged in regardless.

export interface DiscoverOptions {
  /** How many levels below each root to walk. Depth 3 covers `C:\repo`, `C:\code\repo`, `C:\code\org\repo`. */
  maxDepth?: number;
  /** Hard ceiling on directories visited. */
  scanCap?: number;
  /** Hard wall-clock ceiling. */
  timeBudgetMs?: number;
  /** Stop once this many repos are found. */
  limit?: number;
}

const DEFAULTS: Required<DiscoverOptions> = { maxDepth: 3, scanCap: 20_000, timeBudgetMs: 6_000, limit: 400 };

/** Directory names that are never worth descending into on top of the shared SKIP set — these hold
 *  vendored checkouts (a dependency's own `.git`) that are not repositories the owner works in. */
const EXTRA_SKIP = new Set([".pnpm-store", ".gradle", ".nuget", ".conda", ".venv", "venv", "site-packages", "go", ".stack-work", ".terraform"]);

/** Absolute paths of the git repositories under `roots`, deepest-first-free: a directory containing
 *  `.git` is reported and NOT descended into, so a repo's own vendored checkouts stay out of the list.
 *  Never throws — an unreadable directory is skipped. */
export async function discoverRepos(roots: string[], opts: DiscoverOptions = {}): Promise<string[]> {
  const { maxDepth, scanCap, timeBudgetMs, limit } = { ...DEFAULTS, ...opts };
  const deadline = Date.now() + timeBudgetMs;
  const found: string[] = [];
  let visited = 0;

  const exhausted = (): boolean => visited >= scanCap || found.length >= limit || Date.now() > deadline;

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth || exhausted()) return;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      return; // unreadable / permission-denied / vanished mid-walk
    }
    // A repo is reported and not descended into. `.git` is a directory in a normal checkout and a FILE
    // in a linked worktree, so both shapes count.
    if (entries.some((e) => e.name === ".git")) {
      found.push(dir);
      return;
    }
    const children: string[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const lname = e.name.toLowerCase();
      if (lname.startsWith("$") || SKIP.has(lname) || EXTRA_SKIP.has(lname)) continue;
      children.push(join(dir, e.name));
    }
    for (const child of children) {
      if (exhausted()) return;
      visited++;
      await walk(child, depth + 1);
    }
  };

  for (const root of roots) {
    if (exhausted()) break;
    try {
      if (!(await stat(root)).isDirectory()) continue;
    } catch {
      continue; // a drive letter that isn't mounted
    }
    await walk(root, 0);
  }
  return found;
}
