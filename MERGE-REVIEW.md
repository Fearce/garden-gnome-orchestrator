# MERGE-REVIEW — the fork's features, staged as reviewable branches

**Prepared:** 2026-07-25 · **Baseline:** `master` = upstream `6848cc4` + `PORT-INVENTORY.md` (+ this doc)
**Nothing has been merged. Nothing has been pushed.** Six `port/*` branches are cut off `master`, each
verified independently. Read §1, then decide per branch in §3.

Toolchain used for every verification below: Node **v24.15.0**, npm **11.12.1**.

---

## 1. TL;DR — the decision table

| # | Branch | What you get | Verified | Recommendation |
|---|---|---|---|---|
| 1 | `port/crash-resilience` | Wedged-director watchdog + auto-recovery; restart-interrupted tasks stay recoverable; 5 diagnostic scripts; an orphaned-test guard | typecheck, build, **21/21 gates** | **Merge as-is** |
| 2 | `port/director-wake` | The director proactively messages you when a task settles | typecheck, build, **19/19 gates** | **Merge as-is** (after #1) |
| 3 | `port/self-update-restart` | One-click Restart button + "changes ready" banner + honest failure feedback | typecheck, build, **20/20 gates**, **browser-driven** | **Merge with caveat** — see §3.3 |
| 4 | `port/token-limit-pause` | A usage-cap **pauses** in-flight tasks instead of cancelling them; auto-resume at reset | typecheck, build, **19/19 gates**, **browser-driven** | **Merge as-is** |
| 5 | `port/run-hub-projects` | Projects layer (per-repo roadmaps, re-entry brief) + inline launch button — **behind a default-OFF toggle** | typecheck, build, **20/20 gates**, **browser-driven** | **Merge as-is** |
| 6 | `port/token-metrics-dashboard` | Live token-cost dashboard + per-run token schema + A/B variant tagging — **behind a default-OFF toggle** | typecheck, build, **21/21 gates**, **browser-driven** | **Merge as-is** |

Branches 5 and 6 add fork-only *surfaces* upstream has no equivalent for, so both are gated behind new
Settings → Features toggles that default **OFF**: merging them changes nothing you can see until you opt in.

**Suggested merge order — validated, not guessed** (§4): 1 → 2 → 3 → 4 → 5 → 6.
I merged all six in that order on a throwaway branch and the result was green:
typecheck clean, build clean, **30/30 gates**, **0 orphaned tests**. §4 lists every conflict you
will hit and exactly how to resolve it.

**Four findings that contradict or postdate PORT-INVENTORY** — read §5 before you start. In short: part of
§4.3 is already upstream under a different SHA; §4.3's cited `44519d0` is really a separate feature (now
branch 3); the fork's upstream-merge machinery is deliberately dropped; and one fork commit landed AFTER the inventory
was written and had to be ported by hand.

---

## 2. How the branches were built

- Each branch is `git cherry-pick -x` of the fork's real commits onto upstream HEAD, so **authorship is
  preserved verbatim** (the original fork's author metadata) and each commit
  carries a `(cherry picked from …)` line back to the legacy SHA.
- Conflicts were resolved by hand against the upstream codebase. Where upstream and the fork had both
  evolved the same code, **upstream's newer design wins** (PORT-INVENTORY §5's rule).
- Every branch is **self-contained**: it compiles, builds and passes the whole free gate suite on its own.
  Where a feature genuinely depends on another branch, that is called out as a merge-order constraint
  rather than smuggled in.
- Ported test scripts are registered in `server/scripts/run-gates.cjs`, so they actually run. That is why
  each branch reports a gate count above the 18-gate baseline.
- **The old fork repo and the old live instance were never touched.** All verification ran on throwaway
  instances (port 4327, temp `DATA_DIR`, `SCRIPT_HUB_URL` pointed at a dead port) — never 4317/4318.

---

## 3. The branches

