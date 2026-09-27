import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** A Co-work session in its OWN checkout of the repository.
 *
 *  A Co-worker turn and a task agent may never write in the same folder (`coworkTaskConflict`), and a
 *  busy repo nearly always has a task running, so pairing there meant waiting. A linked git worktree is a
 *  second checkout of the same repository on its own branch, in a sibling folder: the workspace key
 *  differs, so neither side blocks the other, and both still share one object store, so the owner merges
 *  the branch back with an ordinary `git merge`. Nothing is removed automatically: an unmerged branch in
 *  that folder is the owner's work. */

export type CoworkWorktree = { ok: true; workspace: string; worktree: string; branch: string; base: string } | { ok: false; error: string };

const GIT_TIMEOUT_MS = 120_000;

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}

/** A branch- and folder-safe slug from the session's name: lower-case words joined by dashes. */
export function worktreeSlug(label: string): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return slug || "session";
}

/** The first `<repo>-cowork-<slug>[-n]` folder and `cowork/<slug>[-n]` branch that are both free. */
async function freeName(root: string, slug: string): Promise<{ folder: string; branch: string }> {
  for (let n = 1; n < 100; n++) {
    const suffix = n === 1 ? slug : `${slug}-${n}`;
    const folder = join(dirname(root), `${basename(root)}-cowork-${suffix}`);
    const branch = `cowork/${suffix}`;
    const taken = await git(root, ["branch", "--list", branch]);
    if (!existsSync(folder) && !taken) return { folder, branch };
  }
  throw new Error("no free worktree name after 99 tries");
}

/** Creates a worktree for `workspace` (any folder inside a git repository) on a fresh `cowork/*` branch
 *  from the repository's current HEAD. The returned `workspace` is the same sub-folder inside the new
 *  checkout, so a session opened on `repo/web` keeps working in `web`. */
export async function createCoworkWorktree(workspace: string, label: string): Promise<CoworkWorktree> {
  let root: string;
  try {
    root = realpathSync(await git(workspace, ["rev-parse", "--show-toplevel"]));
  } catch {
    return { ok: false, error: "A separate worktree needs the workspace to be inside a git repository." };
  }
  try {
    const base = await git(root, ["rev-parse", "--short", "HEAD"]);
    const { folder, branch } = await freeName(root, worktreeSlug(label));
    await git(root, ["worktree", "add", "-b", branch, folder, "HEAD"]);
    const inner = relative(root, realpathSync(workspace));
    const target = inner && !inner.startsWith("..") ? join(folder, inner) : folder;
    return { ok: true, workspace: existsSync(target) ? target : folder, worktree: folder, branch, base };
  } catch (error) {
    const detail = ((error as { stderr?: string }).stderr || (error as Error).message || String(error)).trim().split(/\r?\n/)[0];
    return { ok: false, error: `The worktree could not be created: ${detail}` };
  }
}
