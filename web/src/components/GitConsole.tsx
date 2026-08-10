import { useEffect, useMemo, useRef, useState } from "react";
import { useStore, repoDiffKey } from "../store.js";
import type { GitFile, GitFileStatus, RepoBranch, RepoRef, RepoState } from "../types.js";
import { ago } from "../lib/format.js";
import { FolderPicker } from "./FolderPicker.js";
import { Diff } from "./Diff.js";
import "./gitConsole.css";

/**
 * The Git console — the whole GitHub Desktop surface, in the orchestrator. Repo picker, branch menu
 * (switch / create / track a remote branch / delete), Fetch · Pull · Push, a checkbox file list with
 * per-file diffs and a commit box, and a History tab that opens any commit.
 *
 * This is repo-level and action-bearing, which is what separates it from the per-task Changes drawer
 * (`GitChanges.tsx`): that one is scoped to one task's diff and is deliberately read-only.
 *
 * Every mutation is server-authoritative — the console sends a command and re-renders from the
 * `repo.state` the server replies with. Nothing is optimistically applied, because a git action can
 * legitimately be refused (a dirty tree, a diverged branch, a live agent in the repo) and a UI that
 * assumed success would be lying about the repository.
 */

const LAST_REPO_KEY = "orch-git-console-repo";

export function GitConsole({ onClose }: { onClose: () => void }) {
  const repos = useStore((s) => s.repos);
  const preferred = useStore((s) => s.repoPreferred);
  const pending = useStore((s) => s.repoListPending);
  const selectedThreadId = useStore((s) => s.selectedThreadId);
  const loadRepos = useStore((s) => s.loadRepos);
  const loadRepoState = useStore((s) => s.loadRepoState);
  const [path, setPath] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);
  // Once the operator picks a repo themselves, nothing auto-selects over it — not a later rescan, and
  // not the task that happened to be open when the console was launched.
  const picked = useRef(false);

  // The task this console was opened from, fixed for its lifetime: switching tasks behind an open
  // console shouldn't move it, and every later request (a Rescan) must echo the SAME value or its
  // reply is discarded as stale.
  const openedFor = useRef(selectedThreadId);

  // Ask for the repo list on open, naming that task so the server can say which repo it lives in.
  useEffect(() => {
    loadRepos(false, openedFor.current);
  }, [loadRepos]);

  // Land on a repo without a click, in order of what the operator most likely meant: the open task's
  // repo, then the last one they used here, then the busiest. Waits for THIS open's answer — the list
  // and preference are still those of the previous open until it lands.
  useEffect(() => {
    if (pending || repos.length === 0 || picked.current) return;
    // `preferred` was resolved server-side, so it's trusted even if it fell outside the picker's list;
    // a remembered path is only used while it's still a repo the server knows about.
    const known = (p: string | null): string | null => (p && repos.some((r) => samePath(r.path, p)) ? p : null);
    setPath((cur) => cur ?? preferred ?? known(localStorage.getItem(LAST_REPO_KEY)) ?? repos[0]!.path);
  }, [pending, repos, preferred]);

  const pickRepo = (p: string): void => {
    picked.current = true;
    setPath(p);
  };

  useEffect(() => {
    if (!path) return;
    localStorage.setItem(LAST_REPO_KEY, path);
    loadRepoState(path);
  }, [path, loadRepoState]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="gc-scrim" onClick={onClose}>
      <div className="gc-window" role="dialog" aria-label="Git" onClick={(e) => e.stopPropagation()}>
        <RepoBar
          repos={repos}
          path={path}
          openedFor={openedFor.current}
          onPick={pickRepo}
          onBrowse={() => setBrowsing(true)}
          onClose={onClose}
        />
        {path ? (
          <RepoBody key={path} path={path} />
        ) : (
          <div className="gc-empty">{pending ? "Finding your repositories…" : "No git repository found — open one with Browse."}</div>
        )}
        {browsing ? (
          <FolderPicker
            initialPath={path ?? ""}
            onSelect={(p) => {
              setBrowsing(false);
              pickRepo(p);
              loadRepos(false, openedFor.current);
            }}
            onClose={() => setBrowsing(false)}
          />
        ) : null}
      </div>
    </div>
  );
}

