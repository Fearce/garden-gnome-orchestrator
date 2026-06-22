import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AttachmentRef, ImageAttachment } from "../types.js";
import { apiUrl } from "./base.js";

export const MAX_IMAGES = 8;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const OK_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export function attachmentUrl(ref: AttachmentRef): string {
  return apiUrl(`/api/attachment/${ref.id}`);
}

function previewUrl(a: ImageAttachment): string {
  return `data:${a.mediaType};base64,${a.dataBase64}`;
}

async function fileToAttachment(f: File): Promise<ImageAttachment | null> {
  if (!OK_TYPES.has(f.type) || f.size > MAX_IMAGE_BYTES) return null;
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return null;
  return { name: f.name || "image", mediaType: f.type, dataBase64: dataUrl.slice(comma + 1) };
}

export interface AttachmentsApi {
  images: ImageAttachment[];
  dragging: boolean;
  addFiles: (files: FileList | File[]) => void;
  remove: (i: number) => void;
  clear: () => void;
  onPaste: (e: React.ClipboardEvent) => void;
  dropHandlers: {
    onDragOver: (e: React.DragEvent) => void;
    onDragLeave: (e: React.DragEvent) => void;
    onDrop: (e: React.DragEvent) => void;
  };
}

/** Paste / drag-drop / file-pick image attachments for a composer. Silently drops
 *  non-image or oversized files and caps the count. */
export function useAttachments(): AttachmentsApi {
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [dragging, setDragging] = useState(false);

  const addFiles = useCallback((files: FileList | File[]) => {
    void (async () => {
      const next: ImageAttachment[] = [];
      for (const f of Array.from(files)) {
        const a = await fileToAttachment(f);
        if (a) next.push(a);
      }
      if (next.length) setImages((cur) => [...cur, ...next].slice(0, MAX_IMAGES));
    })();
  }, []);

  const onPaste = useCallback(
    (e: React.ClipboardEvent) => {
      const files = Array.from(e.clipboardData.items)
        .filter((it) => it.kind === "file")
        .map((it) => it.getAsFile())
        .filter((f): f is File => !!f && f.type.startsWith("image/"));
      if (files.length) {
        e.preventDefault();
        addFiles(files);
      }
    },
    [addFiles],
  );

  const dropHandlers = {
    onDragOver: (e: React.DragEvent) => {
      if (Array.from(e.dataTransfer.types).includes("Files")) {
        e.preventDefault();
        setDragging(true);
      }
    },
    onDragLeave: (e: React.DragEvent) => {
      // Ignore leaves into child elements (textarea, thumbs) so the outline doesn't flicker.
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
    },
  };

  return {
    images,
    dragging,
    addFiles,
    remove: (i) => setImages((cur) => cur.filter((_, idx) => idx !== i)),
    clear: () => setImages([]),
    onPaste,
    dropHandlers,
  };
}

