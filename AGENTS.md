# GG Orchestrator: Codex instructions

The Node/Fastify server is in `server/`; the React/Vite console is in `web/`. Follow the owner's current brief and steering. Complete the requested work, verify it, commit it, and push when the task requires it. Avoid placeholders and unrelated refactors. Detailed historical guidance is archived at [docs/agent-reference/AGENTS-full.md](docs/agent-reference/AGENTS-full.md); read the relevant section when troubleshooting. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains the pipeline. Check [docs/DECISIONS.md](docs/DECISIONS.md) before reopening a settled design decision.

## Shared memory
If the operator keeps a cross-project memory bank, it is at `~/.claude/memory/`. Hook-injected matches are pointers: open the named Markdown file before relying on one and verify time-sensitive facts. If a relevant match is missing, use `python ~/.claude/memory/scripts/rag.py retrieve --query "<topic>" --top-k 10 --min-score 0.3 --json`. For an explicit remember/forget request, follow `~/.claude/commands/remember.md` or `forget.md`.

## Run and verify
- `npm run typecheck` checks types. `npm run test:gates` runs free gates and writes `server/data/gates-last.log`. Run focused gates for changed behavior. Browser-test changed UI in Playwright.
- The repo is public: neutral examples only (`alex`/`sam`, `example.com`, `192.0.2.x`), never a real path, address, id, name or project from this machine. `npm run privacy:check --prefix server` (gate `test:privacy-guard`) checks the tree; private words go in the gitignored `server/.privacy-terms`.
- `npm run dev` starts hot reload. HTTP is `127.0.0.1:4317`; HTTPS is `127.0.0.1:4319`. For a headless browser, read `AUTH_PASSWORD` from `server/.env`, POST `{password}` to `/api/login`, and reuse the cookie. Do not print the password.
- Deploy server changes in the same turn with `npm run deploy --prefix server`. It restarts GGO immediately, even with agents running; they auto-resume on the new build. Confirm with `npm run deploy --prefix server -- --verify`. For web-only edits, run `npm run build --prefix web` and reload. Read the archived deployment section for recovery cases.
- For a failed task, run `npm run probe:task-runs --prefix server -- <thread-id|title>`; the archived debugging section lists narrower probes.

## Shared checkout and outputs
- Coordinate through the office when another task shares this repo. Before committing, inspect `git status`, `git diff`, and `git diff --cached`. Never use `git add -A`, `git add .`, a bare `git commit`, `--no-verify`, or force-push main/master.
- Use Conventional Commits. For separate files, use the safe-commit helper (`safe_commit.py -m "type: summary" -- path/to/file`); if another agent changed the same file, use `stage_my_hunks.py` as described in the archived shared-worktree section. Their location differs per machine, so find them with `python ~/.claude/scripts/findtool.py safe commit` (or `stage hunks`) instead of guessing a path.
- Surface generated owner-facing files as deliverables with absolute paths inside the task workspace. Ordinary source/config files are not deliverables. See the archived deliverables section.
