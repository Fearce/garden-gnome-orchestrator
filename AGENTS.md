# GG Orchestrator: Codex instructions

The Node/Fastify server is in `server/`; the React/Vite console is in `web/`. Follow the owner's current brief and steering. Complete the requested work, verify it, commit it, and push when the task requires it. Avoid placeholders and unrelated refactors. Detailed historical guidance is archived at [docs/agent-reference/AGENTS-full.md](docs/agent-reference/AGENTS-full.md); read the relevant section when troubleshooting. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains the pipeline. Check [docs/DECISIONS.md](docs/DECISIONS.md) before reopening a settled design decision.

## Shared memory
The durable cross-project memory bank is `C:/Users/theke/.claude/memory/`. Hook-injected matches are pointers: open the named Markdown file before relying on one and verify time-sensitive facts. If a relevant match is missing, use `python C:/Users/theke/.claude/memory/scripts/rag.py retrieve --query "<topic>" --top-k 10 --min-score 0.3 --json`. For an explicit remember/forget request, follow `C:/Users/theke/.claude/commands/remember.md` or `forget.md`.

## Run and verify
- `npm run typecheck` checks types. `npm run test:gates` runs free gates and writes `server/data/gates-last.log`. Run focused gates for changed behavior. Browser-test changed UI in Playwright.
- `npm run dev` starts hot reload. HTTP is `127.0.0.1:4317`; HTTPS is `127.0.0.1:4319`. For a headless browser, read `AUTH_PASSWORD` from `server/.env`, POST `{password}` to `/api/login`, and reuse the cookie. Do not print the password.
- Deploy server changes in the same turn with `npm run deploy --prefix server`. A waiting restart is a successful staged deploy. Do not directly restart script-hub while agents are active. For web-only edits, run `npm run build --prefix web` and reload. Read the archived deployment section for recovery cases.
- For a failed task, run `npm run probe:task-runs --prefix server -- <thread-id|title>`; the archived debugging section lists narrower probes.

## Shared checkout and outputs
- Coordinate through the office when another task shares this repo. Before committing, inspect `git status`, `git diff`, and `git diff --cached`. Never use `git add -A`, `git add .`, a bare `git commit`, `--no-verify`, or force-push main/master.
- Use Conventional Commits. For separate files, use `python C:/Users/theke/.claude/scripts/safe_commit.py -m "type: summary" -- path/to/file`. If another agent changed the same file, use `stage_my_hunks.py` as described in the archived shared-worktree section.
- Surface generated owner-facing files as deliverables with absolute paths inside the task workspace. Ordinary source/config files are not deliverables. See the archived deliverables section.
