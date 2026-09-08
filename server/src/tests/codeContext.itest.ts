import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodeContextService, repoPrefixOf } from "../orchestrator/codeContext.js";
import { IdeService } from "../ide/service.js";
import { runGit, bustGitCaches } from "../gitService.js";
import type { CoworkSession, Thread } from "../types.js";

/**
 * The contextual-navigation resolver, against real directories and real git repositories.
 *
 * Two properties matter more than the happy path, and both are asserted here:
 *  - a route is offered ONLY when it can actually be taken (a repo above the workspace has no
 *    in-workspace path, so `repoPrefix` is null and the console must not construct one), and
 *  - a `workspace` subject is a path FROM THE BROWSER, so it resolves only for a folder GGO already
 *    works in. Without that check this command reads any directory's git remote state.
 *
 * Run: npm run test:code-context --prefix server
 */

const base = await mkdtemp(join(tmpdir(), "ggo-codectx-"));
let checks = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  await fn();
  console.log(`✓ ${name}`);
  checks++;
}

const norm = (p: string): string => p.replace(/\\/g, "/");

const git = async (cwd: string, ...args: string[]) => {
  const r = await runGit(cwd, args, 60_000);
  assert.equal(r.code, 0, `${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

/** A repository with one commit, at `dir`. */
async function makeRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await git(dir, "init", "-b", "work");
  await git(dir, "config", "user.email", "gate@example.invalid");
  await git(dir, "config", "user.name", "Gate");
  await writeFile(join(dir, "file.txt"), "one\n");
  await git(dir, "add", "-A");
  await git(dir, "commit", "-m", "first");
}

/** Git reports a repo root with forward slashes even on Windows, while a realpath keeps the native
 *  separator — the console passes both straight back to commands that accept either, so comparisons
 *  here normalize rather than pretending one form wins. */
const samePath = async (actual: string | null, expected: string) =>
  assert.equal(norm(actual ?? ""), norm(await realpath(expected)));

const thread = (id: string, workspace: string): Thread =>
  ({ id, workspace, title: id, state: "done" }) as unknown as Thread;
const session = (id: string, workspace: string): CoworkSession =>
  ({ id, workspace, name: id }) as unknown as CoworkSession;

/** The service under test, wired to exactly the records this scenario claims. */
function build(input: { threads?: Thread[]; sessions?: CoworkSession[]; self: string; now?: () => number }) {
  const threads = input.threads ?? [];
  const sessions = input.sessions ?? [];
  const ide = new IdeService(
    { listThreads: () => threads, listCoworkSessions: () => sessions, kvGet: () => null },
    input.self,
  );
  const db = {
    getThread: (id: string) => threads.find((t) => t.id === id) ?? null,
    getCoworkSession: (id: string) => sessions.find((s) => s.id === id) ?? null,
  };
  return new CodeContextService(db, ide, input.now);
}

try {
  const self = join(base, "self");
  await mkdir(self);

  await test("a task in a checkout resolves branch, repo and an IDE workspace id", async () => {
    const workspace = join(base, "plain");
    await makeRepo(workspace);
    const t = thread("t-plain", workspace);
    const service = build({ threads: [t], self });

    const context = await service.resolve({ kind: "thread", id: t.id });
    await samePath(context.workspace, workspace);
    await samePath(context.repoPath, workspace);
    assert.equal(context.repoPrefix, "", "workspace IS the checkout");
    assert.equal(context.branch, "work");
    assert.equal(context.detached, false);
    assert.equal(context.error, null);
    assert.ok(context.ideWorkspaceId, "the IDE must be able to open a registered workspace");
    assert.equal(context.repoName, "plain");
  });

  await test("a workspace that is the PARENT of its checkout reports the nested prefix", async () => {
    const workspace = join(base, "parent");
    await mkdir(workspace);
    await makeRepo(join(workspace, "service"));
    const t = thread("t-parent", workspace);
    const service = build({ threads: [t], self });

    const context = await service.resolve({ kind: "thread", id: t.id });
    assert.equal(context.repoPrefix, "service", "a repo-relative file lives under this prefix");
    assert.equal(context.repoName, "service");
    assert.equal(context.branch, "work");
  });

  await test("a checkout ABOVE the workspace yields no prefix — the console must not invent one", async () => {
    const repo = join(base, "outer");
    await makeRepo(repo);
    const workspace = join(repo, "packages");
    await mkdir(workspace);
    const t = thread("t-inner", workspace);
    const service = build({ threads: [t], self });

    const context = await service.resolve({ kind: "thread", id: t.id });
    await samePath(context.repoPath, repo);
    assert.equal(context.repoPrefix, null, "no in-workspace path exists for a repo-relative file");
    // Still openable in the editor: the workspace itself is a perfectly good folder.
    assert.ok(context.ideWorkspaceId);
  });

  await test("uncommitted work, unpushed commits and a detached HEAD are reported as such", async () => {
    const workspace = join(base, "dirty");
    await makeRepo(workspace);
    await writeFile(join(workspace, "file.txt"), "two\n");
    const t = thread("t-dirty", workspace);
    const service = build({ threads: [t], self });

    const dirty = await service.resolve({ kind: "thread", id: t.id });
    assert.equal(dirty.hasUncommitted, true);
    assert.equal(dirty.unpushed, 0, "no push remote is configured, so nothing is pending a push");
    assert.equal(dirty.pushState, "no-remote");

    await git(workspace, "checkout", "--detach", "HEAD");
    bustGitCaches();
    const detached = await build({ threads: [t], self }).resolve({ kind: "thread", id: t.id });
    assert.equal(detached.detached, true);
    assert.equal(detached.branch, null);
  });

  await test("a co-work session resolves through its own workspace", async () => {
    const workspace = join(base, "cowork");
    await makeRepo(workspace);
    const s = session("cw-1", workspace);
    const service = build({ sessions: [s], self });

    const context = await service.resolve({ kind: "cowork", id: s.id });
    assert.equal(context.kind, "cowork");
    await samePath(context.repoPath, workspace);
    assert.ok(context.ideWorkspaceId);
  });

  await test("a browser-supplied workspace path resolves only for a folder GGO works in", async () => {
    const claimed = join(base, "claimed");
    await makeRepo(claimed);
    const unclaimed = join(base, "unclaimed");
    await makeRepo(unclaimed);
    const service = build({ threads: [thread("t-claimed", claimed)], self });

    const allowed = await service.resolve({ kind: "workspace", id: claimed });
    await samePath(allowed.repoPath, claimed);

    const refused = await service.resolve({ kind: "workspace", id: unclaimed });
    assert.equal(refused.workspace, null, "an unregistered folder is never even stat-ed");
    assert.equal(refused.repoPath, null);
    assert.equal(refused.branch, null);
    assert.match(refused.error ?? "", /no work registered/i);
  });

  await test("missing, non-repo and unknown subjects each explain themselves", async () => {
    const gone = join(base, "gone");
    const plainFolder = join(base, "plain-folder");
    await mkdir(plainFolder);
    const service = build({
      threads: [thread("t-gone", gone), thread("t-plainfolder", plainFolder)],
      self,
    });

    const missing = await service.resolve({ kind: "thread", id: "t-gone" });
    assert.equal(missing.repoPath, null);
    assert.match(missing.error ?? "", /missing on this machine/i);

    const notARepo = await service.resolve({ kind: "thread", id: "t-plainfolder" });
    assert.equal(notARepo.repoPath, null);
    assert.ok(notARepo.ideWorkspaceId, "a plain folder is still editable");
    assert.match(notARepo.error ?? "", /not a Git checkout/i);

    const unknown = await service.resolve({ kind: "thread", id: "no-such-task" });
    assert.equal(unknown.workspace, null);
    assert.match(unknown.error ?? "", /no longer exists/i);
  });

  await test("repeat asks inside the TTL share one resolution", async () => {
    const workspace = join(base, "cached");
    await makeRepo(workspace);
    const t = thread("t-cached", workspace);
    const service = build({ threads: [t], self });

    const [first, second] = await Promise.all([
      service.resolve({ kind: "thread", id: t.id }),
      service.resolve({ kind: "thread", id: t.id }),
    ]);
    assert.ok(Object.is(first, second), "a screenful of surfaces must not each run git");
  });

  // The console re-asks for every visible subject the instant a repo action returns — well inside the
  // cache TTL. A cache that only expires on time therefore answers that refresh with pre-action
  // reality, and nothing asks again until the client's much longer TTL lapses: the operator switches
  // branch in the Git console and every context row keeps naming the old one.
  await test("a git write invalidates a cached context immediately, not when its TTL lapses", async () => {
    const workspace = join(base, "switching");
    await makeRepo(workspace);
    const t = thread("t-switch", workspace);
    // The clock is HELD so the TTL cannot expire on its own. On a loaded box the git calls below
    // outlast 4s by themselves, and this assertion then passes with the generation check deleted.
    const service = build({ threads: [t], self, now: () => 1_000_000 });

    assert.equal((await service.resolve({ kind: "thread", id: t.id })).branch, "work");
    await git(workspace, "checkout", "-q", "-b", "other");
    // Exactly what `git/repoOps.ts` does in its `finally` after any repo-mutating action.
    bustGitCaches();
    assert.equal(
      (await service.resolve({ kind: "thread", id: t.id })).branch,
      "other",
      "the branch a checkout just left must not survive the write that changed it",
    );
  });

  await test("repoPrefixOf distinguishes nested, identical and escaping layouts", () => {
    assert.equal(repoPrefixOf(join(base, "a"), join(base, "a")), "");
    assert.equal(repoPrefixOf(join(base, "a"), join(base, "a", "b", "c")), "b/c");
    assert.equal(repoPrefixOf(join(base, "a", "b"), join(base, "a")), null);
    assert.equal(repoPrefixOf(join(base, "a"), join(base, "other")), null);
  });

  console.log(`\ncode context: ${checks} checks passed`);
} finally {
  await rm(base, { recursive: true, force: true }).catch(() => {});
}
