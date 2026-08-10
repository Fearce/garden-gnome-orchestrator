import { statSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import {
  COMMIT_LOG_FORMAT,
  bustGitCaches,
  classifyNameStatus,
  getGitStatus,
  parseCommitLog,
  parseNameStatus,
  parseNumstat,
  resolveRepoRoot,
  runGit,
  type GitCommit,
  type GitFile,
  type GitFileDiff,
  type GitResult,
  type PushState,
} from "../gitService.js";

// The WRITE side of git: the repo-level Git console (the in-app GitHub Desktop). Everything here acts on
// a whole repository rather than a task's slice of one — fetch, pull, push, branch switch/create/delete,
// commit the files you picked, discard. Reads that the console needs but the task-scoped read layer
// doesn't expose (per-branch tracking, remote branches, remotes, a commit's own diff) live here too.
//
// Two properties this module has to keep:
//   - It never shells out itself: every call goes through gitService's hardened `runGit` (no shell,
//     GIT_TERMINAL_PROMPT=0 so a private remote fails fast instead of hanging on a credential prompt).
//   - Every branch name and path it passes to git is operator-supplied over the WebSocket, so it is
//     validated here (never `-`-leading, never `..`) and always placed after `--`. Validation is the
//     trust boundary, not the UI.
//
// The safety gate ("an agent is live in this repo, don't yank the branch out from under it") is NOT here
// — it needs thread state, so it lives in `orchestrator/repoConsole.ts`, which owns this module's callers.

/** Network operations (fetch/pull/push) talk to a remote, so they get a far longer leash than a local
 *  read. Long enough for a slow first fetch on a big repo; short enough that a hung credential prompt
 *  (which GIT_TERMINAL_PROMPT=0 should already prevent) still ends in an error rather than a dead panel. */
const NET_TIMEOUT_MS = 120_000;
/** How many commits the console's History tab shows. Deeper than the task drawer's 20 — this is the
 *  repo's own history, which is the thing you actually scroll. */
const REPO_LOG_LIMIT = 50;
/** A git message rendered in the console's activity line; anything longer is noise in a one-line strip. */
const MESSAGE_MAX = 1200;
const DIFF_MAX_BYTES = 200_000;

// ---- public shapes (mirrored in web/src/types.ts) ---------------------------------------------------

export interface RepoBranch {
  name: string;
  current: boolean;
  /** The tracked upstream ref (e.g. "origin/master"), or null when the branch was never published. */
  upstream: string | null;
  /** Commits this branch has that its upstream doesn't (and vice versa). Both 0 without an upstream. */
  ahead: number;
  behind: number;
  /** Epoch ms of the branch tip's commit — the list is ordered by this, most recent first. */
  at: number;
  /** The upstream ref exists in config but is gone from the remote (git's `[gone]`). */
  gone: boolean;
}

export interface RepoRemote {
  name: string;
  url: string;
}

/** Everything the Git console renders for one repository. A superset of the task drawer's GitStatus:
 *  same file list and push semantics, plus the branch/remote/fetch detail a repo-level console needs. */
export interface RepoState {
  /** The resolved repo ROOT (not the path that was asked for) — the console's identity for this repo. */
  path: string;
  /** The repo folder's own name, for the picker. */
  name: string;
  isRepo: boolean;
  error: string | null;
  branch: string | null;
  detached: boolean;
  branches: RepoBranch[];
  /** Remote-tracking branches ("origin/feature/x"), minus each remote's symbolic HEAD alias. */
  remoteBranches: string[];
  remotes: RepoRemote[];
  upstreamRef: string | null;
  pushRef: string | null;
  /** Local commits not yet on the push remote — the number a Push would send. */
  ahead: number;
  /** Commits the upstream has that we don't — the number a Pull would take. */
  behind: number;
  isVota: boolean;
  pushState: PushState;
  files: GitFile[];
  commits: GitCommit[];
  /** Epoch ms of the last successful fetch (FETCH_HEAD's mtime), or null if never fetched. */
  lastFetchAt: number | null;
  /** A browser URL for this repo on its hosting provider, deep-linked to the current branch — null
   *  when the remote isn't a recognizable web host (a local bare repo, a plain filesystem remote). */
  webUrl: string | null;
}

/** One commit opened from the History tab: its metadata, full message body, and the files it touched. */
export interface RepoCommitDetail {
  hash: string;
  fullHash: string;
  subject: string;
  body: string;
  author: string;
  email: string;
  at: number;
  files: GitFile[];
  /** A merge commit has no single meaningful diff, so the file list is empty by design — say so. */
  isMerge: boolean;
  error: string | null;
}

export interface RepoActionResult {
  ok: boolean;
  /** Git's own words where there are any (that's what makes this trustworthy), else our reason. */
  message: string;
}

export type RepoOp =
  | { action: "fetch"; prune: boolean }
  | { action: "pull"; rebase: boolean }
  | { action: "push"; setUpstream: boolean }
  | { action: "checkout"; branch: string; create: boolean; from?: string }
  | { action: "deleteBranch"; branch: string; force: boolean }
  | { action: "commit"; summary: string; description: string; paths: string[] }
  | { action: "discard"; paths: string[] };

/** The actions that rewrite the working tree or move HEAD — the ones that would break an agent working
 *  in the repo. `orchestrator/repoConsole.ts` gates exactly this set behind the live-agent check. */
export const TREE_MUTATING_ACTIONS: ReadonlySet<RepoOp["action"]> = new Set(["checkout", "pull", "discard"]);

// ---- validation (the trust boundary for operator-supplied strings) ----------------------------------

/** Turn a git remote URL into a browsable web URL, deep-linked to `branch` when the host supports it.
 *  Handles the three spellings a remote actually comes in — `git@host:owner/repo.git`,
 *  `https://host/owner/repo.git`, `ssh://git@host/owner/repo` — and returns null for anything that
 *  isn't a web host (a local path, a bare repo on a share), so the button hides rather than 404s.
 *  Exported for its unit coverage: this is pure string work and the shapes are easy to get wrong. */
export function remoteWebUrl(remoteUrl: string, branch: string | null): string | null {
  const url = remoteUrl.trim();
  if (!url) return null;

  const scp = /^(?:[\w.-]+@)?([\w.-]+):(?!\/)(.+)$/.exec(url); // git@github.com:owner/repo.git
  const proto = /^(?:https?|ssh|git):\/\/(?:[^@/]*@)?([^/]+)\/(.+)$/.exec(url);
  const m = scp ?? proto;
  if (!m) return null;

  const host = (m[1] ?? "").replace(/:\d+$/, "");
  const repoPath = (m[2] ?? "").replace(/\.git$/, "").replace(/^\/+|\/+$/g, "");
  // A drive letter ("C:\repos\x") parses as host "C" — and a host with no dot is never a web host.
  if (!host.includes(".") || !repoPath) return null;

  const base = `https://${host}/${repoPath}`;
  if (!branch) return base;
  // Encode per SEGMENT: `feature/x` must stay `feature/x` in the URL (GitHub resolves the slashes as
  // path, and does NOT resolve a %2F), while anything odd inside a segment is still escaped.
  const ref = branch.split("/").map(encodeURIComponent).join("/");
  // The two dominant hosts share GitHub's /tree/<branch> shape; anything else gets the repo root
  // rather than a guessed path that might 404.
  if (/(^|\.)(github\.com|gitlab\.com)$/i.test(host)) return `${base}/tree/${ref}`;
  if (/(^|\.)bitbucket\.org$/i.test(host)) return `${base}/src/${ref}`;
  return base;
}

/** True for a branch/ref name we're willing to hand to git. Deliberately narrower than git's own rules:
 *  no leading dash (which git would read as a FLAG, not a ref), no `..`, no path traversal, none of the
 *  characters git rejects anyway. Remote-tracking names ("origin/feature/x") pass. */
export function validRefName(name: string): boolean {
  if (!name || name.length > 255) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name)) return false;
  if (name.includes("..") || name.includes("//") || name.endsWith("/") || name.endsWith(".lock")) return false;
  return true;
}

