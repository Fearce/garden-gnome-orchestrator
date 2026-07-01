import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import { useStore } from "../store.js";
import type { AgentRun, FeedItem, Role } from "../types.js";
import { agentName, repoRoom } from "../types.js";
import { clock, FROZEN_CONTROL_TOOLTIP, isCapParked, isDoneable, isTerminal, roleColor, runActive, sevColor, stateColor, stateLabel, threadRunning } from "../lib/format.js";
import { Elapsed } from "../lib/timing.js";
import { AttachButton, ComposerThumbs, MessageThumbs, useAttachments } from "../lib/attachments.js";
import { Gnome } from "./Gnome.js";
import { Deliverables } from "./Deliverables.js";
import { Markdown } from "./Markdown.js";

function latestRunOf(runs: AgentRun[], role: Role): AgentRun | undefined {
  return runs.filter((r) => r.role === role).sort((a, b) => b.startedAt - a.startedAt)[0];
}

const roleVar = (role: Role): CSSProperties => ({ "--role": roleColor(role) } as CSSProperties);

function RoleLabel({ role, name }: { role: Role; name?: string }) {
  return (
    <>
      <span className="role-word">{role}</span>
      {name ? <span className="role-name">({name})</span> : null}
    </>
  );
}

const ROLE_ORDER: Role[] = ["planner", "researcher", "implementor", "qa"];

// Filter-chip order. Director is first so the DIRECTOR chip renders right after ALL (before
// PLANNER). It's deliberately absent from ROLE_ORDER, which drives the agent pipelinePath —
// the director isn't an agent run, just the brief + injected steering.
const FILTER_ORDER: Role[] = ["director", "planner", "researcher", "implementor", "qa"];

// Only the most recent N feed rows are rendered; older ones load in batches as you scroll up.
// A long task can accumulate thousands of tool calls — rendering them all made every keystroke
// in the inject bar reconcile the whole list, which is the lag this caps.
const RENDER_WINDOW = 120;

/** The actual agent path taken, in first-run order — planner, then whichever of researcher/
 *  implementor/QA actually ran. Reflects the agent-routed pipeline (the researcher may be absent;
 *  a QA→implementor bounce still reads planner → implementor → qa since first occurrences order it). */
function pipelinePath(runs: AgentRun[]): Role[] {
  const seen: Role[] = [];
  for (const r of [...runs].sort((a, b) => a.startedAt - b.startedAt)) {
    if (ROLE_ORDER.includes(r.role) && !seen.includes(r.role)) seen.push(r.role);
  }
  return seen;
}

/** Which agent a feed row belongs to, for the per-agent filter (tool_result resolves via its run). */
function itemRoleOf(f: FeedItem, runRole: Record<string, Role>): Role | null {
  if (f.kind === "text" || f.kind === "tool") return f.role;
  if (f.kind === "tool_result") return runRole[f.runId] ?? null;
  if (f.kind === "finding") return f.finding.fromRole ?? null;
  if (f.kind === "system") return f.role ?? null;
  return null;
}

/** Stable, position-independent key for a feed row — required so the rendered window can grow
 *  (older rows load on scroll-up) without React remounting everything and losing scroll position. */
function feedKey(f: FeedItem): string {
  if (f.kind === "finding") return "find:" + f.finding.id;
  if (f.kind === "tool_result") return "tres:" + (f.messageId ?? f.id);
  return f.kind + ":" + (f.id ?? f.at);
}

function summarize(input: unknown): string {
  try {
    const s = JSON.stringify(input);
    return s && s.length > 140 ? s.slice(0, 140) + "…" : s ?? "";
  } catch {
    return "";
  }
}

