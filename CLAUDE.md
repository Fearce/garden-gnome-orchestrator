# claude-orchestrator

## 🔑 BROWSER-TEST LOGIN — READ THIS FIRST (agents: stop rediscovering it)
The web app at `:4317`/`:4319` is password-gated. **The password is `REDACTED-PASSWORD`.** Don't go
spelunking through `server/.env` or the auth code — just use it. To authenticate a Playwright
(or curl) session, POST it to `/api/login` to mint the session cookie, then reuse that context:
```js
// Playwright: get the authed cookie, then navigate.
await page.request.post("http://127.0.0.1:4317/api/login", { data: { password: "REDACTED-PASSWORD" } });
await page.goto("http://127.0.0.1:4317/");   // now past the login gate
```
```bash
# curl: save the cookie jar, then hit authed routes with it.
curl -s -c /tmp/cj.txt -X POST http://127.0.0.1:4317/api/login -H 'content-type: application/json' -d '{"password":"REDACTED-PASSWORD"}'
curl -s -b /tmp/cj.txt http://127.0.0.1:4317/api/threads
```
(Google sign-in also works, but the password is simplest for headless agents. Local/LAN only.)

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

## Deploying a change — DO IT YOURSELF, don't defer
**If you changed server code, you deploy it before handing off — by restarting the orchestrator
yourself, in the same turn. Do NOT end a turn with "needs a restart to go live" or ask the owner
to restart. Bouncing is FINE: keepAlive + auto-resume bring every in-flight task (including you, if
you're a worker) back on the freshly-built code.** A worker restarting its own parent is the designed,
supported flow — the rebooted server auto-resumes you with a note saying the restart already
completed (so you won't loop). Un-deployed hand-offs are the recurring complaint; don't be the cause.

How to restart depends on how it's running:

**macOS / Linux (local dev — `npm run dev` or `npm run serve`):** no script-hub, no keepAlive.
- Web-only change: don't restart — `npm run build --prefix web` then reload the browser.
- Server change under `serve` (no watch): stop the process and re-run `npm run serve`.
- Under `npm run dev` (`tsx watch`): editing `server/src` already hot-restarts it — but that
  KILLS in-flight tasks, so use `serve` when real pipelines are running.

**Windows (script-hub production deployment):** runs as script-hub id **`claude-orchestrator`** with
keepAlive armed. Implementor workers are **child processes of this server** (the Agent SDK spawns the
`claude` CLI — `server/src/agents/runner.ts`), so:
- **Server change?** `npm run build`, then issue the **atomic** hub restart yourself — it runs
  server-side in the hub process (PID outside this server's tree), survives the caller being killed
  mid-restart, and re-arms keepAlive:
  ```
  POST http://127.0.0.1:3939/api/restart   body {"id":"claude-orchestrator"}
  ```
  Shorthand: `.\launchers\script-hub.ps1 restart claude-orchestrator` (from the script-hub root,
  `C:\Users\user\.runtime\workspace\script-hub`). This is NOT blocked by the MyProject deploy guard
  (it only matches worldserver commands, not `/api/restart`) — issue it directly, no string-splitting.
- **Never use stop+start** (`script-hub stop` / the launcher's `stop`): it disarms keepAlive AND
  tree-kills the whole process — including the worker issuing it — so the follow-up `start` never
  runs and nothing resurrects it. Use the atomic `/api/restart` above, which is exactly why it exists.
- **Web-only change?** Skip the restart — `web/dist` is static; `npm run build --prefix web` then
  reload the browser.
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
  another sub with headroom. If EVERY sub is capped (no failover headroom), the task parks in `review`
  with the marker `⏳ Auto-resume pending` in its `error` — a supervisor (`resumeCapParked`, every
  `CAP_RETRY_MS`/120s) then auto-resumes it the moment `AccountManager.hasHeadroom()` turns true (a
  window reset or a freed sub), so a cap wave doesn't strand the owner hand-resuming each task. A plain
  "needs your review" park carries no marker and is left for a human.

## The office (cross-agent chat)
Concurrent tasks on the same repo would otherwise edit the same files blind. Every running agent is
"in the office": each role gets an `office` MCP server (`bus/officeServer.ts` — `office_look`/`chat_post`/
`chat_read`) and chats in a general room plus, when 2+ tasks share a workspace, a per-repo project room
(`ensureGroup` announces members). Messages persist in `chat_messages` (room `general` | `repo:<normalized-ws>`);
`listProjectRooms` rolls up participants so only collaborating tasks show the top-bar **Office** gnomes
(walk solo, huddle when grouped) and the per-task **Chatroom** button. Codex implementors have no MCP, so
they coordinate through the runner's `OFFICE[team|office]: ...` text bridge. Grouping key =
`normalizeWorkspace` (mirrored in server + web types).

## Deliverables (agent-produced files)
A finding can be a **deliverable**: a file an agent surfaces for the owner to view/download from the
right panel. It's a `findings` row with `kind='deliverable'`, a `path` (absolute or workspace-relative)
and a human `label` (the `summary` mirrors the label; `detail` holds the optional description). Agents
emit one via the `post_deliverable` bus tool (`bus/busServer.ts`); the implementor prompt documents the
format. The console reads these from the thread's findings and renders file cards (`web/src/components/
Deliverables.tsx` + `FileIcon.tsx`) with View (typed inline preview — markdown/JSON/CSV/code/image/PDF),
Download, and Copy-path. Bytes are served by `GET /api/deliverable/:id` (`?download=1` for an attachment),
which is auth-gated and **confines the resolved real path inside the owning task's workspace** (symlinks
resolved, `..`/absolute/cross-drive escapes rejected, files-only, 25 MB cap) — keep that guard intact:
the path is agent-supplied and the server is LAN-reachable.

**Emitting one — avoid the "file not available" 404:** a *relative* `path` resolves as `join(thread.workspace,
path)`, and the task workspace is often the **parent** of this git repo (e.g. workspace
`…\claude-orchastrator` vs. repo `…\claude-orchastrator\claude-orchestrator`). A file you save into the repo
is then NOT found by a repo-relative path. **Pass an ABSOLUTE path** (the containment guard still confines it
to the workspace) — or save the file at the workspace root. Verify before handing off: the file must sit at
`join(workspace, path)` (or be absolute and inside the workspace).

## Conventions
- Conventional Commits (`feat:`/`fix:`/`refactor:`/`chore:`…), matching `git log`.
- One concern per commit — don't sweep unrelated working-tree changes into a fix.
