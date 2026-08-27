# Timed + shotgun task modes (the traps, not the tour)

Read before touching `orchestrator/timedTasks.ts`, `orchestrator/shotgun.ts`, `runTimedWindow`,
`prepareShotgun`/`integrateShotgun`, or the thread columns `duration_ms`/`deadline_at`/`agent_count`/
`parent_id`/`assignment`. CLAUDE.md § "Timed tasks and shotgun tasks" has the shape; this is what bites.

## Both modes
- **MODES on the ordinary pipeline, not lanes.** The read lane short-circuits `runPipeline`; these don't.
  Both hooks sit in `runImplementorQaLoop` between the implementor and QA, inside `if (!qaOnlyRetry)` —
  so a cap/restart QA-only retry never re-opens a window or re-waits a barrier.
- **Every counter is durable (`stage_outputs`), never in-memory.** The point is surviving what interrupts
  a task: restart, turn ceiling, provider hand-off and cap park all re-enter the pipeline. An in-memory
  count hands a bouncing server an unbounded loop — the bug `qaRoundsUsed` exists to fix.

## Timed
- **Never enforce the deadline by aborting a live turn.** A mid-turn abort returns `subtype:"success"`
  with no output, indistinguishable from a real finish (`steerStructuredRole`, `test:chat-steering`).
  The deadline denies the NEXT round; one already running finishes. Reads like a limitation, is the
  safe design — say so in any doc.
- **Re-read the window each round** (`timedWindowFor(this.db.getThread(id))`), don't close over the entry
  value: the row is the source of truth, and that is what makes a window externally adjustable.
- **`timedFinalizing` is the sticky guard, and it is load-bearing.** Without it a restart re-opens a
  closed window and spends another round on work already sitting in review. Revert-checked.
- **The hollow guard must not count the orchestrator's OWN messages.** `runTimedWindow` writes its "⏱
  round N" note just before the round, and at ms resolution it lands at-or-after `roundStart` — counting
  it made every round look productive and silently disabled the guard. Use
  `db.countAgentMessagesSince(id, "implementor", since)` (excludes `kind='system'`; already existed for
  the silent-run check). Keep it AND `timedMaxExtensions`: a count can't tell 40 useful hours from 40
  no-op rounds in 90s.
- **Finishing early must stay possible.** `TIMED_COMPLETE_MARKER` is line-anchored on purpose: the
  extension directive QUOTES the marker at the implementor, so an unanchored match would end the window
  the moment the agent echoed its instructions back. `test:timed-tasks` pins both directions.

## Shotgun
- **Overlapping file ownership is a REJECTION.** Collaborators share one checkout on one branch, so
  nothing merges their changes and two agents in one file lose work with no signal. The bias is one-way:
  a false "unsafe" costs a degrade to one complete agent, a false "safe" costs work. `pathsCollide` makes
  a directory own all beneath it (`src/api` vs `src/api/routes.ts`) but keeps `src/apidocs` clear.
- **Collaborators bypass BOTH concurrency caps** (`enqueueOrRun` early-returns on `parentId`). Not a
  preference: the lead holds a slot then blocks at the barrier waiting for its children, so queueing a
  child behind a cap its own parent occupies deadlocks the pair — guaranteed at `maxConcurrent: 1`.
  MAX_AGENTS bounds it instead. Revert-checked; don't "tidy" it back into the queue.
- **`shotgunPlanned` is sticky** — a resume that re-decomposes spawns a SECOND set of agents onto the
  same tree. Same class as `planDone`/`readerDone`.
- **The barrier polls durable child state; never hold promises.** The lead is auto-resumed straight back
  into the wait after a bounce and re-reads where its children got to; a promise map dies with the
  process. Time-bounded (`shotgunBarrierTimeoutMs`) so one wedged share can't strand the lead, and the
  integration brief is told which shares came back.
- **A collaborator runs `qaEnabled: false` and no self-improvement round.** Its tree is deliberately
  partial, so a per-share QA would bounce complete work as "incomplete" and a per-share reflection round
  would reflect on a tree still changing under it.
- **Ownership must be rebuildable from disk** (`collaboratorOwnershipBlock`), not only from the
  spawn-time map: a collaborator revived by a restart needs the same contract, including the LEAD's share.

## Verify
`npm run test:timed-tasks && npm run test:shotgun && npm run test:task-modes` (free, no agent, no quota),
then `npm run typecheck && npm run build`. `taskModes.itest.ts` stubs ONLY the agent-spawning leaves, so
every decision above runs for real — extend it rather than writing a new harness. Do the revert-check
(`threadmanager-itest.md`): the concurrency exemption and `timedFinalizing` were both proven load-bearing
that way, and both look like tidy-up candidates until the gate goes red. Browser side wants a throwaway
instance (`browser-test-throwaway-instance`), never prod.
