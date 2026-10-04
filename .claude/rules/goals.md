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
  past its step into the rest of the objective. A fresh step is a new session that re-reads the repo plus a
  director call, so many small steps burn tokens on overhead (a sequential goal now avoids both, below). Do not reintroduce "one slice per step"
  wording; `test:goals` pins both texts. A goal with `maxConcurrent > 1` asks instead for a long share that
  can run beside the other steps, and its brief tells the agent to stay in its lane (`nextInstruction`,
  `scopeParagraph`).
- **Ending takes two voices.** The step's implementor must write a standalone `GOAL STATUS: COMPLETE` line
  (`detectGoalComplete`: the last status line wins, and it must stand alone because the brief quotes the
  marker mid-sentence), AND the director's verdict must be `complete`. A lone director verdict dispatches a
  VERIFICATION step (in a persistent goal, a verification turn in the same session); a lone agent claim
  just gets the next step or turn, told the audit disagreed. Revert-checked: dropping `&& agentClaimed`
  turns `test:goals` red.
- **The director call is `directorJudgement`**, the bounded no-tools, capacity-aware judgement behind
  `supervisorJudge`, which also says WHY it failed (restart drain, no target, a run error, an answer off the
  schema). The goal then WAITS (`nextCheckAt`) with that cause as its `statusReason`, never a generic line,
  and must never dispatch blind. A Codex director only parses its final message, so `directorJsonKickoff`
  puts the schema into its prompt; without it Codex guessed the shape, left out `reason`, and the
  Tilebreaker goal waited forever on "no director model returned a usable decision" (2026-09-29).
  Gates: `test:director-provider` (the kickoff and the reason) + `test:goals` (`directorFailure`).
- **The pick is checked against `goalModelRoster()`** (= `implementorModelRoster`, the auto-selection
  roster). An undispatchable model falls back to automatic routing, with the reason written into the
  step's rationale, rather than pinning a step to a model that cannot run. A goal with a token budget
  gets `meteredRoster` (no Grok: it reports no usage), and `pinWithinBurnRate` pins an unplaceable pick to
  a metered candidate instead, since automatic routing could land on Grok.
- **The owner's pin bounds the director's pick; `goalStepPin` is the single place that applies it.** An
  unset goal `effort` means low or medium ONLY — a 24/7 loop must not burn high-effort capacity by
  default. The judge schema's enum and the prompt already say so, but `goalStepPin` still caps the
  answer, because the CLI-bridge director and a schema-ignoring model can return anything. An owner
  model skips the roster fallback above: it is dispatched as the exact pin and waits for capacity.
  A model travels only with its provider (`validateGoalPin`); a half pin is rejected, never guessed.
- **A sequential goal carries ONE task and session (`persistentSession`, default on).** After the first
  step, `continueOnItsOwn` sends a clean `CONTINUE` turn back into the same task via `host.continueTask`
  (= `ThreadManager.continueGoalTask`, the owner-Resume path) with NO director call. Do not route an ordinary
  continuation through the director again: that call per turn is exactly the overhead this removed, and
  `goalSession.test.ts` pins the counts (5 turns = 1 director call + 1 dispatch + 4 continuations). The
  director is asked only for a `COMPLETE` claim (audit), an unclean/failed turn, an owner edit or Resume
  (`replan_at`), a pin change, or a task that answered `fresh` (`retiredCarriers`, in memory). Parallel
  goals never continue a session. Engineering note: `docs/goal-persistent-sessions.md`.
- **`continueGoalTask` is synchronous up to the `resuming` reservation, and refuses on ANY pending work.**
  `goalTurnHold` lists it (owner input of every kind, live/winding-down runs, manual Proceed, deadline,
  token safety, restart drain, concurrency caps) and `goalTaskHold` keeps a cap-parked or restart-parked
  task's step RUNNING, because GGO itself owes it an auto-resume in the same session. A new hold kind
  goes in those two functions, and `test:goal-continuation` (the real entry point, no paid model) must
  cover it; `goalSession.test.ts`'s fake host cannot prove the manager detects anything.
