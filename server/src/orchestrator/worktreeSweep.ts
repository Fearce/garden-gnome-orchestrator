import { execFile } from "node:child_process";
import { existsSync, lstatSync, statSync } from "node:fs";
import { readdir, rm, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runGit } from "../gitService.js";
import type { TaskWorktree, Thread } from "../types.js";
import { mainCheckoutOf, retireTaskWorktree, worktreesHome } from "./taskWorktree.js";

/**
 * Safety net for worktrees that outlive their task. `retireWorktrees` only runs when a task is closed or
 * reaches 'done', so a task that failed, was cancelled, or was abandoned in `review`/`paused`, a worktree an
 * agent made by hand, and one kept at 'done' because it was dirty or unmerged at the time all stayed on disk
 * for good (tilebreaker.worktrees held 25 GB of them). This sweep reconsiders every linked worktree under a
 * repo's `.worktrees` home on boot and then daily:
 *  - a live task owns it, a process mentions its path, it is locked or detached, or it is dirty: kept;
 *  - it holds commits that exist nowhere else (not in the base, not on any remote): kept;
 *  - otherwise (merged into its base, or pushed) the folder is removed and the merged branch deleted;
 *  - a kept worktree of a finished task still sheds its ignored build output (node_modules, build, ...).
 */

/** Task states that no longer own a worktree. 'review' and 'paused' deliberately do: the owner may resume them. */
const TERMINAL_STATES = new Set<string>(["done", "failed", "cancelled", "closed"]);
/** Ignored folders that are pure build output or reinstallable dependencies. */
export const HEAVY_DIRS = ["node_modules", "build", "dist", "builds", ".godot", "bin", "obj"];
/** A worktree with no task owner (hand-made, or its task purged) must have been idle this long. */
const UNOWNED_IDLE_MS = 12 * 3600_000;

export type SweepAction = "removed" | "kept" | "trimmed";
export interface SweepEntry {
  path: string;
  branch: string | null;
  action: SweepAction;
  reason: string;
  freedBytes?: number;
}

export interface SweepOptions {
  dryRun?: boolean;
  /** Pause this long after every 200 files deleted, so a live game or build sharing the disk is not starved. */
  throttleMs?: number;
  /** Threads (all states) used to decide who owns a worktree. */
  threads: readonly Thread[];
  now?: number;
  /** Command lines of running processes; a worktree whose path appears in one is in use. Defaults to a live read. */
  processCommandLines?: readonly string[];
}

const norm = (p: string): string => p.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();

async function gitText(cwd: string, args: string[]): Promise<string | null> {
  const r = await runGit(cwd, args, 60_000, { urgent: true });
  return r.code === 0 ? r.stdout.trim() : null;
}

/** Command lines of every running process (Windows), so a dev server or Godot run inside a worktree blocks its removal. */
export function liveCommandLines(): Promise<string[]> {
  if (process.platform !== "win32") return Promise.resolve([]);
  return new Promise((done) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine } | Where-Object { $_ }"],
      { maxBuffer: 64 * 1024 * 1024, timeout: 60_000, windowsHide: true },
      (error, stdout) => done(error ? [] : String(stdout).split(/\r?\n/).filter(Boolean)),
    );
  });
}

interface Listed {
  path: string;
  branch: string | null;
  locked: boolean;
}

async function listLinked(repo: string): Promise<Listed[]> {
  const porcelain = (await gitText(repo, ["worktree", "list", "--porcelain"])) ?? "";
  const out: Listed[] = [];
  for (const block of porcelain.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/);
    const path = lines.find((l) => l.startsWith("worktree "))?.slice(9);
    if (!path) continue;
    const branch = lines.find((l) => l.startsWith("branch refs/heads/"))?.slice("branch refs/heads/".length) ?? null;
    out.push({ path, branch, locked: lines.some((l) => l === "locked" || l.startsWith("locked ")) });
  }
  return out.slice(1); // the first entry is the main checkout
}

function ownerOf(w: Listed, threads: readonly Thread[]): Thread | null {
  const byPath = threads.find((t) => (t.worktrees ?? []).some((x) => norm(x.path) === norm(w.path)));
  if (byPath) return byPath;
  const id = w.branch?.match(/^ggo\/.+-([0-9a-f]{8})$/)?.[1];
  return id ? (threads.find((t) => t.id.startsWith(id)) ?? null) : null;
}

/** Newest sign of life: the worktree's own git admin files and its branch tip. */
async function lastActivityMs(w: Listed): Promise<number> {
  let latest = 0;
  const gitDir = await gitText(w.path, ["rev-parse", "--absolute-git-dir"]);
  for (const f of gitDir ? [join(gitDir, "HEAD"), join(gitDir, "index")] : []) {
    try {
      latest = Math.max(latest, statSync(f).mtimeMs);
    } catch {
      // Missing file: no signal from it.
    }
  }
  const tip = await gitText(w.path, ["log", "-1", "--format=%ct"]);
  return Math.max(latest, tip ? Number(tip) * 1000 : 0);
}

/** Commits on `branch` that neither the base nor any remote branch has: the work removal would strand. */
async function unsavedCommits(repo: string, base: string | null, branch: string): Promise<number> {
  const exclude = [...(base ? [base] : []), "--remotes"];
  const n = await gitText(repo, ["rev-list", "--count", branch, "--not", ...exclude]);
  return n === null ? Number.MAX_SAFE_INTEGER : Number(n);
}

async function dirSize(path: string): Promise<number> {
  const r = await new Promise<number>((done) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-ChildItem -LiteralPath '${path.replace(/'/g, "''")}' -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum`], { timeout: 120_000, windowsHide: true }, (e, out) => done(e ? 0 : Number(String(out).trim()) || 0));
  });
  return r;
}