// ---- top bar: repo picker + branch menu + fetch/pull/push ------------------------------------------

function RepoBar({
  repos,
  path,
  openedFor,
  onPick,
  onBrowse,
  onClose,
}: {
  repos: RepoRef[];
  path: string | null;
  /** The task the console was opened from — re-sent with a Rescan so its reply isn't discarded. */
  openedFor: string | null;
  onPick: (p: string) => void;
  onBrowse: () => void;
  onClose: () => void;
}) {
  const state = useStore((s) => (path ? s.repoStates[path] : undefined));
  const loadRepos = useStore((s) => s.loadRepos);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [rescanning, setRescanning] = useState(false);
  const current = repos.find((r) => samePath(r.path, path ?? "")) ?? null;
  const label = current?.name ?? (path ? leafOf(path) : "Pick a repository");

  // The list is every repo on the machine, so it needs filtering — on name AND path, since "vota" is
  // as likely to be typed as a folder name is.
  const q = filter.trim().toLowerCase();
  const matches = q ? repos.filter((r) => r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q)) : repos;
  const inUse = matches.filter((r) => !r.discovered);
  const onDisk = matches.filter((r) => r.discovered);

  // A rescan replies with the same repo.list event, so "done" is simply the list changing.
  useEffect(() => {
    setRescanning(false);
  }, [repos]);

  const pick = (p: string) => {
    onPick(p);
    setOpen(false);
    setFilter("");
  };

  const row = (r: RepoRef) => (
    <button key={r.path} className={"gc-menu-row" + (samePath(r.path, path ?? "") ? " on" : "")} onClick={() => pick(r.path)} title={r.path}>
      <span className="gc-menu-main">
        <span className="gc-menu-name">{r.name}</span>
        <span className="gc-menu-path">{r.path}</span>
      </span>
      <span className="gc-menu-meta">
        {r.isSelf ? <span className="gc-tag self">this app</span> : null}
        {r.activeCount > 0 ? <span className="gc-tag live">{r.activeCount} live</span> : null}
        {r.taskCount > 0 ? <span className="gc-count">{r.taskCount}</span> : null}
      </span>
    </button>
  );

  return (
    <div className="gc-topbar">
      <div className="gc-picker">
        <Menu
          open={open}
          onOpenChange={(v) => {
            setOpen(v);
            if (!v) setFilter("");
          }}
          trigger={
            <>
              <RepoIcon />
              <span className="gc-pick-main">
                <span className="gc-pick-label">Repository</span>
                <span className="gc-pick-value">{label}</span>
              </span>
              <Caret />
            </>
          }
          triggerClass="gc-pick-btn"
          ariaLabel="Choose a repository"
        >
          <div className="gc-menu-head">
            <input className="gc-filter" placeholder={`Filter ${repos.length} repositories`} value={filter} autoFocus onChange={(e) => setFilter(e.target.value)} />
          </div>
          <div className="gc-menu-scroll">
            {inUse.map(row)}
            {onDisk.length > 0 ? <div className="gc-menu-sep">Found on disk</div> : null}
            {onDisk.map(row)}
            {matches.length === 0 ? (
              <div className="gc-menu-none">{q ? `No repository matches “${filter}”.` : "No repositories found yet — try Rescan, or Browse to one."}</div>
            ) : null}
          </div>
          <div className="gc-menu-actions">
            <button
              className="gc-menu-action"
              disabled={rescanning}
              onClick={() => {
                setRescanning(true);
                loadRepos(true, openedFor);
              }}
            >
              <FetchIcon /> {rescanning ? "Scanning…" : "Rescan disk"}
            </button>
            <button
              className="gc-menu-action"
              onClick={() => {
                setOpen(false);
                onBrowse();
              }}
            >
              <FolderIcon /> Browse…
            </button>
          </div>
        </Menu>
      </div>

      {state?.isRepo ? <BranchPicker state={state} /> : <div className="gc-pick-spacer" />}
      {state?.isRepo ? <SyncActions state={state} /> : null}

      <button className="gc-close" aria-label="Close Git" onClick={onClose}>
        ✕
      </button>
    </div>
  );
}

