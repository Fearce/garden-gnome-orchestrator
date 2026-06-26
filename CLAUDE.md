# claude-orchestrator

A director's console for running Claude Code agents: a Sonnet **director** enriches a
prompt, runs a planner + researcher, then dispatches Opus 4.8 **implementor** workers you
can inject into mid-work. Node/Fastify API (`server/`) + React/Vite console (`web/`), single origin.

## Run / build
- Dev (hot reload): `npm run dev` at repo root — tsx-watch server + Vite web.
- Prod: `npm run build` (web then server) → `npm start` runs `node dist/index.js` from
  `server/`, serving the built `web/dist` + WS/REST API.
- Typecheck: `npm run typecheck`. Data: `server/data/orchestrator.sqlite`. Crash stacks:
  `server/data/crash.log` (written by the process guards in `server/src/crashLog.ts`).
- Serves `http://127.0.0.1:4317` and `https://127.0.0.1:4319` (same routes; the TLS port
  exists so the HTTPS Dashboard Deck can iframe it without mixed-content blocking).
  LAN access is auth-gated via `server/.env` (`AUTH_PASSWORD` / Google). Local/LAN only.

## Restarting the orchestrator — READ THIS FIRST
The app is cross-platform (macOS/Linux/Windows). How you restart depends on how it's running:

**macOS / Linux (local dev — `npm run dev` or `npm run serve`):** no script-hub, no keepAlive.
There's nothing to auto-resurrect it, so just stop the process and re-run:
- Web-only change: don't restart — `npm run build --prefix web` then reload the browser.
- Server change under `serve` (no watch): stop the process and re-run `npm run serve`.
- Under `npm run dev` (`tsx watch`): editing `server/src` already hot-restarts it — but that
  KILLS in-flight tasks, so use `serve` when real pipelines are running.

**Windows (script-hub production deployment):** the rest of this section applies only there.
It runs as script-hub id **`claude-orchestrator`** with keepAlive armed (the hub auto-restarts
it if it dies). Implementor workers are **child processes of this server** — the Agent SDK
spawns the `claude` CLI as a child (`server/src/agents/runner.ts`). So a worker **cannot**
restart its own parent with stop-then-start:

- `script-hub stop claude-orchestrator` (and the launcher's `stop`) **disarms keepAlive AND
  kills the whole process tree — including the worker that issued the command** — so the
  follow-up `start` never runs and nothing resurrects it. This is the recurring "orchestrator
  went down right after a worker restarted it" loop. Never use stop+start to restart it.

**Correct restart** — atomic, server-side in the hub process (PID outside this server's tree),
survives the caller being killed mid-restart, and re-arms keepAlive:
```
POST http://127.0.0.1:3939/api/restart   body {"id":"claude-orchestrator"}
```
Shorthand: `.\launchers\script-hub.ps1 restart claude-orchestrator` (from the script-hub root,
`C:\Users\user\.runtime\workspace\script-hub`). The hub kills → confirms the PID actually
exited → respawns → re-arms keepAlive itself, so the restart completes even after the worker dies.

- **Web-only change?** Don't restart the server — `web/dist` is static; `npm run build --prefix web`
  then reload the browser.
- **Server change?** `npm run build` then the atomic restart above.
- If a restart doesn't pick up server changes, a stale/orphaned process may still hold :4317 —
  check `Get-NetTCPConnection -LocalPort 4317` and kill the old PID, then restart (see global
  memory `claude_orchestrator_stale_elevated_process_shadows_server_changes`).

## Debugging a failed task
State + run history live in `server/data/orchestrator.sqlite` (open read-only with the bundled
`better-sqlite3`; columns are snake_case — `agent_runs.thread_id/started_at/ended_at/session_id`).
Read the run trail to tell causes apart:
- run `state='interrupted'` → a **server restart** killed it (`markInterrupted`), not the agent. A
  thread whose `error` starts with "interrupted by a server restart" died to a bounce; actively-running
  phases now **auto-resume on boot** (crash-loop guarded — repeated <60s deaths stop it).
- run `state='error'` → a real failure or a **usage cap**. A 5h/weekly cap auto-switches account and
  resumes the SDK session; `runner.ts` flags the cap from a `rate_limit_event`, an assistant
  `error:"rate_limit"`, OR an error result (429 / rate-limit text), and `AccountManager` failover picks
  another sub with headroom. If only one sub has headroom and it's also capped, the task settles to review.

## Conventions
- Conventional Commits (`feat:`/`fix:`/`refactor:`/`chore:`…), matching `git log`.
- One concern per commit — don't sweep unrelated working-tree changes into a fix.
