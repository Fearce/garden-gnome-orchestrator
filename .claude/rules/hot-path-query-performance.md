---
paths:
  - "server/src/db/**"
  - "server/src/ws/hub.ts"
  - "server/scripts/probe-hot-paths.cjs"
---

# Ordering, paging, and snapshot-slimming a hot SQLite read (`messages`/`findings`/`threads`)

Read before touching `db.ts`'s `listMessagePage`/`listMessages`/`listFindings`/`listThreadSummaries`, their indexes in `schema.ts`, or `ws/hub.ts`'s `buildHello` — or before adding any NEW query that orders/pages a UUID-keyed table by `created_at`. The 2026-09-04 perf pass (`14daac9`, `04154de`, `7a0cbca`) got this wrong twice before it got it right; each mistake shipped, passed its own gate, and was only caught by measuring the LIVE 800-task/512k-message DB. (Pagination retention is documented separately in `add-a-message-kind.md` §"the task feed is PAGINATED" — don't duplicate it here.)

## The rowid tie-break — the one that bit hardest
A `TEXT PRIMARY KEY id` is a **random UUID** in this codebase (`crypto.randomUUID()`), so it carries **zero relationship to write order**. Tie-breaking an `ORDER BY created_at` on `id` — which a naive "make paging exact" fix reaches for — reorders every row written inside the same millisecond into UUID order instead of insert order. Measured on the live DB: 1,290 of 2,422 same-millisecond groups reordered, including tool RESULTS rendering above the tool CALLS that produced them.

**The fix, not a workaround:** SQLite appends the table's `rowid` to every non-`WITHOUT ROWID` index's
key automatically. A two-column index `(thread_id, created_at)` is therefore physically
`(thread_id, created_at, rowid)`, and `rowid` **is** insert order. So:
- Tie-break `ORDER BY created_at, rowid` (never `id`) — ordering an agent's own output must always mean
  write order, and `rowid` is the column that already encodes it for free.
- Do **not** add a third `id` column to the index for this — it's redundant (rowid is already appended)
  and, if you order by it instead of `rowid`, actively wrong per above.
- A wire cursor still names a row by its `id` (that's what the client has); resolve `id → rowid` with a
  single covering PK lookup (`SELECT rowid AS seq FROM messages WHERE id = ?`) and keyset on `rowid` —
  see `listMessagePage`. Paging and display then share the exact same order.
- This is the established convention elsewhere in this DB layer already (`director_messages`,
  `cowork_turns`, `cowork_messages`, `lastTextMessageForRun`) — a NEW ordered table should follow it from
  the start. A sibling pattern for a broadcast COLLECTION (not a paged feed) is `add-a-broadcast-
  collection.md`'s explicit `seq` column; use `seq` there, `rowid` here — don't mix the two.

## The broadcast snapshot: clip its free text, and never derive a field PER ROW
`buildHello` fans a `ThreadSummary` out to every client on every reconnect, so anything it does per row it does ~900 times. Two separate costs, and the second is far worse than the first.

**Bytes.** `brief`/`raw_prompt` run to kilobytes and no card renders them (the board needs the first line, as a fallback for when the task isn't streaming). Clip in SQL (`substr(brief, 1, BRIEF_PREVIEW_CHARS)`), never in JS after the fetch — the point is to not pull the bytes across the SQLite↔JS boundary at all. The FULL brief arrives when the panel opens (`thread.history`).

**Reads.** `latest_message_preview` was a correlated subquery for each task's newest readable message: indexed, unsorted, ~0.3ms alone — and 2,773 of the snapshot's 3,312 random page reads, because it ran 907 times. At the ~8ms/read this box gives under load that is a **45-second** frozen event loop, which is what "I click a task and wait 30 seconds" actually was: the click arrives at a loop already inside that query. It now lives in a `threads` column kept by an AFTER INSERT trigger (`db.ts` `installLatestMessagePreviewTrigger`) — a table invariant, not one writer's job, so raw inserts in tests and migrations cannot bypass it. Seeding old rows is the same expensive lookup, so it runs chunked off the boot path (`previewBackfill.ts`): in the constructor it would just move the stall to every boot, where keepAlive reads an unresponsive server as a dead one and restarts into it again.

**Measure read COUNT, not milliseconds.** Time here is whatever the page cache happened to hold — the same query measured 45.8s and 174ms an hour apart. Windows counts a read op served from cache too, so `Win32_Process.ReadOperationCount` around a query is the cache-independent number (it read 3,312 both times). A plan check catches this class where a timing never will: `planVerdict(..., {forbidTable})` fails a snapshot that touches `messages` at all, since an indexed seek is still a random read.

## `threads` listings, `kv` and the project-room rollup are served from memory (`db/memoryMirrors.ts`)
`threads` is ~1k rows but ~900 pages: each row's brief and `stage_outputs` sit on overflow pages, and a listing walks them to reach later columns. `listThreads` ran on every hello rebuild, every supervisor sweep, and every per-minute `crash.log` stall line (via the `active-work` context provider). Under memory pressure the page cache loses those pages, so each call became hundreds of random reads on the event loop. Stall profiles from 2026-09-24 to 09-26 named `listThreads -> all` / `listThreadSummaries -> all` first, alongside 1-9s blocks every minute. `kv` had the same problem on a smaller scale, with 50-130KB values such as `office_names` and provider model lists re-read on hot paths.

`ThreadListingMirror` and `KvMirror` keep both tables in memory, and `ProjectRoomMirror` keeps the per-room `chat_messages` rollup. `listThreads`, `listThreadSummaries`, `listThreadsByStates`, `threadState`, `kvGet`, and `listProjectRooms` read a mirror. An unchanged table costs zero reads, and one changed task costs one single-row read. Invalidation is not the caller's job:
- **Per-connection TEMP triggers** call a JS function for every insert, update, or delete on this connection, including raw statements, cascades, and the `latest_message_preview` trigger.
- **`PRAGMA data_version`** detects another connection's commit and forces a full reload.
- **Inside a transaction a mirror returns null**, and the method reads SQLite directly. The mirror never caches a row that can still roll back.
- **Mirrors are created after `migrate()`**, so migrations always read the file directly.

Do not add a `threads`/`kv` read that bypasses these methods on a hot path; a loop that only branches on a task's state calls `threadState`, never `getThread` (which reads the brief and stage outputs off overflow pages). Do not return mirror objects without copying them: each listing shallow-copies every row, and the nested objects (`assignment`, `modelRequest`, `subTask`, `manualDeployment`) are deep-frozen, so editing one throws. Gate: `test:memory-mirrors` compares each listing with SQLite's own answer (read inside a transaction) and counts reads. It fails if the trigger, foreign-commit, or transaction guard is removed.

## Verify against the LIVE database, not just a synthetic gate
`test:performance-paths` gates these query SHAPES on every `test:gates` run (fast, free, synthetic —
proves the code is structurally correct). It cannot expose a subtly-wrong composite index (right
columns, wrong order) the way the real 512k-row DB does, because a synthetic fixture is too small for
SQLite's planner to make the same choice. Two tools close that gap:
- **`npm run probe:hot-paths --prefix server`** (read-only, safe against prod) — EXPLAIN QUERY PLANs the
  real hot queries against the busiest live task, checks for a bare `SCAN` or a `TEMP B-TREE`, confirms
  the superseded indexes (`idx_messages_thread_created_id` et al.) haven't been rebuilt, and prints the
  hello-snapshot byte savings and real page-read timings. Use it instead of re-deriving `EXPLAIN QUERY
  PLAN` and a `VACUUM INTO` rehearsal by hand — that manual process is exactly what cost three QA rounds.
  **Warm the statement before timing it**: a cold `node` process's first query measures prepare + a
  page-cache miss, not the query — 58ms cold vs 1-2ms warm on the same live query, a >30x gap that has
  nothing to do with the index. `timeSnapshotQuery`/`timeHistoryPage` run once to warm, then time the
  second call; keep that shape if you extend the probe.
- For an actual index/migration CHANGE (not just verification), rehearse it against a `VACUUM INTO`
  snapshot of the live DB per `rehearse-a-data-migration.md` before it ships — that recipe is what caught
  the 1,290-group reordering above; a synthetic-only gate did not.

Gate: `test:hot-paths` (proves the checker in `probe-hot-paths.cjs` actually DETECTS an unindexed query before trusting it to stay quiet on a fixed one — same revert-check discipline as `db-size.test.cjs`).

## Naming a stall: the `slow SQLite statements` line in crash.log
Every statement, `exec`, `pragma` and transaction on the server's connection is timed (`db/slowStatements.ts`, wired in the `Db` constructor). One taking 250ms or more is blamed for any event-loop stall it overlaps (`worst blocked by sqlite get in goalTurnActivity <- settleStep: SELECT …`) and summarised once a minute as `slow SQLite statements: N, Xs on the event loop — …`, top four by total time. Start from that line when crash.log reports stalls, before re-profiling. A stall still reading "no tracked operation was in flight" was not SQLite. Gate: `test:slow-statements`.

Its first day (2026-10-04) named one-row lookups at 1-3s each with the disk at ~20ms a read: `implementationMemoForRun` (full scan + sort, 1,470 reads on a live snapshot), `chatThreadInRoom` (833), `supervisorWatchingCount` (182). Each got an index (~10 reads, built in under 150ms) and `test:performance-paths` asserts their plans. The goal loop's per-minute read of a carrier's report goes through `goalTurnReport`; only a settling turn pays for `goalTurnActivity`'s tool count, which walks every row of the turn. A `messages(thread_id, role, kind, created_at)` index would make that count free, but it took 61s to build on the snapshot, which is too long for a boot step, so it was not added.

The same day named `listMessages <- collectTaskWrittenFiles` several times a minute: every Changes status/summary request read the task's whole feed, tool results included, to find the files it wrote (3.2s cold on a 14k-message task). It now goes through `db.toolCallDigest` (`ToolCallDigest` in `db/memoryMirrors.ts`), which folds a task's tool calls once and afterwards reads only rows above its rowid watermark. The query is pinned `INDEXED BY idx_messages_thread_time`, whose bytecode rejects already-folded rows on the index entry (`DeferredSeek` then `IdxRowid`) before any table read. A delete-only TEMP trigger on `messages` (retry reset, cascade) and `PRAGMA data_version` (another connection) discard the fold. Reuse it for any other per-task fact derived from tool calls rather than re-reading the feed. Gate: `test:performance-paths`.

After those deploys the slow-statement line still named three callers, each fixed the same way. `getThread <- reopenResumedSteps` (25 calls, 13s in one minute) fetched a whole task row per settled goal step per tick, only for its state; it calls `threadState` now. `listProjectRooms <- buildHello` walked ~10k project chat lines (356 index pages, 3.7s cold) on every console connect; `ProjectRoomMirror` re-reads only a room that was written. `goalUsage <- rowToGoal` read each of a goal's runs from the table (217 scattered reads); `idx_runs_thread_usage` covers it, supersedes `idx_runs_thread_started`, and built in ~0.6s on the live 8k-run table. `detectUnsurfacedArtifacts`, the QA and reviewer kickoffs' artifact hint, read the whole feed the same way the Changes chip did; it now folds through its own `toolCallDigest`. Gate: `test:performance-paths`.

## WAL checkpoints run on a worker thread (`db/walCheckpointer.ts`)

The same repair's live QA named `agentLastActivity <- recentNameUses` in a 3.3s stall: its completed-run branch fetched each run's table row to filter state and read role/end time. `idx_runs_started_activity(started_at, state, ended_at, thread_id, role)` covers that branch and replaces `idx_runs_started` while preserving run-list ordering. A live snapshot rehearsal built it in 384ms, reduced process read operations from 236 to 80, and returned 824 byte-identical activity rows. Gate: `test:performance-paths` checks its covering plan and live/completed/unfinished/expired/boundary semantics.

With those reads gone, crash.log blamed single-row `addMessage` INSERTs for stalls up to 2.8s. The cause was SQLite's auto-checkpoint, which copies the WAL into the main file inside whichever commit crosses 1000 pages, on the event loop. On this box 42 of 8,000 inserts took 5-494ms with it and none with it off. The commit fsync is not the cause: better-sqlite3 already runs WAL at `synchronous = NORMAL` once the WAL opens, though a fresh connection reads 2 until its first write. The server now starts a `WalCheckpointer` at boot: a worker thread with its own connection runs `PRAGMA wal_checkpoint(PASSIVE)` every second, which never blocks a writer or a reader, and the server connection's `wal_autocheckpoint` is 0 only while that worker is up. If the worker dies, auto-checkpoint goes back to 1000 at once, crash.log gets a `WAL checkpoint worker stopped` entry, and the worker restarts after 30s, so the WAL never goes without a checkpointer. Only the server's `Db` gets one; tests and scripts keep SQLite's own. Gate: `test:wal-checkpointer`.
