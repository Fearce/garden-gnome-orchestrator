# Watchdog tasks — triage BEFORE you work

When the brief is "check on earlier work" (overnight watchdog, "make sure that
finished", auto-resume after a run died to a token/rate-limit cap), your first job
is **not to work**. It is to pick one of three verdicts and, in two of them, stop.

```bash
bash ~/Claude/tools/watchdog-triage.sh -a MIGRATION-READINESS.md -s 4000 -k Verdict -k 'Build health'
```
Exit **0 HEALTHY** (stop) · **2 IN-PROGRESS** (stand down) · **1 STRANDED** (recover) · **3 can't tell** (ask).
Read-only, safe while another agent owns the tree. Then confirm peers with `office_look`.

## Why both wrong answers are expensive
They look identical from inside the agent — "the brief said recover, so I recovered."
- Re-doing **finished** work burns a night of quota and dirties a clean tree.
- Treating a **live** agent as dead clobbers a teammate mid-edit (this checkout is shared —
  see `office-coordination.md` and project memory `shared-working-tree-collisions`).

## The two traps the script encodes
- **A clean tree alone is not healthy.** It is equally consistent with "nothing was ever done."
  Require: artifact exists **and** is substantive **and** is committed. "Committed but edited
  since" means work in flight, not finished work.
- **Size is not substance.** A 5 KB report with no verdict section is still a stub — gate on
  required headings (`-k`), not byte count. For a `.md` artifact `-k` is heading-anchored: the
  keyword must sit on a `#`/`##`/`###` line, so a table of contents that merely *lists* "Verdict",
  or a body that says "could not determine a Verdict", does not pass. `-K` is the loose
  anywhere-in-file match, for non-markdown artifacts or a value rather than a section.

## If the verdict is STRANDED
Recover per the brief, then honor the usual constraints: never `git add -A` (a dirty tree on a
shared checkout is usually a peer's WIP — pathspec only your files), never force-push, never
`--no-verify`, never auto-resolve a merge conflict. For a re-baselined repo whose only remotes
are `upstream` (fetch-only, not ours) and `legacy`, commit **locally** and push nowhere.

Related: `nightly-quality-sweep.md` (the health sweep once you HAVE decided to work),
`office-coordination.md`, global memory `watchdog-triage-before-work`.
