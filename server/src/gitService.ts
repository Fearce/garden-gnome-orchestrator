import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";

// The shared git-service layer: real git operations (status, per-file diff, log, branch list, current
// branch, ahead/behind vs upstream, branch checkout) over ARBITRARY task workspaces — the backing for
// the console's in-task "Changes" surface (the GitHub-Desktop replacement). Distinct from update.ts,
// whose runGit is hardcoded to the orchestrator's OWN checkout for self-update; this one takes the repo
// dir as its first argument so it can inspect any repo a task is working in. update.ts can lift its
// runGit onto this module as a follow-up (its self-update semantics layer on top).

const GIT_TIMEOUT_MS = 15_000;
// Bound a pathological diff/log so a runaway repo can't blow the WS frame or the browser. The per-file
// diff truncates to this many bytes; the file list and log are naturally bounded by their own caps.
const DIFF_MAX_BYTES = 200_000;
const LOG_LIMIT = 20;
// Untracked files are shown as all-additions; cap the line count we bother counting so a huge generated
// blob doesn't cost a full read just to render "+N" on the row.
const UNTRACKED_COUNT_CAP = 50_000;

interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run git in `cwd`, resolving with its exit code + captured output (never rejects). Mirrors update.ts's
 *  runGit env hardening: GIT_TERMINAL_PROMPT=0 so a private remote fails fast instead of hanging on a
 *  credential prompt, GIT_OPTIONAL_LOCKS=0 so a read never races an index lock a concurrent agent holds. */
