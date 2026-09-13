/**
 * Integration test - the resume-kickoff git progress block (`server/src/orchestrator/gitProgress.ts`),
 * against REAL git repos and a REAL non-repo directory.
 *
 * The defect this guards: `composeResumeKickoff`'s old inline `git()` helper resolved with
 * `stdout || stderr || err.message` regardless of exit code, so a workspace that is merely the PARENT of
 * a checkout (several agents sharing one parent directory, each working a child repo, is a normal setup
 * here) had `git diff`/`git diff --stat` fall back to `--no-index` mode and dump their full usage text
 * into the resumed agent's prompt as if it were workspace state.
 *
 * Scenarios:
 *   A. NON-REPO   - a plain directory (not a repo) holding a child that IS a repo: the block must name
 *                   the child, stay tiny, and contain none of git's `--no-index` usage text.
 *   B. NON-REPO, no repo children - the block still stays tiny and says so plainly.
 *   C. HEALTHY REPO - a repo with one commit plus an uncommitted change still reports the commit and the
 *                   diff (the pre-existing behavior must not regress).
 *
 * Run:  npm run test:git-progress   (from server/)   -- or:  npx tsx src/tests/gitProgress.itest.ts
 * Exits non-zero if any assertion fails. Self-contained: builds throwaway dirs/repos in a temp dir, removes them.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { buildGitProgressBlock } = await import("../orchestrator/gitProgress.js");

// ---- tiny assertion harness ------------------------------------------------------------------------
let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  PASS ${label}`);
  } else {
    failed++;
    failures.push(label + (detail ? ` - ${detail}` : ""));
    console.log(`  FAIL ${label}${detail ? ` - ${detail}` : ""}`);
  }
}

// ---- git helpers -----------------------------------------------------------------------------------
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, windowsHide: true }).trim();
}

function configureRepo(dir: string): void {
  git(dir, "config", "user.name", "Git Test");
  git(dir, "config", "user.email", "git-test@example.com");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "config", "core.autocrlf", "false");
  // Make the throwaway repo independent of a developer's global hooks, matching gitService.itest.ts.
  const emptyHooks = join(dir, ".git", "itest-empty-hooks");
  mkdirSync(emptyHooks);
  git(dir, "config", "core.hooksPath", emptyHooks);
}

function initRepoWithCommit(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "--quiet");
  configureRepo(dir);
  writeFileSync(join(dir, "README.md"), "base\n");
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "initial commit");
}

// ---- run -------------------------------------------------------------------------------------------
const root = mkdtempSync(join(tmpdir(), "gitprogress-itest-"));
try {
  // ---- A. non-repo workspace with a git-repo child -----------------------------------------------
  console.log("\nA. non-repo workspace, with a child repo");
  {
    const parent = join(root, "parent-with-child");
    mkdirSync(parent, { recursive: true });
    // A plain, non-repo child too, to prove only real repos get named.
    mkdirSync(join(parent, "not-a-repo"), { recursive: true });
    const child = join(parent, "child-repo");
    initRepoWithCommit(child);

    const block = await buildGitProgressBlock(parent);
    check("stays well under 1 KB (no usage-text dump)", block.length < 1024, `${block.length} bytes`);
    check("contains no git diff --no-index usage text", !/--no-index/.test(block) && !/usage: git diff/i.test(block));
    check("names the child repo", block.includes("child-repo"), block);
    check("does not name the non-repo sibling as a repo", !block.includes("not-a-repo"), block);
    check("says the workspace itself is not a repo", /not a git repository/i.test(block), block);
  }

  // ---- B. non-repo workspace with no repo children -----------------------------------------------
  console.log("\nB. non-repo workspace, no repo children");
  {
    const lonely = join(root, "lonely-non-repo");
    mkdirSync(join(lonely, "just-a-folder"), { recursive: true });

    const block = await buildGitProgressBlock(lonely);
    check("stays well under 1 KB", block.length < 1024, `${block.length} bytes`);
    check("contains no git diff --no-index usage text", !/--no-index/.test(block) && !/usage: git diff/i.test(block));
    check("plainly says no repo children either", /no child directory/i.test(block), block);
  }

  // ---- C. healthy repo: commit + uncommitted change must still be reported ------------------------
  console.log("\nC. healthy repo (pre-existing behavior unchanged)");
  {
    const repo = join(root, "healthy-repo");
    initRepoWithCommit(repo);
    writeFileSync(join(repo, "README.md"), "base\nchanged line\n");

    const block = await buildGitProgressBlock(repo);
    check("reports the commit", block.includes("initial commit"), block);
    check("reports the uncommitted diff", block.includes("changed line") || /README\.md/.test(block), block);
    check("does not claim the repo is missing", !/not a git repository/i.test(block), block);
  }

  console.log(`\n${failed === 0 ? "PASS" : "FAIL"} - ${passed} checks passed, ${failed} failed`);
  if (failed > 0) {
    console.log("Failures:\n  - " + failures.join("\n  - "));
    process.exitCode = 1;
  }
} finally {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
}
