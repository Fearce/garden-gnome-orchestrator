# GG Orchestrator

*Garden Gnome Orchestrator* — a single director's console for running coding
agents the way you already work by hand: a Sonnet **director** enriches a raw
prompt, pulls in relevant memories, and asks the clarifying questions you'd
otherwise forget to answer, then dispatches the task to a self-assembling agent
pipeline — a **planner** reads the repo and plans, an optional **researcher**
gathers external context, an **implementor** does the work in the right repo, and
a **QA** agent reviews it. Fire many tasks at once, watch them as concurrent
lanes, feed a running agent new information mid-flight, and resume a task that
died partway.

The implementor runs on **Claude Opus 4.8** by default, or — when you enable the
subscription in Settings — on the **OpenAI Codex**, **xAI Grok**, or **Zhipu z.ai
(GLM)** backend instead, all authing off a flat-fee subscription with no per-token API billing
(see [Runtime model](#runtime-model--zero-metered-api-credits)).

> A local cockpit for directing coding agents — not a hosted service or a
> finance/background "agent" bot.

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
  issues, changelogs, plus your global memory. It does **not** read the codebase
  (that's the planner's job) — it enriches the build, then hands to the implementor.
- **Implementor.** Does the work in the repo, fully autonomous. It always hands
  off to QA — it can't declare itself done. Runs on **Claude Opus 4.8** by
  default, or on the **Codex** / **Grok** / **z.ai (GLM)** backend when you enable
  that subscription (the director, planner, researcher, and QA stay Claude —
  though a z.ai run can also take failover for those when every Claude sub is capped).
- **QA.** Reviews and tests against the brief; it's the **only** agent that can
  mark a task **done**, or bounce it back to the implementor with concrete fixes
  (looping until it passes or runs out of rounds).

**Read lane.** A pure read-only lookup ("read HANDOFF.md and report it", "which
model does role X use") skips the whole pipeline: the director dispatches it with
`dispatch_read`, which runs **one** cheap read-only Sonnet **reader** that answers
by posting a finding — no planner, no implementor, no QA. Anything needing an edit
or verification escalates back to the full pipeline instead of half-answering. The
card shows a **READ** badge.

The director's `dispatch` just hands over the brief — the chain assembles itself.
Each completed stage is **persisted**, so a task that dies mid-pipeline (crash,
restart, timeout) can be **resumed** from where it failed: finished stages are
reused and the implementor picks up its prior session. You can also inject new
context into a live task, or interrupt + resume it, at any point.

## In the console

Beyond the pipeline, the board gives you:

- **Deliverables** — agents surface any owner-facing file they produce (a report,
  CSV, diagram, exported data) as a card in the right panel you can preview inline,
  download, or copy the path of.
- **The office** — concurrent tasks on the same repo see each other and coordinate
  in a shared per-repo chat room, so two agents don't clobber the same files.
- **Scheduled tasks** — dispatch a brief on a recurring schedule (a nightly health
  sweep, a periodic check) instead of firing it by hand.
- **Diff review & injection** — review a task's `git diff` in a modal without
  leaving the console, and paste/drop **images** into any prompt for the agents to
  see via vision.
- **Anywhere access** — password or Google sign-in gates the LAN listener, with
  opt-in browser + webhook notifications when a task needs you or finishes.

## Runtime model — zero metered API credits

Every backend authenticates off a flat-fee subscription, never a metered API key
— no `ANTHROPIC_API_KEY`, no `OPENAI_API_KEY`, no per-token billing:

- **Claude** (the director, planner, researcher, QA, and the default implementor)
  runs through the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`), which
  drives the bundled Claude Code binary and **inherits your Claude Max
  subscription auth**. Local runs use your logged-in CLI credentials
  automatically; running as a background service uses a `CLAUDE_CODE_OAUTH_TOKEN`
  from `claude setup-token`.

  > From 2026-06-15, subscription Agent SDK usage draws from a separate monthly
  > "Agent SDK credit" pool (still your subscription, not API billing).

- **Codex** (optional implementor backend) runs the OpenAI Codex CLI, authed by a
  ChatGPT-plan `codex login` seeded into the isolated `server/data/codex-home/auth.json`
  (see the `codex` block in `server/src/config.ts`).
- **Grok** (optional implementor backend) runs the xAI Grok CLI, authed by a
  flat-fee SuperGrok `grok login` (OAuth, `~/.grok/auth.json`).
- **z.ai** (optional implementor backend) runs Zhipu's **GLM Coding Plan** through
  its **Anthropic-compatible endpoint** — so, unlike Codex/Grok, it reuses the
  Claude Agent SDK path (a base-URL + `ANTHROPIC_AUTH_TOKEN` swap) and keeps the
  in-app bus/office tools, deliverables, and resume. Authed by a z.ai API key
  (Settings → Subscriptions, or `ZAI_API_KEY`); its real 5-hour + weekly quota
  windows feed the usage chip and routing (see the `zai` block in `server/src/config.ts`).

Enable Codex, Grok, or z.ai per-machine from the **Subscriptions** panel in Settings;
until then every role runs on Claude. Because the CLI backends share one login
each, note that any *other* tool on your machine pointed at the same
`codex-home` / `~/.grok` shares it — logging out, rotating a token, or moving
`CODEX_HOME_DIR` affects those consumers too, so update their config in the same
change.

**Multi-subscription load balancing.** Configure two or more Claude
subscriptions (`ACCOUNT_<n>_TOKEN`) and each dispatch routes to burn the
"perishable" weekly allowance first — the sub whose weekly window resets soonest —
holding the long-runway one in reserve until it caps, then failing over
mid-task without losing work. Live 5h + weekly utilization for every sub shows in
the top-bar burn strip.

## Layout

```
server/   Fastify HTTP + WebSocket backend, the Agent SDK runtime, SQLite state
web/      React + Vite director console
docs/     ARCHITECTURE.md — the design contract
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design.

## Quick start

```bash
# one-time: mint a subscription token for headless/service use (optional locally)
claude setup-token   # paste the token into server/.env as CLAUDE_CODE_OAUTH_TOKEN

cd claude-orchestrator        # Windows: cd C:\claude-orchestrator
npm run install:all
npm run serve        # task pipelines: server (no watch) + web — start here
```

Cross-platform: runs on macOS, Linux, and Windows. Paths shown Unix-style;
`server/.env` (`DEFAULT_WORKSPACE`, `WORKSPACE_SEARCH_ROOTS`) defaults to your home dir
when unset, so no config is needed to start.

### Linux / first-run extra steps

On a fresh Linux setup (and any machine running **npm 12+**) two extra steps were
needed that macOS/Windows didn't hit:

1. **Install the repo-root dev dep.** `npm run install:all` only installs `server/`
   and `web/`, not the root — where `concurrently` (used by `npm run dev` / `serve`)
   lives. Without it you get `concurrently: not found`. Run a plain install at the root:

   ```bash
   npm install            # at the repo root — adds concurrently
   ```

2. **Compile the `better-sqlite3` native binary.** It's a native (C++) addon, and
   **npm 12 blocks packages' install/build scripts by default** (a new allowlist), so
   its `node-gyp rebuild` never runs and the server crashes at boot with
   *"Could not locate the bindings file … better_sqlite3.node"*. Approve its build
   script once, then rebuild:

   ```bash
   cd server
   npm install-scripts approve better-sqlite3   # allowlist its build step (npm 12+)
   npm rebuild better-sqlite3                    # compile against your Node version
   ```

   Verify: `ls node_modules/better-sqlite3/build/Release/better_sqlite3.node` should exist.

   Notes:
   - On **older npm** the build script isn't blocked, so `npm run install:all` compiles
     `better-sqlite3` automatically and neither step above is needed — this is why other
     OSes / setups "just worked".
   - `npm install-scripts ls` lists everything currently blocked. Other blocked scripts
     (`esbuild`, `tree-sitter-*`, …) are **not** required to boot the orchestrator — the
     web build (Vite/esbuild) works without them. Approve + rebuild any additional one the
     same way only if a feature later reports a missing binding.
   - Re-run both steps whenever you delete and reinstall `node_modules`.

### Configuration & personal rules — `server/.env`

All per-machine and personal settings live in **`server/.env`**, which is
**gitignored** — copy `server/.env.example` to `server/.env` and fill in what you
need. Nothing is required to run locally; every value has a sensible default. This
is where you put anything specific to *you* rather than shipping it in the code:

- **`OWNER_NAME`** — your name, woven into the agent prompts (defaults to "the user").
- **`NO_PUSH_REPO_PATTERN`** — a personal git rule: agents commit-only (never push)
  any repo whose origin URL contains this substring, while every other repo
  auto-pushes. Handy for keeping work/private repos from being pushed. Unset = push
  everything.
- **`HTTPS_PFX_PATH` / `HTTPS_PFX_PASSPHRASE`** — your own TLS cert for the optional
  HTTPS listener; **`PLAYWRIGHT_RUNTIME_DEPS_DIR`** — a custom Playwright location for
  agent browser-tests.
- Auth (`AUTH_PASSWORD`, Google `CLIENT_ID/SECRET`, `ALLOWED_EMAIL`), account tokens,
  `DEFAULT_WORKSPACE`, and more — all documented inline in `server/.env.example`.

Because `server/.env` is gitignored, your personal values never end up in the repo;
the committed code carries only generic defaults.

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
