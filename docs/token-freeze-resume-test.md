# Token-freeze → reset → auto-resume — proof it works

**TL;DR:** Token-window recovery is always on. Capacity failures and Token Safety stops use the same durable
capacity-park state, retain the task's SDK session, and resume only when a compatible provider pool has real
headroom again. Token Safety also holds new dispatches until a fresh below-limit usage reading arrives.

- **Test:** `server/src/tests/tokenFreezeResume.itest.ts`
- **Run:** `npm run test:token-freeze` (from `server/`) — exits non-zero on any failure.

---

## What "freeze → resume" actually is (the real code path)

There is no auto-resume setting or off path. The flow lives in `server/src/orchestrator/threadManager.ts`:

1. **Detect the freeze.** Provider rejections create a durable capacity park. Independently, the always-on
   reset watcher arms before a hot window is exhausted. Its epoch is persisted in `token_resume_wakeup_at`.
2. **Freeze, don't die.** Token Safety writes the same `⏳ Auto-resume pending` park before stopping the live
   run. It never calls the terminal Cancel path. Files, stage outputs, findings, and SDK sessions survive.
3. **Hold the boundary.** While Token Safety is tripped, fresh dispatches remain queued and automatic resume
   is blocked. The freeze survives a server restart when a safety-parked row exists.
4. **Reset the right window.** Claude safety scheduling couples 5-hour and weekly readings. General capacity
   recovery uses the same per-task inventory for Claude, Codex, Grok, and z.ai, so an earlier 5-hour reset
   cannot release work that is still weekly/monthly exhausted.
5. **Resume with prior context.** `fireTokenResume()` gates on compatible capacity, then resumes each frozen task
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

## Regression coverage

| Test | Maps to | Proves |
|------|---------|--------|
| A | migration | Legacy off/threshold rows are deleted and cannot disable recovery. |
| B | steps 1–2 | Freeze (util 90% ≥ built-in arm point) ⇒ a durable wakeup is armed. |
| C | "freeze, not die" | The frozen task stays `paused` (not deleted/failed) and its prior implementor session is still recoverable from the DB. |
| C1–C2 | Token Safety | Active work becomes a durable capacity park (not Cancelled), resumes with its saved session after reset, and fresh dispatches remain queued until then. |
| C3 | owner bypass | "Resume anyway" releases the freeze, resumes the held task with its saved session and starts the held dispatch; the same crossing never re-trips, a restart keeps the bypass, a below-limit reading ends it, and the next crossing freezes again. |
| C4 | owner bypass | With no real provider headroom the bypass resumes nothing, reports the task as waiting, and leaves an ordinary cap park that the supervisor resumes once headroom returns. |
| C5 | owner bypass | Changing the Token Safety limit ends a bypass and re-evaluates at once. |
| D | guard | An early reset with **no headroom** ⇒ **re-arms** for the next reset and does **not** wake the task (no instant re-cap). |
| E | steps 3–4 | Usage resets (headroom returns) ⇒ resume **fires**, re-enters the same task **carrying its prior session** (warm, not cold), task reaches `done`, wakeup kv cleared, owner notified ("Token window reset. Resuming 1 paused/parked task."). |
| F | steps 3–4 | Same for the **cap-parked `review`** freeze outcome — resumes with its prior session and completes. |
| G | durability | Freeze + arm, then a **server restart** (fresh manager, same DB) ⇒ re-arms from the persisted epoch (logged "Re-arming token-reset auto-resume after a restart"). |

### Negative control (the assertions genuinely bite)

Injecting the exact bug the test must catch — a cold restart that loses the journal (`latestImplementorSession`
forced to return `undefined`) — makes the resume still fire but with `resumeSession=undefined`, so Test E's
**"carried the prior session"** assertion flips to **FAIL**. A broken resume would not pass this suite.

## Conclusion

The freeze→reset→resume cycle has one operator-visible policy: it is always on. The only usage safeguard toggle
is Token Safety, which controls whether work pauses early; it does not control whether preserved work recovers.
