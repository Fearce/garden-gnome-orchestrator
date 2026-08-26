/**
 * Integration test — the WRITE side of git (`server/src/git/repoOps.ts`), against REAL git repos.
 *
 * This is what backs the Git console (the in-app GitHub Desktop): fetch, pull, push, branch
 * switch/create/delete, commit-the-files-you-picked, discard. Every one of them mutates a real
 * repository, so the whole point of this gate is that they do exactly what they claim and refuse — with
 * git's own words — when they can't.
 *
 * WHAT IS REAL: every git operation. The only stand-in is the "remote", a local bare repo instead of
 * GitHub, so push/pull/fetch run for real without a network or a credential.
 *
 * Scenarios:
 *   A. STATE      — branches with ahead/behind + upstream, remote branches, remotes, last-fetch time.
 *   B. FETCH      — an upstream commit becomes visible as behind>0; a remote-less repo is refused.
 *   C. PULL       — ff-only fast-forwards; a diverged branch is refused WITH the rebase hint; rebase works.
 *   D. PUSH       — publishing sets upstream; a second push is a plain push; a Vota origin is refused.
 *   E. CHECKOUT   — switch, create (incl. from a start point), track a remote branch, refuse nonsense.
 *   F. DELETE     — refuses the current branch, refuses an unmerged branch, force deletes it.
 *   G. COMMIT     — commits ONLY the selected files (a sibling's dirty file stays dirty), body included.
 *   H. DISCARD    — a tracked edit reverts to HEAD, an untracked file is removed, others are untouched.
 *   I. VALIDATION — flag-shaped/traversing branch names and paths are rejected before git ever runs.
 *   J. COMMIT LOG — a commit's detail + its per-file diff; a merge commit says it's a merge.
 *   M. SLOW GIT   — a working-tree write outlives the metadata-read budget, and a run we killed at its
 *                   deadline is reported as a timeout instead of in the words git printed on the way.
 *
 * Run:  npm run test:repo-ops   (from server/)   — or:  npx tsx src/tests/repoOps.itest.ts
 * Exits non-zero if any assertion fails. Self-contained: builds throwaway repos in a temp dir, removes them.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { getRepoState, getCommitDetail, getCommitFileDiff, runRepoAction, remoteWebUrl, failureText, validRefName, validRepoPath } =
  await import("../git/repoOps.js");
const { runGit } = await import("../gitService.js");
const { discoverRepos } = await import("../git/discoverRepos.js");

// ---- tiny assertion harness ------------------------------------------------------------------------
let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    failures.push(label + (detail ? ` — ${detail}` : ""));
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---- git helpers -----------------------------------------------------------------------------------
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim();
}

// Written straight into .git/config rather than through five `git config` spawns. This gate builds a
// dozen repos, and on Windows process spawn — not git itself — is what makes it slow; that is ~60
// processes saved.
const REPO_CONFIG = `
[user]
\tname = Repo Ops Test
\temail = repo-ops@example.com
[commit]
\tgpgsign = false
[core]
\tautocrlf = false
[push]
\tdefault = simple
`;

function configureRepo(dir: string): void {
  appendFileSync(join(dir, ".git", "config"), REPO_CONFIG);
}

/** A working clone of a fresh bare "origin", with one seed commit pushed on master. */
function setupClone(base: string, name: string, originUrlName = `${name}-origin.git`): { work: string; originBare: string } {
  const originBare = join(base, originUrlName);
  const work = join(base, `${name}-work`);
  git(base, "init", "--quiet", "--bare", originBare);
  git(base, "clone", "--quiet", originBare, work);
  configureRepo(work);
  writeFileSync(join(work, "README.md"), "base\n");
  git(work, "add", "-A");
  git(work, "commit", "--quiet", "-m", "initial");
  git(work, "branch", "-M", "master");
  git(work, "push", "--quiet", "-u", "origin", "master");
  return { work, originBare };
}

