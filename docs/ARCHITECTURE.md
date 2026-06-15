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
        │                                                               │
        │   PLANNER (read-only)  ─┐                                     │
        │                         ├─▶  IMPLEMENTOR (Opus 4.8, in repo)  │
        │   RESEARCHER (read-only)┘     full tools · streaming input    │
        │                                     ▲                         │
        └─────────────────────────────────────┼─────────────────────────┘
                                              │ inject / interrupt+resume
                       MESSAGE BUS (in-process MCP) ── post_finding · notify_thread
```

The **director** owns the conversation with the user. Each dispatched task
becomes a **thread** that runs the planner→researcher→implementor pipeline. The
**message bus** lets any agent surface a finding; the **thread manager** decides
whether that finding should be injected into a running implementor (live) or
held for the director.

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
| Planner     | claude-opus-4-8  | plan           | Read/Grep/Glob, bus(post_finding) |
| Researcher  | claude-sonnet-4-6| plan           | Read/Grep/Glob, WebSearch/WebFetch, memory, bus |
| Implementor | claude-opus-4-8  | bypassPermissions | all (Read/Write/Edit/Bash/…), bus |

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
intake → enriching → awaiting_user? → planning ─┐
                                                ├─▶ implementing → review → done
                       researching ─────────────┘                 ↑
                                                          paused (inject/resume)
```

- Planner + researcher run **concurrently** (both read-only).
- Their structured outputs (`outputFormat: json_schema`) compose the
  implementor's kickoff message.
- **Finding routing:** when a finding lands on a thread whose implementor is
  live, the manager either (a) `inject`s it as a follow-up user message, or
  (b) `interrupt → resume(sessionId)` with augmented context — chosen by
  severity / a thread policy / the director.

## 6. Persistence (`server/src/db/`)

`better-sqlite3` at `server/data/orchestrator.sqlite`. We store **orchestration
metadata**; the Agent SDK already persists Claude session transcripts as JSONL
on disk (resumable by `session_id`). Tables: `threads`, `agent_runs`,
`messages`, `findings`, `questions`, `director_messages`, `kv`. Schema inlined in
`db/schema.ts` (no copy step on build).

## 7. Realtime protocol (`server/src/ws/protocol.ts`)

One WebSocket per browser. Server→client events and client→server commands are
a single discriminated union (`zod`-validated). Highlights:

- S→C: `hello`, `thread.upsert`, `thread.history`, `run.upsert`, `agent.delta` /
  `agent.text` / `agent.tool` / `agent.tool_result`, `finding`, `question.ask` /
  `question.resolved`, `director.delta` / `director.message` / `director.tool` /
  `director.busy`, `log`.
- C→S: `prompt.new`, `question.answer`, `thread.inject`, `thread.interrupt`,
  `thread.resume`, `thread.cancel`, `thread.history`, `snapshot.request`.

## 8. Memory (`server/src/memory/memory.ts`)

`search_memory` runs a dependency-free **lexical** search over
`~/.claude/memory/`: it reads the markdown memory files, parses their frontmatter
`name`/`description`, and ranks by query-token overlap (cached 60s). No Python /
pgvector / Ollama call, so it degrades gracefully if those are down. The director
and researcher then `Read` a returned path for the full memory; `MEMORY.md` is
exposed as the index.

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
  known, then favors the account with the most **weekly** headroom, skipping any
  that 429-rejected until its reset passes. A run's `rate_limit_event` still flags
  `rateLimited` fast mid-burst (the ping owns the %). State streams to the GUI as
  `accounts` events → the topbar burn strip; a failed ping marks the value
  "stale" (dimmed) after 20 min.
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
  When on, `runPipeline` pauses after planning into `awaiting_approval`, emits
  `plan.ready` (the composed kickoff), and `await`s a pending promise resolved by
  `thread.approve` (approve → implement; reject+feedback → `review`). Off by
  default — tasks build autonomously.
- **Diff review.** `thread.changes` runs `git -C <workspace> diff` + `log` and
  returns it; the ThreadDetail "Diff" button shows it in a modal — review changes
  without leaving the console.
