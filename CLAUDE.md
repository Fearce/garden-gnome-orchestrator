# claude-orchestrator

## 🔑 BROWSER-TEST LOGIN — READ THIS FIRST (agents: stop rediscovering it)
The web app at `:4317`/`:4319` is password-gated. **The password is the `AUTH_PASSWORD` line in
`server/.env`** — read that one line (`grep AUTH_PASSWORD server/.env`) instead of spelunking the
auth code. To authenticate a Playwright (or curl) session, POST it to `/api/login` to mint the
session cookie, then reuse that context:
```js
// Playwright: get the authed cookie, then navigate.
const pw = process.env.AUTH_PASSWORD; // or read it out of server/.env
await page.request.post("http://127.0.0.1:4317/api/login", { data: { password: pw } });
await page.goto("http://127.0.0.1:4317/");   // now past the login gate
```
```bash
# curl: save the cookie jar, then hit authed routes with it.
PW=$(grep -E '^AUTH_PASSWORD=' server/.env | cut -d= -f2-)
curl -s -c /tmp/cj.txt -X POST http://127.0.0.1:4317/api/login -H 'content-type: application/json' -d "{\"password\":\"$PW\"}"
curl -s -b /tmp/cj.txt http://127.0.0.1:4317/api/threads
```
(Google sign-in also works, but the password is simplest for headless agents. Local/LAN only.)

A director's console for running Claude Code agents: a provider-neutral **director** enriches a
prompt, runs a planner + researcher, then dispatches Opus 5 **implementor** workers you
can inject into mid-work. Node/Fastify API (`server/`) + React/Vite console (`web/`), single origin.

**Read lane (`dispatch_read`).** A pure read-only lookup ("read HANDOFF.md and report it", "which
model does role X use", "explain how Z works") can skip the whole planner→implementor→QA pipeline:
the director dispatches it with `dispatch_read`, which runs ONE cheap **reader** (Sonnet) that answers
by posting a finding — read-only enforced at the harness level (Read/Grep/Glob + an allowlisted
`git_read`, no Write/Edit/Bash), no QA. The reader **escalates rather than half-answers**: anything
needing an edit/build/verification/broad investigation gets a "needs full pipeline" finding and parks
for a normal re-dispatch. Bias toward the full `dispatch` when unsure — misrouting to Opus is safe,
misrouting a real task to the reader is not. The card shows a **READ** badge. See ARCHITECTURE.md §5.

**Auto-review (`thread.autoReview`).** A task parked in `review` is waiting on Kevin; the detail
panel's "Auto-review & mark done" button delegates that call to one **reviewer** agent (Opus,
read-only + Bash, `docs/ARCHITECTURE.md` §5). It flips the thread to `reviewing`, verifies the work,
`ask_user`s Kevin about anything only he can decide, then settles the task `done` or hands it back to
`review` with its reasons — an errored/verdict-less run always re-parks, never accepts (its two involuntary
stops are recovered first, sharing one in-process budget of 2: a turn-ceiling cutoff continues the session it
made progress in — on the backend that holds it, since a review can run on Claude or, when every sub is
capped, z.ai — and an empty run, or a session whose backend is now capped, starts the review over).
**A hand-back isn't the end of the lane:** the reviewer is read-only, so what blocks a task is usually
implementor work — an `accept: false` carrying concrete `issues` relaunches the implementor with that
list (no QA loop; the reviewer is the gate), then
warm-resumes the reviewer to re-check and decide again, bounded by the `maxReviewFixRounds` setting
(default 1, `0` = old behavior). A failed fix round parks, never accepts — a cap there parks WITHOUT the
`⏳ Auto-resume pending` marker on purpose, since the supervisor would resume it through the QA loop and
could mark it done on a verdict the reviewer never gave. The round runs under `implementing` with a durable
`reviewFixing` marker so a restart re-parks it for a fresh click instead of reviving it into the pipeline,
and the inject/resume gates key on the episode (not the state) so nothing spawns a second implementor in
the window where the fix run has ended but the state hasn't flipped back. So `done` has three
sources: QA, a manual Mark done, and an accepted auto-review. Gate: `test:auto-review`.

## Run / build
- Dev (hot reload): `npm run dev` at repo root — tsx-watch server + Vite web.
- Prod: `npm run build` (web then server) → `npm start` runs `node dist/index.js` from
  `server/`, serving the built `web/dist` + WS/REST API.
- Typecheck: `npm run typecheck`. Data: `server/data/orchestrator.sqlite`. Crash stacks:
  `server/data/crash.log` (written by the process guards in `server/src/crashLog.ts`).
- Full free gate suite: `npm run test:gates` from the repo root. It streams terse progress and writes
  the complete transcript to `server/data/gates-last.log`.
