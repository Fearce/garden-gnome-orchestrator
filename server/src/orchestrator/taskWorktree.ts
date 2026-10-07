import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { config } from "../config.js";
import { isConfiguredCommitOnlyOrigin } from "../git/commitOnly.js";
import { runGit } from "../gitService.js";
import { withGitTransaction } from "../git/transaction.js";
import type { TaskWorktree } from "../types.js";

/**
 * A task's OWN checkout of a repository: a linked git worktree on its own branch, so several tasks (and
 * the owner) can change one repo at once without sharing a working tree. It lives beside the repo in
 * `<parent>/<repo>.worktrees/<name>` on branch `ggo/<name>-<id8>`, cut from whatever the main checkout
 * has checked out; `<name>` names the work (worktreeName.ts, or the agent's own via `task_worktree`).
 * Both share one object store, so integrating is an ordinary rebase + fast-forward.
 *
 * A fresh worktree has none of the repo's ignored state, so `provisionWorktree` links the heavy
 * dependency folders back to the main checkout as junctions and copies its `.env*` files. Those
 * junctions are why removal must go through `retireTaskWorktree`: `git worktree remove` follows a
 * junction and deletes the MAIN checkout's packages through it (reproduced on this box), so the links
 * are unlinked first.
 */

const ADD_TIMEOUT_MS = 180_000;
const READ_TIMEOUT_MS = 30_000;

/** Ignored folders that are shared rather than reinstalled: reinstalling them per task costs minutes
 *  and hundreds of MB, and a task that changes dependencies is told to replace the link. */
const LINKED_DIRS = new Set(["node_modules", ".venv", "venv"]);
/** Ignored files copied in: the local secrets a test or dev server needs to start at all, and the
 *  privacy guard's private word list, without which `privacy:check` in a worktree passes on far fewer words. */
const COPIED_FILE = /^(\.env(\..+)?|\.privacy-terms)$/;

export type WorktreeResult = { ok: true; worktree: TaskWorktree } | { ok: false; error: string };

async function git(cwd: string, args: string[], timeoutMs = READ_TIMEOUT_MS): Promise<string> {
  const result = await runGit(cwd, args, timeoutMs, { urgent: true });
  if (result.code !== 0) throw new Error((result.stderr || result.stdout || `git ${args[0]} failed`).trim().split(/\r?\n/)[0]);
  return result.stdout.trim();
}

async function gitOk(cwd: string, args: string[]): Promise<boolean> {
  return (await runGit(cwd, args, READ_TIMEOUT_MS, { urgent: true })).code === 0;
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Branch- and folder-safe words from a task title. */
export function worktreeSlug(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32).replace(/-+$/, "");
  return slug || "task";
}

/** `ggo/<words>-<id8>`: readable in `git branch`, and the id suffix ties it to exactly one task. */
export function taskBranchName(words: string, threadId: string): string {
  return `ggo/${worktreeSlug(words)}-${threadId.slice(0, 8)}`;
}