function runGit(cwd: string, args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<GitResult> {
  return new Promise((resolveP) => {
    let stdout = "";
    let stderr = "";
    const child = spawn("git", ["--no-pager", ...args], {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    timer.unref();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => {
      if (stdout.length < DIFF_MAX_BYTES * 2) stdout += c;
    });
    child.stderr.on("data", (c: string) => (stderr += c));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolveP({ code: -1, stdout, stderr: stderr + String((e as Error).message) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveP({ code, stdout, stderr });
    });
  });
}

const out = (r: GitResult): string => r.stdout.trim();
const okOut = (r: GitResult): string | null => (r.code === 0 ? r.stdout.trim() : null);

// ---- repo resolution --------------------------------------------------------------------------------

// Resolution is cached per workspace (including NEGATIVE results) for a few seconds, so a board full of
// cards sharing one workspace doesn't re-run a readdirSync + git rev-parse on every mount. The TTL is
// short enough that a freshly-cloned repo is still picked up promptly.
const repoRootCache = new Map<string, { at: number; root: string | null }>();
const REPO_ROOT_TTL_MS = 15_000;

/** Resolve the git repo a task's work lives in. A task's `workspace` is USUALLY the repo itself, but
 *  it's often the PARENT of a nested repo (e.g. workspace `…/claude-orchastrator` vs. the repo at
 *  `…/claude-orchastrator/claude-orchestrator`, per CLAUDE.md). So: (1) if the workspace is inside a
 *  repo, use that repo's top level; (2) else pick the best nested checkout one level down; (3) else null
 *  (not a repo — the caller surfaces a graceful "no git" state). */
export async function resolveRepoRoot(workspace: string): Promise<string | null> {
  if (!workspace) return null;
  const cached = repoRootCache.get(workspace);
  if (cached && Date.now() - cached.at < REPO_ROOT_TTL_MS) return cached.root;
  const root = await resolveRepoRootUncached(workspace);
  repoRootCache.set(workspace, { at: Date.now(), root });
  return root;
}

async function resolveRepoRootUncached(workspace: string): Promise<string | null> {
  if (!existsSync(workspace)) return null;
  const top = await runGit(workspace, ["rev-parse", "--show-toplevel"]);
  if (top.code === 0 && top.stdout.trim()) return top.stdout.trim();

  // Workspace isn't itself in a repo — look one level down for nested checkouts. A parent that holds
  // MORE THAN ONE nested repo is normal for the orchestrator (sibling worktrees, a `-demo` checkout, a
  // helper clone), so we disambiguate rather than bail: prefer the nested repo whose folder name most
  // resembles the workspace's own folder (longest common prefix — tolerant of typo variants like
  // "claude-orchastrator" vs "claude-orchestrator"), then a real checkout over a linked worktree
  // (.git dir vs .git file), then the shorter name (the base repo over a "-demo"/"-lite" sibling).
  let candidates: { dir: string; name: string; gitIsDir: boolean }[];
  try {
    candidates = [];
    for (const entry of readdirSync(workspace, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const gitPath = join(workspace, entry.name, ".git");
      if (!existsSync(gitPath)) continue;
      let gitIsDir = false;
      try {
        gitIsDir = statSync(gitPath).isDirectory();
      } catch {
        /* a .git file (worktree) — leave gitIsDir false */
      }
      candidates.push({ dir: join(workspace, entry.name), name: entry.name, gitIsDir });
    }
  } catch {
    return null; // unreadable dir
  }
  if (candidates.length === 0) return null;

  const leaf = basename(workspace.replace(/[\\/]+$/, "")).toLowerCase();
  candidates.sort((a, b) => {
    const pa = commonPrefixLen(leaf, a.name.toLowerCase());
    const pb = commonPrefixLen(leaf, b.name.toLowerCase());
    if (pa !== pb) return pb - pa;
    if (a.gitIsDir !== b.gitIsDir) return a.gitIsDir ? -1 : 1;
    return a.name.length - b.name.length;
  });

  const t = await runGit(candidates[0]!.dir, ["rev-parse", "--show-toplevel"]);
  return t.code === 0 && t.stdout.trim() ? t.stdout.trim() : null;
}

/** Length of the shared leading substring of two strings — the name-similarity signal for disambiguating
 *  sibling nested repos (a workspace named like its primary repo scores highest). */
function commonPrefixLen(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

// ---- public shapes (mirrored in web/src/types.ts) ---------------------------------------------------

export type GitFileStatus = "added" | "modified" | "deleted" | "renamed" | "untracked" | "conflicted";

export interface GitFile {
  /** Repo-relative path (the new path for a rename). */
  path: string;
  status: GitFileStatus;
  /** Lines added / removed vs HEAD; both -1 for a binary file (git reports "-"). */
  added: number;
  removed: number;
  binary: boolean;
  /** The pre-rename path, when status is "renamed" (for display). */
  oldPath?: string;
}

export interface GitCommit {
  hash: string; // short
  subject: string;
  author: string;
  /** Epoch ms of the author date. */
  at: number;
  /** Not yet on the push remote (@{push}) — a "committed but not pushed" local commit. */
  local: boolean;
}

/** How the repo's push state should read. "commit-only" is the Vota steady state (neutral, no push nag);
 *  "unpushed" is a normal repo with local commits to push; "pushed" is in sync; "no-remote" has no push
 *  target configured at all. */
export type PushState = "pushed" | "unpushed" | "commit-only" | "no-remote";

export interface GitStatus {
  isRepo: boolean;
  repoRoot: string | null;
  branch: string | null;
  detached: boolean;
  branches: string[];
  /** The tracked upstream ref (@{u}, e.g. "upstream/master") — the pull source. */
  upstreamRef: string | null;
  /** The push destination ref (@{push}, e.g. "origin/master") — where a Push goes. */
  pushRef: string | null;
  /** Commits upstream (@{u}) has that we don't. */
  behind: number;
  /** Local commits not yet on the push remote (@{push}). */
  unpushed: number;
  /** True when `origin` is a Vota repo, where commit-only is the normal steady state. */
  isVota: boolean;
  pushState: PushState;
  hasUncommitted: boolean;
  files: GitFile[];
  commits: GitCommit[];
  /** True when a resolvable dispatch baseline drove the task-scoping (so `files`/`commits` are this task's
   *  net changes since it started). False for a repo-wide status, or a task whose baseline was never
   *  recorded / no longer resolves — the drawer then shows an explicit "no diff anchor recorded" state for
   *  History rather than a full-repo commit dump. */
  hasDiffAnchor: boolean;
  /** Set when git failed / the workspace isn't a repo — a human-readable reason for the empty state. */
  error: string | null;
}

/** The compact header the card's Changes chip renders — cheap enough to fetch per visible card, and
 *  cached per-repo so the many tasks sharing one workspace collapse to a single git run. */
export interface GitSummary {
  isRepo: boolean;
  fileCount: number;
  added: number;
  removed: number;
  /** Commits attributed to this task (baseline..HEAD touching the task's own files). 0 for the
   *  repo-wide summary and whenever no per-task baseline is available. */
  commitCount: number;
  branch: string | null;
  unpushed: number;
  isVota: boolean;
  pushState: PushState;
}

export interface GitFileDiff {
  path: string;
  binary: boolean;
  /** Unified-diff hunks; empty for a binary file or when nothing differs. */
  patch: string;
  /** The patch was clipped at DIFF_MAX_BYTES — the UI offers to open the file instead. */
  truncated: boolean;
}

export interface CheckoutResult {
  ok: boolean;
  branch?: string;
  error?: string;
}

const EMPTY_SUMMARY: GitSummary = { isRepo: false, fileCount: 0, added: 0, removed: 0, commitCount: 0, branch: null, unpushed: 0, isVota: false, pushState: "no-remote" };

// ---- helpers ----------------------------------------------------------------------------------------

/** Map a porcelain XY status pair to a single display status. X = staged, Y = worktree; we collapse to
 *  the most meaningful single verb for the row (a conflict wins, then delete/add/rename, else modified). */
function classify(xy: string): GitFileStatus {
  if (xy === "??") return "untracked";
  if (xy.includes("U") || xy === "AA" || xy === "DD") return "conflicted";
  if (xy.includes("R")) return "renamed";
  if (xy.includes("D")) return "deleted";
  if (xy.includes("A")) return "added";
  return "modified";
}

/** Parse `git status --porcelain=v1 -z` into rows. NUL-delimited; a rename entry is `XY <new>\0<old>\0`,
 *  so a leading R consumes the following record as its source path. */
function parsePorcelain(z: string): { xy: string; path: string; oldPath?: string }[] {
  const parts = z.split("\0").filter((p) => p.length > 0);
  const rows: { xy: string; path: string; oldPath?: string }[] = [];
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i]!;
    const xy = rec.slice(0, 2);
    const path = rec.slice(3);
    if (xy.includes("R") && i + 1 < parts.length) {
      rows.push({ xy, path, oldPath: parts[++i] });
    } else {
      rows.push({ xy, path });
    }
  }
  return rows;
}

/** Build a path → {added, removed, binary} map from `--numstat` output. Binary files print "-\t-\tpath".
 *  With -z the fields are NUL-separated and a rename prints old\0new after the counts. */
function parseNumstat(z: string): Map<string, { added: number; removed: number; binary: boolean }> {
  const map = new Map<string, { added: number; removed: number; binary: boolean }>();
  // `--numstat -z`: each record is "added\tremoved\t" then, for a rename, oldpath\0newpath\0, else path\0.
  const tokens = z.split("\0");
  let i = 0;
  while (i < tokens.length) {
    const head = tokens[i++];
    if (!head) continue;
    const m = /^(-|\d+)\t(-|\d+)\t?(.*)$/.exec(head);
    if (!m) continue;
    const binary = m[1] === "-";
    const added = binary ? -1 : Number.parseInt(m[1]!, 10);
    const removed = binary ? -1 : Number.parseInt(m[2]!, 10);
    let path = m[3] ?? "";
    if (!path) {
      // Rename: the head ended after the tabs, so old/new paths are the next two NUL records.
      /* old */ tokens[i++];
      path = tokens[i++] ?? "";
    }
    if (path) map.set(path, { added, removed, binary });
  }
  return map;
}

/** Count additions for an untracked file (all lines are new), detecting binary by a NUL byte. Bounded so
 *  a huge generated artifact costs a read but not an unbounded one. */
function untrackedCount(repoRoot: string, rel: string): { added: number; binary: boolean } {
  try {
    const buf = readFileSync(join(repoRoot, rel));
    if (buf.includes(0)) return { added: -1, binary: true };
    if (buf.length === 0) return { added: 0, binary: false };
    let lines = 0;
    for (let i = 0; i < buf.length && lines < UNTRACKED_COUNT_CAP; i++) if (buf[i] === 10) lines++;
    // A file with no trailing newline still has a final line.
    if (buf[buf.length - 1] !== 10) lines++;
    return { added: lines, binary: false };
  } catch {
    return { added: 0, binary: false };
  }
}

async function isVotaRepo(repoRoot: string): Promise<boolean> {
  const url = okOut(await runGit(repoRoot, ["remote", "get-url", "origin"]));
  return !!url && /vota/i.test(url);
}

function derivePushState(isVota: boolean, unpushed: number, hasPushRef: boolean): PushState {
  if (isVota) return "commit-only";
  if (!hasPushRef) return "no-remote";
  return unpushed > 0 ? "unpushed" : "pushed";
}

// ---- status -----------------------------------------------------------------------------------------

/** Full git reality for a task's repo: branch + branch list, upstream/push refs, behind/unpushed counts,
 *  the changed-file list with per-file ±counts, and the recent commit log with each commit tagged
 *  local-or-pushed. Never throws — a non-repo / git failure returns isRepo:false with an `error`. */
export async function getGitStatus(workspace: string): Promise<GitStatus> {
  const empty: GitStatus = {
    isRepo: false, repoRoot: null, branch: null, detached: false, branches: [], upstreamRef: null,
    pushRef: null, behind: 0, unpushed: 0, isVota: false, pushState: "no-remote", hasUncommitted: false,
    files: [], commits: [], hasDiffAnchor: false, error: null,
  };
  const repoRoot = await resolveRepoRoot(workspace);
  if (!repoRoot) return { ...empty, error: "Not a git repository." };
  empty.repoRoot = repoRoot;
  empty.isRepo = true;

  const branchRaw = out(await runGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]));
  const detached = branchRaw === "HEAD" || branchRaw === "";
  const branch = detached ? null : branchRaw;

  const branches = (okOut(await runGit(repoRoot, ["branch", "--format=%(refname:short)", "--sort=-committerdate"])) ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  const upstreamRef = okOut(await runGit(repoRoot, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]));
  const pushRef = okOut(await runGit(repoRoot, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{push}"]));

  // behind = commits @{u} has that HEAD lacks. unpushed = commits on HEAD not yet on @{push} (fall back
  // to @{u} when no distinct push ref is configured).
  let behind = 0;
  if (upstreamRef) {
    const c = okOut(await runGit(repoRoot, ["rev-list", "--count", `HEAD..${upstreamRef}`]));
    behind = c ? Number.parseInt(c, 10) || 0 : 0;
  }
  const unpushedRef = pushRef ?? upstreamRef;
  let unpushed = 0;
  const unpushedShas = new Set<string>();
  if (unpushedRef) {
    const list = okOut(await runGit(repoRoot, ["rev-list", `${unpushedRef}..HEAD`]));
    if (list) for (const s of list.split("\n").map((x) => x.trim()).filter(Boolean)) unpushedShas.add(s);
    unpushed = unpushedShas.size;
  }

  const isVota = await isVotaRepo(repoRoot);
  const hasHead = (await runGit(repoRoot, ["rev-parse", "--verify", "-q", "HEAD"])).code === 0;

  const files = await collectFiles(repoRoot, hasHead);
  const commits = await collectCommits(repoRoot, hasHead, unpushedShas, unpushedRef !== null);

  return {
    isRepo: true,
    repoRoot,
    branch,
    detached,
    branches,
    upstreamRef,
    pushRef,
    behind,
    unpushed,
    isVota,
    pushState: derivePushState(isVota, unpushed, pushRef !== null),
    hasUncommitted: files.length > 0,
    files,
    commits,
    hasDiffAnchor: false, // repo-wide status makes no per-task attribution claim
    error: null,
  };
}

/** The changed-file list vs HEAD (staged + unstaged), plus untracked files as all-additions. */
async function collectFiles(repoRoot: string, hasHead: boolean): Promise<GitFile[]> {
  const status = await runGit(repoRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const rows = parsePorcelain(status.stdout);

  // Counts for tracked changes: diff vs HEAD when it exists, else the staged diff (fresh repo, no commit).
  const numstatArgs = hasHead ? ["diff", "--numstat", "-M", "-z", "HEAD"] : ["diff", "--numstat", "-M", "-z", "--cached"];
  const counts = parseNumstat((await runGit(repoRoot, numstatArgs)).stdout);

  const files: GitFile[] = [];
  for (const r of rows) {
    const status = classify(r.xy);
    if (status === "untracked") {
      const { added, binary } = untrackedCount(repoRoot, r.path);
      files.push({ path: r.path, status, added, removed: 0, binary });
    } else {
      const n = counts.get(r.path);
      files.push({
        path: r.path,
        status,
        added: n?.added ?? 0,
        removed: n?.removed ?? 0,
        binary: n?.binary ?? false,
        ...(r.oldPath ? { oldPath: r.oldPath } : {}),
      });
    }
  }
  // Stable, readable ordering: by path.
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

// The one commit-log format both the repo-wide and task-scoped logs use: unit-separator-delimited fields
// so subjects with any punctuation parse cleanly — %H full hash (to test membership in the unpushed set),
// %h short (display), %an author, %at author epoch seconds, %s subject.
const COMMIT_LOG_FORMAT = "--format=%H%x1f%h%x1f%an%x1f%at%x1f%s";

/** Parse `git log` output in COMMIT_LOG_FORMAT into rows, tagging each commit local-or-pushed. Without a
 *  remote ref we can't prove push state, so a commit reads as local (an honest "not pushed"). */
function parseCommitLog(raw: string, unpushedShas: Set<string>, hasRemoteRef: boolean): GitCommit[] {
  const commits: GitCommit[] = [];
  for (const line of raw.split("\n")) {
    const [full, short, author, at, subject] = line.split("\x1f");
    if (!full) continue;
    commits.push({
      hash: short ?? full.slice(0, 8),
      subject: subject ?? "",
      author: author ?? "",
      at: (Number.parseInt(at ?? "", 10) || 0) * 1000,
      local: hasRemoteRef ? unpushedShas.has(full) : true,
    });
  }
  return commits;
}

/** The recent commit log, each row tagged whether it's still local (not on @{push}). */
async function collectCommits(repoRoot: string, hasHead: boolean, unpushedShas: Set<string>, hasRemoteRef: boolean): Promise<GitCommit[]> {
  if (!hasHead) return [];
  const raw = okOut(await runGit(repoRoot, ["log", `-${LOG_LIMIT}`, COMMIT_LOG_FORMAT]));
  if (!raw) return [];
  return parseCommitLog(raw, unpushedShas, hasRemoteRef);
}

// ---- summary (cached per-repo) ----------------------------------------------------------------------

const summaryCache = new Map<string, { at: number; value: GitSummary }>();
const SUMMARY_TTL_MS = 4_000;

/** The compact chip header. Cached per resolved repo root for a few seconds so a board full of tasks
 *  that share one workspace triggers a single git run rather than one per card. */
export async function getGitSummary(workspace: string): Promise<GitSummary> {
  const repoRoot = await resolveRepoRoot(workspace);
  if (!repoRoot) return EMPTY_SUMMARY;
  const cached = summaryCache.get(repoRoot);
  if (cached && Date.now() - cached.at < SUMMARY_TTL_MS) return cached.value;

  const status = await getGitStatus(workspace);
  let added = 0;
  let removed = 0;
  for (const f of status.files) {
    if (f.added > 0) added += f.added;
    if (f.removed > 0) removed += f.removed;
  }
  const value: GitSummary = {
    isRepo: status.isRepo,
    fileCount: status.files.length,
    added,
    removed,
    commitCount: 0, // repo-wide summary makes no per-task commit claim
    branch: status.branch,
    unpushed: status.unpushed,
    isVota: status.isVota,
    pushState: status.pushState,
  };
  summaryCache.set(repoRoot, { at: Date.now(), value });
  return value;
}

// ---- task-scoped summary (the per-task Changes chip) ------------------------------------------------
// The card chip must show only the diff THIS task produced, not the whole working tree (which accretes
// every concurrent task's WIP and any pre-existing dirty state in a repo many agents share). We scope it
// two ways at once: (1) a baseline HEAD captured at dispatch, so only commits/changes SINCE the task
// started count, and (2) the set of files the task's OWN agents wrote (replayed from its recorded tool
// calls — see deliverableCheck.collectTaskWrittenFiles), so a foreign commit or a foreign dirty file is
// excluded even when it landed after the baseline. The one leaky edge is two tasks editing the SAME file:
// that file's delta leaks into both. We attribute conservatively there — prefer under- to over-reporting.

const taskSummaryCache = new Map<string, { at: number; value: GitSummary }>();
const taskStatusCache = new Map<string, { at: number; value: GitStatus }>();

export interface TaskGitScope {
  /** Cache identity — the thread whose chip this is. */
  threadId: string;
  /** HEAD sha at dispatch, or null (legacy row / not a repo at dispatch → graceful fallback below). */
  baselineHead: string | null;
  /** Absolute paths the task's agents wrote/edited (from collectTaskWrittenFiles). */
  taskFiles: string[];
}

/** The compact chip header scoped to a SINGLE task: files/±/commits attributed to it, plus the repo-wide
 *  branch + push state (those are properties of the checkout, not the task, so they stay whole-repo). The
 *  diff is `git diff <baseline> -- <task files>` (committed + staged + unstaged) plus untracked task files,
 *  and commitCount is `rev-list <baseline>..HEAD -- <task files>`. Falls back to a HEAD-relative diff of the
 *  task files when no usable baseline exists — still task-scoped, just unable to attribute past commits.
 *  Never throws. Cached per threadId for a few seconds so a board of cards collapses to one git run each. */
export async function getTaskGitSummary(workspace: string, scope: TaskGitScope): Promise<GitSummary> {
  const cached = taskSummaryCache.get(scope.threadId);
  if (cached && Date.now() - cached.at < SUMMARY_TTL_MS) return cached.value;

  const repoRoot = await resolveRepoRoot(workspace);
  if (!repoRoot) return EMPTY_SUMMARY;

  // Repo-wide branch / push metadata (correct at repo granularity — a push target is not per-task).
  const status = await getGitStatus(workspace);
  const rels = toRepoRelative(repoRoot, scope.taskFiles);

  let added = 0;
  let removed = 0;
  let fileCount = 0;
  let commitCount = 0;

  if (rels.length > 0) {
    const hasHead = (await runGit(repoRoot, ["rev-parse", "--verify", "-q", "HEAD"])).code === 0;
    // Prefer the dispatch baseline; fall back to HEAD (or the staged tree in a repo with no commit yet)
    // when it's missing/unresolvable, so a legacy thread still gets a task-scoped — if commit-blind — chip.
    const baseline = (await isResolvableCommit(repoRoot, scope.baselineHead)) ? scope.baselineHead! : null;
    const diffBase = baseline ?? (hasHead ? "HEAD" : "--cached");
    const counts = parseNumstat(
      (await runGit(repoRoot, ["diff", "--numstat", "-M", "-z", diffBase, "--", ...rels])).stdout,
    );
    for (const [, n] of counts) {
      fileCount++;
      if (n.added > 0) added += n.added;
      if (n.removed > 0) removed += n.removed;
    }
    // `git diff <ref>` compares against the working tree but never lists untracked files — fold in the
    // task's own untracked files (all-additions) from the status we already have.
    const relSet = new Set(rels);
    for (const f of status.files) {
      if (f.status !== "untracked" || !relSet.has(f.path) || counts.has(f.path)) continue;
      fileCount++;
      if (f.added > 0) added += f.added;
    }
    if (baseline) {
      const c = okOut(await runGit(repoRoot, ["rev-list", "--count", `${baseline}..HEAD`, "--", ...rels]));
      commitCount = c ? Number.parseInt(c, 10) || 0 : 0;
    }
  }

  const value: GitSummary = {
    isRepo: status.isRepo,
    fileCount,
    added,
    removed,
    commitCount,
    branch: status.branch,
    unpushed: status.unpushed,
    isVota: status.isVota,
    pushState: status.pushState,
  };
  taskSummaryCache.set(scope.threadId, { at: Date.now(), value });
  return value;
}

// ---- task-scoped status (the per-task Changes DRAWER) ----------------------------------------------
// The drawer was originally repo-wide (GitHub-Desktop semantics): its file list was the whole working
// tree and its History was `git log -20` — which, in a repo many agents share, reads as "the entire repo
// history", not this task's work. We scope it the same way the chip is scoped: the Changes list becomes
// the task's NET file changes since dispatch (`git diff <baseline> -- <task files>`, committed + staged +
// unstaged, plus untracked task files), and History becomes the task's own commits (`git log
// <baseline>..HEAD -- <task files>`). Branch / push / behind / unpushed stay repo-wide — those are
// properties of the checkout, not the task. Same conservative attribution + leaky-shared-file edge as
// getTaskGitSummary. When no usable baseline exists (legacy row / non-repo at dispatch), the file list
// degrades to a HEAD-relative diff of the task files and History reports no anchor (hasDiffAnchor:false)
// rather than dumping the full repo log.

/** Map a `git diff --name-status` letter to our display status. A rename/copy is "R…"/"C…" with a score
 *  suffix (R100); we key off the first letter. Copies read as additions (a new path appears). */
function classifyNameStatus(code: string): GitFileStatus {
  switch (code[0]) {
    case "A": return "added";
    case "D": return "deleted";
    case "R": return "renamed";
    case "C": return "added";
    case "U": return "conflicted";
    case "T": // typechange (e.g. file → symlink) — surface as a modification
    case "M": return "modified";
    default: return "modified";
  }
}

/** Parse `git diff --name-status -M -z` into rows. NUL-delimited; a rename/copy entry is
 *  `Rxxx\0<old>\0<new>\0`, so an R/C status consumes the following TWO records (old then new path). */
function parseNameStatus(z: string): { code: string; path: string; oldPath?: string }[] {
  const parts = z.split("\0").filter((p) => p.length > 0);
  const rows: { code: string; path: string; oldPath?: string }[] = [];
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i]!;
    const first = code[0];
    if ((first === "R" || first === "C") && i + 2 < parts.length) {
      rows.push({ code, oldPath: parts[++i], path: parts[++i]! });
    } else if (i + 1 < parts.length) {
      rows.push({ code, path: parts[++i]! });
    }
  }
  return rows;
}

/** The task's NET changed-file list: `git diff <diffBase> -- <rels>` (statuses via --name-status, ±counts
 *  via --numstat) folded together with the task's own untracked files (which `git diff` never lists). */
async function collectTaskFiles(repoRoot: string, diffBase: string, rels: string[], repoFiles: GitFile[]): Promise<GitFile[]> {
  const nameStatus = parseNameStatus((await runGit(repoRoot, ["diff", "--name-status", "-M", "-z", diffBase, "--", ...rels])).stdout);
  const counts = parseNumstat((await runGit(repoRoot, ["diff", "--numstat", "-M", "-z", diffBase, "--", ...rels])).stdout);

  const files: GitFile[] = [];
  const seen = new Set<string>();
  for (const r of nameStatus) {
    const n = counts.get(r.path);
    files.push({
      path: r.path,
      status: classifyNameStatus(r.code),
      added: n?.added ?? 0,
      removed: n?.removed ?? 0,
      binary: n?.binary ?? false,
      ...(r.oldPath ? { oldPath: r.oldPath } : {}),
    });
    seen.add(r.path);
  }
  // Untracked task files: `git diff <ref>` compares against the working tree but never lists untracked
  // paths, so fold them in (all-additions) from the repo-wide status we already computed.
  const relSet = new Set(rels);
  for (const f of repoFiles) {
    if (f.status !== "untracked" || !relSet.has(f.path) || seen.has(f.path)) continue;
    files.push(f);
    seen.add(f.path);
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

/** The task's own commits: `git log <baseline>..HEAD -- <rels>`, each tagged local-or-pushed against the
 *  same @{push}/@{u} ref the repo-wide status used. Bounded by LOG_LIMIT for parity with the repo log. */
async function collectTaskCommits(repoRoot: string, baseline: string, rels: string[], pushRef: string | null, upstreamRef: string | null): Promise<GitCommit[]> {
  const unpushedRef = pushRef ?? upstreamRef;
  const unpushedShas = new Set<string>();
  if (unpushedRef) {
    const list = okOut(await runGit(repoRoot, ["rev-list", `${unpushedRef}..HEAD`]));
    if (list) for (const s of list.split("\n").map((x) => x.trim()).filter(Boolean)) unpushedShas.add(s);
  }
  const raw = okOut(await runGit(repoRoot, ["log", `-${LOG_LIMIT}`, `${baseline}..HEAD`, COMMIT_LOG_FORMAT, "--", ...rels]));
  if (!raw) return [];
  return parseCommitLog(raw, unpushedShas, unpushedRef !== null);
}

/** Full git status for the drawer, scoped to a SINGLE task: files/commits attributed to it (dispatch
 *  baseline + the task's own written-file set), over the repo-wide branch/push/behind metadata. Mirrors
 *  getTaskGitSummary's scoping so the drawer and the card chip tell the same story. Never throws — a
 *  non-repo / git failure returns the repo-wide empty status with hasDiffAnchor:false. */
export async function getTaskGitStatus(workspace: string, scope: TaskGitScope): Promise<GitStatus> {
  const cached = taskStatusCache.get(scope.threadId);
  if (cached && Date.now() - cached.at < SUMMARY_TTL_MS) return cached.value;

  const status = await getGitStatus(workspace);
  if (!status.isRepo || !status.repoRoot) return status; // already hasDiffAnchor:false + error set
  const repoRoot = status.repoRoot;
  const rels = toRepoRelative(repoRoot, scope.taskFiles);

  const hasHead = (await runGit(repoRoot, ["rev-parse", "--verify", "-q", "HEAD"])).code === 0;
  // Prefer the dispatch baseline; degrade to HEAD (or the staged tree in a repo with no commit yet) when
  // it's missing/unresolvable — still task-scoped, just unable to attribute past commits.
  const baseline = (await isResolvableCommit(repoRoot, scope.baselineHead)) ? scope.baselineHead! : null;
  const diffBase = baseline ?? (hasHead ? "HEAD" : "--cached");

  const files = rels.length > 0 ? await collectTaskFiles(repoRoot, diffBase, rels, status.files) : [];
  // Commits need a real range: with no baseline there's no `<sha>..HEAD` to isolate the task's commits, so
  // History reports "no anchor" instead. With a baseline but no task files, the range would match nothing.
  const commits = baseline && rels.length > 0
    ? await collectTaskCommits(repoRoot, baseline, rels, status.pushRef, status.upstreamRef)
    : [];

  const value: GitStatus = {
    ...status,
    hasUncommitted: files.length > 0,
    files,
    commits,
    hasDiffAnchor: baseline !== null,
  };
  taskStatusCache.set(scope.threadId, { at: Date.now(), value });
  return value;
}

/** True if `sha` names a real commit in this repo — guards the baseline before we diff against it, so a
 *  stale/garbage/foreign sha degrades to the HEAD-relative fallback instead of making git error. */
async function isResolvableCommit(repoRoot: string, sha: string | null): Promise<boolean> {
  if (!sha) return false;
  return (await runGit(repoRoot, ["rev-parse", "--verify", "-q", `${sha}^{commit}`])).code === 0;
}

/** Map absolute task-file paths to repo-relative, forward-slashed pathspecs, dropping any that fall
 *  outside the resolved repo root (a file written directly in the workspace parent, or on another drive).
 *  De-duped. These become the `-- <pathspec>` scope for the task's diff. */
function toRepoRelative(repoRoot: string, absFiles: string[]): string[] {
  const out = new Set<string>();
  for (const f of absFiles) {
    const rel = relative(repoRoot, f).replace(/\\/g, "/");
    if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) continue;
    out.add(rel);
  }
  return [...out];
}

/** The current HEAD sha of a workspace's repo, or null when it isn't a repo / has no commit yet. Used at
 *  dispatch to stamp the task's baseline. */
export async function getHeadSha(workspace: string): Promise<string | null> {
  const repoRoot = await resolveRepoRoot(workspace);
  if (!repoRoot) return null;
  return okOut(await runGit(repoRoot, ["rev-parse", "HEAD"]));
}

// ---- per-file diff (lazy) ---------------------------------------------------------------------------

/** The unified diff for one changed file, truncated to a sane size. When `baseline` names a resolvable
 *  commit (the task's dispatch HEAD) the diff is the file's NET task change — `git diff <baseline> -- file`,
 *  which includes the part the task already committed — matching the task-scoped file list. Without a
 *  baseline it's the working-tree diff vs HEAD (or the staged tree in a fresh repo); an untracked file is
 *  the whole file as additions. Path is validated against the live status set by the caller. */
export async function getFileDiff(workspace: string, relPath: string, baselineHead?: string | null): Promise<GitFileDiff> {
  const repoRoot = await resolveRepoRoot(workspace);
  if (!repoRoot) return { path: relPath, binary: false, patch: "", truncated: false };

  const hasHead = (await runGit(repoRoot, ["rev-parse", "--verify", "-q", "HEAD"])).code === 0;
  const baseline = (await isResolvableCommit(repoRoot, baselineHead ?? null)) ? baselineHead! : null;
  const tracked = (await runGit(repoRoot, ["ls-files", "--error-unmatch", "--", relPath])).code === 0;
  // A file the task deleted or renamed away is no longer in the index (tracked=false) but existed at the
  // baseline — `git diff <baseline>` renders it correctly, so treat "present at baseline" as diffable too.
  const inBaseline = baseline ? (await runGit(repoRoot, ["cat-file", "-e", `${baseline}:${relPath}`])).code === 0 : false;

  let res: GitResult;
  if (!tracked && !inBaseline) {
    // Untracked / brand-new file: diff against the empty tree so the whole content shows as additions.
    // --no-index exits 1 when files differ, which is the normal case — read stdout regardless of code.
    res = await runGit(repoRoot, ["diff", "--no-index", "--", nullDevice(), relPath]);
  } else if (baseline) {
    res = await runGit(repoRoot, ["diff", "-M", baseline, "--", relPath]);
  } else {
    res = await runGit(repoRoot, hasHead ? ["diff", "-M", "HEAD", "--", relPath] : ["diff", "-M", "--cached", "--", relPath]);
  }

  const full = res.stdout;
  const binary = /\bBinary files? .* differ\b/.test(full) || full.includes("GIT binary patch");
  const truncated = full.length > DIFF_MAX_BYTES;
  const patch = binary ? "" : truncated ? full.slice(0, DIFF_MAX_BYTES) : full;
  return { path: relPath, binary, patch, truncated };
}

/** The platform's null device, so an untracked-file diff has a valid empty "before" side. git accepts
 *  /dev/null on every platform including Windows, but NUL is the native form there. */
function nullDevice(): string {
  return process.platform === "win32" ? "NUL" : "/dev/null";
}

// ---- read-only git for the reader lane --------------------------------------------------------------
// The reader micro-pipeline gets git HISTORY without a shell: an allowlisted git_read MCP tool (see
// bus/gitReadServer.ts) that runs ONLY these subcommands through the same execFile-style `runGit` path
// used everywhere above. Enforcement is here, not in the prompt — the allowlist plus the arg-denylist are
// the trust boundary, mirroring how the console's other git surfaces never shell out.

/** The only git subcommands the reader may run — all strictly read-only (they cannot mutate the repo,
 *  index, refs, or remotes regardless of their arguments). Widening this set is a security decision. */
export const GIT_READ_SUBCOMMANDS = ["log", "show", "status", "diff"] as const;
export type GitReadSubcommand = (typeof GIT_READ_SUBCOMMANDS)[number];

// Even a read-only subcommand has a couple of args that escape read-only-ness: `git diff --output=<f>`
// writes the diff to a FILE, and `--ext-diff` runs an external diff driver (arbitrary configured command).
// Reject those so the reader can't turn a "read" into a write or a shell-out.
const GIT_READ_ARG_DENY = /^(--output(=|$)|-o$|--ext-diff$)/;

export interface GitReadResult {
  ok: boolean;
  /** Combined trimmed stdout (truncated to DIFF_MAX_BYTES), or "" on rejection/failure. */
  output: string;
  /** Human-readable reason when ok is false (rejected subcommand/arg, not-a-repo, or git failure). */
  error: string | null;
}

/** Validate a reader git request against the allowlist + arg-denylist WITHOUT running anything — the pure
 *  core the unit test exercises (writes like push/commit rejected, log/show/status/diff accepted). */
export function validateGitRead(subcommand: string, args: string[]): { ok: true } | { ok: false; error: string } {
  if (!GIT_READ_SUBCOMMANDS.includes(subcommand as GitReadSubcommand)) {
    return {
      ok: false,
      error: `git "${subcommand}" is not permitted in the read lane — only ${GIT_READ_SUBCOMMANDS.join(", ")} are allowed. If you need to modify or run anything, escalate to the full pipeline instead.`,
    };
  }
  const bad = args.find((a) => GIT_READ_ARG_DENY.test(a));
  if (bad) return { ok: false, error: `argument "${bad}" is not permitted — it can write a file or run an external command.` };
  return { ok: true };
}

/** Run an allowlisted read-only git subcommand in a task's repo and return its text output. Reuses the
 *  hardened `runGit` (no shell, GIT_TERMINAL_PROMPT=0, GIT_OPTIONAL_LOCKS=0) and the same repo resolution
 *  as every other git surface. Never throws — a rejection / non-repo / git error comes back as ok:false. */
export async function runReadonlyGit(workspace: string, subcommand: string, args: string[] = []): Promise<GitReadResult> {
  const v = validateGitRead(subcommand, args);
  if (!v.ok) return { ok: false, output: "", error: v.error };
  const repoRoot = await resolveRepoRoot(workspace);
  if (!repoRoot) return { ok: false, output: "", error: "Not a git repository." };
  const res = await runGit(repoRoot, [subcommand, ...args]);
  const raw = res.stdout;
  const output = raw.length > DIFF_MAX_BYTES ? raw.slice(0, DIFF_MAX_BYTES) + "\n… (output truncated)" : raw;
  return {
    ok: res.code === 0,
    output: output.trim(),
    error: res.code === 0 ? null : (res.stderr.trim() || `git ${subcommand} exited ${res.code ?? "?"}`),
  };
}

// ---- branch checkout --------------------------------------------------------------------------------

/** Switch the repo to `branch`. The caller (ThreadManager) enforces the safety lock — it refuses while
 *  any agent is live on the repo. Here we just run the checkout and report a graceful result (a dirty
 *  tree that would be overwritten makes git refuse, which we surface rather than force). */
export async function checkoutBranch(workspace: string, branch: string): Promise<CheckoutResult> {
  const repoRoot = await resolveRepoRoot(workspace);
  if (!repoRoot) return { ok: false, error: "Not a git repository." };

  // Validate the branch exists locally so we never accidentally create one or check out arbitrary input.
  const exists = (await runGit(repoRoot, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`])).code === 0;
  if (!exists) return { ok: false, error: `No local branch "${branch}".` };

  const res = await runGit(repoRoot, ["checkout", branch]);
  if (res.code !== 0) {
    return { ok: false, error: (res.stderr || res.stdout).trim() || "git checkout failed" };
  }
  // Bust the summary caches so the chip reflects the new branch immediately. The task cache is keyed by
  // threadId (not repoRoot), and a checkout changes the repo for every task sharing it, so clear it whole.
  summaryCache.delete(repoRoot);
  taskSummaryCache.clear();
  taskStatusCache.clear();
  return { ok: true, branch };
}