- **Build/typecheck suddenly fails with `Cannot find module '@anthropic-ai/claude-agent-sdk'` (a wall of
  TS2307s) or `'tsc' is not recognized`?** Not your diff — a concurrent/interrupted `npm install` left
  `server/node_modules` PARTIAL (common here: many agents share one checkout). Fix: `npm install --prefix
  server` (~7s; the pure-JS SDK + `.bin` shims re-add with no EBUSY even while prod runs), then re-run
  typecheck before assuming your code broke. This also silently blocks QA (its build fails the same way).
- Serves `http://127.0.0.1:4317` and `https://127.0.0.1:4319` (same routes; the TLS port
  exists so the HTTPS Dashboard Deck can iframe it without mixed-content blocking).
  LAN access is auth-gated via `server/.env` (`AUTH_PASSWORD` / Google). Local/LAN only.

## Deploying a change — DO IT YOURSELF, don't defer
**If you changed server code, you deploy it before handing off — by restarting the orchestrator
yourself, in the same turn. Do NOT end a turn with "needs a restart to go live" or ask the owner
to restart. Bouncing is FINE: keepAlive + auto-resume bring every in-flight task (including you, if
you're a worker) back on the freshly-built code.** A worker restarting its own parent is the designed,
supported flow — the rebooted server auto-resumes you with a note saying the restart already
completed (so you won't loop). Un-deployed hand-offs are the recurring complaint; don't be the cause.

How to restart depends on how it's running:

**macOS / Linux (local dev — `npm run dev` or `npm run serve`):** no script-hub, no keepAlive.
- Web-only change: don't restart — `npm run build --prefix web` then reload the browser.
- Server change under `serve` (no watch): stop the process and re-run `npm run serve`.
- Under `npm run dev` (`tsx watch`): editing `server/src` already hot-restarts it — but that
  KILLS in-flight tasks, so use `serve` when real pipelines are running.

**Windows (script-hub production deployment):** runs as script-hub id **`claude-orchestrator`** with
keepAlive armed. Implementor workers are **child processes of this server** (the Agent SDK spawns the
`claude` CLI — `server/src/agents/runner.ts`), so:
- **Server change? `npm run deploy --prefix server`** — it builds, stamps, issues the atomic hub restart
  and verifies a NEW pid came up on HEAD. **Use it instead of building by hand**, because the right build
  depends on `git status` and gets it wrong in both directions: a plain `npm run build` compiles the DIRTY
  tree, so it ships a sibling's uncommitted, un-QA'd server code live under your deploy; the HEAD-only
  archive recipe avoids that but is ten calls and a junction that deletes `server/node_modules` if removed
  wrong. `deploy` picks per half, on what actually COMPILES in (`server/src` — a dirty lab/doc/probe does
  not count), names what it excluded, and refuses to rebuild `web/dist` from someone else's WIP.
  `-- --plan` prints the decision and touches nothing; `-- --verify` (no build, no bounce) answers "is my
  change live?" and is what the auto-resumed session runs, since the restart kills you. Gate:
  `test:deploy-plan`. By hand it is `POST http://127.0.0.1:3939/api/restart {"id":"claude-orchestrator"}`
  (atomic: runs in the hub, outside this server's tree, survives the caller, re-arms keepAlive).
- **Never use stop+start** (`script-hub stop` / the launcher's `stop`): it disarms keepAlive AND
  tree-kills the whole process — including the worker issuing it — so the follow-up `start` never
  runs and nothing resurrects it. Use the atomic `/api/restart` above, which is exactly why it exists.
- **Web-only change?** Skip the restart — `web/dist` is static; `npm run build --prefix web` then
  reload the browser.
- If a restart doesn't pick up server changes, a stale/orphaned process may still hold :4317 —
  check `Get-NetTCPConnection -LocalPort 4317` and kill the old PID, then restart.
- **`/api/restart` silently no-ops when the :4317/:4319 PID is elevated** — the hub can't kill it, so
  the response is `ok:false` with `stop.killed:[]` and start `skipped:"already-running"` (HTTP 200, no
  `errors` — looks fine, ships nothing). Self-elevate the kill (`Start-Process powershell -Verb RunAs
  -File <kill.ps1>` → `Stop-Process -Id <pid> -Force`), then let **keepAlive respawn** the fresh build —
  verify a NEW listener appears on :4317; don't manually `start` it (that races keepAlive into a
  double-bind). Deploy from a **detached** elevated script, not this process tree: you're a child of
  :4317, so killing it kills your shell before it can heal — the auto-resumed session verifies after.

## Debugging a failed task
State + run history live in `server/data/orchestrator.sqlite` (open read-only with the bundled
`better-sqlite3`; columns are snake_case — `agent_runs.thread_id/started_at/ended_at/session_id`, the
subscription is `account` (not `account_label`), message text is `messages.content` (not `text`), and a task's
saved stage outputs are a JSON blob in `threads.stage_outputs` — there is NO `thread_stage_outputs` table;
there's NO `backend` column — the backend is encoded in `model`, e.g. `grok-4.6`/`gpt-*-sol`/`claude-*`.
`agent_runs.cap_flagged` is what the RUNNER concluded about a cap — 1/0, null when no verdict was recorded
(a row predating it, or one a restart/silent-run stamp closed out) — so "was this a quota or a crash?" is a
read, not an inference from absent findings and expiring kv latches; `probe:task-runs` prints it).
For one task's full trail + per-model cost/turn totals + a QA-loop budget check, run
`npm run probe:task-runs --prefix server -- <thread-id|title-substring>` (read-only, safe while prod is up).
Read its QA-loop check as written: the budget is the durable `qaRoundsUsed` vs `maxQaRounds`, NOT the QA
run count — a turn-ceiling continuation, an empty-run retry and a cap failover each spend a *launch* while
recovering one *round*, so launches legitimately exceed the cap. And when `qaAppliesFixes` is on (it is, in
prod), QA edits the tree itself and hands each changed pass to a VERIFIER QA pass, so **many QA runs against
one implementor run is the designed shape, not a stuck loop** (`.claude/rules/qa-fixes-mode.md`).
To triage ALL non-done runs in a window instead of one task — which errors are real vs. an expected
cutoff/cap/retry/restart, and did the handling mechanism actually run — use
`npm run probe:run-errors --prefix server [-- <hours>]` (its classifier also backs health's `non-done
reasons:` line). For **"what is parked in `review`, and does any of it need a human?"**, run
`npm run probe:parks --prefix server` — it names every parked task (id, age, reason, last run) and splits
them into a **stalled** pipeline (QA/auto-review/resume stopped mid-verification; a Resume or Auto-review
clears it, nothing else will), an owner **verdict** wait (by design, however old), a **capWait** the cap
supervisor owns, and **unknown** wording that drifted from the classifier. It then does the same for the
OTHER state that waits on a person — tasks abandoned in **`failed`** by a restart, which no sweep step read
until 2026-08-10: **promised** (still claiming "auto-resuming…", i.e. a resume that never arrived — the one
to act on), **clickResume** (handed back by design), **otherFailure** (unclassified). For a **subscription/account-chip** question ("why does it say idle / limited / 0% / a wrong %?"), run
`npm run probe:accounts --prefix server` — it dumps each account's persisted `account_usage_*` state
(5h/7d usage + resets, `holdUntil` stagger-hold, `extWakeAt` outside-consumer mark) with plain-English
reads, then the **failover ladder**: Codex/Grok/z.ai availability from their `setting_*_enabled` +
`*_cap_until` kv keys AND their own `data/<x>-usage-cache.json` meters, plus a ladder-depth line (nothing
counts as a rung while either window is ≥98% — a sub OR a backend, latch or no latch). **A ChatGPT plan is
not ONE allowance**: `account/rateLimits/read` also returns `rateLimitsByLimitId`, a dedicated pool per
model that ships its own (GPT-5.3-Codex-Spark, live limitId `codex_bengalfox` — an opaque codename, so
`agents/codexPools.ts` maps model→pool by normalizing `limitName`, never the id). Those pools have their
own 5h/weekly windows, their own resets and their own cap latches (`codex_pool_cap_until`), and a cap in
one must NEVER be read as a cap in the other. They serve only reader/planner/researcher — a capability
rule, not thrift: the CLI ships Spark instructed never to verify its own work or run tests, and 128K
context against the flagships' 272K, which makes it wrong for the implementor and unsafe for QA. The
probe prints them under the ladder; gate `test:codex-pools`.
"idle" is a stagger hold-off (GG parked its OWN 5h restart and stops pinging), NOT a globally
unused sub — a 2nd orchestrator/service sharing the sub burns it while GG is held-blind (`accountManager.ts`).
To SEE a chip in a given state (a lapsed weekly, a hold, a stale read) instead of only reading its numbers,
`npm run chip-lab --prefix server` boots a throwaway instance with bogus tokens + a seeded snapshot and
renders the strip headlessly (`--list` for scenarios) — no quota, no effect on prod's real windows.
Read the run trail to tell causes apart:
- run `state='interrupted'` → a **server restart** killed it (`markInterrupted`), not the agent. A
  thread whose `error` starts with "interrupted by a server restart" died to a bounce; actively-running
  phases now **auto-resume on boot** (crash-loop guarded — repeated <60s deaths stop it). That resume is
  armed by a 4s in-memory timer, so a SECOND bounce inside the window used to lose it for good (the thread
  is `failed` by then, which the IN_FLIGHT scan skips); the next boot now re-arms from the persisted
  "auto-resuming…" promise, up to 3 attempts and only while the promise is <24h old — past either bound it
  says so and waits for a click. Gate: `test:restart-revival`. Two rounds are
  exempt because they run on ALREADY-accepted work and are keyed on a durable MARKER, not the state (both
  run under auto-resume states): an auto-review fix round re-parks (`reviewFixing`), and the opt-in
  self-improvement round settles the task **done** (`selfImproving`) — so a `done` task holding one
  interrupted implementor run is that, not a lost resume. Gate: `test:self-improve-restart`.
- run `state='error'` → a real failure, an involuntary **cutoff**, or a **usage cap**. Read the row's
  `error` text: it now names the reason (the SDK's `errors`, else the subtype). "Stopped at the
  per-session turn ceiling" is the deliberate role turn ceiling — benign, warm-resumed on the implementor
  path, and several per long task are expected, NOT failures. A QA run cut off the same way is continued
  too: it warm-resumes the SAME review session with a fresh turn budget, charged to a durable **per-review**
  allowance (`qaCutoffResumesThisRound`, max 2, separate from the QA-round budget) that renews whenever a
  round reaches a verdict — what it bounds is one WEDGED review, and a round that answered isn't wedged; it
  parks only once that allowance is spent. `qaCutoffResumes` beside it is the lifetime tally
  `probe:task-runs` reconciles launches against, not a budget. QA's own
  ceiling is 60 read-only but implementor-grade in `qaAppliesFixes` mode (`QA_FIX_MAX_TURNS`, default
  `IMPLEMENTOR_MAX_TURNS`) — an editing QA does the implementor's work, so it gets its budget.
  "Resumed session produced no output" is a run that came back empty (0 turns, $0, no messages — the CLI
  loaded the session and exited without reaching the model). Benign on its own: it is never read as an
  answer on any path whose output GATES the pipeline, and each of those recovers it — the implementor retries
  on a FRESH session seeded from a compressed handoff (parking only if its whole auto-resume budget goes that
  way), a QA round re-runs the review fresh once (durable `qaSilentRetries`, since re-waking the same
  session is what already failed), and the auto-reviewer starts its review over (in-process, sharing
  `MAX_REVIEW_RECOVERIES` with its cutoff continuations). Every empty run is stamped with this text, so a
  `done` row with 0 turns is never left to look like a finish. A 5h/weekly cap auto-switches account and
  resumes the SDK session; `runner.ts` flags the cap from a `rate_limit_event`, an assistant
  `error:"rate_limit"`, OR an error result (429 / rate-limit text), and `AccountManager` failover picks
  another sub with headroom. A cap on a **Fable** model is first classified (`classifyCap`: fresh Haiku
  usage ping — Fable's allowance is its OWN gated pool, separate from the 5h/weekly windows): normal
  windows still free ⇒ the run resumes on the SAME account with `config.fableFallbackModel` (default
  `claude-opus-5`, env `FABLE_FALLBACK_MODEL`), the pool cap is latched per (sub, model) until its
  reset (5h self-expiry when unknown), `modelFor` resolves the fallback for every role meanwhile, and
  the account chip shows a "Fable → Opus" tag. If EVERY sub is capped, an implementor fails over to the CODEX,
  Grok, or z.ai backend when one is enabled+authed with headroom (fresh seed for the CLI backends — a Claude session
  can't resume on the codex CLI; the reverse flip back to Claude already existed). z.ai (GLM Coding Plan) is
  Anthropic-compatible, so it reuses the AgentRun path via an env base-URL/token swap, not a custom runner —
  the `ZaiAgentRun` marker class is what routes its cap through the provider-flip. Only when no backend can continue does the task park
  in `review` with the marker `⏳ Auto-resume pending` in its `error` — a supervisor (`resumeCapParked`,
  every `CAP_RETRY_MS`/120s) auto-resumes it the moment a Claude sub OR Codex frees up; a QA-stage park
  (message carries "(QA runs on Claude)") waits for a Claude window specifically. A plain "needs your
  review" park carries no marker and is left for a human. Idle 5h windows restart STAGGERED: a shared
  `ResetStagger` (`accounts/resetStagger.ts`) places each restart at the midpoint of the largest gap
  between the OTHER participants' live 5h reset phases — Claude subs AND Codex — so resets spread out
  and re-converge dynamically (a sub some outside consumer keeps waking, e.g. a background service, is detected
  via `extWakeAt` and left unheld — its phase anchors the rest). Codex meters stay live via a free
  `codex app-server` `account/rateLimits/read` ping (`codexUsagePing.ts`), and an IDLE Codex 5h window
  is re-started at its slot by a cheap real wake turn (one-word prompt, `gpt-5.5` low effort — mini
  models 400 on ChatGPT-plan auth; `CODEX_WAKE=off` disables, `CODEX_WAKE_MODEL` overrides).

## Auto model selection (`settings.autoModelSelection`, off by default)
On, the implementor's model + effort become a per-task judgement: just before the implementor stage,
`orchestrator/modelSelector.ts` makes ONE no-tools structured judgement on whichever provider currently has
headroom, weighing the brief, the planner's read of the repo, graded local history, a daily cached LiveBench
category/effort prior, and the roster of models **dispatchable right now**. The roster is exhaustive, not
representative: every live Claude, Grok and GLM model (z.ai mirrors Anthropic's `/v1/models`, so its roster is fetched, not hand-listed), and
every Codex model the active auth exposes — its API-key catalog, else the CLI presets that ARE the ChatGPT-plan roster — on each enabled+authed+uncapped backend. Each entry names
its exact model-compatible effort tiers after the operator's backend/account cap; no fixed per-provider slice
or global effort list can hide a usable choice. Exact LiveBench rows are distinguished from
explicitly labelled older same-family priors; local outcomes and role/tool fit outrank the benchmark. The reply is validated against that roster and
the PROVIDER comes from the matched entry, never the reply, so a hallucinated id can't reach a spawn; two
unusable replies fall back to normal routing (a dispatch is never blocked). The pick persists in
`stage_outputs.modelPick` (a resume must land on the same backend — session ids are provider-specific),
overrides usage routing while that backend is ready, and supplies a model only to the backend it named.
Effort precedence: `effortOverride` > pick > planner. Retry re-selects (the blob is nulled).

**Every auto-picked task is graded**, else the selection is a coin flip repeated forever.
`orchestrator/modelGrading.ts` scores it DETERMINISTICALLY at settle (no LLM judging an LLM): `done` 100 /
`review` 40 / `failed` 0, minus 12 per QA fix-round past the first (cap 36) — so a 4-round finish still
outranks a first-round hand-off. A cap-park, restart casualty, cancel, or failure before any implementor
ran is NOT a verdict and is skipped; a task a cap-failover split across two models scores but credits
neither. Rows live in `model_grades` — keyed by thread, **no FK**, so the lesson outlives the task's 30-day
purge (like `chat_messages`). `db.modelStats()` aggregates per model, globally and per repo, feeding both
the next prompt and a read-only scoreboard under the toggle. Gates: `test:model-select` (validator + score)
and `test:auto-model` (pick→run, effort precedence, routing, grading). `npm run probe:model-picks --prefix
server [-- <limit> --repo <sub>]` answers "what did it choose, and was that a good call?"; `npm run
model-lab --prefix server` drives the Settings surface headlessly (own instance, never prod). The
LiveBench release CSV/category map is persisted in kv and refreshed every 24h; fetch failures retain the
last good snapshot and never block dispatch. Gate: `test:livebench`.

## Timed tasks and shotgun tasks (two one-off task MODES, both off by default)
Two per-task modes on the ordinary pipeline — neither is a lane, and neither is a schedule. Set in the
composer's task-mode row, or by the director's `dispatch` args (`duration: "8h"`, `agents: 3`) when the
owner asks in words. `duration_ms`/`deadline_at`/`agent_count`/`parent_id`/`assignment` are nullable
thread columns, so an ordinary task is byte-for-byte unaffected.

**Timed** (`orchestrator/timedTasks.ts`) — "work on this for 8 hours". `deadline_at` is stamped ABSOLUTE
when the task acquires its first pipeline slot, so time spent queued does not eat the window; the round counters are durable in
`stage_outputs`, so ONE window survives restarts, turn ceilings, provider hand-offs and cap parks: each
re-enters the pipeline and re-asks `timedDecision`. The loop sits in `runImplementorQaLoop` between the
implementor and the QA hand-off, so QA still reviews the finished work exactly once.
**The deadline is enforced at round BOUNDARIES, never by aborting a live turn** — a mid-turn abort returns
a success-shaped result with no output that nothing downstream can tell from a real finish (the
`steerStructuredRole` trap), so a round running at the deadline finishes and the deadline denies the NEXT
one. Bounded twice, because a count alone can't tell 40 useful hours from 40 no-op rounds in 90 seconds:
`timedMaxExtensions` (40) AND a hollow-round guard (a round that returns instantly having produced no
agent messages; 3 consecutive ⇒ close). `timedMinSliceMs` (5 min) is both the "worth starting" floor and
the reserve held back for the closing review. Finishing EARLY is a valid outcome: the implementor writes a
standalone `TIMED_TASK_COMPLETE: <why>` line and the window closes with time unused rather than padding
the task. Every close posts its reason — a window never just goes quiet. Gates: `test:timed-tasks`
(the decision function), `test:task-modes` (the loop, durably).

**Shotgun** (`orchestrator/shotgun.ts`) — "use 3 agents". No worktrees (standing doctrine), so parallelism
comes from DISJOINT OWNERSHIP in the one shared tree: one extra planner call decomposes the plan into
work packages with non-overlapping file lists, the lead takes the first, and each other becomes a
COLLABORATOR thread (`parent_id`) on the same workspace running the ordinary implementor path with
`qaEnabled: false`. They share a workspace, so `ensureGroup` forms their office project room for free.
The lead then waits at a barrier, runs ONE integration/reconcile round over the combined tree, and ONE QA
pass reviews the result. **Overlapping ownership is a REJECTION, not a warning** — two agents in one file
in one tree lose work silently, with no merge step to catch it — and the task then degrades to a normal
single-agent run with the reason posted. Degrading is a first-class outcome (most tasks can't be split).
The complete split (narrowed lead kickoff, every child assignment and barrier ids) commits in ONE SQLite
transaction before any child can start; a restart then launches only that complete durable set. A malformed
legacy partial split is parked rather than guessed at. Root, absolute/drive and `..` ownership paths are
rejected. A timed split that expires during decomposition creates no children, and every child inherits the
lead's exact absolute deadline.
**Collaborators BYPASS both concurrency caps** (`enqueueOrRun` early-returns on `parentId`): the lead holds
a slot and then blocks on its children, so queueing a child behind a cap the parent occupies deadlocks the
pair — guaranteed at `maxConcurrent: 1`. MAX_AGENTS (6) is what bounds it instead. The barrier polls
DURABLE child state rather than holding promises, which is what makes it survive a bounce. Collaborators
are hidden from the board (they'd be N cards per task) and shown inside the lead's detail panel.
Gates: `test:shotgun` (ownership + validation), `test:task-modes`. Traps: `.claude/rules/task-modes.md`.

## The Git console (the in-app GitHub Desktop)
The GitHub button beside the gear opens a repo-level git surface: a repository picker, a branch menu
(switch / create / check out a remote branch as a tracking branch / delete), Fetch · Pull · Push, an
**Open** link to the repo on its host (derived from the remote, deep-linked to the current branch), a
ticked-file list with per-file diffs and a commit box, and a History tab that opens any commit's diff.
**The picker fills itself** — `git/discoverRepos.ts` walks `config.workspaceSearchRoots` (`C:\;D:\`,
env `WORKSPACE_SEARCH_ROOTS`) for checkouts, async and bounded by depth/count/wall-clock, memoized 10min
with a Rescan in the menu; the repos actually in use (recent dispatches, task workspaces, this checkout)
sort above the merely-found ones. Nobody types a path; Browse is the fallback. **It opens on the selected
task's repo** when one is open (`repoForThread` resolves it server-side, since a workspace is often the
PARENT of its checkout), else the last repo used here, else the busiest — and an explicit pick always
wins. Writes live in
`git/repoOps.ts` (reusing `gitService.ts`'s hardened `runGit` + parsers — that module stays read-only),
the repo list + safety gate in `orchestrator/repoConsole.ts`, the wire in the `repo.*` WS commands.
Rules it keeps: **never `--force`, never `--no-verify`**; Pull is fast-forward-only with an explicit
Pull (rebase) in its caret menu; a **Vota** origin refuses to push (commit-only policy); a checkout /
pull / discard is **refused while an agent is live in that repo**, naming the tasks, with an explicit
"Do it anyway" override. Branch names and paths arrive from the client, so they're validated in
`repoOps` (no leading `-`, no `..`) and always passed after `--`. Gates: `test:repo-ops` (real repos,
free, no browser) and `npm run git-lab --prefix server` (drives the console in a headless browser
against its own throwaway instance + fixture repo). Details: `.claude/rules/git-changes-surface.md`.

## The office (cross-agent chat)
Concurrent tasks on the same repo would otherwise edit the same files blind. Every running agent is
"in the office": each role gets an `office` MCP server (`bus/officeServer.ts` — `office_look`/`chat_post`/
`chat_read`) and chats in a general room plus, when 2+ tasks share a workspace, a per-repo project room
(`ensureGroup` announces members). Messages persist in `chat_messages` (room `general` | `repo:<normalized-ws>`);
`listProjectRooms` rolls up participants so only collaborating tasks show the top-bar **Office** gnomes
(walk solo, huddle when grouped) and the per-task **Chatroom** button. Codex implementors have no MCP, so
they coordinate through the runner's `OFFICE[team|office]: ...` text bridge. Grouping key =
`normalizeWorkspace` (mirrored in server + web types).

**Office is OFF while a task is alone in its repo** — no kickoff office note, no general check-in (wasted
tokens/noise for a lone worker). It switches ON for BOTH sides the moment a 2nd task joins: the newcomer's
kickoff carries the office note (`officeNote`, peer-gated, injected for every role), and `ensureGroup`
backfills the incumbent's general check-in AND pushes a "so-and-so joined" message into every already-running
implementor incumbent (`pushOfficeActivation`, via `this.live` only — never a one-shot planner/QA
mid-structured-output; the 3rd/4th joiner wakes the earlier ones too, each announced once).
The office MCP tools stay allowlisted throughout so a mid-run join can coordinate immediately (the SDK can't
add tools mid-query). Dedup is durable via `chatThreadInRoom`, so a restart/auto-resume never re-pings.
Gate: `test:office-gating`.

## The Online Office (the office, across machines)
Two orchestrators on one repo were invisible to each other. **Settings → Online office** joins a shared
relay (`relay/`, one container on the Sprogbroen box at `office.sprogbroen.dk`): each advertises its live
agents; same-repo agents become peers — office on, `office_look` lists them, `chat_post(scope:"team")`
reaches them, a remote line reaches the live implementor and lands in the local project room, which the
console shows as a chatroom tab + ONE top-bar huddle (`isCollaborationRoom` — a remote machine counts
before any local task speaks). Nothing an instance sends echoes back: presence, chat and history are
sender-filtered at BOTH ends — an echo gave a solo agent a teammate, itself. **The room key is the git
REMOTE identity, not the workspace path** (`office/repoIdentity.ts`) — two paths are one room, and so are
a FORK and its upstream once either side has the other's remote (every remote is an alias); no remote ⇒
folder name. A remote peer's edits never reach your `git status`, so you collide at the remote — the
prompts say so. **Auth is once** — a `JOIN_CODE` traded for a per-machine device token whose expiry
slides forward on every connect (revoke at `/admin?key=…`). It degrades soft: no token, relay down or
device revoked ⇒ the console says so and local pipelines run as before. Gates `test:online-office` +
`test:relay-core`, browser `npm run office-lab --prefix server`; traps in `.claude/rules/online-office.md`;
credentials in `server/data/online-office-credentials.txt` (gitignored).

## Deliverables (agent-produced files)
A finding can be a **deliverable**: a file an agent surfaces for the owner to view/download from the
right panel. It's a `findings` row with `kind='deliverable'`, a `path` (absolute or workspace-relative)
and a human `label` (the `summary` mirrors the label; `detail` holds the optional description). Agents
emit one via the `post_deliverable` bus tool (`bus/busServer.ts`); Codex/Grok CLI implementors use the
runner's `DELIVERABLE: label | absolute path` text bridge. The implementor prompts document both formats.
The console reads these from the thread's findings and renders file cards (`web/src/components/
Deliverables.tsx` + `FileIcon.tsx`) with View (typed inline preview — markdown/JSON/CSV/code/image/PDF),
Download, and Copy-path. Bytes are served by `GET /api/deliverable/:id` (`?download=1` for an attachment),
which is auth-gated and **confines the resolved real path inside the owning task's workspace** (symlinks
resolved, `..`/absolute/cross-drive escapes rejected, files-only, 25 MB cap) — keep that guard intact:
the path is agent-supplied and the server is LAN-reachable.

**Reliable emission (deterministic backstop).** Emitting a deliverable is a discretionary `post_deliverable`
call the implementor can forget, so a task could produce a real artifact and finish without surfacing it. Two
layers make it reliable: (1) the implementor prompt frames the deliverables pass as a MANDATORY, self-verified
completion step (not an optional aside); (2) QA — the gate that marks a task done — runs a required deliverables
check every round and fails (blocker → bounce) if a produced owner-facing artifact wasn't surfaced. QA's check is
seeded by a harness-computed hint: `orchestrator/deliverableCheck.ts` (`detectUnsurfacedArtifacts`) replays the
run's own recorded `Write` tool calls and deliverable findings to list artifact-type files (docs/data/media by
extension; source, config, meta-docs, and `_`-prefixed scratch excluded) the implementor wrote but never surfaced.
It's a HINT injected into `qaKickoff`, not an auto-emit — surfacing every changed file would spam the console with
ordinary source edits. Bash/script-generated artifacts don't show as `Write` calls, so QA also checks the real git
diff itself. CLI bridge entries carry the real run id and publish through `ThreadManager.postFinding`, so
they satisfy the same backstop and immediately appear in an already-open console.

**Emitting one — avoid the "file not available" 404:** a *relative* `path` resolves as `join(thread.workspace,
path)`, and the task workspace is often the **parent** of this git repo (e.g. workspace
`…\claude-orchastrator` vs. repo `…\claude-orchastrator\claude-orchestrator`). A file you save into the repo
is then NOT found by a repo-relative path. **Pass an ABSOLUTE path** (the containment guard still confines it
to the workspace) — or save the file at the workspace root. Verify before handing off: the file must sit at
`join(workspace, path)` (or be absolute and inside the workspace).

## Search (the rail's box — it searches TASKS, not just the director)
It answers "which task was I doing X in?", so it spans each task's **whole conversation**, not only title
+ brief. That scope IS the feature: searching `director_messages` alone returned nothing for "milkshake"
— dispatched as "Can u make a 3d model of this i can print?" + a photo, the word existed only in what the
implementor then wrote. A term the owner never typed is the normal case. `db.searchTasks` = one grouped
`LIKE` scan of `messages` (~0.4s/350k rows; debounced, deliberately NOT FTS — mirroring ~100 MB of tool
output costs more than it saves on a DB whose growth is the watch-item), ranked metadata → hit count →
recency (recency alone buries the answer), snippets **windowed server-side** (a `result` row is often
megabytes). `director.search` replies `messages` + `tasks`. Gate: `test:task-search`.
Triage side — "where in the DB does this word live?", to read BEFORE placing a missing-text bug:
`npm run probe:text --prefix server -- <text>` gives every table holding it (incl. findings/chat/notes),
rolled up per task, plus whether the DIRECTOR ever said it (no ⇒ an agent coined it — the normal case).
Read-only, grep exit codes. Gate: `test:probe-text`.

## The note list (what's waiting on the owner)
The **Notes** board tab (count badge) is the owner's own list of branches/PRs waiting on THEM — one
clickable line each, which they click, act on, and delete. Every thread-scoped role posts via the
`post_operator_note` bus tool (the director has its own; the owner can add one), and CLI backends, which
have no bus tools, reach the SAME service through a second text bridge beside the office one — a
standalone `OPERATOR_NOTE: <line> | <https://…>` the runner strips (`.claude/rules/office-bridge.md`).
`orchestrator/notes.ts` is stateless over `(Db, EventHub)`, so every caller builds its own instead of
routing through ThreadManager. Rows: `operator_notes`, **no FK**, task title/workspace SNAPSHOT (a PR
outlives the task's 30-day purge). **The anti-spam rules ARE the feature** ("255 chars so they cant spam
me, i hate reading agent yapper"): the body TRUNCATES (never rejects — a long note still carries its
link), a `url` already listed REFRESHES that row whichever task posts it (one PR = one line, deleted
once; keyed on a normalized link identity — a trailing slash, `#issuecomment` or http-vs-https is the
same thing to click), and a task holds ≤5 (oldest evicted, never refused). The `url` is agent-supplied
and becomes an `href`, so http(s) is enforced at BOTH ends — service refuses, render degrades to text.
Gates `test:notes` + `test:office-bridge`; `npm run notes-lab --prefix server`.

## Phone notifications (Settings → Phone notifications, off by default)
On, a Discord message when a task settles **done**, needs the owner's **input** (a review park or an
`ask_user`), or **fails**. `orchestrator/discordNotify.ts` is standalone (config getter + log callback, no
ThreadManager), reads config LIVE per notice so the toggle applies mid-task, and posts to Discord's REST
API with a BOT token, not a webhook. **`notifyOwner` posts to Discord, plain `notifyExternal` does not** —
that split IS the feature: a cap-park (the supervisor resumes it itself) and every failover/resume line
stay off the phone, or the channel stops being read. Route a new owner-facing event through `notifyOwner`.
Two invariants: the push preview is built from `content`, so the essential line lives there and the embed
only carries detail/repo (an embed-only message previews as "sent an embed"); and sends are **serialized**,
since a settling burst fired in parallel earns a 429 each. Token + channel are write-only settings over
`DISCORD_BOT_TOKEN`/`DISCORD_CHANNEL_ID`; only `discordTokenPresent`/`last4` are broadcast, and **Send
test** is the one way to prove token + channel + post permission at once. Gate: `test:discord-notify`.

## Before investigating "should we adopt / replace X?"
Read **`docs/DECISIONS.md`** — the closed-questions register: one row per settled question with its
headline verdict, plus what's genuinely still open. Adding a backend, swapping the harness, and
token-freeze behaviour are already answered there. `grep` finds scripts, never verdicts, so a brief
nothing points at gets rebuilt from scratch. If your question is listed, **extend that brief instead
of writing a second one**, and add your row in the same commit when you close a new one.

## Conventions
- Conventional Commits (`feat:`/`fix:`/`refactor:`/`chore:`…), matching `git log`.
- One concern per commit — don't sweep unrelated working-tree changes into a fix.
