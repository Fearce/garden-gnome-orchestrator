# claude-orchestrator

## 🔑 BROWSER-TEST LOGIN — READ THIS FIRST (agents: stop rediscovering it)
The web app at `:4317`/`:4319` is password-gated. **The password is the `AUTH_PASSWORD` line in `server/.env`** — read that one line (`grep AUTH_PASSWORD server/.env`) instead of spelunking the auth code. To authenticate a Playwright (or curl) session, POST it to `/api/login` to mint the session cookie, then reuse that context:
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

A director's console for running Claude Code agents: a provider-neutral **director** enriches a prompt, dispatches into a pipeline that self-assembles the smallest capable route — a planner and/or researcher when the work benefits, then a capability-routed **implementor** worker you can inject into mid-work. Node/Fastify API (`server/`) + React/Vite console (`web/`), single origin.

**Task-aware route selection (planner/QA are AVAILABLE, not mandatory).** The `plannerEnabled`/ `qaEnabled` top-bar toggles make a stage available, not forced onto every task — `orchestrator/routeSelection.ts`'s deterministic `selectRoute()` (pure function of the brief text + a few structural signals, no model call) decides per task whether it benefits, ANDed with the setting at each gate. Narrow/contained/low-risk (typo, single-file rename, version bump) runs the implementor alone; broad, risk-bearing (security/auth, money, data/migrations, prod/infra), or itself ambiguous ("investigate why…") keeps both — bias conservative when unsure. The same persisted decision carries an `adaptive` or `flagship` implementor floor; substantial/risk-sensitive work prefers Opus 5, with only reviewed flagship fallbacks and a visible wait when none is safe. Strict owner pins still win exactly. Sticky per episode except for a one-time legacy-policy upgrade (`stage_outputs.routeDecision`) and announced in the task's own feed ("🧭 Route selected/updated — …"). OFF remains the only true "never". Gates: `test:route-selection`, `test:route-pipeline`. ARCHITECTURE.md §5.

**Read lane (`dispatch_read`).** A pure read-only lookup ("read HANDOFF.md and report it", "which model does role X use", "explain how Z works") skips the whole pipeline AND route selection: the director dispatches it with `dispatch_read`, running ONE cheap **reader** (Sonnet) that answers by posting a finding — read-only enforced at the harness level (Read/Grep/Glob + `git_read`, no Write/Edit/Bash), no QA regardless of settings. The reader **escalates rather than half-answers**: anything needing an edit/build/verification/broad investigation is **automatically promoted into the normal pipeline, in place** — same thread id, no re-dispatch — selecting the appropriate task-aware route from its evidence and folding its findings into the brief; a restart mid-promotion recovers from the durable `readerEscalation` record instead of re-running the reader. Bias toward the full `dispatch` when unsure. The card shows a **READ** badge until an escalation clears it. See ARCHITECTURE.md §5.

**Auto-review (`thread.autoReview`).** A task parked in `review` is waiting on the owner; the detail panel's "Auto-review & mark done" button delegates that call to one **reviewer** agent (Opus, read-only + Bash, `docs/ARCHITECTURE.md` §5). It flips the thread to `reviewing`, verifies the work, `ask_user`s the owner about anything only they can decide, then settles the task `done` or hands it back to `review` with its reasons — an errored/verdict-less run always re-parks, never accepts (its two involuntary stops are recovered first, sharing one in-process budget of 2: a turn-ceiling cutoff continues the session it made progress in — on the backend that holds it, since a review can run on Claude or, when every sub is capped, z.ai — and an empty run, or a session whose backend is now capped, starts the review over). **A hand-back isn't the end of the lane:** the reviewer is read-only, so what blocks a task is usually implementor work — an `accept: false` carrying concrete `issues` relaunches the implementor with that list (no QA loop; the reviewer is the gate), then warm-resumes the reviewer to re-check and decide again, bounded by the `maxReviewFixRounds` setting (default 1, `0` = old behavior). A failed fix round parks, never accepts — a cap there parks WITHOUT the `⏳ Auto-resume pending` marker on purpose, since the supervisor would resume it through the QA loop and could mark it done on a verdict the reviewer never gave. The round runs under `implementing` with a durable `reviewFixing` marker so a restart re-parks it for a fresh click instead of reviving it into the pipeline, and the inject/resume gates key on the episode (not the state) so nothing spawns a second implementor in the window where the fix run has ended but the state hasn't flipped back. So `done` has three sources: QA, a manual Mark done, and an accepted auto-review. An unattended Supervisor gets at most one claim per work revision and, by default, two consecutive claims across the whole task (`MAX_UNATTENDED_AUTO_REVIEWS`). The cross-task budget survives new implementor runs because those are exactly what used to re-arm the review/fix/review loop forever. Acceptance, an explicit owner auto-review, or Retry restores the budget; reaching it posts one clear handoff and leaves later revisions with the owner. `npm run probe:auto-review --prefix server` (nightly step 12) audits the live streak, persisted attempt markers, same-revision repeats, and old unmeasured history. Gates: `test:auto-review`, `test:director-supervisor`, and `test:auto-review-health`.

## Standing owner directives (an injection outlives the session it was sent to)
An owner instruction injected mid-task ("put this on a separate branch") used to reach ONLY the session live at that moment. `stage_outputs.kickoff` is a frozen snapshot composed before the implementor first started and is never rewritten, so every LATER fresh/cold session — a reviewer fix round, a cap failover, a manual Resume, a restart — rebuilt its kickoff from that snapshot and never saw the instruction. It silently dropped, which is exactly the "the agents forgot what I told them" report. `injectThread` now durably appends every owner injection to `stage_outputs.standingDirectives` (verbatim, oldest first, most recent 25, exact-repeat deduped), and `renderStandingDirectives` puts the whole list into **every** kickoff-composing path: every implementor resume shape, QA/reviewer (incl. resumed/recheck forms), and planner/researcher/reader — a planner or reader can re-run after the directive lands, and must not hand back a plan that quietly contradicts it. Two rules: **a directive is only as durable as the narrowest path that omits it**, so a new kickoff builder must render it too; and it is rendered VERBATIM, never folded into the Haiku-compressed prior-session handoff, which is lossy. The list also survives a from-scratch **Retry** (`resetThreadForRetry` preserves it beside the reader escalation): a retry re-runs the ORIGINAL brief, and these are the owner's corrections TO that brief, so wiping them puts the retry straight back into the reported failure. **Only OWNER text is recorded.** The non-owner callers that reuse the same injection machinery pass `standing: false` — a routed `critical` finding (another agent, or another task via `notify_thread`) and an autonomous Supervisor correction are transient steering for the agent that is live right now, and the rendered block states outright that every line came from the owner. They pass `retitle: false` for the same reason (neither is a change of objective; both used to rename the owner's card to the finding / stall-nudge text). Supervisor CHAT relays the owner's own words, so it retitles nothing but IS recorded. Gate: `test:standing-directives`.

