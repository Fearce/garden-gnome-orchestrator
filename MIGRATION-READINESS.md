# MIGRATION-READINESS — cutover to `claude-orchestrator` (correctly spelled repo)

**Report date:** 2026-07-25 (evening, unattended run)
**Target cutover:** 2026-07-26 — all orchestrator work moves from the legacy misspelled
`C:\Users\Mikkel\projects\claude-orchastrator` to **this** repo, `C:\Users\Mikkel\projects\claude-orchestrator`.
**Verified against:** `master` @ `5493dc1` (pinned throughout this audit), `upstream/master` @ `6848cc4`,
`legacy/master` @ `6148bb6`.

> **Snapshot caveat — read this first.** A second agent was cutting `port/*` review branches in this repo
> while this report was written; the branch list in §3.2 was refreshed at the end and reflects all six
> branches as of hand-off, but that agent was still working. Everything about `master`, `upstream`,
> `legacy` and the build is exact and re-checkable. Re-run the one-liners in §7 before acting on §3.

> **2026-08-27: §1.3's push-safety ACTION REQUIRED is CLOSED, and the remote names below are stale.**
> `prismicious` has write access to `Fearce/garden-gnome-orchestrator` (verified: `gh-capability.sh` grades
> WRITE, `admin=false push=true`), so the writable-origin question this report left open is answered. The
> `legacy` and `upstream` remotes are gone; every checkout now has one remote, `origin` → the real repo.
> The rest of the audit stands as the dated record of the 2026-07-26 cutover. Full evidence:
> `docs/remote-consolidation-2026-08-27.md`.

---

## 0. Verdict — **CONDITIONAL GO**

**Go**, with eyes open. The repo is structurally sound and the toolchain is green end to end, but the
cutover is a **move of the working location, not a move of the working feature set**. Today this repo is
upstream + one docs commit; every fork feature is still pending, staged on unmerged branches or not yet
started.

| Dimension | Verdict |
|---|---|
| Git hygiene / baseline correctness | ✅ **GO** — clean baseline, at current upstream HEAD, no drift |
| Build & test health | ✅ **GO** — install → typecheck → build → 18/18 gates, all exit 0 |
| Costs/Projects settings gating | ⚠️ **CLAIM DOES NOT HOLD FOR THIS REPO** — see §2 |
| Port completeness | ⚠️ **NO-GO for "feature parity"** — **0 of 5** PORT areas on `master`; all 5 staged on unmerged `port/*` branches; see §3 |
| Feature branches ship gated? | ✅ **RESOLVED 2026-07-25** — both branches now gate their surface, default OFF, verified in a browser; see §3.4 |
| Push safety (`upstream` is writable) | ⚠️ **ACTION REQUIRED** — see §1.3 |

**What this means practically:** you can move *into* this repo tomorrow and it will build, run and pass its
gates. You cannot yet expect the Costs dashboard, the Projects/Run Hub layer, director wake, or the
director-wedge watchdog to be there — all five are staged on review branches but none has merged. Land the
port branches first, or accept a temporarily thinner console.

**The one thing not to miss — now fixed.** As first written, this report's headline was that the two staged
feature branches shipped Costs and Projects **without** the settings gates, so merging them would have put
both surfaces on by default (§3.4). That has since been closed: each branch carries the half of `8164ea2`
that gates the surface it actually ships, both default OFF, both verified in a real browser. §3.4 records
the commits and the evidence. It is left in the report rather than deleted because the *class* of gap —
a design decision that lives in a commit the port list never saw — is the thing to keep watching for.

---

## 1. Git state

### 1.1 Remotes — as described, with one exception

```
legacy    C:/Users/Mikkel/projects/claude-orchastrator/claude-orchestrator   (fetch + push)
upstream  https://github.com/Fearce/garden-gnome-orchestrator                (fetch + push)
```

- `legacy` is present and fetches fine (it moved during this audit — see §1.4).
- `upstream` is present and points at the right URL.
- **There is no writable `origin`.** Confirmed — that decision is still open and is Mikkel's to make (§6.1).
- ⚠️ **`upstream` is NOT fetch-only.** Its push URL is unset, which means it *inherits the fetch URL* —
  `git push` to `upstream` is a live, configured operation, not a blocked one. See §1.3.

### 1.2 Baseline is at current upstream HEAD — no drift

