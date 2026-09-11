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

**Revert with the Edit tool, and `diff` the file before believing either colour.** A scripted
revert lies in BOTH directions. It edits nothing and the gate passes, which reads as "my fix isn't
load-bearing" but means "I never removed it" — twice on 2026-08-17 (`python3 - <<EOF` is the
Microsoft Store alias here: prints its ad, exits 0; a `node -e` replace missed on escaping). Or it
edits to garbage and the gate dies on a `SyntaxError` — red, but for a reason that says nothing
about your fix, and the more convincing lie because red is what you were hoping for (2026-08-25).
So: `cp <file> /tmp/x.bak`, `diff` after the revert, read the ASSERTION message rather than the
exit code, and `diff` again after restoring to prove it went back byte-identical.

**A verified revert that stays GREEN condemns the ASSERTION, not the fix.** The diff proves the code
left, so the gate is watching a proxy the bug doesn't move — ask what OBSERVABLE state the bug
changes and assert THAT. "The probe never writes to the DB" compared size+mtime and passed while the
probe ran migrations (on a migrated DB `CREATE TABLE IF NOT EXISTS` writes no pages; WAL misses the
main file). It only bit staged against a DB with a migration OUTSTANDING, asserting the column stays
absent. Sibling: an assertion on stdout cannot see a usage error printed to *stderr* (both 08-25).
Sibling #2, for anything TTL-cached: on this box the setup's own git/DB calls routinely outlast a
short TTL, so the entry the fix was meant to invalidate expires by itself and the gate passes without
the fix. Freeze the clock (inject `now`) before concluding the fix isn't load-bearing (09-08,
`.claude/rules/contextual-code-navigation.md`).

**A gate that THROWS under the revert told you nothing either.** `hitFor(...)!` is a TypeError once
the fix that produced the row is gone: a stack where you needed the line naming the defect, and every
later scenario unrun. Optional-chain the accessors (`hit?.where === "x"`) so a missing row reports.

## Trap: your stub hands the code a state production never has

Both gaps above were this — the differences are exactly where lifecycle bugs live:

- **`this.live` stays populated.** In production a run's own `onEnd` clears the live
  handle AND finalizes its `agent_runs` row — and it RACES the result you awaited. A
  fast run (an empty resume exits in seconds) usually wins that race. If your code
  reads `this.live.get(id)` or checks `run.endedAt`, add a case where onEnd already ran.
- **An empty `agent_runs` table.** A stubbed `runRole` writes no run row, so everything
  reading the run trail silently takes its fallback: the QA park degrades to the generic
  "needs your review" instead of the diagnosable reason, and `latestQaRun` /
  `latestRoleRun` find no session, so a warm-resume path never even runs. Persist
  what the real `runRole` would have (`createRun` + `updateRun` with `sessionId`/`error`).
  **Persist its `account` too**: `latestRoleRun` reads the backend back off that label
  (`zai:…`/`codex:…`/`grok:…`, else Claude), so a row without one reads as Claude and any
  assertion about provider-pinned resume passes vacuously.
  **A stubbed IMPLEMENTOR spawn owes a row for the same reason** (`startResumedImplementor`, the
  auto-review fix round): a non-reviewer run is what moves `autoReviewRevision`, so a harness that
  writes none freezes one revision across the whole episode and every assertion that the Supervisor
  converges on the work a fix round produced passes whatever the settle stamps (proven 2026-09-09 —
  `test:auto-review` stayed green with `finishAutoReview` writing the STALE revision, i.e. with the
  review/fix/review loop the gate exists to catch fully reopened).
- **An empty `messages` table.** Guards like `implementorLooksDone` read the last
  implementor MESSAGE, which in production carries over from an EARLIER session — a
  QA fix-round resume routinely inherits "the task is complete". Seed a stale sign-off
  and prove it can't veto your path.
- **A faked result event must carry `type`/`subtype`/`isError`.** A bare `{isError:true}`
  is not a `ResultEvent`: `runErrorText` reads `subtype`, so the stub throws a TypeError
  the settle path's catch swallows into the owner-facing message. Fake the whole shape —
  and leave `result` unset for an SDK error, or it outranks the canned subtype reason.