### 3.1 `port/crash-resilience` — 9 commits, 17 files, +1262/−11

**What it ports (plain language).** The orchestrator used to wedge or die in ways that needed a manual
restart. This branch adds: a **liveness watchdog on the director** (a turn that goes silent for 3 minutes
is treated as a hung `claude` subprocess, torn down, and the session resumed so your message is still
answered — bounded so a permanently broken session settles with an honest note instead of looping); a fix
so a task **interrupted by a restart stays recoverable across repeated bounces** (it used to strand in
`failed` showing "auto-resuming…" forever); five read-only diagnostic scripts; and a guard that fails the
sweep if a test file is wired into no npm script.

**Legacy commits included:** `f41e8e7`, `08e2e08`, `0ded573`, `bca6486`, `d777bdf`, `898a109`, `09e8d4b`,
`0feb2c9` — plus one adaptation commit of mine (`6cff8ee`).

**Conflicts hit and how they were resolved.**
- `server/package.json` (×3), `server/src/agents/runner.ts`, `server/src/orchestrator/director.ts` — all
  "both sides added adjacent lines". Kept both, taking only the scripts belonging to *this* feature.
- `director.ts`: upstream and the fork each had their own doc comment for the cap message. Upstream's
  kept; the fork's `recoverFromStall()` inserted above it.
- `f014ea5` was **skipped** — see §5.1.

**Adaptations I had to make (please sanity-check these).**
- `restartResumeRecovery.itest.ts` needed `StubAccounts.setSpreadUsage()` — upstream's `ThreadManager`
  constructor boot-applies the spread-usage setting, which the fork-era stub predates. Without it the
  harness throws before the first assertion.
- The orphan guard immediately flagged **two pre-existing upstream orphans**: `gitService.itest.ts` and
  `grokUsage.test.ts` ship on master wired into no script. I wired both (`test:git`, `test:grok-usage`);
  `test:grok-usage` is in GATES, `test:git` is scripted but not gated (slow, matching the fork).
- `check-orphaned-tests.cjs`'s ALLOWLIST is now **empty**. Its only entry excused
  `restartResumeRecovery.itest.ts` by citing `DEV-ISOLATION.md`, a fork-internal doc we are not porting —
  a dangling reference. The test is free (real Db, no agent), so it runs as a gate instead.

**Verification.** typecheck ✓ · build ✓ · **21/21 gates** ✓ · orphan check clean (25/25 wired).

**Recommendation: merge as-is.** It is the lowest-risk, highest-value branch and several later branches
build on it.

---

### 3.2 `port/director-wake` — 2 commits, 14 files, +613/−2

**What it ports.** When a task reaches a terminal state (done / needs-review / failed), the director now
messages you with the outcome instead of waiting to be asked. A debounce window coalesces a burst of
completions into one turn; a dedup set stops the same (task, state) being announced twice; it never
interleaves a live turn. Gated by a new `directorWakeOnComplete` setting (on by default).

**Legacy commits included:** `95303c3`, plus the `directorWake.ts` follow-ups from `f014ea5` and the rule
doc from `c02b55a`, folded into one adaptation commit.

**Conflicts hit and how they were resolved.** `config.ts`, `index.ts`, `director.ts`, `threadManager.ts`,
`package.json` — all adjacent-add. In `threadManager.setState` upstream's `dropTerminalBookkeeping` call
and the fork's `announceSettled` calls were combined (both kept, upstream's ordering preserved).

**⚠ The one thing to know.** `Director.deliverWake()` on the fork resets `this.stallRetries` — a field owned
by the **watchdog on branch 1**. To keep this branch self-contained I dropped that line. **Merging branch 1
first and then this one re-adds it during conflict resolution** (§4 step 2). If you merge this branch
*without* branch 1, nothing breaks — the field simply doesn't exist.

**Verification.** typecheck ✓ · build ✓ · **19/19 gates** ✓ (`test:director-wake` newly registered — it is
free: no SDK, no network, injected `isBusy`/`deliver`).

