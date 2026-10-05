import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

type View = { zoom: number; x: number; y: number };
const FIT: View = { zoom: 1, x: 0, y: 0 };
const clamp = (value: number, limit: number) => Math.max(-limit, Math.min(limit, value));

/** Digital inspection of the existing live feed; no extra socket or camera commands. */
export function CameraViewer({ name, children, age, onClose }: { name: string; children: ReactNode; age: ReactNode; onClose: () => void }) {
  const dialog = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const [view, setView] = useState(FIT);
  const [fullscreen, setFullscreen] = useState(false);
  const close = useRef(onClose);
  close.current = onClose;

  function bounded(next: View): View {
    const box = viewport.current;
    const zoom = Math.max(1, Math.min(8, next.zoom));
    const width = box?.clientWidth ?? 0;
    const height = box?.clientHeight ?? 0;
    const image = box?.querySelector("img");
    // object-fit: contain can leave large margins, especially on a phone. Bound
    // the visible camera picture rather than allowing its margins to pan into view.
    const fit = image?.naturalWidth && image.naturalHeight ? Math.min(width / image.naturalWidth, height / image.naturalHeight) : null;
    const pictureWidth = fit === null ? width : image!.naturalWidth * fit;
    const pictureHeight = fit === null ? height : image!.naturalHeight * fit;
    const x = clamp(next.x, Math.max(0, (pictureWidth * zoom - width) / 2));
    const y = clamp(next.y, Math.max(0, (pictureHeight * zoom - height) / 2));
    return zoom === next.zoom && x === next.x && y === next.y ? next : { zoom, x, y };
  }

  function zoomBy(factor: number, x = 0, y = 0) {
    setView((old) => {
      const zoom = Math.max(1, Math.min(8, old.zoom * factor));
      const ratio = zoom / old.zoom;
      return bounded({ zoom, x: x - (x - old.x) * ratio, y: y - (y - old.y) * ratio });
    });
  }

  useEffect(() => {
    const opener = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.current?.focus();
    const element = dialog.current!;
    const changed = () => setFullscreen(document.fullscreenElement === element);
    document.addEventListener("fullscreenchange", changed);
    // Browsers without fullscreen permission still get the full viewport viewer.
    void element.requestFullscreen?.().catch(() => {});
    return () => {
      document.removeEventListener("fullscreenchange", changed);
      if (document.fullscreenElement === element) void document.exitFullscreen().catch(() => {});
      document.body.style.overflow = previousOverflow;
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  useEffect(() => {
    const element = viewport.current!;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      zoomBy(Math.exp(-Math.max(-100, Math.min(100, event.deltaY)) * 0.003), event.clientX - rect.left - rect.width / 2, event.clientY - rect.top - rect.height / 2);
    };
    element.addEventListener("wheel", wheel, { passive: false });
    const resize = new ResizeObserver(() => setView((old) => bounded(old)));
    resize.observe(element);
    return () => { element.removeEventListener("wheel", wheel); resize.disconnect(); };
  }, []);

  return createPortal(
    <div ref={dialog} className="sv-viewer" role="dialog" aria-modal="true" aria-label={`${name}, fullscreen camera`} tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); close.current(); }
        if (event.key === "Tab") {
          const buttons = Array.from(dialog.current!.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          event.preventDefault();
          buttons[index < 0 ? (event.shiftKey ? buttons.length - 1 : 0) : (index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus();
        }
        // Ctrl/Cmd/Alt combinations stay with the browser (page zoom, history), not the camera view.
        if (!event.ctrlKey && !event.metaKey && !event.altKey && ["+", "=", "-", "0", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
          event.preventDefault();
          if (event.key === "+" || event.key === "=") zoomBy(1.25);
          else if (event.key === "-") zoomBy(0.8);
          else if (event.key === "0") setView(FIT);
          else setView((old) => bounded({ ...old, x: old.x + (event.key === "ArrowLeft" ? 50 : event.key === "ArrowRight" ? -50 : 0), y: old.y + (event.key === "ArrowUp" ? 50 : event.key === "ArrowDown" ? -50 : 0) }));
        }
      }}>
      <header className="sv-viewer-bar">
        <h3>{name}</h3>
        <button className="btn ghost sm" onClick={() => close.current()} aria-label="Close camera view">Close</button>
      </header>
      <div ref={viewport} className={`sv-viewer-viewport${view.zoom > 1 ? " zoomed" : ""}`} aria-label="Camera image. Scroll or pinch to zoom; drag to pan."
        onLoadCapture={() => setView((old) => bounded(old))}
        onDoubleClick={() => setView(FIT)}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        }}
        onPointerMove={(event) => {
          const previous = pointers.current.get(event.pointerId);
          if (!previous) return;
          const other = [...pointers.current.entries()].find(([id]) => id !== event.pointerId)?.[1];
          if (other) {
            const before = Math.hypot(previous.x - other.x, previous.y - other.y);
            const after = Math.hypot(event.clientX - other.x, event.clientY - other.y);
            const rect = event.currentTarget.getBoundingClientRect();
            if (before > 0) zoomBy(after / before, (previous.x + other.x) / 2 - rect.left - rect.width / 2, (previous.y + other.y) / 2 - rect.top - rect.height / 2);
            setView((old) => bounded({ ...old, x: old.x + (event.clientX - previous.x) / 2, y: old.y + (event.clientY - previous.y) / 2 }));
          } else setView((old) => bounded({ ...old, x: old.x + event.clientX - previous.x, y: old.y + event.clientY - previous.y }));
          pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        }}
        onLostPointerCapture={(event) => pointers.current.delete(event.pointerId)}
        onPointerUp={(event) => pointers.current.delete(event.pointerId)}
        onPointerCancel={(event) => pointers.current.delete(event.pointerId)}>
        <div className="sv-viewer-picture" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}>{children}</div>
      </div>
      <footer className="sv-viewer-bar">
        <button className="btn ghost sm" aria-label="Zoom out" disabled={view.zoom <= 1} onClick={() => zoomBy(0.8)}>−</button>
        <output aria-label="Zoom level">{Math.round(view.zoom * 100)}%</output>
        <button className="btn ghost sm" aria-label="Zoom in" disabled={view.zoom >= 8} onClick={() => zoomBy(1.25)}>+</button>
        <button className="btn ghost sm" onClick={() => setView(FIT)}>Reset view</button>
        {document.fullscreenEnabled ? <button className="btn ghost sm" onClick={() => void (fullscreen ? document.exitFullscreen() : dialog.current!.requestFullscreen()).catch(() => {})}>{fullscreen ? "Exit fullscreen" : "Fullscreen"}</button> : null}
        <span className="sv-viewer-hint">Scroll or pinch to zoom · drag to pan</span>
        {age}
      </footer>
    </div>, document.body,
  );
}