| Check | Result |
|---|---|
| `master` HEAD | `5493dc1` — *docs: add PORT-INVENTORY…* |
| `upstream/master` HEAD | `6848cc4` (2026-07-24 15:44) |
| `git log master..upstream/master` | **empty** — we are behind by nothing |
| `git log upstream/master..master` | exactly one commit: `5493dc1`, the PORT-INVENTORY doc |
| Merge-base `upstream/master`↔`legacy/master` | `cdf37e9` — unchanged since the inventory was written |

**Has upstream moved since 2026-07-24?** **No.** `upstream/master` is still `6848cc4`, the same commit
PORT-INVENTORY recorded. A fresh `git fetch upstream --prune` produced no new refs. **The delta is zero, so
it cannot matter.** Re-baselining bought exactly the 5 commits §3 of PORT-INVENTORY lists, and nothing has
landed upstream since to complicate the picture.

### 1.3 ⚠️ Push safety — the one git change worth making before the move

`branch.master.remote = upstream` and `push.default` is unset (→ `simple`). Together that means **a bare
`git push` while on `master` targets `upstream/master`** — the repo we explicitly do not own. Nothing but
GitHub's own permission check stands between a reflexive `git push` and a push at Fearce's repo.

Recommended one-liner (not applied by this task — see §5, git state was owned by another agent tonight):

```bash
git remote set-url --push upstream no-push://blocked   # fetch still works; push fails instantly, locally
```

This is cheap, reversible, and removes the single sharpest footgun in the new repo. Do it before the first
day of real work in here.

### 1.4 Working tree, branches, in-progress state

At the time of writing the tree was **not** clean and **not** on `master` — a concurrent agent was
mid-`cherry-pick` on `port/director-wake`, with `.git/CHERRY_PICK_HEAD` present and 6 files in `UU`
(unmerged) state. **That is expected, coordinated, in-progress work — not corruption.** By agreement, this
audit read everything through `git show master:<path>` so it was immune to those branch switches, and
`master` stayed pinned at `5493dc1` the whole time.

**Before the cutover, confirm this has settled:**

```bash
git status --short --branch          # expect: on master, clean
ls .git/CHERRY_PICK_HEAD .git/MERGE_HEAD  # expect: no such file
git worktree list                    # expect: only the main checkout
```

Other observations:
- `legacy/master` advanced from `12a7644` → `6148bb6` during the audit (2 new commits — both relevant,
  see §2 and §4).
- Untracked `package-lock.json` at the repo root: `server/package-lock.json` and `web/package-lock.json`
  are tracked, but the **root** lockfile is neither tracked nor ignored, so it shows up as permanent
  untracked noise (root `npm install` for `concurrently` is a documented step, so it keeps coming back).
  It should **not** be tracked — that would diverge from upstream's layout and conflict the next time we
  upstream a PR. **Resolved during this session:** the agent doing the port staging is deleting it and
  adding `/package-lock.json` to `.gitignore`. Verify that landed (`git check-ignore -v package-lock.json`).

---

## 2. Settings gating — the claim, and what is actually true

**Claim under test:** *"costs and projects have already been gated behind settings" in this repo.*

**Verdict: the gating is real and well-built — but it is in the LEGACY fork, not in this repo.**
In this repo the statement is not merely unverified, it is **not applicable**: the Costs and Projects
features **do not exist here at all**, so there is nothing to gate.

Evidence on the pinned `master` tree:

```bash
git ls-tree -r --name-only master | grep -Ei 'cost|metric|project|runhub|tokendash|launch'   # → no output
git grep -n -Ei 'costsEnabled|projectsEnabled' master -- server/src web/src                  # → no output
```

Zero files, zero symbols. `TokenDashboard.tsx`, `liveMetrics.ts`, `Projects.tsx`, `runHub/` — none present.

### 2.1 Where the gates actually live (`legacy/master`, commit `8164ea2`)

Introduced 2026-07-24 23:15 by **`8164ea2` — *feat(settings): gate the Projects and Costs surfaces behind
toggles***, with the companion doc `6148bb6 docs(rules): document gating a whole nav surface behind a
setting`. Both are on `legacy/master` HEAD, not a side branch. **Both post-date PORT-INVENTORY**, which is
why the inventory does not mention them.

