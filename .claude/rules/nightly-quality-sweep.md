# Nightly / quality sweep + resume-after-bounce

When the brief is a health/quality sweep ("nightly check", "make sure
everything is smooth") or you are auto-resumed after an orchestrator
restart that already completed:

## First command (one shot)
```
npm run health --prefix server
```
(`server/scripts/nightly-health.cjs`) — hits `/api/health`, checks `:4317`
vs `dist` mtime, greps live reliability symbols, lists dirty git paths,
and summarizes SQLite parks/caps/stuck runs. Exit 1 = hard fail; dirty
tree alone does **not** fail.

## Do / don't
- **Do NOT re-restart** if the resume note says the bounce already
  completed — only verify live `dist` + health.
- **Do NOT `git add -A`** when `health` lists dirty paths; those are
  usually a concurrent implementor's WIP (office claims win). Pathspec
  only your files.
- **Do not re-apply** a teammate's already-pushed fix. Check
  `git log -5 --oneline` + office claims before editing the same files.
- Prefer unit gates already wired: `npm run test:office-bridge`,
  `test:grok-runner`, `test:weekly-safety`, `typecheck` (batch at end).

## If the sweep finds a real bug
Fix it in its own conventional commit, pathspec-stage, push (not vota).
Deploy server changes yourself via atomic hub restart **only when you
changed server code and it is not already in the running dist** — the
health script's process-vs-dist section tells you.

## Related
- Office harvest gotchas: `.claude/rules/office-bridge.md`
- Shared-checkout deploy without peers: project memory
  `shared-checkout-concurrent-edits`
