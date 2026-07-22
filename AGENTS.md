# Codex-orchestrator

## 🔑 BROWSER-TEST LOGIN — READ THIS FIRST (agents: stop rediscovering it)
The web app at `:4317`/`:4319` is password-gated. **The password is the `AUTH_PASSWORD` line in
`server/.env`** — read that one line (`grep AUTH_PASSWORD server/.env`) instead of spelunking the
auth code. To authenticate a Playwright (or curl) session, POST it to `/api/login` to mint the
session cookie, then reuse that context:
```js
// Playwright: get the authed cookie, then navigate.
const pw = process.env.AUTH_PASSWORD; // or read it out of server/.env
await page.request.post("http://127.0.0.1:4317/api/login", { data: { password: pw } });
await page.goto("http://127.0.0.1:4317/");   // now past the login gate
```
```bash
# curl: save the cookie jar, then hit authed routes with it.
PW=$(grep -E '^AUTH_PASSWORD=' server/.env | cut -d= -f2-)
curl -s -c /tmp/cj.txt -X POST http://127.0.0.1:4317/api/login -H 'content-type: application/json' -d "{\"password\":\"$PW\"}"
curl -s -b /tmp/cj.txt http://127.0.0.1:4317/api/threads
```
(Google sign-in also works, but the password is simplest for headless agents. Local/LAN only.)

A director's console for running Codex agents: a Sonnet **director** enriches a
prompt, runs a planner + researcher, then dispatches Opus 4.8 **implementor** workers you
can inject into mid-work. Node/Fastify API (`server/`) + React/Vite console (`web/`), single origin.

