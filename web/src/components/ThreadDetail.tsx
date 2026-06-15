import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import { useStore } from "../store.js";
import type { AgentRun, FeedItem, Role } from "../types.js";
import { clock, roleColor, runActive, sevColor, stateColor, stateLabel, threadRunning } from "../lib/format.js";
import { Elapsed } from "../lib/timing.js";
import { AttachButton, ComposerThumbs, useAttachments } from "../lib/attachments.js";

function latestRunOf(runs: AgentRun[], role: Role): AgentRun | undefined {
  return runs.filter((r) => r.role === role).sort((a, b) => b.startedAt - a.startedAt)[0];
}

const roleVar = (role: Role): CSSProperties => ({ "--role": roleColor(role) } as CSSProperties);

const ROLE_ORDER: Role[] = ["planner", "researcher", "implementor", "qa"];

/** Which agent a feed row belongs to, for the per-agent filter (tool_result resolves via its run). */
function itemRoleOf(f: FeedItem, runRole: Record<string, Role>): Role | null {
  if (f.kind === "text" || f.kind === "tool") return f.role;
  if (f.kind === "tool_result") return runRole[f.runId] ?? null;
  if (f.kind === "finding") return f.finding.fromRole ?? null;
  return null;
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
  const select = useStore((s) => s.select);
  const approve = useStore((s) => s.approve);
  const loadChanges = useStore((s) => s.loadChanges);
  const setDetailWidth = useStore((s) => s.setDetailWidth);
  const pendingPlan = useStore((s) => (s.selectedThreadId ? s.pendingPlans[s.selectedThreadId] : undefined));
  const changes = useStore((s) => (s.selectedThreadId ? s.threadChanges[s.selectedThreadId] : undefined));
  const [msg, setMsg] = useState("");
  const [showChanges, setShowChanges] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [feedback, setFeedback] = useState("");
  const att = useAttachments();
  const scrollRef = useRef<HTMLDivElement>(null);

  const thread = id ? threads[id] : undefined;
  const feed = id ? feeds[id] ?? [] : [];
  const draft = id ? drafts[id] : undefined;

  const [roleFilter, setRoleFilter] = useState<Role | "all">("all");
  const [showTools, setShowTools] = useState(true);
  const stickRef = useRef(true);

  const runRole = useMemo(() => {
    const m: Record<string, Role> = {};
    for (const r of Object.values(runs)) if (r.threadId === id) m[r.id] = r.role;
    return m;
  }, [runs, id]);

  const counts = useMemo(() => {
    const c: Partial<Record<Role, number>> = {};
    for (const f of feed) {
      const r = itemRoleOf(f, runRole);
      if (r) c[r] = (c[r] ?? 0) + 1;
    }
    return c;
  }, [feed, runRole]);

  const activeRoles = useMemo(() => ROLE_ORDER.filter((r) => (counts[r] ?? 0) > 0), [counts]);

  const visible = useMemo(
    () =>
      feed.filter((f) => {
        if (!showTools && (f.kind === "tool" || f.kind === "tool_result")) return false;
        if (roleFilter === "all") return true;
        return itemRoleOf(f, runRole) === roleFilter;
      }),
    [feed, roleFilter, showTools, runRole],
  );

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

  const threadRuns = Object.values(runs).filter((r) => r.threadId === id);
  const impl = threadRuns.filter((r) => r.role === "implementor").sort((a, b) => b.startedAt - a.startedAt)[0];
  const totalCost = threadRuns.reduce((a, r) => a + (r.costUsd ?? 0), 0);

  const isLive = thread.state === "implementing";
  const isPaused = thread.state === "paused" || thread.state === "review";
  const terminal = thread.state === "done" || thread.state === "cancelled" || thread.state === "failed";

  const doInject = (mode: "append" | "interrupt") => {
    const t = msg.trim();
    if (!t) return;
    inject(id, t, mode, att.images);
    setMsg("");
    att.clear();
  };

  const onFeedScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
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
            <span className="badge" style={{ "--state-color": stateColor(thread.state) } as CSSProperties}>
              {stateLabel(thread.state)}
            </span>
            <button className="btn ghost sm" onClick={() => select(null)}>
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
        <div className="detail-controls">
          {isLive && (
            <button className="btn ghost sm" onClick={() => interrupt(id)}>
              ⏸ Interrupt
            </button>
          )}
          {isPaused && (
            <button className="btn primary sm" onClick={() => resume(id)}>
              ▶ Resume
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

      {feed.length > 0 && (
        <div className="feed-filter">
          <button className={"fchip" + (roleFilter === "all" ? " on" : "")} onClick={() => setRoleFilter("all")}>
            all <span className="n">{feed.length}</span>
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
                {role} <span className="n">{counts[role] ?? 0}</span>
                {r ? <Elapsed className="fchip-time" startMs={r.startedAt} endMs={r.endedAt} running={runActive(r.state)} /> : null}
              </button>
            );
          })}
          <button
            className={"fchip tools-toggle" + (showTools ? "" : " off")}
            onClick={() => setShowTools((v) => !v)}
            title={showTools ? "Hide tool calls — show just the prose/findings" : "Show tool calls"}
          >
            ⛏ tools
          </button>
        </div>
      )}

      <div className="feed" ref={scrollRef} onScroll={onFeedScroll}>
        {visible.length === 0 && !draft && (
          <div className="faint" style={{ fontSize: 13 }}>
            {feed.length === 0
              ? "Planner and researcher are warming up. Their findings and the implementor's work will stream here."
              : roleFilter === "all"
                ? "Nothing to show."
                : `No ${roleFilter} output${showTools ? "" : " (tool calls hidden)"} yet.`}
          </div>
        )}
        {visible.map((f, i) => (
          <FeedRow key={`${f.kind}:${f.at}:${i}`} item={f} />
        ))}
        {draft && (roleFilter === "all" || draft.role === roleFilter) && (
          <div className="fi draft" style={roleVar(draft.role)}>
            <div className="head">
              <span className="role-tag" style={{ color: roleColor(draft.role) }}>
                {draft.role}
              </span>
            </div>
            <div className="body">{draft.text}</div>
          </div>
        )}
      </div>

      <div className={"inject-bar" + (att.dragging ? " dragging" : "")} {...att.dropHandlers}>
        <textarea
          value={msg}
          placeholder="Feed new information to the implementor…  (paste/drop images · ⌘/Ctrl+Enter = inject)"
          onChange={(e) => setMsg(e.target.value)}
          onPaste={att.onPaste}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              doInject("append");
            }
          }}
        />
        <ComposerThumbs images={att.images} onRemove={att.remove} />
        <div className="row">
          <AttachButton onPick={att.addFiles} />
          <button className="btn primary sm" onClick={() => doInject("append")} disabled={!msg.trim()}>
            Inject
          </button>
          <button className="btn ghost sm" onClick={() => doInject("interrupt")} disabled={!msg.trim()}>
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

function FeedRow({ item }: { item: FeedItem }) {
  switch (item.kind) {
    case "text":
      return (
        <div className="fi text" style={roleVar(item.role)}>
          <div className="head">
            <span className="role-tag" style={{ color: roleColor(item.role) }}>
              {item.role}
            </span>
            <span className="ts">{clock(item.at)}</span>
          </div>
          <div className="body">{item.text}</div>
        </div>
      );
    case "tool":
      return (
        <div className="fi tool">
          <div className="head">
            <span className="role-tag dim">{item.role}</span>
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
            <span className="role-tag dim">{item.finding.fromRole}</span>
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
        </div>
      );
    default:
      return null;
  }
}
