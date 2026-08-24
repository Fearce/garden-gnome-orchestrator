---
paths:
  - server/src/gitService.ts
  - server/src/git/repoOps.ts
  - server/src/orchestrator/repoConsole.ts
  - web/src/components/GitChanges.tsx
  - web/src/components/GitConsole.tsx
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