## Co-work (the interactive lane — a conversation, not a task)
The **Co-work** tab is pair development: an owner prompt claims one owner-scoped **Co-worker** turn (`coworkerRunOptions`/`COWORKER_PROMPT`) that completes the requested outcome when feasible, verifies proportionately, and hands control back. While it runs, Queue, Inject, and Interrupt & inject persist owner direction in the same turn and steer the live provider. There is no arbitrary wall-clock hand-back by default; `COWORKER_HANDOFF_MS` (>0) opts into the soft/hard safety boundary, which returns an unresponsive run as a `timeboxed` turn to `idle`. Initial and live messages accept pasted/dropped/selected screenshots and files: refs and bytes survive reload, native image blocks reach capable providers, and every file gets a session-isolated agent-readable cache path plus an auth-gated download. It owns **no task** — no `threads`/`agent_runs` row, no findings, no bus/office MCP, no `runPipeline`, no planner/QA/reviewer/supervisor/auto-review — so nothing can mark it done and ordinary dispatch is untouched. `orchestrator/cowork.ts` owns the lifecycle over `cowork_sessions`/`cowork_turns`/`cowork_messages`, reaching provider/account/capacity routing through the narrow `CoworkRuntime` bridge so no pipeline state enters the conversation. One turn at a time is a durable CAS in `beginCoworkTurn` (not an in-memory lock), a restart reconciles orphaned turns at construction, an explicit provider/model is a **strict pin** (the turn fails rather than substituting), and a live turn and a task agent are mutually exclusive in one workspace both ways (`attachCoworkWorkspaceGuard` + `taskConflict`). **Every task-side probe is blind to this lane**, so debug with `npm run probe:cowork --prefix server [-- <id-prefix|name>]` — state, active-turn age, the turn trail with cost/model/account, timed-hand-back frequency/timing, resume linkage, each live direction's mode and delivery outcome, and the invariants (a claim nothing can release, an unsealed partial reply, a substituted pin, one provider session in two conversations, invalid steering metadata, or an attachment ref whose blob/name/type no longer matches durable storage); exit 1 names it. Gates `test:cowork`, `test:cowork-summary`, `test:cowork-ui`, `test:cowork-health`. Browser: `npm run cowork-lab --prefix server`. Traps: `.claude/rules/co-work-sessions.md`.

**The console side is a conversation, not a log, and it never holds the rest of the app hostage.** Tool traffic FOLDS: a call and its result are one row, paired on the provider's own tool id (never adjacency, which parallel tool use breaks), and consecutive calls collapse into one burst accordion ("worked 2m · 14 calls") that prose closes (`web/src/lib/coworkTranscript.ts`). The transcript sticks to the bottom while a turn streams, stops the moment the owner scrolls up, and offers a "jump to latest" pill back; scroll position and expanded bursts are stored PER SESSION in the store, because the desk is a component and the store outlives it. The desk itself now stays MOUNTED behind `hidden` while another board area is on screen (the pattern the IDE already used), so leaving mid-turn to read the board or talk to the Director costs no scroll position, no expanded burst, no draft and no staged attachment. `.cowork-shell` sets `display: grid`, which beats the UA rule behind `hidden`, so `.cowork-shell[hidden]` is explicit and load-bearing. The server-side mutual workspace guard is untouched: that lock is correct, the UI modality was the bug. Each live or recently-used session also gets a **card on the task board** (`CoworkCards.tsx`): repo, state, an elapsed clock off the live TURN, the last conversational line, click-to-open, and queue/inject/interrupt/stop through the same `sendCowork` path the composer uses. Display-only by construction: no thread, no findings, no QA/done semantics. The card fields (`activeTurnStartedAt`, `lastSnippet`) are DERIVED in the session read, clipped in SQL, so a card never costs a second fetch. Two hand-offs close the loop, both driven by `orchestrator/coworkSummary.ts`, which reads the durable transcript DETERMINISTICALLY (no model call: the owner reads this exactly when capacity is short, and a commit is only real if git printed its receipt in the tool RESULT). **Promote to task** (`cowork.promote`) composes a brief from repo + what was asked + where it got to + files touched + commits made, dispatches an ordinary task through `manager.dispatch`, and leaves the conversation untouched — one-way, so Co-work still owns no task. A **session trail** is auto-posted into the transcript whenever a turn ends timeboxed/cancelled/errored, and the same trail is available on demand from the header, so an abandoned session explains itself without a second agent turn.

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
**If you changed server code, you deploy it before handing off — by restarting the orchestrator yourself, in the same turn. Do NOT end a turn with "needs a restart to go live" or ask the owner to restart.** `npm run deploy --prefix server` stages the build with GGO's restart coordinator. If agents are active, they finish normally and fresh work remains available; the server restarts when all work is idle. A waiting restart is a completed deploy handoff, not permission to call the hub directly.

How to restart depends on how it's running:

**macOS / Linux (local dev — `npm run dev` or `npm run serve`):** no script-hub, no keepAlive.
- Web-only change: don't restart — `npm run build --prefix web` then reload the browser.
- Server change under `serve` (no watch): stop the process and re-run `npm run serve`.
- Under `npm run dev` (`tsx watch`): editing `server/src` already hot-restarts it — but that
  KILLS in-flight tasks, so use `serve` when real pipelines are running.

**A THIRD real shape, on any OS: `npm run serve --prefix server` under its own supervisor** (`server/scripts/supervise.cjs`, not script-hub). This process loads TypeScript **source** directly via tsx and never reads `server/dist`. `server/src/selfRestart.ts`'s `restartRoute()` detects it from `ORCH_SUPERVISED=1` and prefers it over the hub: a restart is a clean `process.exit(75)`, which `supervise.cjs` respawns immediately onto whatever is on disk, not counting it as a crash. `npm run deploy --prefix server` already routes through this correctly, no different command is needed. What differs is diagnosis: `npm run health --prefix server` cannot compare this process to `dist` (there is none to compare to) and instead compares `server/src` file mtimes to the process start (`.claude/rules/nightly-quality-sweep.md` §1, `scripts/listener-shape.cjs`).

**Windows (script-hub production deployment):** runs as script-hub id **`claude-orchestrator`** with
keepAlive armed. Implementor workers are **child processes of this server** (the Agent SDK spawns the
`claude` CLI — `server/src/agents/runner.ts`), so:
- **Server change? `npm run deploy --prefix server`** — it builds, stamps, and asks the running restart
  coordinator to bounce onto HEAD after active agents finish. On an idle server it verifies the new pid
  immediately; during a drain it exits successfully and the server owns the pending bounce. **Use it
  instead of building by hand**, because the right build
  depends on `git status` and gets it wrong in both directions: a plain `npm run build` compiles the DIRTY
  tree, so it ships a sibling's uncommitted, un-QA'd server code live under your deploy; the HEAD-only
  archive recipe avoids that but is ten calls and a junction that deletes `server/node_modules` if removed
  wrong. `deploy` picks per half, on what actually COMPILES in (`server/src` — a dirty lab/doc/probe does
  not count), names what it excluded, and refuses to rebuild `web/dist` from someone else's WIP.
  `-- --plan` prints the decision and touches nothing; `-- --verify` (no build, no bounce) answers "is my
  change live?" after the coordinated bounce. Gate:
  `test:deploy-plan`.