export function ThreadDetail() {
  const id = useStore((s) => s.selectedThreadId);
  const threads = useStore((s) => s.threads);
  const runs = useStore((s) => s.runs);
  const feeds = useStore((s) => s.threadFeeds);
  const drafts = useStore((s) => s.threadDrafts);
  const inject = useStore((s) => s.inject);
  const interrupt = useStore((s) => s.interrupt);
  const resume = useStore((s) => s.resume);
  const cancel = useStore((s) => s.cancel);
  const retry = useStore((s) => s.retry);
  const markDone = useStore((s) => s.markDone);
  const select = useStore((s) => s.select);
  const approve = useStore((s) => s.approve);
  const loadChanges = useStore((s) => s.loadChanges);
  const openOffice = useStore((s) => s.openOffice);
  const nameOverrides = useStore((s) => s.nameOverrides);
  // The project chatroom for THIS task's repo, if one exists (≥2 tasks ever collaborated here —
  // possibly in a PAST task, since the room persists). Repo-keyed so a fresh task on a repo with
  // prior history also gets the button to read the old chatter; invisible on repos that never collaborated.
  const chatRoom = useStore((s) => {
    const t = s.selectedThreadId ? s.threads[s.selectedThreadId] : undefined;
    return t ? s.chatRooms.find((r) => r.room === repoRoom(t.workspace) && r.threadIds.length >= 2) : undefined;
  });
  const setDetailWidth = useStore((s) => s.setDetailWidth);
  const pendingPlan = useStore((s) => (s.selectedThreadId ? s.pendingPlans[s.selectedThreadId] : undefined));
  const changes = useStore((s) => (s.selectedThreadId ? s.threadChanges[s.selectedThreadId] : undefined));
  const [msg, setMsg] = useState("");
  const [showChanges, setShowChanges] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [feedback, setFeedback] = useState("");
  const att = useAttachments();
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastSentRef = useRef(""); // last injected message, recalled with ↑ when the field is empty

  const thread = id ? threads[id] : undefined;
  const feed = id ? feeds[id] ?? [] : [];
  const draft = id ? drafts[id] : undefined;

  // Deliverables (findings tagged kind 'deliverable') render in their own section, not the feed —
  // so split them out here: `deliverables` feeds the section, `feedItems` is the feed minus them.
  const deliverables = useMemo(
    () =>
      feed
        .filter((f): f is Extract<FeedItem, { kind: "finding" }> => f.kind === "finding" && f.finding.kind === "deliverable")
        .map((f) => f.finding),
    [feed],
  );
  const feedItems = useMemo(() => feed.filter((f) => !(f.kind === "finding" && f.finding.kind === "deliverable")), [feed]);

  const [roleFilter, setRoleFilter] = useState<Role | "all">("all");
  // Persisted globally: the detail panel remounts per task (key={selected}), so without this the
  // tools toggle would reset to "shown" every time you switch tasks.
  const [showTools, setShowToolsState] = useState(() => {
    try {
      return localStorage.getItem("orch-show-tools") !== "0";
    } catch {
      return true;
    }
  });
  const setShowTools = (v: boolean) => {
    try {
      localStorage.setItem("orch-show-tools", v ? "1" : "0");
    } catch {
      /* private mode */
    }
    setShowToolsState(v);
  };
  const stickRef = useRef(true);

  const runRole = useMemo(() => {
    const m: Record<string, Role> = {};
    for (const r of Object.values(runs)) if (r.threadId === id) m[r.id] = r.role;
    return m;
  }, [runs, id]);

  const counts = useMemo(() => {
    const c: Partial<Record<Role, number>> = {};
    for (const f of feedItems) {
      const r = itemRoleOf(f, runRole);
      if (r) c[r] = (c[r] ?? 0) + 1;
    }
    return c;
  }, [feedItems, runRole]);

  const activeRoles = useMemo(() => FILTER_ORDER.filter((r) => (counts[r] ?? 0) > 0), [counts]);

  const visible = useMemo(
    () =>
      feedItems.filter((f) => {
        if (!showTools && (f.kind === "tool" || f.kind === "tool_result")) return false;
        if (roleFilter === "all") return true;
        return itemRoleOf(f, runRole) === roleFilter;
      }),
    [feedItems, roleFilter, showTools, runRole],
  );

  // Render only the tail of the feed; grow the window when the user scrolls toward the top.
  const [renderCount, setRenderCount] = useState(RENDER_WINDOW);
  const growAnchorRef = useRef<{ height: number; top: number } | null>(null);
  // The window always tracks the most recent rows, so live appends stay visible at the bottom.
  const windowed = useMemo(
    () => (visible.length <= renderCount ? visible : visible.slice(visible.length - renderCount)),
    [visible, renderCount],
  );
  const hiddenAbove = visible.length - windowed.length;
  // Reset the window when the viewed subset changes (task switch, filter, tools toggle).
  useEffect(() => setRenderCount(RENDER_WINDOW), [id, roleFilter, showTools]);
  // After older rows are prepended, keep the same content under the viewport (no jump).
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const a = growAnchorRef.current;
    if (el && a) {
      el.scrollTop = el.scrollHeight - a.height + a.top;
      growAnchorRef.current = null;
    }
  }, [renderCount]);

  // Stick to the bottom only when already near it, so reading an earlier agent
  // isn't yanked down when a live agent appends below.
  useEffect(() => {
    if (stickRef.current) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [visible.length, draft]);
  // Switching filter: jump to the start of a specific agent (read top-down), or to live for "all".
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (roleFilter === "all") {
      el.scrollTo({ top: el.scrollHeight });
      stickRef.current = true;
    } else {
      el.scrollTo({ top: 0 });
      stickRef.current = false;
    }
  }, [roleFilter, showTools]);

  if (!id || !thread) return null;

  // Frozen (cap-parked) thread: the pane renders normally so the operator can read the feed, view the
  // Diff, and Cancel — their escape hatch. Only the MUTATING live-controls (the inject box + Inject +
  // Interrupt + Interrupt & inject) get iced and disabled, because the server is already auto-resuming
  // the task the moment an account frees up, so a manual inject/interrupt would fight it. Detection
  // mirrors the server's own cap-park scan (isCapParked), never a plain human-review park.
  const frozen = isCapParked(thread);

  const threadRuns = Object.values(runs).filter((r) => r.threadId === id);
  const impl = threadRuns.filter((r) => r.role === "implementor").sort((a, b) => b.startedAt - a.startedAt)[0];
  const totalCost = threadRuns.reduce((a, r) => a + (r.costUsd ?? 0), 0);
  const path = pipelinePath(threadRuns);
  // A role is "live" only while its latest run is still going; finished roles grey out so the
  // currently-working gnome is the one that stands out (matches the board cards).
  const roleIsLive = (role: Role): boolean => {
    const lr = latestRunOf(threadRuns, role);
    return lr ? runActive(lr.state) : false;
  };

  const isLive = thread.state === "implementing";
  // Resume covers a failed task too: the pipeline is resume-aware and re-runs from the stage that
  // died (reusing saved plan/research and the implementor's prior session) instead of from scratch.
  const isResumable = thread.state === "paused" || thread.state === "review" || thread.state === "failed";
  const terminal = isTerminal(thread.state);
  // Each role in this task is a distinct agent with its own name — resolve per row/chip, never one
  // thread-wide name (that was the "implementor and QA are both Nim" bug).
  const nameFor = useMemo(() => (role: Role) => agentName(nameOverrides, id, role), [nameOverrides, id]);

  const doInject = (mode: "append" | "interrupt" | "queue") => {
    // Frozen tasks accept no manual inject/interrupt — the server auto-resumes them. Guard the handler
    // itself (not just the disabled attribute) so a keyboard ⌘/Ctrl+Enter can't slip an inject through.
    if (frozen) return;
    const t = msg.trim();
    if (!t) return;
    lastSentRef.current = t;
    inject(id, t, mode, att.images);
    setMsg("");
    att.clear();
  };

  const onFeedScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    // Near the top with older rows still unrendered → load the next batch. The anchor (captured
    // here, applied in the layout effect) keeps the current content from jumping under the cursor.
    if (el.scrollTop < 240 && hiddenAbove > 0 && !growAnchorRef.current) {
      growAnchorRef.current = { height: el.scrollHeight, top: el.scrollTop };
      setRenderCount((c) => c + RENDER_WINDOW);
    }
  };

  const startResize = (e: ReactMouseEvent) => {
    e.preventDefault();
    const onMove = (ev: MouseEvent) => {
      const max = Math.max(420, window.innerWidth - 480);
      setDetailWidth(Math.min(Math.max(window.innerWidth - ev.clientX, 360), max));
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.classList.remove("col-resizing");
    };
    document.body.classList.add("col-resizing");
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  return (
    <section className="detail">
      <div className="resize-handle" onMouseDown={startResize} title="Drag to resize this panel" />
      <div className="detail-head">
        <div className="top">
          <div>
            <h2>{thread.title}</h2>
            <div className="meta">{thread.workspace}</div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <Elapsed
              className="task-elapsed"
              startMs={thread.createdAt}
              endMs={thread.updatedAt}
              running={threadRunning(thread.state)}
              title="Time since the task was dispatched"
            />
            {impl?.effort ? (
              <span className={"effort-badge eff-" + impl.effort} title="Implementor effort level (chosen by the planner)">
                {impl.effort}
              </span>
            ) : null}
            <span className="badge" style={{ "--state-color": frozen ? "var(--frost-strong)" : stateColor(thread.state) } as CSSProperties}>
              {stateLabel(thread.state)}
            </span>
            <button className="close-x" onClick={() => select(null)} aria-label="Close" title="Close">
              ✕
            </button>
          </div>
        </div>
        <div className="meta">
          {impl ? `${impl.model}${impl.account ? ` · ${impl.account}` : ""}${impl.effort ? ` · ${impl.effort} effort` : ""} · ${impl.state}` : "—"}
          {impl ? (
            <>
              {" · "}
              <Elapsed startMs={impl.startedAt} endMs={impl.endedAt} running={runActive(impl.state)} title="Implementor run time" />
            </>
          ) : null}
          {totalCost > 0 ? ` · ~$${totalCost.toFixed(2)} equiv (subscription)` : ""}
          {thread.error ? ` · ERROR: ${thread.error}` : ""}
        </div>
        {path.length > 0 && (
          <div className="meta" style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2 }} title="The actual agent path this task took">
            {path.map((role, i) => {
              const live = roleIsLive(role);
              return (
                <span key={role} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  {i > 0 ? <span style={{ opacity: 0.4 }}>→</span> : null}
                  <Gnome role={role} size={28} active={live} />
                  <span style={{ color: live ? roleColor(role) : "var(--text-faint)", textTransform: "capitalize", fontWeight: 600 }}>{role}</span>
                </span>
              );
            })}
          </div>
        )}
        <div className="detail-controls">
          {isLive && (
            <button
              className={"btn ghost sm" + (frozen ? " frozen-ctl" : "")}
              onClick={() => { if (!frozen) interrupt(id); }}
              disabled={frozen}
              title={frozen ? FROZEN_CONTROL_TOOLTIP : undefined}
            >
              ⏸ Interrupt
            </button>
          )}
          {isResumable && (
            <button className="btn primary sm" onClick={() => resume(id)}>
              ▶ Resume
            </button>
          )}
          {thread.state === "cancelled" && (
            <button
              className="btn primary sm"
              onClick={() => retry(id)}
              title="Start this task over from the beginning — re-runs the whole pipeline from the original brief"
            >
              ↻ Retry
            </button>
          )}
          {isDoneable(thread.state) && (
            <button className="btn success sm" onClick={() => markDone(id)} title="Accept this task as finished and mark it done">
              ✓ Mark done
            </button>
          )}
          <button
            className="btn ghost sm"
            onClick={() => {
              setShowChanges(true);
              loadChanges(id);
            }}
          >
            Diff
          </button>
          {chatRoom && (
            <button
              className="btn ghost sm"
              onClick={() => openOffice(chatRoom.room)}
              title={`Open this repo's chatroom — ${chatRoom.threadIds.length} task(s) have collaborated here`}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 5, verticalAlign: "-2px" }}>
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
              Chatroom
            </button>
          )}
          {!terminal && (
            <button className="btn danger sm" onClick={() => cancel(id)}>
              Cancel
            </button>
          )}
        </div>
      </div>
      {thread.state === "awaiting_approval" && (
        <div className="approval">
          <div className="approval-head">⏸ Plan ready — approve to build, or reject with feedback</div>
          <pre className="approval-plan">{pendingPlan ?? "(plan not captured — see the planner output in the feed)"}</pre>
          {rejecting ? (
            <div className="approval-reject">
              <textarea
                value={feedback}
                placeholder="What should change? (sent back as the rejection reason)"
                onChange={(e) => setFeedback(e.target.value)}
              />
              <div className="row">
                <button
                  className="btn danger sm"
                  onClick={() => {
                    approve(id, false, feedback.trim() || undefined);
                    setRejecting(false);
                    setFeedback("");
                  }}
                >
                  Reject plan
                </button>
                <button className="btn ghost sm" onClick={() => setRejecting(false)}>
                  Back
                </button>
              </div>
            </div>
          ) : (
            <div className="row">
              <button className="btn primary sm" onClick={() => approve(id, true)}>
                ✓ Approve &amp; build
              </button>
              <button className="btn ghost sm" onClick={() => setRejecting(true)}>
                Reject…
              </button>
            </div>
          )}
        </div>
      )}

      {feedItems.length > 0 && (
        <div className="feed-filter">
          <button className={"fchip" + (roleFilter === "all" ? " on" : "")} onClick={() => setRoleFilter("all")}>
            all <span className="n">{feedItems.length}</span>
          </button>
          {activeRoles.map((role) => {
            const r = latestRunOf(threadRuns, role);
            return (
              <button
                key={role}
                className={"fchip" + (roleFilter === role ? " on" : "")}
                style={{ "--role": roleColor(role) } as CSSProperties}
                onClick={() => setRoleFilter(role)}
              >
                <Gnome role={role} size={15} />
                <span className="fchip-label">
                  <RoleLabel role={role} name={nameFor(role)} />
                </span>
                <span className="n">{counts[role] ?? 0}</span>
                {r ? <Elapsed className="fchip-time" startMs={r.startedAt} endMs={r.endedAt} running={runActive(r.state)} /> : null}
              </button>
            );
          })}
          <button
            className={"fchip tools-toggle" + (showTools ? "" : " off")}
            onClick={() => setShowTools(!showTools)}
            title={showTools ? "Hide tool calls — show just the prose/findings" : "Show tool calls"}
          >
            ⛏ tools
          </button>
        </div>
      )}

      <Deliverables items={deliverables} />

      <div className="feed" ref={scrollRef} onScroll={onFeedScroll}>
        {visible.length === 0 && !draft && (
          <div className="faint" style={{ fontSize: 13 }}>
            {feedItems.length === 0
              ? "Planner and researcher are warming up. Their findings and the implementor's work will stream here."
              : roleFilter === "all"
                ? "Nothing to show."
                : `No ${roleFilter} output${showTools ? "" : " (tool calls hidden)"} yet.`}
          </div>
        )}
        {hiddenAbove > 0 && (
          <button
            onClick={() => {
              const el = scrollRef.current;
              if (el) growAnchorRef.current = { height: el.scrollHeight, top: el.scrollTop };
              setRenderCount((c) => c + RENDER_WINDOW);
            }}
            style={{
              alignSelf: "center",
              margin: "2px 0 8px",
              padding: "5px 12px",
              background: "transparent",
              border: "1px solid var(--line)",
              borderRadius: 100,
              color: "var(--text-dim)",
              fontSize: 11,
              fontFamily: "var(--font-mono)",
              cursor: "pointer",
            }}
          >
            ↑ {hiddenAbove} earlier {hiddenAbove === 1 ? "entry" : "entries"} — scroll up or click to load
          </button>
        )}
        {windowed.map((f) => (
          <FeedRow key={feedKey(f)} item={f} nameFor={nameFor} />
        ))}
        {draft && (roleFilter === "all" || draft.role === roleFilter) && (
          <div className="fi draft" style={roleVar(draft.role)}>
            <div className="head">
              <Gnome role={draft.role} size={30} />
              <span className="role-tag" style={{ color: roleColor(draft.role) }}>
                <RoleLabel role={draft.role} name={nameFor(draft.role)} />
              </span>
            </div>
            <Markdown className="body" text={draft.text} />
          </div>
        )}
      </div>

      <div
        className={"inject-bar" + (att.dragging ? " dragging" : "") + (frozen ? " frozen" : "")}
        title={frozen ? FROZEN_CONTROL_TOOLTIP : undefined}
        {...(frozen ? {} : att.dropHandlers)}
      >
        {frozen ? <span className="inject-frost" aria-hidden="true" /> : null}
        <textarea
          value={msg}
          placeholder={frozen ? "Frozen — every account is rate-limited; this task auto-resumes on its own." : "Feed new information to the implementor…  (paste/drop images · ⌘/Ctrl+Enter = inject)"}
          onChange={(e) => setMsg(e.target.value)}
          onPaste={att.onPaste}
          disabled={frozen}
          title={frozen ? FROZEN_CONTROL_TOOLTIP : undefined}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              doInject("append");
            } else if (e.key === "ArrowUp" && !msg && lastSentRef.current) {
              e.preventDefault();
              setMsg(lastSentRef.current);
            }
          }}
        />
        <ComposerThumbs images={att.images} onRemove={att.remove} />
        <div className="row">
          <AttachButton onPick={att.addFiles} />
          <button
            className={"btn ghost sm" + (frozen ? " frozen-ctl" : "")}
            onClick={() => doInject("queue")}
            disabled={frozen || !msg.trim()}
            title={frozen ? FROZEN_CONTROL_TOOLTIP : "Queue this for the implementor without interrupting — it picks it up when it finishes its current work, before handing off to QA"}
          >
            Queue
          </button>
          <button
            className={"btn primary sm" + (frozen ? " frozen-ctl" : "")}
            onClick={() => doInject("append")}
            disabled={frozen || !msg.trim()}
            title={frozen ? FROZEN_CONTROL_TOOLTIP : "Send to the implementor now — it uses this on its next step while it keeps working"}
          >
            Inject
          </button>
          <button
            className={"btn ghost sm" + (frozen ? " frozen-ctl" : "")}
            onClick={() => doInject("interrupt")}
            disabled={frozen || !msg.trim()}
            title={frozen ? FROZEN_CONTROL_TOOLTIP : "Stop the implementor now and hand it this immediately"}
          >
            Interrupt &amp; inject
          </button>
          <div style={{ flex: 1 }} />
          <span className="faint mono" style={{ fontSize: 10 }}>
            {id.slice(0, 8)}
          </span>
        </div>
      </div>
      {showChanges && (
        <div className="scrim" onClick={() => setShowChanges(false)}>
          <div className="modal changes" onClick={(e) => e.stopPropagation()}>
            <div className="m-head">
              <h3>Changes · {thread.workspace}</h3>
              <button className="btn ghost sm" onClick={() => setShowChanges(false)}>
                ✕
              </button>
            </div>
            <div className="changes-body">
              {changes ? (
                <>
                  <div className="changes-sec">recent commits</div>
                  <pre>{changes.log}</pre>
                  <div className="changes-sec">uncommitted diff</div>
                  <pre>{changes.diff}</pre>
                </>
              ) : (
                <div className="faint">loading…</div>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

const FeedRow = memo(function FeedRow({ item, nameFor }: { item: FeedItem; nameFor: (role: Role) => string }) {
  switch (item.kind) {
    case "text":
      return (
        <div className="fi text" style={roleVar(item.role)}>
          <div className="head">
            <Gnome role={item.role} size={30} />
            <span className="role-tag" style={{ color: roleColor(item.role) }}>
              <RoleLabel role={item.role} name={nameFor(item.role)} />
            </span>
            <span className="ts">{clock(item.at)}</span>
          </div>
          <Markdown className="body" text={item.text} />
        </div>
      );
    case "tool":
      return (
        <div className="fi tool">
          <div className="head">
            <span className="role-tag dim">
              <RoleLabel role={item.role} name={nameFor(item.role)} />
            </span>
            <span className="ts">{clock(item.at)}</span>
          </div>
          <div className="body">
            ⛏ {item.name} {summarize(item.input)}
          </div>
        </div>
      );
    case "tool_result":
      return (
        <div className={"fi tool_result" + (item.isError ? " err" : "")}>
          <div className="body">↳ {item.preview}</div>
        </div>
      );
    case "finding":
      return (
        <div className="fi finding" style={{ "--sev": sevColor(item.finding.severity) } as CSSProperties}>
          <div className="head">
            <span className="sev-tag">⚑ {item.finding.severity}</span>
            {item.finding.fromRole ? (
              <span className="role-tag dim">
                <RoleLabel role={item.finding.fromRole} name={nameFor(item.finding.fromRole)} />
              </span>
            ) : null}
            <span className="ts">{clock(item.at)}</span>
          </div>
          <div className="body">
            {item.finding.summary}
            {item.finding.detail ? `\n${item.finding.detail}` : ""}
          </div>
        </div>
      );
    case "system":
      return (
        <div className="fi system">
          <div className="body">{item.text}</div>
          <MessageThumbs refs={item.attachments} />
        </div>
      );
    default:
      return null;
  }
});
