# Token freeze mid-task — behavior findings

**Scope:** investigation only, no code changes. Traces what the orchestrator does when a Claude
token wall is hit mid-task: rate-limit / usage cap (429 `rate_limit_error`), transient overload
(529 `overloaded_error`), and context-window exceeded (`prompt is too long`). All line refs are
`server/src/…` on the tree at the time of writing.

TL;DR — **rate-limit / usage-cap handling is robust and self-healing** (multi-signal detection →
account failover → cap-park → 120 s auto-resume, with partial work preserved). **529 is correctly
left to the SDK.** The **one real gap is context-window-exceeded**: it has *no* dedicated path, so
it parks in a human-gated `review` with no auto-resume and no compaction — indistinguishable from a
generic crash.

---

## 1. What a token freeze is, and the three distinct cases

| Case | API shape | Handled? |
|------|-----------|----------|
| Usage cap / rate limit | 429 `rate_limit_error`, `rate_limit_event`, assistant `error:"rate_limit"`, or a CLI "you've hit your … limit" text notice | ✅ Yes — detect → failover → park → auto-resume |
| Transient overload | 529 `overloaded_error` | ✅ Yes — **deliberately** left to the SDK's internal retry (switching accounts wouldn't help) |
| Context window exceeded | error result "prompt is too long: N tokens > 200000 maximum" | ❌ **No dedicated path** — falls through as a generic error, human-gated park |

---

## 2. Rate-limit / usage-cap — the well-handled path (with proof)

### 2a. Detection (multi-signal), `server/src/agents/runner.ts`
A cap can surface in **four** different shapes; each is caught and normalized into one
`flagCapFromSignal()` (L271-275, which sets `rateLimited` and emits a `rate_limit` event):

- **`rate_limit_event`** with `status:"rejected"` → sets `rateLimited` (L353-362).
- **Assistant-message error** `m.error === "rate_limit"` → `flagCapFromSignal` (L330). Comment there
  is explicit that this is *not* done for `overloaded` — "that's transient server load the SDK
  retries, and switching accounts wouldn't help."
- **CLI session-limit TEXT block** ("You've hit your session limit · resets 7pm") — matched by
  `SESSION_LIMIT_TEXT_RE` (L402-403), the text is *swallowed* (so the owner doesn't see a dead-end
  message), the reset clock is parsed (`parseResetClock`, L415) or falls back to a 5 h cadence
  (`SESSION_LIMIT_FALLBACK_MS`), and a synthetic `rate_limit` is emitted so the account is held out
  of rotation (L308-319).
- **Error RESULT** — `evt.isError && resultLooksRateLimited(m)` (L378). `resultLooksRateLimited`
  (L437-443) checks `api_error_status === 429`, a `stop_reason` matching `/rate.?limit/i`, or the
  error/result text against `RATE_LIMIT_RESULT_RE` (L393-394).

### 2b. Account failover, `server/src/accounts/accountManager.ts`
- `HARD_LIMIT = 98` (L26): an account whose tightest window (`max(5h, weekly)`, L31) is ≥ 98% is
  treated as capped.
- `noteRateLimit` (L229-240) flags `rateLimited` fast, mid-burst, from a live `rate_limit_event`.
- `selectFailover(excludeId)` (L285-291) returns another enabled account with headroom
  (`!limited && tightest < HARD_LIMIT`), or `null` when none has room.
- `hasHeadroom()` (L337-344) is the supervisor's gate; `soonestResetAt()` (L323) reports when the
  next account frees.

### 2c. Mid-task failover + cap-park, `server/src/orchestrator/threadManager.ts`
- `awaitImplementorResult` (L1263-1295): on a rate-limited result it fails over up to
  `MAX_ACCOUNT_FAILOVERS = 3` (L96) times — **stops the capped query and warm-resumes the same
  session on the next account** (`startImplementor({ resume: sessionId, … })`, L1284), so
  work-so-far is preserved (the SDK session transcript + files on disk carry over). If no account
  has headroom, it sets `capParked` (L1280/L1293) and returns `undefined`.
