import { useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import { useStore } from "../store.js";
import { AttachButton, ComposerThumbs, MessageThumbs, useAttachments } from "../lib/attachments.js";
import type { DirectorItem } from "../types.js";

export function Director() {
  const items = useStore((s) => s.director);
  const draft = useStore((s) => s.directorDraft);
  const busy = useStore((s) => s.directorBusy);
  const sendPrompt = useStore((s) => s.sendPrompt);
  const [text, setText] = useState("");
  const [ws, setWs] = useState("");
  const setDirectorWidth = useStore((s) => s.setDirectorWidth);
  const att = useAttachments();
  const scrollRef = useRef<HTMLDivElement>(null);

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

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    sendPrompt(t, ws.trim() || undefined, att.images);
    setText("");
    att.clear();
  };

  return (
    <aside className="rail">
      <div className="resize-handle rail-resize" onMouseDown={startResize} title="Drag to resize the director panel" />
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

      <div className={"composer" + (att.dragging ? " dragging" : "")} {...att.dropHandlers}>
        <textarea
          value={text}
          placeholder="Describe a task…  (paste or drop images · ⌘/Ctrl+Enter to send)"
          onChange={(e) => setText(e.target.value)}
          onPaste={att.onPaste}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
        />
        <ComposerThumbs images={att.images} onRemove={att.remove} />
        <div className="row">
          <AttachButton onPick={att.addFiles} />
          <input
            className="ws"
            value={ws}
            placeholder="repo path hint (optional)  e.g. C:\example"
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
