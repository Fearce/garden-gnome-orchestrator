# Writing a ThreadManager integration test that actually proves something

For any change to pipeline behavior in `orchestrator/threadManager.ts` — resume/retry
logic, the QA loop, failover, gating. The cheap seam is a REAL `Db` (temp file) +
`EventHub` + a stub AccountManager, stubbing ONLY the agent spawn. No `claude`
subprocess, no quota, ~1s. (For "does the lane actually answer" use the real-agent
harness in `e2e-a-pipeline-lane.md` instead — it costs money.) References: `silentResume`
(one private method), `qaRoundBudget` / `tokenFreezeResume` / `autoReview` (full harness),
`officeGating`, `perRepoConcurrency` — all `*.itest.ts`.

**Stub at the right depth.** Stubbing `runQA`/`runReviewer` tests the LOOP around it;
to test what those methods themselves decide (resume vs fresh, kickoff choice, a
cutoff continuation) stub `runRole` instead — one level lower, still no subprocess.

## The check that is NOT optional: revert the fix, watch the gate fail

A test written AFTER the fix proves nothing until you have seen it fail without it.
Comment out your change, run the gate, require RED, restore. Commit `70c2f84` shipped two
gaps that made it a no-op in production; its tests passed, and only the revert-check
(`5a618cc`) found them. One minute, and it is the difference between a gate and a decoration.

## Trap: your stub hands the code a state production never has

Both gaps above were this — the differences are exactly where lifecycle bugs live:

- **`this.live` stays populated.** In production a run's own `onEnd` clears the live
  handle AND finalizes its `agent_runs` row — and it RACES the result you awaited. A
  fast run (an empty resume exits in seconds) usually wins that race. If your code
  reads `this.live.get(id)` or checks `run.endedAt`, add a case where onEnd already ran.
- **An empty `agent_runs` table.** A stubbed `runRole` writes no run row, so everything
  reading the run trail silently takes its fallback: the QA park degrades to the generic
  "needs your review" instead of the diagnosable reason, and `latestQaRun` /
  `latestRoleSession` find no session, so a warm-resume path never even runs. Persist
  what the real `runRole` would have (`createRun` + `updateRun` with `sessionId`/`error`).
- **An empty `messages` table.** Guards like `implementorLooksDone` read the last
  implementor MESSAGE, which in production carries over from an EARLIER session — a
  QA fix-round resume routinely inherits "the task is complete". Seed a stale sign-off
  and prove it can't veto your path.
- **A faked result event must carry `type`/`subtype`/`isError`.** A bare `{isError:true}`
  is not a `ResultEvent`: `runErrorText` reads `subtype`, so the stub throws a TypeError
  the settle path's catch swallows into the owner-facing message. Fake the whole shape —
  and leave `result` unset for an SDK error, or it outranks the canned subtype reason.

## Gotchas that cost a run each

- Set env (`MAX_AUTO_RESUMES`, `CAP_RETRY_MS=0`, `ACCOUNT_PING_MS`) BEFORE `config.js`
  is evaluated — import the app modules with dynamic `await import()`, as every existing
  itest does. A top-level static import hoists and reads env too late.
- **A warm-resume test needs `RESUME_FULL_SESSION=1`**: a fake session id has no CLI
  transcript, so `sessionAgeMs` is null and the age check falls COLD — the "it resumed"
  assertion then quietly proves the fresh path. Process-global; say so in a comment.
- **Never `dispose()` with a `void`ed pipeline still in flight.** `autoReview`/`dispatch`
  return before their run settles; closing the DB under one throws "database connection
  is not open" — surfacing inside the NEXT test, so it reads as that test's bug. Yield
  several macrotask turns (not one `setTimeout(0)`) after any call you don't await.
- `db.createThread` requires `rawPrompt` (NOT NULL) — omitting it throws SQLITE_CONSTRAINT.
- `dispose()` must `clearInterval(capSupervisor)` + `clearTimeout(tokenResumeTimer)` and
  `db.raw.close()` BEFORE `rmSync`, or Windows throws EBUSY on the sqlite file.
- A `StubAccounts` fake must carry every method the constructor's boot-apply calls
  (`setSpreadUsage`, `applyWeeklySafetyPct`, …) or construction crashes — plus `auxToken()`
  if your path can reach `setState(id,"done")`: `announceDone` calls it inside a `void`ed
  promise, so a missing method is an unhandled rejection that kills the whole run.
- "What does the SDK actually do?" (does `--resume` get a fresh turn budget, does it reach
  the model): don't reason from the types — `npm run probe:sdk-resume --prefix server` runs
  the real `AgentRun` through a fresh query + N resumes, printing subtype/turns/output/cost
  each (`out: 0` on a success = the silent-resume signature). Real quota, ~$0.10.
- Register the gate: the `test:*` script in `server/package.json` AND in `GATES` in
  `server/scripts/run-gates.cjs`, or the nightly sweep never runs it — `test:gate-registration`
  red-flags both halves of that omission. Verify with
  `npm run typecheck && npm run test:gates --prefix server`.
