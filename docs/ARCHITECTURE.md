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
| Director    | claude-sonnet-4-6| default        | memory + orchestration MCP, AskUserQuestion, Read/Grep/Glob |
| Planner     | claude-opus-4-8  | plan           | Read/Grep/Glob, bus(post_finding) |
| Researcher  | claude-sonnet-4-6| plan           | Read/Grep/Glob, WebSearch/WebFetch, memory, bus |
| Implementor | claude-opus-4-8  | bypassPermissions | all (Read/Write/Edit/Bash/…), bus |

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
- **Burn signal — why not the usage endpoint.** `claude setup-token` tokens
  **cannot** read `/api/oauth/usage`: it returns `403` for anything but an
  interactive OAuth access token (the kind the agent-orchestrator reads from
  `~/.claude/.credentials.json`, for the *active* account only). So this console
  can't poll usage like that orchestrator does. Instead, per-account burn comes
  from each run's **`rate_limit_event`** — the message API returns `utilization`
  (0-100), `rateLimitType` (`five_hour`/`seven_day`/…), and `status`
  (`allowed`/`allowed_warning`/`rejected`) for the account actually running. This
  needs no extra calls and works with setup-tokens.
- **AccountManager** (`accountManager.ts`) keeps each account's last-known 5h/7d
  utilization (from `updateFromRateLimit`, fed by those events). `select()`
  round-robins (least-recently-selected) while burn is unknown — so both subs are
  used from the first dispatch — and once a window's utilization is known, favors
  the account with the most **weekly** headroom, skipping any that 429-rejected
  until its reset passes (falling back to least-burned if all are near the cap). A
  light liveness tick (`ACCOUNT_TICK_MS`, default 60s) only clears expired
  rate-limits and republishes; it makes **no** network call. Snapshots stream to
  the GUI as `accounts` events → the topbar burn strip; each run records its
  account.
- Degrades to single-account (inherited login) when fewer than two tokens are
  configured. Burn bars read `—` until a run's `rate_limit_event` reports a
  window (typically as it approaches a warning/cap), then fill in live.
