# GGO IDE and source control

Open **IDE** from the board areas. On a phone, **All areas** in the bottom navigation reaches IDE, Notes, Scheduled Tasks and Supervisor. The board header also has an **Area** selector when space is limited. Director, Tasks and Co-work retain direct mobile shortcuts.

## Editing a workspace

The workspace picker lists GGO's own checkout, recent registered repositories, task workspaces and co-work workspaces. It opens the selected task's workspace when available. The explorer's **Workspace tasks** section links back to task details. Choosing another workspace retains open tabs and drafts.

- Browse folders, open multiple files, or use **Search** / **Ctrl+P** to find a filename. Enable **Search file contents** to find text and open its matching line. Search is case-insensitive and reports when its limits are reached.
- **New file** takes a relative path. Its parent folder must exist. The file is created exclusively on first save; an existing file cannot be overwritten by creation.
- **Save** / **Ctrl+S** writes the active file. A dot on a tab marks unsaved changes. **Reload** explicitly replaces the draft with the disk version; closing a dirty tab asks before discarding it.
- **Compare disk** shows the current disk text beside the draft. If an agent or another editor changes a file, a stale save returns a conflict and keeps the draft. Compare the versions, copy any text you need, then reload and apply the intended edit.
- Drafts survive area navigation and page reloads in the same browser tab using session storage. They are not a replacement for saving. Closing the browser tab ends that recovery session. Storage failures are shown explicitly; no draft data is uploaded until Save.

Desktop editing uses the MIT-licensed Monaco editor, with syntax highlighting, undo/redo, find/replace, folding, multiple cursors, command palette and built-in language features. JavaScript/TypeScript, JSON, HTML and CSS use local browser workers for completion and diagnostics. Language analysis covers open models; this is not a project build, TypeScript configuration loader or project-wide language server. Use the editor context menu or **F1** for available commands, **Ctrl+F** for find/replace and **Ctrl+Space** for completion.

Touch screens use a native text editor with find and save. It supports mobile selection and software keyboards and does not download Monaco. Completion, language diagnostics and snippet expansion require the desktop editor. On phones the explorer and editor occupy the same space; opening a file shows the editor, and **Explorer** returns to the file list.

**Extensions & editor** stores font size, wrapping and minimap preferences per browser. GGO's Classic and Nocturne themes automatically style the editor. These preferences do not change agent settings.

## Fast navigation and freshness

The editor instance, open models and undo history, expanded explorer folders, search query/results and source-control selection stay in memory when switching tools or board areas. Closed editor models are released. Touch editing loads separately and avoids the desktop editor download.

File, folder, search, repository-mapping and diff requests share a session-memory cache, bounded to 128 entries and approximately 16 MB of serialized text. Concurrent requests share one read. Snapshots are reused for 30 seconds (repository mapping: 60 seconds); returning to a diff paints its cached snapshot while it refreshes. File contents are not written to persistent browser storage except unsaved recovery drafts. Repository state and commit history use the existing store caches; a background Git refresh retains the current view, and concurrent server refreshes share one Git scan.

Save and Git results invalidate dependent reads, including requests still in flight. **Refresh files**, source-control **Refresh**, **Reload** and **Compare disk** fetch current data. Saves always check the actual disk version, regardless of any cache. External editors can make an open snapshot stale: use Reload or Compare disk to inspect their changes. The server revalidates workspace registration and its real root on every file operation; cached workspace identity does not retain access after registration is removed.

## Extension support: real, deliberately bounded

GGO supports **declarative VS Code snippet contributions**, including import from a `.vsix` extension package. It does not contain a VS Code extension host.

Import either:

- A `.code-snippets` or snippet `.json` file. JSON comments and trailing commas are accepted. Prefixes, multiple prefixes, bodies, descriptions, scopes, tab stops and placeholders are carried into Monaco completion. A file without a scope applies to every language.
- A `.vsix` with `extension/package.json` and `contributes.snippets`. The manifest's language identifier scopes each contribution. The installed collection displays the extension identity, version, declared license and unsupported contributions. Extension JavaScript is never executed, even if the package includes `main`, `browser`, scripts or commands.

Each import replaces the current snippet collection; **Remove snippets** removes it. The collection persists in this browser. Imported snippets retain their publisher's license; GGO does not redistribute a marketplace catalog.