**Read lane (`dispatch_read`).** A pure read-only lookup ("read HANDOFF.md and report it", "which
model does role X use", "explain how Z works") can skip the whole planner→implementor→QA pipeline:
the director dispatches it with `dispatch_read`, which runs ONE cheap **reader** (Sonnet) that answers
by posting a finding — read-only enforced at the harness level (Read/Grep/Glob + an allowlisted
`git_read`, no Write/Edit/Bash), no QA. The reader **escalates rather than half-answers**: anything
needing an edit/build/verification/broad investigation gets a "needs full pipeline" finding and parks
for a normal re-dispatch. Bias toward the full `dispatch` when unsure — misrouting to Opus is safe,
misrouting a real task to the reader is not. The card shows a **READ** badge. See ARCHITECTURE.md §5.

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

**Windows (script-hub production deployment):** runs as script-hub id **`Codex-orchestrator`** with
keepAlive armed. Implementor workers are **child processes of this server** (the Agent SDK spawns the
`Codex` CLI — `server/src/agents/runner.ts`), so:
- **Server change?** `npm run build`, then issue the **atomic** hub restart yourself — it runs
  server-side in the hub process (PID outside this server's tree), survives the caller being killed
  mid-restart, and re-arms keepAlive:
  ```
  POST http://127.0.0.1:3939/api/restart   body {"id":"Codex-orchestrator"}
  ```
  Shorthand: `.\launchers\script-hub.ps1 restart Codex-orchestrator` (from your process-manager
  root) — issue it directly.
- **Never use stop+start** (`script-hub stop` / the launcher's `stop`): it disarms keepAlive AND
  tree-kills the whole process — including the worker issuing it — so the follow-up `start` never
  runs and nothing resurrects it. Use the atomic `/api/restart` above, which is exactly why it exists.
- **Web-only change?** Skip the restart — `web/dist` is static; `npm run build --prefix web` then
  reload the browser.
- If a restart doesn't pick up server changes, a stale/orphaned process may still hold :4317 —
  check `Get-NetTCPConnection -LocalPort 4317` and kill the old PID, then restart.
- **`/api/restart` silently no-ops when the :4317/:4319 PID is elevated** — the hub can't kill it, so
  the response is `ok:false` with `stop.killed:[]` and start `skipped:"already-running"` (HTTP 200, no
  `errors` — looks fine, ships nothing). Self-elevate the kill (`Start-Process powershell -Verb RunAs
  -File <kill.ps1>` → `Stop-Process -Id <pid> -Force`), then let **keepAlive respawn** the fresh build —
  verify a NEW listener appears on :4317; don't manually `start` it (that races keepAlive into a
  double-bind). Deploy from a **detached** elevated script, not this process tree: you're a child of
  :4317, so killing it kills your shell before it can heal — the auto-resumed session verifies after.

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
  another sub with headroom. A cap on a **Fable** model is first classified (`classifyCap`: fresh Haiku
  usage ping — Fable's allowance is its OWN gated pool, separate from the 5h/weekly windows): normal
  windows still free ⇒ the run resumes on the SAME account with `config.fableFallbackModel` (default
  `Codex-opus-4-8`, env `FABLE_FALLBACK_MODEL`), the pool cap is latched per (sub, model) until its
  reset (5h self-expiry when unknown), `modelFor` resolves the fallback for every role meanwhile, and
  the account chip shows a "Fable → Opus" tag. If EVERY sub is capped, an implementor fails over to the CODEX backend
  when it's enabled+authed with headroom (fresh seed — a Codex session can't resume on the codex CLI;
  the reverse codex→Codex flip already existed). Only when no backend can continue does the task park
  in `review` with the marker `⏳ Auto-resume pending` in its `error` — a supervisor (`resumeCapParked`,
  every `CAP_RETRY_MS`/120s) auto-resumes it the moment a Codex sub OR Codex frees up; a QA-stage park
  (message carries "(QA runs on Codex)") waits for a Codex window specifically. A plain "needs your
  review" park carries no marker and is left for a human. Idle 5h windows restart STAGGERED: a shared
  `ResetStagger` (`accounts/resetStagger.ts`) places each restart at the midpoint of the largest gap
  between the OTHER participants' live 5h reset phases — Codex subs AND Codex — so resets spread out
  and re-converge dynamically (a sub some outside consumer keeps waking, e.g. a background service, is detected
  via `extWakeAt` and left unheld — its phase anchors the rest). Codex meters stay live via a free
  `codex app-server` `account/rateLimits/read` ping (`codexUsagePing.ts`), and an IDLE Codex 5h window
  is re-started at its slot by a cheap real wake turn (one-word prompt, `gpt-5.5` low effort — mini
  models 400 on ChatGPT-plan auth; `CODEX_WAKE=off` disables, `CODEX_WAKE_MODEL` overrides).

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

**Reliable emission (deterministic backstop).** Emitting a deliverable is a discretionary `post_deliverable`
call the implementor can forget, so a task could produce a real artifact and finish without surfacing it. Two
layers make it reliable: (1) the implementor prompt frames the deliverables pass as a MANDATORY, self-verified
completion step (not an optional aside); (2) QA — the gate that marks a task done — runs a required deliverables
check every round and fails (blocker → bounce) if a produced owner-facing artifact wasn't surfaced. QA's check is
seeded by a harness-computed hint: `orchestrator/deliverableCheck.ts` (`detectUnsurfacedArtifacts`) replays the
run's own recorded `Write` tool calls and deliverable findings to list artifact-type files (docs/data/media by
extension; source, config, meta-docs, and `_`-prefixed scratch excluded) the implementor wrote but never surfaced.
It's a HINT injected into `qaKickoff`, not an auto-emit — surfacing every changed file would spam the console with
ordinary source edits. Bash/script-generated artifacts don't show as `Write` calls, so QA also checks the real git
diff itself. Codex-backend implementors have no bus tools and so can't emit deliverables at all (a known gap).

**Emitting one — avoid the "file not available" 404:** a *relative* `path` resolves as `join(thread.workspace,
path)`, and the task workspace is often the **parent** of this git repo (e.g. workspace
`…\Codex-orchastrator` vs. repo `…\Codex-orchastrator\Codex-orchestrator`). A file you save into the repo
is then NOT found by a repo-relative path. **Pass an ABSOLUTE path** (the containment guard still confines it
to the workspace) — or save the file at the workspace root. Verify before handing off: the file must sit at
`join(workspace, path)` (or be absolute and inside the workspace).

## Conventions
- Conventional Commits (`feat:`/`fix:`/`refactor:`/`chore:`…), matching `git log`.
- One concern per commit — don't sweep unrelated working-tree changes into a fix.