## A gate that reads the operator's `.env` or the machine's auth is not a gate

It is red on some boxes and green on others, so it gets written off as a "known environment
failure" and stops being read at all. Both of these sat red for weeks that way, and two separate
sessions re-diagnosed them to the same non-answer before 2026-09-11 fixed them (`c55c294`):

- **`test:account-usage`** asserted `buildEnv({}).CLAUDE_ORCH_ACCOUNT_ID === undefined`. `buildEnv`
  falls back to `config.oauthToken` and legitimately re-publishes an identity when that token matches
  a configured account, so the assertion only holds on a box whose `.env` configures none. Fix: drive
  it with a token no configuration can match, so the property under test (a stale inherited identity
  never survives) is asserted the same way everywhere.
- **`test:director-provider`** did not fail, it CRASHED. `directorTargets` calls `codexAuthAvailable`,
  which asks the machine (a `~/.codex` ChatGPT login, a seeded isolated `CODEX_HOME`, or a key) and
  which none of the test's `internals.*` stubs reach. With no Codex login there was no target at all,
  `configured[0]` was `undefined`, and the file died on a TypeError with three assertions still
  unexecuted. Fix: seed the seam into the test's OWN throwaway Db (`db.kvSet("openai_api_key", ...)`).

The general rule: **stubbing a ThreadManager method does not stub a module-level function it calls.**
`codexImplementorReady` and `codexProviderCandidate` are methods and were stubbed; `codexAuthAvailable`
is an import and was not, which is why the stubs looked complete and the gate still read the box.
Before adding a gate, ask which of its reads leave the process: `config.*` (the real `.env`, loaded at
import), `$HOME`, an auth file, a port, the clock. Each one is a machine the gate will be wrong on.

**"Pre-existing, not my diff" is where both earlier sessions stopped, and it is not a stopping point.**
`bash ~/Claude/tools/gate-blame.sh <npm-script>` answers whose diff it is safely, and for CI
`gate-ran.sh` separates ran-and-failed from never-ran. Locally the suite now does that last part
itself: a red gate in the summary is tagged `[reported]`, `[crashed]` or `[silent]`. Read the tag
before the tail, because for the last two the tail is actively misleading (a stack with no assertion
in it, or twelve lines of PASSING output). Gate: `test:gates-driver`.

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
- **`db.updateThread` writes only title/state/brief/workspace/error.** `effort_override` (and the close
  columns) are set at creation / by their own methods, so `updateThread({effortOverride})` silently no-ops
  and your "the operator's pin still wins" assertion fails against a thread that was never pinned. Seed the
  pin the way a dispatch does: `createThread({ effortOverride })`.
- `dispose()` must `clearInterval(capSupervisor)` + `clearTimeout(tokenResumeTimer)` and
  `db.raw.close()` BEFORE `rmSync`, or Windows throws EBUSY on the sqlite file.
- A `StubAccounts` fake must carry every method the constructor's boot-apply calls
  (`setSpreadUsage`, `applyWeeklySafetyPct`, …) or construction crashes — plus `auxToken()`
  if your path can reach `setState(id,"done")`: `announceDone` calls it inside a `void`ed
  promise, so a missing method is an unhandled rejection that kills the whole run.
- "What does the SDK actually do?" — never reason from the types (several fields have no doc comment).
  CLI semantics live in the minified binary, so anchor on a string literal: `claude-cli-grep '("now")'`
  (Bash tool; PowerShell eats inner quotes — `--pattern-file`), free and ~0.3s. What a RUN does needs
  quota: `probe:sdk-resume` (`out: 0` on success = silent resume, ~$0.10); what STEERING one does:
  `probe:sdk-steer [-- --mode now|next|interrupt]`, ~$0.03 — read `terminal_reason`, never the shape
  (a `"now"` abort is success-shaped, a bare `interrupt()` is `error_during_execution`).
- Register the gate in BOTH `server/package.json` and `GATES` in `scripts/run-gates.cjs`, else the
  nightly sweep never runs it; `test:gate-registration` red-flags either omission. Verify with
  `npm run typecheck && npm run test:gates --prefix server`.