function BranchPicker({ state }: { state: RepoState }) {
  const repoAction = useStore((s) => s.repoAction);
  const busy = useStore((s) => s.repoBusy);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  const q = filter.trim().toLowerCase();
  const locals = state.branches.filter((b) => !q || b.name.toLowerCase().includes(q));
  // A remote branch already checked out locally is the same branch — offering it twice invites the
  // "a local branch already exists" refusal instead of a switch.
  const localNames = new Set(state.branches.map((b) => b.name));
  const remotes = state.remoteBranches
    .filter((b) => !localNames.has(b.split("/").slice(1).join("/")))
    .filter((b) => !q || b.toLowerCase().includes(q));

  const run = (op: Parameters<typeof repoAction>[1]) => {
    repoAction(state.path, op);
    setOpen(false);
    setCreating(false);
    setNewName("");
    setFilter("");
  };

  return (
    <div className="gc-picker">
      <Menu
        open={open}
        onOpenChange={(v) => {
          setOpen(v);
          if (!v) {
            setCreating(false);
            setFilter("");
          }
        }}
        trigger={
          <>
            <BranchIcon />
            <span className="gc-pick-main">
              <span className="gc-pick-label">Current branch</span>
              <span className="gc-pick-value">{state.detached ? "detached HEAD" : (state.branch ?? "—")}</span>
            </span>
            <Caret />
          </>
        }
        triggerClass="gc-pick-btn"
        ariaLabel="Choose a branch"
      >
        <div className="gc-menu-head">
          <input
            className="gc-filter"
            placeholder="Filter branches"
            value={filter}
            autoFocus
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        <div className="gc-menu-scroll">
          {locals.map((b) => (
            <BranchRow key={b.name} branch={b} disabled={busy} onSwitch={() => run({ action: "checkout", branch: b.name })} onDelete={(force) => run({ action: "deleteBranch", branch: b.name, force })} />
          ))}
          {remotes.length > 0 ? <div className="gc-menu-sep">Remote</div> : null}
          {remotes.map((b) => (
            <button key={b} className="gc-menu-row" disabled={busy} onClick={() => run({ action: "checkout", branch: b })} title={`Check out ${b} as a local tracking branch`}>
              <span className="gc-menu-main">
                <span className="gc-menu-name">{b}</span>
              </span>
              <span className="gc-tag remote">track</span>
            </button>
          ))}
          {locals.length === 0 && remotes.length === 0 ? <div className="gc-menu-none">No branch matches “{filter}”.</div> : null}
        </div>
        {creating ? (
          <form
            className="gc-new-branch"
            onSubmit={(e) => {
              e.preventDefault();
              const name = newName.trim();
              if (name) run({ action: "checkout", branch: name, create: true, from: state.branch ?? undefined });
            }}
          >
            <input
              className="gc-filter"
              placeholder={`New branch from ${state.branch ?? "HEAD"}`}
              value={newName}
              autoFocus
              onChange={(e) => setNewName(e.target.value)}
            />
            <button className="gc-btn primary sm" type="submit" disabled={busy || !newName.trim()}>
              Create
            </button>
          </form>
        ) : (
          <button className="gc-menu-action" onClick={() => setCreating(true)}>
            <PlusIcon /> New branch…
          </button>
        )}
      </Menu>
    </div>
  );
}

