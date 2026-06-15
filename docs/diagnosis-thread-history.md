# Diagnosis — disappearing thread history & related feed symptoms

Investigation into three reported symptoms in the dashboard thread feed. Conclusion:
two are the same single root cause (now fixed), and one is not a bug.

## Symptoms investigated

1. **History truncates / disappears.** A thread feed that had been streaming live would
   show only the most recent handful of messages; older output was gone even though it was
   in the database.
2. **Browser restart loses history.** Reloading the dashboard (or reconnecting after a
   server restart) left the open thread's feed partially or fully empty.
3. **QA → Implementor handoff loses context.** Suspicion that the implementor restarts
   from scratch on each QA fix round.

## Root cause (symptoms #1 and #2)

`web/src/store.ts` handled the `thread.history` event with an **all-or-nothing guard**:

```ts
// old
if (existingFeed.length > 0) return {}; // bail — keep the live feed, ignore DB history
```

Whenever live `agent.*` events had already populated the feed (the normal case for any
thread you were watching), the guard made the authoritative DB history a no-op. So:

- On the first history fetch for an active thread, the full DB backlog was **dropped**,
  leaving only whatever had streamed live since you opened it (the "~20 messages" symptom).
- On reconnect/reload, the feed could not be rehydrated from the DB because the same guard
  refused to merge — hence the browser-restart symptom.

These are one bug with two faces: the feed and the DB were never reconciled.

## Fix

**Id-keyed merge instead of all-or-nothing** (`store.ts`, `thread.history` handler). The DB
history and the live feed are merged on a stable key — the DB message-row id — with the DB
row winning on a collision and live-only artifacts (in-flight tool results, system notes)
preserved. Dedup keys align end-to-end:

- The server stamps every emit with its DB row id: `wireRun` calls `db.addMessage(...)` and
  passes `m.id` as `messageId` on `agent.text` / `agent.tool` / `agent.tool_result`, and
  persists tool results as `kind:"result"` (`server/src/orchestrator/threadManager.ts`).
- `feedMessageId()` resolves to that same id for both live items and re-fetched DB rows
  (`f.id` for text/tool, `f.messageId` for tool_result; the tool's `id` field stays the SDK
  tool-use id for the React key). `messageToFeed()` maps DB rows to the same ids.

**Reconnect re-fetch.** The WS `hello` event (which also fires on reconnect after a server
restart or network blip) now re-requests `thread.history` for the selected thread. With the
id-keyed merge this is safe — it fills any gap that streamed while disconnected without
clearing or flashing the existing feed.

**Render backstop on both paths.** `PER_RUN_CAP` (per-run) and `FEED_HARD_CAP` (absolute)
were only enforced in the live append (`pushFeed`). The merge path returned an uncapped
array and `db.listMessages` has no SQL `LIMIT`, so reconnecting on a long-running thread
could balloon the feed past the render backstop. A shared `capFeed()` helper now enforces
both caps on the live append and the merge result.

## Symptom #3 — not a bug

The QA → Implementor handoff preserves session context. A QA fix round sends the fix message
to the **same live implementor run** (`threadManager.ts`: `live.run.send(fixMsg, {priority:
"now"})` followed by `awaitImplementorResult(..., useNext=true)` which awaits
`run.nextResult()`). The SDK session is never torn down between rounds, so the implementor
keeps its full context across fix rounds. No change required.

## Verification

- `npm run typecheck` and `npm run build` pass clean for both `server` and `web`.
- Dedup keys traced end-to-end (live emit → DB row → history re-fetch) to confirm reconnect
  merges rather than duplicates.
