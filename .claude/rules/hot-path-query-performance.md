# Ordering, paging, and snapshot-slimming a hot SQLite read (`messages`/`findings`/`threads`)

Read before touching `db.ts`'s `listMessagePage`/`listMessages`/`listFindings`/`listThreadSummaries`,
their indexes in `schema.ts`, or `ws/hub.ts`'s `buildHello` — or before adding any NEW query that
orders/pages a UUID-keyed table by `created_at`. The 2026-09-04 perf pass (`14daac9`, `04154de`,
`7a0cbca`) got this wrong twice before it got it right; each mistake shipped, passed its own gate, and
was only caught by measuring the LIVE 800-task/512k-message DB. (Pagination retention is documented
separately in `add-a-message-kind.md` §"the task feed is PAGINATED" — don't duplicate it here.)

## The rowid tie-break — the one that bit hardest
A `TEXT PRIMARY KEY id` is a **random UUID** in this codebase (`crypto.randomUUID()`), so it carries
**zero relationship to write order**. Tie-breaking an `ORDER BY created_at` on `id` — which a naive
"make paging exact" fix reaches for — reorders every row written inside the same millisecond into UUID
order instead of insert order. Measured on the live DB: 1,290 of 2,422 same-millisecond groups reordered,
including tool RESULTS rendering above the tool CALLS that produced them.

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

## Don't ship a broadcast snapshot's full free-text fields
`buildHello` fans a `ThreadSummary` out to every connected client on every reconnect. A task's `brief`
and `raw_prompt` can run to kilobytes and are read by almost no card (the board only needs the first
line, as a fallback for when the task isn't actively streaming). Shipping them in full cost ~639KB
across 799 tasks for text nothing on the card actually shows. Clip in SQL
(`substr(brief, 1, BRIEF_PREVIEW_CHARS)`), not in JS after the fetch — the whole point is to never pull
the bytes across the SQLite↔JS boundary. `BRIEF_PREVIEW_CHARS` (`types.ts`) is the shared clip width; a
task's FULL brief/prompt still arrives once its detail panel is opened (`thread.history`).

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

Gate: `test:hot-paths` (proves the checker in `probe-hot-paths.cjs` actually DETECTS an unindexed query
before trusting it to stay quiet on a fixed one — same revert-check discipline as `db-size.test.cjs`).