function BranchRow({
  branch,
  disabled,
  onSwitch,
  onDelete,
}: {
  branch: RepoBranch;
  disabled: boolean;
  onSwitch: () => void;
  onDelete: (force: boolean) => void;
}) {
  return (
    <div className={"gc-branch-row" + (branch.current ? " on" : "")}>
      <button className="gc-menu-row" disabled={disabled || branch.current} onClick={onSwitch} title={branch.upstream ? `tracks ${branch.upstream}` : "not published"}>
        <span className="gc-menu-main">
          <span className="gc-menu-name">{branch.name}</span>
          <span className="gc-menu-path">
            {branch.current ? "current · " : ""}
            {branch.gone ? "upstream gone · " : ""}
            {branch.at > 0 ? `${ago(branch.at)} ago` : ""}
          </span>
        </span>
        <span className="gc-menu-meta">
          {branch.ahead > 0 ? <span className="gc-tag ahead">↑{branch.ahead}</span> : null}
          {branch.behind > 0 ? <span className="gc-tag behind">↓{branch.behind}</span> : null}
        </span>
      </button>
      {branch.current ? null : (
        <button
          className="gc-branch-del"
          disabled={disabled}
          aria-label={`Delete branch ${branch.name}`}
          title={`Delete ${branch.name}`}
          onClick={() => {
            const force = window.confirm(
              `Delete the branch “${branch.name}”?\n\nOK deletes it even if it isn't merged (git branch -D) — that discards its commits. Cancel to leave it alone.`,
            );
            if (force) onDelete(true);
          }}
        >
          <TrashIcon />
        </button>
      )}
    </div>
  );
}

/** Pull, as a split control: the main half fast-forwards (a one-click Pull should never invent a merge
 *  bubble), the caret offers the rebase the fast-forward refusal points you at when the branch has
 *  diverged. Without the second half that refusal would name an affordance the console doesn't have. */
function PullButton({ state }: { state: RepoState }) {
  const repoAction = useStore((s) => s.repoAction);
  const busy = useStore((s) => s.repoBusy);
  const [open, setOpen] = useState(false);
  const canPull = !!state.upstreamRef && !state.detached;

  return (
    <div className="gc-split">
      <button
        className="gc-btn gc-split-main"
        disabled={busy || !canPull}
        title={
          !canPull
            ? "This branch has no upstream to pull from"
            : state.behind > 0
              ? `Fast-forward ${state.behind} commit${state.behind === 1 ? "" : "s"} from ${state.upstreamRef}`
              : `Up to date with ${state.upstreamRef}`
        }
        onClick={() => repoAction(state.path, { action: "pull", rebase: false })}
      >
        <PullIcon /> Pull
        {state.behind > 0 ? <span className="gc-btn-count">{state.behind}</span> : null}
      </button>
      <Menu
        open={open}
        onOpenChange={setOpen}
        trigger={<Caret />}
        triggerClass="gc-btn gc-split-caret"
        ariaLabel="More pull options"
      >
        <button
          className="gc-menu-action"
          disabled={busy || !canPull}
          onClick={() => {
            setOpen(false);
            repoAction(state.path, { action: "pull", rebase: true });
          }}
        >
          <PullIcon /> Pull (rebase)
          <span className="gc-menu-hint">Replays your local commits on top of {state.upstreamRef ?? "the upstream"} — use this when the branches have diverged.</span>
        </button>
      </Menu>
    </div>
  );
}

/** Fetch · Pull · Push — the three buttons the whole console exists for, each labelled with what it
 *  would actually do right now (how many commits, to or from where) rather than a bare verb. */
function SyncActions({ state }: { state: RepoState }) {
  const repoAction = useStore((s) => s.repoAction);
  const busy = useStore((s) => s.repoBusy);
  const published = !!state.pushRef;

  return (
    <div className="gc-sync">
      <button
        className="gc-btn"
        disabled={busy || state.remotes.length === 0}
        title={state.lastFetchAt ? `Last fetched ${ago(state.lastFetchAt)} ago` : "Never fetched"}
        onClick={() => repoAction(state.path, { action: "fetch", prune: true })}
      >
        <FetchIcon /> Fetch
        {state.lastFetchAt ? <span className="gc-btn-sub">{ago(state.lastFetchAt)}</span> : null}
      </button>

      <PullButton state={state} />

      {state.webUrl ? (
        <a className="gc-btn" href={state.webUrl} target="_blank" rel="noreferrer" title={`Open ${state.webUrl} in your browser`}>
          <ExternalIcon /> Open
        </a>
      ) : null}

      {state.isVota ? (
        <span className="gc-vota" title="Vota repos are commit-only by policy — pushes are done manually">
          <ShieldIcon /> commit-only
        </span>
      ) : (
        <button
          className={"gc-btn" + (state.ahead > 0 ? " primary" : "")}
          disabled={busy || state.detached || state.remotes.length === 0}
          title={
            !published
              ? `Publish ${state.branch} to ${state.remotes[0]?.name ?? "origin"} and set it as the upstream`
              : state.ahead > 0
                ? `Push ${state.ahead} commit${state.ahead === 1 ? "" : "s"} to ${state.pushRef}`
                : `Nothing to push — ${state.pushRef} is up to date`
          }
          onClick={() => repoAction(state.path, { action: "push", setUpstream: !published })}
        >
          <PushIcon /> {published ? "Push" : "Publish"}
          {state.ahead > 0 ? <span className="gc-btn-count">{state.ahead}</span> : null}
        </button>
      )}
    </div>
  );
}

