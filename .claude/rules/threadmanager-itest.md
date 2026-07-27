# Writing a ThreadManager integration test that actually proves something

For any change to pipeline behavior in `orchestrator/threadManager.ts` — resume/retry
logic, the QA loop, failover, gating. The cheap seam is a REAL `Db` (temp file) +
`EventHub` + a stub AccountManager, stubbing ONLY the agent spawn. No `claude`
subprocess, no quota, ~1s. (For "does the lane actually answer" use the real-agent
harness in `e2e-a-pipeline-lane.md` instead — it costs money.)

References: `silentResume.itest.ts` (drives one private method with fake runs),
`qaRoundBudget.itest.ts` / `tokenFreezeResume.itest.ts` (full harness),
`officeGating.itest.ts`, `perRepoConcurrency.itest.ts`.

## The check that is NOT optional: revert the fix, watch the gate fail

A test written AFTER the fix proves nothing until you have seen it fail without it.
Comment out your change, run the gate, require RED, restore. Commit `70c2f84` shipped
with two gaps that made it a no-op in production — its tests passed anyway, and only
the revert-check (landed as `5a618cc`) found them. Budget one minute for this; it is
the difference between a regression gate and a green decoration.

## Trap: your stub hands the code a state production never has

Both gaps above were this. The harness is not production, and the differences are
exactly where lifecycle bugs live:

- **`this.live` stays populated.** In production a run's own `onEnd` clears the live
  handle AND finalizes its `agent_runs` row — and it RACES the result you awaited. A
  fast run (an empty resume exits in seconds) usually wins that race. If your code
  reads `this.live.get(id)` or checks `run.endedAt`, add a case where onEnd already ran.
- **An empty `messages` table.** Guards like `implementorLooksDone` read the last
  implementor MESSAGE, which in production carries over from an EARLIER session — a
  QA fix-round resume routinely inherits "the task is complete". Seed a stale sign-off
  and prove it can't veto your path.
- **Fresh `db.createRun` rows** are `state='starting'`, `endedAt: null`. Production
  rows reaching your code are often already terminal.

## When the question is "what does the SDK actually do?"

Some pipeline logic rests on Agent SDK behaviour we don't control — whether `--resume`
gets a fresh turn budget, whether it reaches the model at all. Don't hand-roll a harness
and don't reason from the types: `npm run probe:sdk-resume --prefix server` drives the
real `AgentRun` through a fresh query + N resumes and prints subtype/turns/output/cost
per attempt (`out: 0` on a success = the silent-resume signature). Costs real quota;
defaults to Haiku at ~$0.10.

## Gotchas that cost a run each

- Set env (`MAX_AUTO_RESUMES`, `CAP_RETRY_MS=0`, `ACCOUNT_PING_MS`) BEFORE `config.js`
  is evaluated — so import the app modules with dynamic `await import()`, as every
  existing itest does. A top-level static import hoists and reads env too late.
- `db.createThread` requires `rawPrompt` (NOT NULL) — omitting it throws SQLITE_CONSTRAINT.
- `dispose()` must `clearInterval(capSupervisor)` + `clearTimeout(tokenResumeTimer)` and
  `db.raw.close()` BEFORE `rmSync`, or Windows throws EBUSY on the sqlite file.
- A `StubAccounts` fake must carry every method the constructor's boot-apply calls
  (`setSpreadUsage`, `applyWeeklySafetyPct`, …) or construction crashes.

## Register it or the sweep never runs it

Add the `test:*` script to `server/package.json` AND to `GATES` in
`server/scripts/run-gates.cjs` — an unregistered gate is invisible to the nightly
sweep (`nightly-quality-sweep.md`). Verify with `npm run typecheck && npm run
test:gates --prefix server`.