/** Remove ignored build output from a kept worktree. Symlinked folders (shared node_modules) are never followed. */
async function removeTree(dir: string, throttleMs: number): Promise<void> {
  if (throttleMs > 0) {
    let n = 0;
    const walk = async (d: string): Promise<void> => {
      for (const e of await readdir(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) await walk(p);
        else {
          await unlink(p).catch(() => undefined); // a junction is not a directory entry here: the link goes, never its target
          if (++n % 200 === 0) await new Promise((r) => setTimeout(r, throttleMs));
        }
      }
    };
    await walk(dir).catch(() => undefined);
  }
  await rm(dir, { recursive: true, force: true, maxRetries: 2 }).catch(() => undefined);
}

async function trimHeavy(w: Listed, o: SweepOptions): Promise<number> {
  let freed = 0;
  for (const name of HEAVY_DIRS) {
    const dir = join(w.path, name);
    let info;
    try {
      info = lstatSync(dir);
    } catch {
      continue;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) continue;
    if ((await gitText(w.path, ["ls-files", "--", name])) !== "") continue; // tracked content: not build output
    if ((await runGit(w.path, ["check-ignore", "-q", `${name}/`], 30_000, { urgent: true })).code !== 0) continue; // not ignored
    freed += await dirSize(dir);
    if (!o.dryRun) await removeTree(dir, o.throttleMs ?? 0);
  }
  return freed;
}

async function decide(repo: string, w: Listed, o: SweepOptions, lines: readonly string[]): Promise<SweepEntry> {
  const entry = (action: SweepAction, reason: string, freedBytes?: number): SweepEntry => ({ path: w.path, branch: w.branch, action, reason, freedBytes });
  if (!existsSync(w.path)) {
    if (!o.dryRun) await gitText(repo, ["worktree", "prune"]);
    return entry("removed", "folder already gone; pruned the registration");
  }
  if (w.locked) return entry("kept", "locked");
  if (!w.branch) return entry("kept", "detached HEAD, no branch to judge it by");
  const owner = ownerOf(w, o.threads);
  if (owner && !TERMINAL_STATES.has(owner.state)) return entry("kept", `task ${owner.id.slice(0, 8)} is ${owner.state}`);
  const needle = norm(w.path);
  if (lines.some((l) => norm(l).includes(needle))) return entry("kept", "a running process references it");
  if (!owner && (o.now ?? Date.now()) - (await lastActivityMs(w)) < UNOWNED_IDLE_MS) return entry("kept", "no task owner, but active within 12h");
  if ((await gitText(w.path, ["status", "--porcelain"])) !== "") return entry("kept", await trimmedNote(w, o, "uncommitted or untracked files"));
  const base = await gitText(repo, ["branch", "--show-current"]);
  const unsaved = await unsavedCommits(repo, base || null, w.branch);
  if (unsaved > 0) return entry("kept", await trimmedNote(w, o, `${unsaved} commit(s) not merged into ${base ?? "base"} and not pushed`));
  if (o.dryRun) return entry("removed", "merged or pushed; would remove", await dirSize(w.path));
  await trimHeavy(w, o); // ignored output first, throttled, so the folder removal below is quick
  const baseSha = (await gitText(repo, ["merge-base", base ?? "HEAD", w.branch])) ?? "";
  const tw: TaskWorktree = { repo, path: w.path, branch: w.branch, base: base || null, baseSha, links: [], createdAt: 0 };
  const result = await retireTaskWorktree(tw);
  return result.removed ? entry("removed", `merged or pushed${result.branchDeleted ? "; merged branch deleted" : "; branch kept"}`) : entry("kept", result.reason ?? "removal refused");
}

/** For a worktree that has to stay: drop its heavy ignored output when its task is over; return the reason with what was freed. */
async function trimmedNote(w: Listed, o: SweepOptions, why: string): Promise<string> {
  const owner = ownerOf(w, o.threads);
  if (owner && !TERMINAL_STATES.has(owner.state)) return why;
  const freed = await trimHeavy(w, o);
  return freed > 0 ? `${why}; ${o.dryRun ? "would trim" : "trimmed"} ${(freed / 1e9).toFixed(2)} GB of build output` : why;
}

/** Sweep one repo's worktrees. Never touches the main checkout or anything outside `<repo>.worktrees`. */
export async function sweepRepoWorktrees(repoInput: string, options: SweepOptions): Promise<SweepEntry[]> {
  const repo = await mainCheckoutOf(repoInput).catch(() => null);
  if (!repo) return [];
  const home = norm(worktreesHome(repo));
  const lines = options.processCommandLines ?? (await liveCommandLines());
  const results: SweepEntry[] = [];
  for (const w of await listLinked(repo)) {
    if (!norm(w.path).startsWith(home + "/")) continue;
    results.push(await decide(repo, w, options, lines).catch((e: unknown) => ({ path: w.path, branch: w.branch, action: "kept" as const, reason: `sweep error: ${String(e)}` })));
  }
  return results;
}

/** The distinct main checkouts GGO tasks have worked in. */
export async function reposOf(threads: readonly Thread[]): Promise<string[]> {
  const found = new Set<string>();
  for (const t of threads) {
    for (const folder of [t.homeWorkspace ?? t.workspace, ...(t.worktrees ?? []).map((w) => w.repo)]) {
      if (!folder || !existsSync(resolve(folder))) continue;
      const root = await gitText(folder, ["rev-parse", "--show-toplevel"]);
      if (root) found.add(await mainCheckoutOf(root).catch(() => root));
    }
  }
  return [...found];
}