| Layer | `projectsEnabled` | `costsEnabled` |
|---|---|---|
| Type (server) | `server/src/types.ts:556` | `server/src/types.ts:557` |
| Type (web) | `web/src/types.ts:393` | `web/src/types.ts:394` |
| Default (server read) | `threadManager.ts:1117` → `settingBool("setting_projects_enabled", **false**)` | `threadManager.ts:1118` → `settingBool("setting_costs_enabled", **false**)` |
| Persist (server write) | `threadManager.ts:1424` → `kvSet("setting_projects_enabled", …)` | `threadManager.ts:1425` → `kvSet("setting_costs_enabled", …)` |
| WS validation (zod) | `server/src/ws/protocol.ts:227` | `server/src/ws/protocol.ts:228` |
| Default (web store) | `web/src/store.ts:403` → `false` | `web/src/store.ts:404` → `false` |
| Settings UI toggle | `web/src/components/SettingsPanel.tsx:220-221` | `SettingsPanel.tsx:226-227` |
| Nav button conditional | `web/src/App.tsx:53` | `web/src/App.tsx:54` |
| Content pane conditional | `web/src/App.tsx:78` | `web/src/App.tsx:78` |

The source comment states the intent exactly (`types.ts:555`):
*"Fork-only surfaces, gated behind a toggle so the base console matches upstream (both default OFF)."*

**Both default OFF**, verified at both the server default and the web store default — the two places that
matter for a fresh install.

### 2.2 The gates are **UI-only** — an honest caveat, not a bug

Both toggles suppress the **nav button and the pane**. They do **not** gate the server side:

- `server/src/index.ts:163` calls `startTokenMetricsBroadcast(hub, db)` **unconditionally** — the metrics
  tick and its SQL aggregation run whether or not Costs is on, and the `token.metrics` WS frame is seeded
  on every connect.
- `server/src/index.ts:577` / `:583` register `GET /api/runhub/projects` and `POST /api/runhub/launch`
  **unconditionally** (auth-gated, but not `projectsEnabled`-gated), and `buildHello` always ships
  `projectMeta`.

If the intent was "the base console matches upstream", that is achieved *visually*. If the intent was
"none of this code runs unless I turn it on", it is not — the collection, the broadcast timer and the REST
surface are always live. **Decide which you meant** (§6.5). For a LAN-only, auth-gated, single-operator
service the UI-only gate is defensible; it is simply worth knowing it is what you have.

**No test covers either toggle.** No file in `legacy/master` references `projectsEnabled`/`costsEnabled`
in a test. `liveMetrics.itest.ts`, `metricsTokenReport.itest.ts` and `runHub.itest.ts` exercise the
underlying features, never the gate.

### 2.3 What must travel with the port

Porting §4.1/§4.2 **without** `8164ea2` silently ships both surfaces **default-ON**. Seven files carry the
gate and must arrive together — missing any one leaves a toggle that does nothing at some layer:

`server/src/types.ts` · `server/src/orchestrator/threadManager.ts` (both the `settingBool` reads and the
`kvSet` writes) · `server/src/ws/protocol.ts` · `web/src/types.ts` · `web/src/store.ts` ·
`web/src/components/SettingsPanel.tsx` · `web/src/App.tsx`.

### 2.4 "Confirm the gates work (typecheck/tests/build pass with them in place)"

**Not possible in this repo, and the reason is the finding itself:** the gating code is not here, so there
is nothing to typecheck. What *is* verifiable is that this repo's build is green **without** it (§4), and
that the gate's shape follows the repo's own documented `add-a-setting.md` pattern at every layer. The real
gate verification has to happen **after** §4.1/§4.2 + `8164ea2` are merged here — add it to the port's
definition of done (§6.5).

---

## 3. Port completeness — PORTED / PENDING / DROPPED

Audited against PORT-INVENTORY.md §4 and §6.

### 3.1 PORTED — landed on `master`

**Nothing from the PORT list has landed on `master`.** `master` is upstream HEAD plus one docs commit. What
is present is present because it *is* upstream:

| Item | Evidence |
|---|---|
| Office coordination peer-gating (`0dc9ae9`) — the "KEEP UPSTREAM, drop fork's version" row | On `master`; `server/src/tests/officeGating.itest.ts` present, `test:office-gating` in the gate list |
| Upstream mobile fixes (`6848cc4`, `3cc7ca6`) | On `master` |
| Upstream docs/build notes (`b7a1229`, `c48ac56`) | On `master` |
| `.claude/rules/office-coordination.md` | On `master` |
| Crash supervisor + crash logging (§4.3, the already-upstream half) | `server/scripts/supervise.cjs`, `supervise.itest.cjs`, `server/src/crashLog.ts`, `crashLog.itest.ts` |
| Cap-park + auto-resume (the §4.5 *behavior*) | `threadManager.ts:242` `CAP_PARK_PREFIX`, `:479` `resumeCapParked()`, `:467` cap supervisor interval, `tokenFreezeResume.itest.ts` |
| Restart-resume on boot | `threadManager.ts:692` `markInterrupted()`, `:255` `RESTART_ERROR_PREFIX` |
| Codex runner no-output watchdog | `server/src/agents/codexRunner.ts` |