/** True for a repo-relative path we're willing to pass after `--`. Rejects a leading dash (git would read
 *  it as a FLAG), git pathspec magic (`:(glob)…`), absolute paths in either platform's spelling, and any
 *  `..` traversal. Separators are normalized first: a Windows-style `..\..\secret` must be rejected on
 *  every platform, not only where `isAbsolute` happens to understand backslashes. */
export function validRepoPath(p: string): boolean {
  if (!p || p.length > 4096 || p.includes("\0")) return false;
  if (p.startsWith("-") || p.startsWith(":")) return false;
  const norm = p.replace(/\\/g, "/");
  if (norm.startsWith("/") || /^[A-Za-z]:/.test(norm) || isAbsolute(p)) return false;
  return !/(^|\/)\.\.(\/|$)/.test(norm);
}

// ---- small helpers ----------------------------------------------------------------------------------

const okOut = (r: GitResult): string | null => (r.code === 0 ? r.stdout.trim() : null);

/** Git's output for the activity line: stdout and stderr both matter (fetch/push report on stderr),
 *  progress-only noise is dropped, and the result is capped. */
function gitText(r: GitResult): string {
  const lines = `${r.stdout}\n${r.stderr}`
    .split(/\r?\n/)
    .map((l) => l.replace(/\r.*$/, "").trim())
    .filter((l) => l.length > 0 && !/^(remote:\s*)?(Enumerating|Counting|Compressing|Receiving|Resolving|Writing|Total) /.test(l));
  return lines.join(" · ").slice(0, MESSAGE_MAX);
}