// ---- body: activity line + changes/history panes ---------------------------------------------------

function RepoBody({ path }: { path: string }) {
  const state = useStore((s) => s.repoStates[path]);
  const [tab, setTab] = useState<"changes" | "history">("changes");

  if (!state) return <div className="gc-empty">Reading the repository…</div>;
  if (!state.isRepo) return <div className="gc-empty">{state.error ?? "That folder isn't a git repository."}</div>;

  return (
    <>
      <ActivityLine state={state} />
      <div className="gc-body">
        <div className="gc-left">
          <div className="gc-tabs" role="tablist" aria-label="Changes and history">
            <button role="tab" aria-selected={tab === "changes"} className={"gc-tab" + (tab === "changes" ? " on" : "")} onClick={() => setTab("changes")}>
              Changes <span className="gc-tab-count">{state.files.length}</span>
            </button>
            <button role="tab" aria-selected={tab === "history"} className={"gc-tab" + (tab === "history" ? " on" : "")} onClick={() => setTab("history")}>
              History <span className="gc-tab-count">{state.commits.length}</span>
            </button>
          </div>
          {tab === "changes" ? <ChangesPane state={state} /> : <HistoryPane state={state} />}
        </div>
      </div>
    </>
  );
}

/** The one-line result of the last action — git's own words, kept until the next action. This is where
 *  a refusal lands, so it has to be readable rather than a toast that vanishes before it's read. */
function ActivityLine({ state }: { state: RepoState }) {
  const result = useStore((s) => s.repoResult);
  const busy = useStore((s) => s.repoBusy);
  const clear = useStore((s) => s.clearRepoResult);
  const repoAction = useStore((s) => s.repoAction);
  const lastOp = useStore((s) => s.repoLastOp);

  if (busy) {
    return (
      <div className="gc-activity busy">
        <span className="gc-spinner" aria-hidden="true" /> Running git…
      </div>
    );
  }
  if (!result) {
    return state.busy.length > 0 ? (
      <div className="gc-activity note">
        <LiveDot /> {state.busy.length} task{state.busy.length === 1 ? "" : "s"} working in this repo — branch switches, pulls and discards are held back while they run.
      </div>
    ) : null;
  }

  return (
    <div className={"gc-activity " + (result.ok ? "ok" : result.blocked ? "note" : "err")}>
      <span className="gc-activity-text">{result.message}</span>
      {result.blocked && lastOp ? (
        <button className="gc-btn sm danger" onClick={() => repoAction(state.path, lastOp, true)}>
          Do it anyway
        </button>
      ) : null}
      <button className="gc-activity-x" aria-label="Dismiss" onClick={clear}>
        ✕
      </button>
    </div>
  );
}

/** Changes: the checkbox file list + commit box on the left, the selected file's diff on the right —
 *  GitHub Desktop's layout, because it's the one that puts the commit box where your eye already is. */
