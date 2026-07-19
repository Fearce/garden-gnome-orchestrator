import { useEffect, useState } from "react";
import { useStore } from "../store.js";
import type { GitFile, GitFileStatus, GitStatus, GitSummary, Thread } from "../types.js";
import { ago, threadRunning } from "../lib/format.js";
import "./gitChanges.css";

/**
 * Git / Changes — the productionized, real-git per-task surface. Progressive disclosure by design: the
 * card face carries only the tiny <ChangesChip> (file count, ±lines, a subtle status dot); the heavy
 * detail (branch + push status, commit history, expandable per-file diffs) lives in the right-side
 * drawer the chip opens. The drawer is a pure read-only viewer — no branch switching, no actions. All
 * data is REAL git, fetched over the WS git commands and scoped to the task's resolved repo — this is the
 * in-console replacement for GitHub Desktop, not a mock.
 *
 * Design lifted from the QA-approved demo (commit a1c5753); the data behind it is now live git.
 */

// ---- the card chip ---------------------------------------------------------------------------------

/** The collapsed summary affordance — the card's entire git footprint. Renders only once the repo's
 *  compact summary has loaded and confirms it IS a repo (so a non-git workspace shows no chip). Clicking
 *  opens the drawer; the click is isolated so it never selects the card or arms a drag. */
export function ChangesChip({ threadId }: { threadId: string }) {
  const thread = useStore((s) => s.threads[threadId]);
  const summary = useStore((s) => s.gitSummaries[threadId]);
  const loadGitSummary = useStore((s) => s.loadGitSummary);
  const loadGitStatus = useStore((s) => s.loadGitStatus);
  const [open, setOpen] = useState(false);

  // Fetch the compact header once per card mount. The server caches per-repo for a few seconds, so the
  // many tasks that share one workspace collapse to a single git run rather than one per card.
  useEffect(() => {
    loadGitSummary(threadId);
  }, [threadId, loadGitSummary]);

  // Prefetch the full drawer payload as soon as the summary confirms this is a repo, so opening the drawer
  // is instant instead of showing "Loading git status…" on click. Keyed on the summary's change signature
  // so the preloaded status re-syncs whenever the chip's own counts move (mount, and after a drawer close
  // refreshes the summary) rather than going stale. The server's status cache (same 4s TTL as the summary)
  // makes this cheap: the prefetch and the drawer's own fetch collapse to one git run.
  const summarySig = summary?.isRepo
    ? `${summary.fileCount}:${summary.added}:${summary.removed}:${summary.commitCount}:${summary.unpushed}`
    : null;
  useEffect(() => {
    if (summarySig !== null) loadGitStatus(threadId);
  }, [threadId, summarySig, loadGitStatus]);

  if (!thread || !summary || !summary.isRepo) return null;

  const running = threadRunning(thread.state);
  const marker = chipMarker(summary, running);

  return (
    <>
      <button
        className="changes-chip"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        title="Open the Git / Changes view — diffs, commits, branch & push status"
        aria-label={`Changes: ${summary.fileCount} files, ${summary.added} added, ${summary.removed} removed. Open Git view.`}
      >
        <ForkIcon size={13} />
        {summary.fileCount > 0 ? (
          <>
            <span className="cc-files">
              {summary.fileCount} file{summary.fileCount === 1 ? "" : "s"}
            </span>
            <span className="cc-stat">
              <span className="cc-add">+{summary.added}</span>
              <span className="cc-del">−{summary.removed}</span>
            </span>
          </>
        ) : (
          <span className="cc-clean">Changes</span>
        )}
        {marker === "unpushed" ? <span className="cc-dot unpushed" title="Committed, not pushed" /> : null}
        {marker === "commit-only" ? <span className="cc-tag">commit-only</span> : null}
        {marker === "working" ? <span className="cc-dot working" title="Agent is working — uncommitted changes" /> : null}
        <ChevronIcon />
      </button>
      {open ? <GitPanel thread={thread} onClose={() => { setOpen(false); loadGitSummary(threadId); }} /> : null}
    </>
  );
}

type ChipMarker = "unpushed" | "commit-only" | "working" | "clean";

/** The single status marker the chip shows: a live pulse while the agent works with uncommitted edits, a
 *  neutral commit-only tag for a Vota repo, an amber not-pushed dot for a normal repo with local commits,
 *  or nothing at all when clean and in sync. */
function chipMarker(summary: GitSummary, running: boolean): ChipMarker {
  if (running && summary.fileCount > 0) return "working";
  if (summary.isVota) return "commit-only";
  if (summary.unpushed > 0) return "unpushed";
  return "clean";
}

