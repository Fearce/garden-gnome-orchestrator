import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type HTMLAttributes } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, rectSortingStrategy, sortableKeyboardCoordinates, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useStore, type TaskSort } from "../store.js";
import type { AgentRun, Role, Thread, ThreadState } from "../types.js";
import { repoRoom } from "../types.js";
import { clockHM, closesInDays, isCapParked, isClosable, roleColor, runActive, soonestReset, stateColor, stateLabel, threadRunning } from "../lib/format.js";
import { Elapsed } from "../lib/timing.js";
import { Gnome } from "./Gnome.js";

// Pipeline order for laying out the role pips. The path is agent-routed, so which of these
// actually run varies (the researcher is conditional) — pips are derived from real runs below.
const PIPELINE_ORDER: Role[] = ["planner", "researcher", "implementor", "qa"];
const PER_PAGE = 15;

// Finished states hidden by the "Show completed tasks" setting. Only the genuinely-done outcomes —
// review/failed stay visible because they still want the owner's attention.
const COMPLETED_STATES = new Set<Thread["state"]>(["done", "cancelled"]);

// Most-recently-active first: a state change, an inject, or a resume bumps updatedAt, so a task you
// just touched jumps to the front. Ties (and brand-new tasks) fall back to creation order.
const byRecency = (a: Thread, b: Thread) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt;

// Lifecycle rank for the "Status" sort: live work first (an agent is on it), then tasks waiting on a
// human, then review, then the terminal outcomes. Exhaustive over ThreadState so adding a new state is
// a typecheck error here, not a silently-unsorted card. Ties fall back to recency.
const STATUS_RANK: Record<ThreadState, number> = {
  intake: 0,
  enriching: 0,
  queued: 1,
  planning: 2,
  researching: 2,
  implementing: 2,
  qa: 2,
  awaiting_user: 3,
  awaiting_approval: 3,
  paused: 4,
  review: 5,
  done: 6,
  failed: 7,
  cancelled: 8,
  closed: 9,
};

// The repo folder (last path segment), lower-cased and sans separator — the key the user scans by when
// sorting "by project". splitWorkspace keeps the leading slash for display, so strip it here.
const repoKey = (t: Thread) => splitWorkspace(t.workspace).leaf.replace(/^[\\/]+/, "").toLowerCase();

// The board sort options, in dropdown order. Each carries its comparator; byRecency is the shared
// tiebreaker so equal-rank tasks still read newest-touched-first.
const SORT_OPTIONS: { value: TaskSort; label: string; cmp: (a: Thread, b: Thread) => number }[] = [
  { value: "created_desc", label: "Newest first", cmp: (a, b) => b.createdAt - a.createdAt },
  { value: "created_asc", label: "Oldest first", cmp: (a, b) => a.createdAt - b.createdAt },
  { value: "updated", label: "Last updated", cmp: byRecency },
  { value: "status", label: "Status", cmp: (a, b) => STATUS_RANK[a.state] - STATUS_RANK[b.state] || byRecency(a, b) },
  { value: "workspace", label: "Project", cmp: (a, b) => repoKey(a).localeCompare(repoKey(b)) || byRecency(a, b) },
  { value: "title", label: "Alphabetical", cmp: (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }) || byRecency(a, b) },
];
const sortComparator = (sort: TaskSort) => (SORT_OPTIONS.find((o) => o.value === sort) ?? SORT_OPTIONS[0]!).cmp;

/** Lay the active board out by the owner's manual drag order. Tasks already in `order` keep their
 *  manual slot (so a live updatedAt bump never reshuffles them); tasks not yet placed — brand-new
 *  ones — lead by recency, matching the default board's feel until they're dragged. Stale ids in
 *  `order` (closed/dismissed since) simply fall away because they're no longer in the active set. */
function orderByManual(active: Thread[], order: string[]): Thread[] {
  const byId = new Map(active.map((t) => [t.id, t]));
  const placed = new Set(order);
  const fresh = active.filter((t) => !placed.has(t.id)).sort(byRecency);
  const kept = order.map((id) => byId.get(id)).filter((t): t is Thread => !!t);
  return [...fresh, ...kept];
}

