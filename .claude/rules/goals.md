---
paths:
  - "server/src/orchestrator/goals.ts"
  - "server/src/tests/goals.test.ts"
  - "web/src/components/Goals.tsx"
  - "web/scripts/goals-ui.test.tsx"
---

# Goal-directed tasks (the traps, not the tour)

Read before touching `orchestrator/goals.ts`, the `goals`/`goal_steps` tables, the director's
`create_goal`/`list_goals`/`update_goal` tools, or the Goals view. The shape is in
`docs/agent-reference/CLAUDE-full.md` § "Goal-directed tasks".

- **A goal is a loop of ORDINARY tasks, not a lane or a mode.** Each step goes through
  `manager.dispatch` like a hand-dispatched task, with a strict model pin (`requestedProvider` +
  `requestedModel`) and an effort. Do not add goal-specific branches to `runPipeline`. The goal learns a
  step ended from the hub's `thread.upsert` (fast path) and the 60s tick (safety net), and reads the
  outcome from durable rows. Steps dispatch with `skipQa: true`, which `resolveRoute` turns into a
  route with `useQa: false` (`withoutQaWhenSkipped`); the director's step judgement is the review.
  Gates: `test:goals` (the flag is sent) and `test:route-pipeline` §2b (QA never runs, Retry keeps it).
- **Steps are long, not sliced.** The judge prompt asks for `next` to cover ALL the remaining work, split
  only where a later part depends on judging an earlier result; the step brief tells the agent to keep going
  past its step into the rest of the objective. Each step is a fresh session that re-reads the repo plus a
  director call, so many small steps burn tokens on overhead. Do not reintroduce "one slice per step"
  wording; `test:goals` pins both texts. A goal with `maxConcurrent > 1` asks instead for a long share that
  can run beside the other steps, and its brief tells the agent to stay in its lane (`nextInstruction`,
  `scopeParagraph`).
- **Ending takes two voices.** The step's implementor must write a standalone `GOAL STATUS: COMPLETE` line
  (`detectGoalComplete`: the last status line wins, and it must stand alone because the brief quotes the
  marker mid-sentence), AND the director's verdict must be `complete`. A lone director verdict dispatches a
  VERIFICATION step; a lone agent claim just gets the next step. Revert-checked: dropping `&& agentClaimed`
  turns `test:goals` red.
- **The director call is `supervisorJudge`**, the bounded no-tools, capacity-aware judgement ThreadManager
  already has. It returns null during a restart drain or when nothing can answer, and the goal then WAITS
  (`nextCheckAt` + a visible `statusReason`). It must never dispatch blind.
- **The pick is checked against `goalModelRoster()`** (= `implementorModelRoster`, the auto-selection
  roster). An undispatchable model falls back to automatic routing, with the reason written into the
  step's rationale, rather than pinning a step to a model that cannot run.
- **The owner's pin bounds the director's pick; `goalStepPin` is the single place that applies it.** An
  unset goal `effort` means low or medium ONLY — a 24/7 loop must not burn high-effort capacity by
  default. The judge schema's enum and the prompt already say so, but `goalStepPin` still caps the
  answer, because the CLI-bridge director and a schema-ignoring model can return anything. An owner
  model skips the roster fallback above: it is dispatched as the exact pin and waits for capacity.
  A model travels only with its provider (`validateGoalPin`); a half pin is rejected, never guessed.
- **Guards fire at SETTLE time, not on every evaluation.** A cancelled step pauses the goal, and so do 3
  consecutive failed steps. If those checks ran on every evaluation, Resume would re-pause at once on the
  same old step (`test:goals` covers "resume judges again"). Only a missing workspace is re-checked on
  every pass. A `review` outcome is NOT a failure: QA was unsatisfied, but the work exists.
