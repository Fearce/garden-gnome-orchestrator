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
  wording; `test:goals` pins both texts.
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
  same old step (`test:goals` covers "resume judges again"). Only the step budget and a missing workspace
  are re-checked on every pass. A `review` outcome is NOT a failure: QA was unsatisfied, but the work exists.
- **The step row is written BEFORE the dispatch.** A crash in between leaves a step with no `thread_id`;
  `adoptOrphan` finds its task by the exact `stepTitle` in that workspace, and while that is unresolved
  the goal dispatches nothing. That early return is load-bearing: without it a restart doubles the step.
- **Re-read the goal after the judge returns.** The owner may pause, end or delete it while the director
  is thinking; a judgement that lands afterwards must dispatch nothing.
- Pausing/ending never touches the running step task: it finishes, and no step follows.

Verify: `npm run test:goals --prefix server` (server loop + the web store/view gate), then typecheck.
