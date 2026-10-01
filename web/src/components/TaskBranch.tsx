import { normalizeWorkspace, type Thread, type TaskWorktree } from "../types.js";
import { useCodeContext } from "./CodeContextBar.js";
import { splitWorkspace } from "./WorkspacePath.js";
import "./taskBranch.css";

/**
 * The task header's answer to "which branch is this task on, and where": one line per worktree the task
 * owns (its branch, the worktree folder, the branch it was cut from), or — for a task working in place —
 * the main checkout's current branch as the code context resolved it. Renders nothing until there is a
 * branch to name, so a still-locating context never shows a placeholder.
 */
export function TaskBranch({ thread }: { thread: Thread }) {
  const worktrees = thread.worktrees ?? [];
  if (worktrees.length) {
    return (
      <div className="task-branch">
        {worktrees.map((w) => (
          <WorktreeLine key={w.path} worktree={w} showRepo={worktrees.length > 1 || !isSameRepo(w, thread)} />
        ))}
      </div>
    );
  }
  return <InPlaceLine thread={thread} />;
}

function WorktreeLine({ worktree, showRepo }: { worktree: TaskWorktree; showRepo: boolean }) {
  const folder = splitWorkspace(worktree.path).leaf.replace(/^[\\/]+/, "");
  const repo = splitWorkspace(worktree.repo).leaf.replace(/^[\\/]+/, "");
  return (
    <div
      className="task-branch-line"
      title={`Branch ${worktree.branch} in its own worktree ${worktree.path}, cut from ${worktree.base ?? "a detached HEAD"} at ${worktree.baseSha.slice(0, 8)} of ${worktree.repo}`}
    >
      <BranchIcon />
      {showRepo ? <span className="task-branch-repo">{repo}</span> : null}
      <b className="task-branch-name">{worktree.branch}</b>
      <span className="task-branch-tag">worktree</span>
      <span className="task-branch-folder">{folder}</span>
      {worktree.base ? <span className="task-branch-base">from {worktree.base}</span> : null}
      {worktree.commitOnly ? <span className="task-branch-tag commit-only">commit-only</span> : null}
    </div>
  );
}

function InPlaceLine({ thread }: { thread: Thread }) {
  const context = useCodeContext({ kind: "thread", id: thread.id });
  if (!context || context.gitPending || !context.repoPath || !context.branch) return null;
  return (
    <div className="task-branch">
      <div className="task-branch-line" title={`Working in the main checkout ${context.repoPath} on ${context.branch}`}>
        <BranchIcon />
        <b className={"task-branch-name" + (context.detached ? " detached" : "")}>{context.branch}</b>
        <span className="task-branch-tag shared">main checkout</span>
      </div>
    </div>
  );
}

/** Whether the task was dispatched into this worktree's repository (rather than an umbrella folder holding
 *  it), in which case the repo name would only repeat the folder chip beside it. */
function isSameRepo(worktree: TaskWorktree, thread: Thread): boolean {
  const home = normalizeWorkspace(thread.homeWorkspace ?? "");
  const repo = normalizeWorkspace(worktree.repo);
  return home === repo || home.startsWith(repo + "/");
}

function BranchIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="6" cy="5" r="2.5" />
      <circle cx="6" cy="19" r="2.5" />
      <circle cx="18" cy="9" r="2.5" />
      <path d="M6 7.5v9M18 11.5c0 3-4 3.5-6 4.5" />
    </svg>
  );
}
