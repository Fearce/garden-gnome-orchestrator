# Remote consolidation: retiring the `prismicious` fork (2026-08-27)

**Question asked:** *"Is this running on my fork or the real branch? It's very confusing, I think we
should remove the fork from github."*

**Short answer:** it was never running on the fork. The live orchestrator runs from a **third** checkout
nobody's notes mentioned, and that checkout's `master` is a strict ancestor of the real repo. The
confusion was real, but it came from three checkouts and three GitHub repos with overlapping names, not
from running fork code.

Everything below was verified on disk and against the GitHub API on 2026-08-27. Ancestry claims use
`git merge-base --is-ancestor` and `git rev-list --not <every fork ref>`, never a ref-name comparison:
the `port/*` branches tracked nothing, so `git status -sb` printed no ahead/behind for them at all.

---

## 0. What was actually there

### Three local checkouts

| Path | Role | `origin` before | `origin` now |
|---|---|---|---|
| `C:\Users\Mikkel\projects\garden-gnome-orchestrator` | **the live :4317 service** | prismicious fork | `Fearce/garden-gnome-orchestrator` |
| `C:\Users\Mikkel\projects\claude-orchestrator` | the 2026-07-26 re-baseline (agents work here) | prismicious fork | `Fearce/garden-gnome-orchestrator` |
| `C:\Users\Mikkel\projects\claude-orchastrator\claude-orchestrator` | the old misspelled superset | `prismicious/claude-orchestrator` (private) | unchanged |

The live service was identified from the listener itself, not from a guess:

```
PID 26324 on :4317
"C:\Program Files\nodejs\node.exe"
  --require C:\Users\Mikkel\projects\garden-gnome-orchestrator\server\node_modules\tsx\dist\preflight.cjs
  --import  file:///C:/Users/Mikkel/projects/garden-gnome-orchestrator/server/node_modules/tsx/dist/loader.mjs
  src/index.ts
```

That checkout sat on `master` @ `9929139`, which was **0 ahead / 25 behind** `Fearce/master` and a strict
ancestor of it. It read as "188 ahead" only because it was comparing against the fork's stale `master`
branch. So: real-repo code, 25 commits old, never fork code.

(Noted in passing, not changed here: it runs `tsx src/index.ts`, not `dist/index.js`.)

### Three GitHub repos

| Repo | What it is | Disposition |
|---|---|---|
| `Fearce/garden-gnome-orchestrator` | public, the real repo, the source of truth | **the only remote anything points at now** |
| `prismicious/garden-gnome-orchestrator` | public **fork** of the above, 12 branches | **to be deleted by Mikkel** (see §4) |
| `prismicious/claude-orchestrator` | private, **not a fork**, the old pre-scrub superset | **kept.** Not the fork Mikkel meant, and it is the only home of the legacy history |

`Fearce/claude-orchestrator` is not a separate repo: it 301-redirects to `garden-gnome-orchestrator`
(the repo was renamed), which is why the misspelled checkout's `upstream` still resolved.

---

## 1. What was unique, and where

### Commits that existed only on a local disk: three

| Commit | Date | Branch / checkout |
|---|---|---|
| `bbf3eab` | 2026-08-26 | `proto/nisse-workers` (re-baseline). *chore(proto): resolve Playwright from the global install first* |
| `94e296e` | 2026-08-26 | `proto/nisse-workers` (re-baseline). *feat(proto): rappelling nisse workers* |
| `0a15462` | 2026-06-18 | `local-testing` (legacy checkout). *feat(web): redesign gnome mascots* |

Nine of the ten branches in the re-baseline checkout had **zero** commits missing from the fork. The
legacy checkout's raw counts looked alarming (`master` alone showed 379 commits "not on the fork") purely
because its history was rewritten in the OSS secret-scrub, so every sha differs by construction. Checked
against the repo those branches actually belong to, `prismicious/claude-orchestrator`, eight of nine came
back at zero and only `0a15462` was genuinely local.

### Commits that existed only on the fork: three, on two branches

This is the half that mattered, and it is why this was a migrate-then-delete rather than a delete.

| Branch | Commits | Also on the private repo? | Any local branch? |
|---|---|---|---|
| `read-lane-autoclose` | `d578328` *feat(read-lane): auto-close a read task once its answer is delivered* | **no** | **no** |
| `crash-resilience` | `a0c4838`, `c3fb01c` (crash supervisor, context-rich crash logs, memory bounds) | yes | no |

`d578328` existed nowhere but the fork. Deleting the fork before this task would have destroyed it. In the
live checkout its object survived only as a remote-tracking ref, i.e. only for as long as the fork did.

`crash-resilience` is **not** subsumed by `port/crash-resilience`: `server/scripts/supervise.cjs`,
`server/src/crashLog.ts` and `server/src/tests/threadBookkeepingLeak.itest.ts` appear only on the original.

---

## 2. The migration

### 2.1 Archive first

