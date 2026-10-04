// Patch notes read from git. Run: npx tsx src/tests/patchNotes.test.ts
//
// The console's Patch notes area is the checkout's own Conventional-Commit history. Two things must hold
// against a real repo: commits are classified the way an operator reads them (feat → feature, fix → fix,
// docs/test/chore → internal, trailers never shown), and the upstream commits an update would bring in are
// listed separately from what this checkout already has, with paging that never drops or repeats a commit.
// A busy day's digest is built from the commits git holds for the shas asked about, never from client
// text, needs five operator-facing changes, waits until the day has ended in the viewer's timezone, and is
// asked of the model once per commit set.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stopChildRunner } from "../childRunner.js";
import { classifyCommit, readPatchNotes } from "../patchNotes.js";
import { cleanDigest, dayIn, digestRequest, digestShas, PatchNoteDigests } from "../patchNoteDigest.js";

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

/** A commit stamped at `iso`, so a digest's day is fixed rather than whenever the gate happens to run. */
function commitAt(repo: string, message: string, iso: string): string {
  writeFileSync(join(repo, "file.txt"), `${++counter}\n`);
  git(repo, "add", "file.txt");
  execFileSync("git", ["-C", repo, "-c", "user.email=gate@example.com", "-c", "user.name=gate", "-c", `core.hooksPath=${noHooks}`, "commit", "-q", "-m", message], {
    env: { ...process.env, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso },
    windowsHide: true,
  });
  return git(repo, "rev-parse", "HEAD");
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
  const freeForm = classifyCommit("Replace Sam with the user across codebase", "");
  assert.deepEqual([freeForm.kind, freeForm.type, freeForm.summary], ["other", null, "Replace Sam with the user across codebase"]);
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

/** The digest reads the commits itself, skips internal ones, refuses a quiet day and a day still in
 *  progress, and caches per set. The commits sit late on 30 September in Copenhagen (UTC+2), which is
 *  already 1 October in Tokyo. */
async function dayDigest(): Promise<void> {
  const repo = join(root, "digest");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "master");
  const facing = ["feat(board): hide done tasks", "fix: stop the chip overlap", "perf: faster board load", "feat(goals): keep one session", "fix(web): wrap the header"].map((m, i) =>
    commitAt(repo, m, `2026-09-30T20:0${i}:00Z`),
  );
  const internal = commitAt(repo, "docs: write it down", "2026-09-30T20:10:00Z");
  const nextDay = commitAt(repo, "feat: the day after", "2026-10-01T09:00:00Z");
  const tz = "Europe/Copenhagen";
  const day = "2026-09-30";
  assert.equal(dayIn(Date.parse("2026-09-30T21:59:59Z"), tz), day);
  assert.equal(dayIn(Date.parse("2026-09-30T22:00:00Z"), tz), "2026-10-01", "a day is the viewer's calendar day, not UTC's");

  const kv = new Map<string, string>();
  const store = { get: (k: string) => kv.get(k) ?? null, set: (k: string, v: string) => void kv.set(k, v) };
  const asked: string[] = [];
  let now = Date.parse("2026-09-30T21:30:00Z");
  const digests = new PatchNoteDigests(store, async (changes) => (asked.push(changes), "Board and goal polish with three fixes"), repo, () => now);
  const ask = (shas: string[], on = day, timeZone = tz) => digests.digest({ shas, day: on, timeZone });

  const today = await ask([...facing, internal]);
  assert.equal(today.ok ? null : today.status, 409, "today is not summarized while it is still going, however busy");
  assert.equal(asked.length, 0, "today never reaches the model");
  assert.equal((await ask([nextDay], "2026-10-01")).ok, false, "nor is a day after today");

  // Midnight passes in Copenhagen while the same instance keeps running.
  now = Date.parse("2026-09-30T22:00:01Z");
  const quiet = await ask([...facing.slice(0, 4), internal]);
  assert.deepEqual(quiet.ok ? null : quiet.status, 422, "four operator-facing changes plus an internal one is not a busy day");
  assert.equal(asked.length, 0, "a quiet day never reaches the model");

  const [a, b] = await Promise.all([ask([...facing, internal]), ask([internal, ...facing].reverse())]);
  assert.deepEqual(a, { ok: true, summary: "Board and goal polish with three fixes." }, "the day is summarized once it has ended, without a restart");
  assert.deepEqual(b, a, "the same set in another order is the same day");
  assert.equal(asked.length, 1, "concurrent asks for one day share one model call");
  assert.match(asked[0]!, /- New \(board\): Hide done tasks/);
  assert.ok(!asked[0]!.includes("Write it down"), "internal commits stay out of the overview");

  now = Date.parse("2026-10-05T12:00:00Z");
  assert.deepEqual(await ask([...facing, internal]), a, "a later render or poll reuses the digest");
  assert.equal(asked.length, 1, "...without asking the model again");
  const reread = new PatchNoteDigests(store, async () => assert.fail("a cached day must not call the model again"), repo, () => now);
  assert.deepEqual(await reread.digest({ shas: [...facing, internal], day, timeZone: tz }), a, "the digest survives a restart via the store");

  const tokyo = await ask([...facing.slice(1), internal, nextDay], day, "Asia/Tokyo");
  assert.equal(tokyo.ok ? null : tokyo.status, 422, "commits that are not all from the named day in that timezone are refused");
  const mixed = await ask([...facing.slice(1), nextDay]);
  assert.equal(mixed.ok ? null : mixed.status, 422, "a set that spills into another day is refused");
  const unknown = await ask([...facing.slice(1), "0".repeat(40)]);
  assert.equal(unknown.ok ? null : unknown.status, 422, "a sha this checkout lacks is refused");
  assert.equal(asked.length, 1, "no refused request reaches the model");

  const noAnswer = await new PatchNoteDigests({ get: () => null, set: () => assert.fail("a failure is not cached") }, async () => null, repo, () => now).digest({ shas: facing, day, timeZone: tz });
  assert.equal(noAnswer.ok ? null : noAnswer.status, 502);

  assert.equal(digestShas([facing[0], facing[0]])?.length, 1);
  for (const bad of [[], ["HEAD"], [facing[0]!.toUpperCase()], ["--all"], "abc", [1]]) assert.equal(digestShas(bad), null, JSON.stringify(bad));
  assert.deepEqual(digestRequest({ shas: [facing[0]], day, timeZone: tz }), { shas: [facing[0]], day, timeZone: tz });
  const sha = facing[0];
  for (const bad of [{ shas: [sha], day }, { shas: [sha], timeZone: tz }, { shas: [sha], day: "30/09/2026", timeZone: tz }, { shas: [sha], day, timeZone: "Mars/Olympus" }, null]) {
    assert.equal(digestRequest(bad), null, JSON.stringify(bad));
  }
  assert.equal(cleanDigest("I can't summarize this"), null);
  assert.equal(cleanDigest("This is not a coding task"), null);
  assert.equal(cleanDigest("Mostly fixes!"), "Mostly fixes!");
  console.log("  ok  a busy day's digest comes from git, needs five changes, waits for the day to end and is asked once per set");
}

try {
  classification();
  await dayDigest();
  await historyAndUpcoming();
  await notACheckout();
  await pendingByPath();
  console.log("patch notes: all checks passed");
} finally {
  await stopChildRunner();
  rmSync(root, { recursive: true, force: true });
}