/** Editable preview strip shown in a composer before send. */
export function ComposerThumbs({ images, onRemove }: { images: ImageAttachment[]; onRemove: (i: number) => void }) {
  if (!images.length) return null;
  return (
    <div className="composer-thumbs">
      {images.map((img, i) => (
        <div className="thumb" key={i} title={img.name}>
          <img src={previewUrl(img)} alt={img.name} />
          <button className="thumb-x" type="button" onClick={() => onRemove(i)} aria-label="Remove image">
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

/** Read-only image strip rendered inside a sent chat bubble / feed row. Each thumbnail opens a
 *  zoomable lightbox (Esc / X / backdrop to close), rather than punting to a raw new tab. */
export function MessageThumbs({ refs }: { refs?: AttachmentRef[] }) {
  const [open, setOpen] = useState<number | null>(null);
  if (!refs?.length) return null;
  return (
    <>
      <div className="msg-thumbs">
        {refs.map((r, i) => (
          <button className="msg-thumb" key={r.id} type="button" onClick={() => setOpen(i)} title={r.name} aria-label={`View ${r.name}`}>
            <img src={attachmentUrl(r)} alt={r.name} />
          </button>
        ))}
      </div>
      {open !== null && <Lightbox refs={refs} index={open} onClose={() => setOpen(null)} onNav={setOpen} />}
    </>
  );
}

const clamp = (v: number, min: number, max: number): number => Math.min(Math.max(v, min), max);
const MIN_ZOOM = 1;
const MAX_ZOOM = 8;

interface Transform {
  scale: number;
  x: number;
  y: number;
}
const IDENTITY: Transform = { scale: 1, x: 0, y: 0 };

/** Zoom toward an anchor point (expressed relative to the stage centre) so the pixel under the
 *  cursor/pinch-midpoint stays put as scale changes. Collapses back to identity at min zoom. */
function zoomAt(prev: Transform, factor: number, ax: number, ay: number): Transform {
  const scale = clamp(prev.scale * factor, MIN_ZOOM, MAX_ZOOM);
  if (scale === MIN_ZOOM) return IDENTITY;
  const k = scale / prev.scale;
  return { scale, x: ax - (ax - prev.x) * k, y: ay - (ay - prev.y) * k };
}

/** Full-screen image viewer: mousewheel + pinch zoom (anchored), drag/pan when zoomed, double-click
 *  to toggle, arrow keys to step through siblings, Esc / X / backdrop to close. Portaled to <body>
 *  so the feed's scroll container can't clip it. */
function Lightbox({
  refs,
  index,
  onClose,
  onNav,
}: {
  refs: AttachmentRef[];
  index: number;
  onClose: () => void;
  onNav: (i: number) => void;
}) {
  const [t, setT] = useState<Transform>(IDENTITY);
  const stageRef = useRef<HTMLDivElement>(null);
  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchDist = useRef<number | null>(null);
  const ref = refs[index];

  // Reset zoom/pan whenever the displayed image changes (open, prev/next).
  useEffect(() => setT(IDENTITY), [index]);

  // Keyboard: Esc closes; arrows step through siblings (wrapping).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (refs.length > 1 && e.key === "ArrowRight") onNav((index + 1) % refs.length);
      else if (refs.length > 1 && e.key === "ArrowLeft") onNav((index - 1 + refs.length) % refs.length);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, refs.length, onClose, onNav]);

  // Wheel zoom needs a non-passive listener so preventDefault can stop the page scrolling under it;
  // React's synthetic onWheel is passive, hence the manual attach.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const ax = e.clientX - rect.left - rect.width / 2;
      const ay = e.clientY - rect.top - rect.height / 2;
      setT((p) => zoomAt(p, e.deltaY < 0 ? 1.15 : 1 / 1.15, ax, ay));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const stageCentreAnchor = (clientX: number, clientY: number): [number, number] => {
    const rect = stageRef.current!.getBoundingClientRect();
    return [clientX - rect.left - rect.width / 2, clientY - rect.top - rect.height / 2];
  };

  /** The first two active pointers, or null if fewer than two are down (keeps TS — and the pinch
   *  math — honest about the Map possibly not holding a pair). */
  const pointerPair = (): [{ x: number; y: number }, { x: number; y: number }] | null => {
    const [a, b] = [...pointers.current.values()];
    return a && b ? [a, b] : null;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pair = pointerPair();
    if (pair) pinchDist.current = Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    const cur = { x: e.clientX, y: e.clientY };
    pointers.current.set(e.pointerId, cur);

    const pair = pointerPair();
    if (pair && pinchDist.current != null) {
      const [a, b] = pair;
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const factor = dist / (pinchDist.current || dist);
      pinchDist.current = dist;
      const [ax, ay] = stageCentreAnchor((a.x + b.x) / 2, (a.y + b.y) / 2);
      setT((p) => zoomAt(p, factor, ax, ay));
      return;
    }
    if (pointers.current.size === 1) {
      const dx = cur.x - prev.x;
      const dy = cur.y - prev.y;
      setT((p) => (p.scale > 1 ? { ...p, x: p.x + dx, y: p.y + dy } : p));
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinchDist.current = null;
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const [ax, ay] = stageCentreAnchor(e.clientX, e.clientY);
    setT((p) => (p.scale > 1 ? IDENTITY : zoomAt(p, 2.5, ax, ay)));
  };

  if (!ref) return null; // index out of range (sibling list shrank) — nothing to show

  return createPortal(
    <div
      className="lightbox"
      ref={stageRef}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
    >
      <button className="lightbox-close" type="button" onClick={onClose} aria-label="Close (Esc)" title="Close (Esc)">
        ✕
      </button>
      {refs.length > 1 && (
        <>
          <button
            className="lightbox-nav prev"
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onNav((index - 1 + refs.length) % refs.length);
            }}
            aria-label="Previous image"
          >
            ‹
          </button>
          <button
            className="lightbox-nav next"
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onNav((index + 1) % refs.length);
            }}
            aria-label="Next image"
          >
            ›
          </button>
        </>
      )}
      <img
        className="lightbox-img"
        src={attachmentUrl(ref)}
        alt={ref.name}
        draggable={false}
        style={{ transform: `translate(${t.x}px, ${t.y}px) scale(${t.scale})`, cursor: t.scale > 1 ? "grab" : "zoom-in" }}
      />
      {refs.length > 1 && (
        <div className="lightbox-count">
          {index + 1} / {refs.length}
        </div>
      )}
    </div>,
    document.body,
  );
}

/** Paperclip file-picker button (Lucide paperclip — real icon, not an emoji). */
export function AttachButton({ onPick }: { onPick: (files: FileList) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={ref}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        multiple
        style={{ display: "none" }}
        onChange={(e) => {
          if (e.target.files?.length) onPick(e.target.files);
          e.target.value = "";
        }}
      />
      <button
        className="btn ghost sm attach-btn"
        type="button"
        title="Attach images"
        aria-label="Attach images"
        onClick={() => ref.current?.click()}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
        </svg>
      </button>
    </>
  );
}