export function Board() {
  const threads = useStore((s) => s.threads);
  const showCompleted = useStore((s) => s.showCompleted);
  const dndEnabled = useStore((s) => s.taskDragAndDrop);
  const taskSort = useStore((s) => s.taskSort);
  const taskOrder = useStore((s) => s.taskOrder);
  const setTaskOrder = useStore((s) => s.setTaskOrder);
  const setTaskSort = useStore((s) => s.setTaskSort);
  const all = Object.values(threads);
  // Closed tasks are pulled out of the main board into the Closed holding area below; completed tasks
  // are hidden too when the owner turned that off in settings.
  const hiddenCompleted = !showCompleted ? all.filter((t) => COMPLETED_STATES.has(t.state)).length : 0;
  const active = all.filter((t) => t.state !== "closed" && (showCompleted || !COMPLETED_STATES.has(t.state)));
  // With drag-and-drop on, the manual order is authoritative (no recency re-sort, or cards would jump
  // out from under a drag on the next WS event); off, the board behaves exactly as it always has.
  const list = useMemo(
    () => (dndEnabled ? orderByManual(active, taskOrder) : [...active].sort(sortComparator(taskSort))),
    [dndEnabled, active, taskOrder, taskSort],
  );

  // Picking a sort always persists the choice. With DnD off the `list` memo re-sorts on it directly.
  // With DnD on the manual order is authoritative, so a pick wouldn't otherwise move anything — re-seed
  // the manual order from the chosen comparator so the board visibly reflows, leaving drag to fine-tune
  // from there. Seeding the FULL active set means the canonicalization effect finds it already canonical
  // (every id placed, none fresh) and converges in the same pass — no reorder loop.
  const applySort = (sort: TaskSort) => {
    setTaskSort(sort);
    if (dndEnabled) setTaskOrder([...active].sort(sortComparator(sort)).map((t) => t.id));
  };
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

  // Keep the persisted order canonical while DnD is on: fold brand-new tasks in (at their fresh-lead
  // slot) and drop stale ids, so localStorage doesn't accumulate cruft and a new task's position is
  // remembered before it's ever dragged. Converges in one pass — the next render finds them equal.
  const orderSig = list.map((t) => t.id).join("\n");
  useEffect(() => {
    // Bail until the WS `hello` has populated threads: on first mount `list` is empty, so persisting
    // its canonical form would wipe the saved order to [] — and once threads arrive every id would
    // then look 'fresh' and clobber the manual order with recency. An empty active set also genuinely
    // means "nothing to order" (all tasks closed/hidden), so skipping it never drops a real reorder;
    // stale ids in the saved order are pruned harmlessly at render by orderByManual.
    if (!dndEnabled || !orderSig) return;
    const canonical = orderSig.split("\n");
    const same = canonical.length === taskOrder.length && canonical.every((id, i) => id === taskOrder[i]);
    if (!same) setTaskOrder(canonical);
  }, [dndEnabled, orderSig, taskOrder, setTaskOrder]);

  const sensors = useSensors(
    // A small activation distance so a click on the grip still selects nearby UI / opens the card,
    // and only a deliberate drag starts a reorder.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeThread = activeId ? threads[activeId] : undefined;

  const onDragStart = (e: DragStartEvent) => setActiveId(String(e.active.id));
  const onDragEnd = (e: DragEndEvent) => {
    setActiveId(null);
    const { active: a, over } = e;
    if (!over || a.id === over.id) return;
    // Map the dragged/target ids to their positions in the FULL ordered list (not the visible page)
    // so reordering on page 2 lands correctly; arrayMove then yields the new full order to persist.
    const ids = list.map((t) => t.id);
    const from = ids.indexOf(String(a.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    setTaskOrder(arrayMove(ids, from, to));
  };

  const lanes = (
    <div className="lanes">
      {pageItems.map((t) => (dndEnabled ? <SortableCard key={t.id} thread={t} /> : <Card key={t.id} thread={t} />))}
    </div>
  );

  return (
    <main className="board">
      <div className="board-head">
        <h2>Tasks</h2>
        <div className="board-head-right">
          <span className="faint mono" style={{ fontSize: 11 }}>
            {list.length} total
            {hiddenCompleted > 0 ? ` · ${hiddenCompleted} completed hidden` : ""}
          </span>
          {/* Always available — under DnD a pick re-seeds the manual order (applySort) instead of being hidden. */}
          <SortMenu onPick={applySort} />
        </div>
      </div>
      {list.length === 0 ? (
        <div className="empty">
          <div className="big">No tasks running</div>
          <div className="faint">Dispatch one from the Director on the left.</div>
        </div>
      ) : (
        <>
          {dndEnabled ? (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setActiveId(null)}>
              <SortableContext items={pageItems.map((t) => t.id)} strategy={rectSortingStrategy}>
                {lanes}
              </SortableContext>
              <DragOverlay>{activeThread ? <div className="card-drag-overlay"><Card thread={activeThread} draggableCard /></div> : null}</DragOverlay>
            </DndContext>
          ) : (
            lanes
          )}
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

/** The board sort control: a quiet trigger in the header that opens a listbox of sort options, reusing
 *  the .ws-menu/.ws-opt pattern (downward variant). Self-contained — owns its open state and closes on
 *  an outside click or Escape. Picking an option hands it to `onPick`, which persists the choice and,
 *  under drag-and-drop, re-seeds the manual order so the board reflows (see Board.applySort). */
function SortMenu({ onPick }: { onPick: (sort: TaskSort) => void }) {
  const taskSort = useStore((s) => s.taskSort);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const current = SORT_OPTIONS.find((o) => o.value === taskSort) ?? SORT_OPTIONS[0]!;
  return (
    <div className="sort-menu" ref={ref}>
      <button
        className={"btn sm sort-trigger" + (open ? " open" : "")}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Sort tasks"
      >
        <SortIcon />
        <span className="sort-prefix">Sort:</span>
        <span className="sort-label">{current.label}</span>
        <span className="sort-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open ? (
        <ul className="ws-menu sort-list" role="listbox" aria-label="Sort tasks by">
          {SORT_OPTIONS.map((o) => (
            <li
              key={o.value}
              role="option"
              aria-selected={o.value === taskSort}
              className={"ws-opt" + (o.value === taskSort ? " hi" : "")}
              onClick={() => {
                onPick(o.value);
                setOpen(false);
              }}
            >
              <span className="nm">{o.label}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** A compact descending-bars glyph — the conventional "sort" affordance, drawn in currentColor. */
function SortIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 4v16M6 4l-3 3M6 4l3 3" />
      <path d="M13 5h7M13 10h5M13 15h3" />
    </svg>
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
// The drag props (innerRef/style/dragging/draggableCard/dragProps) are absent on a non-draggable
// board, so the OFF path renders byte-for-byte as before and memo still short-circuits on an
// unchanged thread.
const Card = memo(function Card({
  thread,
  innerRef,
  style,
  dragging,
  draggableCard,
  dragProps,
}: {
  thread: Thread;
  innerRef?: (el: HTMLElement | null) => void;
  style?: CSSProperties;
  dragging?: boolean;
  draggableCard?: boolean;
  dragProps?: HTMLAttributes<HTMLDivElement>;
}) {
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
  // The project chatroom for this task's repo (≥2 tasks ever collaborated here, possibly in the past
  // since rooms persist) — drives the card's Chatroom chip. Repo-keyed, so a fresh task on a repo with
  // prior history shows it too; hidden on repos that never had a collaboration.
  const chatRoom = useStore((s) => s.chatRooms.find((r) => r.room === repoRoom(thread.workspace) && r.threadIds.length >= 2));
  const openOffice = useStore((s) => s.openOffice);

  const impl = latestRun(threadRuns, "implementor");
  // Full shows the agent's latest streaming line; compact drops it so the card is just title + pips + state.
  const activity = verbosity === "full" ? draftText || lastText || thread.brief.split("\n")[0] || "—" : null;

  const live = threadRunning(thread.state);
  // Token freeze: this task gave up only because every account was rate-limited and is now parked in
  // review waiting on the supervisor to auto-resume it. Detection mirrors the server's own scan (the
  // CAP_PARK marker on the error), so a plain human-review park never trips it. Only when frozen do we
  // read the accounts' soonest reset — and we select that derived primitive (not the accounts array)
  // so a non-frozen card never re-renders on an accounts broadcast, and a frozen one re-renders only
  // when the reset time itself changes.
  const capParked = isCapParked(thread);
  const frozenReset = useStore((s) => (capParked ? soonestReset(s.accounts) : null));

  // The ✕ soft-closes a parked task (review / paused / done / failed / cancelled) — it moves to the
  // Closed list below, restorable, rather than being deleted outright. A running task shows no ✕, so
  // active work is never discarded (cancel it from the detail panel first). stopPropagation keeps the
  // click from also opening the detail panel of a card that's leaving the board.
  const canClose = isClosable(thread.state);

  return (
    <div
      ref={innerRef}
      className={"card" + (selected ? " sel" : "") + (live ? " live" : "") + (capParked ? " frozen" : "") + (dragging ? " dragging" : "") + (draggableCard ? " draggable" : "")}
      style={{ "--state-color": stateColor(thread.state), ...style } as CSSProperties}
      onClick={() => select(thread.id)}
      {...dragProps}
    >
      {draggableCard ? (
        <span className="card-grip" aria-hidden="true" title="Drag anywhere on the card to reorder">
          <GripIcon />
        </span>
      ) : null}
      {canClose ? (
        <button
          className="card-dismiss"
          title="Close — move to the Closed list (restorable)"
          aria-label="Close task"
          // Swallow the pointerdown so pressing ✕ on a draggable card never arms a drag — it stays a click.
          onPointerDown={(e) => e.stopPropagation()}
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
          {/* Token-freeze pill: shown only while the task is cap-parked, so it reads as an informational
              "rate-limited, resuming itself" note next to the review badge — not an alarm. The reset clock
              is appended when known; otherwise just the ⏳ rate-limited label (never an empty/Invalid time). */}
          {capParked ? (
            <span
              className="badge frozen"
              title={thread.error ?? "Every account was rate-limited — this task auto-resumes when one frees up."}
            >
              ⏳ rate-limited{frozenReset ? ` · resumes ${clockHM(frozenReset)}` : ""}
            </span>
          ) : null}
          {impl?.effort ? (
            <span className={"effort-badge eff-" + impl.effort} title="Implementor effort (planner-chosen)">
              {impl.effort}
            </span>
          ) : null}
        </span>
        <span className="foot-right">
          {chatRoom ? (
            <button
              className="card-chatroom"
              title={`This repo's chatroom — ${chatRoom.threadIds.length} task(s) have collaborated here`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                openOffice(chatRoom.room);
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            </button>
          ) : null}
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

/** A board Card made sortable. dnd-kit's transform/transition drive the live shuffle; the active slot
 *  dims to a placeholder (the lifted clone lives in the board's DragOverlay). The WHOLE card is the
 *  drag activator (the grip is just a discoverability affordance) — the PointerSensor's 6px activation
 *  distance keeps a plain click selecting/opening the card, and only a deliberate drag reorders. Inner
 *  controls (the ✕) stopPropagation, so they never get caught as a drag-vs-click. */
function SortableCard({ thread }: { thread: Thread }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: thread.id });
  const style: CSSProperties = { transform: CSS.Transform.toString(transform), transition };
  return (
    <Card
      thread={thread}
      innerRef={setNodeRef}
      style={style}
      dragging={isDragging}
      draggableCard
      dragProps={{ ...attributes, ...listeners }}
    />
  );
}

/** A quiet 6-dot gripper — the universal "drag me" affordance, drawn in currentColor so the card's
 *  hover/active grip colors flow straight through. */
function GripIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
      <circle cx="4" cy="2.5" r="1.1" />
      <circle cx="8" cy="2.5" r="1.1" />
      <circle cx="4" cy="6" r="1.1" />
      <circle cx="8" cy="6" r="1.1" />
      <circle cx="4" cy="9.5" r="1.1" />
      <circle cx="8" cy="9.5" r="1.1" />
    </svg>
  );
}
