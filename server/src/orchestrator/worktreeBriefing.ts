import type { TaskWorktree, WorkspaceMode } from "../types.js";
import { worktreesHome } from "./taskWorktree.js";

export interface BriefingInput {
  threadId: string;
  workspace: string;
  /** The top of the repository a `guided` task was dispatched into (its workspace may be a subfolder). */
  repoRoot?: string | null;
  mode: WorkspaceMode | undefined;
  worktrees: readonly TaskWorktree[];
  owner: string;
  /** The task may push (the auto-push setting). A commit-only repo never pushes regardless. */
  autoPush: boolean;
  /** A sub-task or collaborator in its parent's worktree: the parent integrates, so this one only commits. */
  borrowed?: boolean;
}

/** The "## Branch & worktree" kickoff section, or null when the task works in place. Pure, so the
 *  implementor, the default-mode lane and QA all read the same words. */
export function worktreeBriefing(input: BriefingInput): string | null {
  if (input.mode === "umbrella") return umbrellaBriefing(input);
  if (input.mode === "guided") return guidedBriefing(input);
  if (input.mode !== "worktree" || !input.worktrees.length) return null;
  if (input.borrowed) return ["## Branch & worktree", ...input.worktrees.map(borrowedLine)].join("\n");
  return ["## Branch & worktree", ...input.worktrees.flatMap((w) => ownWorktreeLines(w, input))].join("\n");
}

function borrowedLine(w: TaskWorktree): string {
  return `You work in your parent task's own git worktree \`${w.path}\`, on branch \`${w.branch}\`. Edit and build only there, never in the main checkout \`${w.repo}\`. Do not switch branches, rebase, merge or push: the parent task integrates the branch. Never run \`git worktree remove\` on it.`;
}

function ownWorktreeLines(w: TaskWorktree, input: BriefingInput): string[] {
  const base = w.base ? `\`${w.base}\`` : `commit ${w.baseSha.slice(0, 8)}`;
  return [
    `This task has its OWN git worktree: \`${w.path}\`, on branch \`${w.branch}\`, cut from ${base} of the main checkout \`${w.repo}\`. Nobody else works in this folder, so parallel tasks cannot collide with you. The main checkout and other tasks' worktrees are not yours: never edit, switch branches, stash or reset there.`,
    "- Commit on this branch, in this folder.",
    "- Dependency folders such as `node_modules` here are junctions to the main checkout's. If you change dependencies, delete the junction first (`cmd /c rmdir node_modules`) and install a real copy, so the main checkout's packages stay untouched.",
    `- Never run \`git worktree remove\` on this folder: git deletes the main checkout's packages through those junctions. GGO removes it safely once the task is done and its branch is integrated.`,
    ...integrationLines(w, input),
  ];
}

function integrationLines(w: TaskWorktree, input: BriefingInput): string[] {
  if (!w.base) {
    return [`- When the work is done: commit on \`${w.branch}\` and name it in your final report; the main checkout was on a detached HEAD, so there is no base branch to integrate into.`];
  }
  const ff = `\`git -C "${w.repo}" merge --ff-only ${w.branch}\` when the main checkout has \`${w.base}\` checked out, otherwise \`git fetch . ${w.branch}:${w.base}\` from this worktree`;
  const rebase = `commit, rebase \`${w.branch}\` onto the latest \`${w.base}\` (pull it first when it tracks a remote) and resolve any conflicts here, then fast-forward \`${w.base}\` to it with ${ff}`;
  if (w.commitOnly) {
    return [
      `- When the work is done and verified, integrate it locally: ${rebase}. Never push: this repository is commit-only, and pushing \`${w.base}\` (and merging its pull request) is the one step ${input.owner} keeps. Never leave the fast-forward to ${input.owner} either: the task is not finished while its work sits only on \`${w.branch}\`. Re-run the checks that matter after the rebase, and name \`${w.base}\` and its new head commit in your final report.`,
    ];
  }
  const push = input.autoPush ? `, then push \`${w.base}\`` : ` (auto-push is OFF for this task, so do not push)`;
  return [
    `- When the work is done and verified, integrate it: ${rebase}${push}. Re-run the checks that matter after the rebase. Anything that must run from the main checkout (a deploy of the running app) runs there after the fast-forward.`,
  ];
}

