# Nightly / quality sweep + resume-after-bounce

When the brief is a health/quality sweep ("nightly check", "make sure everything is smooth") or you
are auto-resumed after an orchestrator restart that already completed:

## First command (one shot)
```
npm run health --prefix server
```
(`nightly-health.cjs`) — hits `/api/health`, checks `:4317` vs `dist` mtime, greps live reliability
symbols, lists dirty git paths, summarizes SQLite parks/caps/stuck runs, and scans `crash.log` for
real faults vs the benign memory high-water notes. Exit 1 = hard fail; a dirty tree alone does **not** fail.

## Second command — run the gate suite (health does NOT)
```
npm run typecheck && npm run test:gates --prefix server
```
`health` greps dist symbols but never RUNS the unit gates, so a green health can sit on top of
crash-broken gates (a feature landing without updating a test stub — this is how a missing
`StubAccounts.setSpreadUsage` slipped past a "13/13 green" claim). `test:gates` (`scripts/run-gates.cjs`)
runs all FREE gates in ~25s (the count is whatever's registered — don't hardcode it here) and exits
non-zero on any failure, including the local reader, structured-output, and effort-cap integration
tests. They use stubs and a throwaway git repo; no `claude` subprocess or account quota is involved.
Don't hand-run gates one by one.

## Third command — triage the non-done runs (don't read the counts yourself)
```
npm run probe:run-errors --prefix server        # add `-- 168` for 7 days
```
`health`'s `runs 24h: { error: 10 }` line is a COUNT, and most non-done runs are expected: a
turn-ceiling cutoff, a cap that failed over, a restart that auto-resumed, a retried 5xx. The probe
classifies each one, lists only what needs a human, and **verifies the mechanism ran** (a cap/restart
on a `review`/`failed` task with no later run = something stopped mid-work). `num_turns` at the role's
ceiling (implementor `implementorMaxTurns`, qa 60, others 40) is a benign cutoff — that misread is
why this step exists. Same classifier backs health's `non-done reasons:` line (gate `test:run-classify`).

## Fourth command — backend headroom (the one watch-item)
```
npm run probe:accounts --prefix server
```
A green sweep still leaves headroom to eyeball. Prints the Claude subs' 5h/7d capacity, then the **full
failover ladder** — Codex / Grok / z.ai, each `available (5h x% · 7d y%)`, `CAPPED — frees in <countdown>`,
`NO ROOM — <window> at N%`, or `disabled` — and a **ladder depth** line. Nothing counts as a rung while
either window is ≥98%, sub or backend: a "5h 0%" sub with an exhausted weekly doesn't, and neither does a
backend that never got rejected (so has no cap latch) but is simply spent — that's `NO ROOM`, and reading the
latch alone once reported 3 rungs over a 1-rung reality. Caps are handled by failover (`probe:run-errors`
confirms it ran); depth ≤1 is the thing to act on, because a burst then parks on caps. One capped/spent alt
backend is normal — a latch self-expires, a spent window waits for its real reset. Gate: `test:failover-ladder`.

## Do / don't
- **Do NOT re-restart** if the resume note says the bounce already completed — only verify live `dist` + health.
- **Do NOT `git add -A`** when `health` lists dirty paths; those are usually a concurrent implementor's
  WIP (office claims win). Pathspec only your files.
- **Do not re-apply** a teammate's already-pushed fix — check `git log -5 --oneline` + office claims first.
- Run `test:gates` once at the end, not each gate separately.
- **Do not run `npm install --omit=dev` in this shared development checkout.** It removes the server's
  `tsc`/`tsx` tooling and makes the next build or gate run fail. Use `npm install --prefix server` to
  restore a partial install; after any dependency update, run both `npm run typecheck` and `npm run build`.

## If the sweep finds a real bug
Fix it in its own conventional commit, pathspec-stage, push (not vota). Deploy server changes yourself
via atomic hub restart **only when you changed server code and it's not already in the running dist** —
the health script's process-vs-dist section tells you.

## Related
- Office harvest gotchas: `.claude/rules/office-bridge.md`
- Shared-checkout deploy without peers: project memory `shared-checkout-concurrent-edits`
