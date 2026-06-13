import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useStore } from "../store.js";
import type { DirectorItem } from "../types.js";

export function Director() {
  const items = useStore((s) => s.director);
  const draft = useStore((s) => s.directorDraft);
  const busy = useStore((s) => s.directorBusy);
  const sendPrompt = useStore((s) => s.sendPrompt);
  const [text, setText] = useState("");
  const [ws, setWs] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [items.length, draft]);

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    sendPrompt(t, ws.trim() || undefined);
    setText("");
  };

  return (
    <aside className="rail">
      <div className="rail-head">
        <h2>Director</h2>
        <div className="who">
          <span className="pip active" style={{ "--role": "var(--role-director)" } as CSSProperties}>
            <span className="led" />
          </span>
          <span className="dim mono" style={{ fontSize: 11 }}>
            {busy ? "thinking…" : "sonnet 4.6 · ready"}
          </span>
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

      <div className="composer">
        <textarea
          value={text}
          placeholder="Describe a task…  (⌘/Ctrl+Enter to send)"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="row">
          <input
            className="ws"
            value={ws}
            placeholder="repo path hint (optional)  e.g. C:\sprogbroen"
            onChange={(e) => setWs(e.target.value)}
          />
          <button className="btn primary" onClick={submit} disabled={!text.trim()}>
            Send
          </button>
        </div>
      </div>
    </aside>
  );
}

function DirectorBubble({ item }: { item: DirectorItem }) {
  if (item.kind === "tool") {
    return (
      <div className="tool-chip">
        <span className="k">{item.toolName}</span>
        {item.text ? <span>· {item.text}</span> : null}
      </div>
    );
  }
  return (
    <div className={"msg " + item.kind}>
      <div className="by">{item.kind === "user" ? "you" : "director"}</div>
      <div className="bubble">{item.text}</div>
    </div>
  );
}
