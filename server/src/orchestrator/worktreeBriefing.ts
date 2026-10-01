import type { TaskWorktree, WorkspaceMode } from "../types.js";
import { worktreesHome } from "./taskWorktree.js";

export interface BriefingInput {
  threadId: string;
  workspace: string;
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
    `- Never run \`git worktree remove\` on this folder: git deletes the main checkout's packages through those junctions. GGO removes it safely when the task is closed.`,
    ...integrationLines(w, input),
  ];
}

function integrationLines(w: TaskWorktree, input: BriefingInput): string[] {
  if (w.commitOnly) {
    return [`- When the work is done: commit on \`${w.branch}\` only. Never push it and never merge it into another branch; ${input.owner} reviews, merges and pushes it. Name the branch in your final report.`];
  }
  if (!w.base) {
    return [`- When the work is done: commit on \`${w.branch}\` and name it in your final report; the main checkout was on a detached HEAD, so there is no base branch to integrate into.`];
  }
  const ff = `\`git -C "${w.repo}" merge --ff-only ${w.branch}\` when the main checkout has \`${w.base}\` checked out, otherwise \`git fetch . ${w.branch}:${w.base}\` from this worktree`;
  const push = input.autoPush ? `, then push \`${w.base}\`` : ` (auto-push is OFF for this task, so do not push)`;
  return [
    `- When the work is done and verified, integrate it: commit, rebase \`${w.branch}\` onto the latest \`${w.base}\` (pull it first when it tracks a remote) and resolve any conflicts here, then fast-forward \`${w.base}\` to it with ${ff}${push}. Re-run the checks that matter after the rebase. Anything that must run from the main checkout (a deploy of the running app) runs there after the fast-forward.`,
  ];
}

function umbrellaBriefing(input: BriefingInput): string {
  const branch = `ggo/<name>-${input.threadId.slice(0, 8)}`;
  const example = `${input.workspace.replace(/[\\/]+$/, "")}\\<repo>`;
  return [
    "## Branch & worktree",
    `Your workspace \`${input.workspace}\` is not itself a git repository; it holds several. Other tasks and ${input.owner} use their main checkouts, so never edit, switch branches, stash or reset in them.`,
    `- Before you change ANY repository in here, call \`task_worktree\` with that repository's path and a \`name\`: 2–4 lowercase hyphenated words naming the work you will do there (e.g. \`crawler-email-extraction\`), never the opening words of the request. Pass \`branch\` instead to continue an existing branch. It returns this task's own worktree and branch for that repo; do all edits, builds and commits there. Calling it again for the same repo returns the same worktree.`,
    `- If you have no \`task_worktree\` tool, create it yourself with exactly this naming so GGO can find it, your own words in place of \`<name>\`: \`git -C "${example}" worktree add -b ${branch} "${worktreesHome(example)}\\<name>"\`.`,
    input.borrowed
      ? "- The worktree belongs to your parent task, which integrates it: do not switch branches, rebase, merge or push. Never run `git worktree remove` on a task worktree."
      : `- Integration follows the repository's rule: in a commit-only (never-push) repository leave the work committed on the task branch for ${input.owner}; elsewhere rebase onto the base branch, fast-forward it and push. Never run \`git worktree remove\` on a task worktree: GGO removes it when the task is closed.`,
    "- Read-only investigation needs no worktree. Name every branch you committed to in your final report.",
  ].join("\n");
}
