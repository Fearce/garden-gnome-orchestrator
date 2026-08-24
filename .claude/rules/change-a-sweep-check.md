---
paths:
  - server/scripts/**
---

# Changing a check inside a sweep script (`probe:*` / `audit:*` / `health`)

The eight nightly steps ARE these scripts — `nightly-quality-sweep.md` is the procedure to RUN
them, this is how to safely CHANGE one. Half the sweeps in the last ten days ended in a diff to
one of them, so this is the recurring shape, not a one-off.

## The predicate you change has to end up gated

A gate can only `require` a module that doesn't run on import. `audit-deps.cjs`,
`audit-overrides.cjs`, `crashlog-scan.cjs` and `recovery-features.cjs` already do
(`if (require.main === module) main();` + `module.exports`) and each has a `<x>.test.cjs`
beside it. **`audit-secrets.cjs` does NOT** — it runs top-to-bottom and `process.exit()`s.
Don't restructure it for a one-line fix: lift just the predicate into its own
`scripts/<x>.cjs` + `scripts/<x>.test.cjs` (the 2026-08-12 email fix did this →
`email-hygiene.cjs`). **Never hand-copy the predicate into the test** — a mirrored classifier
drifts, which is exactly what `probe:run-errors`'s `cap classifier agreement` section exists
to catch. **That includes copying only how the predicate is COMPOSED**: `compiled-diff.test.cjs`
first built the git pathspec itself from the module's exported parts, so deleting an exclusion
from the module left all 18 assertions green — the test was still excluding it. Call the exported
FUNCTION and inject what it needs (a `cwd`, a clock), never re-assemble its inputs.

Register BOTH halves or the sweep never runs it: the `test:*` script in `server/package.json`
AND the name in `GATES` in `scripts/run-gates.cjs`. `test:gate-registration` fails on either.

## Loosening a detector is the dangerous direction

Every check here answers "is something wrong?", so a false NEGATIVE is silent forever while a
false positive only annoys. Both halves of the 08-12 fix were exclusions that reached too far:

- dropping the whole grep ROW hid a real address sharing that line with an SSH remote;
- `\b(?:git|hg|svn)@host` hid a real mailbox whose local part IS `git` — and, because `\b`
  matches after a dot, one that merely ENDS in it (`foo.git@…`). Requiring the `[:/]` path
  separator is what makes the pattern mean "a remote URL" (`cd675bd`).

Write the "still reports X" assertion in the same commit as the "now ignores Y" one.

## Verify it the way the script actually runs

- **`git grep` / `git log` only see TRACKED files.** A new gate file full of sample secrets
  scans clean until you `git add` it — check an exclusion AFTER staging or you've proved nothing.
- **Scope an exclusion to the scan that needs it.** `audit-secrets` excludes ITSELF from every
  scan (it holds the token patterns), but its email gate's fixture addresses only trip the email
  grep — so that file is excluded there alone (`EMAIL_EXCLUDES`), and the hard-fail secret-value
  and token-shape scans still cover it.
- **Prove the exclusion is load-bearing:** run the scan with and without it, diff the hit count.
- **Revert-check both ways** (as in `threadmanager-itest.md`): the gate must go RED without the
  fix AND against the naive version of the fix. Then restore and diff to confirm byte-identical.

A fix here is **scripts-only — no deploy**: nothing under `scripts/` is compiled into `dist`, so
health will still report `dist` matching HEAD. Keep any new `probe:*` query read-only; they run
against prod's live SQLite.
