# GG Orchestrator

Node/Fastify API in `server/`, React/Vite console in `web/`, one origin. The implementation and current tests are the source of truth. Detailed operational and feature history lives in [docs/agent-reference/CLAUDE-full.md](docs/agent-reference/CLAUDE-full.md); read only the sections relevant to your task. For architecture, use [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Before reconsidering an adopted or rejected design, read [docs/DECISIONS.md](docs/DECISIONS.md).

## Work and verify
- Respect the owner's brief, current steering, and existing work in the shared tree. Implement completely; avoid placeholders and unrelated refactors.
- `npm run typecheck` checks types. `npm run test:gates` runs the free gate suite and records `server/data/gates-last.log`. Run focused gates for changed behavior. Browser-test a changed UI in Playwright.
- `npm run dev` runs hot reload. The app serves HTTP on `127.0.0.1:4317` and HTTPS on `127.0.0.1:4319`. For headless browser tests, read `AUTH_PASSWORD` from `server/.env`, POST `{password}` to `/api/login`, then reuse the session cookie. Do not print the password.
- A server change must be deployed before handoff: `npm run deploy --prefix server`. A reported waiting restart is a completed deploy handoff. Do not use a direct script-hub restart while agents are active. For a web-only change, run `npm run build --prefix web`; no server restart. Read the archived deployment section for recovery cases.
- A task run's state and diagnostic trail can be read with `npm run probe:task-runs --prefix server -- <thread-id|title>`. More specific probes and gates are indexed in the archived debugging section.

## Shared worktree
- Other agents may edit this checkout at the same time. Coordinate in the office when another task shares the repo. Recheck `git status`, `git diff`, and `git diff --cached` before committing.
- Use Conventional Commits. Never use `git add -A`, `git add .`, a bare `git commit`, `--no-verify`, or force-push main/master. For separate files use `python C:/Users/theke/.claude/scripts/safe_commit.py -m "type: summary" -- path/to/file`. For overlapping files use `stage_my_hunks.py` as described in the archived shared-worktree section.
- Surface generated owner-facing files as deliverables using an absolute path inside the task workspace. Ordinary source/config edits are not deliverables. See the archived deliverables section for containment and verification details.

## Topic rules
`.claude/rules/*.md` load only when you touch the files they cover. Some tasks are defined by the brief rather than by a file. For these, read the rule first:
- Health or quality sweep, or resume after a restart: `.claude/rules/nightly-quality-sweep.md`.
- "Check on earlier work" or a watchdog: `.claude/rules/watchdog-triage.md`.
- Merging an incoming PR: `.claude/rules/merge-an-incoming-pr.md`.
- Pipeline or ThreadManager behavior: `.claude/rules/threadmanager-itest.md` and `.claude/rules/e2e-a-pipeline-lane.md`.
- Any other area: `ls .claude/rules`; each file name describes its topic.