- `settleReview` (L756-759): when `capParked` is set, it parks with `capParkMessage()` — the
  `CAP_PARK_PREFIX = "⏳ Auto-resume pending"` marker (L112) — otherwise it uses the human reason.
- `capParkMessage` (L763-766): "…every account was rate-limited mid-task. Soonest account resets
  … It will resume automatically when one frees up (no manual Resume needed)."

> **Note (observed this session):** the rate-limit path is actively being hardened. A teammate
> landed a fix on `origin/master` for a real flap in exactly this area — a session-limit cap that
> didn't propagate into `AccountManager`, so a cap-parked task auto-resumed every `capRetryMs` (120 s)
> and instantly re-capped, re-surfacing the "session limit" message on a loop. On the tree documented
> here, the synthetic `rate_limit` event *does* reach `AccountManager.updateFromRateLimit` (L230) via
> the runner's event bridge (threadManager.ts L2593-2595); the fix tightens that propagation further.
> This underscores that the cap path, while robust in design, has had live edge cases — whereas the
> context-window path (§4) has no handling at all.

### 2d. Auto-resume supervisor
- `capSupervisor` runs `resumeCapParked` on an interval of `capRetryMs = 120_000` (config L158;
  wired L262-269). It scans `review` tasks whose `error` starts with `CAP_PARK_PREFIX` (L287) and
  resumes them the moment `AccountManager.hasHeadroom()` turns true — a window reset or a freed sub.
- Resume is **cheap**: it warm-resumes the session and compresses the prior transcript locally
  (`resumeCompress.ts`) rather than reloading hundreds of K of context on a cold cache miss.

### 2e. Proactive token-safety auto-stop (opt-in), `threadManager.ts` L307-345
Layered *under* the immediate `HARD_LIMIT=98` failover: when live `effectiveUtilization()` (the MIN
across accounts, L356-369) reaches the operator threshold (`setting_token_limit_percent`, **default
80**, range 50-99, L546), `stopAllForTokenLimit` cancels every running + queued task so it stops
burning the allowance; they land in **Cancelled** (re-dispatchable) with a `notice` event and an
external ping. It lags a fast burn by minutes (driven by the ~10-min usage ping), so it's a net, not
a realtime cutoff. Latched so it fires once per crossing (L310-312).

### 2f. Owner notification (the answer to "is the user told?")
Yes, for the cap path — via `notifyExternal` (external webhook, L770) plus in-app log/`notice`:
- Failover: "↪ {role} hit a {window} limit mid-task — auto-switched to {account}, continuing …" (L426).
- Cap-park: **no** "needs review" ping (deliberate — it would mislead and re-fire every re-park),
  L746-748; the task instead shows the "⏳ Auto-resume pending" marker in the UI.
- Auto-resume on freed account: "↪ account freed up — auto-resuming …" (L296).
- Token-safety stop: `notice` + "🛑 Token safety limit reached …" (L343-344).

---

## 3. 529 / overloaded — intentionally not a cap

`overloaded_error` (529) is transient server load. The code explicitly does **not** treat it as a
usage cap (runner.ts L328-329) because switching accounts wouldn't help — the Agent SDK retries it
internally with backoff. This is correct; no gap.

---

## 4. THE GAP — context-window exceeded ("prompt is too long")

**No code anywhere recognizes a context-length error.** A grep of `server/src` for
`prompt is too long` / `context (window|length|limit)` / `input length` / `413` returns nothing that
matches a context overflow. Walking the same result through the pipeline:

1. It arrives as an **error result** whose text is roughly `prompt is too long: N tokens > 200000
   maximum`. `RATE_LIMIT_RESULT_RE` (`rate.?limit | usage limit | session limit | hour limit |
   limit reached | too many requests | quota …`) does **not** match that string, so
   `resultLooksRateLimited` is false and `rateLimited` stays **false**.