### 3.2 PENDING — not on `master`

Two of the five PORT areas are **staged on unmerged local branches** (a teammate's in-flight work,
snapshot as of writing). Staged ≠ landed.

| # | Area | Status | Where | Blocker? |
|---|---|---|---|---|
| §4.4 | Director wake-on-completion | **STAGED** — `port/director-wake` @ `ce5b034`, 2 commits (`00f1ec4`, `ce5b034`); adds `directorWake.ts`, `directorWake.itest.ts`, the `test:director-wake` gate, the SettingsPanel toggle | branch, unmerged | No — quality-of-life |
| §4.3 | Crash-resilience remainder: **director-wedge recovery** (`a3e9e93`), **Claude-runner watchdog**, `verify-instance.cjs`, `why-ended.cjs`, `update-doctor.cjs`, `check-orphaned-tests.cjs`, `restartResumeRecovery.itest.ts`, `runnerWatchdog.itest.ts` | **STAGED** — `port/crash-resilience` @ `6cff8ee`, 9 commits (includes `225823e` recover restart-interrupted tasks stuck in 'failed') | branch, unmerged | **Yes — highest-value gap** |
| §4.6 | Self-update / one-click restart button + "changes ready" prompt | **STAGED, IN PROGRESS** — `port/self-update-restart` @ `9a77d8e`, 1 commit, still being cherry-picked at time of writing | branch, unmerged | No |
| §4.1 | Live token-cost dashboard + metrics (`liveMetrics.ts`, `metricsBroadcast.ts`, `tokenReport.ts`, `TokenDashboard.tsx`) + `agent_runs` token columns + new `director_runs` table | **STAGED** — `port/token-metrics-dashboard` @ `783ea5f`, 6 commits | branch, unmerged | No — observability. Now gated (`783ea5f`, default OFF) — §3.4 |
| §4.2 | Run Hub + Projects layer (`runHub/launcher.ts`, `projects.ts`, `recipe.ts`, `Projects.tsx`, `LaunchButton.tsx`) + `project_meta` table | **STAGED** — `port/run-hub-projects` @ `f9e3724`, 10 commits (incl. a `styles.css` rebuild onto the upstream base — the worst §5 conflict file) | branch, unmerged | No — productivity layer. Now gated (`56980aa`, default OFF); dead recipe removed (`f9e3724`) — §3.4 |
| §4.1/§4.2 | **The `costsEnabled`/`projectsEnabled` gates (`8164ea2`)** | ✅ **STAGED — split across both feature branches** (`783ea5f` / `56980aa`), default OFF, browser-verified | on the branches | **No longer — resolved, see §3.4** |
| §4.5 | Token-limit pause + its tests | **STAGED** — `port/token-limit-pause` @ `73f3f7e`, 3 commits | branch, unmerged | No — the behavior is already upstream (§3.1); this adds the fork's pause UI + tests |
| §4.6 | Supporting core wiring — the 9 conflict files (§5 of the inventory) | **REWORK, untouched** | needs 3-way merge | Coupled to §4.1/§4.2 |
| §4.7 | Fork rule docs paired with ported features (`add-a-live-pane.md`, `ab-token-measurement.md`, `run-hub-recipe.md`) | **NOT STARTED** (the wake rule rides on `port/director-wake`) | `legacy/master` | No |

**Why §4.3 is the one real blocker.** The fork's `director.ts` has a liveness watchdog that force-ends and
recovers a wedged director session (8 `wedge` sites at `:18`, `:244`, `:355`, `:461-468`); this repo's
`director.ts` has **zero**. The fork's `runner.ts` has 27 watchdog references; this repo's has **zero**. A
wedged director or a silent hung `claude` subprocess is precisely the failure this repo cannot currently
self-heal from — it hangs until someone notices and restarts. That is a daily-driver risk, not a nicety.
It is fully staged on `port/crash-resilience`; it just needs review and merge.

**Correction to a natural assumption:** §4.5 is **not** a blocker. The cap-park/auto-resume *behavior* is
already upstream and on `master` (see §3.1). Only the fork's extra test and the pause chips are missing.

### 3.3 DROPPED — confirmed absent (intentional, correct)