- **`restart WAITING` is a FINISHED deploy — never route around it.** `deploy` asks the running server
  (`POST :4317/api/deploy/restart`), not the hub. `orchestrator/restartCoordinator.ts` holds every planned
  restart while any task, Co-worker, Director, or Supervisor work is active, allows fresh agent starts,
  then closes admission only for the actual bounce at zero active work. Pending builds and refused
  restarts must never freeze GGO. There is no hourly restart limit or elapsed-time override.
  Owner update-badge restarts use the same drain. Waiting exits 0; `--verify` reports `BUILT and STAGED`,
  also 0. Gate: `test:restart-drain`.
  By hand it is `POST http://127.0.0.1:3939/api/restart {"id":"claude-orchestrator"}` (atomic: runs in the
  hub, outside this server's tree, survives the caller, re-arms keepAlive) — it **bypasses the drain and
  can kill active agents**, so keep it for emergency recovery when :4317 itself is down.
- **Never use stop+start** (`script-hub stop` / the launcher's `stop`): it disarms keepAlive AND
  tree-kills the whole process — including the worker issuing it — so the follow-up `start` never
  runs and nothing resurrects it. Use the atomic `/api/restart` above, which is exactly why it exists.
- **Web-only change?** Skip the restart — `web/dist` is static; `npm run build --prefix web` then
  reload the browser. That build stamps `web/dist/.build-info.json`, and it is the ONLY thing that
  answers "is the bundle current?" — `--verify` and `health` both read it. A web note from either means
  the BUNDLE is behind HEAD; it never refers to the server's build, so a rebuild is the whole remedy.
  **That build IS the deploy.** The running server serves `web/dist` out of this checkout, so it
  replaces what the live console shows the second it finishes, unverified WIP and all. `deploy` refuses
  to rebuild `web/dist` from a SIBLING's WIP, which makes it easy to assume a plain `npm run build
  --prefix web` is guarded too; it is not, and it does not care whose WIP it is, including yours. The
  usual way it happens is building mid-task to feed a throwaway instance, so either build a detached
  worktree and point the throwaway at that, or treat prod as carrying your change and do not stop until
  it is verified and committed (then rebuild once more, so the stamp names the real commit, `dirty:false`).
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
For an explicit-model task, run `npm run probe:model-pin --prefix server -- <thread> --expect-model
<canonical-id>`; it quickly exits non-zero unless the persisted strict request matches the latest
implementor run's real model and provider. `probe:task-runs` also accepts `--verify-model-pin` when the
same verdict should appear inside the full timeline.
Its control-flow timeline joins run starts/ends (including account + `cap_flagged`), routing/capacity
findings, owner/supervisor system messages, and matching `crash.log` boot/reconcile records on one clock.
For **"did my Supervisor-chat message arrive, and did its action run?"**, use
`npm run probe:supervisor-chat --prefix server -- <turn-id|task-id|task-title|message-text>` (omit the
query for recent turns; add `--json` for automation). It separates no durable receipt, pending, success,
failure, and needs-input, then shows the send-time target beside its current task state and action audit.
For successful steering it also prints the persisted task-feed injection and any agent `ACK:` within two
minutes, so exact delivery and prompt receipt do not require an ad-hoc SQLite join.
Every event shows system-local time beside explicit UTC; do not hand-convert SQLite epochs when the owner
quotes a local time. Add `--prompt` to print the exact saved routing prompt when provider intent is disputed.
The thread header also prints `activeTaskDeadline`: its persisted local + UTC instant, countdown, and whether
the server sees it armed, expired/parked, extended-but-still-parked, cleared-but-still-parked, or overdue
without a durable park. Read that before reaching for raw SQLite; changing or clearing an expired deadline
never means the task resumed — only a deliberate Resume removes the park.
Read its QA-loop check as written: the budget is the durable `qaRoundsUsed` vs `maxQaRounds`, NOT the QA
run count — a turn-ceiling continuation, an empty-run retry and a cap failover each spend a *launch* while
recovering one *round*, so launches legitimately exceed the cap. And when `qaAppliesFixes` is on (it is, in
prod), QA edits the tree itself and hands each changed pass to a VERIFIER QA pass, so **many QA runs against
one implementor run is the designed shape, not a stuck loop** (`.claude/rules/qa-fixes-mode.md`).
For **"the console shows 'Planner and researcher are warming up' forever" / a task looks stuck in the
browser**, run `npm run probe:thread-feed --prefix server [-- --thread <uuid> | --title <substring>]`
(read-only — it sends the same `thread.history` the browser would). It times an unauthenticated
`/api/health` baseline, login, WS connect, the `hello` round trip, and the `thread.history` round trip
separately: a FAST baseline beside a SLOW WS/hello/history leg means this box is contended in a way that
specifically stalls this Node process's socket handling (see "Local processes" above), not a bug in
message storage or the feed-mapping logic; a slow baseline too means look at the box first. This is the
diagnosis that took four hand-written throwaway WS probe scripts to reach on 2026-09-11 (a 94-96%-loaded
box made every task's WS take ~15s just to open) — use this instead of rebuilding one.
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
one must NEVER be read as a cap in the other. Automatic routing offers them only to
reader/planner/researcher — a capability default, not thrift: the CLI ships Spark instructed never to
verify its own work or run tests, and 128K context against the flagships' 272K, which makes it a poor
ordinary implementor choice and unsafe for QA. An explicit owner model request is the deliberate
exception: it is persisted as a strict task-local pin, checked against that exact model pool, displayed
beside the actual runtime, and may never fall back to another model. The
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
  "Resumed session produced no output" is a run that came back hollow (0 turns, $0 — the CLI loaded the
  session and exited without reaching the model). Usually it emits nothing at all, but a resumed SDK
  session can REPLAY the cut-off query's pending tool call, so message traffic alone never proves the new
  query reached the model — the explicit zero telemetry decides (`ranSilently`; that replay shape parked
  task 7b4d99a0 after its verifier hit the ceiling). Benign on its own: it is never read as an
  answer on any path whose output GATES the pipeline, and each of those recovers it — the implementor retries
  on a FRESH session seeded from a compressed handoff (parking only if its whole auto-resume budget goes that
  way), a QA round re-runs the review fresh once (durable `qaSilentRetries`, since re-waking the same
  session is what already failed), and the auto-reviewer starts its review over (in-process, sharing
  `MAX_REVIEW_RECOVERIES` with its cutoff continuations). Every empty run is stamped with this text, so a
  `done` row with 0 turns is never left to look like a finish. **Its CAUSE is a teardown race, and the only
  cure is `AgentRun.stop()` awaiting the child's real exit** — the recovery above is expensive (a fresh
  session re-inspects everything, which is the "starting again and again" the owner asked to stop), and it
  fired on 29% of turn-ceiling continuations. `Query.close()` is fire-and-forget and the message stream ends
  the instant it is called, so waiting on that stream is NOT waiting for the `claude` child; the next
  `--resume` then loads a session the old process still holds and exits with just `system:init`. Tear down
  through `Query.return()`/asyncDispose, which run `performCleanup()` -> a bounded await on
  `Transport.waitForExit` (the SDK documents exactly this on `waitForExit`). Gate: `test:runner-stop-drain`;
  reproduce with `npm run probe:sdk-resume --prefix server` (real quota). **Its OTHER cause is stopping the
  wrong OBJECT — and that one leaves TWO agents on the workspace.** `awaitImplementorResult` relaunches the
  implementor itself (account cap, Fable pool, transient-API retry), so it returns the run it ended on
  (`ImplementorTurn`) and `awaitImplementorCompletion` tracks THAT, never the run it passed in. Tracking the
  argument stopped a corpse and started the continuation beside a child still working: two agents committing
  over each other on one production branch for 45 minutes (2026-09-11). `startImplementor` ends an unfinished
  implementor it displaces as a backstop. Gate: `test:implementor-handover`. A 5h/weekly cap auto-switches account and
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
  review" park carries no marker and is left for a human. **A cap the owner clears BY HAND (usage reset,
  credit top-up), or that the provider stated wrongly, is disproved by live telemetry, not by run
  history** — `codexAllowanceReopened`, and since 2026-09-11 `grokAllowanceReopened`/`zaiAllowanceReopened`
  over the shared `agents/usageFreshness.ts`: a stated reset once needed a newer successful run on that
  provider, which the latch itself made impossible. Absent telemetry is still never permission, a reading
  older than the cap is not evidence, and a lift is a BET the provider gets to answer — a cap recorded
  AFTER one means it capped us again anyway, so no further probe is spent until that latch expires on its
  own (bounding it by the probed WINDOW does not work: a rejection stating no reset falls back to a
  cooldown from now, so every re-cap lands further out and slips past). **Freshness is what makes a reset
  timestamp readable at all**: a scrape that stops updating leaves its reset drifting further into the
  past every minute, so a frozen exhausted pool reads as permanently rolled-over and free. Grok was
  offered as a live failover rung for two days that way, rejecting every run handed to it. A stale
  reading may still report a window SPENT; it may not CLEAR one on a reset it never witnessed elapse —
  and `probe:accounts` mirrors that guard, or the sweep's ladder keeps printing the frozen rung
  available. **A usage gate's clock must be its READING clock**: the frozen meter above was written by
  the gate suite itself, before `config.ts` isolated a test's `DATA_DIR` (`d3e8f38`). Gates:
  `test:usage-freshness`, `test:provider-fallback`, `test:failover-ladder`.
  ARCHITECTURE.md §10. Idle 5h windows restart STAGGERED: a shared
  `ResetStagger` (`accounts/resetStagger.ts`) places each restart at the midpoint of the largest gap
  between the OTHER participants' live 5h reset phases — Claude subs AND Codex — so resets spread out
  and re-converge dynamically (a sub some outside consumer keeps waking, e.g. a background service, is detected
  via `extWakeAt` and left unheld — its phase anchors the rest). Codex meters stay live via a free
  `codex app-server` `account/rateLimits/read` ping (`codexUsagePing.ts`), and an IDLE Codex 5h window
  is re-started at its slot by a cheap real wake turn (one-word prompt, `gpt-5.5` low effort — mini
  models 400 on ChatGPT-plan auth; `CODEX_WAKE=off` disables, `CODEX_WAKE_MODEL` overrides).

### Capacity-aware dispatch and waiting

Hard-cap detection, account/provider failover, Fable fallback, dedicated Codex pools, durable cap-park auto-resume, and the free planner/reader pool's full-run request/token/credit lease already exist. The routing layer now adds a pre-dispatch runway check shared by Claude-account selection, provider selection, exact Codex model-pool selection, smart model rosters, QA/reviewer routing, Director target selection, and parked-task wake scheduling.

The check estimates a role-sized duration/burn/reserve (including implementor effort, plan size/risk, and timed-task duration) and evaluates every visible gating window: Claude/z.ai 5h + weekly, Codex general or dedicated 5h + weekly, Grok weekly + monthly credits, routing ceilings, and live cap latches. Known viable capacity wins, unknown/unmetered capacity remains a bounded fallback, and known-at-risk capacity is last. Existing weekly-safety, spread-usage, and perishable-reset policy still breaks ties inside that tier. A reset during the estimated run reduces pre-reset demand; one after completion does not. Longer-window gates (weekly/monthly) still gate dispatch, but their required task burn is scaled below the 5h window so one high-effort task does not consume a whole weekly-sized reserve. This lets a short role bridge a near reset without assigning substantial implementation or QA to a pool forecast to expire mid-task.

When every visible compatible pool lacks the reserve, substantial work enters the existing durable `Auto-resume pending` park without spending a doomed turn. The task's finding/error shows the workload estimate and each pool's free percentage/reset. `nextViableAt` simulates all coupled gates, so a 5h reset does not wake or promise capacity while a weekly/monthly window is still exhausted. The supervisor rechecks the same workload reserve before resuming. Eligible reader/planner/researcher turns compare independent Codex model pools proactively, and selecting one no longer selects/wakes an unused Claude account. Unknown telemetry never freezes an otherwise dispatchable API-key/cold-start backend. Gate: `test:capacity-routing` and `test:codex-usage` (plus `test:provider-fallback`, `test:qa-budget`, `test:auto-model`, and `test:codex-pools` for wiring/recovery).

**The gate only ANNOUNCES a route when it chose one.** A "Usage-aware routing chose …" finding needs a real alternative — a second backend candidate, or a second enabled Claude subscription — because an implementor's demand is always `substantial`, and the gate re-runs on every dispatch, manual resume and cold inject (`injectThread` → `resumeThread` → `resumeImplementorOnly`). One sub with nothing else enabled therefore used to re-post a decision that never happened, on every inject. Now that case is silent; a sole pool that is genuinely short of the reserve posts a plain capacity warning ("Low quota runway on … — starting anyway") instead of claiming a choice, and `postRoutingNote` drops any note that repeats the task's previous one, so only a CHANGED verdict re-announces. Gate: `test:routing-notes`.

## Auto model selection (`settings.autoModelSelection`, off by default)
On, the implementor's model + effort become a per-task judgement: just before the implementor stage, `orchestrator/modelSelector.ts` makes ONE no-tools structured judgement on whichever provider currently has headroom, weighing the brief, the planner's read of the repo, graded local history, a daily cached LiveBench category/effort prior, and the roster of models **dispatchable right now**. The roster is exhaustive, not representative: every live Claude, Grok and GLM model (z.ai mirrors Anthropic's `/v1/models`, so its roster is fetched, not hand-listed), and every Codex model the active auth exposes — its API-key catalog, else the CLI presets that ARE the ChatGPT-plan roster — on each enabled+authed+uncapped backend. Each entry names its exact model-compatible effort tiers after the operator's backend/account cap; no fixed per-provider slice or global effort list can hide a usable choice. Each entry also names the live quota runway of the exact account/general/dedicated pool the model would consume. The selector is instructed to treat that as an operational constraint; known-at-risk models are removed when a viable option exists, and the chosen provider is checked again immediately before dispatch. Exact LiveBench rows are distinguished from explicitly labelled older same-family priors; local outcomes and role/tool fit outrank the benchmark. The reply is validated against that roster and the PROVIDER comes from the matched entry, never the reply, so a hallucinated id can't reach a spawn; two unusable replies fall back to normal routing for adaptive tasks.

The persisted task route supplies a deterministic capability floor before that judgement. `adaptive` routes retain the cheapest-capable behavior above. `flagship` routes cover substantial ambiguous work and high-risk production/data-quality/ingestion/migration/backfill/cross-cutting or sensitive user-facing work; they choose `claude-opus-5` first whenever it has task-sized runway. Only reviewed flagship families may be considered as a documented fallback. When none is safe, the task waits visibly in review and names the missing model/capacity instead of silently falling through to a workhorse. Strict owner model pins bypass automatic selection unchanged. Pre-policy saved routes are upgraded in place: planner/QA progress and old run history remain, but a non-compliant model pick/session is superseded and the owner gets a `Route updated` message with the evidence.

The pick persists in `stage_outputs.modelPick` (a resume must land on the same backend and model — session ids are provider-specific), overrides usage routing while that backend is ready, and supplies a model only to the backend it named. Effort precedence: `effortOverride` > pick > planner. Retry re-selects (the blob is nulled).

**Every auto-picked task is graded**, else the selection is a coin flip repeated forever. `orchestrator/modelGrading.ts` scores it DETERMINISTICALLY at settle (no LLM judging an LLM): `done` 100 / `review` 40 / `failed` 0, minus 12 per QA fix-round past the first (cap 36) — so a 4-round finish still outranks a first-round hand-off. A cap-park, restart casualty, cancel, or failure before any implementor ran is NOT a verdict and is skipped; a task a cap-failover split across two models scores but credits neither. Rows live in `model_grades` — keyed by thread, **no FK**, so the lesson outlives the task's 30-day purge (like `chat_messages`). `db.modelStats()` aggregates per model, globally and per repo, feeding both the next prompt and a read-only scoreboard under the toggle. Gates: `test:model-select` (validator + score) and `test:auto-model` (pick→run, effort precedence, routing, grading). `npm run probe:model-picks --prefix server [-- <limit> --repo <sub>]` answers "what did it choose, and was that a good call?"; `npm run model-lab --prefix server` drives the Settings surface headlessly (own instance, never prod). The per-task exact provider/model control has its own persisted desktop + phone pass at `npm run task-model-lab --prefix server` (including Auto and the running-task guard). The LiveBench release CSV/category map is persisted in kv and refreshed every 24h; fetch failures retain the last good snapshot and never block dispatch. Gate: `test:livebench`.

## Token conservation mode (`settings.tokenConservationMode`, off by default)
On, once a Claude subscription or the Codex general pool sits in the last 10% of its weekly window (and the reset isn't within 24h — nothing left worth conserving for), `orchestrator/tokenConservation.ts` caps that subscription's/backend's model to its economy tier (Claude Sonnet 5, GPT-5.6 Luna) at the plain default model-resolution layer (`modelFor`/`providerRoleModel`) every role runs through absent a strict pin or an auto-model-selection pick — both resolve before this layer and are never touched. Grok ships one model and z.ai has no reviewed flagship/economy split, so neither is affected. Three traps this module deliberately guards against — a fail-open "already cheap" check, a Co-work session's permanently-frozen first-turn model swallowing a transient downgrade forever, and a downgraded model colliding with a dedicated Codex pool's own cap latch — are written up in `.claude/rules/token-conservation-mode.md`; read it before touching this file or its two `modelFor`/`providerRoleModel` call sites. Gate: `test:token-conservation`. `npm run token-conservation-lab --prefix server` drives the Settings toggle and a restart round-trip headlessly.

## Timed tasks and shotgun tasks (two one-off task MODES, both off by default)
Two per-task modes on the ordinary pipeline — neither is a lane, and neither is a schedule. Set in the composer's task-mode row, or by the director's `dispatch` args (`duration: "8h"`, `agents: 3`) when the owner asks in words. `duration_ms`/`deadline_at`/`agent_count`/`parent_id`/`assignment` are nullable thread columns, so an ordinary task is byte-for-byte unaffected.

**Timed** (`orchestrator/timedTasks.ts`) — "work on this for 8 hours". `deadline_at` is stamped ABSOLUTE when the task acquires its first pipeline slot, so time spent queued does not eat the window; the round counters are durable in `stage_outputs`, so ONE window survives restarts, turn ceilings, provider hand-offs and cap parks: each re-enters the pipeline and re-asks `timedDecision`. The loop sits in `runImplementorQaLoop` between the implementor and the QA hand-off, so QA still reviews the finished work exactly once. **The deadline is enforced at round BOUNDARIES, never by aborting a live turn** — a mid-turn abort returns a success-shaped result with no output that nothing downstream can tell from a real finish (the `steerStructuredRole` trap), so a round running at the deadline finishes and the deadline denies the NEXT one. Bounded twice, because a count alone can't tell 40 useful hours from 40 no-op rounds in 90 seconds: `timedMaxExtensions` (40) AND a hollow-round guard (a round that returns instantly having produced no agent messages; 3 consecutive ⇒ close). `timedMinSliceMs` (5 min) is both the "worth starting" floor and the reserve held back for the closing review. Finishing EARLY is a valid outcome: the implementor writes a standalone `TIMED_TASK_COMPLETE: <why>` line and the window closes with time unused rather than padding the task. Every close posts its reason — a window never just goes quiet. Gates: `test:timed-tasks` (the decision function), `test:task-modes` (the loop, durably).

**Shotgun** (`orchestrator/shotgun.ts`) — "use 3 agents". No worktrees (standing doctrine), so parallelism comes from DISJOINT OWNERSHIP in the one shared tree: one extra planner call decomposes the plan into work packages with non-overlapping file lists, the lead takes the first, and each other becomes a COLLABORATOR thread (`parent_id`) on the same workspace running the ordinary implementor path with `qaEnabled: false`. They share a workspace, so `ensureGroup` forms their office project room for free. The lead then waits at a barrier, runs ONE integration/reconcile round over the combined tree, and ONE QA pass reviews the result. **Overlapping ownership is a REJECTION, not a warning** — two agents in one file in one tree lose work silently, with no merge step to catch it — and the task then degrades to a normal single-agent run with the reason posted. Degrading is a first-class outcome (most tasks can't be split). The complete split (narrowed lead kickoff, every child assignment and barrier ids) commits in ONE SQLite transaction before any child can start; a restart then launches only that complete durable set. A malformed legacy partial split is parked rather than guessed at. Root, absolute/drive and `..` ownership paths are rejected. A timed split that expires during decomposition creates no children, and every child inherits the lead's exact absolute deadline. **Collaborators BYPASS both concurrency caps** (`enqueueOrRun` early-returns on `parentId`): the lead holds a slot and then blocks on its children, so queueing a child behind a cap the parent occupies deadlocks the pair — guaranteed at `maxConcurrent: 1`. MAX_AGENTS (6) is what bounds it instead. The barrier polls DURABLE child state rather than holding promises, which is what makes it survive a bounce. Collaborators are hidden from the board (they'd be N cards per task) and shown inside the lead's detail panel. Gates: `test:shotgun` (ownership + validation), `test:task-modes`. Traps: `.claude/rules/task-modes.md`.

## The Git console (the in-app GitHub Desktop)
The GitHub button beside the gear opens a repo-level git surface: a repository picker, a branch menu (switch / create / check out a remote branch as a tracking branch / delete), Fetch · Pull · Push, an **Open** link to the repo on its host (derived from the remote, deep-linked to the current branch), a ticked-file list with per-file diffs and a commit box, and a History tab that opens any commit's diff. **The picker fills itself** — `git/discoverRepos.ts` walks `config.workspaceSearchRoots` (`C:\;D:\`, env `WORKSPACE_SEARCH_ROOTS`) for checkouts, async and bounded by depth/count/wall-clock, memoized 10min with a Rescan in the menu; the repos actually in use (recent dispatches, task workspaces, this checkout) sort above the merely-found ones. Nobody types a path; Browse is the fallback. **It opens on the selected task's repo** when one is open (`repoForThread` resolves it server-side, since a workspace is often the PARENT of its checkout), else the last repo used here, else the busiest — and an explicit pick always wins. Writes live in `git/repoOps.ts` (reusing `gitService.ts`'s hardened `runGit` + parsers — that module stays read-only), the repo list + safety gate in `orchestrator/repoConsole.ts`, the wire in the `repo.*` WS commands. Rules it keeps: **never `--force`, never `--no-verify`**; Pull is fast-forward-only with an explicit Pull (rebase) in its caret menu; an origin matching the configured commit-only rule refuses to push; a checkout / pull / discard is **refused while an agent is live in that repo**, naming the tasks, with an explicit "Do it anyway" override. Branch names and paths arrive from the client, so they're validated in `repoOps` (no leading `-`, no `..`) and always passed after `--`. Gates: `test:repo-ops` (real repos, free, no browser) and `npm run git-lab --prefix server` (drives the console in a headless browser against its own throwaway instance + fixture repo). Details: `.claude/rules/git-changes-surface.md`.

## Contextual code navigation (task / Co-work / Supervisor → IDE, Git, and back)
One server-resolved answer per subject — `orchestrator/codeContext.ts`, over the `code.context` WS command — tells the console the workspace, the **IDE's own workspace id**, the repo root and its **prefix**, and how HEAD stands. The browser never derives a deep link itself. `CodeContextBar` renders that as one quiet row (branch · repo · ↑unpushed ↓behind · dirty dot) with two routes, on the task detail panel, the Co-work conversation header and each Supervisor audit row; a task's Changes drawer adds a per-file **Edit** into the editor and makes each of the task's own commits open in the Git console's History. Every route records where it came from, so the IDE and the console show one **back** control. **A route is offered only when it can be taken.** No `ideWorkspaceId` (the path isn't registered) ⇒ no Code button; no `repoPath` ⇒ no Git button; `repoPrefix === null` (the checkout sits ABOVE the workspace, so a repo-relative file has no in-workspace path) ⇒ no per-file link — never a guessed one. The unavailable cases say why in place of the buttons. Two rules not to re-break: a `workspace` subject is a path **from the browser**, so it resolves only for a folder GGO already works in (`IdeService.isRegistered` — the same registry the IDE enforces; without it this command reads any directory's git state); and the row reads `getRepoHeadState`, a repo-keyed cached branch/push read, **not** `getGitStatus` — a screenful of surfaces would otherwise each walk a large working tree. Gates: `test:code-context` (resolver + the browser-side path math) and `npm run code-nav-lab --prefix server` (drives every route and the phone layout headlessly, against its own isolated build). Traps + what the system deliberately cannot know (no line-level provenance): `.claude/rules/contextual-code-navigation.md`.

## The office (cross-agent chat)
Concurrent tasks on the same repo would otherwise edit the same files blind. Every running agent is "in the office": each role gets an `office` MCP server (`bus/officeServer.ts` — `office_look`/`chat_post`/ `chat_read`) and chats in a general room plus, when 2+ tasks share a workspace, a per-repo project room (`ensureGroup` announces members). Messages persist in `chat_messages` (room `general` | `repo:<normalized-ws>`); `listProjectRooms` rolls up participants so only collaborating tasks show the top-bar **Office** gnomes (walk solo, huddle when grouped) and the per-task **Chatroom** button. Codex implementors have no MCP, so they coordinate through the runner's `OFFICE[team|office]: ...` text bridge. Grouping key = `normalizeWorkspace` (mirrored in server + web types).

**Office is OFF while a task is alone in its repo** — no kickoff office note, no general check-in (wasted tokens/noise for a lone worker). It switches ON for BOTH sides the moment a 2nd task joins: the newcomer's kickoff carries the office note (`officeNote`, peer-gated, injected for every role), and `ensureGroup` backfills the incumbent's general check-in AND pushes a "so-and-so joined" message into every already-running implementor incumbent (`pushOfficeActivation`, via `this.live` only — never a one-shot planner/QA mid-structured-output; the 3rd/4th joiner wakes the earlier ones too, each announced once). The office MCP tools stay allowlisted throughout so a mid-run join can coordinate immediately (the SDK can't add tools mid-query). Dedup is durable via `chatThreadInRoom`, so a restart/auto-resume never re-pings. Gate: `test:office-gating`.

## The Online Office (the office, across machines)
Two orchestrators on one repo were invisible to each other. **Settings → Online office** joins a shared relay (`relay/`, one container on the Sprogbroen box at `office.sprogbroen.dk`): each advertises its live agents; same-repo agents become peers — office on, `office_look` lists them, `chat_post(scope:"team")` reaches them, a remote line reaches the live implementor and lands in the local project room, which the console shows as a chatroom tab + ONE top-bar huddle (`isCollaborationRoom` — a remote machine counts before any local task speaks). Nothing an instance sends echoes back: presence, chat and history are sender-filtered at BOTH ends — an echo gave a solo agent a teammate, itself. **The room key is the git REMOTE identity, not the workspace path** (`office/repoIdentity.ts`) — two paths are one room, and so are a FORK and its upstream once either side has the other's remote (every remote is an alias); no remote ⇒ folder name. A remote peer's edits never reach your `git status`, so you collide at the remote — the prompts say so. **Auth is once** — a `JOIN_CODE` traded for a per-machine device token whose expiry slides forward on every connect (revoke at `/admin?key=…`). It degrades soft: no token, relay down or device revoked ⇒ the console says so and local pipelines run as before. Gates `test:online-office` + `test:relay-core`, browser `npm run office-lab --prefix server`; traps in `.claude/rules/online-office.md`; credentials in `server/data/online-office-credentials.txt` (gitignored).

**The directors' room — the people, not their agents.** The same relay carries one room for the humans running the consoles (`DIRECTORS_ROOM`): the top bar grows an **Online Office** gnome cluster the moment another director is on, clicking it opens that room as a tab beside Office, and a line there crosses machines without touching any pipeline — it is stored `scope='directors'`, so no project rollup, no `chat_read`, and no agent session ever sees it. Membership is **opt-in on the wire**: an instance joins by naming its director on its presence frame, which is what keeps a console that predates the room from being sent a line it would file into its own general office as agent chatter. Both additions are optional wire fields (`director` out, `directors` back on `welcome`/`presence`), so `RELAY_PROTOCOL` did NOT bump — a bump is an office-wide outage until every machine redeploys. **Both halves must be deployed**: a machine on an older build is simply not in the room, and `probe:office` prints the one symptom (a room only this machine has ever spoken in).

## Deliverables (agent-produced files)
A finding can be a **deliverable**: a file an agent surfaces for the owner to view/download from the right panel. It's a `findings` row with `kind='deliverable'`, a `path` (absolute or workspace-relative) and a human `label` (the `summary` mirrors the label; `detail` holds the optional description). Agents emit one via the `post_deliverable` bus tool (`bus/busServer.ts`); Codex/Grok CLI implementors use the runner's `DELIVERABLE: label | absolute path` text bridge. The implementor prompts document both formats. The console reads these from the thread's findings and renders file cards (`web/src/components/ Deliverables.tsx` + `FileIcon.tsx`) with View (typed inline preview — markdown/JSON/CSV/code/image/PDF), Download, and Copy-path. Bytes are served by `GET /api/deliverable/:id` (`?download=1` for an attachment), which is auth-gated and **confines the resolved real path inside the owning task's workspace** (symlinks resolved, `..`/absolute/cross-drive escapes rejected, files-only, 25 MB cap) — keep that guard intact: the path is agent-supplied and the server is LAN-reachable.

**Reliable emission (deterministic backstop).** Emitting a deliverable is a discretionary `post_deliverable` call the implementor can forget, so a task could produce a real artifact and finish without surfacing it. Two layers make it reliable: (1) the implementor prompt frames the deliverables pass as a MANDATORY, self-verified completion step (not an optional aside); (2) QA — the gate that marks a task done — runs a required deliverables check every round and fails (blocker → bounce) if a produced owner-facing artifact wasn't surfaced. QA's check is seeded by a harness-computed hint: `orchestrator/deliverableCheck.ts` (`detectUnsurfacedArtifacts`) replays the run's own recorded `Write` tool calls and deliverable findings to list artifact-type files (docs/data/media by extension; source, config, meta-docs, and `_`-prefixed scratch excluded) the implementor wrote but never surfaced. It's a HINT injected into `qaKickoff`, not an auto-emit — surfacing every changed file would spam the console with ordinary source edits. Bash/script-generated artifacts don't show as `Write` calls, so QA also checks the real git diff itself. CLI bridge entries carry the real run id and publish through `ThreadManager.postFinding`, so they satisfy the same backstop and immediately appear in an already-open console.

**Emitting one — avoid the "file not available" 404:** a *relative* `path` resolves as `join(thread.workspace, path)`, and the task workspace is often the **parent** of this git repo (e.g. workspace `…\claude-orchastrator` vs. repo `…\claude-orchastrator\claude-orchestrator`). A file you save into the repo is then NOT found by a repo-relative path. **Pass an ABSOLUTE path** (the containment guard still confines it to the workspace) — or save the file at the workspace root. Verify before handing off: the file must sit at `join(workspace, path)` (or be absolute and inside the workspace).

## Implementor work memos (the pinned completion report)
The implementor's final report used to exist only as one chronological feed message, so QA, reviewer, Supervisor and self-improvement traffic buried it and the owner had to scroll up hunting for what actually shipped. `implementation_memos` makes it durable instead: **one idempotent row per implementor run**, keyed `(thread_id, run_id)`, allocated a monotonic per-task `revision`. The console renders the memo first in the task detail panel, above the deliverables, the agent filter and the feed (`web/src/components/ImplementationMemos.tsx`), with an Open action into a revision-history modal; every earlier revision stays auditable, including across `resetThreadForRetry` (memos are preserved like `chat_messages`). It sits INSIDE the panel's one scrollport (`.detail-body`) rather than pinned above it: pinned, it held ~150px of the panel open forever, and stacked with the filter chips and the deliverables strip that starved the transcript to a sliver and pushed the inject bar off the bottom of the panel entirely. The agent filter is what stays pinned (sticky), because it is one row, not a card. Gate: `npm run panel-scroll-lab --prefix server`.

Capture is at `finalizeRun` plus the explicit pipeline boundaries, so **every backend converges on the same writer** — Claude, Codex, Grok and z.ai alike — and the CLI text bridges' late `DELIVERABLE:` lines refresh the existing row rather than creating a second one. `(thread_id, run_id)` is what makes duplicate result delivery, a stop/onEnd race and restart reconciliation idempotent; `updated_at` is strictly monotonic so a late history response cannot overwrite a newer live event on reconnect.

**It never invents a success.** `implementationMemoEvidence` records `completed` only for a run that left real prose behind: a success-shaped envelope with no conclusion is `no_conclusion`, an abort/interruption is `interrupted` (even when the transport looked successful), and an error is `failed` with its diagnostic preserved. The post-acceptance self-improvement round is deliberately excluded — it is feed noise, not another work revision. A `handoff` of `pending`/`qa`/`reviewer`/`review`/`done`/`resumed` says where the work went.

Work that predates the feature is imported once by `backfillImplementationMemos` (kv `implementation_memo_backfill_v1`) from durable `agent_runs` + each run's own last text message. Those rows carry `source='backfill'` and the UI says so, because their `handoff` is derived from task state rather than observed at the boundary; a reflection round is detected via the system marker `selfImprovementRound` writes and never imported. Rehearsed against a live snapshot (2026-09-03): 2.7s in the `Db` constructor, 2377 memos over 775 tasks, every pre-existing table unchanged, reopen a 3ms no-op. `lastTextMessageForRun` runs on every implementor run end, so `idx_messages_run` is required — without it that is a full scan of the whole message history.

API: `GET /api/threads/:id/implementation-memos` → `{ current, latestUseful, memos }` (auth-gated). The live console gets the same rows on `thread.history` and one `thread.memo` event per write. Gate: `test:implementation-memos` (server lifecycle + SSR UI markup).

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
The **Notes** board tab (count badge) is the owner's own list of branches/PRs waiting on THEM — one clickable line each, which they click, act on, and delete. Every thread-scoped role posts via the `post_operator_note` bus tool (the director has its own; the owner can add one), and CLI backends, which have no bus tools, reach the SAME service through a second text bridge beside the office one — a standalone `OPERATOR_NOTE: <line> | <https://…>` the runner strips (`.claude/rules/office-bridge.md`). `orchestrator/notes.ts` is stateless over `(Db, EventHub)`, so every caller builds its own instead of routing through ThreadManager. Rows: `operator_notes`, **no FK**, task title/workspace SNAPSHOT (a PR outlives the task's 30-day purge). **The anti-spam rules ARE the feature** ("255 chars so they cant spam me, i hate reading agent yapper"): the body TRUNCATES (never rejects — a long note still carries its link), a `url` already listed REFRESHES that row whichever task posts it (one PR = one line, deleted once; keyed on a normalized link identity — a trailing slash, `#issuecomment` or http-vs-https is the same thing to click), and a task holds ≤5 (oldest evicted, never refused). The `url` is agent-supplied and becomes an `href`, so http(s) is enforced at BOTH ends — service refuses, render degrades to text. Gates `test:notes` + `test:office-bridge`; `npm run notes-lab --prefix server`.

## Concise agent communication (Settings → Agent communication, on by default)
`settings.conciseAgentCommunication` is a server-authoritative, `kv`-persisted wording policy. On, every role leads with the answer, uses short concrete plain language, and removes filler, repeated process narration, and avoidable jargon. It covers Director chat, planner/researcher/reader findings, implementor handoffs, QA/reviewer/Supervisor prose, office bridges, and task-status explanations.

This is **not** output truncation and never changes task scope, implementation depth, tests, diagnostics, permissions, tools, bridge grammar, or structured schemas. Blockers, errors, safety caveats, exact commands/IDs, and decision evidence stay intact. `agents/communicationPolicy.ts` supplies one trusted policy block to role system prompts and every fresh/resumed/steered turn; Director and Supervisor use the same live seam, so the next generated turn sees a toggle immediately without a restart. Gate: `test:concise-communication`. `npm run concise-lab --prefix server` drives the authenticated toggle, restart persistence, and phone layout against a throwaway instance (never production).

## Director Supervisor (Settings → Director Supervisor, off by default)
**Off means off:** no timer, agent turn, or DB scan is armed; the one live event subscription returns on one boolean check so a toggle can take effect without reconnecting browsers. **On** adds a single-flight, event-first watchdog (`orchestrator/supervisor.ts`): state transitions enqueue a deterministic health pass, and a backstop sweep runs every 5 minutes while it has active/parked work to watch, but exponentially backs off from 2 to 30 minutes while idle. It reads state, live runs, recent findings/messages and run history before spending a model turn.

For a normal review transition, it may run one bounded check-in to decide whether to delegate to the existing Auto-reviewer; that reviewer, not the supervisor, must verify and accept before a task reaches done.

Only a newly failed non-cap task, a materially stalled active task (no live run past its state-specific 15–25 minute threshold), or a review/failed park forgotten for 6 hours earns the no-tools structured check-in. It uses the current capacity-ready director target, has an 8-turn no-tools ceiling so a first real handoff can be read and reasoned through, and is guarded by a 15-minute per-task cooldown plus a durable daily ceiling of 60 check-ins / $3 / 480K tokens. The compact model, token, cost, reason, skipped/action result and phone-send flag live in `supervisor_events`, so the Supervisor tab can show the last check, budget and audit trail across restart. A restart rehydrates the event-backed cooldown and the global phone cooldown; it never starts a second loop.

The action boundary is deliberately narrow: it can append a normal note, send a critical correction only to a still-live agent, safely call the existing Resume path only for a dropped active run or old failed task, start the existing Auto-reviewer for a newly normal review park, or surface a warning alert. The reviewer is still the only autonomous acceptance path: it must inspect the workspace and return an accepting verdict before the task moves to done. The supervisor does **not** cancel/retry/delete, directly mark work done, revive cancelled work, or resume a human-review/approval wait. A done transition gets a no-agent cleanup audit row only. Supervisor phone notices are Discord-only and only high-signal alerts, owner-visible recoveries, or a watched task's subsequent completion; disabled/incomplete Phone notifications sends nothing. Per-task and global durable cooldowns prevent a flapping task or a restart from buzzing repeatedly. Gate: `test:director-supervisor`.

## Phone notifications (Settings → Phone notifications, off by default)
On, a Discord message when a task settles **done**, needs the owner's **input** (a review park or an `ask_user`), or **fails**. `orchestrator/discordNotify.ts` is standalone (config getter + log callback, no ThreadManager), reads config LIVE per notice so the toggle applies mid-task, and posts to Discord's REST API with a BOT token, not a webhook. **`notifyOwner` posts to Discord, plain `notifyExternal` does not** — that split IS the feature: a cap-park (the supervisor resumes it itself) and every failover/resume line stay off the phone, or the channel stops being read. Route a new owner-facing event through `notifyOwner`. Two invariants: the push preview is built from `content`, so the essential line lives there and the embed only carries detail/repo (an embed-only message previews as "sent an embed"); and sends are **serialized**, since a settling burst fired in parallel earns a 429 each. Token + channel are write-only settings over `DISCORD_BOT_TOKEN`/`DISCORD_CHANNEL_ID`; only `discordTokenPresent`/`last4` are broadcast, and **Send test** is the one way to prove token + channel + post permission at once. Gate: `test:discord-notify`.

## Appearance themes (Settings → Appearance, per browser)
The console ships two looks. **Classic is `web/src/styles.css` with NO attribute on `<html>`** — that is not a convention, it is the whole guarantee: an owner who never opted in cannot be reached by a theme, because every themed rule is scoped behind `[data-theme="<id>"]`. **Nocturne** is the second: near-black midnight ink under a pale cyan accent, a bigger sentence-case heading SCALE on the things that NAME something (task/panel/dialog titles) with mono still carrying every measurement, softer geometry, a lit top edge instead of a flat fill, tinted feed rows, and motion only where a surface arrives — panel, dialog, menu — never in the feed or on the board. Role and state hues are unchanged across both. **A theme owns that scale, never the FACE**: it drew those headings in Instrument Serif until 2026-09-12, which handed a serif to every console that had chosen no heading typeface and could not see a picker for one ("Theme default is still a serif font for the titles"). Every theme rule that can reach a heading now reads `--font-sans`; the serif is one explicit click away in the Heading typeface list. `test:fonts` audits every theme sheet for it and `appearance-lab` checks the computed family under both themes. The pick lives in the browser (the shared `director_settings` record, so each screen keeps its own), is painted by an inline script in `index.html` BEFORE the bundle runs — JS alone flashes Classic on every load — and changes nothing about how tasks run. Gate `test:themes` (scoping, keyframe collisions, the pre-paint list, hard-coded-accent leaks, the picker); browser `npm run appearance-lab --prefix server`, which diffs Classic's computed style across a switch-away-and-back. Third theme: `add-a-theme.md`.

## Typeface picker (Settings → Appearance → Interface / Heading / Monospace typeface, per browser)
Three curated specimen lists let the owner set the console's faces: **Interface** drives `--font-sans` (briefs, prose, buttons), **Heading** drives `--font-display` (the masthead, task/board card headers, section and lane headings, the detail panel's title and its rename input, every dialog title) and **Monospace** drives `--font-mono` (transcripts, tool output, diffs, the Monaco editor, every measurement in the top bar). They are independent on purpose, so a serif interface can never turn a diff proportional and a heading face never reaches a transcript. Seven interface faces (Theme default, System UI, Geist, IBM Plex Sans, Source Serif 4, Space Grotesk, JetBrains Mono), eight heading ones (Theme default, Geist, Instrument Sans, Space Grotesk, Bricolage Grotesque, Instrument Serif, Source Serif 4, JetBrains Mono) and five monospace ones (Theme default, System mono, IBM Plex Mono, Fira Code, Source Code Pro), each row painted in the face it sells from the SAME stack the CSS installs, never a copied approximation. **"Theme default" sets no attribute at all**, the identical guarantee Classic has against a theme: `web/src/fonts.css` is entirely behind `[data-font="…"]`/`[data-font-mono="…"]`/`[data-font-display…]`, so a console that never chose a face matches nothing in it. Faces the console does not already bundle are `@fontsource`/`@fontsource-variable` imports in `main.tsx` (LAN-first, never a CDN); only the `@font-face` declarations are eager, so a browser fetches a woff2 only once something on screen is set in that face. Each face restates the body tracking (and, where a face needs it, the leading) it wants rather than inheriting a number chosen for Inter Tight. `index.html`'s pre-paint script sets both attributes before first paint for a sharper reason than the theme's: a face applied after the bundle loads REFLOWS the whole console on every load. Monaco cannot read a CSS custom property, so the editor reads `--font-mono` itself and re-reads it on a `data-font-mono` mutation. Persisted in the same `director_settings` record as the theme, and applied live with no reload. Only monos on JetBrains Mono's 600/1000 advance are offered, so the top bar's measured chip widths hold (`npm run probe:chips`). Gate: `test:fonts`. Adding a face: `add-a-theme.md`.

**The Heading channel is the one that had to fight for its elements.** The other two only swap a token that rules already read; nothing faces the heading tier as a tier, so `fonts.css` APPLIES `--font-display` to an explicit selector list, and that list is the feature. Two consequences. Every selector is written `:root[data-font-display] <element>`, because `[data-theme="nocturne"] .card .title` faces the same element at the same specificity and `fonts.css` is imported before the theme, so the bare attribute would tie it and lose on source order. That tie WAS the reported bug ("I still can't change the font for the task headers": Nocturne's serif was winning). What is not in the list is equally deliberate: the account meters, badges and pips, elapsed clocks, the build tag, the workspace chip, model ids and every transcript, diff and editor surface read as DATA and stay on `--font-mono`, several of them because the chip row's widths are measured against JetBrains Mono's advance. A face may also restate the tier's weight and size when it needs to, and then owes the phone sizes as well: Instrument Serif ships ONE weight, so the tier's 600 would be drawn as a synthetic bold, and it carries Nocturne's own proven sizes with it. `test:fonts` pins all of that, including a computed specificity comparison against every `nocturne.css` rule that can reach the same heading.

## The AFK screensaver (Settings → Appearance, per browser, ON by default)
After `screensaverIdleMinutes` (default 5, clamped 1..240) with no pointer/key/wheel/scroll activity anywhere in the app, a full-viewport scene covers the board: one gnome per task, rappelling off a scaffold beam and raising a thirteen-piece timber frame. **Every lane is a real task**, not a demo script. `components/screensaver/taskScene.ts` derives the cast from the same live `threads`/`runs`/ `threadDrafts` the board renders from: `ThreadState` picks the pose (working / perched / done + pennant / failed + rope slip), the run trail picks the role and its tool, and the build height is a **floor** (the furthest pipeline stage any run of this task reached, so a QA hand-back can never un-build the frame) plus a saturating **creep** on the live run's real elapsed seconds, which approaches its stage's band and never arrives. Tasks appearing, finishing or failing while it is up animate in and out live.

Rules not to re-break:
- **Dismissal is instant and lossless.** `useIdle` listens on the CAPTURE phase, so the first input
  clears the overlay before anything can consume it; the scene only ever READS the store, so the
  board underneath is byte-for-byte as it was. Activity writes a timestamp, never state: re-arming a
  timer per `mousemove` would be the most expensive thing on the page while somebody works.
- **It idles cheaply.** The scene is a `lazy()` chunk that does not exist until it is wanted, its one
  rAF loop exists only while it is on screen, and it stops entirely on `document.hidden` or
  `prefers-reduced-motion` (which still POSES every lane correctly, it just holds still). The loop
  writes rounded values straight to the DOM and only when they changed, rather than through state.
- **Nothing leaks onto the real console.** `screensaver.css` is scoped entirely under `.gs-root`,
  every keyframe carries a `gs-` prefix (animation names are GLOBAL), and every token it declares is
  `--gs-`. It reads the console's accent, role and state hues through `var()`, so a theme retints it.
- **The rigging is solved, not keyframed.** One target point yields both the rope length and the lean
  (`scene.ts` `rigFor`). A CSS `rotate(+t)` swings a point hanging BELOW the origin LEFT, so reaching
  right is a NEGATIVE rotation; the reversed sign stays plausible while the build is low and only
  walks the gnome off the board once he traverses out along his rafter.

Gate `test:screensaver` (solver composed forward, the live-data mapping, the `nextPhase` lifecycle, the settings, SSR markup, CSS blast radius). Browser: `npm run screensaver-lab --prefix server [-- --shots <dir>] [--video <dir>]`, which boots its own instance on :5317 with a seeded task per lifecycle state and MEASURES the scene across the timeline (computed transforms decomposed back into an impact point) rather than eyeballing stills.

## Before investigating "should we adopt / replace X?"
Read **`docs/DECISIONS.md`** — the closed-questions register: one row per settled question with its headline verdict, plus what's genuinely still open. Adding a backend, swapping the harness, and token-freeze behaviour are already answered there. `grep` finds scripts, never verdicts, so a brief nothing points at gets rebuilt from scratch. If your question is listed, **extend that brief instead of writing a second one**, and add your row in the same commit when you close a new one.

## Conventions
- Conventional Commits (`feat:`/`fix:`/`refactor:`/`chore:`…), matching `git log`.
- One concern per commit — don't sweep unrelated working-tree changes into a fix.