**Recommendation: merge as-is, after branch 1.**

---

### 3.3 `port/self-update-restart` — 2 commits, 11 files, +928/−16

**What it ports.** A **Restart button in the top bar** (with a confirm popover) and a "New changes are
ready → Restart?" banner that appears when shipped code is on disk but the running process hasn't loaded
it. The server gets `POST /api/restart` and a restart ladder: process-supervisor → script-hub → in-process
self-re-exec → *honest* "I can't restart myself, here's the exact command". `/api/health` gains a
per-process `bootId` so the client can **prove** a real bounce happened rather than silently reloading onto
the same old process.

**Legacy commits included:** `70db7c3`, `44519d0`.

**Conflicts hit and how they were resolved.**
- `server/src/update.ts` — the fork's `restartViaHub`/`performRestart` region. Resolved by keeping
  upstream's `scheduleSupervisedRestart` and grafting the fork's ladder on top, **then adding a
  `supervised()` first rung** so a bounce under `server/scripts/supervise.cjs` (which upstream already has)
  is a clean `exit(75)` respawn rather than a re-exec fighting the supervisor. That is the fork's own final
  shape; I reproduced it by hand because the commit that introduced it (`f014ea5`) is skipped (§5.1).
- `web/src/components/NoticeBanner.tsx` — the fork's banner is a 3-tier component whose tier-1 is the
  **token-freeze banner from branch 4**. I ported only the restart tiers; upstream's simple notice
  rendering is retained underneath. Merging branch 4 does not conflict with this.
- `restart.itest.ts` was taken at its final fork state so it covers the supervisor rung.

**⚠ Caveat — this is my one deliberate deviation from PORT-INVENTORY, and it needs your call.**
PORT-INVENTORY lists `44519d0` under §4.3 (crash-resilience). It is really the tail of a five-commit
self-update chain, so I split it out (§5.2) and **dropped the fork-topology half**:
- **Dropped:** `82dca86` (merge upstream via a merge-commit instead of `--ff-only`) and `0219d9d` (pull
  `@{push}` instead of `@{u}`). Both exist *only* because the old fork's history was rewritten and shared
  no ancestry with Fearce. **This repo is a clean clone that does share history with upstream**, and it has
  no writable origin yet — so `@{push}` is unset and upstream's existing `git pull --ff-only` is correct.
  Porting `mergeUpstream` would ship ~200 lines of dead workaround.
- **Consequence:** the "update available" badge still works exactly as upstream ships it. If you later add
  a writable origin *and* want the badge to merge Fearce forward with a merge commit, that logic is still
  in the legacy repo at those two SHAs.

**Verification.** typecheck ✓ · build ✓ · **20/20 gates** ✓ · **real browser drive** on a throwaway
instance: Restart button renders in the top bar, confirm popover appears, `POST /api/restart` returns
`needsManualRestart` with the exact manual command, and the UI shows a **persistent** error banner with
Retry/Dismiss — never a silent no-op. Separately confirmed the supervisor rung by observing the throwaway
process exit with code **75**.

**Recommendation: merge with caveat** — merge the branch, but confirm you're happy dropping the
fork's upstream-merge machinery. If you want it, say so and it's a separate small port.

> **Operational note (bit me during testing, will bite an agent later):** a throwaway instance's Restart
> button reaches the **real** script-hub on `:3939` and tries to bounce **prod**. Always run throwaway
> instances with `SCRIPT_HUB_URL` pointed at a dead port. Also, agent shells inherit `ORCH_SUPERVISED=1`
> from prod, so set `ORCH_SUPERVISED=0` (not empty — Windows drops empty env vars) to exercise the other
> rungs.

---

### 3.4 `port/token-limit-pause` — 3 commits, 11 files, +1087/−38

