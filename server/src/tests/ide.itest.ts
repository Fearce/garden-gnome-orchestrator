import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, symlink, link } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import Fastify from "fastify";
import { IdeService, IdeError, MAX_FILE_BYTES, pathParts } from "../ide/service.js";
import { registerIdeRoutes } from "../ide/routes.js";
import { runGit, bustGitCaches } from "../gitService.js";
import { getRepoState, runRepoAction } from "../git/repoOps.js";

const base = await mkdtemp(join(tmpdir(), "ggo-ide-test-"));
const root = join(base, "workspace");
await mkdir(root);
const service = new IdeService({ listThreads: () => [], listCoworkSessions: () => [], kvGet: () => null }, root);
const app = Fastify();
registerIdeRoutes(app, service, cookie => cookie === "session=test");
let checks = 0;
async function test(name: string, fn: () => Promise<void> | void) { await fn(); console.log(`✓ ${name}`); checks++; }
const git = async (...args: string[]) => { const r = await runGit(root, args, 60_000); assert.equal(r.code, 0, `${args.join(" ")}: ${r.stderr}${r.timedOut ? " (timed out)" : ""}`); return r.stdout.trim(); };
try {
  const [workspace] = await service.workspaces(); assert.ok(workspace);
  const id = workspace.id;
  await test("cached root identity does not retain revoked workspace access", async () => {
    const other = join(base, "registered"); await mkdir(other); await writeFile(join(other, "file.txt"), "registered");
    let recent = JSON.stringify([other]);
    const restricted = new IdeService({ listThreads: () => [], listCoworkSessions: () => [], kvGet: () => recent }, root);
    const canonical = await realpath(other);
    const registered = (await restricted.workspaces()).find(w => w.path === canonical);
    assert.ok(registered); assert.equal((await restricted.read(registered.id, "file.txt")).text, "registered");
    recent = "[]";
    await assert.rejects(restricted.read(registered.id, "file.txt"), e => e instanceof IdeError && e.status === 403);
  });
  await writeFile(join(root, "sample.ts"), "const value = 1;\r\n");
  await test("registered workspace only, authenticated routes and cross-site refusal", async () => {
    assert.equal((await app.inject({ url: "/api/ide/workspaces" })).statusCode, 401);
    assert.equal((await app.inject({ url: "/api/ide/workspaces", headers: { cookie: "session=test" } })).statusCode, 200);
    assert.equal((await app.inject({ url: "/api/ide/workspaces", headers: { cookie: "session=test", origin: "https://evil.example" } })).statusCode, 403);
    assert.equal((await app.inject({ url: "/api/ide/workspaces", headers: { cookie: "session=test", "sec-fetch-site": "cross-site" } })).statusCode, 403);
    await assert.rejects(service.read("a".repeat(24), "sample.ts"), e => e instanceof IdeError && e.status === 403);
  });
  await test("reject traversal, NTFS aliases and Git metadata on every platform", async () => {
    for (const path of ["../outside", "/absolute", "a/../../b", "a\\b", "C:/outside", "file:stream", "a/./b", ".git/config", ".GIT/config", "a/", "a//b", "NUL", "x/COM1.txt", "file.", "file ", "x\0y"]) {
      assert.throws(() => pathParts(path), IdeError, path);
    }
    assert.deepEqual(pathParts("src/hello world.ts"), ["src", "hello world.ts"]);
    assert.equal((await app.inject({ url: `/api/ide/file?workspace=${id}&path=..%2Foutside`, headers: { cookie: "session=test" } })).statusCode, 400);
  });
  await test("atomic save preserves CRLF, Unicode and BOM; stale write leaves disk intact", async () => {
    const initial = await service.read(id, "sample.ts");
    assert.equal(initial.text, "const value = 1;\r\n");
    const next = await service.save(id, "sample.ts", "\ufeffconst value = 'æ';\r\n", initial.version);
    assert.equal((await service.read(id, "sample.ts")).text, next.text);
    await assert.rejects(service.save(id, "sample.ts", "stale", initial.version), e => e instanceof IdeError && e.status === 409);
    assert.equal(await readFile(join(root, "sample.ts"), "utf8"), next.text);
  });
  await test("competing browser writes serialize; exactly one wins", async () => {
    const file = await service.read(id, "sample.ts");
    const results = await Promise.allSettled([service.save(id, file.path, "first\n", file.version), service.save(id, file.path, "second\n", file.version)]);
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
    assert.equal(results.filter(r => r.status === "rejected").length, 1);
    const winner = results.find(r => r.status === "fulfilled");
    assert.equal(await readFile(join(root, file.path), "utf8"), winner?.status === "fulfilled" ? winner.value.text : "no winner");
  });
  await test("exclusive creation and deleted-file conflicts", async () => {
    await service.save(id, "new.txt", "new file", null);
    await assert.rejects(service.save(id, "new.txt", "replace", null));
    const file = await service.read(id, "new.txt");
    await rm(join(root, "new.txt"));
    await assert.rejects(service.save(id, "new.txt", "resurrect", file.version), e => e instanceof IdeError && e.status === 409);
    assert.equal((await app.inject({ method: "PUT", url: "/api/ide/file", headers: { cookie: "session=test" }, payload: { workspace: id, path: "new.txt", text: "created through API", version: null } })).statusCode, 200);
  });
  await test("binary, invalid UTF-8, oversized and hard-linked files are refused", async () => {
    await writeFile(join(root, "binary"), Buffer.from([1, 0, 3]));
    await writeFile(join(root, "invalid"), Buffer.from([0xff, 0xff]));
    await writeFile(join(root, "large"), "x".repeat(MAX_FILE_BYTES + 1));
    for (const p of ["binary", "invalid", "large"]) await assert.rejects(service.read(id, p));
    await link(join(root, "sample.ts"), join(root, "hardlink"));
    await assert.rejects(service.read(id, "hardlink"), e => e instanceof IdeError && e.status === 403);
    await rm(join(root, "hardlink"));
  });
  await test("junction escape is refused for tree, read, creation and search", async () => {
    const outside = join(base, "outside"); await mkdir(outside); await writeFile(join(outside, "secret.txt"), "private-needle");
    await symlink(outside, join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(service.tree(id, "escape"));
    await assert.rejects(service.read(id, "escape/secret.txt"));
    await assert.rejects(service.save(id, "escape/new.txt", "bad", null));
    assert.equal((await service.search(id, "private-needle", true)).hits.length, 0);
    assert.ok(!(await service.tree(id, "")).entries.some(e => e.name === "escape"));
  });
  await test("search reports line navigation and excludes build folders", async () => {
    await writeFile(join(root, "find.ts"), "first\nsearch needle\nlast\n");
    await mkdir(join(root, "node_modules")); await writeFile(join(root, "node_modules", "ignore.txt"), "search needle");
    assert.deepEqual((await service.search(id, "search needle", true)).hits.map(h => [h.path, h.line]), [["find.ts", 2]]);
    assert.ok((await service.search(id, "find", false)).hits.some(h => h.path === "find.ts"));
  });
  await test("real staging, unstaging, literal filenames and separate index/worktree diffs", async () => {
    await git("init", "--quiet"); await git("config", "user.name", "IDE Test"); await git("config", "user.email", "ide-test@example.com"); await git("config", "commit.gpgsign", "false"); await git("config", "core.autocrlf", "false");
    await writeFile(join(root, ".gitignore"), "binary\ninvalid\nlarge\nescape\nnode_modules\n");
    await git("add", "sample.ts", ".gitignore"); await git("commit", "--quiet", "-m", "initial");
    await writeFile(join(root, "sample.ts"), "staged value\n");
    assert.equal((await runRepoAction(root, { action: "stage", paths: ["sample.ts"] })).ok, true);
    await writeFile(join(root, "sample.ts"), "unstaged value\n");
    bustGitCaches();
    const state = await getRepoState(root);
    assert.ok(state.staged?.includes("sample.ts")); assert.ok(state.unstaged?.includes("sample.ts"));
    assert.match((await service.gitDiff(id, "sample.ts", true)).patch, /\+staged value/);
    assert.match((await service.gitDiff(id, "sample.ts", false)).patch, /\+unstaged value/);
    assert.equal((await runRepoAction(root, { action: "commitStaged", summary: "index only", description: "keep worktree edit" })).ok, true);
    assert.equal(await git("show", "HEAD:sample.ts"), "staged value");
    assert.equal(await readFile(join(root, "sample.ts"), "utf8"), "unstaged value\n");
    await writeFile(join(root, "[a].txt"), "literal filename"); await writeFile(join(root, "a.txt"), "must not stage");
    assert.equal((await runRepoAction(root, { action: "stage", paths: ["[a].txt"] })).ok, true);
    assert.deepEqual((await getRepoState(root)).staged, ["[a].txt"]);
    assert.equal((await runRepoAction(root, { action: "unstage", paths: ["[a].txt"] })).ok, true);
    assert.deepEqual((await getRepoState(root)).staged, []);
    assert.equal(await readFile(join(root, "[a].txt"), "utf8"), "literal filename");
  });
  await test("new commands reject pathspec/traversal; hooks remain enforced", async () => {
    for (const path of ["../outside", ":(glob)*", ".git/config", "--all"]) assert.equal((await runRepoAction(root, { action: "stage", paths: [path] })).ok, false);
    await runRepoAction(root, { action: "stage", paths: ["sample.ts"] });
    await writeFile(join(root, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    assert.equal((await runRepoAction(root, { action: "commitStaged", summary: "must fail", description: "" })).ok, false);
    assert.ok((await getRepoState(root)).staged?.includes("sample.ts"));
  });
  await test("merge and rebase conflicts can be aborted or resolved and continued", async () => {
    await rm(join(root, ".git", "hooks", "pre-commit"));
    await git("commit", "--quiet", "-m", "before conflicts");
    const branch = await git("branch", "--show-current");
    const anchor = await git("rev-parse", "HEAD");
    await git("checkout", "-b", "conflicting");
    await writeFile(join(root, "sample.ts"), "feature version\n"); await git("add", "sample.ts"); await git("commit", "--quiet", "-m", "feature");
    await git("checkout", branch);
    await writeFile(join(root, "sample.ts"), "main version\n"); await git("add", "sample.ts"); await git("commit", "--quiet", "-m", "main");
    assert.equal((await runGit(root, ["merge", "conflicting"], 60_000)).code, 1);
    assert.equal((await getRepoState(root)).operation, "merge");
    assert.equal((await runRepoAction(root, { action: "continueOperation" })).ok, false);
    assert.equal((await runRepoAction(root, { action: "abortOperation" })).ok, true);
    assert.equal((await getRepoState(root)).operation, null);
    assert.equal(await readFile(join(root, "sample.ts"), "utf8"), "main version\n");
    assert.equal((await runGit(root, ["merge", "conflicting"], 60_000)).code, 1);
    await writeFile(join(root, "sample.ts"), "merged version\n"); await runRepoAction(root, { action: "stage", paths: ["sample.ts"] });
    assert.equal((await runRepoAction(root, { action: "continueOperation" })).ok, true);
    assert.equal((await getRepoState(root)).operation, null);
    await git("checkout", "-b", "rebase-conflict", anchor);
    await writeFile(join(root, "sample.ts"), "rebase version\n"); await git("add", "sample.ts"); await git("commit", "--quiet", "-m", "rebasing");
    assert.equal((await runGit(root, ["rebase", branch], 60_000)).code, 1);
    assert.equal((await getRepoState(root)).operation, "rebase");
    assert.equal((await runRepoAction(root, { action: "abortOperation" })).ok, true);
    assert.equal(await git("branch", "--show-current"), "rebase-conflict");
    assert.equal((await runGit(root, ["rebase", branch], 60_000)).code, 1);
    await writeFile(join(root, "sample.ts"), "rebased resolution\n"); await runRepoAction(root, { action: "stage", paths: ["sample.ts"] });
    const continued = await runRepoAction(root, { action: "continueOperation" });
    assert.equal(continued.ok, true, continued.message);
    assert.equal((await getRepoState(root)).operation, null);
  });
  console.log(`${checks} IDE/API/security/Git integration scenarios passed.`);
} finally {
  await app.close();
  // The temp directory is fixed by mkdtemp and confined before recursive cleanup.
  assert.ok(resolve(base).startsWith(resolve(tmpdir())) && base.includes("ggo-ide-test-"));
  await rm(base, { recursive: true, force: true });
}