/** A task in a repo's main checkout. A worktree is guidance for a shared repository, never a move GGO
 *  makes; once the agent has claimed one, every later kickoff names it like an own worktree. */
function guidedBriefing(input: BriefingInput): string | null {
  if (input.worktrees.length) {
    if (input.borrowed) return ["## Branch & worktree", ...input.worktrees.map(borrowedLine)].join("\n");
    return [
      "## Branch & worktree",
      `Other agents shared this repository, so this task claimed its own worktree. Your session may still start in the main checkout \`${input.workspace}\`: do every edit, build and commit in the worktree below, never there.`,
      ...input.worktrees.flatMap((w) => ownWorktreeLines(w, input)),
    ].join("\n");
  }
  if (input.borrowed) return null;
  const repo = input.repoRoot ?? input.workspace;
  const branch = `ggo/<name>-${input.threadId.slice(0, 8)}`;
  return [
    "## Branch & worktree",
    `You start in the main checkout \`${input.workspace}\` on its current branch, which other tasks and ${input.owner} may also use.`,
    `- If your brief, repository instructions or ${input.owner} names the branch to work on (e.g. "my current branch" or a documented master-only workflow), that wins over everything below: work on that branch where it is checked out, claim no worktree and create no branch.`,
    `- While you are alone in this repository (your brief has no OFFICE section and no "teammate just joined" message has arrived), work here directly.`,
    `- When another agent works in this repository and you have not edited anything yet, call \`task_worktree\` with \`${repo}\` and a \`name\` before your first edit: 2–4 lowercase hyphenated words naming your work (e.g. \`crawler-email-extraction\`), never the opening words of the request. It returns your own branch and worktree; do every edit, build and commit there. If you already have uncommitted edits here, stay, coordinate in the office and commit all reviewed pending changes, preserving peer work in separately attributed commits.`,
    `- If you have no \`task_worktree\` tool, create the worktree yourself with exactly this naming so GGO can find it, your own words in place of \`<name>\`: \`git -C "${repo}" worktree add -b ${branch} "${worktreesHome(repo)}\\<name>"\`. Never run \`git worktree remove\` on a task worktree: GGO removes it once the task is done and its branch is integrated.`,
    "- Read-only investigation needs no worktree. Name every branch you committed to in your final report.",
  ].join("\n");
}

function umbrellaBriefing(input: BriefingInput): string {
  const branch = `ggo/<name>-${input.threadId.slice(0, 8)}`;
  const example = `${input.workspace.replace(/[\\/]+$/, "")}\\<repo>`;
  return [
    "## Branch & worktree",
    `Your workspace \`${input.workspace}\` is not itself a git repository; it holds several. Other tasks and ${input.owner} use their main checkouts, so never edit, switch branches, stash or reset in them.`,
    `- Before you change ANY repository in here, call \`task_worktree\` with that repository's path and a \`name\`: 2–4 lowercase hyphenated words naming the work you will do there (e.g. \`crawler-email-extraction\`), never the opening words of the request. Pass \`branch\` instead to continue an existing branch. It returns this task's own worktree and branch for that repo; do all edits, builds and commits there. Calling it again for the same repo returns the same worktree.`,
    `- If you have no \`task_worktree\` tool, create it yourself with exactly this naming so GGO can find it, your own words in place of \`<name>\`: \`git -C "${example}" worktree add -b ${branch} "${worktreesHome(example)}\\<name>"\`.`,
    `- If your brief or ${input.owner} names the branch to work on in a repository (e.g. "my current branch"), that overrides the rules above for it: work on that branch in the checkout that already has it, or pass it as \`branch\` when no checkout has it.`,
    input.borrowed
      ? "- The worktree belongs to your parent task, which integrates it: do not switch branches, rebase, merge or push. Never run `git worktree remove` on a task worktree."
      : `- When the work is done, integrate every task branch yourself: rebase it onto its base branch and fast-forward the base to it. Then push the base, except in a commit-only (never-push) repository, where pushing is the one step ${input.owner} keeps. Never leave a merge or fast-forward for ${input.owner}. Never run \`git worktree remove\` on a task worktree: GGO removes it once the task is done and its branch is integrated.`,
    "- Read-only investigation needs no worktree. Name every branch you committed to in your final report.",
    ...input.worktrees.map((w) => `- Already claimed: \`${w.path}\` on branch \`${w.branch}\` for \`${w.repo}\`.`),
  ].join("\n");
}
