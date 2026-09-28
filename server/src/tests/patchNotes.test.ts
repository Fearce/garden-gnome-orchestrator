// Patch notes read from git. Run: npx tsx src/tests/patchNotes.test.ts
//
// The console's Patch notes area is the checkout's own Conventional-Commit history. Two things must hold
// against a real repo: commits are classified the way an operator reads them (feat → feature, fix → fix,
// docs/test/chore → internal, trailers never shown), and the upstream commits an update would bring in are
// listed separately from what this checkout already has, with paging that never drops or repeats a commit.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stopChildRunner } from "../childRunner.js";
import { classifyCommit, readPatchNotes } from "../patchNotes.js";

const root = mkdtempSync(join(tmpdir(), "ggo-patch-notes-"));
// The owner's global core.hooksPath runs a real validation suite on every commit and push (~3s each).
const noHooks = join(root, "no-hooks");
mkdirSync(noHooks);

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, "-c", "user.email=gate@example.com", "-c", "user.name=gate", "-c", `core.hooksPath=${noHooks}`, ...args], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

let counter = 0;
function commit(repo: string, message: string): void {
  writeFileSync(join(repo, "file.txt"), `${++counter}\n`);
  git(repo, "add", "file.txt");
  git(repo, "commit", "-q", "-m", message);
}

function commitPath(repo: string, path: string, message: string): string {
  mkdirSync(join(repo, path, ".."), { recursive: true });
  writeFileSync(join(repo, path), `${++counter}
`);
  git(repo, "add", path);
  git(repo, "commit", "-q", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

/** "Not live yet" means the running build lacks the change, so it is keyed on WHAT a commit touched: a web
 *  fix the auto-builder already bundled, or a docs commit, is live even though the server was not rebuilt. */
async function pendingByPath(): Promise<void> {
  const repo = join(root, "pending");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "master");
  const built = commitPath(repo, "server/src/a.ts", "feat: built into both");
  const web = commitPath(repo, "web/src/b.tsx", "fix(web): bundled by the auto-builder");
  const docs = commitPath(repo, "docs/c.md", "docs: no build needed");
  const serverTest = commitPath(repo, "server/src/tests/d.test.ts", "test: compiled but never run");
  const server = commitPath(repo, "server/src/e.ts", "fix: needs a deploy");
  const webLater = commitPath(repo, "web/src/f.tsx", "fix(web): not bundled yet");

  const page = await readPatchNotes({ cwd: repo, serverBuild: built, webBuild: server });
  assert.deepEqual(new Set(page.pending), new Set([server, webLater]), "only runtime changes above their own build are pending");
  for (const live of [built, web, docs, serverTest]) assert.ok(!page.pending.includes(live), "a change the running build already has, or needs no build, is live");

  const unknown = await readPatchNotes({ cwd: repo, serverBuild: null, webBuild: "0000000000000000000000000000000000000000" });
  assert.deepEqual(unknown.pending, [], "no stamp, or one git cannot reach, reads as unknown rather than everything pending");
  assert.deepEqual((await readPatchNotes({ cwd: repo, skip: 1, serverBuild: built, webBuild: built })).pending, [], "pending rides the first page only");
  console.log("  ok  \"not live yet\" is keyed on the build each commit's paths feed");
}

function classification(): void {
  const feat = classifyCommit("feat(web): dock the header under the composer", "Body line.\n\nCo-Authored-By: Someone <x@y>\nSigned-off-by: A <a@b>");
  assert.deepEqual(feat, { kind: "feature", type: "feat", scope: "web", breaking: false, summary: "Dock the header under the composer", body: "Body line." });
  assert.equal(classifyCommit("fix: stop a crash", "").kind, "fix");
  assert.equal(classifyCommit("perf(dispatch): faster", "").kind, "perf");
  for (const internal of ["docs: x", "test(labs): x", "chore(probe): x", "refactor: x", "style: x", "build: x", "ci: x"]) {
    assert.equal(classifyCommit(internal, "").kind, "internal", internal);
  }
  const breaking = classifyCommit("feat(api)!: rename the route", "");
  assert.equal(breaking.breaking, true);
  assert.equal(classifyCommit("fix: y", "Details\n\nBREAKING CHANGE: the old flag is gone").breaking, true);
  const freeForm = classifyCommit("Replace Mikkel with the user across codebase", "");
  assert.deepEqual([freeForm.kind, freeForm.type, freeForm.summary], ["other", null, "Replace Mikkel with the user across codebase"]);
  assert.equal(classifyCommit("wip(thing): unknown type", "").kind, "other");
  console.log("  ok  commits are classified by Conventional-Commit type, trailers stripped");
}

async function historyAndUpcoming(): Promise<void> {
  const origin = join(root, "origin.git");
  const live = join(root, "live");
  const seed = join(root, "seed");
  execFileSync("git", ["init", "--bare", "-q", "-b", "master", origin], { windowsHide: true });
  execFileSync("git", ["-c", `core.hooksPath=${noHooks}`, "clone", "-q", origin, seed], { windowsHide: true });
  commit(seed, "feat: first feature");
  commit(seed, "docs: write it down");
  commit(seed, "fix(web): a bug");
  git(seed, "push", "-q", "origin", "HEAD:master");
  execFileSync("git", ["-c", `core.hooksPath=${noHooks}`, "clone", "-q", origin, live], { windowsHide: true });
  commit(seed, "feat(goals): upstream only");
  git(seed, "push", "-q", "origin", "HEAD:master");
  git(live, "fetch", "-q");

  const page = await readPatchNotes({ cwd: live });
  assert.equal(page.error, null);
  assert.equal(page.head, git(live, "rev-parse", "HEAD"));
  assert.equal(page.branch, "master");
  assert.deepEqual(page.entries.map((e) => e.summary), ["A bug", "Write it down", "First feature"]);
  assert.deepEqual(page.entries.map((e) => e.kind), ["fix", "internal", "feature"]);
  assert.equal(page.hasMore, false);
  assert.deepEqual(page.upcoming.map((e) => e.summary), ["Upstream only"], "upstream commits are listed apart from local history");
  assert.ok(page.entries.every((e) => e.at > 0 && e.short.length >= 7));
  console.log("  ok  local history and upcoming upstream commits are read separately");

  const first = await readPatchNotes({ cwd: live, limit: 2 });
  const second = await readPatchNotes({ cwd: live, skip: 2, limit: 2 });
  assert.equal(first.hasMore, true);
  assert.equal(second.hasMore, false);
  assert.deepEqual(second.upcoming, [], "upcoming rides the first page only");
  assert.deepEqual([...first.entries, ...second.entries].map((e) => e.sha), page.entries.map((e) => e.sha), "paging drops or repeats nothing");
  console.log("  ok  paging covers the history exactly once");
}

async function notACheckout(): Promise<void> {
  const plain = join(root, "plain");
  mkdirSync(plain);
  const page = await readPatchNotes({ cwd: plain });
  assert.ok(page.error, "a folder outside git reports why there is no history");
  assert.deepEqual(page.entries, []);
  console.log("  ok  an install outside git explains itself instead of throwing");
}

try {
  classification();
  await historyAndUpcoming();
  await notACheckout();
  await pendingByPath();
  console.log("patch notes: all checks passed");
} finally {
  await stopChildRunner();
  rmSync(root, { recursive: true, force: true });
}
