# Merging an incoming PR (this repo is public — contributions arrive as fork PRs)

The repo went public 2026-07-22, so "merge these PRs in" is a recurring ask. PRs come
from FORKS (e.g. Mikkel's `prismicious`), and the fork's history was rewritten during
the OSS secret-scrub, so a fork PR **shares no common ancestry** with `master`. That
breaks the naive merge — do it the cherry-pick way.

## The flow that works
1. `gh pr list --state open --json number,title,headRefName,mergeable,isDraft` — triage.
   Read each PR body with `gh pr view <n> --json title,body,files,commits`.
2. Fetch the heads locally: `git fetch origin pull/<n>/head:pr-<n>`. Inspect the real
   diff against CURRENT master (`git diff master...pr-<n>`), not the PR's stale base —
   the PR was authored against an OLDER master, so verify every symbol it references
   still exists (`grep` the touched file). GitHub's `mergeable` flag lies about drift.
3. **Cherry-pick onto master**, never `gh pr merge`: `git cherry-pick <sha>...`. This
   preserves the contributor's authorship AND keeps master linear (Kevin's git hygiene).
   Resolve conflicts (usually additive `package.json`/registry blocks — keep both sides).
4. Verify BEFORE pushing: `npm run typecheck && npm run build`, `npm run test:gates`
   (`server/`), plus any test the PR touched. A fork PR authored against an old base can
   typecheck-pass yet be logically half-wired into current master — read the merged
   result, don't trust the PR's own green.
5. Run the `code-reviewer` subagent on `git diff <old-master>..HEAD` for INTEGRATION
   correctness (dead code the PR wired against a since-changed path, double-settles,
   missed cleanup). Fix real gaps found in their own commits — don't flag-and-wait.
6. Push `master` (origin is `garden-gnome`, NOT vota → push). Then **deploy yourself**
   (server change ⇒ atomic hub restart — CLAUDE.md § "Deploying a change"); verify the
   new PID started after the dist mtime.

## Gotchas that bit
- **Cherry-pick = new SHA**, so GitHub will NOT auto-close the PR, and you can't push to
  the contributor's fork branch. Close it manually: `gh pr comment <n> --body-file <f>`
  with a provenance note (which commit SHA it landed as, what you verified, any follow-up)
  then `gh pr close <n>`. Write the comment to a FILE and `--body-file` it — never inline a
  multi-line `--body` in PowerShell (shell-mangles quotes/backticks).
- **A PR that adds a test script must be wired into the gate suite.** New FREE (no-agent,
  no-quota) `test:*` scripts go into `GATES` in `server/scripts/run-gates.cjs`, or the
  nightly sweep never runs them (see `nightly-quality-sweep.md`). PRs routinely add the
  script and forget the registration.
- **Before assuming a `serve`/`package.json` script change affects prod:** it doesn't.
  Windows prod launches `node dist\index.js` under script-hub keepAlive (registry id
  `claude-orchestrator`), NOT `npm run serve`. The `serve` path is dev-only.

## Verdict framing
Misrouting a real contribution to a sloppy merge is worse than spending the tool calls.
Read the code, verify integration, harden what the reviewer flags — then merge and deploy.
