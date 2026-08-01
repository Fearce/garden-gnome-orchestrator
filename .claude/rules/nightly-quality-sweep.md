# Nightly / quality sweep + resume-after-bounce

When the brief is a health/quality sweep ("nightly check", "make sure everything is smooth") or you
are auto-resumed after an orchestrator restart that already completed, run these six, in order.

## 1. `npm run health --prefix server`
(`nightly-health.cjs`) — hits `/api/health`, checks `:4317` vs `dist` **and `dist` vs HEAD**, greps live
reliability symbols, lists dirty git paths, summarizes SQLite parks/caps/stuck runs, and scans `crash.log`
for real faults vs benign memory high-water notes. Exit 1 = hard fail; a dirty tree alone does **not** fail.
Read **`dist` vs HEAD** carefully: process-vs-dist can agree while `dist` itself predates HEAD — how a
feature shipped its web half and sat in prod a full day unbuilt on the server (Stop button, 2026-07-29). It
compares by CONTENT (`dist/.build-info.json`'s commit vs HEAD's `server/src`, tests excluded); timestamps
alone would cry wolf every sweep. A warn = `npm run build` + the atomic hub restart.

## 2. `npm run typecheck && npm run test:gates --prefix server` — health does NOT run the gates
health greps dist symbols only, so a green one can sit on top of crash-broken gates (a missing
`StubAccounts.setSpreadUsage` once slipped past a "13/13 green" claim). `test:gates` (`scripts/run-gates.cjs`)
runs every registered FREE gate in ~90s (don't hardcode the count) and exits non-zero on any failure — stubs
+ a throwaway git repo, no `claude` subprocess, no quota. Once, at the end; never gate by gate.
`test:gate-registration` checks the suite is itself complete: a `test:*` script missing from `GATES`, or a
`src/tests` file with no script at all, is a failure.

## 3. `npm run probe:run-errors --prefix server` — triage the non-done runs (`-- 168` for 7 days)
`health`'s `runs 24h: { error: 10 }` is a COUNT, and most non-done runs are expected: a turn-ceiling cutoff,
a cap that failed over, a restart that auto-resumed, a retried 5xx. The probe classifies each, lists only
what needs a human, and **verifies the mechanism ran** (a cap/restart on a `review`/`failed` task with no
later run = something stopped mid-work). `num_turns` at the role's ceiling (implementor
`implementorMaxTurns`, qa 60, others 40) is a benign cutoff — that misread is why this step exists. Backs
health's `non-done reasons:` line. Gate: `test:run-classify`.

## 4. `npm run probe:parks --prefix server` — name the parked tasks
health's park line is a count too; this is the "read the thread error" it asks for — each task's id, age,
reason and last run, from the same classifier, so the two can't disagree. Classes: **stalled**
(QA/auto-review/resume stopped mid-verification — only a Resume or Auto-review clears it), **verdict**
(finished, awaiting the owner — by design, however old), **capWait** (`⏳ Auto-resume pending` — the cap
supervisor owns it, acting manually races it), **unknown** (wording drifted from `PARK_CLASSES` — fix the
classifier). A stalled park is already tagged **bug or stale** on its `↳` line (`recovery-features.cjs`,
gate `test:recovery-features`): `stale — … predates <feature> (<sha>); a Resume exercises the fix`, or
`… continuations already spent — the recovery mechanism ran and gave up`. Trust it, don't re-derive ship
dates by hand; only a stalled park tagged NEITHER needs a `probe:task-runs` drill. Gate: `test:park-classify`.

## 5. `npm run probe:accounts --prefix server` — backend headroom (the one watch-item)
A green sweep still leaves headroom to eyeball. Prints the Claude subs' 5h/7d capacity, then the **failover
ladder** — Codex / Grok / z.ai as `available (5h x% · 7d y%)`, `CAPPED — frees in <countdown>`, `NO ROOM —
<window> at N%`, or `disabled` — and a **ladder depth** line. Nothing counts as a rung while either window
is ≥98%, sub or backend: a "5h 0%" sub with a spent weekly doesn't, and neither does a backend never
rejected (so unlatched) but simply spent — that's `NO ROOM`; reading the latch alone once reported 3 rungs
over a 1-rung reality. A reported reset >2× its own window is a backend sentinel, printed but never counted
down (z.ai answered Jan 2027 for a 5h window). Depth ≤1 is the thing to act on: a burst then parks on caps.
One capped/spent backend is normal. Gate: `test:failover-ladder`.

## 6. `npm run probe:console` — the console still loads (health cannot see this)
`/api/health` proves the SERVER answers; a bundle that throws on mount or a WS that never connects keeps it
green over a dead UI. `console-smoke.cjs` asserts the app mounted, `.conn` reads live, and zero console
errors / failed requests (`-- --shot <png>` saves screenshot evidence for the report). `npm run probe:chips`
is the separate 4-width chip-clipping check. Both are read-only and **click NOTHING** — that is what makes
them the only browser checks safe against prod; read `.claude/rules/verify-a-ui-change-shipped.md` before
extending either, and never hand-roll your own drive against `:4317`.

## Do / don't
- **Do NOT re-restart** if the resume note says the bounce already completed — only verify live `dist` + health.
- **Do NOT `git add -A`** when `health` lists dirty paths; those are usually a concurrent implementor's WIP
  (office claims win). Pathspec only your files. Nor **re-apply** a teammate's already-pushed fix — check
  `git log -5 --oneline` + office claims first.
- **Do not run `npm install --omit=dev` in this shared checkout.** It removes the server's `tsc`/`tsx` and
  breaks the next build; repair a partial install with `npm install --prefix server`, then typecheck + build.
- **A real bug** gets its own conventional commit, pathspec-staged, pushed (not vota) — and you deploy server
  changes yourself via the atomic hub restart when your code isn't in the running `dist` (step 1 answers that).

## Related
- Office harvest gotchas: `.claude/rules/office-bridge.md`
- Shared-checkout deploy without peers: project memory `shared-checkout-concurrent-edits`
