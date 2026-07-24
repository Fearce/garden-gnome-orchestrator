# PORT-INVENTORY — re-baselining Claude Orchestrator on current upstream

**Generated:** 2026-07-24
**New repo:** `C:\Users\Mikkel\projects\claude-orchestrator` (clean clone of upstream)
**Upstream:** `https://github.com/Fearce/garden-gnome-orchestrator` — remote `upstream`, HEAD `6848cc4` (2026-07-24 15:44)
**Legacy fork:** `C:\Users\Mikkel\projects\claude-orchastrator\claude-orchestrator` — remote `legacy`, `legacy/master` HEAD `12a7644` (2026-07-24 18:11)
**Merge-base (3-way comparison point):** `cdf37e9` — *"docs(rules): add the merge-an-incoming-fork-PR playbook"* (2026-07-24 13:23)

This report inventories the full divergence between our fork and current upstream HEAD so we can port
the fork's best pieces onto a clean upstream baseline. It is complete, not a sample: every changed file
is accounted for, grouped by feature area, with commit/file citations for cherry-picking.

---

## 0. TL;DR — the recommended move

- **The re-baseline gain is small.** Upstream is only **5 commits / 12 files** ahead of the merge-base
  (office peer-gating, two mobile fixes, a README Linux/npm-12 note). The fork already absorbed everything
  else upstream had via merges earlier today. So "re-baselining" buys us those 5 commits plus a clean history.
- **The fork's unique value is ~6 features** not present upstream: **live token-cost dashboard**,
  **Run Hub / Projects layer**, **crash-resilience supervisor + watchdog**, **director wake-on-completion**,
  **token-limit pause/auto-resume**, and their supporting **schema + WS-protocol** changes.
- **The conflict zone is 9 files** both sides changed — dominated by `threadManager.ts` and `styles.css`.
  Everything else the fork added is in **new files** (86 of them) that graft cleanly.
- **Drop from the port:** the upstream auto-sync tooling (the fork already removed it), the
  environment-specific `infra/` (Caddy proxy, prediction-market bet-tracker), the design-exploration
  mockups, and most fork-internal process docs.

---

## 1. Repository setup (as delivered)

```
$ git -C claude-orchestrator remote -v
legacy    C:/Users/Mikkel/projects/claude-orchastrator/claude-orchestrator (fetch/push)
upstream  https://github.com/Fearce/garden-gnome-orchestrator (fetch/push)
```

- Cloned at upstream default branch (`master`) HEAD `6848cc4`, 318 commits.
- `origin` renamed to `upstream` (we do **not** own it; never push there). No writable origin exists yet —
  Mikkel will decide the remote later.
- `legacy` added → local fork, fetched. All fork branches are available for cherry-picking
  (`legacy/master`, plus `feat/*`, `fix/*`, `reader-lane`, `local-testing`, etc.).
- The legacy repo was **only read/fetched** — no commits, no working-tree changes were made to it.

## 2. History topology — why the merge-base is "today"