- **Stops use evidence, never prose.** `noProgress` runs for `done` AND `review` turns: a turn with no tool
  call is counted per carrier (`silentTurns`, in memory) — the first only blocks `continueOnItsOwn`, so the
  director judges the report and its `next` reaches the same session, even when it repeated the report
  before it (a refusal usually does); `GOAL_SILENT_TURNS` (2) in a row stop as `blocked`. An objective edit
  or Resume clears the count. Never make the first one a stop: a turn that ends on its report alone is a normal ending
  (the d2r goal blocked that way on 2026-10-02). A turn with progress (`assessSessionProgress`: ≥3 novel tool calls, a new finding, or a git
  fingerprint change) resets the idle count and the wait backoff whatever status it ended on, and always
  continues, even under the same words; otherwise a clean turn stops on a repeated report digest (the
  WAITING/BLOCKED turns update the digest too, so "repeated" means the turn just before) or on
  `GOAL_IDLE_TURNS` idle turns. `toolCalls == null` (Grok) never counts idle. An idle `WAITING` turn never
  stops: `idleWaits` doubles the next check up to `GOAL_WAIT_BACKOFF_MAX_MS`. `noteUncleanTurn` retires a
  carrier after `GOAL_UNCLEAN_TURNS` `review` turns running (in memory, like `retiredCarriers`). A
  persistent goal's dispatch sets `skipSelfImprovement`, or that round's report replaces the status line.
  `judgeAndAct` checks the carrier's pool (`runningProvider`: the latest run's account, not
  `step.provider`) before the director call and again, on a fresh roster, after it. `blockerStreak` never compares wording: only `moved` (repo change or new finding) restarts the
  count. Both stop as `blocked`, an owner status apart from `paused`; Resume resets the streaks and sets
  `replan_at` so the next pass audits.
- **Owner injections are scoped to their turn.** An inject into a step task is a standing directive
  (`recordStandingDirective`); `continueGoalTask` moves it to `priorTurnDirectives` before the next turn,
  and `standingDirectivesBlock` renders those under a heading that keeps constraints but ends wind-down
  orders ("pls finish up") with their turn. Without the move a days-old "finish up" re-arrived as a live
  order in every continuation turn and made the agent refuse work. Retry keeps both lists, and every lane's
  kickoff (researcher, reader, QA, reviewer) takes the stage's two lists through `renderOwnerDirectives`, so
  a constraint moved to the earlier-turn list still reaches them. The same boundary stamps
  `priorTurnsEndedAt`: `persistedImageBlocks` skips owner screenshots older than it and the in-memory
  `threadImages` are dropped, and the earlier-turn heading calls those requests already acted on (re-open only
  on current evidence). The cold reseed (`composeResumeKickoff`) puts them beside the handoff, never in its
  "Current authoritative" block. On 2026-10-02 the d2r step re-attached a 14:53 green-window screenshot and
  ranked "fix the green artifacts" above the handoff that recorded the fix, so every fresh session redid a
  fix finished hours earlier. The receipt note names the instruction it acknowledges (`quoteInstruction`), not
  "the instruction(s) above". Gate: `test:goal-continuation` J + `test:injection-receipts`.
- **One Done notice per step task.** `settleGoalTurn` marks its `done` quiet (`quietGoalDone`, held only
  across the `setState`) when `db.endsGoalContinuationTurn` — the task's latest step has `turns > 1` and its
  goal is still `active` — and `publishState` skips the owner notice (Discord + voice) for it. An ending the
  owner started (Resume, inject run) is never quiet. The goal's own blocked/paused/achieved notice covers
  the rest; covered by `test:goal-continuation` I.
- **Races the settle and judge must survive.** `sendTurn` stamps `turnStartedAt` from the clock BEFORE
  `continueTask` (the host may create the run row synchronously). `settleStep` re-checks `turnUnchanged`
  after awaiting the workspace fingerprint and returns `restarted` if the owner resumed or steered the task
  meanwhile. `judgeAndAct` re-reads the goal after the judge and drops the plan if the objective, pin,
  pace, `persistentSession` or `tokenBudget` changed, then re-checks `budgetSpent`.
- **Usage is step-task run usage from the goal's own baseline, and the budget is boundary-enforced.**
  `usage_since` (creation, or migration time for older goals) is the only provenance: never a global
  meter date. Earlier runs are a count, unmetered runs make the total `≥`, cache reads are apart. Director
  judgements are outside it. A running turn can overshoot the budget, which is checked between turns, and
  a spent budget refuses Resume until it is raised or removed. Do not add streaming metering here.
- **The `goals` event patches the cached hello** (`createHelloCache` in `ws/hub.ts`), so a reload inside
  the cache window shows the status the runner last broadcast. A raw SQL write in a lab emits no event: drive
  an owner action through the runner after it (`goals-lab.cjs` pauses another goal) instead of adding a
  production refresh.