// ---- the drawer ------------------------------------------------------------------------------------

/** The Git / Changes drawer: everything the card deliberately withholds. A viewport-fit two-pane sheet
 *  (GitHub-Desktop style) — fixed chrome (branch + push header, a Changes|History switch) over a split
 *  body: a bounded, internally-scrolling file/commit list on the left and the selected file's diff on the
 *  right. The page never grows; only the two panes scroll, each within its own bounds. */
function GitPanel({ thread, onClose }: { thread: Thread; onClose: () => void }) {
  const status = useStore((s) => s.gitStatus[thread.id]);
  const loadGitStatus = useStore((s) => s.loadGitStatus);
  const [tab, setTab] = useState<"changes" | "history">("changes");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  useEffect(() => {
    loadGitStatus(thread.id);
  }, [thread.id, loadGitStatus]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Keep the selection valid across loads: default to the first changed file when status lands, and
  // re-anchor if the file set changes underneath us (e.g. a reload after the agent commits).
  useEffect(() => {
    const files = status?.files;
    if (!files) return;
    setSelectedPath((cur) => (cur && files.some((f) => f.path === cur) ? cur : files[0]?.path ?? null));
  }, [status?.files]);

  const { parent, leaf } = splitWorkspace(status?.repoRoot || thread.workspace);
  const selectedFile = status?.files.find((f) => f.path === selectedPath) ?? null;

  return (
    <div className="git-scrim" onClick={onClose}>
      <aside className="git-panel" role="dialog" aria-label={`Git changes — ${thread.title}`} onClick={(e) => e.stopPropagation()}>
        <div className="git-head">
          <div className="git-head-title">
            <span className="git-head-ico">
              <ForkIcon size={16} />
            </span>
            <div className="git-head-text">
              <h3>{thread.title}</h3>
              <div className="git-head-sub" title={status?.repoRoot || thread.workspace}>
                {parent ? <span className="git-head-parent">{parent}</span> : null}
                <span className="git-head-leaf">{leaf}</span>
              </div>
            </div>
          </div>
          <button className="git-close" aria-label="Close Git view" onClick={onClose}>
            ✕
          </button>
        </div>

        {!status ? (
          <div className="git-loading">Loading git status…</div>
        ) : !status.isRepo ? (
          <div className="git-empty">{status.error ?? "This task's workspace isn't a git repository."}</div>
        ) : (
          <>
            <BranchBar status={status} />
            <div className={"git-two-pane" + (selectedFile ? " has-selection" : "")}>
              <div className="git-left">
                <div className="git-tabs" role="tablist" aria-label="Changes and history">
                  <button
                    role="tab"
                    aria-selected={tab === "changes"}
                    className={"git-tab" + (tab === "changes" ? " on" : "")}
                    onClick={() => setTab("changes")}
                  >
                    <FileDiffIcon /> Changes <span className="git-tab-count">{status.files.length}</span>
                  </button>
                  <button
                    role="tab"
                    aria-selected={tab === "history"}
                    className={"git-tab" + (tab === "history" ? " on" : "")}
                    onClick={() => setTab("history")}
                  >
                    <CommitIcon /> History <span className="git-tab-count">{status.commits.length}</span>
                  </button>
                </div>
                <div className="git-left-scroll viewport-fit-scroll">
                  {tab === "changes" ? (
                    <FileListPane status={status} selectedPath={selectedPath} onSelect={setSelectedPath} />
                  ) : (
                    <CommitLog status={status} />
                  )}
                </div>
              </div>
              <div className="git-right">
                {selectedFile ? (
                  <DiffPane threadId={thread.id} file={selectedFile} onBack={() => setSelectedPath(null)} />
                ) : (
                  <div className="git-diff-empty">
                    {status.files.length === 0 ? "This task hasn't changed any files yet." : "Select a file to view its diff."}
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </aside>
    </div>
  );
}

/** The branch + push header — a read-only status strip: the current branch's push state (in sync /
 *  unpushed / commit-only / no-remote) and a one-line explanation of it. No actions live here — the branch
 *  switcher was removed so the whole Changes drawer is a pure read-only diff surface. Vota repos are
 *  commit-only: their "not pushed" is the intended steady state, shown neutrally with no push nag. */
function BranchBar({ status }: { status: GitStatus }) {
  const sync = status.pushState;

  return (
    <div className="branch-bar">
      <div className="branch-row">
        <PushStatus sync={sync} unpushed={status.unpushed} behind={status.behind} />
      </div>

      <div className="branch-actions">
        <SyncNote status={status} sync={sync} />
      </div>
    </div>
  );
}

type SyncState = "pushed" | "unpushed" | "commit-only" | "no-remote";

/** The push-state pill — the at-a-glance answer to "did this reach the remote?". Neutral for the
 *  commit-only (Vota) case: a status, not a warning. A behind count rides alongside when upstream moved. */
function PushStatus({ sync, unpushed, behind }: { sync: SyncState; unpushed: number; behind: number }) {
  const behindNote = behind > 0 ? <span className="branch-behind" title="Commits the upstream has that this branch doesn't">↓{behind} behind</span> : null;
  if (sync === "pushed")
    return (
      <span style={{ display: "inline-flex", alignItems: "center" }}>
        <span className="push-pill pushed" title="Up to date with the push remote">
          <CheckIcon /> Up to date
        </span>
        {behindNote}
      </span>
    );
  if (sync === "unpushed")
    return (
      <span style={{ display: "inline-flex", alignItems: "center" }}>
        <span className="push-pill unpushed" title="Committed locally, not yet pushed">
          <UpArrowIcon /> {unpushed} to push
        </span>
        {behindNote}
      </span>
    );
  if (sync === "commit-only")
    return (
      <span className="push-pill commit-only" title="Vota repo — commit-only by policy, never pushed">
        <ShieldIcon /> commit-only
      </span>
    );
  return (
    <span className="push-pill no-remote" title="No push remote is configured for this branch">
      <ShieldIcon /> no remote
    </span>
  );
}

/** The one-line explanation under the branch row, keyed off the sync state — where the commit-only policy
 *  is spelled out neutrally, and a running task's uncommitted note lands. */
function SyncNote({ status, sync }: { status: GitStatus; sync: SyncState }) {
  const remote = status.pushRef ?? (status.branch ? `origin/${status.branch}` : "the remote");
  if (sync === "commit-only")
    return (
      <span className="sync-note">
        This is a <b>Vota</b> repo — commit-only by policy. Changes are committed but <b>never pushed</b>; this is the intended
        steady state, not a pending action.
      </span>
    );
  if (sync === "unpushed")
    return (
      <span className="sync-note">
        {status.unpushed} commit{status.unpushed === 1 ? "" : "s"} committed locally, not yet on <code>{remote}</code>.
      </span>
    );
  if (sync === "no-remote") return <span className="sync-note">No push remote is configured — commits stay local.</span>;
  return (
    <span className="sync-note">
      All commits are on <code>{remote}</code>.
    </span>
  );
}

/** The commit log — THIS task's own commits (baseline..HEAD touching its files), short hash, subject,
 *  author, when. A local (not-yet-pushed) commit carries a quiet "local" tag. When the task has no diff
 *  anchor (a legacy row dispatched before change-tracking), its commits can't be isolated from the repo's
 *  history, so we say so explicitly rather than dumping the full repo log. */
function CommitLog({ status }: { status: GitStatus }) {
  return (
    <section className="git-section">
      <div className="git-section-head">
        <CommitIcon />
        <h4>Commits</h4>
        <span className="git-section-count">{status.commits.length}</span>
      </div>
      {!status.hasDiffAnchor ? (
        <div className="commit-empty">
          No diff anchor recorded for this task — its start point wasn't captured, so its own commits can't be
          isolated from the repo's history. (Tasks dispatched before change-tracking was added have no anchor.)
        </div>
      ) : status.commits.length === 0 ? (
        <div className="commit-empty">
          No commits from this task yet. Its edits are in the <b>Changes</b> tab and will be committed when the phase
          finishes.
        </div>
      ) : (
        <ol className="commit-list">
          {status.commits.map((c) => (
            <li key={c.hash} className="commit-row">
              <span className="commit-node" aria-hidden="true" />
              <div className="commit-main">
                <div className="commit-subject">{c.subject}</div>
                <div className="commit-meta">
                  <span className="commit-hash mono">{c.hash}</span>
                  <span className="commit-dot">·</span>
                  <span className="commit-author">{c.author}</span>
                  {c.at > 0 ? (
                    <>
                      <span className="commit-dot">·</span>
                      <span className="commit-when" title={new Date(c.at).toLocaleString()}>
                        {ago(c.at)} ago
                      </span>
                    </>
                  ) : null}
                  {c.local ? <span className="commit-local" title="Not yet pushed to the remote">local</span> : null}
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** The changed-file list pane — one single-click-selectable row per file, no inline expansion. Selecting a
 *  row drives the diff pane on the right; the list itself stays a compact, bounded, internally-scrolling
 *  column so it never grows the sheet. */
function FileListPane({ status, selectedPath, onSelect }: { status: GitStatus; selectedPath: string | null; onSelect: (path: string) => void }) {
  if (status.files.length === 0) {
    return <div className="git-list-empty">No changes from this task yet — nothing it wrote differs from where it started.</div>;
  }
  return (
    <ul className="git-file-list">
      {status.files.map((f) => (
        <SelectableFileRow key={f.path} file={f} selected={f.path === selectedPath} onSelect={() => onSelect(f.path)} />
      ))}
    </ul>
  );
}

const FILE_META: Record<GitFileStatus, { label: string; cls: string; full: string }> = {
  added: { label: "A", cls: "added", full: "Added" },
  modified: { label: "M", cls: "modified", full: "Modified" },
  deleted: { label: "D", cls: "deleted", full: "Deleted" },
  renamed: { label: "R", cls: "renamed", full: "Renamed" },
  untracked: { label: "U", cls: "untracked", full: "Untracked (new)" },
  conflicted: { label: "!", cls: "conflicted", full: "Conflicted" },
};

/** One row in the file-list pane: status glyph, dimmed dir + foregrounded name, and the ±badge. A single
 *  click selects it (loading its diff into the right pane); the selected row carries an accent highlight.
 *  The status reflects the file's NET change since the task started (committed + uncommitted collapsed). */
function SelectableFileRow({ file, selected, onSelect }: { file: GitFile; selected: boolean; onSelect: () => void }) {
  const meta = FILE_META[file.status];
  const { dir, name } = splitPath(file.path);
  return (
    <li>
      <button
        className={"git-file-row" + (selected ? " selected" : "")}
        onClick={onSelect}
        aria-current={selected ? "true" : undefined}
        title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
      >
        <span className={"file-status " + meta.cls} title={meta.full}>
          {meta.label}
        </span>
        <span className="file-path">
          {dir ? <span className="file-dir">{dir}</span> : null}
          <span className="file-name">{name}</span>
        </span>
        <span className="file-stat">
          {file.binary ? (
            <span className="file-binary">bin</span>
          ) : (
            <>
              {file.added > 0 ? <span className="file-add">+{file.added}</span> : null}
              {file.removed > 0 ? <span className="file-del">−{file.removed}</span> : null}
            </>
          )}
        </span>
      </button>
    </li>
  );
}

/** The diff pane — the one legitimate internal-scroll region. Fixed header (path + ±stat + a mobile back
 *  affordance) over a bounded body that scrolls the selected file's unified diff both ways. The diff is
 *  lazily fetched on first selection and cached, so switching files is instant once loaded. */
function DiffPane({ threadId, file, onBack }: { threadId: string; file: GitFile; onBack: () => void }) {
  const diff = useStore((s) => s.gitDiffs[threadId]?.[file.path]);
  const loadGitDiff = useStore((s) => s.loadGitDiff);
  const meta = FILE_META[file.status];
  const { dir, name } = splitPath(file.path);

  useEffect(() => {
    if (!diff && !file.binary) loadGitDiff(threadId, file.path);
  }, [diff, file.binary, file.path, threadId, loadGitDiff]);

  return (
    <div className="git-diff-view">
      <div className="git-diff-head">
        <button className="git-diff-back" onClick={onBack} aria-label="Back to file list">
          ‹ Files
        </button>
        <span className={"file-status " + meta.cls} title={meta.full}>
          {meta.label}
        </span>
        <span className="git-diff-path" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
          {dir ? <span className="file-dir">{dir}</span> : null}
          <span className="file-name">{name}</span>
        </span>
        <span className="file-stat">
          {file.binary ? (
            <span className="file-binary">binary</span>
          ) : (
            <>
              {file.added > 0 ? <span className="file-add">+{file.added}</span> : null}
              {file.removed > 0 ? <span className="file-del">−{file.removed}</span> : null}
            </>
          )}
        </span>
      </div>
      <div className="git-diff-body viewport-fit-scroll">
        {file.binary ? (
          <div className="diff">
            <div className="diff-note">Binary file — no textual diff.</div>
          </div>
        ) : !diff ? (
          <div className="diff">
            <div className="diff-loading">Loading diff…</div>
          </div>
        ) : (
          <Diff patch={diff.patch} truncated={diff.truncated} />
        )}
      </div>
    </div>
  );
}

interface DLine {
  t: "ctx" | "add" | "del";
  text: string;
}
interface DHunk {
  oldStart: number;
  newStart: number;
  label?: string;
  lines: DLine[];
}

/** Parse a raw unified diff (git's textual output) into hunks. File headers (diff --git / index / --- /
 *  +++) precede the first @@ so they're skipped while `cur` is null; "\ No newline" markers are dropped. */
function parseUnifiedDiff(patch: string): DHunk[] {
  const hunks: DHunk[] = [];
  let cur: DHunk | null = null;
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
      if (m) {
        cur = { oldStart: Number.parseInt(m[1]!, 10), newStart: Number.parseInt(m[2]!, 10), label: (m[3] ?? "").trim() || undefined, lines: [] };
        hunks.push(cur);
      }
      continue;
    }
    if (!cur) continue; // still in the file header block
    if (raw.startsWith("\\")) continue; // "\ No newline at end of file"
    const c = raw[0];
    if (c === "+") cur.lines.push({ t: "add", text: raw.slice(1) });
    else if (c === "-") cur.lines.push({ t: "del", text: raw.slice(1) });
    else cur.lines.push({ t: "ctx", text: raw.startsWith(" ") ? raw.slice(1) : raw });
  }
  return hunks;
}

/** A unified diff, rendered from the parsed hunks. Line numbers on both sides are computed while walking
 *  each hunk (context advances both, an add advances only new, a del only old) so the gutters stay
 *  self-consistent. Add/remove lines get the conventional green/red tint. */
function Diff({ patch, truncated }: { patch: string; truncated: boolean }) {
  const hunks = parseUnifiedDiff(patch);
  return (
    <div className="diff">
      {hunks.length === 0 ? <div className="diff-note">No textual changes.</div> : null}
      {hunks.map((h, hi) => {
        let oldNo = h.oldStart;
        let newNo = h.newStart;
        const oldLen = h.lines.filter((l) => l.t !== "add").length;
        const newLen = h.lines.filter((l) => l.t !== "del").length;
        return (
          <div className="diff-hunk" key={hi}>
            <div className="diff-hunk-head">
              <span className="diff-range">
                @@ -{h.oldStart},{oldLen} +{h.newStart},{newLen} @@
              </span>
              {h.label ? <span className="diff-label">{h.label}</span> : null}
            </div>
            {h.lines.map((l, li) => {
              const oldCell = l.t === "add" ? "" : String(oldNo++);
              const newCell = l.t === "del" ? "" : String(newNo++);
              const sign = l.t === "add" ? "+" : l.t === "del" ? "−" : " ";
              return (
                <div className={"diff-line " + l.t} key={li}>
                  <span className="diff-gutter old">{oldCell}</span>
                  <span className="diff-gutter new">{newCell}</span>
                  <span className="diff-sign" aria-hidden="true">
                    {sign}
                  </span>
                  <span className="diff-text">{l.text || " "}</span>
                </div>
              );
            })}
          </div>
        );
      })}
      {truncated ? <div className="diff-note">Diff truncated — this file is very large. Open it in your editor to see the rest.</div> : null}
    </div>
  );
}

// ---- path helpers ----------------------------------------------------------------------------------

/** Split a workspace path into its parent and its last segment (the repo folder), for the drawer header. */
function splitWorkspace(p: string): { parent: string; leaf: string } {
  const norm = p.replace(/[\\/]+$/, "");
  const i = Math.max(norm.lastIndexOf("\\"), norm.lastIndexOf("/"));
  return i < 0 ? { parent: "", leaf: norm } : { parent: norm.slice(0, i), leaf: norm.slice(i) };
}

/** Split a repo-relative path into its directory prefix (dimmed) and filename (foregrounded). */
function splitPath(p: string): { dir: string; name: string } {
  const i = p.lastIndexOf("/");
  return i < 0 ? { dir: "", name: p } : { dir: p.slice(0, i + 1), name: p.slice(i + 1) };
}

// ---- icons (inline, matched to the app's 24-grid stroke style) -------------------------------------

function ForkIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="6" cy="4" r="2" />
      <circle cx="6" cy="20" r="2" />
      <circle cx="18" cy="8" r="2" />
      <path d="M6 6v12" />
      <path d="M18 10a5 5 0 0 1-5 5H8" />
    </svg>
  );
}

function CommitIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <line x1="3" y1="12" x2="9" y2="12" />
      <line x1="15" y1="12" x2="21" y2="12" />
    </svg>
  );
}

function FileDiffIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
      <line x1="12" y1="12" x2="12" y2="18" />
      <line x1="9" y1="15" x2="15" y2="15" />
    </svg>
  );
}

function UpArrowIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 19V5" />
      <path d="m6 11 6-6 6 6" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m5 12 5 5L20 6" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg className="cc-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}