- **There is no step budget; a goal keeps going until it is done.** The owner removed it on 2026-09-28,
  so do not reintroduce a step count limit as a runaway guard. The bounds are the failed-step streak,
  a cancelled step, the burn-rate hold and the owner's Pause. Boot drops the old `goals.max_steps`
  column and reactivates any goal still paused by "Reached its budget of …" (`resumeBudgetPausedGoals`).
- **The step row is written BEFORE the dispatch.** A crash in between leaves a step with no `thread_id`;
  `adoptOrphan` finds its task by the exact `stepTitle` in that workspace, and while that is unresolved
  the goal dispatches nothing. That early return is load-bearing: without it a restart doubles the step.
- **Parallel steps are slots, not a different loop.** `advance` settles every open step (`listOpenGoalSteps`),
  counts the ones still running, and judges only while fewer than `maxConcurrent` run. The last-settled
  step, not the highest `seq`, is "the last step" (its claim is the agent's voice), and the failed-streak
  guard reads the last 3 SETTLED steps. A running step has `outcome` null, which `stepFailed` counts as a
  failure. A dispatch that leaves a slot free re-runs the evaluation loop to fill it.
- **A settled step is not final: its task can come back.** Cap auto-resume, Retry and inject all restart a
  task the goal already settled. `reopenResumedSteps` clears the step's settle so it holds a slot again, and
  `uncountSettle` lowers the last verdict's `settledSteps`, so the real ending is still reported and still lifts a
  `wait`. Counting only `listOpenGoalSteps` let a 2-slot goal run 3 steps. `judgeAndAct` re-runs it after the
  director answers and drops the judgement if a step came back meanwhile (a cap reset both resumes a task and
  frees capacity for the judge call). Gates: `test:goals` ("takes its slot back", "while the director judges").
- **A `wait` must cost nothing until a step settles.** The hold is the `wait` verdict plus its `settledSteps`
  count, NOT a timestamp: the gate's clock is frozen, and a same-millisecond settle would lift a
  timestamp hold and re-judge every tick. `complete` while steps run is stored as the same hold.
  Revert-checked: dropping `heldForRunningSteps` turns `test:goals` red.
- **The burn-rate hold is a `wait`, not a `paused` status.** It must lift by itself when the pace catches
  up, so it sets `nextCheckAt` (≥ the retry backoff, ≤ 30 min) and keeps the goal `active`. It runs BEFORE
  the director call, so a held goal spends nothing. An unpinned goal holds only when every pool is over
  pace; `pinWithinBurnRate` keeps an unplaceable pick off automatic routing, which could pick an
  over-pace pool. Changing `maxConcurrent`/`burnConservation`/`burnRatePct` clears `nextCheckAt` and evaluates at once.
- **Re-read the goal after the judge returns.** The owner may pause, end or delete it while the director
  is thinking; a judgement that lands afterwards must dispatch nothing.
- **The burn rate and a pause also bind the RUNNING step, at its turn ceilings.** Steps run for hours and
  auto-continue through ~10 turn ceilings each, so with a check only before dispatch a step started within
  pace could run on for hours past it, and a goal the owner paused kept spending until its step ended
  (2026-09-29: two ~7h steps took 36% of a weekly window overnight, and both kept running after the pause). ThreadManager asks `continuationGuard` (installed in `index.ts`
  as `goals.wrapUpReason`) at every turn-ceiling continuation; `stepWrapUpReason` answers when the goal is
  no longer `active`, or the pool the step is running on NOW is over pace (the guard is handed the live
  run's provider: an auto-routed step records none, and a failed-over step left its dispatch pool). The step is then told to commit and report
  instead of continuing, finishes `done`, and the goal's own hold takes over. It never interrupts a turn.
  Gate: `test:goals` (`stepWrapUpReason`) + `test:continuation-guard` (the loop sends the wrap-up nudge,
  once, and settles on the wrap-up report).

Verify: `npm run test:goals --prefix server` (server loop + the web store/view gate), then typecheck.
