---
paths:
  - server/src/gitService.ts
  - server/src/git/repoOps.ts
  - server/src/orchestrator/repoConsole.ts
  - web/src/components/GitChanges.tsx
  - web/src/components/GitConsole.tsx
  - server/src/orchestrator/codeContext.ts
  - web/src/components/CodeContextBar.tsx
---

# The per-task Git / Changes surface (chip + drawer data flow)

Two tiers, both **scoped to a single task** (not repo-wide) via its dispatch
`baselineHead` + the set of files its own agents wrote (`collectTaskWrittenFiles`),
so a foreign commit / dirty file is excluded. Trace before you touch it:

- **Chip** (`ChangesChip`, on every Board card) — the compact header: file count,
  ±lines, a status dot. Auto-loads `loadGitSummary` on mount AND prefetches the full
  `loadGitStatus` (keyed on the summary's count signature) so the drawer opens
  instantly — no "Loading git status…" click-to-load. Renders nothing until the
  summary confirms `isRepo`.
- **Drawer** (`GitPanel`) — full status: branch/push header, Changes|History, per-file
  diffs (each diff lazily fetched via `loadGitDiff`, cached in `gitDiffs`).

Client store (`web/src/store.ts`): `gitSummaries` / `gitStatus` / `gitDiffs`, keyed by
threadId; loaders `loadGitSummary` → WS `thread.gitSummary`, `loadGitStatus` →
`thread.git`, `loadGitDiff` → `thread.gitDiff`. WS handlers live in `ws/hub.ts`,
dispatching to `ThreadManager.getGitSummary/getGitStatus/getFileDiff`, which call
`gitService.getTaskGitSummary/getTaskGitStatus/getFileDiff`.

Server (`gitService.ts`): `getTaskGitStatus` is the full payload; `getTaskGitSummary`
derives the chip's counts from a scoped numstat. Both are cached per-threadId for
`SUMMARY_TTL_MS` (4s) in `taskStatusCache` / `taskSummaryCache` so a board of cards +
each prefetch collapse to one git run — bust them together via the exported
`bustGitCaches()` (what every write in `git/repoOps.ts` calls). Whole-repo
branch/push/behind metadata comes from the uncached repo-wide `getGitStatus`; the
separate repo-wide `getGitSummary` has its own `summaryCache` keyed by repoRoot.
**Want only branch + push standing? Use `getRepoHeadState`** — same `readRepoHead` ref
reads, no branch list / numstat / commit log, cached per repo root (`headStateCache`,
also bust by `bustGitCaches`). `orchestrator/codeContext.ts` reads it for the contextual
rows (`docs/agent-reference/CLAUDE-full.md` § "Contextual code navigation", which owns the drawer's Edit/commit/repo
routes); a screenful of them through the full status walks the tree once per surface.

## Not this surface — the two others that also say "git"
- **The Git console** (top-bar GitHub button → `GitConsole.tsx`) is REPO-level and
  ACTION-bearing: fetch/pull/push/branch/commit/discard over any repo on the machine.
  Server: `git/repoOps.ts` (writes + `remoteWebUrl`) + `git/discoverRepos.ts` (the async
  bounded disk scan that fills the picker) + `orchestrator/repoConsole.ts` (repo list,
  discovery memo, the live-agent gate), WS `repo.*`. `gitService.ts` stays READ-only and
  is where repoOps gets its hardened `runGit` + parsers — don't add a write here. Gates:
  `test:repo-ops` (real repos, no browser) and `npm run git-lab --prefix server` (drives
  the console headlessly against its own throwaway instance + fixture repo).
- **Legacy**: `ThreadDetail`'s "Diff" button opens a raw `git diff`/`git log` modal
  (`loadChanges` → `thread.changes` → `getChanges`). Neither of the above.

## When the answer is "git never replies at all", suspect the POOL, not this surface
2026-09-14: the Git console, the board's Changes chips and the contextual rows all went silent at once
on the live server, while `thread.history` answered in 7ms. Nothing had thrown, `crash.log` was clean
and no `git.exe` was running. It was none of the code above: **every git surface funnels through
`gitService.runGit` to `childRunner.runChild`, a two-worker pool**, and a worker that stops answering
used to hold its slot forever (the command timeout is enforced INSIDE the worker, so it is no help when
the worker itself is what is lost). Two lost workers is zero capacity, permanently and silently.
`childRunner` now arms a MAIN-thread watchdog per job, drops a slot whose worker exits even while idle,
and answers from the worker anyway when a killed child never closes. Gate: `test:child-runner`.

Diagnosis, in this order, so you do not re-derive it:
1. `npm run probe:git-console --prefix server` (read-only, safe against prod). It times the picker's
   `repo.list`, a `repo.state`, the first changed file's `repo.diff`, a warm second `repo.list`, and the
   error a non-repository path returns. `--thread <id>` reproduces the focused open a task does.
2. A leg that never returns while `thread.history` is instant means the git pool, not the console.
   Confirm by running the same read in a FRESH process (`getRepoState` directly): healthy there and
   hung in the server is the pool wedged, and a restart clears it.
3. `childRunnerState()` reports `{ workers, queued }` for a process you can get a handle on.

Four traps the console hit, all in the reply path:
- `repo.list` echoes `forThread`; a reply not matching the request in flight is DISCARDED. The
  first list costs a disk scan, so a previous open's answer routinely arrives after the current
  request — taking it auto-selected the wrong repo. A Rescan must re-send the same `forThread`.
- After an action the server sends `repo.state` BEFORE `repo.result` — the console
  un-busies on the result, and re-reading a repo costs a dozen git spawns, so the other
  order shows a settled panel over pre-action data.
- `repo.action` must answer EXACTLY ONCE, so its hub case catches: a throw with no reply
  leaves the console busy forever with no way back.
- A successful action must NOT clear `gitSummaries`: a card chip fetches only on mount,
  so clearing it makes every chip on the board vanish. Re-request them instead.