- **Guards fire at SETTLE time, not on every evaluation.** A cancelled step pauses the goal, and so do 3
  consecutive failed steps. If those checks ran on every evaluation, Resume would re-pause at once on the
  same old step (`test:goals` covers "resume judges again"). Only a missing workspace is re-checked on
  every pass. A `review` outcome is NOT a failure: QA was unsatisfied, but the work exists.
- **There is no step budget; a goal keeps going until it is done.** The owner removed it on 2026-09-28,
  so do not reintroduce a step count limit as a runaway guard. The bounds are the failed-step streak,
  a cancelled step, the burn-rate hold (never on a pool the owner is preparing for its reset: a roster
  entry marked `resetBurn` is not paced), the evidence-based `blocked` stops above, an optional owner token
  budget (`budget_limited`) and the owner's Pause. Boot drops the old `goals.max_steps`
  column and reactivates any goal still paused by "Reached its budget of …" (`resumeBudgetPausedGoals`).
- **The step row is written BEFORE the dispatch.** A crash in between leaves a step with no `thread_id`;
  `adoptOrphan` finds its task by the exact `stepTitle` in that workspace, and while that is unresolved
  the goal dispatches nothing. That early return is load-bearing: without it a restart doubles the step.
- **Parallel steps are slots, not a different loop.** `advance` settles every open step (`listOpenGoalSteps`),
  counts the ones still running, and judges only while fewer than `maxConcurrent` run. The last-settled
  step, not the highest `seq`, is "the last step" (its claim is the agent's voice), and the failed-streak
  guard reads the last 3 SETTLED steps. A running step has `outcome` null, which `stepFailed` counts as a
  failure. A dispatch that leaves a slot free re-runs the evaluation loop to fill it.
  The judge sees the exact free-slot count and must search the whole remaining objective for independent
  work before waiting. A dependency on the next live test or no-tools repository access does not block
  unrelated implementation, recorded-evidence work or replay tests. Keep scopes bounded so one step does
  not reserve every concern, and require work-board/ownership checks before implementors edit shared files.
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
  Owner edits that replan and Resume release the old hold with persisted `waitReleased`, preserving its
  reason and settled-step cursor. A new director wait holds again; title-only and unchanged edits do not release it.
- **The burn-rate hold is a `wait`, not a `paused` status.** It must lift by itself when the pace catches
  up, so it sets `nextCheckAt` (≥ the retry backoff, ≤ 30 min) and keeps the goal `active`. It runs BEFORE
  the director call, so a held goal spends nothing. An unpinned goal holds only when every pool is over
  pace; `pinWithinBurnRate` keeps an unplaceable pick off automatic routing, which could pick an
  over-pace pool. Changing `maxConcurrent`/`burnConservation`/`burnRatePct`, the objective or the model/effort
  pin clears `nextCheckAt` and evaluates at once; a title edit keeps the backoff.
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

- **Milestones are the step agent's own structured report, never inferred.** `report_goal_progress`
  (bus tool, registered only for a goal step's implementor) and the CLI `GOAL_PROGRESS:` line both reach
  `GoalRunner.recordWork`, which merges into `goal_work_items` by `(goal_id, key)` (`goalWork.ts`
  `mergeGoalWork`). A report without an `id` matches an existing item by its title slug, so a retry or a
  resumed session updates rather than duplicates. A report is all or nothing: blocked and
  awaiting_approval need a `blocker`, and `verified` counts only on `done`. Never mark an item done from
  elapsed time, a session ending or a command succeeding. Titles and notes are clipped short (60/200
  characters) because the owner skims them. `stepOfTask` falls back to the orphan title match, since the
  bus is created before the dispatch writes `thread_id` back.
- **A step's `last_status` is the status line its last turn ended on.** `settleStep` writes it. On boot,
  `backfillStepStatus` reads it once for older steps from their recorded reports: NULL means not read yet,
  and "" means read, with no line. Historical goals show only this and their steps; nothing else is
  backfilled, and the view shows counts, never percentages.
- **The continuation carries a short reminder and the first open milestones only** (`GOAL_PROGRESS_REMINDER`,
  `CONTINUATION_WORK_CHARS`), because `goalSession.test.ts` keeps a continuation under 2,500 characters.
  The full list is in the fresh brief, the judge prompt and every tool reply.

Verify: `npm run test:goals --prefix server` (server loop + the web store/view gate), then typecheck.
The tree in a real browser (desktop + iPhone, live update, restart): `npm run goal-tree-lab --prefix server`.
