import { createHash } from "node:crypto";
import { existsSync, readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { runGit } from "../gitService.js";

// The "## Current workspace progress (git)" block appended to every resumed agent's kickoff
// (`composeResumeKickoff` in threadManager.ts). This used to be a bespoke `git()` helper that resolved
// with `stdout || stderr || err.message` regardless of exit code: "resolve with whatever text git
// printed, success or not." `git diff`/`git diff --stat` fall back to `--no-index` mode when the cwd is
// not a repo and print their FULL usage block to stderr, so a workspace that is merely the PARENT of
// several checkouts (a normal, currently-live setup here: several agents share one parent directory and
// each works in a child repo) had that usage text quoted into the prompt as if it were real workspace
// state. Measured against a real non-repo parent workspace: `git diff --stat` alone was 7,221 bytes of
// `git diff --no-index` usage text, `git diff` another 7,221 bytes (6,000 of it surviving the existing
// truncation cap as garbage rather than a diff), roughly 13.2 KB (about 3,500 tokens) of `git diff --help`
// text injected into the prompt, with only the two-line "not a git repository" fatal from `git log` as a
// hint anything was wrong.
//
// The fix: probe with `git rev-parse --is-inside-work-tree` and key off its EXIT STATUS, never its text,
// before running anything else; a non-repo workspace gets one short line instead. Since the exact failure
// mode above is a workspace that is the PARENT of the agent's real repo, that line also lists the
// immediate child directories that ARE git repos (a cheap `.git` existence check per child, no `git log`
// per child, no recursion), so the resumed agent knows where to actually look.
const MAX_DIFF_CHARS = 6000;
// Bound the child-repo listing so a workspace with hundreds of siblings can't bloat the kickoff: this is
// a pointer for the agent, not an inventory.
const MAX_CHILD_REPOS_LISTED = 20;

/** The git-progress block for a resume kickoff: recent commits, `git diff --stat`, and a capped `git diff`
 *  for a real repo; one short "not a repo, here is where to look" line otherwise. `runGit` (gitService.ts)
 *  is the same hardened, worker-thread-backed spawn every other git surface in the app uses: it resolves
 *  with an exit code, so a caller (this one included) never has to guess success from text. */
export async function buildGitProgressBlock(workspace: string): Promise<string> {
  const probe = await runGit(workspace, ["rev-parse", "--is-inside-work-tree"]);
  if (probe.code !== 0) return nonRepoProgress(workspace);

  const [log, stat, diff] = await Promise.all([
    runGit(workspace, ["log", "--oneline", "-8"]),
    runGit(workspace, ["diff", "--stat"]),
    runGit(workspace, ["diff"]),
  ]);
  // Only a SUCCESSFUL command's stdout is real output, never a fallback to stderr on failure, which is
  // the exact defect this replaces. A failed read (rare once we know it is a repo: a mid-run index lock,
  // the timeout) reports as empty rather than quoting whatever git printed to stderr.
  const logText = log.code === 0 ? log.stdout.trim() : "";
  const statText = stat.code === 0 ? stat.stdout.trim() : "";
  const diffText = diff.code === 0 ? diff.stdout.trim() : "";
  const cappedDiff =
    diffText.length > MAX_DIFF_CHARS ? diffText.slice(0, MAX_DIFF_CHARS) + "\n... (diff truncated, read the files for the rest)" : diffText;
  return [
    "Recent commits:",
    logText || "(none yet)",
    "",
    "Uncommitted changes (git diff --stat):",
    statText || "(none)",
    cappedDiff ? `\nUncommitted diff:\n${cappedDiff}` : "",
  ].join("\n");
}

/** A hash of the workspace's git state (HEAD, status and diff against HEAD) — equal before and after a
 *  session that changed nothing. Covers the parent-of-checkouts case the same way the block above does,
 *  bounded to the same child listing. Null when there is no repo to read, which callers must treat as
 *  "unknown", never as "changed". */
export async function workspaceGitFingerprint(workspace: string): Promise<string | null> {
  const probe = await runGit(workspace, ["rev-parse", "--is-inside-work-tree"]);
  const repos = probe.code === 0 ? [workspace] : childRepoNames(workspace).slice(0, MAX_CHILD_REPOS_LISTED).map((n) => join(workspace, n));
  if (repos.length === 0) return null;
  const hash = createHash("sha1");
  for (const repo of repos) {
    const reads = await Promise.all([
      runGit(repo, ["rev-parse", "HEAD"]),
      runGit(repo, ["status", "--porcelain"]),
      runGit(repo, ["diff", "HEAD"]),
    ]);
    hash.update(repo);
    for (const r of reads) hash.update(`\0${r.code}\0${r.stdout}`);
  }
  return hash.digest("hex");
}

/** The workspace itself is not a repo, so point at whichever immediate children are, instead of running
 *  `git diff` here at all. Name-only and bounded: this is a pointer for the agent to read into, not a
 *  repo inventory, so no per-child `git log`/`git status`, just a cheap `.git` existence check. */
function nonRepoProgress(workspace: string): string {
  const repoNames = childRepoNames(workspace);
  const shown = repoNames.slice(0, MAX_CHILD_REPOS_LISTED);
  const overflow = repoNames.length - shown.length;
  const childLine =
    repoNames.length === 0
      ? "No child directory here looks like a git repo either, nothing obvious to point you at."
      : `Child directories that ARE git repos: ${shown.join(", ")}${overflow > 0 ? ` (+${overflow} more)` : ""}.`;
  return [
    "This workspace itself is not a git repository (`git rev-parse --is-inside-work-tree` failed), so git status/diff here is skipped to avoid quoting git's own usage text as if it were workspace state.",
    childLine,
  ].join("\n");
}

function childRepoNames(workspace: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(workspace, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => existsSync(join(workspace, name, ".git")))
    .sort((a, b) => a.localeCompare(b));
}
