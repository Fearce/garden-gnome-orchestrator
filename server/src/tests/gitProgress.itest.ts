/**
 * Integration test - the resume-kickoff git progress block (`server/src/orchestrator/gitProgress.ts`)
 * and `ThreadManager.getChanges` (the in-GUI change-review panel), against REAL git repos and a REAL
 * non-repo directory.
 *
 * The defect this guards: both `composeResumeKickoff`'s old inline `git()` helper AND `getChanges`
 * resolved with `stdout || stderr || err.message` regardless of exit code, so a workspace that is
 * merely the PARENT of a checkout (several agents sharing one parent directory, each working a child
 * repo, is a normal setup here) had `git diff`/`git diff --stat` fall back to `--no-index` mode and
 * dump their full usage text into the resumed agent's prompt, or into the owner's change-review panel,
 * as if it were workspace state. `getChanges` had already anticipated a non-repo workspace with
 * "(no commits / not a git repo)" fallback text, but the `|| stderr` chain made that string non-empty
 * before the fallback could ever fire.
 *
 * Scenarios:
 *   A. NON-REPO   - a plain directory (not a repo) holding a child that IS a repo: the block must name
 *                   the child, stay tiny, and contain none of git's `--no-index` usage text.
 *   B. NON-REPO, no repo children - the block still stays tiny and says so plainly.
 *   C. HEALTHY REPO - a repo with one commit plus an uncommitted change still reports the commit and the
 *                   diff (the pre-existing behavior must not regress).
 *   D. getChanges - the same non-repo/healthy-repo split, through the real `ThreadManager.getChanges`:
 *                   a non-repo workspace reaches the "(no commits / not a git repo)"/"(no uncommitted
 *                   changes)" fallbacks instead of a usage dump, and a healthy repo is unaffected.
 *
 * Run:  npm run test:git-progress   (from server/)   -- or:  npx tsx src/tests/gitProgress.itest.ts
 * Exits non-zero if any assertion fails. Self-contained: builds throwaway dirs/repos in a temp dir, removes them.
 */

process.env.CAP_RETRY_MS = "0"; // no cap-supervisor interval during the test

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountManager } from "../accounts/accountManager.js";

const { buildGitProgressBlock } = await import("../orchestrator/gitProgress.js");
const { Db } = await import("../db/db.js");
const { EventHub } = await import("../events.js");
const { FileMemoryService } = await import("../memory/memory.js");
const { ThreadManager } = await import("../orchestrator/threadManager.js");

// Minimal stub AccountManager: getChanges never touches accounts/pipeline, so only the methods the
// ThreadManager constructor's boot-apply calls need to exist (threadmanager-itest.md's documented trap).
class StubAccounts {
  onUsageRefresh(_cb: () => void): void {}
  effectiveUtilization(): number | null {
    return null;
  }
  soonestResetAt(): number | null {
    return null;
  }
  hasHeadroom(): boolean {
    return true;
  }
  setPingInterval(_ms: number): void {}
  applyEnabled(_id: string, _enabled: boolean): void {}
  applyWeeklySafetyPct(_id: string, _pct: number): void {}
  setSpreadUsage(_on: boolean): void {}
}

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

  // ---- D. ThreadManager.getChanges shares the same guard --------------------------------------------
  console.log("\nD. ThreadManager.getChanges (the change-review panel)");
  {
    const dbDir = mkdtempSync(join(tmpdir(), "gitprogress-tm-"));
    const db = new Db(join(dbDir, "orchestrator.sqlite"));
    const hub = new EventHub();
    const memory = new FileMemoryService(join(dbDir, "memory"));
    const mgr = new ThreadManager(db, hub, memory, new StubAccounts() as unknown as AccountManager);
    try {
      // D1: non-repo workspace (the multi-repo-parent case) must reach the honest fallback text, not
      // a `git diff --no-index` usage dump.
      const lonely = join(root, "getchanges-non-repo");
      mkdirSync(join(lonely, "just-a-folder"), { recursive: true });
      const nonRepoThread = db.createThread({ title: "non-repo", workspace: lonely, rawPrompt: "check changes" });
      const nonRepoChanges = await mgr.getChanges(nonRepoThread.id);
      check("non-repo diff is the honest fallback, not a usage dump", nonRepoChanges.diff === "(no uncommitted changes)", nonRepoChanges.diff.slice(0, 120));
      check("non-repo log is the honest fallback, not a usage dump", nonRepoChanges.log === "(no commits / not a git repo)", nonRepoChanges.log.slice(0, 120));
      check("non-repo diff contains no --no-index usage text", !/--no-index/.test(nonRepoChanges.diff) && !/usage: git diff/i.test(nonRepoChanges.diff));
      check("non-repo log contains no --no-index usage text", !/--no-index/.test(nonRepoChanges.log) && !/usage: git diff/i.test(nonRepoChanges.log));

      // D2: a healthy repo with a commit and an uncommitted change is unaffected.
      const repo = join(root, "getchanges-healthy-repo");
      initRepoWithCommit(repo);
      writeFileSync(join(repo, "README.md"), "base\nchanged line\n");
      const healthyThread = db.createThread({ title: "healthy", workspace: repo, rawPrompt: "check changes" });
      const healthyChanges = await mgr.getChanges(healthyThread.id);
      check("healthy repo log reports the commit", healthyChanges.log.includes("initial commit"), healthyChanges.log);
      check("healthy repo diff reports the uncommitted change", /README\.md/.test(healthyChanges.diff), healthyChanges.diff.slice(0, 200));
      check("healthy repo diff is not the fallback text", healthyChanges.diff !== "(no uncommitted changes)");
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const anyMgr = mgr as any;
      if (anyMgr.capSupervisor) clearInterval(anyMgr.capSupervisor);
      db.raw.close();
      rmSync(dbDir, { recursive: true, force: true });
    }
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