Limits: 5 MB per VSIX archive, at most 5,000 archive entries, 40 declared snippet files, 200 KB per extracted file, 1 MB of extracted snippet data and 200 snippets. Extraction occurs only in browser memory. Missing files, traversal paths, duplicate contribution entries, malformed manifests and oversized data fail visibly. A package with no snippet contributions is rejected.

Marketplace installation, extension activation, commands, language-server processes, TextMate grammars, extension themes, terminals and debuggers are not supported. Importing a package does not imply support for its other features. The UI lists unsupported contributions rather than presenting them as installed functionality.

The architectural decision follows [Monaco's compatibility explanation](https://github.com/microsoft/monaco-editor): Monaco is an editor component, not the VS Code workbench or extension host. [VS Code web extensions](https://code.visualstudio.com/api/extension-guides/web-extensions) still require a compatible extension host and APIs. GGO's existing Fastify/React application has neither. Embedding a separately privileged VS Code server would introduce another host, authentication and filesystem boundary. The implemented subset uses the documented [`contributes.snippets` format](https://code.visualstudio.com/api/references/contribution-points#contributes.snippets) without that execution surface.

## Source control

**Source control** uses the repository inside the selected workspace and the same Git command service as GGO's existing Git console. It retains configured credentials, commit hooks, commit-only remote policy and live-agent guards. Git commands use argument arrays, not user-supplied shell strings.

- **Changes** lists unstaged tracked and untracked files. **Staged changes** lists the real Git index. Use **+ / −**, **Stage all** or **Unstage all**. A file changed again after staging appears in both groups.
- Selecting a file shows the appropriate diff: working tree versus index, or index versus HEAD. **Open in editor** opens that exact repository file in the workspace.
- A commit includes the staged index, not later unstaged edits. Review the index, enter a summary and optional description, then confirm. The index is shared with agents and other Git clients. Failed commits keep the message and staged changes. Hooks remain enabled.
- The branch menu switches branches, creates branches, tracks remote branches and deletes merged branches with confirmation. Git refuses unsafe switches and unmerged branch deletion. Unsaved IDE drafts block branch and sync controls.
- **Fetch**, **Pull**, **Push/Publish**, upstream, push destination, ahead/behind counts and remote URLs remain in the same view. Pull fast-forwards by default; its menu also offers rebase. Push asks before sending commits. No force-push is offered; commit-only repositories cannot push.
- Conflicts are identified in the file list. Open the file, resolve markers, save and stage it. A merge/rebase in progress offers **Continue** and a confirmed **Abort**. Git refuses continuation with unresolved conflicts. Live-agent checks apply to both operations.
- **History** opens recent commits, metadata, changed files and diffs. Repository state refreshes after actions, on window focus and every 15 seconds while visible. **Refresh** is available at any time. Reload open editor files after a branch switch or pull.

The original top-bar Git console and task Changes drawers remain available. The task drawer stays read-only.

## File boundaries and verification

IDE file routes require GGO authentication and refuse cross-site requests. Clients supply a registered workspace ID plus a relative path; they cannot nominate arbitrary filesystem roots. Traversal, absolute paths, NTFS stream/device aliases, Git internals, symlinks/junctions and hard-linked files are rejected. Files must be UTF-8 text and at most 2 MB. Reads and searches are bounded. Search excludes generated dependency/build folders and reports skipped files and truncated results.

Saves use a SHA-256 content version, serialize competing IDE writes to the same file, preserve UTF-8 BOM and line endings, flush a sibling temporary file and atomically replace the destination. File creation is exclusive. They do not silently force an overwrite after a conflict. Save and Git act on the same files that agents use; ordinary source edits do not alter GGO task lifecycle state.

Verification commands:

```text
npm run test:ide --prefix server
npm run test:git --prefix server
npm run test:repo-ops --prefix server
npm run typecheck
npm run build --prefix web
npm run ide-lab --prefix server -- --shots data/ide-shots
npm run phone-lab --prefix server
```

The IDE lab compiles the server into an isolated `.ide-lab-dist`, boots a temporary database with nonfunctional account tokens, and uses a local bare Git remote. It exercises desktop and touch flows without interacting with production or overwriting the live server artifact. Screenshots are written to the requested evidence directory.