`C:\Users\Mikkel\projects\claude-orchestrator\_fork-archive-2026-08-27\`

| File | Contents |
|---|---|
| `prismicious-fork-all-branches.bundle` (8.3 MB) | all 12 fork branches, complete history |
| `local-only-proto-nisse-workers.bundle` (36 MB) | `proto/nisse-workers` (528 commits) |
| `legacy-only-local-testing.bundle` (258 KB) | legacy `local-testing` (40 commits), carrier of `0a15462` |

Each bundle was **restored into a throwaway bare clone and diffed tip by tip**, not merely created.
That check earned its keep: the first attempt bundled `refs/remotes/origin/*`, so `git clone` from it came
back empty. It was rebuilt from a bare mirror and now restores all 12 branches bit-identically, `fsck`
clean, with `git bundle verify` reporting a complete history.

### 2.2 Pushed to the real repo

Ten branches, all as **new** refs (no forced update, no history rewritten, `master` untouched):

```
read-lane-autoclose            d578328    <- was fork-only. mandatory rescue
crash-resilience               a0c4838    <- had no local home
feat/token-freeze-auto-resume  4a3bdfb    <- 3 commits / 27 files / +2174 lines, absent upstream
port/crash-resilience          6cff8ee
port/director-wake             b5b8d6a
port/run-hub-projects          07326a4
port/self-update-restart       b3ae8e3
port/token-limit-pause         73f3f7e
port/token-metrics-dashboard   783ea5f
proto/nisse-workers            bbf3eab    <- was on no remote at all
```

`read-lane-autoclose` and `crash-resilience` also got local branches in the re-baseline checkout, so they
now exist in three places each.

### 2.3 Deliberately not pushed

`backup/master-pre-upstream-sync-2026-07-30` (11 commits, 6 files) is a pure pre-sync docs snapshot. Every
file it touches (`PORT-INVENTORY.md`, `MIGRATION-READINESS.md`, `MERGE-REVIEW.md`,
`.claude/rules/watchdog-triage.md`, `.gitignore`, `scheduler.test.ts`) already exists on `Fearce/master` in
a newer state. It is kept as a local branch in the re-baseline checkout and in the bundle rather than
added to the real repo. `local-work/master-2026-07-30` and the fork's `master` are strict ancestors of
`Fearce/master` and needed nothing.

### 2.4 Proof of preservation

After the push, for every one of the 12 fork branches:

```
git rev-list origin/<branch> --not <every ref on Fearce/garden-gnome-orchestrator>
```

returns **0** for 11 of 12. The twelfth is the backup branch above, at 10, held by a local branch plus a
restore-verified bundle. Server-side confirmation via `gh api repos/Fearce/garden-gnome-orchestrator/branches`
shows all ten pushed tips matching their fork shas exactly.

---

## 3. The rewiring

Every checkout now has **one** remote and truthful tracking.

```
re-baseline    origin  git@github.com:Fearce/garden-gnome-orchestrator.git      (upstream, legacy: removed)
live service   origin  git@github.com:Fearce/garden-gnome-orchestrator.git      (upstream: removed)
legacy dir     origin  git@github.com:prismicious/claude-orchestrator.git       (kept: the pre-scrub history)
               upstream git@github.com:Fearce/garden-gnome-orchestrator.git     (URL refreshed off the old name)
```

`legacy` was dropped from the re-baseline checkout because that path-remote existed only to support the
2026-07-26 port, which is finished. Re-add it in one command if an archaeology question comes up:

```
git remote add legacy C:/Users/Mikkel/projects/claude-orchastrator/claude-orchestrator
```

All eleven re-baseline branches and the live checkout's `master` were given tracking against `origin`, so
`git status -sb` now reports real numbers instead of silence: the live checkout reads **behind 25** and the
re-baseline `master` reads **behind 54**, both of which are true and were previously invisible.

Changing a git remote is config only. The running service was not restarted and its working tree was not
touched. The doc commit in this change was made in a detached `git worktree`, so the shared checkout's
`HEAD` and working tree were never moved either.

---

## 4. The one step left for Mikkel

The fork is still there. `gh` is authenticated as `prismicious`, which **can** admin its own fork, but the
token has no `delete_repo` scope. Verified by attempting it rather than inferring it:

```
$ gh repo delete prismicious/garden-gnome-orchestrator --yes
HTTP 403: Must have admin rights to Repository.
This API operation needs the "delete_repo" scope.
```

Either route works:

```
gh auth refresh -h github.com -s delete_repo && gh repo delete prismicious/garden-gnome-orchestrator --yes
```

or the click-path: <https://github.com/prismicious/garden-gnome-orchestrator/settings>, scroll to the
Danger Zone, **Delete this repository**.

### What deleting it costs, in full

- **No code.** Every commit is on `Fearce/garden-gnome-orchestrator`, except the backup branch's ten,
  which are on a local branch and in a restore-verified bundle.
- **No tags, releases, issues, wiki, stars, or forks-of-the-fork.** All confirmed empty.
- **Two closed pull requests lose their diffs.** `Fearce/garden-gnome-orchestrator` PRs **#11**
  (crash-resilience) and **#12** (read-lane-autoclose) have their head on the fork. The PR conversations
  survive; the rendered diff and commit list become unavailable once the head repo is gone. Both were
  closed unmerged, and both branches now exist on the real repo by the same names, so no code is at risk.
  This is the only irreversible loss, and it is why the deletion was left as a decision rather than forced.
- **PR #13 is unaffected.** Its head is `Merkelmore/garden-gnome-orchestrator`, a third party's fork.

---

## 5. After the deletion, nothing points at a dead remote

- No checkout references the fork any more (§3).
- `PORT-INVENTORY.md` §1 and `MIGRATION-READINESS.md` §1.3 carry dated superseding notes; their bodies are
  left intact as the audit trail of the cutover.
- `.claude/rules/online-office.md` no longer claims this checkout carries a `mikkel` remote, and
  `.claude/rules/merge-an-incoming-pr.md` now uses `Merkelmore` as its live fork-PR example.
- The remaining `prismicious/garden-gnome-orchestrator` strings in `relay/src/core.test.ts` and
  `server/src/tests/onlineOffice.itest.ts` are **synthetic test fixtures**. Those tests build their own
  temp repos and never contact GitHub, so they keep passing and were deliberately left alone.