function ChangesPane({ state }: { state: RepoState }) {
  const repoAction = useStore((s) => s.repoAction);
  const busy = useStore((s) => s.repoBusy);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [viewing, setViewing] = useState<string | null>(null);
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");

  const paths = useMemo(() => state.files.map((f) => f.path), [state.files]);
  const pathKey = paths.join("\n");
  // Files we have already offered a tick for. A file the operator UNticked must stay unticked across the
  // state refreshes that follow every action — which needs "have I seen this path before?", not just the
  // current selection (an unticked file and a brand-new file both look "not selected").
  const offered = useRef<Set<string>>(new Set());

  // A newly-appeared file starts ticked (GitHub Desktop’s default); a file that vanished — committed,
  // discarded — drops out of the selection rather than lingering as a phantom.
  useEffect(() => {
    const all = new Set(pathKey ? pathKey.split("\n") : []);
    setSelected((cur) => {
      const next = new Set<string>();
      for (const p of all) if (!offered.current.has(p) || cur.has(p)) next.add(p);
      return next;
    });
    offered.current = all;
    setViewing((cur) => (cur && all.has(cur) ? cur : ([...all][0] ?? null)));
  }, [pathKey]);

  const chosen = state.files.filter((f) => selected.has(f.path));
  const viewedFile = state.files.find((f) => f.path === viewing) ?? null;
  const toggle = (p: string) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });

  const commit = () => {
    const s = summary.trim();
    if (!s || chosen.length === 0) return;
    repoAction(state.path, { action: "commit", summary: s, description: description.trim(), paths: chosen.map((f) => f.path) });
    setSummary("");
    setDescription("");
  };

  const discard = () => {
    if (chosen.length === 0) return;
    const ok = window.confirm(
      `Discard changes in ${chosen.length} file${chosen.length === 1 ? "" : "s"}?\n\n` +
        chosen.slice(0, 8).map((f) => `  ${f.path}`).join("\n") +
        (chosen.length > 8 ? `\n  …and ${chosen.length - 8} more` : "") +
        `\n\nTracked files go back to HEAD and new files are deleted. This cannot be undone.`,
    );
    if (ok) repoAction(state.path, { action: "discard", paths: chosen.map((f) => f.path) });
  };

  return (
    <div className="gc-panes">
      <div className="gc-list-col">
        <div className="gc-list-head">
          <label className="gc-check-all">
            <input
              type="checkbox"
              checked={state.files.length > 0 && selected.size === state.files.length}
              ref={(el) => {
                if (el) el.indeterminate = selected.size > 0 && selected.size < state.files.length;
              }}
              disabled={state.files.length === 0}
              onChange={(e) => setSelected(e.target.checked ? new Set(paths) : new Set())}
            />
            <span>
              {state.files.length} changed file{state.files.length === 1 ? "" : "s"}
            </span>
          </label>
          <button className="gc-link danger" disabled={busy || chosen.length === 0} onClick={discard} title="Discard the selected changes">
            Discard
          </button>
        </div>

        <div className="gc-scroll">
          {state.files.length === 0 ? (
            <div className="gc-none">No local changes — the working tree is clean.</div>
          ) : (
            <ul className="gc-files">
              {state.files.map((f) => (
                <li key={f.path}>
                  <div className={"gc-file" + (f.path === viewing ? " viewing" : "")}>
                    <input type="checkbox" checked={selected.has(f.path)} onChange={() => toggle(f.path)} aria-label={`Include ${f.path} in the commit`} />
                    <button className="gc-file-main" onClick={() => setViewing(f.path)} title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}>
                      <FileName file={f} />
                    </button>
                    <StatusGlyph status={f.status} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="gc-commit">
          <input
            className="gc-commit-summary"
            placeholder={chosen.length === 1 ? `Update ${leafOf(chosen[0]!.path)}` : "Summary (required)"}
            value={summary}
            disabled={state.files.length === 0}
            onChange={(e) => setSummary(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) commit();
            }}
          />
          <textarea
            className="gc-commit-body"
            placeholder="Description"
            rows={2}
            value={description}
            disabled={state.files.length === 0}
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) commit();
            }}
          />
          <button className="gc-btn primary wide" disabled={busy || !summary.trim() || chosen.length === 0} onClick={commit}>
            Commit {chosen.length} file{chosen.length === 1 ? "" : "s"} to <b>{state.branch ?? "HEAD"}</b>
          </button>
        </div>
      </div>

      <div className="gc-diff-col">
        {viewedFile ? (
          <DiffView repoPath={state.path} file={viewedFile} />
        ) : (
          <div className="gc-none pad">{state.files.length === 0 ? "Nothing to show — no local changes." : "Select a file to see its diff."}</div>
        )}
      </div>
    </div>
  );
}