2. In `awaitImplementorResult` (L1273): `res.isError` is true but `!current.rateLimited` is true, so
   it **returns the error result immediately — no failover, `capParked` never set.**
3. In `awaitImplementorCompletion` (L1322-1327): it's not a turn-limit stop (subtype isn't
   `error_max_turns`, L1360-1362) and not a voluntary stall (`res.isError` short-circuits
   `implementorStalled`, L1379), so the **auto-resume loop never runs.**
4. It settles via `settleReview` (called at L1559 "Implementor ended without completing — needs your
   review."). `capParked` is empty, so it gets the **human reason, not the CAP_PARK marker.**
5. `setState` (L748) then fires the **"⚠ needs your review"** external ping — i.e. it looks exactly
   like a generic incomplete run.

### Net effect
- **Does it gracefully pause & resume?** No. It parks human-gated with no auto-resume.
- **Fail hard / closed?** It lands in `review` (not `failed`/`closed`), so it isn't lost — but it
  will sit there until a human clicks Resume.
- **User notified?** Yes, but with a **misleading** signal — "needs your review," identical to a QA
  miss or a crash. Nothing tells the owner it was a context overflow or how to fix it.
- **Partial work lost?** No — files on disk and the SDK session transcript survive, same as the cap
  path. And the recovery machinery already exists: a manual Resume warm-resumes via
  `resumeCompress.ts`, which **compacts** the transcript — often shrinking it below the limit. The
  gap is that this compaction is **never triggered automatically** for an overflow.
- **Transient vs. hard stop distinguished?** Rate-limit (transient) yes; context-exceeded (needs
  compaction) is **not** distinguished from a generic failure.

### Secondary risk — `RATE_LIMIT_RESULT_RE` over-broad match
`RATE_LIMIT_RESULT_RE` includes the loose alternative `limit reached`. If a future context/error
message happens to contain that phrase, `resultLooksRateLimited` would **mis-classify a context
overflow as a rate limit** and trigger pointless account failover — each fresh account instantly
re-hits the same oversized prompt, burning up to `MAX_ACCOUNT_FAILOVERS` relaunches with zero
progress before parking. Today's exact Anthropic wording ("prompt is too long") doesn't trip it, so
this is latent, not active — but the regex is a foot-gun worth tightening.

---

## 5. Recommendations (not implemented — investigation only)

1. **Detect context overflow explicitly.** Add a `resultLooksContextExceeded(m)` check in
   `runner.ts` (match `prompt is too long`, `context (window|length)`, token-count-over-max, and the
   SDK's `413`/`invalid_request_error` for oversized input) and surface it as a distinct signal
   (e.g. a `contextExceeded` flag), separate from `rateLimited`.
2. **Auto-recover via forced compaction.** On that signal, drive the existing warm-resume + local
   compression path (`resumeCompress.ts`) automatically — the recovery already works on manual
   Resume; wire it to fire on overflow (bounded by `maxAutoResumes = 8`, L170, to avoid a loop if
   compaction can't get under the limit).
3. **Distinct park marker + message.** If compaction still can't fit, park with a dedicated marker
   and an honest message ("context window exceeded — transcript compacted but still too large;
   consider splitting the task") instead of the generic "needs your review," so the owner knows the
   cause.
4. **Tighten `RATE_LIMIT_RESULT_RE`.** Drop or anchor the bare `limit reached` alternative so a
   context error can never be mis-routed into rate-limit failover (see §4 secondary risk).

---

## 6. Live-monitoring note (best-effort)

A read-only poller (`token_freeze_test.log`, gitignored — local artifact, **not** committed) was set
up to capture any state transition during this session: it tails the orchestrator's SQLite
(`server/data/orchestrator.sqlite` — `threads.state/error` for the `⏳ Auto-resume pending` marker and
`agent_runs.state='error'`). **A token freeze may not fire during the session**; if none is captured,
the above is derived from the code paths, not from an observed live event. The log records whatever
transitions actually occur.
