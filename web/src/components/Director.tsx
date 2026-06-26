import { useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import { useStore } from "../store.js";
import { AttachButton, ComposerThumbs, MessageThumbs, useAttachments } from "../lib/attachments.js";
import { FolderPicker } from "./FolderPicker.js";
import { PathInput } from "./PathInput.js";
import { Gnome } from "./Gnome.js";
import type { DirectorItem, OrchestratorSettings, Role } from "../types.js";

// Recently used repo paths, client-only, persisted under one localStorage key (most-recent first).
// Purely a composer convenience — clicking a chip prefills the dispatch workspace.
const RECENT_REPOS_KEY = "orch-recent-repos";
const RECENT_REPOS_MAX = 8;

const loadRecentRepos = (): string[] => {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_REPOS_KEY) || "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};
const writeRecentRepos = (next: string[]): string[] => {
  try {
    localStorage.setItem(RECENT_REPOS_KEY, JSON.stringify(next));
  } catch {
    /* private mode */
  }
  return next;
};
// Promote `path` to the front, de-duped, capped — call when a task is actually dispatched.
const pushRecentRepo = (path: string): string[] => {
  const p = path.trim();
  if (!p) return loadRecentRepos();
  return writeRecentRepos([p, ...loadRecentRepos().filter((x) => x !== p)].slice(0, RECENT_REPOS_MAX));
};
const removeRecentRepo = (path: string): string[] => writeRecentRepos(loadRecentRepos().filter((x) => x !== path));
// Trailing-separator-tolerant basename, cross-platform (handles / and \ paths).
const repoLabel = (p: string): string => p.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || p;

export function Director() {
  const items = useStore((s) => s.director);
  const draft = useStore((s) => s.directorDraft);
  const busy = useStore((s) => s.directorBusy);
  const sendPrompt = useStore((s) => s.sendPrompt);
  const sendDirect = useStore((s) => s.sendDirect);
  const plannerEnabled = useStore((s) => s.settings.plannerEnabled);
  const [text, setText] = useState("");
  const [ws, setWs] = useState("");
  // Skip-director is a per-session mode (ephemeral, default OFF every reload): when on, a message
  // bypasses the Sonnet director and dispatches straight to the pipeline's first active stage.
  const [skip, setSkip] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [recentRepos, setRecentRepos] = useState<string[]>(loadRecentRepos);
  const setDirectorWidth = useStore((s) => s.setDirectorWidth);
  const selectedThreadId = useStore((s) => s.selectedThreadId);
  const att = useAttachments();

  // Selecting a task pre-fills the repo path from that task's workspace. Keyed on the id
  // alone so manual edits and same-task re-selects never re-fire — only a different task wins.
  useEffect(() => {
    if (!selectedThreadId) return;
    const t = useStore.getState().threads[selectedThreadId];
    if (t?.workspace) setWs(t.workspace);
  }, [selectedThreadId]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastSentRef = useRef(""); // last sent prompt, recalled with ↑ when the field is empty

  // Drag the rail's right edge to resize, mirroring the detail panel. Width is clamped so the
  // board (and an open detail panel) always keep room; persisted via the store.
  const startResize = (e: ReactMouseEvent) => {
    e.preventDefault();
    const onMove = (ev: MouseEvent) => {
      const { selectedThreadId, detailWidth } = useStore.getState();
      const reserved = 320 + (selectedThreadId ? detailWidth : 0) + 16;
      const max = Math.min(760, window.innerWidth - reserved);
      setDirectorWidth(Math.min(Math.max(ev.clientX, 280), Math.max(280, max)));
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

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [items.length, draft]);

  // In skip mode the message enters the pipeline at its first active stage — planner if it's on,
  // otherwise the implementor (the researcher only ever runs after the planner, never first).
  const firstStage = plannerEnabled ? "planner" : "implementor";
  const directNeedsWs = skip && !ws.trim();

  const submit = () => {
    const t = text.trim();
    if (!t || directNeedsWs) return;
    lastSentRef.current = t;
    const w = ws.trim();
    if (w) setRecentRepos(pushRecentRepo(w));
    if (skip) sendDirect(t, w || undefined, att.images);
    else sendPrompt(t, w || undefined, att.images);
    setText("");
    att.clear();
  };

  return (
    <>
    <aside className="rail">
      <div className="resize-handle rail-resize" onMouseDown={startResize} title="Drag to resize the director panel" />
      <div className="rail-head">
        <div className="rail-head-row">
          <div className="who">
            <span className="pip active" style={{ "--role": "var(--role-director)" } as CSSProperties}>
              <Gnome role="director" size={28} />
            </span>
            <div className="rail-head-title">
              <h2>Director</h2>
              <span className="dim mono" style={{ fontSize: 11 }}>
                {busy ? "thinking…" : "sonnet 4.6 · ready"}
              </span>
            </div>
          </div>
          <AgentToggles />
        </div>
      </div>

      <div className="transcript" ref={scrollRef}>
        {items.length === 0 && (
          <div className="faint" style={{ fontSize: 13 }}>
            Tell the Director what you want. It pulls your memories, asks anything it needs to avoid steering wrong, then
            dispatches a planned, researched task to an Opus 4.8 implementor.
          </div>
        )}
        {items.map((it) => (
          <DirectorBubble key={it.id} item={it} />
        ))}
        {draft && (
          <div className="msg director draft">
            <div className="by">director</div>
            <div className="bubble">{draft}</div>
          </div>
        )}
      </div>

      <div className={"composer" + (att.dragging ? " dragging" : "") + (skip ? " direct" : "")} {...att.dropHandlers}>
        {recentRepos.length > 1 && (
          <div className="recent-repos" role="group" aria-label="Recent repositories">
            <span className="recent-repos-label mono">repos</span>
            {recentRepos.map((p) => {
              const active = p === ws.trim();
              return (
                <span key={p} className={"repo-chip" + (active ? " on" : "")} title={p}>
                  <button
                    type="button"
                    className="repo-chip-pick"
                    aria-pressed={active}
                    onClick={() => setWs(p)}
                  >
                    {repoLabel(p)}
                  </button>
                  <button
                    type="button"
                    className="repo-chip-x"
                    aria-label={`Remove ${p} from recent repos`}
                    title="Remove from recents"
                    onClick={() => setRecentRepos(removeRecentRepo(p))}
                  >
                    ×
                  </button>
                </span>
              );
            })}
          </div>
        )}
        <div className="composer-mode">
          <button
            type="button"
            className={"mode-toggle" + (skip ? " on" : "")}
            role="switch"
            aria-checked={skip}
            title={
              skip
                ? `Skip-director ON — your message bypasses the director and dispatches straight to the ${firstStage}. Click to send via the director.`
                : "Skip-director OFF — your message goes to the director, which enriches and dispatches. Click to send straight to the pipeline."
            }
            onClick={() => setSkip((v) => !v)}
          >
            <span className="mode-dot" aria-hidden="true" />
            Skip director
          </button>
          {skip && (
            <span className="mode-hint mono" title={`The first active pipeline stage is the ${firstStage}.`}>
              direct → {firstStage}
            </span>
          )}
        </div>
        <textarea
          value={text}
          placeholder={
            skip
              ? `Direct to ${firstStage} — set the repo path below.  (⌘/Ctrl+Enter to send)`
              : "Describe a task…  (paste or drop images · ⌘/Ctrl+Enter to send)"
          }
          onChange={(e) => setText(e.target.value)}
          onPaste={att.onPaste}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              submit();
            } else if (e.key === "ArrowUp" && !text && lastSentRef.current) {
              e.preventDefault();
              setText(lastSentRef.current);
            }
          }}
        />
        <ComposerThumbs images={att.images} onRemove={att.remove} />
        <div className="row">
          <AttachButton onPick={att.addFiles} />
          <PathInput
            className="ws"
            value={ws}
            onChange={setWs}
            placeholder="exact repo path (optional — used as-is)  e.g. /Users/you/project"
            title="If set, this exact path is the dispatch workspace — the director uses it verbatim instead of resolving a path itself. Leave blank to let the director find the repo from your description."
          />
          <button
            className="btn ghost sm attach-btn"
            type="button"
            title="Browse for a folder"
            aria-label="Browse for a folder"
            onClick={() => setPickerOpen(true)}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
            </svg>
          </button>
          <button
            className="btn primary"
            onClick={submit}
            disabled={!text.trim() || directNeedsWs}
            title={directNeedsWs ? "Skip-director needs a repo path — there's no director to resolve one." : undefined}
          >
            Send
          </button>
        </div>
      </div>
    </aside>
    {pickerOpen && (
      <FolderPicker initialPath={ws} onSelect={setWs} onClose={() => setPickerOpen(false)} />
    )}
    </>
  );
}

