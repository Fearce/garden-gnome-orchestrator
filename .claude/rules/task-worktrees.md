---
paths:
  - "server/src/orchestrator/taskWorktree.ts"
  - "server/src/orchestrator/worktreeBriefing.ts"
  - "server/src/tests/taskWorktree*"
  - "web/src/components/TaskBranch.tsx"
  - "server/scripts/deploy.cjs"
---

# Task worktrees — every task on its own branch, in its own checkout

Built 2026-10-01 (`efc48b7`, gates fix after it). Before this, every task in a repo shared one working tree. A 33-hour Vota task blocked all other Vota work, and agents had to stage hunks around each other. The rule "never create Claude worktrees" is **reversed**: the owner's global `CLAUDE.md` (Branching section) and memory `feedback_one_task_one_branch_worktree.md` carry the machine-wide version.

## The model
- **`thread.workspace` is where agents run; `thread.homeWorkspace` is where the task was dispatched.** `prepareTaskWorkspace` (threadManager, called at the top of `runPipeline` and on read-lane escalation) moves a new top-level task into `createTaskWorktree`'s checkout. That checkout is branch `ggo/<title-slug>-<id8>` in `<repo-parent>/<repo>.worktrees/<slug>`, cut from whatever the main checkout has checked out. A task dispatched on `<repo>/web` lands in `<worktree>/web` (`mapIntoWorktree`). Every `cwd`/git/diff/deliverable call site keeps reading `workspace` unchanged, which is why the binding is a workspace swap rather than a new field read in ~90 places. Grouping keys on `homeWorkspace ?? workspace` (board repo chip, office rooms and gnome huddles, per-repo concurrency cap, per-repo model history), so a task in a worktree still groups with its repo. Rows from before the feature have `homeWorkspace` null and work in place forever.
- **`stageOutputs.workspaceMode`** records the decision once: `worktree`, `umbrella` (a non-git folder holding several repos), or `in-place` (not a repo, or the owner pointed the task at a worktree they made). A failed `git worktree add` persists nothing, so the next start retries.
- **The `baselineHead` is the branch's `baseSha`**, so the task's diff is its own branch, not whatever landed on the main checkout since.
- **Who gets one:** top-level, non-read-lane tasks with `homeWorkspace` set and the setting `taskWorktrees` on (Settings › Pipeline). Sub-tasks and shotgun collaborators share their parent's worktree (`worktreeSection` with `borrowed`). A read lane gets one only if it escalates to work.
- **Umbrella workspaces:** the implementor and QA have the bus tool `task_worktree(repo, branch?)` (`claimTaskWorktree`). It creates or returns the task's worktree for one child repo and records it on the parent when a sub-task calls it. CLI backends (Codex/Grok) have no bus tool, so the kickoff gives them the exact `git worktree add -b ggo/<slug>-<id8>` command, and `syncUmbrellaWorktrees` (from `publishState` on qa/review/done/paused) discovers worktrees by that branch suffix.
- **Integration lives in the kickoff, not in GGO:** `worktreeBriefing.ts` tells the agent to rebase onto the base, fast-forward the base (`merge --ff-only` in the main checkout, or `git fetch . branch:base`), and push when auto-push is on. In a commit-only (Vota) repo the work stays committed on the task branch. QA's fresh rounds get the same section.

## Traps that already cost something
- **`git worktree remove` follows a junction and empties the MAIN checkout's `node_modules`.** `provisionWorktree` junctions every ignored `node_modules`/`.venv`/`venv` (in this repo that means `relay/`, `server/` and `web/`), so `retireTaskWorktree` unlinks every symlink among the worktree's ignored entries FIRST. That covers the recorded `links` and any junction an agent made by hand, because a discovered umbrella worktree has `links: []`. The revert-check proved it: with only recorded links unlinked, `test:task-worktree` F deletes the main checkout's package. Agents are told never to run `git worktree remove` themselves. To clean up stale worktrees by hand, do the same: `fs.unlinkSync` every symlink under the folder, then `git worktree remove --force`.
- **Retirement is conservative.** It runs at close/dismiss/purge (`retireWorktreesOf`) and removes the folder only when `git status` is clean and no deliverable lives inside. It deletes the branch only when it is merged into its base or never moved. An unmerged branch is the owner's work and stays. `ensureWorktreesPresent` re-attaches the branch on resume, retry, QA or auto-review.
- **Gates dispatch into THIS checkout.** The setting defaults on only for the server's own DB (`Db.isServerDb`, i.e. `config.dbPath`). Before that fix, every `vanilla-lane`/`route-pipeline` run cut real `ggo/*` worktrees beside this checkout, and the slow `git worktree add` raced the harness's dispose ("database connection is not open"). A gate that needs worktrees opts in with `mgr.setSettings({ taskWorktrees: true })` on throwaway repos, as `test:task-worktree-pipeline` does.
- **Deploying GGO from a task worktree is refused** (`deploy.cjs` `refuseLinkedWorktree`): prod runs the main checkout's `dist`. Integrate first, then run `npm run deploy --prefix server` from the main checkout.

## Gates
`npm run test:task-worktree` covers the git layer and the briefing against real repos. `npm run test:task-worktree-pipeline` covers ThreadManager binding, sub-tasks, read lanes, restore, `task_worktree` claims and retire-on-close. `test:deploy-plan` covers the linked-worktree guard. `npm run task-branch-lab --prefix server` is a browser lab: it renders the header's branch line for a worktree task and an in-place task at desktop and phone width, and flips the setting. For uncommitted work, run it with `GGO_LAB_ENTRY`/`GGO_LAB_WEB_DIST` as described in `lab-harness.cjs`.
