// The self-update's blocker check. Run: npx tsx src/tests/updateBlocker.test.ts
//
// The Update badge runs `git pull --ff-only` in the live checkout. When an uncommitted edit sat on a
// file the upstream had also changed, every click failed the same way and the only explanation was
// git's stderr in a hover tooltip (2026-09-25: three orphaned rule-file edits held the live checkout 25
// commits behind all day). `gitStatusAt` now names those files in `blockedBy`, and `applyUpdate`
// refuses with them before pulling.
//
// The property under test is that the prediction agrees with git: every case below also runs the real
// `git pull --ff-only` and asserts it fails exactly when `blockedBy` is non-empty. Reporting dirt git
// would happily carry across would refuse an update that works, so the non-overlapping case matters as
// much as the overlapping ones.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stopChildRunner } from "../childRunner.js";
import { gitStatusAt, updateBlocker } from "../update.js";

const root = mkdtempSync(join(tmpdir(), "ggo-update-blocker-"));
// The owner's global core.hooksPath runs a real validation suite on every commit and push (~3s each).
const noHooks = join(root, "no-hooks");
mkdirSync(noHooks);

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, "-c", "user.email=gate@example.com", "-c", "user.name=gate", "-c", `core.hooksPath=${noHooks}`, ...args], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

function pullSucceeds(cwd: string): boolean {
  const r = spawnSync("git", ["-C", cwd, "-c", `core.hooksPath=${noHooks}`, "pull", "--ff-only"], { encoding: "utf8", windowsHide: true });
  return r.status === 0;
}

function write(repo: string, path: string, text: string): void {
  writeFileSync(join(repo, path), text);
}

let n = 0;
/** A fresh origin, a "live" clone of it, and an upstream that has moved on by one commit touching
 *  `shared.md` (modified) and `added.md` (new). `quiet.md` is left alone upstream. */
function scenario(): { live: string } {
  const dir = join(root, `case-${++n}`);
  const origin = join(dir, "origin.git");
  const seed = join(dir, "seed");
  mkdirSync(dir);
  execFileSync("git", ["init", "--bare", "-q", "-b", "master", origin], { windowsHide: true });
  execFileSync("git", ["-c", `core.hooksPath=${noHooks}`, "clone", "-q", "--config", "core.autocrlf=false", origin, seed], { windowsHide: true });
  write(seed, "shared.md", "one\n");
  write(seed, "quiet.md", "one\n");
  git(seed, "add", "shared.md", "quiet.md");
  git(seed, "commit", "-q", "-m", "seed");
  git(seed, "push", "-q", "origin", "HEAD:master");
  const live = join(dir, "live");
  execFileSync("git", ["-c", `core.hooksPath=${noHooks}`, "clone", "-q", "--config", "core.autocrlf=false", origin, live], { windowsHide: true });
  write(seed, "shared.md", "two\n");
  write(seed, "added.md", "new\n");
  git(seed, "add", "shared.md", "added.md");
  git(seed, "commit", "-q", "-m", "upstream moves on");
  git(seed, "push", "-q", "origin", "HEAD:master");
  git(live, "fetch", "-q");
  return { live };
}

async function expectBlocked(name: string, live: string, expected: string[]): Promise<void> {
  const status = await gitStatusAt(live);
  assert.equal(status.behind, 1, `${name}: the live clone should be one commit behind`);
  assert.deepEqual(status.blockedBy, expected, `${name}: blockedBy`);
  assert.equal(pullSucceeds(live), expected.length === 0, `${name}: git pull --ff-only should ${expected.length ? "fail" : "succeed"}`);
  console.log(`  ok  ${name}`);
}

try {
  {
    const { live } = scenario();
    await expectBlocked("a clean checkout is not blocked", live, []);
  }
  {
    const { live } = scenario();
    write(live, "quiet.md", "local edit\n");
    await expectBlocked("an edit to a file the upstream leaves alone does not block", live, []);
  }
  {
    const { live } = scenario();
    write(live, "shared.md", "local edit\n");
    write(live, "quiet.md", "local edit\n");
    await expectBlocked("an unstaged edit to a file the upstream changed blocks, and only that file is named", live, ["shared.md"]);
  }
  {
    const { live } = scenario();
    write(live, "shared.md", "local edit\n");
    git(live, "add", "shared.md");
    await expectBlocked("a staged edit blocks too", live, ["shared.md"]);
  }
  {
    const { live } = scenario();
    unlinkSync(join(live, "shared.md"));
    await expectBlocked("an unstaged deletion does not block (git checks the new version out)", live, []);
  }
  {
    const { live } = scenario();
    git(live, "rm", "-q", "shared.md");
    await expectBlocked("a staged deletion of a file the upstream changed blocks", live, ["shared.md"]);
  }
  {
    const { live } = scenario();
    write(live, "added.md", "mine\n");
    await expectBlocked("an untracked file where the upstream adds one blocks", live, ["added.md"]);
  }
  {
    const { live } = scenario();
    write(live, "scratch.md", "mine\n");
    await expectBlocked("an unrelated untracked file does not block", live, []);
  }

  // The message names the files and says what to do; a diverged branch gets its own reason.
  {
    const { live } = scenario();
    write(live, "shared.md", "local edit\n");
    write(live, "added.md", "mine\n");
    const message = updateBlocker(await gitStatusAt(live), live);
    assert.ok(message, "a blocked status must produce a message");
    assert.match(message, /^2 files have uncommitted changes/);
    assert.match(message, /added\.md, shared\.md/);
    assert.match(message, /Commit, stash or discard them/);
    assert.ok(message.includes(live), "the message names the checkout to fix");
    console.log("  ok  the refusal names the files and the remedy");
  }
  {
    const { live } = scenario();
    write(live, "quiet.md", "local commit\n");
    git(live, "commit", "-q", "-am", "local only");
    const status = await gitStatusAt(live);
    assert.equal(status.ahead, 1);
    assert.equal(status.behind, 1);
    assert.equal(pullSucceeds(live), false, "a diverged branch cannot fast-forward");
    const message = updateBlocker(status, live);
    assert.ok(message && /1 local commit that the upstream does not/.test(message), `diverged message: ${message}`);
    console.log("  ok  a diverged checkout is refused with its own reason");
  }
  {
    const { live } = scenario();
    assert.equal(updateBlocker(await gitStatusAt(live), live), null);
    console.log("  ok  nothing in the way means no refusal");
  }
  {
    const { live } = scenario();
    git(live, "pull", "-q", "--ff-only");
    write(live, "shared.md", "local edit after updating\n");
    const status = await gitStatusAt(live);
    assert.equal(status.behind, 0);
    assert.deepEqual(status.blockedBy, [], "an up-to-date checkout has nothing to block");
    console.log("  ok  dirt on an up-to-date checkout is not reported as a blocker");
  }
  console.log("\nupdate blocker: all checks passed");
} finally {
  await stopChildRunner();
  rmSync(root, { recursive: true, force: true });
}
