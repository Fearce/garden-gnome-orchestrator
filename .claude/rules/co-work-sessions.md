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
`npm run probe:cowork --prefix server [-- <id-prefix|name>]` is the only view; it includes active-turn
age, the durable timed-hand-back and Queue/Inject/Interrupt delivery ledgers, and verifies that every
attachment ref still resolves to matching blob metadata. The hand-back ledger recognizes both the stable
event tag and legacy message text, so repeated historical cutoffs stay visible. It deliberately ignores
the disposable file cache, which the next turn rehydrates. Gate `test:cowork-health`.

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
- **The owner's requested outcome is the turn boundary.** Do not impose a short default wall clock over
  explicit direction to keep working: live steering and Stop already keep the owner in control. A
  deployment may opt into soft/hard timers with `COWORKER_HANDOFF_MS`; when enabled, `timeboxed` is an
  intentional terminal turn state that returns the session to `idle`, not an error or retry trigger.
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

## Console traps (the QoL layer)
- **The desk is MOUNTED, not re-rendered.** `Board.tsx` keeps `<CoWork hidden={...} />` alive the way it
  keeps the IDE alive. Turning that back into a conditional render silently restores the whole "leaving
  the tab mid-turn loses your place" complaint: the session DATA is in the store either way, but the
  scroll position, expanded bursts, draft and staged attachments are component state.
  `.cowork-shell` is `display: grid`, which overrides the UA rule behind `hidden` — `.cowork-shell[hidden]
  { display: none; }` is what actually hides it, and without it the desk covers the task board.
- **Scroll position and expansion belong to the STORE, keyed by session.** `display: none` resets
  `scrollTop`, and the component is remounted by a key change on session switch. Both are also what the
  owner means by "where I was", so they are per session, never global.
- **A tool result pairs by `meta.id`, never by adjacency.** Parallel tool use returns out of order, and a
  result can arrive before its own call row. Pairing on position looks right in every hand-written
  fixture and mismatches under real load, which shows the owner one call's output under another's name.
- **A burst is a FLEX ITEM in a flex column, so it needs `flex: 0 0 auto`.** `.cowork-tools` carries
  `overflow: hidden` for its rounded corners, which resolves its automatic minimum size to 0; without an
  explicit basis every burst is squashed to a hairline the moment the conversation is taller than the
  scrollport (which is always). Caught only in a browser — SSR markup was perfect.
- **The board card owns nothing.** `CoworkCards.tsx` may read session state and send the steering
  commands the composer already sends. A "mark done", a QA pip or a findings list on that card is the
  exact defect this lane exists to prevent.
- **The summary is deterministic on purpose.** `coworkSummary.ts` never calls a model: the owner reads it
  when a session was timeboxed or abandoned, which is when capacity is least likely to be there. A commit
  is only reported when git printed its `[branch sha] subject` receipt in a SUCCESSFUL tool RESULT — the
  attempted command is never evidence, because a pre-commit hook refusing a commit is the normal case here.
- **Promotion is one-way and refused mid-turn.** `promote` dispatches a SEPARATE ordinary task and leaves
  the session with no thread id, no findings and no settle path. It refuses while a turn is live so the
  brief can never describe unsettled work.
- **Browser: `npm run cowork-lab --prefix server`** drives all of the above against its own instance on
  :5417 (`-- --shots data/cowork-lab-shots` to keep the pictures). Uncommitted server work needs an
  isolated build: `npx tsc -p tsconfig.json --outDir .cowork-lab-dist` then `GGO_LAB_ENTRY=.cowork-lab-dist/index.js`.

## Verify
`npm run test:cowork && npm run test:cowork-summary && npm run test:cowork-ui && npm run test:cowork-health --prefix server` (all
free, no agent, no quota), then `npm run typecheck && npm run build`. `cowork.itest.ts` stubs only the
agent-spawning leaf (`CoworkRuntime`), so every decision above runs for real — extend it rather than
writing a new harness, and do the revert-check (`threadmanager-itest.md`): the pre-start race and the
claim CAS both look like tidy-up candidates until the gate goes red. Browser side wants a throwaway
instance (project memory `browser-test-throwaway-instance`), never prod.
