# Token-freeze → reset → auto-resume — proof it works

**TL;DR:** The orchestrator's token-freeze auto-resume **works**. A new deterministic integration test drives
the full freeze → usage-reset → resume cycle against the **real** `ThreadManager` machinery (mocking only the
account usage signal and the leaf agent spawn) and passes **26/26** assertions. A negative control proves the
test genuinely fails if resume regresses to a cold restart. No bug was found — the mechanism is correct; it had
simply never been exercised end-to-end before.

- **Test:** `server/src/tests/tokenFreezeResume.itest.ts`
- **Run:** `npm run test:token-freeze` (from `server/`) — exits non-zero on any failure.

---

## What "freeze → resume" actually is (the real code path)

The opt-in feature is **Token-reset auto-resume** (`setting_auto_resume_on_token_reset`, off by default;
threshold `setting_auto_resume_threshold_percent`, default 80). All in `server/src/orchestrator/threadManager.ts`:

1. **Detect the freeze.** On every account usage refresh, `maybeScheduleTokenResume()` checks live
   `effectiveUtilization()`. When it crosses the threshold and a window reset epoch is known, `armTokenResume()`
   persists that epoch to the `token_resume_wakeup_at` kv key and schedules `fireTokenResume()` for reset + 60s.
2. **Freeze, don't die.** Work that hits the wall lands in one of two preserved states — `paused` (interrupted
   implementor) or a cap-parked `review` (all accounts capped mid-task, error prefixed `⏳ Auto-resume pending`).
   Files on disk and the implementor's SDK session survive.
3. **Reset.** When the window resets an account regains headroom; the armed timer fires.
4. **Resume with prior context.** `fireTokenResume()` gates on `hasHeadroom()`, then resumes each frozen task
   via `resumeThread()`. Recovery re-enters through `startResumedImplementor()`, which is handed the prior SDK
   session recovered from `agent_runs.session_id` (`latestImplementorSession()`) — a **warm resume of the prior
   journal, not a cold restart**. `restoreTokenResume()` re-arms the timer across a server restart from the kv epoch.

## How the test exercises it deterministically

- **Real:** a temp-file `Db`, a real `EventHub`, and the real `ThreadManager` freeze/resume orchestration
  (`maybeScheduleTokenResume` / `armTokenResume` / `restoreTokenResume` / `fireTokenResume` / `resumeThread` /
  `latestImplementorSession`).
- **Simulated (the two leaves that would otherwise need a live API limit + token burn):**
  - the **usage signal** — a stub `AccountManager` whose utilization / soonest-reset / headroom the test drives,
    standing in for the ~10-min usage ping crossing then clearing the cap;
  - the **agent spawn** — `startResumedImplementor` is intercepted to *record the session id the real recovery
    handed it*, then mark the task `done` (standing in for the resumed implementor running to completion).
- The routing gate (`gateImplementorProvider`) is forced open — it's orthogonal to freeze/resume.

Every assertion observes real code output (kv values, log strings, the recovered session id, state transitions).

## Result — `npm run test:token-freeze`  →  PASS ✅ (26 passed, 0 failed)

| Test | Maps to | Proves |
|------|---------|--------|
| A | guard | Feature OFF ⇒ a 99% usage ping arms **nothing** (no false green). |
| B | steps 1–2 | Freeze (util 90% ≥ 80%) ⇒ a wakeup is armed **at the soonest reset epoch**; logged "Token threshold hit (90%). Scheduling resume…". |
| C | "freeze, not die" | The frozen task stays `paused` (not deleted/failed) and its prior implementor session is still recoverable from the DB. |
| D | guard | An early reset with **no headroom** ⇒ **re-arms** for the next reset and does **not** wake the task (no instant re-cap). |
| E | steps 3–4 | Usage resets (headroom returns) ⇒ resume **fires**, re-enters the same task **carrying its prior session** (warm, not cold), task reaches `done`, wakeup kv cleared, owner notified ("Token window reset. Resuming 1 paused/parked task."). |
| F | steps 3–4 | Same for the **cap-parked `review`** freeze outcome — resumes with its prior session and completes. |
| G | durability | Freeze + arm, then a **server restart** (fresh manager, same DB) ⇒ re-arms from the persisted epoch (logged "Re-arming token-reset auto-resume after a restart"). |

### Negative control (the assertions genuinely bite)

Injecting the exact bug the test must catch — a cold restart that loses the journal (`latestImplementorSession`
forced to return `undefined`) — makes the resume still fire but with `resumeSession=undefined`, so Test E's
**"carried the prior session"** assertion flips to **FAIL**. A broken resume would not pass this suite.

## Conclusion

The freeze→reset→resume cycle behaves correctly and is now covered by a repeatable, self-contained test. Enable
it in Settings ("resume when the token window resets"); the machinery arms on the freeze, survives a restart, and
warm-resumes the frozen task with its prior context the moment the window frees up.