**What it ports.** When the operator token-safety limit trips, in-flight tasks are **paused**
(non-terminal, marker `⏸ Paused — token safety limit`) instead of cancelled. The implementor SDK session
and on-disk WIP survive; a restart leaves them intact; and at the real window reset they auto-resume
stage-correctly when "Auto-resume on token reset" is on. A **manual** pause carries no marker and is never
auto-resumed — the two tracks deliberately never cross. Board cards distinguish the two.

**Legacy commits included:** `3e086f7`, `a368989`, `4f984ff`.

**Conflicts hit and how they were resolved.**
- `threadManager.ts` — four conflicts. The important one: the fork's `CAP_PARK_QA_MARK = "(QA runs on
  Claude)"` vs upstream's newer `"(QA stage)"`. **Upstream wins** (its `resumeCapParked` no longer gates on
  the string at all); only the new `TOKEN_LIMIT_PAUSE_PREFIX` was added. The fork's `cancelled()` →
  `stopped()` guard rename was applied at the two pipeline-loop sites upstream had added since.
- `CLAUDE.md` — the fork's triage paragraph was kept, minus its `why-ended.cjs` pointer (that script lives
  on branch 1; after both merge, the pointer is valid again and worth re-adding).
- `server/scripts/why-ended.cjs` — dropped here (branch 1 owns it).
- `tokenFreezeResume.itest.ts` — taken at its final fork state (645 lines vs upstream's 412). I diffed the
  two: the fork's is a **superset**; the only upstream content not carried over is the old file header.
- Same `StubAccounts.setSpreadUsage()` adaptation as branch 1, in `tokenLimitPause.itest.ts`.

**Verification.** typecheck ✓ · build ✓ · **19/19 gates** ✓ (`test:token-pause` 43 assertions,
`test:token-freeze` 44 assertions). **Real browser drive:** seeded one token-limit-paused task and one
manually-paused task into a throwaway DB — the board renders the first as `PAUSED — RESUMES AT RESET` and
the second as plain `PAUSED`, which is exactly the distinction the feature exists to make.

**Recommendation: merge as-is.**

---

### 3.5 `port/run-hub-projects` — 8 commits, 25 files, +4072/−5

**What it ports.** Two related things:
- **Projects layer** — the flat task board regrouped by repo. A skimmable home grid, then a per-project
  page with a re-entry brief, an editable Now/Next/Later roadmap with hill-chart status (persisted
  server-side in a new `project_meta` table), and a real history timeline. Plus a "re-entry peek"
  slide-over reachable from the task board without leaving it.
- **Run Hub** — one-click launch of orchestrator-built apps from a per-repo `.orchestrator/run.json`
  recipe, surfaced as an inline play-triangle launch icon on task and project cards.

**Legacy commits included:** `b3b4054`, `a6692dc`, `3af47af`, `ebd6f71`, `9feb91b`, `d51bd36`, `9097e60`,
the `projectsEnabled` half of `8164ea2`, plus two commits of mine (`c0e7a67` repair, `56980aa` gate + recipe).

**Gated OFF by default.** `8164ea2` (fork, 2026-07-24) adds `projectsEnabled`/`costsEnabled` so these
fork-only surfaces are opt-in and the base console matches upstream. It **post-dates PORT-INVENTORY**, so
it isn't on the port list — caught in review. It's split across the two branches it gates: this one carries
`projectsEnabled`, branch 6 carries `costsEnabled`, and merging both reproduces `8164ea2` in full. Without
this the Projects button would land in everyone's top bar by default.

**Launch recipe dropped entirely.** `ff62ab0` points `.orchestrator/run.json` at
`http://dev.orchestrator.localhost/`, which only resolves through the Caddy proxy in `infra/caddy` —
dropped per PORT-INVENTORY §4.8. Shipped as-is that's a dead Run button. I first re-authored it as a `web`
recipe on the Vite dev port (`56980aa`), which was **also wrong** and Fen caught it (`f9e3724`): root
`npm run dev` is `concurrently dev:server dev:web` and `dev:server` **listens on the prod port `:4317`**,
and even with `:4318` already up `vite.config.ts` proxies `/api` and `/ws` straight to `:4317`. Either way
the button boots or drives production, which is precisely what `run-hub-recipe.md`'s hard rule forbids.
The recipe is therefore **removed**, per that rule's own closing line: *no recipe is better than a dead
button*. The rule text was updated with the reasoning so nobody re-authors it a third time.

**Conflicts hit and how they were resolved.**
- **Skipped the demo commit `2bce56a`** (`ProjectsDemo.tsx`, a mock-data hash-route preview that `b3b4054`
  deletes anyway) — it only added churn.
- `db.ts`, `protocol.ts`, `hub.ts`, `store.ts`, `types.ts` (both copies) — several conflicts split a type
  or function **mid-construct**, producing syntactically broken merges that I re-spliced by hand against
  the legacy source. All caught by typecheck.
- `Board.tsx` — upstream's `BoardTabs` (Tasks ⇄ Scheduled Tasks switcher) vs the fork's `ReEntryButton`.
  Both kept: the button is grafted into upstream's `board-head-right` group.
- `Board.tsx` — the fork's extracted `CardActivity` component was **dropped**. Upstream renders the same
  activity line inline *and* adds `activityPreview()` (which collapses multi-line Grok QA feeds). Upstream's
  is strictly newer; keeping the fork's would have been a regression, and keeping both left dead code.
- `main.tsx` — kept upstream's `createRoot(...).render(...)`; the fork's `const root = …` split existed only
  for the skipped demo's hash routing.
- **`styles.css` — the one that nearly shipped broken, worth knowing about.** Cherry-picking split several
  CSS rules mid-block, which silently swallowed **61 Projects-layer selectors**. It still typechecked and
  still built; the feature would simply have rendered unstyled. Rather than patch the interleave, commit
  `c0e7a67` reconstructs the file deterministically: upstream's sheet verbatim, then every fork-only rule
  appended in fork order under one banner. Proven by a selector-set diff in **both** directions — 0 upstream
  selectors lost, 0 fork selectors missing, 285 fork rules appended.

**Verification.** typecheck ✓ · build ✓ · **20/20 gates** ✓ (`test:workspace`, `test:runhub` registered).
**Real browser drive:** Projects button renders and is correctly styled (computed height/gap/radius match
the ported rule), the full-view takeover opens and closes, the re-entry button is on the board, and
`GET /api/runhub/projects` answers with a list.

**Recommendation: merge as-is.** Largest diff of the six, but almost entirely new files.

---

### 3.6 `port/token-metrics-dashboard` — 5 commits, 30 files, +2974/−10

**What it ports.** A live token-cost dashboard (a "Costs" top-bar view showing real-time spend, per-task
and per-stage token breakdown with the cache split, current burn and trend), the schema to back it
(per-run token columns on `agent_runs`, a new `director_runs` table so director turns are accounted too),
a CLI `npm run token-report`, and an **A/B variant tag** setting that stamps every dispatched task and
director turn so two configurations can be measured head-to-head.

**Legacy commits included:** `16562e4`, `4abaf3b`, `51a38a1`, `730c994`, `e6b08d6`, plus the
`costsEnabled` half of `8164ea2` (see branch 5 — the Costs button is **hidden until you toggle it on**).

**Conflicts hit and how they were resolved.**
- The fork built this *after* the wake feature and *after* the Projects layer, so its diffs carry both as
  context. I stripped the `directorWakeOnComplete` lines (branch 2 owns them) and all
  Projects/`ProjectsButton` content (branch 5 owns it), keeping only the dashboard's own
  `ActiveView = "console" | "dashboard"`.
- `director.ts` — the fork's `startOrSend()` extraction belongs to the wake feature; only the metrics
  fields and the `turnStartedAt` stamp were taken, inlined into `handleUserMessage`.
- `schema.ts` — upstream already has `baseline_head`; only `variant` was new.
- Two merges misfiled a field (`variant` landed on `ScheduledTask` instead of `Thread`) and dropped a
  `break;` / a JSX self-close. All three caught by typecheck and fixed.

**Verification.** typecheck ✓ · build ✓ · **21/21 gates** ✓ (`test:run-tokens`, `test:token-report`,
`test:live-metrics` registered). **Real browser drive:** the Costs button renders, the dashboard takeover
opens and hides the board, it toggles back, and the "A/B variant tag" row is present in Settings.

**Recommendation: merge as-is.** Merge it **last** — it is the branch that most depends on the others'
shape.

> Two fork investigation write-ups ride along at the repo root on this branch —
> `TOKEN_USAGE_INVESTIGATION.md` and `TOKEN_INSTRUMENTATION_FOLLOWUP.md`. The second lists real follow-ups
> for this feature; the first is a dated report. **Delete both if you don't want fork process docs at the
> root** — nothing references them.

---

## 4. Suggested merge order (validated end-to-end)

```
1. port/crash-resilience
2. port/director-wake
3. port/self-update-restart
4. port/token-limit-pause
5. port/run-hub-projects
6. port/token-metrics-dashboard
```

**Why this order.** Branch 1 introduces `Director.stallRetries` and `config.directorWatchdogMs`, which
branch 2 wants. Branch 3 touches the same `update.ts`/`index.ts` region branch 1 does, and is easier once
branch 1's diagnostics are in. Branch 4 changes `threadManager`'s boot sweep, which must sit *around*
branch 1's restart-recovery block. Branch 5 establishes `activeView` + the Projects view; branch 6 only
extends that union — doing 6 before 5 forces you to re-derive it.

**I actually ran this cascade** on a throwaway branch, resolved every conflict, and verified the result:
**typecheck clean, build clean, 30/30 gates, 0 orphaned tests.** The throwaway branch was deleted; here is
what you will hit at each step.

| Step | Conflicts | Resolution |
|---|---|---|
| 1. crash-resilience | *none* | — |
| 2. director-wake | `run-gates.cjs`, `config.ts` | Union both (each side adds one entry). **Then re-add `this.stallRetries = 0;` in `Director.deliverWake()`** — see §3.2. |
| 3. self-update-restart | `package.json`, `run-gates.cjs` | Union both. Watch the JSON comma between the two added script blocks. |
| 4. token-limit-pause | `CLAUDE.md`, `package.json`, `run-gates.cjs`, `threadManager.ts` | Union the first three. In `threadManager`'s boot sweep put the **`isTokenLimitPaused(t)` guard first**, then branch 1's stalled-auto-resume re-adoption block. |
| 5. run-hub-projects | `package.json`, `run-gates.cjs` | Union both. |
| 6. token-metrics-dashboard | `package.json`, `run-gates.cjs`, `index.ts`, `director.ts`, `threadManager.ts`, `types.ts`, `protocol.ts`, `App.tsx`, `store.ts`, `SettingsPanel.tsx`, `web/types.ts` | The big one. Union most of it, then fix six spots — see below. |

**Step 6 in detail.** Union resolves the bulk, but a naive union duplicates a few things because both
branches inserted next to the *same* anchor (`maxConcurrentPerRepo`). Fix these six:

1. `ActiveView` → `"console" | "projects" | "dashboard"`.
2. The `App.tsx` view switch → `projectsEnabled && activeView === "projects" ? <Projects /> : costsEnabled && activeView === "dashboard" ? <TokenDashboard /> : <Board />`.
3. `App.tsx` — one `const activeView = useStore(…)` hook (union leaves two); and re-close `ProjectsButton`
   (`</button> ); }`) before `DashboardButton` — the union splices the two functions together.
4. `SettingsPanel.tsx` — the two "Features" `ToggleRow`s get glued into one element. Split them
   (`/>` + `<ToggleRow`) so Projects and Costs are separate rows in the same `Group`.
5. `threadManager.settings()` and `protocol.ts`'s `settings.set` — drop the duplicated
   `maxConcurrentPerRepo` / `selfImproveEnabled` entries the union carries in twice.
6. `web/src/types.ts` — same duplicated pair; and make sure `DEFAULT_SETTINGS` in `store.ts` keeps
   `directorWakeOnComplete: true` alongside the two new `false` flags.

All six are caught by `npm run typecheck` — resolve, typecheck, repeat.

After the final merge, re-run `npm run typecheck && npm run build && npm run test:gates --prefix server`
— you should see **30/30**.

---

## 5. Deviations from PORT-INVENTORY (please review these four)

### 5.1 Part of §4.3 is already upstream, under a different SHA — `f014ea5` skipped
PORT-INVENTORY derived its list from a 3-way merge-base diff, which reports a commit as "fork-only" when
its **SHA** isn't an ancestor of upstream. But several fork changes were upstreamed to Fearce as separate
commits, so the *content* is already on master. Verified byte-identical between `master` and
`legacy/master`: `server/scripts/supervise.cjs`, `supervise.itest.cjs`, `server/src/crashLog.ts`,
`server/src/tests/crashLog.itest.ts`.

Consequently `f014ea5` ("supervise the server + capture crash evidence") is **subsumed**: master already
has the supervisor, the enriched crash log, `describeActiveWork()`, and both OOM leak bounds
(`MAX_STDOUT_BUF`, `MAX_INPUT_QUEUE`). Cherry-picking it *duplicated* `MAX_INPUT_QUEUE` and broke the
build, so it was skipped. Its only two non-subsumed pieces were ported deliberately elsewhere: the
`DirectorWakeQueue` dedup bound (branch 2) and the supervisor rung of `performRestart` (branch 3).

**No action needed** — flagged so you don't go looking for it.

### 5.2 §4.3's `44519d0` is really a separate feature — split into branch 3
`44519d0` is a *fix* on top of an unported four-commit chain (`d21b6b2`, `70db7c3`, `82dca86`, `0219d9d`).
Porting it alone would have been a half-feature; porting the chain inside "crash-resilience" would have
mislabelled ~500 lines of self-update code. It is now branch 3, with the two fork-topology commits dropped
— rationale and consequences in §3.3. **This is the one deviation that wants an explicit yes/no from you.**

### 5.3 `8164ea2` post-dates PORT-INVENTORY and had to be added
The inventory was generated on 2026-07-24; the fork's `8164ea2` ("gate the Projects and Costs surfaces
behind toggles") landed at 23:15 that evening, so it is on neither the port list nor the drop list. Without
it, branches 5 and 6 would have put two fork-only nav buttons into the default console. Ported, split
across the two branches it gates (§3.5, §3.6). **Found by Hilda in review, not by me** — worth knowing that
the inventory has a cutoff, and any fork commit after 2026-07-24 ~13:00 needs checking by hand.

### 5.4 Upstream's design won at every genuine overlap
Per PORT-INVENTORY §5, where both sides evolved the same code I kept upstream's newer version: the office
peer-gating in `threadManager`/`prompts.ts` (the fork's office edits are **not** ported at all),
`CAP_PARK_QA_MARK`, `AUTO_RESUME_STATES`, `Board.tsx`'s `activityPreview` activity line, and upstream's
`CLAUDE.md`/`README.md` where the fork's text was environment-specific.

---

## 6. Dropped — not ported (veto any of these and I'll port it)

| Dropped | Rationale (from PORT-INVENTORY unless noted) |
|---|---|
| Upstream auto-sync tooling (`a097cc4`, `docs/upstream-sync.md`) | Already reverted on the fork by `612e68b`; a re-baselined repo shouldn't auto-sync. |
| `infra/caddy/**` | A Caddy local-domains reverse proxy (Windows service + watchdog) — machine-specific ops, not an orchestrator feature. Keep in a separate ops repo. |
| `infra/bet-tracker/**` | An always-on Supabase tracker for a downstream project — belongs to that project, not here. |
| `design/explorations/2026-07-23*/**` | 19 static HTML/CSS reskin mockups. Design reference only; pull ideas from them if you reskin, don't ship the files. |
| The fork's office-coordination edits | **Superseded** — upstream's `0dc9ae9` peer-gating is the newer design (PORT-INVENTORY §6). |
| `mergeUpstream` / `@{push}` update source (`82dca86`, `0219d9d`) | *My addition to the drop list.* Fork-topology workaround for a rewritten history with no common ancestor. This repo is a clean clone with shared history and no writable origin, so it is dead code here. See §3.3. |
| The Projects **demo** commit (`2bce56a`) | *My addition.* Mock-data preview deleted two commits later by `b3b4054`; picking it added conflicts and no value. |
| The fork's `.orchestrator/run.json` (`ff62ab0`) | *My addition.* Its `dev.orchestrator.localhost` URL needs the dropped Caddy proxy, and every local rewrite reaches the prod `:4317` (see §3.5). Removed: this repo ships no launch recipe for itself. |
| Fork process docs (`HANDOFF.md`, `DEV.md`, `DEV-ISOLATION.md`, `UPSTREAM-MIGRATION-HANDOFF.md`, `docs/*`) | Fork-history artifacts. Only the rule docs paired with a ported feature came along (`run-hub-recipe`, `notify-on-thread-terminal-state`, `add-a-live-pane`, `ab-token-measurement`, `verify-server-route-or-ui`). |
| `token_freeze_monitor.cjs`, `TOKEN_FREEZE_FINDINGS.md` | Investigation scratch; the *behaviour* is ported on branch 4 (PORT-INVENTORY §4.5). |
| Deleting `server/src/git/readonlyGit.ts` / `server/scripts/fix-stuck.cjs` | The fork deleted these; upstream still uses `readonlyGit` for the reader lane's `git_read`. Not replayed. |

---

## 7. Housekeeping done on `master`

- **Stray root `package-lock.json` removed and gitignored.** Upstream tracks only `server/package-lock.json`
  and `web/package-lock.json`; the root `package.json` exists solely for `concurrently`, and the documented
  root `npm install` regenerates a lockfile upstream has never tracked. `/package-lock.json` is now in
  `.gitignore` with the reasoning inline, so it stops showing up as stray noise. Verified: after a fresh
  root `npm install`, `git status` is clean.
- `master` contains **only** the upstream baseline + `PORT-INVENTORY.md` + this file + that `.gitignore`
  line. No port branch has been merged into it.

---

## 8. Verifying any branch yourself

```bash
git checkout port/<name>
npm run install:all && npm install       # only needed once per checkout
npm run typecheck && npm run build
npm run test:gates --prefix server       # expect ≥18; each branch adds its own
node server/scripts/check-orphaned-tests.cjs   # on port/crash-resilience and later
```

A green build does **not** prove a cherry-pick port is complete (that's how 61 CSS rules nearly
shipped missing, §3.5). To check content rather than compilation, without checking anything out:

```bash
bash ~/Claude/tools/port-audit.sh -b master port/<name>
```

It reads the branch's own `(cherry picked from …)` trailers and reports any rule or exported symbol
a picked commit added that the branch lacks. All six branches are clean as delivered.

To drive the UI, use a throwaway instance — **never 4317/4318, never the live DB**:

```bash
PORT=4327 HTTPS_PORT=0 DATA_DIR=/tmp/orch-check AUTH_PASSWORD=testpw123 \
  ORCH_SUPERVISED=0 SCRIPT_HUB_URL=http://127.0.0.1:59997 \
  node server/dist/index.js
```
