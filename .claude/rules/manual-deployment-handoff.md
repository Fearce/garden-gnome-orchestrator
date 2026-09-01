# The manual-deployment handoff (settling `done` when only the owner's deploy is left)

Read before touching `orchestrator/manualDeployment.ts`, the `manualDeployment*` methods on
ThreadManager, `handoff_manual_deployment`, or `db.finishManualDeployment`. CLAUDE.md has the shape;
this is what bites. Related: `qa-fixes-mode.md` (the QA gate that can also verify one),
`add-a-role-or-thread-state.md` (states), `office-bridge.md` (the CLI marker).

A task in a configured commit-only repo (`NO_PUSH_REPO_PATTERN`) whose ONLY remaining step is the
owner's own deployment settles **`done`**, not `review`. Parking it there was the bug: nothing else
could finish it, so Supervisor and auto-review re-claimed it nightly and burned tokens forever.

## The claim is evidence, never authority
- `parseManualDeploymentClaim` accepts **no legacy aliases and defaults no assertion**. Every safety
  boolean must be literally present and correct (`postDeployVerificationRequired` must be `false`).
  Incomplete evidence is deliberately ambiguous — do not "helpfully" default one.
- The server then re-proves it: `inspectManualDeploymentRepository` (Git) + `manualDeploymentBlockers`
  (orchestration: open owner questions, unresolved injections, QA/reviewer handoffs, shotgun
  integration, pending approvals, queued owner instructions, deadline parks, other live runs). An
  agent's declaration **cannot waive** either half. Keep it that way — the whole feature is only safe
  because the asserting agent is not the one deciding.
- Local commits **AHEAD** of the declared ref are valid (the commit-only case); diverged is not.

## Rules that bit — do not re-break
- **Resolve the checkout by the CLAIMED COMMIT, never the directory name.** A task workspace is
  routinely the PARENT of the repo (workspace `…\project`, repo `…\project\service`). Running git
  on the parent rejected valid handoffs until `repoCandidates` scanned nested checkouts and picked the
  one owning the commit (QA round 1, `87b9700`).
- **A manual-deployment settle is NOT a reviewer acceptance.** `finishManualDeployment` consumes a
  non-accepted `auto_review_episodes` row as terminal **`parked`** with `verdict_json`/`verdict_run_id`
  CLEARED. Writing `status='accepted'` there fabricates a reviewer verdict that never happened, and the
  auto-review lane then trusts it (QA round 2, `5d1356f`). See project memory on `auto_review_episodes`.
- **Any new work invalidates the marker.** `invalidateManualDeploymentForNewWork` fires on an
  implementor turn starting/resuming, QA changing the implementation, new owner instructions, a resume
  with instructions, and a reviewer losing its fence. Add a path that mutates the tree ⇒ add the call,
  or a stale claim settles work that moved underneath it.
- **Reviewer acceptance passes `settle:false`** — its existing compare-and-swap owns the state change.
  Two settles race and double-post the owner note.
- **Boot reconciliation only recognises structured evidence** (the marker, an accepted structured
  reviewer verdict, or a successful no-QA run owning the declaration). Prose-only review parks are
  counted **ambiguous and left untouched** on purpose. Do not widen this to text matching: a repair pass
  that guesses marks unverified work `done`.
- **The owner-visible note is the feature, not decoration.** `ensureManualDeploymentHandoff` posts both
  a finding and a feed line, de-duplicated by exact text. Without it a settled task is indistinguishable
  from a silently skipped deployment — which is what the owner asked never to see.

## The queue it created
Settling `done` moved this work out of `review`, so `probe:parks` no longer lists it and **nothing did**
until `probe:manual-deployment`. Run it to answer "what is finished but waiting on me to deploy?":

```
npm run probe:manual-deployment --prefix server        # add --fetch to refresh tracking refs first
```
It splits waiting / pushed / unverified / refused-with-reason, and exits non-zero ONLY on two real
defects: a `verified` marker that never reached `done`, and a settled task missing its owner note. A
long queue is the owner's call, never a failure. Gate: `test:manual-deployment-probe`.

## Verify
`npm run test:manual-deployment --prefix server` (parser, Git qualification, boundaries, restart repair,
API/UI) plus `test:manual-deployment-probe`, then `npm run typecheck`. Scripts are not compiled into
`dist`, so a probe-only change needs **no deploy**; a change under `server/src` does.
