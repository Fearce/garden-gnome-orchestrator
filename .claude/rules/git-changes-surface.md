---
paths:
  - server/src/gitService.ts
  - web/src/components/GitChanges.tsx
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
each prefetch collapse to one git run — keep the two caches busted together (the
branch-switch path clears both). Whole-repo branch/push/behind metadata comes from the
uncached repo-wide `getGitStatus`; the separate repo-wide `getGitSummary` has its own
`summaryCache` keyed by repoRoot.

Legacy: `ThreadDetail`'s "Diff" button opens a separate raw `git diff`/`git log` modal
(`loadChanges` → `thread.changes` → `getChanges`). That is NOT this task-scoped surface;
don't confuse the two.