| Item | Confirmation |
|---|---|
| `infra/caddy/*` (§4.8) | No `infra/` on `master` |
| `infra/bet-tracker/*` (§4.8) | No `infra/` on `master` |
| `design/explorations/**` (§4.9) | No `design/` on `master` |
| Upstream auto-sync tooling (§4.7) | No `docs/upstream-sync.md`, no auto-sync code on `master` |
| Fork process docs (`HANDOFF.md`, `DEV.md`, `DEV-ISOLATION.md`, `UPSTREAM-MIGRATION-HANDOFF.md`, `TOKEN_*.md`) | Absent from `master` |
| Fork's own office edits (superseded by upstream `0dc9ae9`) | Upstream version is what's on `master` — as intended |

### 3.4 ✅ RESOLVED — the staged feature branches shipped Costs and Projects **ungated**

> **Status: closed 2026-07-25, before the cutover.** Both branches now carry the gate and both were driven
> in a headless browser to prove it. The original finding is kept below unedited; the resolution follows it.

Found while re-checking the branch list at the end of this audit, and it was the single most actionable item
in this report. **Neither feature branch carried the gate:**

```bash
git grep -c -E 'costsEnabled|projectsEnabled' port/token-metrics-dashboard -- server/src web/src  # → nothing
git grep -c -E 'costsEnabled|projectsEnabled' port/run-hub-projects       -- server/src web/src  # → nothing
```

And the nav wiring on those branches is unconditional:

| Branch | `web/src/App.tsx` | vs. legacy's gated version |
|---|---|---|
| `port/token-metrics-dashboard` | `:69` `{activeView === "dashboard" ? <TokenDashboard /> : <Board />}` | `:78` `costsEnabled && activeView === "dashboard" ? …` |
| `port/run-hub-projects` | `:72` `{activeView === "projects" ? <Projects /> : <Board />}` | `:78` `projectsEnabled && activeView === "projects" ? …` |

**Merging either branch as-is ships that surface default-ON**, contradicting the stated design intent
(`legacy types.ts:555`: *"gated behind a toggle so the base console matches upstream (both default OFF)"*).
This is not the branch author's oversight — `8164ea2` **post-dates PORT-INVENTORY**, so the gate simply is
not on the port list they worked from.

**Fix:** cherry-pick `legacy 8164ea2` onto both branches (or onto `master` after they merge). 7 files,
+35/−3, listed in §2.3.

**Second issue on the same branch:** `port/run-hub-projects` commit `ff62ab0` adds
`.orchestrator/run.json` = `{"kind":"url", "url":"http://dev.orchestrator.localhost/", "disruptive":true}`.
That host only resolves through the Caddy proxy in `infra/caddy` — explicitly **DROPPED** (§3.3). Merged
as-is it is a dead Run button. Drop the recipe from the port or re-author it (§6.9).

#### Resolution (2026-07-25)

`8164ea2` was **split across the two branches it gates** rather than cherry-picked whole onto each. Each
branch ships only one of the two surfaces, so taking the whole commit would have left the other branch
referencing a setting for a component it does not contain. Merging both reproduces `8164ea2` in full;
because they add sibling rows to the same new "Features" settings group, expect a small additive union
conflict there at merge time and keep both rows.

| Branch | Gate commit | Covers | Tip after this work |
|---|---|---|---|
| `port/token-metrics-dashboard` | `783ea5f` *feat(settings): gate the Costs surface behind a toggle (default OFF)* — 7 files, +21/−2 | `costsEnabled` | `783ea5f` |
| `port/run-hub-projects` | `56980aa` *feat(settings): gate the Projects surface behind a toggle; fix the launch recipe* — 9 files, +30/−7 | `projectsEnabled` | `f9e3724` (see below) |

Both follow the `add-a-setting.md` fan-out: `settingBool("setting_<x>_enabled", false)` + a `kvSet` write in
`threadManager.ts`, the field in `server/src/types.ts` and `ws/protocol.ts`, mirrored in `web/src/types.ts`
and `store.ts`, a `ToggleRow` under a new **Features** group in `SettingsPanel.tsx`, and **two** guards in
`App.tsx` — one on the nav button, one on the view swap (`enabled && activeView === …`), so disabling the
toggle while the surface is open falls back to the board instead of blanking it.

**Verified per branch** — not just typechecked. Each branch was built in an isolated detached worktree
(own `node_modules`, outside the main checkout) and driven headlessly against a throwaway instance on
`:4517` with an isolated `DATA_DIR`, never prod:

| Check | `port/token-metrics-dashboard` | `port/run-hub-projects` |
|---|---|---|
| `npm run typecheck` | clean | clean |
| `npm run build` | pass | pass |
| `npm run test:gates` | **21/21** | **20/20** |
| Browser E2E (10 assertions) | **10/10** | **10/10** |

