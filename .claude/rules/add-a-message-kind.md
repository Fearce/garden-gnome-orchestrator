# Adding a persisted feed message kind (the reload-path fan-out)

For a NEW kind of agent output that must survive reload in the thread feed — a
`text`/`tool`/`thinking`-style row, not a one-off. The reference is the Grok
`thinking` (reasoning) kind: a durable message + a live draft mirroring the
`agent.delta`→`agent.text` pair. (For a whole new entity the console lists/edits
use `add-a-broadcast-collection.md`; for a knob use `add-a-setting.md`.)

Touch every spot — a miss typechecks fine but silently drops the value at that
layer. **The one that bites: `messageToFeed` — skip it and the row streams LIVE
but is BLANK after reload** (the exact "conversation missing" failure mode).

Server:
1. `types.ts` — add to the `MessageKind` union.
2. `types.ts` — `AgentEvent`: the durable event the runner emits (e.g. `{ type:"thinking"; text }`).
3. `ws/protocol.ts` — the durable `ServerEvent` broadcast with a `messageId`
   (mirror the live/durable pair: `agent.delta`+`agent.text` → your `agent.<x>_delta`+`agent.<x>`).
4. `orchestrator/threadManager.ts` — the `case "<event>":` in the agent-event
   switch → `db.addMessage({ kind })` then `hub.publish(<durable ServerEvent>)`.
5. The runner that produces it (`agents/grokRunner.ts` / `runner.ts` / `codexRunner.ts`).

Web:
6. `web/src/types.ts` — mirror `Message.kind`, the `ServerEvent`, AND add a `FeedItem` variant.
7. `store.ts` — the `case "agent.<x>":` handler → `pushFeed(...)` (+ a live-draft slice if you added one).
8. `store.ts` — **`messageToFeed` `case "<kind>":`** (the reload/history path — the miss above).
9. `store.ts` — `feedBucket` (retention) AND `feedMessageId` (dedup) must list the
   kind, else the live-pushed item and the re-fetched history row render TWICE.
10. `store.ts` — if you added a per-thread draft slice, add it to the two `drop()`
    cleanups (thread.removed / thread.reset) and `DEFAULT`/initial state.
11. `components/ThreadDetail.tsx` — `itemRoleOf`, the `visible` filter (if hideable —
    fold verbose kinds into the `showTools` toggle), and the `FeedRow` `case "<kind>":` render.
12. `web/src/styles.css` — `.fi.<kind> .body` styling.

Conventions that bite:
- `messages.kind` is a free-text TEXT column — a NEW kind needs **NO migration**
  (unlike adding a column). Just extend the union.
- Live vs durable: `agent.delta` (live, no id, accumulates a draft) → `agent.text`
  (durable, carries the DB `messageId`). Your durable event MUST carry `messageId`
  or history-merge can't dedup it against the live push.

Verify: `npm run typecheck && npm run build`, then a throwaway-instance browser
test that **SEEDS a message of the new kind and RELOADS** (recipe: project memory
`browser-test-throwaway-instance`) — a live-only test passes even when the reload
path is broken. Prefer a unit gate driving the runner's `onStdout` with canned
events (see `server/src/tests/grokReasoning.test.ts`) for the emit logic.
