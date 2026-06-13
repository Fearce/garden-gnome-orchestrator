# Claude Orchestrator

A single director's console for running Claude Code agents the way the user already
works by hand: a Sonnet **director** enriches a raw prompt, pulls in relevant
memories, asks the clarifying questions you'd otherwise forget to answer, runs a
**planner** and **researcher** to gather context, then dispatches an **Opus 4.8
implementor** into the right repo — with the ability to fire many prompts at
once, watch them as concurrent lanes, and feed a running agent new information
the moment another agent discovers it.

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
npm run dev          # starts server (:4317) + web (:4318)
```