The E2E asserts, per surface: nav button absent on a fresh DB; board rendered; surface absent; the toggle
reads `aria-checked="false"`; flipping it on makes the nav button appear; the surface renders when opened;
flipping it back off while the surface is the active view falls back to the board; the nav button hides
again; and the default still holds after a reload (i.e. it is the server-side `settingBool` default, not
just client state).

**The dead Run recipe was removed, not re-pointed** — `f9e3724` *fix(runhub): drop the orchestrator's own
launch recipe — it bound the prod port*. An intermediate fix in `56980aa` had re-authored the recipe as a
`web` recipe on the Vite dev port `:4318` with `start: npm run dev`. That cured the dead Caddy host but not
the underlying problem, and still broke the hard rule in `run-hub-recipe.md`:

- root `npm run dev` is `concurrently npm:dev:server npm:dev:web`, and `dev:server` **listens on `:4317`** —
  the production port. With prod up under keepAlive the launch either `EADDRINUSE`s or fights the live server.
- even when `:4318` is already up and `start` never fires, `web/vite.config.ts` proxies `/api` → `127.0.0.1:4317`
  and `/ws` → `ws://127.0.0.1:4317`, so the console that Run button opens is driving **production**.

The orchestrator is launched by the process manager, not by its own Run button, so no recipe is the honest
answer. Confirmed the removal leaves **no** button rather than falling through to a re-derived one: for this
workspace `readRecipeFile`, `autoDetectRecipe` and `resolveRecipe` all return `null` — auto-detect finds no
root-level vite config (it lives in `web/`), no package `homepage`, and no exe under a root build dir.
`run-hub-recipe.md`'s hard rule now records the indirect-bind and dev-proxy traps so it is not re-authored.

**Unrelated gate hazard found while verifying — read before you re-run the suite tomorrow.** `test:scheduler`
fails on **every** branch, `master` included, between **02:45 and 02:59 local**. `scheduler.test.ts` creates
a task with cron `0 3 * * *`, updates it to `*/15 * * * *`, and asserts `nextRunAt` changed — inside that
window both expressions resolve to the same instant (today 03:00:00), so it correctly does not change.
Measured with the scheduler's own `nextRun()`: collides at 02:45/02:50/02:59, not at 02:44/03:00/03:01. It is
a deterministic 15-minute-per-day window, not a flake and not a merge defect — every green gate count in this
report was recorded outside it. **Fixed on `master` as `786f669`** *fix(test): make the scheduler re-anchor
check time-independent*, in its own commit rather than on a port branch (patching one branch would have
diverged it from the other five on merge eve; they inherit the fix when they land). The assertion now checks
that `nextRunAt` equals `nextRun("*/15 * * * *", nextRunAt - 1)` instead of merely differing from the previous
value — time-independent, and a stronger property: it proves re-anchoring to the **new** cron rather than just
that a number moved.

---

## 4. Build health — **green, end to end**

Run in an **isolated detached worktree** at `master` @ `5493dc1`
(`C:\Users\Mikkel\projects\_co-readiness`, its own `node_modules`), deliberately **not** in the main
checkout — that tree was dirty with another agent's cherry-pick, so building there would have measured
their conflict markers, not the baseline. Worktree removed afterwards.

| Step | Command | Result |
|---|---|---|
| Toolchain | `node -v` / `npm -v` | Node **v24.15.0**, npm **11.12.1** |
| Install | `npm run install:all` | ✅ exit 0 |
| Root deps | `npm install` (root — `concurrently`) | ✅ exit 0 |
| Native binding | `better-sqlite3` | ✅ `server/node_modules/better-sqlite3/build/Release/better_sqlite3.node` present (1,918,464 bytes) |
| Typecheck | `npm run typecheck` (server + web) | ✅ exit 0, clean |
| Build | `npm run build` | ✅ exit 0 — web: 345 modules → `web/dist` in 245ms; server: `server/dist/index.js` |
| Free gates | `npm run test:gates` (from `server/`) | ✅ **18/18 passed** |

**No breakages found, so no fixes were needed.** Nothing was patched — the baseline is genuinely clean.

Independently corroborated: the teammate working in this repo tonight reported the same result on the same
commit (typecheck clean, 18/18 gates) from the main checkout, on the same toolchain.

