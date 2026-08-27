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
        │   agent-routed: each stage decides the next                   │
        │                                                               │
        │   PLANNER ─▶ [RESEARCHER] ─▶ IMPLEMENTOR (Opus 4.8) ⇄ QA      │
        │   reads repo   external       does the work in    reviews;    │
        │   + routes     info only      the repo            sole "done" │
        │                                     ▲                         │
        └─────────────────────────────────────┼─────────────────────────┘
                                              │ inject / interrupt+resume
                       MESSAGE BUS (in-process MCP) ── post_finding · notify_thread
```

The **director** owns the conversation with the user. Each dispatched task
becomes a **thread** that runs an **agent-routed** pipeline: the planner runs
first and routes to a researcher or straight to the implementor; the implementor
always hands off to QA; QA alone can declare the task done (§5). The **message
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
| Planner     | eligible free pool → configured paid backend | provider-specific | Read/Grep/Glob — **owns codebase reading**; routes to researcher or implementor. The free harness has no write/shell/network surface and falls back on any failure. |
| Researcher  | claude-sonnet-5  | plan           | WebSearch/WebFetch, memory, bus — **no Read/Grep/Glob** (external info only; the planner reads the repo) |
| Implementor | claude-opus-5    | bypassPermissions | all (Read/Write/Edit/Bash/…), bus |
| QA          | claude-opus-5    | bypassPermissions | Read/Grep/Glob + Bash (runs build/tests), bus — **no Write/Edit** (reviews, doesn't implement); sole role that can mark a task done |
| Reader      | eligible free pool → configured paid backend | provider-specific | Read/Grep/Glob + `git_read` (allowlisted log/show/status/diff, **no Bash**) + `post_finding` — **no Write/Edit/Bash/web** (§5, the read-only `dispatch_read` lane); answers a lookup, no QA |
| Reviewer    | claude-opus-5    | bypassPermissions | Read/Grep/Glob + Bash (runs build/tests, browser-drives UI), bus incl. **`ask_user`** — **no Write/Edit** (§5, the on-demand auto-review); accepts a parked task as done in the owner's place, or hands it back |

The **reader** is the same harness-level enforcement as QA — under `bypassPermissions` the
`disallowedTools` denylist is a HARD block, so listing `Write`/`Edit`/`Bash`/`WebFetch`/… there
makes them un-invokable even though the model runs unsupervised (`readerConfig`, `agents/roles.ts`).
It gets read-only git history without a shell via the `git` MCP server's single `git_read` tool
(`bus/gitReadServer.ts` → `gitService.runReadonlyGit`, allowlist `log`/`show`/`status`/`diff`).

Planner and reader first attempt the **free task pool** (`freeProviders/agentRun.ts`). That provider-neutral
loop exposes only fixed read tools, resolves real paths inside the task workspace, replays normalized
assistant tool calls/results across OpenAI-compatible, Gemini, and Cohere transports, validates the role's
JSON schema, and records every call in the provider quota ledger. Eligibility is fail-closed: the enabled,
freshly revalidated free model must have explicit live or narrowly allowlisted official tool support and visible remaining quota. An error or
missing reader finding records the free run and immediately continues through the unchanged paid-provider
`runRole` ladder. It never serves researcher, implementor, QA, or reviewer.

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
carries its exact supported effort set after the operator's configured cap. Every such
task is graded when it settles so the next pick reads real outcomes rather than
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
- **Agent-routed, planner-first.** `runPipeline` has no fixed sequence — each stage
  decides the next. The planner runs first (reads the repo, plans) and its structured
  output declares `nextAgent` (a `PLAN_SCHEMA` required field): `"researcher"` when the
  task needs external info, else `"implementor"`. The researcher (when invoked) gathers
  **external-only** context and always hands to the implementor. The implementor always
  hands off to QA. QA returns `pass` → `done`, or issues → back to the implementor,
  looping up to `config.maxQaRounds`; **QA is the only role that can declare a task done**
  (else it settles to `review`). The optional approval gate (§12) fires after the plan +
  any research exist, before the implementor.
- **Read lane (`dispatch_read`) — a single-agent short-circuit.** A thread dispatched with
  `lane: "read"` (the director's `dispatch_read` tool) skips the whole planner→implementor→QA
  pipeline: `runPipeline` sees the lane and runs ONE read-only **reader** (`runReader` → Sonnet,
  the §3 read-only toolset), which answers a pure lookup by posting the answer as a finding — no
  planner, no QA. It's for the ~1% of tasks that are answered just by reading (the cost/benefit
  analysis's Option C): seconds-to-minutes and a fraction of the cost of the three-Opus pipeline a
  trivial read otherwise pays for. Its disposition is a lean structured output (`ReaderOutput`):
  `answered` → `done`; `escalated` → it posts a `warning` "needs full pipeline because …" finding
  and parks in `review` so the director re-dispatches through the normal `dispatch`. **The reader
  never half-answers** — anything needing an edit, a build/test, verification, or a broad multi-file
  investigation is an escalation, not a guess. `readerDone` is a sticky stage marker (like
  `planDone`) so a restart mid-read can't re-run the reader and double-post. The card shows a distinct
  **READ** badge (`lane === "read"`), since no QA ran. Sonnet, not Haiku, is the reader's default
  because misrouting *to* the reader is the unsafe direction — it has no QA behind it — so the lane
  is biased to capability (`config.models.reader`, configurable like every role's model).
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
  continues from the failure point (then runs QA). Each stage has a sticky "done" marker
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
- Degrades to single-account (inherited login) when fewer than two tokens are
  configured. A bar reads `—` only before the first successful ping for that
  account.

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
