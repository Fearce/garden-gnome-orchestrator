# Architecture

The contract every module builds against. Read this before touching code.

## 1. Mental model

```
                        ┌──────────────────────────────────────────┐
   you  ───chat──────▶  │  DIRECTOR  (Sonnet 4.6, streaming input)  │
                        │  enrich · recall memories · clarify       │
                        └───────────────┬──────────────────────────┘
                                        │ dispatch(threadId, brief)
                                        ▼
        ┌───────────────── THREAD (one task, one lane) ─────────────────┐
        │   task-aware: smallest capable route per task                 │
        │                                                               │
        │   [PLANNER ─▶ [RESEARCHER] ─▶] IMPLEMENTOR (Opus 4.8) [⇄ QA]  │
        │    reads repo    external       does the work in     reviews  │
        │    + routes      info only      the repo            if needed │
        │                                     ▲                         │
        └─────────────────────────────────────┼─────────────────────────┘
                                              │ inject / interrupt+resume
                       MESSAGE BUS (in-process MCP) ── post_finding · notify_thread
```

The **director** owns the conversation with the user. Each dispatched task
becomes a **thread** that runs a **task-aware** pipeline: every change/build
task gets an implementor, while the planner, researcher and QA stages run only
when the selected route calls for them (§5). The **message
bus** lets any agent surface a finding; the **thread manager** decides whether
that finding should be injected into a running implementor (live) or held for
the director.

## 2. Processes & ports

- `server` — Node 22 / TypeScript / ESM. Fastify on **:4317** (HTTP + `/ws`), and
  a second TLS listener on **:4319** serving the identical route surface. Both come
  from one `buildApp()` sharing the same db/hub/manager/director/accounts; the HTTPS
  one reuses the Dashboard Deck's self-signed pfx so the deck (https://localhost:3940)
  can embed the orchestrator as a same-protocol iframe without Chromium's silent
  mixed-content block. A missing/unreadable cert disables HTTPS only — HTTP keeps working.
- `web` — Vite dev server on **:4318** (proxies `/api` + `/ws` to :4317). In
  production the server serves `web/dist` statically, single origin :4317.

Ports are in the script-hub integer-port convention; both registered there.

## 3. Agent runtime (`server/src/agents/runner.ts`)

One thin wrapper over the Agent SDK `query()`. Every agent we run is an
`AgentRun`:

- Always **streaming-input mode** so we can inject mid-flight and `interrupt()`.
- Backed by an **async message queue** (`InputQueue`) feeding the SDK's
  `AsyncIterable<SDKUserMessage>` prompt. `push(msg)` resolves the generator's
  pending `next()`; `end()` closes it.
- Exposes: `send(text|content)`, `interrupt()`, `setModel()`, `setPermissionMode()`,
  `stop()`, plus an `EventEmitter` of normalized `AgentEvent`s (assistant text
  deltas, tool calls, results, errors, session_id).
- Captures `session_id` from the `system/init` message so the thread can later
  `resume` / `forkSession`.

Model + tool policy per role:

| Role        | Model            | permissionMode | Tools |
|-------------|------------------|----------------|-------|
| Director    | runtime-selected Claude / Codex / Grok / z.ai | provider-specific | Native memory + orchestration MCP on Claude/z.ai; constrained server-command bridge on Codex/Grok — **no repo writes/shell** |
| Planner     | small-task-eligible free pool → configured reliable backend | provider-specific | Read/Grep/Glob — **owns codebase reading**; routes to researcher or implementor. Free admission requires an explicit low-effort, narrow first attempt; otherwise the planner starts on the reliable ladder. |
| Researcher  | claude-sonnet-5  | plan           | WebSearch/WebFetch, memory, bus — **no Read/Grep/Glob** (external info only; the planner reads the repo) |
| Implementor | claude-opus-5    | bypassPermissions | all (Read/Write/Edit/Bash/…), bus |
| QA          | claude-opus-5    | bypassPermissions | Read/Grep/Glob + Bash (runs build/tests), bus — **no Write/Edit** (reviews, doesn't implement); runs only when the selected route needs independent review |
| Reader      | small-task-eligible free pool → configured reliable backend | provider-specific | Read/Grep/Glob + `git_read` (allowlisted log/show/status/diff, **no Bash**) + `post_finding` — **no Write/Edit/Bash/web** (§5, the read-only `dispatch_read` lane); broad/uncertain or repeated lookups skip free quota. |
| Reviewer    | claude-opus-5    | bypassPermissions | Read/Grep/Glob + Bash (runs build/tests, browser-drives UI), bus incl. **`ask_user`** — **no Write/Edit** (§5, the on-demand auto-review); accepts a parked task as done in the owner's place, or hands it back |

The **reader** is the same harness-level enforcement as QA — under `bypassPermissions` the
`disallowedTools` denylist is a HARD block, so listing `Write`/`Edit`/`Bash`/`WebFetch`/… there
makes them un-invokable even though the model runs unsupervised (`readerConfig`, `agents/roles.ts`).
It gets read-only git history without a shell via the `git` MCP server's single `git_read` tool
(`bus/gitReadServer.ts` → `gitService.runReadonlyGit`, allowlist `log`/`show`/`status`/`diff`).

Planner and reader may attempt the **free task pool** (`freeProviders/taskPolicy.ts` →
`freeProviders/agentRun.ts`) only after a deterministic, no-inference size gate. A reader needs the explicit
`dispatch_read` lane; a planner needs an explicit `low` effort override. Both must be first attempts with a
short brief and no attachment, broad/multi-file, production-sensitive, external/live, or investigative
signal. Any uncertainty resolves to the reliable provider ladder. Persisted role-run history makes the
first-attempt rule survive restarts and cap recovery, and a planner note received mid-run moves the re-plan
to a reliable provider instead of buying a free continuation.

The provider-neutral loop exposes only fixed read tools, resolves real paths inside the task workspace,
replays normalized assistant tool calls/results across OpenAI-compatible, Gemini, and Cohere transports,
validates the role's JSON schema, and records every call/token response in the provider quota ledger and
normal run history. Provider admission is independently fail-closed: the enabled, freshly revalidated free
model must have explicit live or narrowly allowlisted official tool support, a sufficient context window,
fresh visible quota, and enough request/token/credit headroom for the whole bounded run. The default
lifetime ceiling is 4 model calls, 10 tool calls, 10K tool-result characters, and 8K reported tokens, with
no structured-output retry. An error or missing reader finding records the free run and immediately
continues through the unchanged Claude/Codex/Grok/z.ai `runRole` ladder; a free cap never creates an
all-providers cap park. The free pool never serves researcher, implementor, QA, or reviewer.

The **director only directs** — it has no filesystem or shell tools at all, so it cannot
investigate a repo itself; any "figure out / debug / why is X" request is forced into
a `dispatch`. Memory recall goes through the scoped `search_memory` / `read_memory` MCP
tools (memory dir only), never a generic `Read`.

The implementor runs **fully autonomous** (`bypassPermissions`): every tool is
auto-approved so dispatched tasks run unsupervised — the same trust model as
`claude --dangerously-skip-permissions` in the repo the director chose. There is
deliberately no per-command approval gate; it would defeat firing many concurrent
tasks. (The `permission_request` event type exists as a hook point if a future
opt-in gate is ever wanted.)

Effort: the implementor defaults to `effort: "high"` (Opus 4.8 sweet spot for
agentic work, per the 4.8 guidance — give the full spec up front, run at high
effort). The planner picks a per-task tier (`plan.effort`), and in skip-director
mode the composer's own effort dropdown pins one onto the dispatch
(`threads.effort_override`), beating the planner's pick.

The Implementor row above is the **default** model, not the only one: with the
opt-in `autoModelSelection` setting the director picks this task's implementor
model AND effort from every backend dispatchable at that moment. It receives every model in each provider's
active-auth live catalog (or the complete curated cold-start catalog), without a per-provider truncation, and each model
carries its exact supported effort set after the operator's configured cap. Each candidate also carries
the live capacity of the exact account/general/dedicated pool it would spend;
known-at-risk models are omitted when a viable pool exists, and a persisted pick is revalidated against
the same workload reserve immediately before launch.
Every auto-selected task is graded when it settles so the next pick reads real outcomes rather than
priors (CLAUDE.md § "Auto model selection"). Precedence is then
`effort_override` > the pick > the planner.

The smart picker also reads a persistent LiveBench snapshot refreshed every 24 hours from the leaderboard's
raw release CSV/category files. Exact-model scores and published effort variants are shown to the judging
agent; newer models may receive only an explicitly labelled older same-family prior. Live availability,
role/tool compatibility, and this orchestrator's own accepted-task grades remain the stronger signals, and
a failed refresh keeps the last snapshot without blocking dispatch.

Those local grades are a durable learning record, not disposable task telemetry. For every auto-picked
task the database retains quality/outcome, QA rounds, whole-pipeline dollars, turns, wall time, and normalized
input/output/cache/reasoning/total tokens; the grade deliberately survives the source task's 30-day purge.
The next choice reads both per-repo and global model aggregates plus model×effort breakdowns. Dollar cost and
token-window burn are separate: a flat-subscription run can say `$0` while still consuming scarce allowance,
so the selector explicitly optimizes the cheapest *reliable* choice across both.

## 4. In-process MCP servers (`server/src/bus/`)

Three **in-process SDK MCP servers** (`createSdkMcpServer` + `tool`), whose tools
run in the orchestrator's own Node process and read/write shared state directly:
`busServer.ts` (the blackboard, below), `memoryServer.ts` (`search_memory`, §8),
and `directorServer.ts` (the director's `ask_user` / `dispatch` / inject controls,
§1). The blackboard tools:

- `post_finding({ summary, detail, severity })` — record a discovery on the
  current thread's blackboard; emits a `finding` event.
- `read_findings({ threadId? })` — read the blackboard (director may read across
  threads; agents default to their own).
- `notify_thread({ targetThreadId, message })` — explicitly flag another thread.

The thread id is bound per-agent at construction (the SDK passes no caller
identity into a tool), so each agent's bus instance is scoped to its thread.

## 5. Thread manager & pipeline (`server/src/orchestrator/threadManager.ts`)

`ThreadManager` holds every live thread and runs the per-thread pipeline inline
(the state machine):

```
intake → enriching → [awaiting_user] → planning → [researching] → [awaiting_approval]
                                                       → implementing ⇄ qa → done | review
                                                  ↕ paused / failed   (Resume re-enters, skipping finished stages)

review ──"Auto-review & mark done"──▶ reviewing ──▶ done            (accepted in your place)
                                          │  ▲
                                          │  └── implementing        (fix round: the reviewer's issues,
                                          │          (×maxReviewFixRounds)   handed to the implementor)
                                          └────────▶ review          (handed back, with reasons)
```

- **Closing a task is a soft move, not a delete.** The ✕ on a card → `thread.close` →
  `closeThread`, which moves a *parked* task to a `closed` state (kept in the DB with a `closed_at`
  stamp, hidden from the main board, restorable) instead of deleting it. It's guarded ONLY on the
  **closeable set** — `done`/`failed`/`cancelled`/`review`/`paused` — and *not* on a live-run check:
  a `review`/`paused` task can keep a stale `live`/`activeRuns`/`stopping` entry after the QA loop
  settles, so `closeThread` **force-stops** any lingering agent (mirroring `cancelThread`'s teardown,
  minus the delete) rather than refusing on it — which is what fixed "a review task can't be closed".
  `awaiting_user`/`awaiting_approval` are intentionally excluded (they hold an in-memory resolver the
  close wouldn't settle). The card ✕ mirrors the set via `isClosable`; the ThreadDetail **Cancel**
  button is separate and still gated on `isTerminal`.
- **Closed tasks: restore, permanent delete, 30-day auto-purge.** Closed tasks live in a collapsed
  "Closed · N" section at the bottom of the board, newest-first, each with **Restore**
  (`thread.restore` → `restoreThread`, back to `closed_prev_state`) and **Delete permanently**
  (`thread.dismiss` → `dismissThread`, the hard delete, behind a confirm). `dismissThread` still
  refuses while a run is genuinely live (`hasActiveRun`). A closed task auto-purges 30 days after
  `closed_at` (`CLOSED_TTL_MS`): `purgeExpiredClosed` sweeps on boot and daily, deleting expired rows
  and broadcasting `thread.removed`. `closed_at`/`closed_prev_state` are written only by
  `closeThread`/`restoreThread` (never the generic `updateThread` SQL), so a normal state change can't
  clobber them; `closed_prev_state` stays off the `Thread` DTO.
- **Agent-routed and task-aware.** `runPipeline` has no fixed mandatory sequence — the selected
  stages decide the next. Whether the planner and/or QA run at all for a given task is itself a
  decision, computed once per pipeline episode by `orchestrator/routeSelection.ts`'s
  `selectRoute()` (a pure, deterministic function of the task's own title/brief text plus a few
  structural dispatch signals — shotgun, a multi-hour timed window, an operator-pinned heavy
  effort — no model call). **Enabling planner/QA (the top-bar toggles / `plannerEnabled`,
  `qaEnabled`) makes a stage AVAILABLE, not mandatory** — the route decides whether THIS task
  actually uses it, and the two ANDed together are the real gate (`settings.plannerEnabled &&
  route.usePlanner`, `settings.qaEnabled && route.useQa && !collaborator`). A narrow, contained,
  low-risk change (a typo fix, a single-file rename, a version bump) runs the implementor alone;
  a contained change with an explicit build/test/verification need can select QA without planning;
  anything broader, riskier (security/auth, money, data/migrations, production/infra), or itself
  ambiguous ("investigate why…", "figure out the best way to…") selects both — the classifier
  biases conservative on anything not confidently narrow, mirroring the read lane's own
  "misrouting to the cheap path is the unsafe direction" rule. The pick is persisted
  (`stage_outputs.routeDecision`, sticky across resume — never reclassified mid-episode) and
  announced as a system message in the task's own feed ("🧭 Route selected — …"), so it's visible
  as a deliberate choice, not a silent omission. When the planner DOES run, its structured output
  declares `nextAgent` (a `PLAN_SCHEMA` required field): `"researcher"` when the task needs
  external info, else `"implementor"`. The researcher (when invoked) gathers **external-only**
  context and always hands to the implementor. The implementor always hands off to QA when QA is
  in the route. QA returns `pass` → `done`, or issues → back to the implementor, looping up to
  `config.maxQaRounds`; **QA is the only role that can declare a task done** when it's in the
  route (else it settles to `review`) — with QA routed around, a clean implementor finish goes
  straight to `done` instead. The optional approval gate (§12) fires after the plan + any
  research exist, before the implementor.
- **Read lane (`dispatch_read`) — a single-agent short-circuit, immune to route selection.** A
  thread dispatched with `lane: "read"` (the director's `dispatch_read` tool) skips the whole
  planner→implementor→QA pipeline and the route decision above entirely: `runPipeline` sees the
  lane and runs ONE read-only **reader** (`runReader` → Sonnet, the §3 read-only toolset), which
  answers a pure lookup by posting the answer as a finding — no planner, no QA, regardless of the
  operator's settings. It's for the ~1% of tasks that are answered just by reading (the
  cost/benefit analysis's Option C): seconds-to-minutes and a fraction of the cost of the
  three-Opus pipeline a trivial read otherwise pays for. Its disposition is a lean structured
  output (`ReaderOutput`): `answered` → `done`; `escalated` → **automatically promoted into the
  normal pipeline, in place** (`handleReadLane`/`promoteEscalatedReadTask`) — it posts a
  `warning` "needs full pipeline because …" finding, durably records the disposition
  (`readerEscalation`), clears `lane` (so the READ badge drops and the thread can never re-enter
  this branch — the structural loop guard), appends its evidence to the brief so the planner/
  implementor inherit the investigation instead of repeating it, and falls through into the SAME
  `runPipeline` call — no new dispatch, no new thread id, no click required. Its reason and partial
  answer are task evidence for the same deterministic route selection, not a blanket full-route
  override: an obvious narrow edit can go directly to the implementor, explicit verification can add
  QA without planning, and broad/risky evidence keeps both safeguards. A
  restart landing between the escalation being recorded and the promotion completing recovers
  from the durable `readerEscalation` record rather than re-running the reader. **The reader never
  half-answers** — anything needing an edit, a build/test, verification, or a broad multi-file
  investigation is an escalation, not a guess. `readerDone` is a sticky stage marker (like
  `planDone`) so a restart mid-read can't re-run the reader and double-post. The card shows a
  distinct **READ** badge (`lane === "read"`) until an escalation clears it. Sonnet, not Haiku, is
  the reader's default because misrouting *to* the reader is the unsafe direction — it has no QA
  behind it — so the lane is biased to capability (`config.models.reader`, configurable like every
  role's model).
- **Auto-review (`thread.autoReview`) — the owner's own review, delegated.** A task parked in
  `review` is waiting for *you*. The detail panel's **Auto-review & mark done** button hands that
  decision to one **reviewer** agent instead (`autoReview` → `runAutoReview`): the thread flips to
  `reviewing` (it holds a concurrency slot like a manual resume), the reviewer inspects the real diff,
  runs the project's checks, browser-tests UI, and — the reason the lane exists — calls the bus
  `ask_user` for anything only you can decide, which parks the thread in `awaiting_user` and restores
  it to `reviewing` on your answer. Its `ReviewerOutput` verdict is the *only* route out:
  `accept` → `done` (exactly what Mark done would have produced), anything else → a fix round (below)
  and ultimately back to `review` with the concrete `issues` recorded as a warning finding. **An absent
  verdict is never an acceptance** — an errored, capped, or turn-ceilinged run re-parks. It is read-only
  (no Write/Edit, and the prompt forbids mutating git), so it decides but never fixes. Guards: only a
  genuine human-review park qualifies — a cap-parked task
  (`CAP_PARK_PREFIX`) is still mid-flight and resumes itself, so the button is disabled there. While a
  review is live it owns the slot alone: the auto-review gates in `injectThread`/`resumeThread` (the QA
  gate's twins) forward steering to whichever agent is live rather than spawning one beside it. Those
  gates key on the **episode** (`this.reviewing`), not on the state, because the fix round below runs
  under `implementing` and the implementor's own `onEnd` clears `this.live` while the awaited result is
  still in flight — a state-only check falls through in exactly that window and cold-resumes a second
  implementor onto the workspace the reviewer is about to inspect (proven by reverting it). And
  a server restart mid-review restores the `review` park rather than taking the generic `failed` +
  manual-Resume path. Like the reader it never fails over to a CLI text-bridge backend
  (`providerServesRole` / `MCP_DEPENDENT_ROLES`) — Codex/Grok have no `ask_user`/`post_finding` (z.ai does,
  so it can take a capped reviewer over). One episode can therefore span backends, so every warm resume of a
  review carries the backend that produced it (`resumableReviewSession`): a session id doesn't travel, and a
  "carry on" nudge means nothing to a session that never heard the question — when that backend can't take
  the run, the recovery is a fresh full review instead. Gate: `test:auto-review`.
- **Director Supervisor — opt-in, bounded operations.** Settings → **Director Supervisor** defaults off;
  while off it owns no timer and spends no agent turn. When enabled, `DirectorSupervisor` subscribes to
  lifecycle transitions and queues all evaluations through one single-flight drain; an adaptive backstop
  sweep catches dropped work (5 minutes with candidates, exponential 2–30-minute idle backoff). Each pass
  first reads only durable task facts — state, active runs, messages, findings and run history. It invokes a
  no-tools, eight-turn structured director judgement only for a newly failed non-cap task, a real stall,
  a normal review transition, or a review/failed park left untouched for six hours. The
  15-minute per-task cooldown and
  durable 60-check-in/$3/480K-token daily cap bound cost across restarts.

  The verdict may append a finding, issue a critical correction only to a still-live agent, call the normal
  resume path for a dropped active/old failed task, delegate a normal review park to the existing
  auto-reviewer (whose accepting verdict alone can mark done), or flag an owner blocker; it cannot cancel,
  retry, delete, directly mark done, revive cancelled work, or resume an owner-review/approval state. Each check, skip,
  verdict/action, compact token/cost record, and Discord-send decision is persisted in `supervisor_events`
  and broadcast to the Supervisor board tab. Discord is consulted only when its own Phone notifications
  configuration is complete; per-task plus durable global cooldowns eliminate restart or flapping duplicates.

  The same tab also has an explicit **existing-task chat** (`SupervisorChat`). An owner turn is written to
  `supervisor_chat_turns` before judgement, with the selected task ids/titles/states captured as an audit
  snapshot. The selection is the complete action scope: the model may ask for status, comment, steer through
  `injectThread`, pause through `interruptThread`, resume through `resumeThread`, delegate the existing
  auto-reviewer, or escalate, but it cannot create work or reach an unselected task. Clear new-work requests
  are redirected to Director without dispatching anything; ambiguity becomes a durable `needs_input` reply.
  Chat judgements share the supervisor's single no-tools queue, ahead of background checks, while manual **Run
  now** retains its full-sweep behavior. A restart fails orphaned pending turns closed rather than replaying a
  potentially completed control action.

  Every owner-facing composer uses the same delivery contract. The browser renders an optimistic message with
  a UUID and **Sending…** receipt immediately; Director, Office, and Supervisor persist that UUID as the row id,
  and the returning server event replaces the placeholder. Task injection reconciles against its persisted
  feed echo and correlated `thread.action` receipt. Socket loss or a missing confirmation becomes a visible
  delivery failure, never a cleared composer followed by unexplained silence.
- **A hand-back buys a fix round, not a trip to your desk** (`runReviewFixRound`). Because the reviewer
  is read-only, what blocks a task is routinely work an implementor finishes in a minute — the case this
  was built for handed back a whole task because a report file sat outside the workspace, costing a
  second click and a second full Opus review to clear. So an `accept: false` carrying concrete `issues`
  relaunches the **implementor** with that list (the pipeline's own resume/failover/auto-continue path, a
  QA fix-round in all but name, and deliberately **no** QA loop — the reviewer is the gate this lane
  delegated to), then **warm-resumes the reviewer's own session** to re-check the changed tree and decide
  again. Bounded by the `maxReviewFixRounds` setting (default 1, `0` = hand straight back); a hand-back
  with *no* issues buys nothing, since the implementor would only be guessing. A failed fix round parks —
  it can never itself become a route to `done` — and the final park says how many rounds were spent, the
  difference between "the reviewer said no" and "it said no, was fixed, and still says no". The round runs
  under `implementing`, an auto-resume state, so it carries a durable `reviewFixing` marker that makes
  `markInterrupted` re-park it for a fresh click instead of reviving it into the normal pipeline. **A cap
  during a fix round parks like any other failure, deliberately WITHOUT the `CAP_PARK_PREFIX` marker**
  (`capParked` is consumed, not passed to `settleReview`): `resumeCapParked` resumes a marked task through
  `runPipeline` — the full QA loop, which can reach `done` on its own — which would settle this task on a
  verdict the reviewer never gave, and `autoReview` refuses a cap-parked task so the owner couldn't even
  intervene. A routing block is handled the same way rather than letting `gateImplementorProvider`'s
  `failed` demote an already-finished, owner-parked task.
  `REVIEWER_PROMPT` tells the reviewer a fixer follows, so its issues read as work orders rather than as
  "I can't fix this myself".
- **QA fix-rounds resume the QA session.** Round 1 is a fresh QA session seeded with a *scope hint*
  (the plan summary + the files it expected to touch) so QA doesn't burn Opus turns rediscovering the
  change surface. Rounds 2..N **resume that same QA session** (same warm/cold gate as the implementor;
  back-to-back rounds are warm → a ~0.1× cache read) with only a short "re-verify your issues against
  the new diff" nudge, instead of a fresh Opus session re-reading the whole diff/tests from scratch.
  QA still independently runs `git diff` + the build/tests every round — it just doesn't re-pay to
  reconstruct context it already holds.
- The plan + any research compose the implementor's kickoff; `formatResearch` folds the
  researcher's brief into that kickoff (the planner runs first and no longer reads it).
- **Resumability.** Each completed stage's output is persisted to `threads.stage_outputs`
  (JSON; additive read-merge-write so a later stage never clobbers an earlier one). A
  `failed` thread re-enters `runPipeline`, which skips the stages already saved and
  continues from the failure point, including QA only when the selected route includes it. Each stage
  has a sticky "done" marker
  (`planDone`/`researchDone`/`approved`) so a stage that legitimately produced *nothing* (e.g. the
  planner returned no structured plan) isn't re-run on resume — a re-run would be a wasted Opus pass.
  A `review`/`done`/`paused` thread instead takes
  the lighter `resumeImplementorOnly` path — it talks **only** to the implementor (no QA loop) and
  settles back to `review` when it finishes. Both reuse the prior implementor session through the
  same warm/cold gate (below). `markInterrupted` flips in-flight threads to `failed` on boot but
  leaves `stage_outputs` intact, so a restart mid-task is recoverable rather than lost. A manual
  resume that lands while a prior cold resume is still *materializing* (compressing) is coalesced via
  a `resuming` guard so it can't double-start a second implementor on the same workspace; an inject in
  that window is buffered and delivered once the implementor is live; a cancel in that window wins
  (the resume re-checks `cancelled()` after compressing and won't start).
- **Resume only compresses when it pays off (warm/cold gate).** A *recent* resume hits a still-warm
  prompt cache (≈1h TTL on a subscription), so a normal full resume is cheap (cache read ≈0.1×) and
  keeps full fidelity — compressing then would just burn a Haiku call and lose detail. So the resume
  branch checks the session's age from its transcript mtime (`sessionAgeMs`): within
  `config.resumeWarmMinutes` (default 40, under the 1h TTL) → **full session resume**; older (cache
  likely cold) → **compressed resume**. `RESUME_FULL_SESSION=1` forces full resume regardless of age.
  **This gate is the single choke-point for *every* implementor resume** — `startResumedImplementor`,
  shared by the pipeline's implementor→QA loop (a `failed` thread re-entering) **and** a manual
  `Resume` / an `inject` into a cold (non-live) task. The manual path matters most for cost: after a
  server restart the in-memory `live` map is empty, so resuming *any* `review`/`done`/`paused` thread
  is a cold resume — without this it silently reloaded the whole prior implementor transcript at full
  Opus rate. A still-live thread (incl. a `paused` one whose run wasn't torn down) skips the gate
  entirely and just `send()`s into the open session — the cheapest resume of all.
- **Compressed resume (cold path).** Reloading the entire prior SDK session cold is the *expensive*
  part of a resume — every tool call and file it had read re-charged (a long session is hundreds of
  K of tokens). So the cold path does **not** reload that transcript. `composeResumeKickoff` starts a
  **fresh** session seeded with
  three small parts: the plan (from `stage_outputs`); a **locally-compressed handoff** of the prior
  session that *preserves its reasoning*; and the workspace's current git progress (`git diff` +
  commits). The handoff (`resumeCompress.ts`, vendored from `C:\claude-resume-lite`) finds the
  on-disk transcript (`~/.claude/projects/<slug>/<sessionId>.jsonl`) and does a free static strip of
  re-derivable junk (old tool output, thinking, big inputs, images — keeping the conversation + a
  files-touched list). The stripped **old** turns are then compressed cheaply:
  - **already small** (≤ `RESUME_INLINE_OLD_MAX`, ~6K tokens) → kept **verbatim, no Haiku call** —
    the common case, so most resumes spend **zero** summary tokens;
  - **large** → a **single Haiku call** over only the most-recent `RESUME_HAIKU_INPUT_CAP` chars
    (~90K tokens; older context dropped with a note), capped output (`RESUME_SUMMARY_OUTPUT`, 8K) —
    so Haiku input is bounded to one call rather than re-reading the whole 200K+ session.
  The **recent** turns stay verbatim. Real sessions still compress **~30–50×** (a 185K-token session
  → ~4K). It degrades gracefully and **bounded**: Haiku failure (after one retry) or no token → the
  *same capped* static slice (never the full transcript); no transcript → plan + git only.
  `RESUME_FULL_SESSION=1` forces a full-fidelity reload of the prior session (from the latest
  `agent_runs.session_id`, which survives a restart unlike the in-memory map) when a task genuinely
  needs its exact prior context. The Haiku handoff is told **not** to restate the goal/plan (the
  kickoff already carries them authoritatively) — it captures only the session delta (decisions, work
  done, gotchas, what's left).
- **Task modes — a wall-clock window, and N agents on one objective** (`orchestrator/timedTasks.ts`,
  `orchestrator/shotgun.ts`). Two opt-in per-task modes on this same pipeline, not lanes and not
  schedules. Both hang off nullable thread columns, so a task that uses neither is byte-for-byte
  unaffected: `duration_ms`/`deadline_at` (timed) and `agent_count`/`parent_id`/`assignment` (shotgun).
  Both hooks sit in `runImplementorQaLoop` *between* the implementor and the QA hand-off, so QA still
  reviews the finished work exactly once.
  - **Timed** — "work on this for 8 hours". `deadline_at` is stamped ABSOLUTE when the task acquires
    its first pipeline slot (time spent queued does not eat the window) and every round counter is durable in `stage_outputs`, so ONE
    window survives a restart, a turn ceiling, a provider hand-off and a cap park: each re-enters the
    pipeline and re-asks `timedDecision` rather than depending on a timer in memory. **The deadline is
    enforced at round BOUNDARIES, never by aborting a live turn** — a mid-turn abort returns a
    success-shaped result with no output that nothing downstream can distinguish from a real finish
    (the `steerStructuredRole` trap), so a round running at the deadline finishes and the deadline
    denies the *next* one. Bounded twice, because a round count alone cannot tell forty useful hours
    from forty no-op rounds in ninety seconds: `timedMaxExtensions` AND a hollow-round guard (a round
    that returns instantly having produced no agent messages; three consecutive ⇒ close). Finishing
    EARLY is a first-class outcome — the implementor writes a standalone `TIMED_TASK_COMPLETE: <why>`
    line and the window closes unused rather than padding the task. Every close posts its reason.
  - **Shotgun** — "use 3 agents". The no-worktrees convention means parallelism cannot come from
    isolating checkouts, so it comes from DISJOINT OWNERSHIP in the one shared tree: one extra planner
    call decomposes the plan into work packages with non-overlapping file lists, the lead takes the
    first, and each other becomes a COLLABORATOR thread (`parent_id`) on the same workspace running the
    ordinary implementor path with `qaEnabled: false`. Sharing a workspace means `ensureGroup` forms
    their office project room for free — exactly the case it was built for. The lead then waits at a
    barrier, runs ONE integration/reconcile round over the combined tree, and ONE QA pass reviews the
    result. **Overlapping ownership is a rejection, not a warning** (two agents in one file in one tree
    lose work silently, with no merge step to catch it): the task degrades to a normal single-agent run
    with the reason posted, which is a supported outcome since most tasks cannot be split. Collaborators
    are persisted as one atomic split — narrowed lead kickoff, every child assignment and
    the complete barrier list commit before any child can start — so a restart can launch only the
    complete durable set. Legacy partial splits are parked instead of guessed at; root, absolute/drive
    and `..` ownership paths are rejected. A timed split that expires during decomposition creates no
    children, and children inherit the lead's exact absolute deadline.
    **bypass both concurrency caps** — the lead holds a slot and then blocks on its children, so queueing
    a child behind a cap its own parent occupies deadlocks the pair; `MAX_AGENTS` bounds it instead. The
    barrier polls DURABLE child state rather than holding promises, which is what lets an auto-resumed
    lead re-read where its children got to after a bounce. Collaborators are hidden from the board and
    rendered inside the lead's detail panel.
- **Finding routing:** when a finding lands on a thread whose implementor is
  live, the manager either (a) `inject`s it as a follow-up user message, or
  (b) `interrupt → resume(sessionId)` with augmented context — chosen by
  severity / a thread policy / the director.

## 6. Persistence (`server/src/db/`)

`better-sqlite3` at `server/data/orchestrator.sqlite`. We store **orchestration
metadata**; the Agent SDK already persists Claude session transcripts as JSONL
on disk (resumable by `session_id`). Tables: `threads`, `agent_runs`,
`messages`, `findings`, `questions`, `director_messages`, `attachments`, `kv`.
`threads.stage_outputs` (JSON, nullable) holds the per-stage outputs that make a
task resumable (§5) — kept off the WS wire (it can be multi-KB) and read only by
the resume path, not folded into the `Thread` DTO. Schema inlined in
`db/schema.ts` (no copy step on build); additive columns added via idempotent
`ALTER TABLE … ADD COLUMN` in `migrate()`.

## 7. Realtime protocol (`server/src/ws/protocol.ts`)

One WebSocket per browser. Server→client events and client→server commands are
a single discriminated union (`zod`-validated). Highlights:

- S→C: `hello`, `thread.upsert`, `thread.message` (a server-originated thread feed
  row, e.g. a director inject echoed live), `thread.history`, `run.upsert`,
  `agent.delta` / `agent.text` / `agent.tool` / `agent.tool_result`, `finding`,
  `question.ask` / `question.resolved`, `plan.ready` / `approval.mode`,
  `thread.changes`, `director.delta` / `director.message` / `director.tool` /
  `director.busy`, `log`.
- C→S: `prompt.new`, `question.answer`, `thread.inject`, `thread.interrupt`,
  `thread.resume`, `thread.cancel`, `thread.close`, `thread.restore`, `thread.dismiss`,
  `thread.history`, `thread.approve` / `approval.set`, `thread.changes`, `snapshot.request`.

## 8. Memory (`server/src/memory/memory.ts`)

`search_memory` runs a dependency-free **lexical** search over
`~/.claude/memory/`: it reads the markdown memory files, parses their frontmatter
`name`/`description`, and ranks by query-token overlap (cached 60s). No Python /
pgvector / Ollama call, so it degrades gracefully if those are down. The director
then calls `read_memory` on a returned path for the full text (the researcher has
`search_memory` only, for external-context lookups — no codebase or file reading);
`MEMORY.md` is exposed as the index.

## 9. Frontend (`web/`)

React + Vite + Zustand. A **director board**: left rail = chat with the
director; main = concurrent thread lanes (state, live agent text, tool calls,
findings); a thread opens to a detail view with the inject/interrupt controls.
Design: intentional type + OKLCH palette, mission-control density — no AI-slop
defaults (see root CLAUDE.md doctrine).

## 10. Multi-subscription load balancing (`server/src/accounts/`)

Dispatch is capacity-aware at three levels: Claude subscription, provider, and exact model pool.
`orchestrator/capacityRouting.ts` turns each role into a conservative duration/burn/reserve estimate
(expanded by implementor effort, plan size/risk, and a timed task's active window), then evaluates every
visible quota window that gates the candidate. The inventory includes Claude and z.ai 5h + weekly windows,
the Codex general and per-model 5h + weekly pools, Grok weekly + monthly credits, routing ceilings, and
live cap latches. This builds on the existing hard-cap failover and reset supervisor; it does not replace
their mid-run recovery. The independently implemented free planner/reader pool stays ahead of this ladder:
its lease already reserves a whole bounded run across visible request/token/credit limits, and by design a
free-pool miss falls through immediately instead of joining the reliable-provider cap park.

Run agents across **two (or more) Claude subscriptions**, routing each dispatch
to **burn the "perishable" weekly allowance first** — the sub whose weekly window
resets soonest — and keeping the long-runway one in reserve for when it caps.

- **Tokens, per-run.** Each account is `{ id, label, token }` from
  `ACCOUNT_<n>_TOKEN` (long-lived `claude setup-token` tokens). The runner sets
  `CLAUDE_CODE_OAUTH_TOKEN` **per agent run** (`AgentRunConfig.oauthToken`), so
  concurrent agents can run on **different** accounts at once — unlike the background
  orchestrator's global credential swap. We deliberately do **not** touch that
  orchestrator's live credential files.
- **Burn signal — a tiny Haiku ping** (`usagePing.ts`). `claude setup-token`
  tokens **403** on `/api/oauth/usage`, but the **`/v1/messages`** endpoint
  accepts them, and *every* response carries `anthropic-ratelimit-unified-*`
  headers with exact live 5h + weekly utilization (a 0-1 fraction → ×100) + reset
  epochs + status. So each account is read by firing a minimal Haiku message
  (`max_tokens:1`, "hi" — ~9 tokens) and parsing those headers. This gives real
  numbers for **both** subs (not just the active one), works with setup-tokens,
  and — because the message is a real send — also **starts that window's timer**.
- **AccountManager** (`accountManager.ts`) pings every account on an interval
  (`ACCOUNT_PING_MS`, default 10 min) for a fresh display, and additionally
  schedules a one-shot ping **right at each window's reset** (from the reset
  epochs) so the strip flips to ~0% and the new window's timer starts the instant
  it resets. `select()` round-robins (least-recently-selected) until burn is
  known, then **prefers the account whose weekly window resets soonest**
  (`bySelectionPriority`) — so the about-to-reset weekly allowance is spent rather
  than wasted, while the sub with days of runway is held back. A capped/near-limit
  account (429-rejected, or ≥ `HARD_LIMIT` on its tightest window) is dropped from
  the pool, so we ride the soonest-reset sub until it hits its 5h (or weekly) cap,
  fail over to the reserve, then snap back the moment the first sub's window resets
  (its reset-ping clears the cap; whichever sub is now closest to its weekly reset
  takes over). Weekly headroom → 5h headroom → round-robin are the tiebreaks. A
  run's `rate_limit_event` still flags `rateLimited` fast mid-burst (the ping owns
  the %). State streams to the GUI as `accounts` events → the topbar burn strip; a
  failed ping marks the value "stale" (dimmed) after 20 min.
- **Mid-task failover** (`threadManager.ts`). The account is picked per run, but if it
  hits a 5h/weekly cap *mid-run* (`rate_limit_event` `status:"rejected"` →
  `AgentRun.rateLimited`), the task doesn't stall: `selectFailover` picks another account
  with headroom and the run is **relaunched resuming the session** (`resume: sessionId`,
  re-sent a "continue where you left off" nudge) on it — so the work-so-far is preserved
  and the task continues uninterrupted. Applies to every role (planner/researcher via
  `runRole`, implementor + QA-fix rounds via `awaitImplementorResult`) and to manual
  resume; up to 3 hops, then it settles to `review` only if *no* account has headroom (it
  never runs QA on a half-finished implementation). A webhook ping fires on each switch.
- **Workload-sized runway, before dispatch.** Known-viable capacity wins over unmetered capacity, which
  wins over known-at-risk capacity. Existing weekly-safety, spread-usage, and soonest-reset preferences
  remain tiebreakers inside that capacity tier. A reset inside the estimated run reduces the amount that
  must be available before dispatch; a reset after completion does not. Weekly and monthly windows keep
  gating dispatch, but task burn is weighted lower than a 5h window so substantial work is not stranded
  behind a healthy long-window allowance. Short roles may therefore bridge a near reset, while substantial
  implementation/QA work is parked instead of knowingly starting on a pool forecast to expire mid-task.
  An owner-triggered reviewer refuses the same known-doomed launch and
  leaves the task in review with the next viable reset, because that manual lane deliberately does not
  join pipeline auto-resume. Unknown telemetry remains dispatchable as a bounded fallback so
  API-key and cold-start installations do not deadlock. The task gets a finding with its workload reserve,
  selected provider, and every compared meter.
- **Honest capacity waits.** A capacity park inventories every compatible account/provider/model pool and
  simulates the combined windows at each future reset. It will not advertise or schedule a 5h wake while
  the same pool's weekly/monthly gate remains exhausted. The task error names the limiting pool(s), the
  next reset that would actually make one viable (or says no reliable reset is known), and the supervisor
  rechecks the same role-sized reserve before auto-resuming. Gate: `test:capacity-routing` and
  `test:codex-usage` plus the existing provider-fallback, QA-budget, auto-model, and Codex-pool gates.
- Degrades to single-account (inherited login) when fewer than two tokens are
  configured. A bar reads `—` only before the first successful ping for that
  account.
- **A ChatGPT plan is not one allowance** (`agents/codexPools.ts`). `account/rateLimits/read` returns
  `rateLimitsByLimitId` beside the plan-wide windows: the general `codex` pool, plus a dedicated pool
  per model that ships its own (GPT-5.3-Codex-Spark). Each has its own 5h/weekly windows, its own
  resets and its own cap latch (`codex_pool_cap_until`, separate from `codex_cap_until`) — so a 429 in
  one is never read as a cap in the other, in either direction. The model→pool link is derived by
  normalizing the pool's human `limitName`, never its `limitId`, which is an internal codename
  (`codex_bengalfox`) with no relation to the model slug. A dedicated pool serves **only** the bounded
  roles — reader, planner, researcher — and that is a capability rule rather than a thrift one: the CLI
  ships Spark instructed never to verify its own work or run tests, with a 128K context against the
  flagships' 272K, which makes it wrong for the implementor and unsafe for QA or the reviewer. Routing
  fails closed: no visible meter, no dispatchable model, or a live latch ⇒ ordinary routing. Gate:
  `test:codex-pools`; the nightly ladder readout prints each pool under the backend rungs.
- **Separately metered model pools are real routing candidates.** Eligible bounded roles proactively compare
  each live dedicated Codex pool with the general pool and the other providers using the same role-sized
  runway; a pool does not need the Claude/general pool to cap first. An explicit eligible-role model pin
  still consumes its exact pool and remains independent of a general-pool latch. Choosing a non-Claude
  role also defers Claude account selection, so the unused subscription is not woken merely to construct
  the run. Capability exclusions for implementor/QA/reviewer remain unchanged.

## 11. Image attachments (paste / drop / pick → vision)

Pasted, dropped, or picked images ride the prompt as native **image content blocks**
(base64). Claude/z.ai consume them natively and Codex materializes them for `--image`;
the Grok headless adapter is the one image-input degradation.
CLI/SDK image input is base64-only; there is no file-path image source.

- **Capture** (`web/src/lib/attachments.tsx`). `useAttachments()` handles paste
  (clipboard `file` items), drag-drop, and a paperclip file-picker; caps at 8
  images / 5 MB each; images only. Both composers (Director new-task +
  ThreadDetail inject) share it. Previews render from data URLs; sent bubbles
  render from `/api/attachment/:id`.
- **Transport.** `prompt.new` / `thread.inject` carry `images: [{name, mediaType,
  dataBase64}]` (zod-validated, `.max(8)`; `ws` `maxPayload` lifted to 64 MB).
- **Fan-out — the hard part.** Each role is an isolated session and the
  director's `dispatch` tool is text-only, so the bytes can't ride the brief. The
  director stashes the turn's images (`pendingImages`); a getter handed to
  `createDirectorServer` forwards them into `ThreadManager.dispatch`, which keeps
  them in `threadImages[threadId]`. `kickoffContent()` then wraps **every** role's
  `agent.start` (planner/researcher/QA/implementor) so each one sees them; live
  QA-fix rounds and resumes reuse the session, which already holds them. The map
  entry is freed when the pipeline ends.
- **Persistence.** Bytes live in an `attachments` table (base64); director
  messages store lightweight refs (`{id, name, mediaType}` JSON). Refs travel over
  WS; bytes are fetched on demand via `GET /api/attachment/:id` (clamped to known
  image types + `nosniff`) — keeping base64 off the streaming hot path.

## 12. Notifications, LAN access, plan-gate + diff review

Three controls that make the console a hands-off, anywhere replacement for the CLI.

- **Notifications** (`web/src/lib/notify.ts`, opt-in via the topbar bell). On a
  `question.ask` (a task needs you) or a thread reaching done/review/failed, fire
  a Web `Notification` + a short Web-Audio chime — so you don't watch the tab. For
  when you're away from the machine the server pings the same events outward:
  an external webhook if `NOTIFY_WEBHOOK_URL` is set, and — with Settings → **Phone
  notifications** on — a Discord message via a bot token
  (`orchestrator/discordNotify.ts`). The two sinks are deliberately not the same
  set: `ThreadManager.notifyOwner` feeds Discord and carries only what the owner
  acts on (done · needs-input · failed), while plain `notifyExternal` also carries
  pipeline chatter (cap failover, auto-resume) that must never reach a phone.
- **Access auth** (`server/src/auth.ts`). A **password and/or Google sign-in**, both valid
  when configured — each mints the same HMAC-signed (`email|exp`) httpOnly session cookie, and
  `isAuthed` accepts that one cookie. `authRequired()` is true if either method is set; the `/ws`
  upgrade + attachment endpoint enforce it.
  - **Password** (`AUTH_PASSWORD`) — `POST /api/login` checks it (timing-safe) behind a **per-IP
    wrong-password cooldown** (`LOGIN_COOLDOWN_MS`, default 30s; 429 + `retryMs` while locked), so a
    short PIN is brute-force-safe. The cookie holds the *signed session*, never the password, so the
    PIN is only testable through the cooldown-gated endpoint. Works over the raw LAN IP (the tablet).
  - **Google OIDC** (`GOOGLE_CLIENT_ID`/`SECRET`, `ALLOWED_EMAIL`) — `/api/auth/google` 302s to Google
    with a CSRF `state` bound to a one-time cookie; `/api/auth/callback` decodes the trusted `id_token`,
    checks `aud` + `email_verified` + the allowlist, sets the session. Google **rejects raw private-IP
    redirect URIs**, so it's `localhost`/desktop only (or an https `PUBLIC_ORIGIN`, e.g. Tailscale) —
    the tablet falls back to the password. Wrong account → `/?e=forbidden` (with a `select_account` escape).
  The login screen shows whichever methods are enabled (Google button + password field). Safety: the
  server **refuses to bind a non-localhost `HOST` without auth configured**, falling back to 127.0.0.1.
- **Plan-approval gate** (global toggle, persisted in `kv:require_plan_approval`).
  When on, `runPipeline` pauses after the plan (and any research) into
  `awaiting_approval`, emits `plan.ready` (the composed kickoff), and `await`s a
  pending promise resolved by `thread.approve` (approve → implement; reject+feedback
  → `review`). On resume it's skipped if already approved. Off by default — tasks
  build autonomously.
- **Diff review.** `thread.changes` runs `git -C <workspace> diff` + `log` and
  returns it; the ThreadDetail "Diff" button shows it in a modal — review changes
  without leaving the console.