/** The per-task pipeline gates, in the Director header where tasks are composed/dispatched. Each
 *  gates a stage server-side (planner/researcher/QA) — flip them before sending to shape the next task. */
function AgentToggles() {
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const toggle = (key: keyof OrchestratorSettings, on: boolean) =>
    setSettings({ [key]: !on } as Partial<OrchestratorSettings>);

  const items: { key: keyof OrchestratorSettings; role: Role; label: string; onTitle: string; offTitle: string }[] = [
    {
      key: "plannerEnabled",
      role: "planner",
      label: "Plan",
      onTitle: "Planner ON — click to skip planning and dispatch straight to the implementor",
      offTitle: "Planner OFF — tasks skip planning and go straight to the implementor. Click to re-enable.",
    },
    {
      key: "researcherEnabled",
      role: "researcher",
      label: "Research",
      onTitle: "Researcher ON — click to never run the research step",
      offTitle: "Researcher OFF — the research step is skipped even if the planner asks for it. Click to re-enable.",
    },
    {
      key: "qaEnabled",
      role: "qa",
      label: "QA",
      onTitle: "QA ON — click to skip the QA review loop (implementor output becomes final)",
      offTitle: "QA OFF — the implementor's output is final, with no QA review loop. Click to re-enable.",
    },
  ];

  return (
    <div className="agent-toggles" role="group" aria-label="Pipeline agents">
      {items.map((it) => {
        const on = !!settings[it.key];
        return (
          <button
            key={it.key}
            className={"agent-toggle" + (on ? " on" : " off")}
            style={{ "--role": `var(--role-${it.role})` } as CSSProperties}
            aria-pressed={on}
            title={on ? it.onTitle : it.offTitle}
            onClick={() => toggle(it.key, on)}
          >
            <span className="agent-dot" aria-hidden="true" />
            {it.label}
          </button>
        );
      })}
    </div>
  );
}

function DirectorBubble({ item }: { item: DirectorItem }) {
  if (item.kind === "tool") {
    return (
      <div className="tool-chip" title={item.toolName + (item.text ? ` · ${item.text}` : "")}>
        <span className="k">{item.toolName}</span>
        {item.text ? <span className="arg">· {item.text}</span> : null}
      </div>
    );
  }
  return (
    <div className={"msg " + item.kind}>
      <div className="by">{item.kind === "user" ? "you" : "director"}</div>
      <div className="bubble">
        {item.text}
        <MessageThumbs refs={item.attachments} />
      </div>
    </div>
  );
}