Notes:
- `npm audit` reports 21 advisories (5 low, 12 moderate, 4 high) plus a deprecated-`glob` warning. These are
  transitive dev-dependency advisories inherited from upstream, **non-blocking** and unchanged from the
  inventory's §7 run. Not fixed here — `npm audit fix --force` on the eve of a migration is a bad trade.
- `test:gates` is the **free** suite. The `.itest` gates that spawn real `claude` subprocesses were **not**
  run — they burn subscription quota and need live auth. That is by design, and it means the gate run
  proves compilation and logic, not live agent behavior.
- npm 11 does not block install scripts here, so `better-sqlite3` compiled automatically. On **npm 12+** the
  README's extra step applies: `npm install-scripts approve better-sqlite3 && npm rebuild better-sqlite3`.

---

## 5. Scope and constraints honored by this audit

- **Nothing was pushed anywhere.** No remote was created, modified or contacted except read-only
  `git fetch upstream` / `git fetch legacy`. `upstream` was never pushed to.
- **No merge conflicts were auto-resolved.** The in-flight cherry-pick was left entirely alone; comparisons
  that would have required resolving a conflict are reported as pending instead.
- **No live data touched.** No prod/dev instance was started or stopped; nothing on `:4317`/`:4318`/`:5317`
  was contacted. The build ran in a throwaway worktree with its own `node_modules` and was cleaned up.
- **Git state was owned by another agent** (cutting the `port/*` branches) for the duration, by explicit
  agreement. This audit therefore made **no ref-mutating git calls** — no checkout, reset, stash, merge or
  cherry-pick. The recommended `set-url --push` hardening in §1.3 was **left unapplied** for that reason;
  it is listed as a cutover action instead.

---

## 6. Cutover checklist — ordered

### Before the move

1. **Settle the in-flight branch work.** Confirm no cherry-pick/merge is in progress and the tree is clean
   on `master` (commands in §1.4). Do not start the move mid-cherry-pick.
2. **Harden push safety** (§1.3) — `git remote set-url --push upstream no-push://blocked`. One command,
   removes the sharpest footgun. Do this first; it costs nothing and protects everything after.
3. ~~**Cherry-pick `legacy 8164ea2` onto `port/token-metrics-dashboard` and `port/run-hub-projects`
   BEFORE merging either**~~ — ✅ **DONE 2026-07-25** (§3.4). Split across the two branches (`783ea5f`,
   `56980aa`), default OFF, full gates green on each (21/21 and 20/20) and a 10/10 browser E2E on each. Nothing to do here before the
   merge except keep **both** "Features" toggle rows when the two branches conflict additively in
   `SettingsPanel.tsx`. Re-check with
   `git grep -c -E 'costsEnabled|projectsEnabled' <branch> -- server/src web/src` (non-zero) and
   `App.tsx` reading `costsEnabled && activeView === "dashboard"` / `projectsEnabled && activeView === "projects"`.
4. **Review and merge `port/crash-resilience`** — the director-wedge watchdog + Claude-runner watchdog are
   the one genuine capability regression versus the fork (§3.2). Everything else can follow later; this one
   determines whether a wedged run self-heals or hangs until you notice.
5. **Re-run the build path** after any merge: `npm run typecheck && npm run build`, then
   `npm run test:gates --prefix server`. Expect ≥18 gates (each ported feature registers its own).

### The decision only Mikkel can make

6. **Choose the writable origin.** There is deliberately no `origin` today. Until there is one, this repo has
   **no off-machine backup** — every port branch and every commit exists on exactly one disk. That is the
   single largest risk in the whole migration, and it is a decision, not a task. The options are a private
   GitHub repo under your account, a fork of `Fearce/garden-gnome-orchestrator`, or staying local. **Not
   decided by this task — flagging it, not making it.**

### During / after the move

7. **Keep the legacy repo intact and read-only until the ports are finished.** The `8164ea2` gates have
   since been brought across (§3.4), but that is precisely the point: they were found *after*
   PORT-INVENTORY was written, by reading the legacy history. Anything else the port branches turn out to
   have missed still exists *only* in `C:\Users\Mikkel\projects\claude-orchastrator`. Do not delete,
   archive or rewrite it until every port has landed here and been verified. Losing it loses them.
8. **Verify the gate for real once §4.1/§4.2 merge** (§2.4). Already done *per branch* — toggle off →
   reload → nav button and pane gone, 10/10 assertions on each (§3.4) — so what remains is to re-run it
   once on the **merged** result, since the two toggles first coexist only after both land. Still open, and
   unchanged by this work: whether the UI-only depth (§2.2) is what you want, or whether the metrics timer
   and the `/api/runhub/*` routes should be gated server-side too.
