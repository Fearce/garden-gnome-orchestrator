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
  ±lines, a status dot. Auto-loads only `loadGitSummary` on mount; the full
  `loadGitStatus` is prefetched when the pointer enters or focus lands on the chip, so
  the drawer still opens warm. Mount-time prefetch of every card's drawer was removed
  2026-10-06: it saturated the child-command pool before any drawer was opened.
  Renders nothing until the summary confirms `isRepo`.
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
`bustGitCaches()` (what every write in `git/repoOps.ts` calls). The drawer's whole-repo
branch/push/behind metadata comes from `cachedRepoStatus` (the repo-wide
`getGitStatus`, cached per repo root in `repoStatusCache`); the chip reads only
`getRepoHeadState` plus the shared `porcelainCache` status for untracked task files; the separate repo-wide
`getGitSummary` has its own `summaryCache` keyed by repoRoot. Every one of these is a
`GitReadCache`: a 4s TTL **plus a shared in-flight read**. The TTL alone was not
enough. A board mounts every chip at once, so all the requests missed together and
each card ran its own ~11-spawn repo walk twice (summary + drawer prefetch). One
board load put ~350 git spawns in front of the pool, and a dispatch's baseline
`rev-parse` waited 52-272s behind them (2026-09-27). The Git console (`repoOps`) still
calls `getGitStatus` directly, because a discard must see the live file list.
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
3. `childRunnerState()` reports `{ workers, busy, queued, started }` for a process you can get a handle on.

**Slow rather than silent is the other pool failure: a FLOODED queue.** The pool is FIFO for ordinary
jobs, so a burst of display reads delays anything queued behind it. A caller that someone is waiting on
passes `{ urgent: true }` (`runGit`'s 4th argument, `resolveRepoRoot`/`getHeadSha` options). Urgent jobs
go ahead of every queued ordinary job and may use one reserved worker above `POOL_SIZE`. Today the urgent
callers are the dispatch baseline (`ThreadManager.dispatch`) and the resume kickoff's progress block
(`gitProgress.buildGitProgressBlock`). Keep chip, drawer and poller reads ordinary. If everything is
urgent, nothing is. A job that waited over 5s is summarised once a minute in the hub log and `crash.log`
(`child command pool: N command(s) waited …`). Gates: `test:child-runner`, `test:dispatch-latency` and
`test:git` section J.

**A timed-out read is UNKNOWN, never an answer to cache.** Under heavy spawn load one git process here
can stall past its 15s timeout and not even die on the kill (`rev-parse --show-toplevel`, 2 in 10 under
three git-heavy gates, 2026-09-28). `resolveRepoRoot` used to fall into the nested-repo scan and cache
the result for `REPO_ROOT_TTL_MS`: "not a repo", or a checkout nested inside the real one, on every
surface for that workspace. It now returns null uncached. The timeout is `GIT_READ_TIMEOUT_MS` (default
15000, read per call) — raise it on a box that stalls; gates use it to force a timeout (`test:git` A3).

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