/** Land a commit on the bare origin from a throwaway second clone — the "someone else pushed" case. */
function originCommit(base: string, originBare: string, tag: string, file: string, content: string): void {
  const w = join(base, `origin-work-${tag}`);
  git(base, "clone", "--quiet", originBare, w);
  configureRepo(w);
  writeFileSync(join(w, file), content);
  git(w, "add", "-A");
  git(w, "commit", "--quiet", "-m", `origin: ${file}`);
  git(w, "push", "--quiet", "origin", "master");
}

const head = (work: string): string => git(work, "rev-parse", "--abbrev-ref", "HEAD");

// ---- run -------------------------------------------------------------------------------------------
const root = mkdtempSync(join(tmpdir(), "repoops-itest-"));
try {
  // ---- A. state -------------------------------------------------------------------------------------
  console.log("\nA. getRepoState — branches with tracking, remote branches, remotes");
  {
    const { work } = setupClone(root, "state");
    git(work, "branch", "feature/x");
    writeFileSync(join(work, "local.txt"), "local\n");
    git(work, "add", "-A");
    git(work, "commit", "--quiet", "-m", "a local commit");

    const s = await getRepoState(work);
    check("is a repo, on master", s.isRepo && s.branch === "master", `${s.isRepo}/${s.branch}`);
    check("repo name is the folder leaf", s.name === "state-work", s.name);
    const master = s.branches.find((b) => b.name === "master");
    check("master is marked current", master?.current === true);
    check("master tracks origin/master", master?.upstream === "origin/master", String(master?.upstream));
    check("master is 1 ahead of its upstream", master?.ahead === 1 && master?.behind === 0, `${master?.ahead}/${master?.behind}`);
    const feature = s.branches.find((b) => b.name === "feature/x");
    check("an unpublished branch has no upstream", feature !== undefined && feature.upstream === null);
    check("remote branches list origin/master", s.remoteBranches.includes("origin/master"), s.remoteBranches.join(","));
    check("remote branches exclude the symbolic HEAD", !s.remoteBranches.some((b) => b.endsWith("/HEAD")));
    check("origin remote is reported with its url", s.remotes.some((r) => r.name === "origin" && r.url.length > 0));
    check("ahead reflects the unpushed commit", s.ahead === 1, String(s.ahead));
    check("push state is 'unpushed'", s.pushState === "unpushed", s.pushState);
  }

  // ---- B. fetch -------------------------------------------------------------------------------------
  console.log("\nB. fetch — an upstream commit shows up as behind; a remote-less repo is refused");
  {
    const { work, originBare } = setupClone(root, "fetch");
    originCommit(root, originBare, "fetch", "upstream.txt", "from upstream\n");

    const before = await getRepoState(work);
    check("behind is 0 before fetching", before.behind === 0, String(before.behind));

    const res = await runRepoAction(work, { action: "fetch", prune: false });
    check("fetch succeeds", res.ok, res.message);
    const after = await getRepoState(work);
    check("behind is 1 after fetching", after.behind === 1, String(after.behind));
    check("last-fetch time is recorded", (after.lastFetchAt ?? 0) > 0, String(after.lastFetchAt));

    const solo = join(root, "solo");
    mkdirSync(solo);
    git(solo, "init", "--quiet");
    configureRepo(solo);
    writeFileSync(join(solo, "a.txt"), "a\n");
    git(solo, "add", "-A");
    git(solo, "commit", "--quiet", "-m", "only commit");
    const soloRes = await runRepoAction(solo, { action: "fetch", prune: false });
    check("a repo with no remotes refuses to fetch", !soloRes.ok && /no remotes/i.test(soloRes.message), soloRes.message);
  }

  // ---- C. pull --------------------------------------------------------------------------------------
  console.log("\nC. pull — ff-only fast-forwards; a diverged branch is refused with the rebase hint");
  {
    const { work, originBare } = setupClone(root, "pull");
    originCommit(root, originBare, "pull", "upstream.txt", "from upstream\n");
    const res = await runRepoAction(work, { action: "pull", rebase: false });
    check("ff-only pull succeeds", res.ok, res.message);
    check("the upstream file is now on disk", existsSync(join(work, "upstream.txt")));

    // Diverge: a local commit AND another upstream commit.
    writeFileSync(join(work, "mine.txt"), "mine\n");
    git(work, "add", "-A");
    git(work, "commit", "--quiet", "-m", "my local work");
    originCommit(root, originBare, "pull2", "theirs.txt", "theirs\n");

    const refused = await runRepoAction(work, { action: "pull", rebase: false });
    check("a diverged ff-only pull is refused", !refused.ok, refused.message);
    check("the refusal points at Pull (rebase)", /rebase/i.test(refused.message), refused.message);

    const rebased = await runRepoAction(work, { action: "pull", rebase: true });
    check("pull --rebase succeeds on the same divergence", rebased.ok, rebased.message);
    check("both sides' files are present after the rebase", existsSync(join(work, "mine.txt")) && existsSync(join(work, "theirs.txt")));
    check("history stayed linear (no merge commit)", git(work, "rev-list", "--count", "--merges", "HEAD") === "0");
  }

  // ---- D. push --------------------------------------------------------------------------------------
  console.log("\nD. push — publish sets upstream; a Vota origin is refused");
  {
    const { work } = setupClone(root, "push");
    git(work, "checkout", "--quiet", "-b", "feature/publish");
    writeFileSync(join(work, "f.txt"), "f\n");
    git(work, "add", "-A");
    git(work, "commit", "--quiet", "-m", "feature work");

    const unpublished = await getRepoState(work);
    check("an unpublished branch has no push ref", unpublished.pushRef === null, String(unpublished.pushRef));

    const pub = await runRepoAction(work, { action: "push", setUpstream: true });
    check("publish succeeds", pub.ok, pub.message);
    const afterPub = await getRepoState(work);
    check("publish set the upstream", afterPub.pushRef === "origin/feature/publish", String(afterPub.pushRef));
    check("nothing left to push", afterPub.ahead === 0 && afterPub.pushState === "pushed", `${afterPub.ahead}/${afterPub.pushState}`);

    writeFileSync(join(work, "f.txt"), "f2\n");
    git(work, "add", "-A");
    git(work, "commit", "--quiet", "-m", "more feature work");
    const again = await runRepoAction(work, { action: "push", setUpstream: false });
    check("a second push (no -u) succeeds", again.ok, again.message);
    check("push state is back in sync", (await getRepoState(work)).pushState === "pushed");

    // A Vota origin is commit-only by policy — the console must never push it.
    const { work: vota } = setupClone(root, "vota", "vota-graphql-api.git");
    writeFileSync(join(vota, "v.txt"), "v\n");
    git(vota, "add", "-A");
    git(vota, "commit", "--quiet", "-m", "vota work");
    const votaRes = await runRepoAction(vota, { action: "push", setUpstream: false });
    check("a Vota repo refuses to push", !votaRes.ok && /commit-only/i.test(votaRes.message), votaRes.message);
    check("the Vota commit is still local", (await getRepoState(vota)).ahead === 1);
  }

  // ---- E. checkout ----------------------------------------------------------------------------------
  console.log("\nE. checkout — switch, create, create-from, track a remote branch, refuse nonsense");
  {
    const { work, originBare } = setupClone(root, "checkout");
    git(work, "branch", "feature/x");

    const sw = await runRepoAction(work, { action: "checkout", branch: "feature/x", create: false });
    check("switch to an existing branch succeeds", sw.ok, sw.message);
    check("HEAD moved to feature/x", head(work) === "feature/x", head(work));

    const missing = await runRepoAction(work, { action: "checkout", branch: "does-not-exist", create: false });
    check("a nonexistent branch is refused", !missing.ok, missing.message);
    check("HEAD is unchanged after a refused switch", head(work) === "feature/x");

    const created = await runRepoAction(work, { action: "checkout", branch: "feature/new", create: true });
    check("creating a branch succeeds", created.ok, created.message);
    check("HEAD moved to the new branch", head(work) === "feature/new");

    const dupe = await runRepoAction(work, { action: "checkout", branch: "feature/new", create: true });
    check("creating an existing branch is refused", !dupe.ok && /already exists/i.test(dupe.message), dupe.message);

    const fromMaster = await runRepoAction(work, { action: "checkout", branch: "from-master", create: true, from: "master" });
    check("creating from an explicit start point succeeds", fromMaster.ok, fromMaster.message);
    check("the new branch sits on master's tip", git(work, "rev-parse", "HEAD") === git(work, "rev-parse", "master"));

    const badStart = await runRepoAction(work, { action: "checkout", branch: "nope", create: true, from: "no-such-ref" });
    check("creating from a nonexistent start point is refused", !badStart.ok, badStart.message);

    // A branch that exists only on the remote: check it out as a local tracking branch.
    const other = join(root, "checkout-other");
    git(root, "clone", "--quiet", originBare, other);
    configureRepo(other);
    git(other, "checkout", "--quiet", "-b", "remote-only");
    writeFileSync(join(other, "r.txt"), "r\n");
    git(other, "add", "-A");
    git(other, "commit", "--quiet", "-m", "remote-only work");
    git(other, "push", "--quiet", "-u", "origin", "remote-only");
    await runRepoAction(work, { action: "fetch", prune: false });

    const tracked = await runRepoAction(work, { action: "checkout", branch: "origin/remote-only", create: false });
    check("a remote-only branch is checked out as a tracking branch", tracked.ok, tracked.message);
    check("HEAD is the SHORT local name", head(work) === "remote-only", head(work));
    check("it tracks the remote branch", git(work, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}") === "origin/remote-only");
  }

  // ---- F. delete branch -----------------------------------------------------------------------------
  console.log("\nF. deleteBranch — refuses the current branch and an unmerged one; force deletes");
  {
    const { work } = setupClone(root, "delete");
    git(work, "branch", "merged-branch");
    git(work, "checkout", "--quiet", "-b", "unmerged");
    writeFileSync(join(work, "u.txt"), "u\n");
    git(work, "add", "-A");
    git(work, "commit", "--quiet", "-m", "unmerged work");
    git(work, "checkout", "--quiet", "master");

    const current = await runRepoAction(work, { action: "deleteBranch", branch: "master", force: false });
    check("deleting the current branch is refused", !current.ok && /checked out/i.test(current.message), current.message);

    const merged = await runRepoAction(work, { action: "deleteBranch", branch: "merged-branch", force: false });
    check("deleting a merged branch succeeds", merged.ok, merged.message);

    const unmerged = await runRepoAction(work, { action: "deleteBranch", branch: "unmerged", force: false });
    check("deleting an unmerged branch is refused", !unmerged.ok, unmerged.message);
    check("the refusal points at Delete (force)", /force/i.test(unmerged.message), unmerged.message);
    check("the unmerged branch still exists", git(work, "branch", "--list", "unmerged").includes("unmerged"));

    const forced = await runRepoAction(work, { action: "deleteBranch", branch: "unmerged", force: true });
    check("force-deleting it succeeds", forced.ok, forced.message);
    check("the branch is gone", git(work, "branch", "--list", "unmerged") === "");
  }

  // ---- G. commit ------------------------------------------------------------------------------------
  // The load-bearing property: in a repo several agents share, committing from the console must take the
  // files the operator TICKED and nothing else — including when a sibling's work is already staged.
  console.log("\nG. commit — only the selected files, sibling WIP untouched (staged or not)");
  {
    const { work } = setupClone(root, "commit");
    writeFileSync(join(work, "mine.txt"), "mine\n");
    writeFileSync(join(work, "theirs.txt"), "theirs\n");
    writeFileSync(join(work, "README.md"), "base\nmine edit\n");
    git(work, "add", "theirs.txt"); // a sibling agent staged its own file

    const res = await runRepoAction(work, {
      action: "commit",
      summary: "feat: my selected work",
      description: "A body line.\n\nAnd a second paragraph.",
      paths: ["mine.txt", "README.md"],
    });
    check("commit succeeds", res.ok, res.message);
    check("the message names the new commit", /as [0-9a-f]{7,}/.test(res.message), res.message);

    const committed = git(work, "show", "--name-only", "--format=", "HEAD").split("\n").map((s) => s.trim()).filter(Boolean).sort();
    check("exactly the selected files were committed", JSON.stringify(committed) === JSON.stringify(["README.md", "mine.txt"]), committed.join(","));
    check("the subject is the summary", git(work, "log", "-1", "--format=%s") === "feat: my selected work");
    check("the body is the description", git(work, "log", "-1", "--format=%b").includes("And a second paragraph."));

    const still = await getRepoState(work);
    check("the sibling's file is still uncommitted", still.files.some((f) => f.path === "theirs.txt"), still.files.map((f) => f.path).join(","));
    check("nothing else is left dirty", still.files.length === 1, still.files.map((f) => f.path).join(","));

    const empty = await runRepoAction(work, { action: "commit", summary: "  ", description: "", paths: ["theirs.txt"] });
    check("an empty summary is refused", !empty.ok && /summary/i.test(empty.message), empty.message);

    // A deletion is a change like any other — it must be committable, not silently skipped by the
    // `git add` that stages the selection.
    rmSync(join(work, "mine.txt"));
    const del = await runRepoAction(work, { action: "commit", summary: "chore: drop mine.txt", description: "", paths: ["mine.txt"] });
    check("a deleted file can be committed", del.ok, del.message);
    check("git recorded it as a deletion", git(work, "show", "--name-status", "--format=", "HEAD").startsWith("D"), git(work, "show", "--name-status", "--format=", "HEAD"));
  }

  // ---- H. discard -----------------------------------------------------------------------------------
  console.log("\nH. discard — tracked edits revert, untracked files are removed, others untouched");
  {
    const { work } = setupClone(root, "discard");
    writeFileSync(join(work, "keep.txt"), "keep\n");
    git(work, "add", "-A");
    git(work, "commit", "--quiet", "-m", "add keep.txt");

    writeFileSync(join(work, "keep.txt"), "keep\nedited\n");
    writeFileSync(join(work, "README.md"), "base\nedited too\n");
    writeFileSync(join(work, "junk.txt"), "junk\n");

    const res = await runRepoAction(work, { action: "discard", paths: ["keep.txt", "junk.txt"] });
    check("discard succeeds", res.ok, res.message);
    check("the tracked file is back to HEAD", readFileSync(join(work, "keep.txt"), "utf8") === "keep\n");
    check("the untracked file is gone", !existsSync(join(work, "junk.txt")));
    check("the file that wasn't selected is untouched", readFileSync(join(work, "README.md"), "utf8") === "base\nedited too\n");

    // Discarding a DELETION has to bring the file back, not just unstage it.
    rmSync(join(work, "keep.txt"));
    const undelete = await runRepoAction(work, { action: "discard", paths: ["keep.txt"] });
    check("discarding a deletion succeeds", undelete.ok, undelete.message);
    check("the deleted file is restored", existsSync(join(work, "keep.txt")) && readFileSync(join(work, "keep.txt"), "utf8") === "keep\n");

    // A staged edit must be discarded too — index AND working tree, or the next commit resurrects it.
    writeFileSync(join(work, "keep.txt"), "keep\nstaged edit\n");
    git(work, "add", "keep.txt");
    const staged = await runRepoAction(work, { action: "discard", paths: ["keep.txt"] });
    check("discarding a STAGED edit succeeds", staged.ok, staged.message);
    check("the staged edit is gone from the index too", git(work, "diff", "--cached", "--name-only") === "");
    check("and from the working tree", readFileSync(join(work, "keep.txt"), "utf8") === "keep\n");
  }

  // ---- I. validation --------------------------------------------------------------------------------
  // These strings arrive from the client. A leading dash would be read by git as a FLAG, and `..` escapes
  // the repo — both must be rejected before git ever runs.
  console.log("\nI. validation — flag-shaped and traversing input is rejected before git runs");
  {
    check("a normal branch name is valid", validRefName("feature/my-work_2.1"));
    check("a remote-tracking name is valid", validRefName("origin/feature/x"));
    check("a leading dash is rejected", !validRefName("--upload-pack=evil"));
    check("`..` is rejected", !validRefName("feature/../evil"));
    check("a trailing .lock is rejected", !validRefName("feature/x.lock"));
    check("a space is rejected", !validRefName("my branch"));
    check("an empty name is rejected", !validRefName(""));

    check("a normal path is valid", validRepoPath("server/src/index.ts"));
    check("a traversing path is rejected", !validRepoPath("../../etc/passwd"));
    check("a BACKSLASH-traversing path is rejected too", !validRepoPath("..\\..\\etc\\passwd"));
    check("an absolute path is rejected", !validRepoPath("/etc/passwd") && !validRepoPath("C:\\Windows\\system32"));
    check("a flag-shaped path is rejected", !validRepoPath("--output=evil"));
    check("a pathspec-magic path is rejected", !validRepoPath(":(glob)**/*"));

    const { work } = setupClone(root, "validate");
    const bad = await runRepoAction(work, { action: "checkout", branch: "--orphan", create: false });
    check("a flag-shaped branch never reaches git", !bad.ok && /valid branch name/i.test(bad.message), bad.message);
    const badPath = await runRepoAction(work, { action: "commit", summary: "x", description: "", paths: ["../outside.txt"] });
    check("a traversing path never reaches git", !badPath.ok && /valid path/i.test(badPath.message), badPath.message);
  }

  // ---- J. commit detail -----------------------------------------------------------------------------
  console.log("\nJ. getCommitDetail — files, body, per-file diff; a merge says it's a merge");
  {
    const { work } = setupClone(root, "detail");
    writeFileSync(join(work, "code.ts"), "export const a = 1;\n");
    git(work, "add", "-A");
    git(work, "commit", "--quiet", "-m", "feat: add code", "-m", "Why it exists.");
    const hash = git(work, "rev-parse", "--short", "HEAD");

    const detail = await getCommitDetail(work, hash);
    check("the subject is read back", detail.subject === "feat: add code", detail.subject);
    check("the body is read back", detail.body === "Why it exists.", detail.body);
    check("the author is read back", detail.author === "Repo Ops Test", detail.author);
    check("the touched file is listed", detail.files.length === 1 && detail.files[0]?.path === "code.ts", JSON.stringify(detail.files));
    check("with its ± counts", detail.files[0]?.added === 1 && detail.files[0]?.removed === 0);
    check("not a merge", !detail.isMerge);

    const diff = await getCommitFileDiff(work, hash, "code.ts");
    check("the commit's per-file diff is the added line", diff.patch.includes("+export const a = 1;"), diff.patch.slice(0, 120));

    const missing = await getCommitDetail(work, "0000000");
    check("an unknown commit reports an error, not a throw", missing.error !== null, String(missing.error));

    git(work, "checkout", "--quiet", "-b", "side");
    writeFileSync(join(work, "side.txt"), "side\n");
    git(work, "add", "-A");
    git(work, "commit", "--quiet", "-m", "side work");
    git(work, "checkout", "--quiet", "master");
    writeFileSync(join(work, "main.txt"), "main\n");
    git(work, "add", "-A");
    git(work, "commit", "--quiet", "-m", "main work");
    git(work, "merge", "--quiet", "--no-ff", "-m", "merge side", "side");
    const mergeDetail = await getCommitDetail(work, git(work, "rev-parse", "--short", "HEAD"));
    check("a merge commit is flagged as one", mergeDetail.isMerge, mergeDetail.subject);
    check("and lists no files rather than a misleading diff", mergeDetail.files.length === 0);
  }
  // ---- K. discovery ---------------------------------------------------------------------------------
  // The picker is populated by scanning for checkouts, so the owner never types a path. What matters is
  // that it finds repos at several depths, does NOT descend into one (a vendored .git is not a repo the
  // owner works in), and respects its bounds.
  console.log("\nK. discoverRepos — finds checkouts by scanning, skips noise, honours its bounds");
  {
    const scanRoot = join(root, "scan");
    const mk = (rel: string): string => {
      const dir = join(scanRoot, rel);
      mkdirSync(dir, { recursive: true });
      git(dir, "init", "--quiet");
      return dir;
    };
    mkdirSync(scanRoot, { recursive: true });
    const top = mk("top-level-repo");
    const nested = mk("code/nested-repo");
    const deep = mk("code/org/deep-repo");
    mk("code/org/too/deep-repo"); // depth 4 — beyond the default reach
    // A dependency's own checkout, inside a repo and inside node_modules: neither should be listed.
    mkdirSync(join(top, "node_modules", "dep"), { recursive: true });
    git(join(top, "node_modules", "dep"), "init", "--quiet");
    mkdirSync(join(scanRoot, "plain-folder"), { recursive: true });

    const found = (await discoverRepos([scanRoot])).map((p) => p.replace(/\\/g, "/")).sort();
    const want = [top, nested, deep].map((p) => p.replace(/\\/g, "/")).sort();
    check("finds repos at depth 1, 2 and 3", JSON.stringify(found) === JSON.stringify(want), found.join(" | "));
    check("does not descend INTO a repo (vendored .git ignored)", !found.some((p) => p.includes("node_modules")));
    check("a non-repo folder isn't listed", !found.some((p) => p.endsWith("plain-folder")));

    const shallow = await discoverRepos([scanRoot], { maxDepth: 1 });
    check("maxDepth bounds the walk", shallow.length === 1 && shallow[0] === top, shallow.join(","));
    const capped = await discoverRepos([scanRoot], { limit: 1 });
    check("limit bounds the result", capped.length === 1, String(capped.length));
    check("a root that doesn't exist is skipped, not thrown on", (await discoverRepos([join(root, "no-such-root")])).length === 0);
  }

  // ---- L. remote → browser URL ------------------------------------------------------------------------
  console.log("\nL. remoteWebUrl — every remote spelling becomes a browsable link, or none at all");
  {
    check("SSH scp-style", remoteWebUrl("git@github.com:Fearce/garden-gnome-orchestrator.git", "master") === "https://github.com/Fearce/garden-gnome-orchestrator/tree/master");
    check("HTTPS", remoteWebUrl("https://github.com/Fearce/repo.git", "main") === "https://github.com/Fearce/repo/tree/main");
    check("ssh:// with a port", remoteWebUrl("ssh://git@github.com:22/Fearce/repo.git", "dev") === "https://github.com/Fearce/repo/tree/dev");
    check("no branch → the repo root", remoteWebUrl("https://github.com/Fearce/repo.git", null) === "https://github.com/Fearce/repo");
    // GitHub resolves slashes in a branch ref as PATH — a %2F there does not resolve — but anything
    // odd inside a segment still has to be escaped.
    check("a slash in a branch stays a slash", remoteWebUrl("git@github.com:o/r.git", "feature/x") === "https://github.com/o/r/tree/feature/x", String(remoteWebUrl("git@github.com:o/r.git", "feature/x")));
    check("but a space inside a segment is escaped", remoteWebUrl("git@github.com:o/r.git", "feat/a b") === "https://github.com/o/r/tree/feat/a%20b");
    check("GitLab uses the same shape", remoteWebUrl("git@gitlab.com:o/r.git", "main") === "https://gitlab.com/o/r/tree/main");
    check("Bitbucket uses /src", remoteWebUrl("git@bitbucket.org:o/r.git", "main") === "https://bitbucket.org/o/r/src/main");
    check("an unknown host gets the root, not a guessed path", remoteWebUrl("https://git.example.com/o/r.git", "main") === "https://git.example.com/o/r");
    check("a local path is not a web URL", remoteWebUrl("C:\\Users\\me\\origin.git", "master") === null, String(remoteWebUrl("C:\\Users\\me\\origin.git", "master")));
    check("a POSIX local path is not a web URL", remoteWebUrl("/srv/git/repo.git", "master") === null);
    check("an empty remote is not a web URL", remoteWebUrl("", "master") === null);

    // …and the state carries it through for a real repo.
    const { work } = setupClone(root, "weburl");
    git(work, "remote", "set-url", "origin", "git@github.com:Fearce/sample.git");
    const s = await getRepoState(work);
    check("getRepoState exposes the link for the current branch", s.webUrl === "https://github.com/Fearce/sample/tree/master", String(s.webUrl));
  }

  // ---- M. slow git ----------------------------------------------------------------------------------
  // The 2026-08-26 sweep went red here with "✗ switch to an existing branch succeeds — Switched to
  // branch 'feature/x'" — git's own SUCCESS line delivered as the failure reason, with "✓ HEAD moved"
  // passing right after it. A checkout was inheriting the metadata-read timeout, and on a box where a
  // trivial one measured 19–57s it got killed after doing the work. Both halves are pinned here.
  console.log("\nM. slow git — a working-tree write outlives the read budget; a killed run says so");
  {
    // `hash-object --stdin` blocks on a stdin that is piped and never written to, so this is a git that
    // genuinely hangs rather than a contrived one.
    const { work } = setupClone(root, "timeout");
    const killed = await runGit(work, ["hash-object", "--stdin"], 300);
    check("a run we killed at its deadline is flagged timedOut", killed.timedOut === true, String(killed.timedOut));
    check("...and did not exit 0, so no caller reads it as success", killed.code !== 0, String(killed.code));

    const finished = await runGit(work, ["rev-parse", "HEAD"]);
    check("a run that finished in time is not flagged", finished.timedOut === false && finished.code === 0);

    // The exact production shape: git had already printed its success line when we killed it.
    const halfDone = { code: null, stdout: "", stderr: "Switched to branch 'feature/x'\n", timedOut: true };
    const text = failureText(halfDone, "fallback");
    check("a timed-out failure does not quote git's success line", !text.includes("Switched to branch"), text);
    check("...and says it timed out instead", /timed out/i.test(text), text);
    check(
      "a REAL failure is still reported in git's own words",
      failureText({ code: 1, stdout: "", stderr: "error: pathspec 'nope' did not match\n", timedOut: false }, "fallback") ===
        "error: pathspec 'nope' did not match",
    );

    // Behavioural half: a post-checkout hook that outlives the read budget. Under the old budget git is
    // killed after switching — ok:false carrying "Switched to branch…" — which is the bug above.
    const { work: slow } = setupClone(root, "slow-checkout");
    git(slow, "branch", "feature/slow");
    const hook = join(slow, ".git", "hooks", "post-checkout");
    writeFileSync(hook, "#!/bin/sh\nsleep 16\n");
    chmodSync(hook, 0o755);

    const sw = await runRepoAction(slow, { action: "checkout", branch: "feature/slow", create: false });
    check("a checkout slower than the read budget still succeeds", sw.ok, sw.message);
    check("...and actually moved HEAD", head(slow) === "feature/slow", head(slow));
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