function fail(message: string): RepoActionResult {
  return { ok: false, message };
}

/** Wrap a git run into a result, using git's own message either way. */
function resultOf(r: GitResult, okFallback: string): RepoActionResult {
  const text = gitText(r);
  if (r.code === 0) return { ok: true, message: text || okFallback };
  return fail(text || `git exited ${r.code ?? "?"}`);
}

async function currentBranch(root: string): Promise<{ branch: string | null; detached: boolean }> {
  const raw = okOut(await runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"])) ?? "";
  const detached = raw === "HEAD" || raw === "";
  return { branch: detached ? null : raw, detached };
}

async function localBranchExists(root: string, name: string): Promise<boolean> {
  return (await runGit(root, ["rev-parse", "--verify", "-q", `refs/heads/${name}`])).code === 0;
}

async function refExists(root: string, ref: string): Promise<boolean> {
  return (await runGit(root, ["rev-parse", "--verify", "-q", `${ref}^{commit}`])).code === 0;
}

/** The remote a Publish should target: `origin` when it exists (it nearly always does), else the first
 *  configured remote, else null (nothing to publish to). */
async function defaultRemote(root: string): Promise<string | null> {
  const names = (okOut(await runGit(root, ["remote"])) ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
  if (names.length === 0) return null;
  return names.includes("origin") ? "origin" : names[0]!;
}

// ---- state ------------------------------------------------------------------------------------------

/** Full console state for a repository. Builds on the read layer's `getGitStatus` (file list, push
 *  state, Vota detection, behind/unpushed) and adds what a repo-level console needs on top. Never
 *  throws — a path that isn't a repo comes back isRepo:false with a reason. */
export async function getRepoState(path: string): Promise<RepoState> {
  const root = await resolveRepoRoot(path);
  if (!root) {
    return {
      path, name: basename(path.replace(/[\\/]+$/, "")) || path, isRepo: false,
      error: "Not a git repository.", branch: null, detached: false, branches: [], remoteBranches: [],
      remotes: [], upstreamRef: null, pushRef: null, ahead: 0, behind: 0, isVota: false,
      pushState: "no-remote", files: [], commits: [], lastFetchAt: null, webUrl: null,
    };
  }

  const status = await getGitStatus(root);
  const [branches, remoteBranches, remotes, commits, fetchedAt] = await Promise.all([
    collectBranches(root, status.branch),
    collectRemoteBranches(root),
    collectRemotes(root),
    collectRepoLog(root, status.pushRef ?? status.upstreamRef),
    lastFetchAt(root),
  ]);

  return {
    path: root,
    name: basename(root.replace(/[\\/]+$/, "")) || root,
    isRepo: status.isRepo,
    error: status.error,
    branch: status.branch,
    detached: status.detached,
    branches,
    remoteBranches,
    remotes,
    upstreamRef: status.upstreamRef,
    pushRef: status.pushRef,
    ahead: status.unpushed,
    behind: status.behind,
    isVota: status.isVota,
    pushState: status.pushState,
    files: status.files,
    commits,
    lastFetchAt: fetchedAt,
    // `origin` is what the owner means by "the repo" when it exists; fall back to the first remote.
    webUrl: remoteWebUrl((remotes.find((r) => r.name === "origin") ?? remotes[0])?.url ?? "", status.branch),
  };
}

const REF_FIELD_SEP = "\x1f";

/** Every local branch with its upstream and ahead/behind, newest tip first. `%(upstream:track)` renders
 *  as "[ahead 2, behind 1]" / "[gone]" / empty, which is cheaper than a rev-list per branch. */
async function collectBranches(root: string, current: string | null): Promise<RepoBranch[]> {
  const format = ["%(refname:short)", "%(upstream:short)", "%(upstream:track)", "%(committerdate:unix)"].join("%1f");
  const raw = okOut(await runGit(root, ["for-each-ref", "refs/heads", `--format=${format}`, "--sort=-committerdate"]));
  if (!raw) return [];
  const branches: RepoBranch[] = [];
  for (const line of raw.split("\n")) {
    const [name, upstream, track, at] = line.split(REF_FIELD_SEP);
    if (!name) continue;
    branches.push({
      name,
      current: name === current,
      upstream: upstream || null,
      ahead: trackCount(track ?? "", "ahead"),
      behind: trackCount(track ?? "", "behind"),
      at: (Number.parseInt(at ?? "", 10) || 0) * 1000,
      gone: (track ?? "").includes("gone"),
    });
  }
  return branches;
}

function trackCount(track: string, which: "ahead" | "behind"): number {
  const m = new RegExp(`${which} (\\d+)`).exec(track);
  return m ? Number.parseInt(m[1]!, 10) || 0 : 0;
}

/** Remote-tracking branches, minus each remote's symbolic HEAD (which is an alias, not a branch you'd
 *  check out). These are what the branch menu offers under "Remote". */
async function collectRemoteBranches(root: string): Promise<string[]> {
  const raw = okOut(await runGit(root, ["for-each-ref", "refs/remotes", "--format=%(refname:short)", "--sort=-committerdate"]));
  if (!raw) return [];
  return raw.split("\n").map((s) => s.trim()).filter((s) => s && !/\/HEAD$/.test(s));
}

async function collectRemotes(root: string): Promise<RepoRemote[]> {
  const raw = okOut(await runGit(root, ["remote", "-v"]));
  if (!raw) return [];
  const seen = new Map<string, string>();
  for (const line of raw.split("\n")) {
    const m = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim());
    if (m && !seen.has(m[1]!)) seen.set(m[1]!, m[2]!);
  }
  return [...seen].map(([name, url]) => ({ name, url }));
}

/** The repo's own recent history, each commit tagged local-or-pushed against the push ref. */
async function collectRepoLog(root: string, unpushedRef: string | null): Promise<GitCommit[]> {
  if ((await runGit(root, ["rev-parse", "--verify", "-q", "HEAD"])).code !== 0) return [];
  const unpushedShas = new Set<string>();
  if (unpushedRef) {
    const list = okOut(await runGit(root, ["rev-list", `${unpushedRef}..HEAD`]));
    if (list) for (const s of list.split("\n").map((x) => x.trim()).filter(Boolean)) unpushedShas.add(s);
  }
  const raw = okOut(await runGit(root, ["log", `-${REPO_LOG_LIMIT}`, COMMIT_LOG_FORMAT]));
  return raw ? parseCommitLog(raw, unpushedShas, unpushedRef !== null) : [];
}

/** When this repo last fetched — FETCH_HEAD's mtime, which git rewrites on every successful fetch. The
 *  git dir is asked for rather than assumed: it's a `.git` FILE, not a directory, inside a linked
 *  worktree. */
async function lastFetchAt(root: string): Promise<number | null> {
  const gitDir = okOut(await runGit(root, ["rev-parse", "--absolute-git-dir"]));
  if (!gitDir) return null;
  try {
    return statSync(resolve(gitDir, "FETCH_HEAD")).mtimeMs;
  } catch {
    return null; // never fetched (a fresh `git init`, or a clone that hasn't refetched)
  }
}

// ---- per-file and per-commit diffs -------------------------------------------------------------------

/** One file's diff inside a commit (`git show <hash> -- <file>`), for the History tab's diff pane. */
export async function getCommitFileDiff(path: string, hash: string, file: string): Promise<GitFileDiff> {
  const empty: GitFileDiff = { path: file, binary: false, patch: "", truncated: false };
  const root = await resolveRepoRoot(path);
  if (!root || !validRefName(hash) || !validRepoPath(file)) return empty;
  const res = await runGit(root, ["show", "-M", "--format=", hash, "--", file]);
  const full = res.stdout;
  const binary = /\bBinary files? .* differ\b/.test(full) || full.includes("GIT binary patch");
  const truncated = full.length > DIFF_MAX_BYTES;
  return { path: file, binary, patch: binary ? "" : truncated ? full.slice(0, DIFF_MAX_BYTES) : full, truncated };
}

/** One commit's metadata, message body and touched files. A merge commit has no single meaningful diff,
 *  so its file list is empty and `isMerge` says why rather than silently showing nothing. */
export async function getCommitDetail(path: string, hash: string): Promise<RepoCommitDetail> {
  const empty: RepoCommitDetail = {
    hash, fullHash: hash, subject: "", body: "", author: "", email: "", at: 0, files: [], isMerge: false,
    error: null,
  };
  const root = await resolveRepoRoot(path);
  if (!root) return { ...empty, error: "Not a git repository." };
  if (!validRefName(hash)) return { ...empty, error: "Invalid commit id." };

  const metaFormat = ["%H", "%h", "%an", "%ae", "%at", "%P", "%s", "%b"].join("%x1f");
  const meta = okOut(await runGit(root, ["show", "-s", `--format=${metaFormat}`, hash]));
  if (!meta) return { ...empty, error: `No commit "${hash}" in this repository.` };
  const [fullHash, short, author, email, at, parents, subject, ...bodyParts] = meta.split("\x1f");
  const isMerge = (parents ?? "").trim().split(/\s+/).filter(Boolean).length > 1;

  const files = isMerge ? [] : await collectCommitFiles(root, hash);
  return {
    hash: short ?? hash,
    fullHash: fullHash ?? hash,
    subject: subject ?? "",
    body: bodyParts.join("\x1f").trim(),
    author: author ?? "",
    email: email ?? "",
    at: (Number.parseInt(at ?? "", 10) || 0) * 1000,
    files,
    isMerge,
    error: null,
  };
}

async function collectCommitFiles(root: string, hash: string): Promise<GitFile[]> {
  const nameStatus = parseNameStatus((await runGit(root, ["show", "--format=", "--name-status", "-M", "-z", hash])).stdout);
  const counts = parseNumstat((await runGit(root, ["show", "--format=", "--numstat", "-M", "-z", hash])).stdout);
  const files = nameStatus.map((r) => {
    const n = counts.get(r.path);
    return {
      path: r.path,
      status: classifyNameStatus(r.code),
      added: n?.added ?? 0,
      removed: n?.removed ?? 0,
      binary: n?.binary ?? false,
      ...(r.oldPath ? { oldPath: r.oldPath } : {}),
    };
  });
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

// ---- actions ----------------------------------------------------------------------------------------

/** Run one console action against a repo. Never throws and never forces: a git refusal (a dirty tree
 *  that a checkout would clobber, a non-fast-forward pull, a failing pre-commit hook) comes back as
 *  ok:false carrying git's own words, so the operator decides what to do about it. */
export async function runRepoAction(path: string, op: RepoOp): Promise<RepoActionResult> {
  const root = await resolveRepoRoot(path);
  if (!root) return fail("Not a git repository.");
  try {
    switch (op.action) {
      case "fetch": return await doFetch(root, op.prune);
      case "pull": return await doPull(root, op.rebase);
      case "push": return await doPush(root, op.setUpstream);
      case "checkout": return await doCheckout(root, op.branch, op.create, op.from);
      case "deleteBranch": return await doDeleteBranch(root, op.branch, op.force);
      case "commit": return await doCommit(root, op.summary, op.description, op.paths);
      case "discard": return await doDiscard(root, op.paths);
      default: return fail("Unknown action.");
    }
  } finally {
    // Every action above can move HEAD or the working tree, so the read layer's caches are stale now.
    bustGitCaches();
  }
}

async function doFetch(root: string, prune: boolean): Promise<RepoActionResult> {
  if ((await defaultRemote(root)) === null) return fail("This repository has no remotes configured.");
  const args = ["fetch", "--all", "--tags"];
  if (prune) args.push("--prune");
  const r = await runGit(root, args, NET_TIMEOUT_MS);
  return resultOf(r, "Fetched — already up to date.");
}

async function doPull(root: string, rebase: boolean): Promise<RepoActionResult> {
  const { branch, detached } = await currentBranch(root);
  if (detached || !branch) return fail("HEAD is detached — check out a branch before pulling.");
  const upstream = okOut(await runGit(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]));
  if (!upstream) return fail(`"${branch}" has no upstream to pull from — publish the branch first.`);

  // Fast-forward by default (a merge bubble is never what you want from a one-click Pull); Rebase is the
  // explicit second button for when the branches have diverged.
  const r = await runGit(root, rebase ? ["pull", "--rebase"] : ["pull", "--ff-only"], NET_TIMEOUT_MS);
  if (r.code === 0) return { ok: true, message: gitText(r) || "Already up to date." };
  const text = gitText(r);
  const diverged = /not possible to fast-forward|diverging|Need to specify how to reconcile/i.test(text);
  return fail(diverged && !rebase ? `${text} — your branch has diverged from ${upstream}; use Pull (rebase) to replay your commits on top.` : text);
}

async function doPush(root: string, setUpstream: boolean): Promise<RepoActionResult> {
  const status = await getGitStatus(root);
  if (status.isVota) {
    return fail("This is a Vota repo — commit-only by policy. Vota pushes are done manually, so the console won't push it.");
  }
  const { branch, detached } = await currentBranch(root);
  if (detached || !branch) return fail("HEAD is detached — check out a branch before pushing.");

  if (setUpstream || !status.pushRef) {
    const remote = await defaultRemote(root);
    if (!remote) return fail("This repository has no remotes configured, so there's nothing to push to.");
    const r = await runGit(root, ["push", "--set-upstream", remote, branch], NET_TIMEOUT_MS);
    return resultOf(r, `Published ${branch} to ${remote}.`);
  }
  const r = await runGit(root, ["push"], NET_TIMEOUT_MS);
  return resultOf(r, "Pushed — everything up to date.");
}

/** Switch branches, create one, or check out a remote branch as a new local tracking branch — the three
 *  things the console's branch menu offers, told apart here rather than by three near-identical commands
 *  in the caller. Never `--force`: a checkout that would clobber uncommitted work is git's refusal to
 *  surface, not ours to override. */
async function doCheckout(root: string, branch: string, create: boolean, from?: string): Promise<RepoActionResult> {
  if (!validRefName(branch)) return fail(`"${branch}" isn't a valid branch name.`);
  if (from !== undefined && from !== "" && !validRefName(from)) return fail(`"${from}" isn't a valid starting point.`);

  if (create) {
    if (await localBranchExists(root, branch)) return fail(`A branch named "${branch}" already exists.`);
    const start = from && from !== "" ? from : null;
    if (start && !(await refExists(root, start))) return fail(`No ref "${start}" to branch from.`);
    const r = await runGit(root, start ? ["checkout", "-b", branch, start] : ["checkout", "-b", branch]);
    return resultOf(r, `Created and switched to ${branch}.`);
  }

  if (await localBranchExists(root, branch)) {
    const r = await runGit(root, ["checkout", branch]);
    return resultOf(r, `Switched to ${branch}.`);
  }

  // A remote-only branch ("origin/feature/x"): check it out as a local tracking branch, the way GitHub
  // Desktop does — unless a local branch of that short name already exists, which would be a different
  // branch entirely and is the operator's to resolve.
  if (await refExists(root, branch)) {
    const local = branch.split("/").slice(1).join("/");
    if (!local || !validRefName(local)) return fail(`Can't derive a local branch name from "${branch}".`);
    if (await localBranchExists(root, local)) {
      return fail(`A local branch "${local}" already exists — switch to it instead of re-tracking ${branch}.`);
    }
    const r = await runGit(root, ["checkout", "-b", local, "--track", branch]);
    return resultOf(r, `Checked out ${local} tracking ${branch}.`);
  }
  return fail(`No branch "${branch}" in this repository.`);
}

async function doDeleteBranch(root: string, branch: string, force: boolean): Promise<RepoActionResult> {
  if (!validRefName(branch)) return fail(`"${branch}" isn't a valid branch name.`);
  const { branch: current } = await currentBranch(root);
  if (branch === current) return fail(`"${branch}" is checked out — switch to another branch first.`);
  if (!(await localBranchExists(root, branch))) return fail(`No local branch "${branch}".`);

  const r = await runGit(root, ["branch", force ? "-D" : "-d", branch]);
  if (r.code === 0) return { ok: true, message: gitText(r) || `Deleted ${branch}.` };
  const text = gitText(r);
  return fail(/not fully merged/i.test(text) ? `${text} — use Delete (force) if you're sure.` : text);
}

/** Commit exactly the files the operator ticked — GitHub Desktop's model, where there is no visible
 *  staging area. `git add -A` picks up the selection (including deletions and brand-new files), then
 *  `commit --only` limits the commit to those paths so a sibling agent's staged work isn't swept in.
 *  Hooks always run: `--no-verify` is never passed. */
async function doCommit(root: string, summary: string, description: string, paths: string[]): Promise<RepoActionResult> {
  const subject = summary.trim();
  if (!subject) return fail("A commit needs a summary.");
  const bad = paths.find((p) => !validRepoPath(p));
  if (bad !== undefined) return fail(`"${bad}" isn't a valid path in this repository.`);
  if (paths.length === 0) return fail("Select at least one file to commit.");

  const add = await runGit(root, ["add", "-A", "--", ...paths]);
  if (add.code !== 0) return fail(gitText(add) || "git add failed");

  const args = ["commit", "-m", subject];
  const body = description.trim();
  if (body) args.push("-m", body);
  args.push("--only", "--", ...paths);
  const r = await runGit(root, args, NET_TIMEOUT_MS); // hooks (lint/tests) can be slow — give them the network leash
  if (r.code === 0) {
    const head = okOut(await runGit(root, ["rev-parse", "--short", "HEAD"]));
    return { ok: true, message: `Committed ${paths.length} file${paths.length === 1 ? "" : "s"}${head ? ` as ${head}` : ""} — ${subject}` };
  }
  return fail(gitText(r) || "git commit failed");
}

/** Throw away local changes to the given files: tracked ones go back to HEAD (index and working tree
 *  both), untracked ones are deleted. Destructive and irreversible — the console confirms before it
 *  calls this, and the live-agent gate refuses it outright while an agent is working in the repo. */
async function doDiscard(root: string, paths: string[]): Promise<RepoActionResult> {
  const bad = paths.find((p) => !validRepoPath(p));
  if (bad !== undefined) return fail(`"${bad}" isn't a valid path in this repository.`);
  if (paths.length === 0) return fail("Select at least one file to discard.");

  const status = await getGitStatus(root);
  const untrackedSet = new Set(status.files.filter((f) => f.status === "untracked").map((f) => f.path));
  const untracked = paths.filter((p) => untrackedSet.has(p));
  const tracked = paths.filter((p) => !untrackedSet.has(p));

  if (tracked.length > 0) {
    const r = await runGit(root, ["restore", "--source=HEAD", "--staged", "--worktree", "--", ...tracked]);
    if (r.code !== 0) return fail(gitText(r) || "git restore failed");
  }
  if (untracked.length > 0) {
    const r = await runGit(root, ["clean", "-f", "-d", "--", ...untracked]);
    if (r.code !== 0) return fail(gitText(r) || "git clean failed");
  }
  return { ok: true, message: `Discarded changes in ${paths.length} file${paths.length === 1 ? "" : "s"}.` };
}