This is **not** a classic git-fork where the fork simply sits N commits ahead of an old upstream tag.
`legacy/master` has **two root commits** (`d1cdd91` and `0aec652`, both *"feat: Claude Orchestrator — director
console for Claude Code agents"*, 2026-06-13). The Claude Orchestrator began as its own history on 2026-06-13,
and garden-gnome-orchestrator's history was **merged into it** — the "superset fork" strategy recorded in fork
commit `b6968a2` *"docs(upstream): record the de-fork audit + superset-fork strategy"*.

Crucially, **earlier today** the fork merged upstream *forward* to near-current:
- `7caafc5` *"merge: resolve conflicts between watchdog/liveMetrics/projectMeta and zai provider support"*
- `7dfdab6` *"merge: port 9 upstream commits (reliability, read-lane auto-close, per-repo cap, copy-ref, zai provider)"*

That pulled upstream's history up to `cdf37e9`, which is why the 3-way merge-base is a commit from *today*
rather than mid-June. The practical consequence is good for us: **almost all of upstream's evolution is already
in the fork**, so `git diff <merge-base>..legacy` is a clean readout of the fork's *own* remaining additions,
and `git diff <merge-base>..upstream` is the short list of what re-baselining still gains.

**Divergence at a glance**

| Direction | Commits | Files | Insertions | Deletions |
|---|---:|---:|---:|---:|
| Fork-only (`cdf37e9..legacy/master`) | 377 | 135 | +29,768 | −1,147 |
| Upstream-only (`cdf37e9..upstream/master`) | 5 | 12 | +592 | −83 |

Fork file changes break down as **86 added, 43 modified, 6 deleted**. Commit-subject scope mix across the 377:
`feat` 152, `fix` 116, `docs` 55, `merge` 16, `chore` 11, `refactor` 8, `test`/`perf`/`revert` 5 each.

---

## 3. What re-baselining GAINS (upstream since the merge-base)

The 5 commits upstream has that the fork does not (all 2026-07-24 afternoon):

| Commit | Subject | Files |
|---|---|---|
| `6848cc4` | fix(mobile): keep the inject action row on one line | `web/src/components/ThreadDetail.tsx`, `web/src/styles.css` |
| `b7a1229` | docs(rules): add the office-coordination peer-gating fan-out playbook | `.claude/rules/office-coordination.md` |
| `3cc7ca6` | fix(mobile): reclaim vertical space above the director transcript | `web/src/components/Director.tsx`, `web/src/styles.css` |
| `0dc9ae9` | **feat(office): gate cross-agent office coordination on repo-peer presence** | `AGENTS.md`, `CLAUDE.md`, `server/src/agents/prompts.ts`, `server/src/orchestrator/threadManager.ts`, `server/src/tests/officeGating.itest.ts`, `web/src/components/ThreadDetail.tsx` |
| `c48ac56` | docs(readme): add Linux/npm 12 first-run native build steps | `README.md`, `server/package.json`, `server/scripts/run-gates.cjs` |

**Net:** one real feature (office coordination is now **gated on repo-peer presence** so agents only coordinate
when a teammate is actually in the same repo), two mobile layout fixes, and doc/build notes. This is the entire
upside of re-baselining beyond a clean history — and it's exactly the office area the fork *also* touched, so
watch for it in §5.

---

## 4. What the FORK ADDED (port candidates), by feature area

Each area cites representative commits and the files to cherry-pick. New files graft cleanly; modified files
(*) are in the conflict zone — see §5.

### 4.1 Live token-cost dashboard & metrics — **PORT (high value)**
Real-time per-stage / per-task / director token spend, plus a CLI token-report and an A/B measurement harness.
- **New:** `server/src/metrics/liveMetrics.ts`, `metricsBroadcast.ts`, `tokenReport.ts`, `tokenReportCli.ts`;
  `web/src/components/TokenDashboard.tsx`, `web/src/components/tokenDashboard.css`.
- **Schema:** `agent_runs` gains per-run token columns (`input_tokens`, `output_tokens`, `cache_read_tokens`,
  `cache_creation_tokens`, `baseline_head`, `variant`); **new `director_runs` table** (one row per director turn,
  since the director isn't a per-task pipeline run) with `idx_director_runs_started`.
- **Commits:** `730c994` *feat(dashboard): live token-cost pane*, `51a38a1` *feat(metrics): instrument director
  token spend + A/B harness*.
- **Tests:** `agentRunTokens.itest.ts`, `liveMetrics.itest.ts`, `metricsTokenReport.itest.ts`.
- **Rule/doc:** `.claude/rules/add-a-live-pane.md`, `.claude/rules/ab-token-measurement.md`.

### 4.2 Run Hub + Projects layer — **PORT (high value)**
One-click launch of orchestrator-built apps, inline launch icons on task/project cards, and a persisted
per-repo **Projects** view (Now/Next/Later roadmap + hill positions + description).
- **New:** `server/src/runHub/launcher.ts`, `projects.ts`, `recipe.ts`; `web/src/components/LaunchButton.tsx`,
  `Projects.tsx`; `web/src/lib/projects.ts`; `.orchestrator/run.json`.
- **Schema:** **new `project_meta` table** (`project_id` PK, JSON `data` blob, `updated_at`).
- **Commits:** `ebd6f71` *feat: Run Hub — launch orchestrator-built apps + one-click verify*, `b3b4054`
  *feat(web): productionize the Projects layer with live data + persisted roadmaps*, `a6692dc`
  *feat(web): restructure project view into tabs; auto-populate roadmap; re-entry peek*, `d51bd36`
  *feat(launch): inline launch icon on task/project cards*, `9097e60` *fix(launch): play-triangle icon*.
- **Tests:** `runHub.itest.ts`, `findWorkspace.itest.ts`.
- **Rule/doc:** `.claude/rules/run-hub-recipe.md`.

### 4.3 Crash-resilience: watchdog + director-wedge recovery + restart-resume — **PORT (high value)**
The server captures crash evidence, recovers a wedged director instead of hanging until a manual restart, and
resumes tasks after a restart. (The `serve`-mode supervisor `server/scripts/supervise.cjs` itself is **already
upstream** — unchanged by the fork — so it's not a port item; the fork's additions are the watchdog/recovery
behavior layered on top.)
- **New diagnostic scripts:** `verify-instance.cjs`, `why-ended.cjs`, `update-doctor.cjs`, `pipeline-stats.cjs`,
  `check-orphaned-tests.cjs`.
- **Commits:** `f014ea5` *fix(server): supervise the server + capture crash evidence*, `d777bdf`
  *fix(director): auto-recover a wedged director session*, `44519d0` *fix(restart): always give feedback + actually
  restart a hub-less instance*, `09e8d4b` *docs: crash post-mortem 2026-07-23*.
- **Tests:** `runnerWatchdog.itest.ts`, `restart.itest.ts`, `restartResumeRecovery.itest.ts`, `crashLog.itest.ts`.

### 4.4 Director wake-on-completion — **PORT (medium value)**
The director proactively relays task outcomes when they finish rather than waiting to be asked.
- **New:** `server/src/orchestrator/directorWake.ts`.
- **Commits:** `95303c3` *feat(director): proactively relay task outcomes (wake-on-completion)*.
- **Tests:** `directorWake.itest.ts`.
- **Rule/doc:** `.claude/rules/notify-on-thread-terminal-state.md`.

### 4.5 Token-limit pause / auto-resume — **PORT (medium value)**
On a usage cap, in-flight tasks pause (state preserved) and auto-resume at reset instead of being cancelled.
- **Commits:** `3e086f7` *feat(token-limit): pause in-flight tasks instead of cancelling, auto-resume at reset*.
- **Tests:** `tokenLimitPause.itest.ts`; `tokenFreezeResume.itest.ts` (*modified*).
- **Note:** the standalone `token_freeze_monitor.cjs` and `TOKEN_FREEZE_FINDINGS.md` are investigation
  artifacts (one was later deleted on the fork) — port the *behavior*, not the scratch files.

### 4.6 Supporting wiring (modified core) — **REWORK (see §5)**
The features above are wired through modified core files: `server/src/orchestrator/threadManager.ts`,
`director.ts`, `deliverableCheck.ts`; `server/src/db/{schema,db}.ts`; `server/src/ws/{hub,protocol}.ts`;
`server/src/{config,types,index,update}.ts`; `server/src/accounts/{accountManager,resetStagger,usagePing}.ts`;
`server/src/bus/{directorServer,gitReadServer,memoryServer}.ts`; and web `App.tsx`, `Board.tsx`,
`SettingsPanel.tsx`, `store.ts`, `types.ts`, `lib/{base,format,update}.ts`, `main.tsx`, `vite.config.ts`.
Most are additive and low-risk; the risky subset is the §5 overlap set.

### 4.7 Fork-internal tooling & docs — **MOSTLY DROP**
- **Upstream auto-sync (already removed):** `a097cc4` *feat(sync): automated upstream auto-sync on a schedule*
  was **reverted** by `612e68b` *refactor: remove the automated upstream auto-sync feature*. `server/src/update.ts`
  changes and `docs/upstream-sync.md` relate to this. **Drop** — the new baseline has no auto-sync and we don't
  want one. `.claude/rules/upstreaming-to-fearce.md` documents the manual PR workflow and may be worth keeping.
- **Process rules/docs (keep the ones paired with a ported feature, drop the rest):**
  `.claude/rules/{add-a-live-pane,add-a-thread-column,run-hub-recipe,notify-on-thread-terminal-state,
  per-thread-in-memory-state,verify-server-route-or-ui,cleanup-sweep,seed-global-memory}.md`; root docs
  `HANDOFF.md`, `DEV.md`, `DEV-ISOLATION.md`, `UPSTREAM-MIGRATION-HANDOFF.md`, `TOKEN_*.md`, `docs/*.md`.
  These are fork-history/process artifacts; port selectively.

### 4.8 Environment-specific infra — **DROP from the baseline**
Not orchestrator features — deployment/plumbing tied to Mikkel's machine and a specific downstream project:
- `infra/caddy/*` — a Caddy local-domains reverse proxy (Windows service, watchdog, verify scripts).
  Commits `fe0e45e`, `0f350de`.
- `infra/bet-tracker/*` — an always-on Supabase tracker for the *prediction-market-bot* project.
  Commits `d0e50a8`, `1b7e08b`, `05f9dac`, `ae2fca9`.
Keep these in the legacy repo / a separate ops repo; they don't belong in a re-baselined orchestrator.

### 4.9 Design explorations — **DROP (reference only)**
`design/explorations/2026-07-23*/**` — 19 static HTML/CSS reskin mockups (variants: rail/deck/slate/console/hybrid,
themes: ember/graphite/nocturne/onyx). Design reference, not shipping code. Pull ideas from them if we reskin;
don't port the files.

### 4.10 Files the fork DELETED
`server/scripts/fix-stuck.cjs`, `server/src/git/readonlyGit.ts`, `token_freeze_monitor.cjs`,
`docs/diagnosis-thread-history.md`, `docs/token-freeze-resume-test.md`, `TOKEN_FREEZE_FINDINGS.md`.
These are deletions relative to the merge-base; the baseline already lacks most of them. `readonlyGit.ts`
removal is the only code deletion — verify the replacement path before porting anything that referenced it.

---

## 5. Overlaps / conflicts — where porting is non-trivial

Nine files were changed on **both** sides (upstream's 5 commits ∩ the fork's 377). A clean cherry-pick will
conflict on these; they need a manual 3-way reconcile onto upstream HEAD. Churn (fork vs upstream, relative to
the merge-base):

| File | Fork churn | Upstream churn | Why it conflicts |
|---|---|---|---|
| `server/src/orchestrator/threadManager.ts` | **+366 / −63** | +98 / −42 | Fork wires metrics/wake/watchdog through it; upstream added **office peer-gating** here. Highest-risk merge. |
| `web/src/styles.css` | **+612 / −12** | +45 / −11 | Fork adds token-dashboard/projects styling; upstream has mobile layout fixes. Mostly additive but co-located. |
| `web/src/components/ThreadDetail.tsx` | +97 / −35 | +2 / −2 | Fork feature UI vs upstream mobile inject-row fix. |
| `web/src/components/Director.tsx` | +55 / −39 | +34 / −4 | Fork director-pane changes vs upstream vertical-space fix. |
| `server/src/agents/prompts.ts` | +11 / −8 | +16 / −24 | Both edit agent prompts; upstream's office-gating prompt text must win or be merged. |
| `server/scripts/run-gates.cjs` | +18 / −0 | +1 / −0 | Fork adds gates to the list; upstream adds one (`office-gating`). Merge = union of the gate list. |
| `README.md` | large | +Linux/npm-12 notes | Take upstream's build section; fold in any fork-only run notes. |
| `CLAUDE.md` | large | office-gating guidance | Take upstream's; re-apply fork-specific project rules if still wanted. |
| `server/package.json` | scripts added | +1 script | Merge the `scripts`/deps union. |

**Practical order:** start from upstream HEAD, add the fork's **new files** first (§4.1–4.5 — they don't
conflict), then hand-merge these 9 files, resolving in favor of **upstream's office peer-gating** where it
overlaps the fork's `threadManager.ts`/`prompts.ts` edits (upstream's version is the newer design).

