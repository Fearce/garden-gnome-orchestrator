import { memo, useEffect, useState, type CSSProperties } from "react";
import { useShallow } from "zustand/react/shallow";
import { useStore } from "../store.js";
import type { AgentRun, Role, Thread } from "../types.js";
import { closesInDays, isClosable, roleColor, runActive, stateColor, stateLabel, threadRunning } from "../lib/format.js";
import { Elapsed } from "../lib/timing.js";
import { Gnome } from "./Gnome.js";

// Pipeline order for laying out the role pips. The path is agent-routed, so which of these
// actually run varies (the researcher is conditional) — pips are derived from real runs below.
const PIPELINE_ORDER: Role[] = ["planner", "researcher", "implementor", "qa"];
const PER_PAGE = 15;

// Finished states hidden by the "Show completed tasks" setting. Only the genuinely-done outcomes —
// review/failed stay visible because they still want the owner's attention.
const COMPLETED_STATES = new Set<Thread["state"]>(["done", "cancelled"]);

export function Board() {
  const threads = useStore((s) => s.threads);
  const showCompleted = useStore((s) => s.showCompleted);
  const all = Object.values(threads);
  // Most-recently-active first: a state change, an inject, or a resume bumps updatedAt, so a task
  // you just touched jumps to the front. Ties (and brand-new tasks) fall back to creation order.
  // Closed tasks are pulled out of the main board into the Closed holding area below; completed tasks
  // are hidden too when the owner turned that off in settings.
  const hiddenCompleted = !showCompleted ? all.filter((t) => COMPLETED_STATES.has(t.state)).length : 0;
  const list = all
    .filter((t) => t.state !== "closed" && (showCompleted || !COMPLETED_STATES.has(t.state)))
    .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);
  const closed = all
    .filter((t) => t.state === "closed")
    .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0));
  const [page, setPage] = useState(0);

  const pageCount = Math.max(1, Math.ceil(list.length / PER_PAGE));
  useEffect(() => {
    if (page > pageCount - 1) setPage(pageCount - 1);
  }, [pageCount, page]);
  const cur = Math.min(page, pageCount - 1);
  const pageItems = list.slice(cur * PER_PAGE, cur * PER_PAGE + PER_PAGE);

  return (
    <main className="board">
      <div className="board-head">
        <h2>Tasks</h2>
        <span className="faint mono" style={{ fontSize: 11 }}>
          {list.length} total
          {hiddenCompleted > 0 ? ` · ${hiddenCompleted} completed hidden` : ""}
        </span>
      </div>
      {list.length === 0 ? (
        <div className="empty">
          <div className="big">No tasks running</div>
          <div className="faint">Dispatch one from the Director on the left.</div>
        </div>
      ) : (
        <>
          <div className="lanes">
            {pageItems.map((t) => (
              <Card key={t.id} thread={t} />
            ))}
          </div>
          {pageCount > 1 ? (
            <div className="pager">
              <button className="btn ghost sm" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={cur === 0}>
                ‹ Prev
              </button>
              <span className="pager-info mono">
                {cur * PER_PAGE + 1}–{Math.min((cur + 1) * PER_PAGE, list.length)} of {list.length} · page {cur + 1}/{pageCount}
              </span>
              <button className="btn ghost sm" onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))} disabled={cur >= pageCount - 1}>
                Next ›
              </button>
            </div>
          ) : null}
        </>
      )}
      <ClosedSection threads={closed} />
    </main>
  );
}

const CLOSED_OPEN_KEY = "orch-closed-open";

/** The Closed holding area: a quiet, collapsed-by-default row at the bottom of the board. It's a
 *  safety net, not something you browse — so it stays out of the way until you expand it. */
