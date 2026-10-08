import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { runGit } from "../gitService.js";
import { runRepoAction } from "../git/repoOps.js";
import { withGitTransaction } from "../git/transaction.js";

const exec = promisify(execFile);
const wrapper = fileURLToPath(new URL("../../scripts/git-transaction.cjs", import.meta.url));
const { isGitWrite } = createRequire(import.meta.url)(wrapper);
const { integrate } = createRequire(import.meta.url)("../../scripts/git-integrate.cjs");
const root = await mkdtemp(join(tmpdir(), "ggo-git-transactions-"));
const repo = join(root, "repo"), tree = join(root, "task"), other = join(root, "other");
async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec("git", args, { cwd, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" } })).stdout.trim();
}
async function init(cwd: string) {
  await mkdir(cwd);
  await git(cwd, "init", "-b", "main");
  await git(cwd, "config", "user.name", "Test Agent");
  await git(cwd, "config", "user.email", "agent@example.com");
  await git(cwd, "config", "core.hooksPath", join(root, "no-hooks"));
  await writeFile(join(cwd, "base.txt"), "base\n");
  await git(cwd, "add", "--", "base.txt");
  await git(cwd, "commit", "-m", "test: base", "--", "base.txt");
}
let checks = 0;
function check(label: string, fn: () => void) { fn(); checks++; console.log(`PASS ${label}`); }
try {
  await init(repo); await init(other);
  await git(repo, "worktree", "add", "-b", "task", tree);
  // Everyone's paths are staged before anyone commits. Each transaction must exclude
  // all seven peer paths while every process contends for the same real Git index.
  const paths = Array.from({ length: 8 }, (_, i) => `agent-${i}.txt`);
  for (const p of paths) await writeFile(join(repo, p), p + "\n");
  await git(repo, "add", "--", ...paths);
  await Promise.all(paths.map((p, i) => exec(process.execPath, [wrapper, "--repo", repo, "--", "git", "commit", "--only", "-m", `test: agent ${i}`, "--", p], { windowsHide: true, timeout: 120_000 })));
  for (let i = 0; i < paths.length; i++) {
    const hash = await git(repo, "log", "-1", "--format=%H", `--grep=^test: agent ${i}$`);
    assert.match(hash, /^[a-f0-9]{40,64}$/);
    const landed = await git(repo, "show", "--format=", "--name-only", hash);
    check(`concurrent agent ${i} commits exactly its reviewed path`, () => assert.equal(landed, paths[i]));
  }
  const status = await git(repo, "status", "--porcelain");
  check("eight concurrent commits leave no staged peer work", () => assert.equal(status, ""));

  const holderScript = join(root, "holder.cjs");
  await writeFile(holderScript, `const {withGitTransaction}=require(${JSON.stringify(wrapper)});withGitTransaction(process.argv[2],async()=>{console.log('LOCKED');await new Promise(r=>process.stdin.once('data',r));process.stdin.destroy();}).catch(e=>{console.error(e);process.exitCode=1;});`);
  async function startHolder() {
    const child = spawn(process.execPath, [holderScript, repo], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const closed = new Promise<void>(res => child.once("close", () => res()));
    await new Promise<void>((res, rej) => { child.stdout.once("data", () => res()); child.once("error", rej); child.once("exit", () => rej(new Error("holder exited before locking"))); });
    return { child, closed };
  }

  let entered = false;
  const holding = await startHolder();
  let pendingWriter: Promise<void> | undefined;
  try {
    // CLI and server share the lock, including linked worktrees; unrelated repos and
    // Git reads remain usable while a writer waits. No timing assertion under load.
    const pending = withGitTransaction(tree, async () => { entered = true; });
    await withGitTransaction(other, async () => {});
    const read = await runGit(repo, ["status", "--porcelain"]);
    check("read-only server Git bypasses a held writer transaction", () => assert.equal(read.code, 0));
    check("linked-worktree writer waits for the shared transaction", () => assert.equal(entered, false));
    const busy = await exec(process.execPath, [wrapper, "--repo", tree, "--timeout-ms", "30", "--", "git", "status"], { windowsHide: true }).then(() => 0, e => Number(e.code));
    check("bounded CLI queue wait reports busy exit 75", () => assert.equal(busy, 75));
    // This waiter must run only after the outer callback releases the lock.
    pendingWriter = pending;
  } finally { holding.child.stdin.end("release\n"); await holding.closed; }
  await pendingWriter;
  check("queued worktree transaction resumes after release", () => assert.equal(entered, true));

  const crashed = await startHolder();
  crashed.child.kill("SIGKILL"); await crashed.closed;
  const recovered = await exec(process.execPath, [wrapper, "--repo", repo, "--timeout-ms", "1000", "--", "git", "status", "--porcelain"], { windowsHide: true });
  check("killed lock owner requires no stale-file cleanup", () => assert.equal(recovered.stdout.trim(), ""));

  await writeFile(join(repo, "native.txt"), "native\n");
  await git(repo, "add", "--", "native.txt");
  const nativeLock = join(repo, ".git", "index.lock");
  await writeFile(nativeLock, "foreign git lock\n");
  // Refuse while ownership is uncertain. A ten-minute wait lets the fixture age into
  // the separately verified abandoned-lock recovery policy instead of testing refusal.
  const refusal = await exec(process.execPath, [wrapper, "--repo", repo, "--timeout-ms", "1000", "--", "git", "commit", "--only", "-m", "test: native", "--", "native.txt"], { windowsHide: true }).then(() => false, error => {
    assert.equal(error.code, 75);
    assert.match(error.stderr, /timed out waiting for a native index lock/);
    return true;
  });
  check("non-cooperating native Git lock is respected", () => assert.equal(refusal, true));
  assert.equal(await readFile(nativeLock, "utf8"), "foreign git lock\n");
  await rm(nativeLock); // Fixture owns this lock; production code never removes it.
  const saved = await runRepoAction(repo, { action: "commit", summary: "test: console", description: "", paths: ["native.txt"] });
  check("console multi-step commit uses a reentrant server transaction", () => assert.equal(saved.ok, true, saved.message));
  await writeFile(join(tree, "task.txt"), "task\n");
  await git(tree, "add", "--", "task.txt"); await git(tree, "commit", "-m", "test: task", "--", "task.txt");
  const receipt = await integrate(repo, tree);
  check("integration rebases and fast-forwards to one immutable receipt", () => assert.match(receipt.commit, /^[a-f0-9]{40,64}$/));
  assert.equal(await git(repo, "rev-parse", "HEAD"), await git(tree, "rev-parse", "HEAD"));
  await writeFile(join(repo, "peer.txt"), "peer\n");
  await assert.rejects(integrate(repo, tree), /Review and commit pending changes/);
  const peerContent = await readFile(join(repo, "peer.txt"), "utf8");
  check("dirty peer work blocks integration without being discarded", () => assert.equal(peerContent, "peer\n"));
  for (const args of [["status"], ["-c", "core.quotepath=false", "diff"], ["worktree", "list", "--porcelain"], ["config", "--get", "user.name"]]) check(`read classification ${args.join(" ")}`, () => assert.equal(isGitWrite(args), false));
  for (const args of [["commit"], ["-c", "core.editor=true", "rebase", "--continue"], ["worktree", "add", "path"], ["branch", "new-branch"], ["config", "user.name", "Agent"]]) check(`write classification ${args.join(" ")}`, () => assert.equal(isGitWrite(args), true));
  console.log(`${checks} Git transaction checks passed`);
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