---

## 6. Recommended port list

| Feature / area | Verdict | Rationale |
|---|---|---|
| Live token-cost dashboard + `director_runs`/`agent_runs` token schema (§4.1) | **PORT** | Unique to fork, high operator value, clean new files. |
| Run Hub + Projects layer + `project_meta` (§4.2) | **PORT** | Unique, self-contained, one-click launch is a real workflow win. |
| Crash-resilience supervisor + watchdog + restart-resume (§4.3) | **PORT** | Directly addresses the fork's documented crash/wedge pain; mostly new scripts + tests. |
| Director wake-on-completion (§4.4) | **PORT** | Small, self-contained, improves the director loop. |
| Token-limit pause / auto-resume (§4.5) | **PORT** | Meaningfully better than cancel-on-cap; port behavior, drop scratch files. |
| Supporting core wiring (§4.6) | **REWORK** | Additive parts port easily; the 9 §5 files need a 3-way merge. |
| Office coordination peer-gating (upstream `0dc9ae9`) | **KEEP UPSTREAM (drop fork's version)** | Upstream's newer design supersedes the fork's office edits — reconcile toward upstream. |
| Upstream auto-sync tooling (§4.7) | **DROP** | Already reverted on the fork; a re-baselined repo shouldn't auto-sync. |
| `infra/caddy`, `infra/bet-tracker` (§4.8) | **DROP** | Environment/project-specific ops, not orchestrator features. |
| `design/explorations/**` (§4.9) | **DROP** | Static mockups; reference for a future reskin only. |
| Fork process docs/rules (§4.7) | **PORT SELECTIVELY** | Keep the rule paired with each ported feature; drop the rest. |

---

## 7. Upstream baseline verification (this repo, at HEAD `6848cc4`)

Ran the upstream-prescribed install/build; **the baseline is clean — no breakage.**

| Step | Command | Result |
|---|---|---|
| Toolchain | `node -v` / `npm -v` | Node **v24.15.0**, npm **11.12.1** |
| Install deps | `npm run install:all` | ✓ exit 0 (only non-blocking `npm audit` advisories) |
| Root dev dep | `npm install` (root — for `concurrently`) | ✓ |
| Native binding | `better-sqlite3` build | ✓ `server/node_modules/better-sqlite3/build/Release/better_sqlite3.node` present |
| Typecheck | `npm run typecheck` (server + web) | ✓ clean |
| Build | `npm run build` (web + server) | ✓ web (345 modules, `web/dist/`) + server (`server/dist/index.js`) |
| Free test gates | `npm run test:gates` (in `server/`) | ✓ **18/18 passed** |

**Notes for whoever runs this next:**
- npm 11 here does **not** block install scripts, so `better-sqlite3` compiled automatically. On **npm 12+**
  the README's extra step applies: `npm install-scripts approve better-sqlite3 && npm rebuild better-sqlite3`.
- `test:gates` lives in `server/package.json`, not root — run it from `server/` (or `--prefix server`). It is
  the **free** (no-credential) suite; the `.itest` gates that spawn real `claude` subprocesses are deliberately
  excluded and were **not** run (they burn subscription quota and need live auth).
- No upstream code was modified in this task — verification only.

---

## 8. Reproduce the divergence analysis

```bash
MB=$(git merge-base upstream/master legacy/master)   # cdf37e9
git log $MB..upstream/master --oneline               # the 5 re-baseline gains
git diff --name-status $MB legacy/master             # the 135 fork-changed files
git diff --name-only $MB upstream/master | sort \
  | comm -12 - <(git diff --name-only $MB legacy/master | sort)   # the 9 overlap files
```
