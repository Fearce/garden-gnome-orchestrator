---
paths:
  - server/src/orchestrator/codeContext.ts
  - web/src/components/CodeContextBar.tsx
  - web/src/lib/codeNav.ts
  - web/src/components/codeContext.css
---

# Task / Co-work / Supervisor → IDE and Git (the traps, not the tour)

CLAUDE.md § "Contextual code navigation" has the shape. This is what bites, plus the provenance the system genuinely does NOT have. Siblings: `git-changes-surface.md` (the per-task drawer this routes out of), `verify-a-ui-change-shipped.md` (labs), `add-a-broadcast-collection.md` (the wire pattern).

## The one thing to keep true
**A route is rendered only when it can be taken.** `canOpenIde`/`canOpenGit`/`ideFileTarget` all return null rather than a best guess, and the caller renders nothing. A button that opens the wrong file is worse than no button, because the operator believes it. The unavailable cases explain themselves in place of the routes (`RepoReading` prints `context.error` verbatim) — "no context" and "still loading" must stay distinguishable, so the row never silently blanks.

## Traps
- **`repoPrefix` has THREE meanings and all three matter.** `""` = the workspace IS the checkout;
  `"service"` = the repo is nested under the workspace (the common GGO shape, so a repo-relative file
  needs the prefix prepended); **`null` = the checkout sits ABOVE the workspace**, where a repo-relative
  file has no in-workspace path at all. Collapsing null into `""` silently produces links to the wrong
  file. `repoPrefixOf` and `joinWorkspacePath` are both gated on this.
- **A `workspace` subject is a path FROM THE BROWSER.** It resolves only through
  `IdeService.isRegistered` — the same registry the IDE enforces. Drop that check and `code.context`
  becomes a "stat any directory and read its git remote state" oracle for anyone who reaches the
  console, which is LAN-reachable. Thread/cowork subjects are ids, so they carry no such risk.
- **Read `getRepoHeadState`, never `getGitStatus`.** A task panel, a Co-work header and a screenful of
  Supervisor rows each ask; the full status walks the working tree and numstats every changed file.
  The head read is refs-only, cached per repo root, and busted by `bustGitCaches()` with the others.
- **The browser derives no deep link.** The IDE is addressed by its own `ideWorkspaceId` (hashed
  realpath), which is why `workspaceIdFor` lives beside `workspaces()` in `IdeService` — two
  derivations of that id WILL drift, and the symptom is a route the IDE refuses.
- **A commit route needs both halves.** The Git console opens on History only because `RepoBody` reads
  `gitConsoleCommit` at mount; `HistoryPane` then matches by PREFIX (the two surfaces abbreviate hashes
  independently) and says so when the commit is outside the window it shows. Setting one without the
  other lands on Changes with the request silently spent. Revert-checked — the lab goes red.
- **A tsx SSR gate cannot load a component stylesheet.** `CodeContextBar` reaching `codeContext.css`
  broke `test:cowork-ui` with `ERR_UNKNOWN_FILE_EXTENSION`, nothing to do with what that gate asserts.
  Fix is `web/scripts/ssrCssStub.mjs`, imported before the dynamic component import — not relocating
  the sheet.
- **The cache-busting gate must HOLD THE CLOCK** (`CodeContextService`'s injectable `now`). Its git
  calls outlast the 4s TTL on a loaded box, so against a real clock the assertion passes with the
  generation check deleted — it stayed green under the revert-check until the clock was frozen.

## What the system does NOT know (say so; never fake it)
- **No line-level provenance.** Nothing records which LINE an agent touched: `Write`/`Edit` tool calls
  carry a path, a git diff carries hunks, neither is a claim about where the interesting code is. So
  `ideFileTarget` takes an optional `line` and no current caller passes one. Deriving a line from a
  diff hunk would be a guess wearing a precise-looking badge — leave it absent.
- **File provenance is only as good as the task's diff anchor.** The Changes drawer attributes files
  through the dispatch baseline (`hasDiffAnchor`); without one it can show the task's files but not
  isolate its commits, and the commit route correctly disappears rather than opening the repo's log.
- **A resolved context is a snapshot.** `CODE_CONTEXT_MAX_AGE_MS` (30s client) over a 4s server cache:
  an agent that switches branch mid-task is reflected on the next ask, not instantly. A git action in
  the console re-asks every on-screen subject (`refreshCodeContexts`).

## Verify
`npm run test:code-context --prefix server` (resolver against real repos + the browser-side path math, free) and `npm run code-nav-lab --prefix server` — it compiles its OWN isolated `.code-nav-lab-dist`, so it drives the working tree rather than whatever is deployed. Then `npm run typecheck`. A change to the `CodeContext` shape also needs the `web/src/types.ts` mirror updated, or `test:mirror-drift` fails.
