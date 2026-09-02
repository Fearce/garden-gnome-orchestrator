# Co-work sessions (the interactive lane) — the traps, not the tour

Read before touching `orchestrator/cowork.ts`, `prepareCoworkerRun`, `coworkerRunOptions`, the
`cowork_sessions`/`cowork_turns`/`cowork_messages` tables or `web/src/components/CoWork.tsx`.
CLAUDE.md § "Co-work" has the shape. (Read lane: `e2e-a-pipeline-lane.md`. Task modes: `task-modes.md`.)

## The one thing to keep true
**Co-work is a LANE, and it owns no task.** No `threads` row, no `agent_runs` row, no findings, no
bus/office MCP servers, no `runPipeline`, no planner/QA/reviewer/supervisor/auto-review, and no
autonomous `done`. Every turn ends by returning the session to `idle` for the owner's next prompt. A
change that lets a Co-work session enter the pipeline or settle itself is the defect the lane exists
to prevent — the owner is the only coordinator.
Consequence: **every task-side probe and sweep step is blind to it.** `probe:parks`, `probe:run-errors`
and `probe:task-runs` read `threads`/`agent_runs`, so a wedged Co-work session appears nowhere.
`npm run probe:cowork --prefix server [-- <id-prefix|name>]` is the only view; it includes the durable
Queue/Inject/Interrupt delivery ledger (delivered / failed / unconfirmed) and verifies that every
attachment ref still resolves to matching blob metadata. It deliberately ignores the disposable file
cache, which the next turn rehydrates. Gate `test:cowork-health`.

## Traps
- **The turn claim is durable, not a mutex.** `beginCoworkTurn` is one conditional UPDATE
  (`WHERE active_turn_id IS NULL AND state IN ('idle','error')`) inside a transaction — that CAS, not
  `this.live`, is what makes one-turn-at-a-time survive a restart. It also claims **only** from
  `idle`/`error`, so a session left claiming `running` can never accept another prompt: reconcile every
  orphan at construction (`interruptOrphanedCoworkTurns`) or the conversation is dead.
- **Every owner message id is an idempotency key.** Initial prompts and live steering are persisted
  before provider delivery; a reconnect/double-click with the same id is refused as already received.
  Don't "simplify" the id or move persistence after `send()`.
- **Attachments are message data, not loose uploads.** Store their blob refs inside the same
  `beginCoworkTurn` / `appendCoworkSteering` transaction as the owner row; otherwise a lost claim or
  raced steering command leaks orphan blobs. `cowork_messages.attachments` must stay in `REF_TABLES`,
  and session deletion must prune unshared blobs plus its materialized cache. Screenshots travel both
  as native image blocks and as safe agent-readable paths; other files travel by path. Re-materialize
  prior refs before every turn so reload/cache loss cannot break fresh fallback. Fence asynchronous
  browser reads when switching sessions or one session's large file can finish loading into another.
- **Steering stays inside the claimed turn.** `queue` uses priority `later`; `append` follows the
  shared injection policy; `interrupt` uses priority `now`. Claude/z.ai emit a result per message,
  while Codex/Grok coalesce buffered directions into one resumed result. Keep the result accounting
  provider-aware or the DB turn will settle early (lost direction) or wait forever.
- **Bound the collaboration, not just the SDK.** The Co-worker prompt requests one small useful
  increment, the role ceiling is deliberately short, and the soft/hard wall timers request a summary
  then stop an unresponsive run. `timeboxed` is an intentional terminal turn state that returns the
  session to `idle`; it must not read as an error or trigger a continuation/retry.
- **`send()` must return the CURRENT row, never the claimed one.** `execute()` can fail synchronously
  in `prepare()` and settle the session before the WebSocket action receipt is written; returning the
  claim then overwrites the UI back to a stale `running` it will never leave (`5efe433`).
- **Seal partials when reconciling.** A `partial=1` row from an interrupted turn is substantive
  history, not a live cursor — leave it partial and the reload path renders a truncated reply forever.
- **A pin is strict: fail the turn, never substitute.** `prepareCoworkerRun` reuses the task model
  gate by building a **synthetic `cowork:<id>` Thread** for the capacity snapshot — it is never
  persisted (`probe:cowork` fails the board if such a row exists). Same for the account: persist the
  account **id**, not the display label, because a Claude session id belongs to the subscription that
  created it and resuming under another token loses the context or fails.
- **Resume is provider-specific and is linked mid-turn.** `agent_session_id` is written from the
  `init` event while the turn is still running, so a bounce keeps the linkage. A Claude session cannot
  resume on a CLI backend, so Codex/Grok get `freshFallback` = the replayed transcript
  (`coworkFreshKickoff`) plus `COWORKER_PROMPT`; Claude/z.ai take the prompt alone.
- **`text` after `text_delta` is the SAME block.** Claude streams deltas then commits the block; CLI
  backends emit only `text`. Appending unconditionally doubles the whole reply.
- **Workspace exclusivity runs both ways.** `attachCoworkWorkspaceGuard` blocks task dispatch/resume
  and the Git console's destructive actions while a Co-worker turn is live in that workspace, and
  `taskConflict` blocks a turn while a task agent is live there. One tree, one writer — keep both.
- **`AskUserQuestion` is disallowed on purpose.** A blocker question is returned as the turn's reply;
  the built-in tool would bypass the durable transcript and park the session in an unrepresented state.

## Verify
`npm run test:cowork && npm run test:cowork-ui && npm run test:cowork-health --prefix server` (all
free, no agent, no quota), then `npm run typecheck && npm run build`. `cowork.itest.ts` stubs only the
agent-spawning leaf (`CoworkRuntime`), so every decision above runs for real — extend it rather than
writing a new harness, and do the revert-check (`threadmanager-itest.md`): the pre-start race and the
claim CAS both look like tidy-up candidates until the gate goes red. Browser side wants a throwaway
instance (project memory `browser-test-throwaway-instance`), never prod.