/** History: the repo's recent commits; opening one shows its files and their diffs. */
function HistoryPane({ state }: { state: RepoState }) {
  const loadRepoCommit = useStore((s) => s.loadRepoCommit);
  const detail = useStore((s) => s.repoCommits[state.path]);
  const [openHash, setOpenHash] = useState<string | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);

  useEffect(() => {
    const first = state.commits[0]?.hash ?? null;
    setOpenHash((cur) => (cur && state.commits.some((c) => c.hash === cur) ? cur : first));
  }, [state.commits]);

  useEffect(() => {
    if (openHash && !detail?.[openHash]) loadRepoCommit(state.path, openHash);
  }, [openHash, detail, state.path, loadRepoCommit]);

  const open = openHash ? detail?.[openHash] : undefined;
  useEffect(() => {
    setViewing(open?.files[0]?.path ?? null);
  }, [open?.fullHash, open?.files]);

  const viewedFile = open?.files.find((f) => f.path === viewing) ?? null;

  return (
    <div className="gc-panes">
      <div className="gc-list-col">
        <div className="gc-scroll">
          {state.commits.length === 0 ? (
            <div className="gc-none">No commits yet.</div>
          ) : (
            <ol className="gc-commits">
              {state.commits.map((c) => (
                <li key={c.hash}>
                  <button className={"gc-commit-row" + (c.hash === openHash ? " on" : "")} onClick={() => setOpenHash(c.hash)}>
                    <span className="gc-commit-subject">{c.subject}</span>
                    <span className="gc-commit-meta">
                      <span className="mono">{c.hash}</span>
                      <span>·</span>
                      <span>{c.author}</span>
                      {c.at > 0 ? (
                        <>
                          <span>·</span>
                          <span title={new Date(c.at).toLocaleString()}>{ago(c.at)} ago</span>
                        </>
                      ) : null}
                      {c.local ? <span className="gc-tag local">local</span> : null}
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>

      <div className="gc-diff-col">
        {!open ? (
          <div className="gc-none pad">Select a commit.</div>
        ) : open.error ? (
          <div className="gc-none pad">{open.error}</div>
        ) : (
          <div className="gc-commit-detail">
            <div className="gc-detail-head">
              <div className="gc-detail-subject">{open.subject}</div>
              {open.body ? <pre className="gc-detail-body">{open.body}</pre> : null}
              <div className="gc-detail-meta">
                <span className="mono">{open.fullHash.slice(0, 10)}</span>
                <span>·</span>
                <span>
                  {open.author} {open.email ? `<${open.email}>` : ""}
                </span>
                {open.at > 0 ? (
                  <>
                    <span>·</span>
                    <span>{new Date(open.at).toLocaleString()}</span>
                  </>
                ) : null}
              </div>
            </div>
            {open.isMerge ? (
              <div className="gc-none pad">A merge commit — it has no single diff of its own.</div>
            ) : (
              <>
                <div className="gc-detail-files">
                  {open.files.map((f) => (
                    <button key={f.path} className={"gc-detail-file" + (f.path === viewing ? " on" : "")} onClick={() => setViewing(f.path)}>
                      <StatusGlyph status={f.status} />
                      <span className="gc-detail-file-name">{f.path}</span>
                    </button>
                  ))}
                </div>
                {viewedFile ? <DiffView repoPath={state.path} file={viewedFile} commit={open.fullHash} /> : null}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** One file's diff, lazily fetched and cached. Renders the shared unified-diff view so the console and
 *  the per-task drawer show a diff exactly the same way. */
function DiffView({ repoPath, file, commit }: { repoPath: string; file: GitFile; commit?: string }) {
  const key = repoDiffKey(file.path, commit ?? null);
  const diff = useStore((s) => s.repoDiffs[repoPath]?.[key]);
  const loadRepoDiff = useStore((s) => s.loadRepoDiff);

  useEffect(() => {
    if (!diff && !file.binary) loadRepoDiff(repoPath, file.path, commit);
  }, [diff, file.binary, file.path, repoPath, commit, loadRepoDiff]);

  return (
    <div className="gc-diff">
      <div className="gc-diff-head">
        <StatusGlyph status={file.status} />
        <span className="gc-diff-path" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
          <FileName file={file} />
        </span>
        <span className="gc-diff-stat">
          {file.binary ? (
            <span className="gc-bin">binary</span>
          ) : (
            <>
              {file.added > 0 ? <span className="gc-add">+{file.added}</span> : null}
              {file.removed > 0 ? <span className="gc-del">−{file.removed}</span> : null}
            </>
          )}
        </span>
      </div>
      <div className="gc-diff-scroll">
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

// ---- small shared bits ------------------------------------------------------------------------------

const STATUS_META: Record<GitFileStatus, { label: string; cls: string; full: string }> = {
  added: { label: "A", cls: "added", full: "Added" },
  modified: { label: "M", cls: "modified", full: "Modified" },
  deleted: { label: "D", cls: "deleted", full: "Deleted" },
  renamed: { label: "R", cls: "renamed", full: "Renamed" },
  untracked: { label: "U", cls: "untracked", full: "Untracked (new)" },
  conflicted: { label: "!", cls: "conflicted", full: "Conflicted" },
};

function StatusGlyph({ status }: { status: GitFileStatus }) {
  const meta = STATUS_META[status];
  return (
    <span className={"gc-status " + meta.cls} title={meta.full}>
      {meta.label}
    </span>
  );
}

function FileName({ file }: { file: GitFile }) {
  const i = file.path.lastIndexOf("/");
  return (
    <>
      {i >= 0 ? <span className="gc-dir">{file.path.slice(0, i + 1)}</span> : null}
      <span className="gc-name">{file.path.slice(i + 1)}</span>
    </>
  );
}

/** A dropdown that closes on outside-click and Escape — the repo and branch pickers share it so the two
 *  can't drift apart in behaviour. */
function Menu({
  open,
  onOpenChange,
  trigger,
  triggerClass,
  ariaLabel,
  children,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  trigger: React.ReactNode;
  triggerClass: string;
  ariaLabel: string;
  children: React.ReactNode;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) onOpenChange(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onOpenChange(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, onOpenChange]);

  return (
    <div className="gc-menu-wrap" ref={wrap}>
      <button className={triggerClass + (open ? " on" : "")} aria-label={ariaLabel} aria-expanded={open} onClick={() => onOpenChange(!open)}>
        {trigger}
      </button>
      {open ? <div className="gc-menu">{children}</div> : null}
    </div>
  );
}

/** Windows path comparison — the server answers with git's spelling, the picker with the OS's, and they
 *  differ in slash direction and drive-letter case on the same folder. */
function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

function leafOf(p: string): string {
  const norm = p.replace(/[\\/]+$/, "");
  const i = Math.max(norm.lastIndexOf("\\"), norm.lastIndexOf("/"));
  return i < 0 ? norm : norm.slice(i + 1);
}

// ---- icons (inline, matched to the app's 24-grid stroke style) -------------------------------------

function RepoIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  );
}

function BranchIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="6" cy="4" r="2" />
      <circle cx="6" cy="20" r="2" />
      <circle cx="18" cy="8" r="2" />
      <path d="M6 6v12" />
      <path d="M18 10a5 5 0 0 1-5 5H8" />
    </svg>
  );
}

function FetchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
      <path d="M3 21v-5h5" />
    </svg>
  );
}

function PullIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3v14" />
      <path d="m6 11 6 6 6-6" />
      <path d="M4 21h16" />
    </svg>
  );
}

function PushIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 21V7" />
      <path d="m6 13 6-6 6 6" />
      <path d="M4 3h16" />
    </svg>
  );
}

function ExternalIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 6h18" />
      <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    </svg>
  );
}

function Caret() {
  return (
    <svg className="gc-caret" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function LiveDot() {
  return <span className="gc-live-dot" aria-hidden="true" />;
}