/** The worktree folder for `branch`: its words without the `ggo/` prefix or this task's id suffix. */
export function worktreeFolderName(branch: string, threadId: string): string {
  return worktreeSlug(branch.replace(/^ggo\//, "").replace(new RegExp(`-${threadId.slice(0, 8)}$`), ""));
}

/** The folder every task worktree of `mainRoot` lives under — one sibling folder per repo. */
export function worktreesHome(mainRoot: string): string {
  return join(dirname(mainRoot), `${basename(mainRoot)}.worktrees`);
}

/** The repository's top level when `path` is inside a work tree, else null (not a repo, or a non-repo
 *  umbrella folder holding several repos). Unlike gitService.resolveRepoRoot it never guesses a nested
 *  checkout: picking one of several repos for the task is the agent's call, not ours. */
export async function containingRepoRoot(path: string): Promise<string | null> {
  if (!existsSync(path)) return null;
  try {
    const top = await git(path, ["rev-parse", "--show-toplevel"]);
    return top ? realpathSync(top) : null;
  } catch {
    return null;
  }
}

/** The nearest folder at or above `path` holding a `.git` entry, without spawning git — for the sync
 *  callers (kickoff text) that only need the folder to name. */
export function enclosingRepoSync(path: string): string | null {
  for (let dir = resolve(path); ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return dir;
    if (dirname(dir) === dir) return null;
  }
}

/** The MAIN checkout of the repository `root` belongs to (itself, unless `root` is a linked worktree). */
export async function mainCheckoutOf(root: string): Promise<string> {
  const common = resolve(root, await git(root, ["rev-parse", "--git-common-dir"]));
  return basename(common) === ".git" ? realpathSync(dirname(common)) : realpathSync(root);
}

/** Whether `root` is a linked worktree rather than a main checkout. */
export async function isLinkedWorktree(root: string): Promise<boolean> {
  return normalized(await mainCheckoutOf(root)) !== normalized(realpathSync(root));
}

const normalized = (p: string): string => p.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();

/** Whether `inner` is `outer` or below it. */
export function isWithin(inner: string, outer: string): boolean {
  const rel = relative(outer, inner);
  return rel === "" || (!!rel && !rel.startsWith("..") && !rel.includes(":"));
}

/** Map a path inside the main checkout to the same place inside the task's worktree, so a task
 *  dispatched on `repo/web` keeps working in `web`. */
export function mapIntoWorktree(path: string, worktree: TaskWorktree): string {
  const rel = relative(worktree.repo, path);
  const target = rel && !rel.startsWith("..") ? join(worktree.path, rel) : worktree.path;
  return existsSync(target) ? target : worktree.path;
}

/** The checkout holding a task's work, for whatever reads it rather than running in it (the Changes view,
 *  progress fingerprints, the code-context bar): the worktree it claimed for the repo it was dispatched
 *  into, since a guided task keeps running in the main checkout, else its own workspace. */
export function taskWorkCheckout(t: { workspace: string; worktrees?: readonly TaskWorktree[]; baselineHead?: string | null }): { workspace: string; baselineHead: string | null } {
  const claimed = (t.worktrees ?? []).find((w) => !isWithin(t.workspace, w.path) && isWithin(t.workspace, w.repo));
  if (!claimed) {
    const movedInto = (t.worktrees ?? []).find((w) => isWithin(t.workspace, w.path) && !existsSync(w.path));
    if (movedInto) return { workspace: join(movedInto.repo, relative(movedInto.path, t.workspace)), baselineHead: t.baselineHead ?? movedInto.baseSha };
    return { workspace: t.workspace, baselineHead: t.baselineHead ?? null };
  }
  // A retired worktree's work was fast-forwarded into the base the main checkout holds.
  if (!existsSync(claimed.path)) return { workspace: t.workspace, baselineHead: claimed.baseSha };
  return { workspace: mapIntoWorktree(t.workspace, claimed), baselineHead: claimed.baseSha };
}

/** Every branch currently checked out somewhere, mapped to the folder holding it. */
async function checkedOutBranches(root: string): Promise<Map<string, string>> {
  const porcelain = await git(root, ["worktree", "list", "--porcelain"]);
  const out = new Map<string, string>();
  let folder = "";
  for (const line of porcelain.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) folder = line.slice("worktree ".length);
    else if (line.startsWith("branch refs/heads/")) out.set(line.slice("branch refs/heads/".length), folder);
  }
  return out;
}

async function branchExists(root: string, branch: string): Promise<boolean> {
  return gitOk(root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
}

/** The first free `<home>/<slug>[-n]` folder. */
function freeFolder(home: string, slug: string): string {
  for (let n = 1; n < 100; n++) {
    const folder = join(home, n === 1 ? slug : `${slug}-${n}`);
    if (!existsSync(folder)) return folder;
  }
  throw new Error("no free worktree folder after 99 tries");
}

export interface CreateTaskWorktreeInput {
  /** Any folder inside the repository. */
  repoPath: string;
  threadId: string;
  title: string;
  /** Words naming the work, for the new branch and folder; blank falls back to the title. */
  name?: string | null;
  /** Check out this branch instead of creating `ggo/<slug>`; created from `startPoint` if missing. */
  branch?: string | null;
  /** Commit-ish a NEW branch starts from; defaults to the main checkout's HEAD. */
  startPoint?: string | null;
}

/** Create the task's worktree. Refuses a branch that is already checked out elsewhere — two working
 *  trees on one branch is the sharing this exists to end — and names where it is checked out. */
export async function createTaskWorktree(input: CreateTaskWorktreeInput): Promise<WorktreeResult> {
  const root = await containingRepoRoot(input.repoPath);
  if (!root) return { ok: false, error: `"${input.repoPath}" is not inside a git repository.` };
  try {
    const main = await mainCheckoutOf(root);
    return await withGitTransaction(main, async (): Promise<WorktreeResult> => {
      const base = (await git(main, ["branch", "--show-current"])) || null;
      const branch = input.branch?.trim() || taskBranchName(input.name?.trim() || input.title, input.threadId);
      const busy = (await checkedOutBranches(main)).get(branch);
      if (busy) return { ok: false, error: `Branch "${branch}" is already checked out in ${busy}. Work there only if it is yours, or give a different branch.` };
      const exists = await branchExists(main, branch);
      const startPoint = input.startPoint?.trim() || "HEAD";
      const baseSha = await git(main, ["rev-parse", exists ? branch : startPoint]);
      const folder = freeFolder(worktreesHome(main), worktreeFolderName(branch, input.threadId));
      mkdirSync(dirname(folder), { recursive: true });
      await git(main, exists ? ["worktree", "add", folder, branch] : ["worktree", "add", "-b", branch, folder, startPoint], ADD_TIMEOUT_MS);
      const links = await provisionWorktree(main, folder);
      const origin = await git(main, ["remote", "get-url", "origin"]).catch(() => null);
      const commitOnly = isConfiguredCommitOnlyOrigin(origin, config.noPushRepoPattern);
      return { ok: true, worktree: { repo: main, path: realpathSync(folder), branch, base, baseSha, commitOnly, links, createdAt: Date.now() } };
    });
  } catch (error) {
    return { ok: false, error: `The worktree could not be created: ${errorText(error)}` };
  }
}

/** Bring back a recorded worktree whose folder is gone (it was retired when the task finished, or
 *  deleted by hand): re-attach its branch, or recreate the branch. A deleted branch was integrated, so
 *  it restarts from its base's current tip, which holds that work; `baseSha` moves with it. */
export async function restoreTaskWorktree(worktree: TaskWorktree): Promise<WorktreeResult> {
  if (existsSync(worktree.path)) return { ok: true, worktree };
  if (!existsSync(worktree.repo)) return { ok: false, error: `The repository ${worktree.repo} no longer exists.` };
  try {
    await git(worktree.repo, ["worktree", "prune"]);
    const busy = (await checkedOutBranches(worktree.repo)).get(worktree.branch);
    if (busy) return { ok: false, error: `Branch "${worktree.branch}" is now checked out in ${busy}.` };
    mkdirSync(dirname(worktree.path), { recursive: true });
    const exists = await branchExists(worktree.repo, worktree.branch);
    const baseSha = exists ? worktree.baseSha : await restartPoint(worktree);
    const args = exists ? ["worktree", "add", worktree.path, worktree.branch] : ["worktree", "add", "-b", worktree.branch, worktree.path, baseSha];
    await git(worktree.repo, args, ADD_TIMEOUT_MS);
    const links = await provisionWorktree(worktree.repo, worktree.path);
    return { ok: true, worktree: { ...worktree, path: realpathSync(worktree.path), baseSha, links } };
  } catch (error) {
    return { ok: false, error: `The worktree could not be restored: ${errorText(error)}` };
  }
}

async function restartPoint(worktree: TaskWorktree): Promise<string> {
  if (worktree.base && (await branchExists(worktree.repo, worktree.base))) return git(worktree.repo, ["rev-parse", `refs/heads/${worktree.base}`]);
  return worktree.baseSha;
}

/** Link the main checkout's dependency folders into the worktree and copy its `.env*` files. Returns
 *  the worktree-relative links made, which `retireTaskWorktree` must unlink before git removes it. */
export async function provisionWorktree(main: string, folder: string): Promise<string[]> {
  const ignored = await git(main, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]).catch(() => "");
  const links: string[] = [];
  for (const entry of ignored.split("\0").filter(Boolean)) {
    const rel = entry.replace(/\/$/, "");
    const name = basename(rel);
    const source = join(main, rel);
    const target = join(folder, rel);
    if (existsSync(target)) continue;
    try {
      if (entry.endsWith("/") && LINKED_DIRS.has(name)) {
        mkdirSync(dirname(target), { recursive: true });
        symlinkSync(source, target, "junction");
        links.push(rel);
      } else if (!entry.endsWith("/") && COPIED_FILE.test(name) && existsSync(dirname(target))) {
        copyFileSync(source, target);
      }
    } catch {
      // One unlinkable folder (a long path, a locked file) leaves the agent to install it itself.
    }
  }
  return links;
}

export interface WorktreeState {
  exists: boolean;
  /** Tracked changes or untracked (non-ignored) files in the worktree. */
  dirty: boolean;
  /** Commits on the task branch that its base does not have. */
  ahead: number;
  /** Commits on the base the task branch does not have. */
  behind: number;
  /** The task branch has commits and every one of them is in the base. */
  merged: boolean;
  /** The branch has no commits of its own beyond where it started. */
  untouched: boolean;
}

/** Where the task's branch stands against its base, for the header and the retire decision. */
export async function readWorktreeState(worktree: TaskWorktree): Promise<WorktreeState> {
  const exists = existsSync(worktree.path);
  const dirty = exists ? (await git(worktree.path, ["status", "--porcelain"]).catch(() => "")) !== "" : false;
  const tip = await git(worktree.repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${worktree.branch}`]).catch(() => "");
  if (!tip) return { exists, dirty, ahead: 0, behind: 0, merged: false, untouched: true };
  const untouched = tip === worktree.baseSha;
  if (!worktree.base) return { exists, dirty, ahead: 0, behind: 0, merged: false, untouched };
  const counts = await git(worktree.repo, ["rev-list", "--left-right", "--count", `${worktree.base}...${worktree.branch}`]).catch(() => "0\t0");
  const [behind, ahead] = counts.split(/\s+/).map((n) => Number(n) || 0) as [number, number];
  return { exists, dirty, ahead, behind, merged: !untouched && ahead === 0, untouched };
}

export type RetireResult = { removed: boolean; branchDeleted: boolean; reason?: string };

export interface RetireOptions {
  /** Deliverable paths: a worktree holding one is kept. */
  keep?: string[];
  /** Keep the worktree while its branch holds work its base lacks (a finished task that never integrated). */
  onlyIntegrated?: boolean;
}

/**
 * Remove a task's worktree folder when nothing in it can be lost: no uncommitted or untracked file and
 * no `keep` path (deliverables) inside it. Committed work survives on the branch either way; the branch
 * itself is deleted only once it is merged into its base or never moved. Junctions go first — see the
 * module comment for why that order is the whole point.
 */
export async function retireTaskWorktree(worktree: TaskWorktree, options: RetireOptions = {}): Promise<RetireResult> {
  const keep = options.keep ?? [];
  if (!existsSync(worktree.repo)) return { removed: false, branchDeleted: false, reason: "repository gone" };
  const state = await readWorktreeState(worktree);
  if (options.onlyIntegrated && !state.merged && !state.untouched) {
    return { removed: false, branchDeleted: false, reason: worktree.base ? `branch not integrated into ${worktree.base}` : "no base branch to integrate into" };
  }
  if (state.exists) {
    if (state.dirty) return { removed: false, branchDeleted: false, reason: "uncommitted or untracked files" };
    if (keep.some((path) => isWithin(resolve(worktree.path, path), worktree.path))) {
      return { removed: false, branchDeleted: false, reason: "a deliverable lives in it" };
    }
    await unlinkJunctions(worktree);
    try {
      await git(worktree.repo, ["worktree", "remove", worktree.path], ADD_TIMEOUT_MS);
    } catch (error) {
      return { removed: false, branchDeleted: false, reason: errorText(error) };
    }
  } else {
    await git(worktree.repo, ["worktree", "prune"]).catch(() => "");
  }
  const branchDeleted = (state.merged || state.untouched) && (await gitOk(worktree.repo, ["branch", "-D", worktree.branch]));
  return { removed: true, branchDeleted };
}

/** Where a deliverable card can point once the task's worktree goes: the main checkout's copy of the
 *  file when it holds the same bytes, or, for a file committed on the task branch (git keeps those exact
 *  bytes), the main checkout's tracked version of it. Null when only the worktree has the file. */
export async function mainCheckoutCopy(worktree: TaskWorktree, path: string): Promise<string | null> {
  const rel = relative(worktree.path, path);
  if (!rel || !isWithin(path, worktree.path)) return null;
  const copy = join(worktree.repo, rel);
  if (sameBytes(path, copy)) return copy;
  const tracked = (cwd: string) => gitOk(cwd, ["ls-files", "--error-unmatch", "--", rel.split("\\").join("/")]);
  return existsSync(copy) && (await tracked(worktree.path)) && (await tracked(worktree.repo)) ? copy : null;
}

function sameBytes(a: string, b: string): boolean {
  let fa: number | null = null;
  let fb: number | null = null;
  try {
    const [sa, sb] = [statSync(a), statSync(b)];
    if (!sa.isFile() || !sb.isFile() || sa.size !== sb.size) return false;
    fa = openSync(a, "r");
    fb = openSync(b, "r");
    const [ba, bb] = [Buffer.alloc(1 << 20), Buffer.alloc(1 << 20)];
    for (;;) {
      const na = readSync(fa, ba, 0, ba.length, null);
      const nb = readSync(fb, bb, 0, bb.length, null);
      if (na !== nb || !ba.subarray(0, na).equals(bb.subarray(0, nb))) return false;
      if (na === 0) return true;
    }
  } catch {
    return false;
  } finally {
    if (fa !== null) closeSync(fa);
    if (fb !== null) closeSync(fb);
  }
}

/** Remove only the links themselves, never what they point at: the recorded ones, plus any an agent
 *  made by hand (an umbrella task's worktree is discovered, so GGO never recorded its links). */
async function unlinkJunctions(worktree: TaskWorktree): Promise<void> {
  const ignored = await git(worktree.path, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]).catch(() => "");
  const found = ignored.split("\0").filter(Boolean).map((entry) => entry.replace(/\/$/, ""));
  for (const rel of new Set([...(worktree.links ?? []), ...found])) {
    const link = join(worktree.path, rel);
    try {
      if (lstatSync(link).isSymbolicLink()) unlinkSync(link);
    } catch {
      // Already gone.
    }
  }
}

/** The main checkouts directly inside a non-repo umbrella folder (one holding several repos). */
export function childRepos(umbrella: string): string[] {
  try {
    return readdirSync(umbrella, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.endsWith(".worktrees"))
      .map((entry) => join(umbrella, entry.name))
      .filter((dir) => {
        try {
          return statSync(join(dir, ".git")).isDirectory();
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

/** Worktrees an agent made by hand off `repos` (a CLI backend has no `task_worktree` tool),
 *  recognised by the branch convention `ggo/<words>-<id8>`. */
export async function discoverTaskWorktrees(repos: readonly string[], threadId: string): Promise<TaskWorktree[]> {
  const suffix = `-${threadId.slice(0, 8)}`;
  const found: TaskWorktree[] = [];
  for (const repo of repos) {
    const branches = await checkedOutBranches(repo).catch(() => new Map<string, string>());
    for (const [branch, folder] of branches) {
      if (!branch.startsWith("ggo/") || !branch.endsWith(suffix) || normalized(folder) === normalized(repo)) continue;
      try {
        const main = realpathSync(repo);
        const base = (await git(main, ["branch", "--show-current"])) || null;
        const baseSha = await git(main, ["merge-base", base ?? "HEAD", branch]);
        const origin = await git(main, ["remote", "get-url", "origin"]).catch(() => null);
        const commitOnly = isConfiguredCommitOnlyOrigin(origin, config.noPushRepoPattern);
        found.push({ repo: main, path: realpathSync(folder), branch, base, baseSha, commitOnly, links: [], createdAt: Date.now() });
      } catch {
        // A worktree git can't describe right now is picked up on the next pass.
      }
    }
  }
  return found;
}
