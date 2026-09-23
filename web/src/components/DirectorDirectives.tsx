import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useStore } from "../store.js";
import { MAX_DIRECTOR_DIRECTIVES_CHARS } from "../types.js";

const PLACEHOLDER = [
  "Always prefer Claude models. OpenAI is our backup subscription.",
  "Use low effort unless a task is clearly hard.",
  "Treat every codebase as enterprise, NASA-grade work.",
].join("\n");

/** The owner's standing directives for the Director: a pill in the rail header that opens an editor.
 *  The text is appended to the Director's system prompt server-side and applies from its next turn. */
export function DirectorDirectives() {
  const directives = useStore((s) => s.settings.directorDirectives);
  const directorName = useStore((s) => s.settings.directorName);
  const [open, setOpen] = useState(false);
  const set = directives.trim().length > 0;

  return (
    <>
      <button
        type="button"
        className={"agent-toggle directives-toggle" + (set ? " on" : " off")}
        style={{ "--role": "var(--role-director)" } as CSSProperties}
        aria-haspopup="dialog"
        aria-label={set ? "Edit standing directives" : "Add standing directives"}
        title={set ? `Standing directives for ${directorName}:\n\n${preview(directives)}` : `Give ${directorName} standing directives — a personal addition to its system prompt`}
        onClick={() => setOpen(true)}
      >
        <DirectivesIcon />
        <span className="directives-label">Directives</span>
      </button>
      {open ? <DirectivesDialog initial={directives} directorName={directorName} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function DirectivesDialog({ initial, directorName, onClose }: { initial: string; directorName: string; onClose: () => void }) {
  const save = useStore((s) => s.setDirectorDirectives);
  const [text, setText] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const dirty = text.trim() !== initial.trim();

  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
  }, []);

  const commit = (next: string) => {
    if (!save(next.trim())) {
      setError("Not saved — the console is reconnecting. Your text is still here; try again in a moment.");
      return;
    }
    onClose();
  };
  // A stray click on the backdrop must never throw away a paragraph of instructions.
  const dismiss = () => { if (!dirty) onClose(); };

  return (
    <div className="scrim" onMouseDown={dismiss}>
      <div
        className="modal directives-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="directives-title"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") dismiss();
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && dirty) commit(text);
        }}
      >
        <div className="m-head">
          <div className="q-context">Standing directives</div>
          <h3 id="directives-title">What should {directorName} always keep in mind?</h3>
        </div>
        <div className="m-body">
          <p className="directives-hint">
            Added to {directorName}'s system prompt from its next message on. It applies them to its replies and
            dispatches and passes them on in every brief. An explicit effort or exact model is pinned on the task.
            A soft preference, like a backup provider, reaches the agents as an instruction only.
          </p>
          <textarea
            ref={areaRef}
            className="directives-input"
            value={text}
            maxLength={MAX_DIRECTOR_DIRECTIVES_CHARS}
            placeholder={PLACEHOLDER}
            spellCheck
            onChange={(e) => { setText(e.target.value); setError(null); }}
          />
          <div className="directives-meta">
            <span className={"directives-count mono" + (text.length >= MAX_DIRECTOR_DIRECTIVES_CHARS ? " full" : "")}>
              {text.length.toLocaleString()} / {MAX_DIRECTOR_DIRECTIVES_CHARS.toLocaleString()}
            </span>
            {error ? <span className="directives-error" role="alert">{error}</span> : null}
          </div>
          <div className="m-foot">
            {text ? (
              <button type="button" className="btn ghost directives-clear" onClick={() => { setText(""); areaRef.current?.focus(); }}>
                Clear
              </button>
            ) : null}
            <button type="button" className="btn ghost" onClick={onClose}>
              {dirty ? "Discard" : "Close"}
            </button>
            <button type="button" className="btn primary" disabled={!dirty} onClick={() => commit(text)} title="Save (Ctrl+Enter)">
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function preview(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 280 ? `${trimmed.slice(0, 280)}…` : trimmed;
}

function DirectivesIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 12h-5" />
      <path d="M15 8h-5" />
      <path d="M19 17V5a2 2 0 0 0-2-2H4" />
      <path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3" />
    </svg>
  );
}
