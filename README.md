# Claude Orchestrator

A single director's console for running Claude Code agents the way the user already
works by hand: a Sonnet **director** enriches a raw prompt, pulls in relevant
memories, and asks the clarifying questions you'd otherwise forget to answer,
then dispatches the task to a self-assembling agent pipeline — a **planner**
reads the repo and plans, an optional **researcher** gathers external context, an
**Opus 4.8 implementor** does the work in the right repo, and a **QA** agent
reviews it. Fire many tasks at once, watch them as concurrent lanes, feed a
running agent new information mid-flight, and resume a task that died partway.

> Not to be confused with the agent "agent orchestrator". This is the
> *Claude* orchestrator — a local cockpit for directing coding agents.

## Why it exists

The manual workflow this automates:

1. Have Sonnet optimize / enrich a raw prompt.
2. Have it research the codebase a bit.
3. Pick an existing session or create a new one.
4. Start an Opus 4.8 agent.
5. **Stop it and feed it new information** when another agent reveals something
   that changes the picture.

Doing that by hand for one task is fine. Doing it for five concurrent tasks is
where a director's console earns its keep.

## How a task runs

A dispatched task is a **thread** that runs a self-assembling, **agent-routed**
pipeline — there's no fixed sequence; each agent decides what happens next:

- **Planner first, always.** It reads the codebase, produces the plan, and
  declares what comes next: a researcher (when the task needs information that
  *isn't* in the repo) or straight to the implementor.
- **Researcher — optional, external-only.** Web search, library/API docs, GitHub
  issues, changelogs, plus the user's memory. It does **not** read the codebase
  (that's the planner's job) — it enriches the build, then hands to the implementor.
- **Implementor (Opus 4.8).** Does the work in the repo, fully autonomous. It
  always hands off to QA — it can't declare itself done.
- **QA.** Reviews and tests against the brief; it's the **only** agent that can
  mark a task **done**, or bounce it back to the implementor with concrete fixes
  (looping until it passes or runs out of rounds).

The director's `dispatch` just hands over the brief — the chain assembles itself.
Each completed stage is **persisted**, so a task that dies mid-pipeline (crash,
restart, timeout) can be **resumed** from where it failed: finished stages are
reused and the implementor picks up its prior session. You can also inject new
context into a live task, or interrupt + resume it, at any point.

## Runtime model — zero metered API credits

Agents run through the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`),
which drives the bundled Claude Code binary and **inherits your Claude Max
subscription auth** — no `ANTHROPIC_API_KEY`, no per-token API billing. Local
runs use your logged-in CLI credentials automatically; running as a background
service uses a `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`.

> Note: from 2026-06-15, subscription Agent SDK usage draws from a separate
> monthly "Agent SDK credit" pool (still your subscription, not API billing).

## Layout

```
server/   Fastify HTTP + WebSocket backend, the Agent SDK runtime, SQLite state
web/      React + Vite director console
docs/     ARCHITECTURE.md — the design contract
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design.

## Quick start

```powershell
# one-time: mint a subscription token for headless/service use (optional locally)
claude setup-token   # paste the token into server\.env as CLAUDE_CODE_OAUTH_TOKEN

cd C:\claude-orchestrator
npm run install:all
npm run serve        # task pipelines: server (no watch) + web — start here
```

### Run modes — `serve` vs `dev`

The server runs under `tsx`. `npm run dev` adds `tsx watch`, which hot-restarts the
process whenever an **imported `server/src` module** changes. The orchestrator is
routinely pointed at **its own repo**, so an implementor agent editing `server/src`
restarts the watched server mid-run — that SIGTERMs every in-flight Claude Code child,
and on reboot each running thread is stamped *"interrupted by a server restart"*. (Only
imported modules trigger it; `server/data/*.sqlite*` and other non-imported files do
not.)

- **`npm run serve`** — server in **no-watch** mode + web. Use this for **real task
  pipelines**: editing `server/src` no longer restarts the running console. This is the
  default for actually running agents.
- **`npm run dev`** — server under `tsx watch` + web. Use this **only while actively
  developing the server itself**; it auto-reloads on `server/src` edits and will end any
  in-flight tasks. The startup banner prints a ⚠ reminder when you're in this mode.

To pick up a server-code change while in `serve`, stop and re-run `npm run serve` (or
`npm run build && npm start` for the built `dist`).
