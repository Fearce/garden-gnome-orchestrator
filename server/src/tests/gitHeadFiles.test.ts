import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { headFromFiles } from "../git/headFromFiles.js";

const root = mkdtempSync(join(tmpdir(), "ggo-git-head-"));
const git = join(root, "repo", ".git");
const sha = "a".repeat(40), next = "b".repeat(40);
const write = (file: string, value: string) => writeFileSync(file, value);
try {
  mkdirSync(join(git, "refs", "heads"), { recursive: true });
  mkdirSync(join(root, "repo", "src"));
  write(join(git, "HEAD"), "ref: refs/heads/main\n");
  write(join(git, "refs", "heads", "main"), sha);
  assert.equal(await headFromFiles(join(root, "repo", "src")), sha, "nested workspace finds the containing checkout");
  symlinkSync(join(root, "repo", "src"), join(root, "junction"), "junction");
  assert.equal(await headFromFiles(join(root, "junction")), sha, "junctions follow the physical repository like Git");
  assert.equal(await headFromFiles(join(root, "repo", "absent")), undefined, "a missing workspace cannot inherit a baseline");
  assert.equal(await headFromFiles(join(git, "HEAD")), undefined, "a file is not a workspace");
  write(join(git, "refs", "heads", "main"), next);
  assert.equal(await headFromFiles(join(root, "repo")), next, "a peer commit is seen without stale HEAD caching");
  rmSync(join(git, "refs", "heads", "main"));
  write(join(git, "packed-refs"), `# pack-refs with: peeled\n${sha} refs/heads/main\n^${next}\n`);
  assert.equal(await headFromFiles(join(root, "repo")), sha, "packed references resolve exactly");
  write(join(git, "HEAD"), next);
  assert.equal(await headFromFiles(join(root, "repo")), next, "detached HEAD is supported");
  const worktree = join(root, "linked");
  const metadata = join(git, "worktrees", "linked");
  mkdirSync(metadata, { recursive: true }); mkdirSync(worktree);
  write(join(worktree, ".git"), "gitdir: ../repo/.git/worktrees/linked\n");
  write(join(metadata, "commondir"), "../..\n");
  write(join(metadata, "HEAD"), "ref: refs/heads/main\n");
  assert.equal(await headFromFiles(worktree), sha, "linked worktrees read refs from their common directory");
  write(join(metadata, "HEAD"), "ref: refs/../../outside\n");
  assert.equal(await headFromFiles(worktree), undefined, "malformed references use the CLI fallback");
  write(join(metadata, "HEAD"), "ref: refs/heads/missing\n");
  assert.equal(await headFromFiles(worktree), undefined, "unborn or missing references are not invented");
  write(join(metadata, "HEAD"), "c".repeat(64));
  assert.equal(await headFromFiles(worktree), "c".repeat(64), "SHA-256 repositories are supported");
  const previous = process.env.GIT_DIR;
  process.env.GIT_DIR = git;
  try { assert.equal(await headFromFiles(worktree), undefined, "explicit Git environment selection stays with the CLI"); }
  finally { if (previous === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = previous; }
  assert.equal(await headFromFiles(root), undefined, "a parent workspace stays with normal nested-repo discovery");
  console.log("Git baseline metadata: nested workspaces, fresh commits, detached/packed refs, linked worktrees, SHA-256 and fallback guards passed.");
} finally { rmSync(root, { recursive: true, force: true }); }
