/**
 * Regression test — opening the Git picker must not wait for every historical task workspace or a disk
 * scan. A real owner database can have hundreds of old rows, and on Windows each git rev-parse is a
 * process launch. The focused task, recent repositories, and this app's checkout must arrive promptly;
 * discovery is warmed in the background and an explicit Rescan is allowed to wait for it.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "repo-console-"));
process.env.WORKSPACE_SEARCH_ROOTS = root;

const { RepoConsole } = await import("../orchestrator/repoConsole.js");

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore", windowsHide: true });
}

function initRepo(path: string): void {
  mkdirSync(path);
  git(path, "init", "--quiet");
  // The owner's global core.hooksPath runs a real validation suite on every commit (~3s each here).
  const emptyHooks = join(path, ".git", "gate-empty-hooks");
  mkdirSync(emptyHooks);
  git(path, "config", "core.hooksPath", emptyHooks);
  git(path, "config", "user.name", "Git Console Test");
  git(path, "config", "user.email", "git-console-test@example.com");
  writeFileSync(join(path, "README.md"), "fixture\n");
  git(path, "add", "README.md");
  git(path, "commit", "--quiet", "-m", "initial");
}

const samePath = (a: string, b: string): boolean => a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase();

try {
  const self = join(root, "self repo");
  const recent = join(root, "recent repo");
  const focused = join(root, "focused repo");
  initRepo(self);
  initRepo(recent);
  initRepo(focused);

  // Only the focused row should be resolved on an ordinary open. These deliberately invalid historical
  // paths catch the old serial `resolveRepoRoot` loop without making the test depend on process speed.
  const oldRows = Array.from({ length: 120 }, (_, i) => ({ id: `old-${i}`, workspace: join(root, `old workspace ${i}`), state: "done" }));
  const focusedRow = { id: "focused", workspace: focused, state: "review" };
  const db = {
    listThreads: () => [focusedRow, ...oldRows],
    listCoworkSessions: () => [],
    getThread: (id: string) => id === "focused" ? focusedRow : undefined,
    kvGet: (key: string) => key === "setting_recent_repos" ? JSON.stringify([recent]) : null,
  };
  const consoleService = new RepoConsole(db as never, self);

  const started = Date.now();
  const initial = await consoleService.list(false, "focused");
  const elapsed = Date.now() - started;
  const initialPaths = new Set(initial.map((repo) => repo.path));
  assert.ok([...initialPaths].some((path) => samePath(path, self)), "self repository is available immediately");
  assert.ok([...initialPaths].some((path) => samePath(path, recent)), "recent repository is available immediately");
  assert.ok([...initialPaths].some((path) => samePath(path, focused)), "focused task repository is available immediately");
  assert.ok(elapsed < 5_000, `ordinary picker open took ${elapsed}ms`);

  const rescanned = await consoleService.list(true, "focused");
  assert.ok(rescanned.some((repo) => samePath(repo.path, focused)), "explicit rescan preserves the focused repository");
  console.log(`Git picker returns known repositories in ${elapsed}ms and keeps full discovery on Rescan.`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