function ClosedSection({ threads }: { threads: Thread[] }) {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(CLOSED_OPEN_KEY) === "1";
    } catch {
      return false;
    }
  });
  if (threads.length === 0) return null;
  const toggle = () =>
    setOpen((v) => {
      const next = !v;
      try {
        localStorage.setItem(CLOSED_OPEN_KEY, next ? "1" : "0");
      } catch {
        /* private mode */
      }
      return next;
    });
  return (
    <section className="closed-section">
      <button className="closed-toggle" onClick={toggle} aria-expanded={open}>
        <span className={"closed-caret" + (open ? " open" : "")} aria-hidden="true">
          ›
        </span>
        Closed · {threads.length}
      </button>
      {open ? (
        <div className="closed-list">
          {threads.map((t) => (
            <ClosedCard key={t.id} thread={t} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function ClosedCard({ thread }: { thread: Thread }) {
  const restore = useStore((s) => s.restore);
  const dismiss = useStore((s) => s.dismiss);
  const days = thread.closedAt != null ? closesInDays(thread.closedAt) : 30;
  const expiry = days <= 0 ? "auto-removes soon" : `auto-removes in ${days} ${days === 1 ? "day" : "days"}`;
  return (
    <div className="closed-card">
      <div className="closed-card-main">
        <span className="badge closed-badge">closed</span>
        <span className="closed-card-title" title={thread.title}>
          {thread.title}
        </span>
      </div>
      <div className="closed-card-foot">
        <span className="closed-expiry" title="Closed tasks are permanently deleted 30 days after they're closed">
          {expiry}
        </span>
        <span className="closed-actions">
          <button className="btn ghost sm" onClick={() => restore(thread.id)} title="Move this task back to the board">
            Restore
          </button>
          <button
            className="btn danger sm"
            title="Permanently delete this task"
            onClick={() => {
              if (window.confirm(`Permanently delete "${thread.title}"? This can't be undone.`)) dismiss(thread.id);
            }}
          >
            Delete permanently
          </button>
        </span>
      </div>
    </div>
  );
}

function latestRun(runs: AgentRun[], role: Role): AgentRun | undefined {
  return runs.filter((r) => r.role === role).sort((a, b) => b.startedAt - a.startedAt)[0];
}

/** The roles to show as pips: the ones that actually ran, in pipeline order (so the researcher pip
 *  appears only when the planner routed to it). Before any run exists, show the planner — it's
 *  always next — so a just-dispatched card isn't blank. */
function pipRoles(runs: AgentRun[]): Role[] {
  const ran = PIPELINE_ORDER.filter((role) => runs.some((r) => r.role === role));
  return ran.length ? ran : ["planner"];
}

/** Split a workspace path into its parent and its last segment (the repo folder). The leaf carries
 *  its leading separator so it reads naturally, and it's the part the user scans for — so it's never
 *  truncated; the parent is what gives way when space is tight. */
function splitWorkspace(p: string): { parent: string; leaf: string } {
  const norm = p.replace(/[\\/]+$/, "");
  const i = Math.max(norm.lastIndexOf("\\"), norm.lastIndexOf("/"));
  return i < 0 ? { parent: "", leaf: norm } : { parent: norm.slice(0, i), leaf: norm.slice(i) };
}

/** The target repo, foregrounded on the card — it's how you tell tasks apart at a glance (and decide
 *  which to resume). Repo folder is bold/bright and always shown; the parent path dims and truncates. */
function WorkspacePath({ path }: { path: string }) {
  const { parent, leaf } = splitWorkspace(path);
  return (
    <div className="ws-path" title={path}>
      <svg className="ws-ico" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
      </svg>
      {parent ? <span className="ws-parent">{parent}</span> : null}
      <span className="ws-leaf">{leaf}</span>
    </div>
  );
}

// Memoized + each subscription is narrowed to THIS thread, so a card re-renders only when its own
// runs/findings/feed/draft/selection change — not on every WS event for any task on the board.
const Card = memo(function Card({ thread }: { thread: Thread }) {
  // useShallow keeps the array reference stable when this thread's run set is unchanged.
  const threadRuns = useStore(useShallow((s) => Object.values(s.runs).filter((r) => r.threadId === thread.id)));
  const findCount = useStore((s) => s.findings.reduce((n, f) => (f.threadId === thread.id ? n + 1 : n), 0));
  const draftText = useStore((s) => s.threadDrafts[thread.id]?.text);
  const lastText = useStore((s) => {
    const feed = s.threadFeeds[thread.id];
    if (feed) for (let i = feed.length - 1; i >= 0; i--) if (feed[i]!.kind === "text") return (feed[i] as { text: string }).text;
    return undefined;
  });
  const selected = useStore((s) => s.selectedThreadId === thread.id);
  const select = useStore((s) => s.select);
  const close = useStore((s) => s.close);
  const verbosity = useStore((s) => s.verbosity);

  const impl = latestRun(threadRuns, "implementor");
  // Full shows the agent's latest streaming line; compact drops it so the card is just title + pips + state.
  const activity = verbosity === "full" ? draftText || lastText || thread.brief.split("\n")[0] || "—" : null;

  const live = threadRunning(thread.state);
  // The ✕ soft-closes a parked task (review / paused / done / failed / cancelled) — it moves to the
  // Closed list below, restorable, rather than being deleted outright. A running task shows no ✕, so
  // active work is never discarded (cancel it from the detail panel first). stopPropagation keeps the
  // click from also opening the detail panel of a card that's leaving the board.
  const canClose = isClosable(thread.state);

  return (
    <div
      className={"card" + (selected ? " sel" : "") + (live ? " live" : "")}
      style={{ "--state-color": stateColor(thread.state) } as CSSProperties}
      onClick={() => select(thread.id)}
    >
      {canClose ? (
        <button
          className="card-dismiss"
          title="Close — move to the Closed list (restorable)"
          aria-label="Close task"
          onClick={(e) => {
            e.stopPropagation();
            close(thread.id);
          }}
        >
          ✕
        </button>
      ) : null}
      {live ? <span className="live-dot" title="Active — an agent is working on this task right now" /> : null}
      <div className="title">{thread.title}</div>
      <WorkspacePath path={thread.workspace} />
      <div className="pips">
        {pipRoles(threadRuns).map((role) => {
          const r = latestRun(threadRuns, role);
          const active = r && runActive(r.state);
          const cls = active ? "active" : r ? "done" : "idle";
          return (
            <span key={role} className={"pip " + cls} style={{ "--role": roleColor(role) } as CSSProperties}>
              {/* The currently-working role shows its gnome (it breathes via `.pip.active .gnome`); idle
                  and done roles stay a quiet status dot, so the active agent is what your eye lands on. */}
              {active ? <Gnome role={role} size={15} /> : <span className="pip-dot" aria-hidden="true" />}
              <span className="pip-text">
                <span className="pip-role">{role[0]!.toUpperCase() + role.slice(1, 4)}</span>
                {r ? <Elapsed className="pip-time" startMs={r.startedAt} endMs={r.endedAt} running={!!active} /> : null}
              </span>
            </span>
          );
        })}
      </div>
      {activity !== null ? <div className="activity">{activity}</div> : null}
      <div className="foot">
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <span className="badge" style={{ "--state-color": stateColor(thread.state) } as CSSProperties}>
            {stateLabel(thread.state)}
          </span>
          {impl?.effort ? (
            <span className={"effort-badge eff-" + impl.effort} title="Implementor effort (planner-chosen)">
              {impl.effort}
            </span>
          ) : null}
        </span>
        <span className="foot-right">
          <Elapsed
            className="task-elapsed"
            startMs={thread.createdAt}
            endMs={thread.updatedAt}
            running={threadRunning(thread.state)}
            title="Time since the task was dispatched"
          />
          {findCount > 0 ? <span className="findcount">⚑ {findCount}</span> : null}
        </span>
      </div>
    </div>
  );
});
