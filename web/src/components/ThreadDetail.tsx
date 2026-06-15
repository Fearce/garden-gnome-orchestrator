import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useStore } from "../store.js";
import type { FeedItem, Role } from "../types.js";
import { clock, roleColor, sevColor, stateColor, stateLabel } from "../lib/format.js";
import { AttachButton, ComposerThumbs, useAttachments } from "../lib/attachments.js";

const roleVar = (role: Role): CSSProperties => ({ "--role": roleColor(role) } as CSSProperties);

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

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [feed.length, draft]);

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

  return (
    <section className="detail">
      <div className="detail-head">
        <div className="top">
          <div>
            <h2>{thread.title}</h2>
            <div className="meta">{thread.workspace}</div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span className="badge" style={{ "--state-color": stateColor(thread.state) } as CSSProperties}>
              {stateLabel(thread.state)}
            </span>
            <button className="btn ghost sm" onClick={() => select(null)}>
              ✕
            </button>
          </div>
        </div>
        <div className="meta">
          {impl ? `${impl.model}${impl.account ? ` · ${impl.account}` : ""} · ${impl.state}` : "—"}
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

      <div className="feed" ref={scrollRef}>
        {feed.length === 0 && !draft && (
          <div className="faint" style={{ fontSize: 13 }}>
            Planner and researcher are warming up. Their findings and the implementor's work will stream here.
          </div>
        )}
        {feed.map((f, i) => (
          <FeedRow key={`${f.kind}:${f.at}:${i}`} item={f} />
        ))}
        {draft && (
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