9. ~~**Fix the Run Hub recipe rather than merging the legacy one.**~~ — ✅ **DONE 2026-07-25.** The
   `.orchestrator/run.json` that `ff62ab0` brought onto `port/run-hub-projects` (pointing at the dropped
   Caddy host `http://dev.orchestrator.localhost/`) has been **removed** on that branch, not re-pointed
   (`f9e3724`). Re-pointing it at the Vite dev port was tried and rejected: `npm run dev` boots `dev:server`
   on `:4317` and Vite proxies `/api`/`/ws` to `:4317`, so any such recipe binds or drives production —
   see §3.4. `master` and the port branch now both carry **no** `run.json`, which is the correct state.
   Don't re-author one on merge day; the orchestrator is launched by the process manager.
10. **Review `port/self-update-restart` separately** — 2 commits (`9a77d8e` one-click restart button +
    "changes ready" prompt, `00c5df5` always give feedback + actually restart a hub-less instance),
    touching `server/src/update.ts`, the self-update path. A half-ported self-update is worse than none.
    Note also that a throwaway test instance's Restart button reaches the **real** script-hub on `:3939`
    and will bounce **prod** — neutralise `SCRIPT_HUB_URL` and set `ORCH_SUPERVISED=0` before smoke-testing
    this one.

### Nice to have, not blocking

11. Root `package-lock.json` (§1.4) — being gitignored during this session; confirm the `.gitignore` line
    landed rather than the file being committed.
12. Add a **committed** test for the `costsEnabled`/`projectsEnabled` toggles — there is still none
    (§2.2). The §3.4 verification was a throwaway browser harness against a temp instance; it proved the
    gates work today and was then deleted, so it guards nothing going forward. A settings gate with no
    gate test is exactly the thing that silently regresses, and §3.4 is the proof: the gate was dropped on
    the way into this repo and nothing failed to catch it. The cheap version is a unit gate asserting
    `settingBool("setting_costs_enabled"/"setting_projects_enabled", false)` defaults OFF and round-trips
    through `updateSettings`; the UI guard itself is only worth an E2E once both branches have merged.

---

## 7. Re-verify this report in one minute

```bash
cd C:\Users\Mikkel\projects\claude-orchestrator
git fetch upstream --prune && git fetch legacy --prune
git log --oneline master..upstream/master                  # empty  => still at upstream HEAD
git log --oneline upstream/master..master                  # only the PORT-INVENTORY docs commit(s)
git status --short --branch                                # clean, on master
git for-each-ref --format='%(refname:short) %(objectname:short)' refs/heads   # the port/* branch list
git ls-tree -r --name-only master | grep -Ei 'cost|metric|project|runhub'     # empty => §4.1/§4.2 still pending
git grep -n -E 'wedge' master -- server/src/orchestrator/director.ts          # empty => §4.3 still pending

# §3.4 — the gate check. Non-zero on BOTH before either branch merges, else the surfaces land default-ON.
# As of 2026-07-25 both return 7 files each; a ZERO here means the gate got lost again.
git grep -c -E 'costsEnabled|projectsEnabled' port/token-metrics-dashboard -- server/src web/src
git grep -c -E 'costsEnabled|projectsEnabled' port/run-hub-projects       -- server/src web/src

# §3.4 — and the recipe must stay gone (any output here is a regression):
git ls-tree -r --name-only port/run-hub-projects -- .orchestrator

npm run typecheck && npm run build && npm run test:gates --prefix server      # expect 18/18 on master
```

> Gate counts on the port branches are **higher than 18** and differ per branch — each ported feature
> registers its own gates (`port/token-metrics-dashboard` 21, `port/run-hub-projects` 20). 18 is `master`'s
> number. And do not read a `test:scheduler` failure between **02:45 and 02:59**
> local as a regression on an unmerged branch: that is the cron collision fixed on `master` by `786f669`,
> which the branches only inherit when they land (§3.4).

---

*Produced by the pre-move readiness check, 2026-07-25. Every claim above was verified against the pinned
`master` tree or a captured command log; where something could not be verified, this report says so rather
than assuming.*

*Updated 2026-07-25, same night: §3.4 closed — the Costs/Projects gates now ship on both feature branches
(default OFF, browser-verified), the dead Run Hub recipe was removed rather than re-pointed, and the
`test:scheduler` cron collision found while verifying was fixed on `master`. Checklist items 3 and 9 are
done; items 8 and 12 are narrowed but still open. Everything else in this report stands as originally
written.*
