/**
 * Gate: a Co-work session in its own git worktree (`orchestrator/coworkWorktree.ts`).
 *
 *   npm run test:cowork-worktree --prefix server
 *
 * Runs real git against a throwaway repository, because every claim here is about what git does:
 *
 *   1. THE WORKTREE IS A REAL SECOND CHECKOUT, on a fresh `cowork/<slug>` branch at the repo's HEAD, in a
 *      sibling folder. Its path differs from the main checkout's, which is the entire point: the
 *      workspace conflict guard compares paths, so a task in the main checkout no longer blocks it.
 *   2. A SUB-FOLDER STAYS A SUB-FOLDER. A session opened on `repo/web` works in `web` of the worktree.
 *   3. A SECOND SESSION NEVER REUSES A NAME. Folder and branch both get a suffix instead of failing.
 *   4. A FOLDER THAT IS NOT A REPOSITORY IS REFUSED with a reason, not a stack trace.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { normalizeWorkspace } from "../types.js";
import { createCoworkWorktree, worktreeSlug } from "../orchestrator/coworkWorktree.js";

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();

const base = realpathSync(mkdtempSync(join(tmpdir(), "cowork-worktree-")));
const repo = join(base, "garden");
try {
  mkdirSync(join(repo, "web"), { recursive: true });
  git(repo, "init", "--quiet", "-b", "master");
  for (const [key, value] of [["user.name", "Worktree Test"], ["user.email", "worktree@example.com"], ["commit.gpgsign", "false"]] as const) git(repo, "config", key, value);
  writeFileSync(join(repo, "web", "app.ts"), "export {};\n");
  git(repo, "add", "-A");
  git(repo, "commit", "--quiet", "-m", "initial");
  const head = git(repo, "rev-parse", "--short", "HEAD");

  // ---- 1. a real second checkout on its own branch ------------------------------------------------
  const first = await createCoworkWorktree(repo, "Pair on the Mobile layout!");
  assert.ok(first.ok, first.ok ? "" : first.error);
  assert.equal(first.branch, "cowork/pair-on-the-mobile-layout", "the branch is named from the session");
  assert.equal(basename(first.worktree), "garden-cowork-pair-on-the-mobile-layout", "the folder sits beside the repo");
  assert.equal(git(first.worktree, "rev-parse", "--abbrev-ref", "HEAD"), first.branch, "the worktree is on its own branch");
  assert.equal(first.base, head, "the branch starts at the repo's HEAD");
  assert.ok(existsSync(join(first.worktree, "web", "app.ts")), "the worktree carries the committed files");
  assert.notEqual(normalizeWorkspace(first.workspace), normalizeWorkspace(repo), "its workspace key differs, so the task guard does not block it");
  assert.equal(git(repo, "rev-parse", "--abbrev-ref", "HEAD"), "master", "the main checkout is left on its branch");

  // ---- 2. a sub-folder stays a sub-folder ---------------------------------------------------------
  const nested = await createCoworkWorktree(join(repo, "web"), "web only");
  assert.ok(nested.ok, nested.ok ? "" : nested.error);
  assert.equal(nested.workspace, join(nested.worktree, "web"), "a session on repo/web works in web of its worktree");

  // ---- 3. names never collide ---------------------------------------------------------------------
  const again = await createCoworkWorktree(repo, "Pair on the Mobile layout!");
  assert.ok(again.ok, again.ok ? "" : again.error);
  assert.equal(again.branch, "cowork/pair-on-the-mobile-layout-2", "a second session gets a suffixed branch");
  assert.notEqual(again.worktree, first.worktree, "and its own folder");

  // ---- 4. not a repository -----------------------------------------------------------------------
  const plain = join(base, "plain");
  mkdirSync(plain);
  const refused = await createCoworkWorktree(plain, "anything");
  assert.equal(refused.ok, false, "a folder outside git is refused");
  assert.match(refused.ok ? "" : refused.error, /inside a git repository/, "with a reason the owner can act on");

  assert.equal(worktreeSlug("   "), "session", "an empty name still yields a usable slug");
  assert.equal(worktreeSlug("Ünïcode / slashes\\and:colons"), "n-code-slashes-and-colons", "a slug is always branch- and folder-safe");

  console.log("Co-work worktree gate passed - real second checkout on its own branch, sub-folders kept, no name collisions, non-repos refused.");
} finally {
  rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
