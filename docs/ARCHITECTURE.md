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

- `server` — Node 22 / TypeScript / ESM. Fastify on **:4317** (HTTP + `/ws`).
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
| Director    | claude-sonnet-4-6| bypassPermissions | memory (search_memory/read_memory) + orchestration MCP only — **no Read/Grep/Glob/Bash** |
| Planner     | claude-opus-4-8  | plan           | Read/Grep/Glob, bus(post_finding) — **owns codebase reading**; routes to researcher or implementor |
| Researcher  | claude-sonnet-4-6| plan           | WebSearch/WebFetch, memory, bus — **no Read/Grep/Glob** (external info only; the planner reads the repo) |
| Implementor | claude-opus-4-8  | bypassPermissions | all (Read/Write/Edit/Bash/…), bus |
| QA          | claude-opus-4-8  | bypassPermissions | Read/Grep/Glob + Bash (runs build/tests), bus — **no Write/Edit** (reviews, doesn't implement); sole role that can mark a task done |

The **director only directs** — it has no filesystem or shell tools, so it cannot
investigate a repo itself; any "figure out / debug / why is X" request is forced into
a `dispatch`. Memory recall goes through the scoped `search_memory` / `read_memory` MCP
tools (memory dir only), never a generic `Read`.

The implementor runs **fully autonomous** (`bypassPermissions`): every tool is
auto-approved so dispatched tasks run unsupervised — the same trust model as
`claude --dangerously-skip-permissions` in the repo the director chose. There is
deliberately no per-command approval gate; it would defeat firing many concurrent
tasks. (The `permission_request` event type exists as a hook point if a future
opt-in gate is ever wanted.)

Effort: implementor runs `effort: "high"` (Opus 4.8 sweet spot for agentic
work, per the 4.8 guidance — give the full spec up front, run at high effort).

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
```

- **Agent-routed, planner-first.** `runPipeline` has no fixed sequence — each stage
  decides the next. The planner runs first (reads the repo, plans) and its structured
  output declares `nextAgent` (a `PLAN_SCHEMA` required field): `"researcher"` when the
  task needs external info, else `"implementor"`. The researcher (when invoked) gathers
  **external-only** context and always hands to the implementor. The implementor always
  hands off to QA. QA returns `pass` → `done`, or issues → back to the implementor,
  looping up to `config.maxQaRounds`; **QA is the only role that can declare a task done**
  (else it settles to `review`). The optional approval gate (§12) fires after the plan +
  any research exist, before the implementor.
- The plan + any research compose the implementor's kickoff; `formatResearch` folds the
  researcher's brief into that kickoff (the planner runs first and no longer reads it).
- **Resumability.** Each completed stage's output is persisted to `threads.stage_outputs`
  (JSON; additive read-merge-write so a later stage never clobbers an earlier one). A
  `failed` thread re-enters `runPipeline`, which skips the stages already saved and
  continues from the failure point. The `Resume` control on a failed/paused/review thread
  triggers this; `markInterrupted` flips in-flight threads to `failed` on boot but leaves
  `stage_outputs` intact, so a restart mid-task is recoverable rather than lost.
- **Compressed resume (default).** Reloading the implementor's entire prior SDK session is the
  *expensive* part of a resume — after a restart it's a cold-cache reload of every tool call and
  file it had read (a long session is hundreds of K of tokens). So by default the resume does
  **not** reload that transcript. `composeResumeKickoff` starts a **fresh** session seeded with
  three small parts: the plan (from `stage_outputs`); a **locally-compressed handoff** of the prior
  session that *preserves its reasoning*; and the workspace's current git progress (`git diff` +
  commits). The handoff (`resumeCompress.ts`, vendored from `C:\claude-resume-lite`) finds the
  on-disk transcript (`~/.claude/projects/<slug>/<sessionId>.jsonl`), does a free static strip of
  re-derivable junk (old tool output, thinking, big inputs, images — keeping the conversation + a
  files-touched list), then a cheap **Haiku** summary of the older turns (recent turns kept
  verbatim) via `/v1/messages` on an account token. Real sessions compress **~30–50×** (a 185K-token
  session → ~4K). It degrades gracefully: Haiku failure → free static strip; no transcript → plan +
  git only. `RESUME_FULL_SESSION=1` forces a full-fidelity reload of the prior session (from the
  latest `agent_runs.session_id`, which survives a restart unlike the in-memory map) when a task
  genuinely needs its exact prior context.
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
  `thread.resume`, `thread.cancel`, `thread.history`, `thread.approve` /
  `approval.set`, `thread.changes`, `snapshot.request`.

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
to whichever sub has the most headroom so neither is wasted.

- **Tokens, per-run.** Each account is `{ id, label, token }` from
  `ACCOUNT_<n>_TOKEN` (long-lived `claude setup-token` tokens). The runner sets
  `CLAUDE_CODE_OAUTH_TOKEN` **per agent run** (`AgentRunConfig.oauthToken`), so
  concurrent agents can run on **different** accounts at once — unlike the trading
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
  known, then favors the account with the most **weekly** headroom, skipping any
  that 429-rejected until its reset passes. A run's `rate_limit_event` still flags
  `rateLimited` fast mid-burst (the ping owns the %). State streams to the GUI as
  `accounts` events → the topbar burn strip; a failed ping marks the value
  "stale" (dimmed) after 20 min.
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

Pasted, dropped, or picked images ride the prompt as native Anthropic **image
content blocks** (base64), so every agent — the Sonnet director and the
Opus/Sonnet pipeline roles — *sees* them via vision (no Read-tool round-trip).
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
  a Web `Notification` + a short Web-Audio chime — so you don't watch the tab. The
  server also pings an external webhook on those events if `NOTIFY_WEBHOOK_URL` is
  set (`ThreadManager.notifyExternal`), for when you're away from the machine.
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
