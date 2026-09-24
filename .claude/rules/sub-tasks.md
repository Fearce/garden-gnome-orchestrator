---
paths:
  - server/src/orchestrator/subTasks.ts
  - server/src/agents/jevClient.ts
  - server/src/bus/busServer.ts
  - server/src/agents/officeBridge.ts
  - server/src/tests/subTasks.itest.ts
---

# Sub-tasks (spawned sub-agents) — the traps, not the tour

Read before touching `orchestrator/subTasks.ts`, `agents/jevClient.ts`, the sub-task tools in
`bus/busServer.ts`, the `SUBTASK:` bridge, `integrateSubTasks`/`awaitSubTasks` in `threadManager.ts`,
or the `threads.sub_task` column. CLAUDE.md § "Sub-tasks" has the shape. Related: `task-modes.md`
(shotgun collaborators share `parent_id` and several rules), `office-bridge.md` (the CLI marker grammar).

## The one thing to keep true
**Every sub-agent is a sub-task the owner can open.** The implementor's `Agent`/`Task` SDK tools are
disallowed in `implementorConfig` for that reason. Re-enabling them brings back invisible helpers the
owner cannot reach, all on the parent's model. Default mode (`vanilla`) keeps them only because it has
no bus to offer instead.

## Traps
- **`sub_task` is NOT NULL ⇔ sub-task.** A shotgun collaborator also has `parent_id`. Every `parentId`
  filter that means "collaborator" must add `&& !t.subTask` (Board's ⚡ count, `collaboratorIdsOf`,
  `listCollaborators`), or sub-tasks get interleaved into the parent's feed and counted as shares.
- **A result is delivered exactly once, and only through a durable channel.** `wait_for_subtasks`
  or the hand-off barrier read the child, then set `subTaskReported`. `nudgeLive` is a heads-up only:
  a message sent as a turn ends can be lost, so it must never carry the result. `message_subtask` on
  a settled coding child clears `subTaskReported` so the new result comes back.
- **The barrier runs AFTER `drainQueuedFollowUps`**, inside `drainQueuedImplementor`. It must stay on
  that one hand-off seam: a result that lands after QA starts is work nobody reviews.
- **The barrier is bounded three ways**: `SUBTASK_BARRIER_TIMEOUT_MS`, `MAX_SUBTASK_REPORT_ROUNDS`
  (durable `subTaskRounds`), and "the parent's own run failed". Each limit posts a warning finding
  naming the unreported children. A silent give-up is the defect. It polls durable thread state, not
  promises, so an auto-resumed parent re-enters the same wait.
- **Coding sub-agents bypass the concurrency caps** (`enqueueOrRun` early-returns on `parentId`), for
  the same deadlock reason as shotgun collaborators. The live, lifetime and depth caps bound them instead.
- **The model is a strict pin.** `spawnCoding` resolves the model against `subAgentRoster()` and
  dispatches `requestedProvider` + `requestedModel`. `ensureThreadModelRequest` skips owner-wording
  detection for any `subTask`: a brief written by another agent mentioning "sonnet" is not an owner pin.
- **Jev is not an agent session.** `runPipeline` short-circuits to `runJev` before route selection.
  `resumeThread` re-asks a pending question, `injectThread` turns owner text into another question
  (`ownerQuestion`), and `setThreadModel` refuses a model change. Anything that assumes a Jev
  sub-task has a kickoff, a session or a live run is wrong.
- **An in-flight Jev call is tracked in `jevCalls`** so a cancel aborts the HTTP request rather than
  letting a late answer flip a cancelled task to `done`. `jevPending` is durable so a restart re-asks.
- **Sub-tasks never page the owner.** `publishState` skips `notifyOwner` for any `subTask`. The owner
  hears about the parent.
- **The key is write-only.** `jevApiKey()` reads kv `jev_api_key`, else `config.jev.apiKey`
  (`TYPESAFE_API_KEY`). Only `jevKeyPresent`/`jevKeyLast4` leave the server.

## Verify
`npm run test:subtasks && npm run test:jev-client && npm run test:office-bridge`, from `server/` (free:
real Db + ThreadManager, stubbed agent spawn, fake Jev endpoint). Then `npm run typecheck && npm run build`.
Browser: `npm run subtask-lab --prefix server` boots its own instance and seeds a parent, a coding
sub-task and a Jev sub-task. It asserts the board badge, the panel strip, feed isolation, the Jev composer
and the Settings key card. A live Jev call costs fractions of a cent. Test it with `curl` against
`/v1/systemone` using the key in `server/.env`, never through prod.
