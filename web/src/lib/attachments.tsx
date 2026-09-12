import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AttachmentRef, FileAttachment, ImageAttachment, ImageMediaType } from "../types.js";
import { useStore } from "../store.js";
import { FileIcon, fileKindOf } from "../components/FileIcon.js";
import { apiUrl } from "./base.js";

export const MAX_IMAGES = 8;
/** The API's per-image ceiling, measured on the BASE64 payload the model receives. */
export const MAX_IMAGE_BASE64_BYTES = 5 * 1024 * 1024;
/** …and the size of a FILE that encodes to it — base64 is 4 characters per 3 bytes, so a picture is 4/3
 *  of itself on the wire. Checking the file against the API's own 5MB number is the bug this constant
 *  exists to prevent: it let every image between 3.75MB and 5MB through to be rejected mid-run, killing
 *  the task that carried it (2026-08-26 — one $8 implementor run, and four such images already stored). */
export const MAX_IMAGE_BYTES = Math.floor((MAX_IMAGE_BASE64_BYTES * 3) / 4);
/** …and what the operator may actually PICK. The two caps above are the API's and cannot move — a
 *  payload past them is not degraded, the run DIES ("Image base64 size exceeds API limit") — but nothing
 *  says the operator has to do the shrinking. A file over `MAX_IMAGE_BYTES` is re-encoded here before it
 *  becomes an attachment, so a 4K screenshot or a phone photo attaches instead of being refused. This is
 *  only a bound on how much work one paste may cost; anything under it is accepted and resized. */
export const MAX_IMAGE_SOURCE_BYTES = 64 * 1024 * 1024;
/** The longest edge a re-encode renders to. The API downsamples anything past ~1568px on the long edge
 *  before the model ever sees it, so pixels beyond this bound cost payload size and tokens and buy no
 *  detail. Kept above 1568 so the console is never the thing that loses legibility first. */
const MAX_IMAGE_EDGE = 2000;
const OK_TYPES = new Set<ImageMediaType>(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function isImageAttachment(file: FileAttachment): file is ImageAttachment {
  return OK_TYPES.has(file.mediaType as ImageMediaType);
}

export function attachmentUrl(ref: AttachmentRef, download = false): string {
  return apiUrl(`/api/attachment/${ref.id}${download ? "?download=1" : ""}`);
}

function previewUrl(a: ImageAttachment): string {
  return `data:${a.mediaType};base64,${a.dataBase64}`;
}

/** Why a file didn't become an attachment, so the composer can say so — a picture that simply never
 *  appears reads as a broken paste, and the operator sends the prompt believing the agent can see it. */
type Rejection = "type" | "size" | "shrink" | "unreadable";

async function readBase64(f: File): Promise<string | null> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });
  const comma = dataUrl.indexOf(",");
  return comma < 0 ? null : dataUrl.slice(comma + 1);
}

/** Decode a picked file into something a canvas can draw. `createImageBitmap` is the cheap path and is
 *  everywhere the console runs; the `<img>` fallback exists because a decode failure has to be told
 *  apart from an unsupported browser — both end as one honest "couldn't resize" rather than a silent
 *  drop. The object URL is always revoked, including on the failure path. */
async function decodeImage(f: File): Promise<{ width: number; height: number; draw: CanvasImageSource; release: () => void } | null> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(f);
      // An ImageBitmap holds its decoded pixels outside the JS heap, so a 4K paste stays resident until
      // GC gets round to it. Closing it is the caller's job once the last render is done.
      return { width: bitmap.width, height: bitmap.height, draw: bitmap, release: () => bitmap.close() };
    } catch {
      // Fall through to the <img> decoder below.
    }
  }
  const url = URL.createObjectURL(f);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("decode failed"));
      el.src = url;
    });
    return { width: img.naturalWidth, height: img.naturalHeight, draw: img, release: () => {} };
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** One render attempt: fit the image inside `edge` on its long side and encode it. Returns the base64
 *  payload, which is the quantity the API measures — never the canvas byte count. */
function renderBase64(
  source: { width: number; height: number; draw: CanvasImageSource },
  edge: number,
  mediaType: ImageMediaType,
  quality: number,
): string | null {
  const scale = Math.min(1, edge / Math.max(source.width, source.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(source.width * scale));
  canvas.height = Math.max(1, Math.round(source.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(source.draw, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL(mediaType, quality);
  // A browser that can't encode the requested type silently hands back a PNG data URL, which would
  // mislabel the block's media_type on the wire. Trust the prefix, not the request.
  if (!dataUrl.startsWith(`data:${mediaType};base64,`)) return null;
  return dataUrl.slice(dataUrl.indexOf(",") + 1);
}

/**
 * Shrink an oversized picture until its base64 fits the API's per-image cap. Dimensions come down
 * first, because payload grows with area and the API discards the extra pixels anyway; only once that
 * isn't enough does it trade format/quality. A GIF becomes a still PNG — its first frame beats the
 * alternative, which today is the whole image being refused.
 */
async function shrinkImage(f: File): Promise<ImageAttachment | null> {
  const source = await decodeImage(f);
  if (!source || !source.width || !source.height) return null;
  const keepsPng = f.type !== "image/jpeg";
  const ladder: Array<{ edge: number; mediaType: ImageMediaType; quality: number }> = [
    { edge: MAX_IMAGE_EDGE, mediaType: keepsPng ? "image/png" : "image/jpeg", quality: 0.92 },
    { edge: 1568, mediaType: keepsPng ? "image/png" : "image/jpeg", quality: 0.9 },
    { edge: 1568, mediaType: "image/jpeg", quality: 0.85 },
    { edge: 1200, mediaType: "image/jpeg", quality: 0.8 },
    { edge: 900, mediaType: "image/jpeg", quality: 0.7 },
  ];
  try {
    for (const step of ladder) {
      const dataBase64 = renderBase64(source, step.edge, step.mediaType, step.quality);
      if (dataBase64 && dataBase64.length <= MAX_IMAGE_BASE64_BYTES) {
        return { name: f.name || "image", mediaType: step.mediaType, dataBase64 };
      }
    }
  } finally {
    source.release();
  }
  return null;
}

/** The single entry point, and it never throws: a decode/read failure is an ORDINARY outcome here (a
 *  truncated download, a file the OS handed over mid-write), and letting it reject would take the whole
 *  batch's banner with it and leave the operator sending a prompt that silently has no picture. */
async function fileToAttachment(f: File): Promise<ImageAttachment | Rejection> {
  if (!OK_TYPES.has(f.type as ImageMediaType)) return "type";
  if (f.size > MAX_IMAGE_SOURCE_BYTES) return "size";
  try {
    // Anything that already fits is passed through byte-identical: re-encoding a picture that was never
    // a problem would cost fidelity for nothing.
    if (f.size > MAX_IMAGE_BYTES) return (await shrinkImage(f)) ?? "shrink";
    const dataBase64 = await readBase64(f);
    if (dataBase64 == null) return "unreadable";
    return { name: f.name || "image", mediaType: f.type as ImageMediaType, dataBase64 };
  } catch {
    return "unreadable";
  }
}

const MAX_IMAGE_MB = (MAX_IMAGE_SOURCE_BYTES / (1024 * 1024)).toFixed(0);

/** One banner covering everything a drop/paste threw away, in the operator's terms (the size of the file
 *  they picked, not of the payload it encodes to). */
function rejectionNotice(counts: Record<Rejection, number>): { level: "warn"; title: string; message: string } | null {
  const { size, type, shrink, unreadable } = counts;
  const parts: string[] = [];
  if (size) parts.push(`${size} image${size === 1 ? " is" : "s are"} over the ${MAX_IMAGE_MB} MB limit`);
  if (type) parts.push(`${type} file${type === 1 ? " is" : "s are"} not a PNG, JPEG, GIF or WebP`);
  if (shrink) parts.push(`${shrink} image${shrink === 1 ? " couldn't" : "s couldn't"} be resized to fit the model's per-image limit`);
  if (unreadable) parts.push(`${unreadable} file${unreadable === 1 ? " couldn't" : "s couldn't"} be read`);
  if (!parts.length) return null;
  return { level: "warn", title: "Not attached", message: `${parts.join(", and ")} — resend a smaller or converted copy.` };
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

/** Paste / drag-drop / file-pick image attachments for a composer. Rejects non-image or oversized files
 *  with a banner saying which and why, and caps the count. */
export function useAttachments(): AttachmentsApi {
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [dragging, setDragging] = useState(false);

  const addFiles = useCallback((files: FileList | File[]) => {
    void (async () => {
      const next: ImageAttachment[] = [];
      const rejected: Record<Rejection, number> = { size: 0, type: 0, shrink: 0, unreadable: 0 };
      for (const f of Array.from(files)) {
        const a = await fileToAttachment(f);
        if (typeof a === "string") rejected[a]++;
        else next.push(a);
      }
      if (next.length) setImages((cur) => [...cur, ...next].slice(0, MAX_IMAGES));
      const notice = rejectionNotice(rejected);
      if (notice) useStore.setState({ notice });
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

export const MAX_COWORK_ATTACHMENTS = 8;
export const MAX_COWORK_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_COWORK_TOTAL_BYTES = 25 * 1024 * 1024;

interface CoworkDraftAttachment {
  file: FileAttachment;
  bytes: number;
}

export interface CoworkAttachmentsApi {
  files: FileAttachment[];
  dragging: boolean;
  addFiles: (files: FileList | File[]) => void;
  remove: (index: number) => void;
  clear: () => void;
  onPaste: (event: React.ClipboardEvent) => void;
  dropHandlers: {
    onDragOver: (event: React.DragEvent) => void;
    onDragLeave: (event: React.DragEvent) => void;
    onDrop: (event: React.DragEvent) => void;
  };
}

function coworkAttachmentNotice(rejected: { imageSize: number; fileSize: number; unreadable: number; count: number; total: number }): void {
  const reasons: string[] = [];
  if (rejected.imageSize) reasons.push(`${rejected.imageSize} screenshot${rejected.imageSize === 1 ? " is" : "s are"} over ${MAX_IMAGE_MB} MB`);
  if (rejected.fileSize) reasons.push(`${rejected.fileSize} file${rejected.fileSize === 1 ? " is" : "s are"} over ${MAX_COWORK_FILE_BYTES / 1024 / 1024} MB`);
  if (rejected.unreadable) reasons.push(`${rejected.unreadable} file${rejected.unreadable === 1 ? " could" : "s could"} not be read`);
  if (rejected.count) reasons.push(`only ${MAX_COWORK_ATTACHMENTS} attachments fit in one message`);
  if (rejected.total) reasons.push(`attachments must total ${MAX_COWORK_TOTAL_BYTES / 1024 / 1024} MB or less`);
  if (reasons.length) {
    useStore.setState({ notice: { level: "warn", title: "Not attached", message: `${reasons.join(", and ")}. Split or shrink the files, then try again.` } });
  }
}

/** Co-work accepts screenshots plus arbitrary files. A screenshot is resized to the provider's image
 * ceiling rather than refused for exceeding it; all files share count/per-file/total caps that keep one
 * WebSocket frame below its 64 MB limit. */
export function useCoworkAttachments(): CoworkAttachmentsApi {
  const [items, setItems] = useState<CoworkDraftAttachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const itemsRef = useRef<CoworkDraftAttachment[]>([]);
  const generation = useRef(0);

  const replace = useCallback((next: CoworkDraftAttachment[]) => {
    itemsRef.current = next;
    setItems(next);
  }, []);

  const addFiles = useCallback((input: FileList | File[]) => {
    const startedInGeneration = generation.current;
    void (async () => {
      const candidates: CoworkDraftAttachment[] = [];
      const rejected = { imageSize: 0, fileSize: 0, unreadable: 0, count: 0, total: 0 };
      for (const source of Array.from(input)) {
        const image = OK_TYPES.has(source.type as ImageMediaType);
        if (image) {
          // Screenshots go through the same accept-and-resize path the task composer uses, so an
          // oversized one is shrunk rather than refused. `bytes` is then what the message actually
          // carries, not what the operator picked — the total budget guards the WebSocket frame.
          const attached = await fileToAttachment(source);
          if (attached === "size") { rejected.imageSize++; continue; }
          if (typeof attached === "string") { rejected.unreadable++; continue; }
          candidates.push({
            file: { ...attached, name: (attached.name || "screenshot").slice(0, 240) },
            bytes: Math.ceil((attached.dataBase64.length * 3) / 4),
          });
          continue;
        }
        if (source.size > MAX_COWORK_FILE_BYTES) { rejected.fileSize++; continue; }
        let dataBase64: string | null;
        try {
          dataBase64 = await readBase64(source);
        } catch {
          rejected.unreadable++;
          continue;
        }
        if (dataBase64 == null) { rejected.fileSize++; continue; }
        candidates.push({
          file: {
            name: (source.name || "attachment").slice(0, 240),
            mediaType: source.type || "application/octet-stream",
            dataBase64,
          },
          bytes: source.size,
        });
      }

      // Switching sessions or sending while FileReader was busy invalidates this batch. Without the
      // generation fence, a large file selected in session A could finish loading into session B.
      if (startedInGeneration !== generation.current) return;

      const next = [...itemsRef.current];
      let bytes = next.reduce((sum, item) => sum + item.bytes, 0);
      for (const candidate of candidates) {
        if (next.length >= MAX_COWORK_ATTACHMENTS) { rejected.count++; continue; }
        if (bytes + candidate.bytes > MAX_COWORK_TOTAL_BYTES) { rejected.total++; continue; }
        next.push(candidate);
        bytes += candidate.bytes;
      }
      if (next.length !== itemsRef.current.length) replace(next);
      coworkAttachmentNotice(rejected);
    })();
  }, [replace]);

  const remove = useCallback((index: number) => replace(itemsRef.current.filter((_, itemIndex) => itemIndex !== index)), [replace]);
  const clear = useCallback(() => {
    generation.current++;
    replace([]);
  }, [replace]);
  useEffect(() => () => { generation.current++; }, []);
  const onPaste = useCallback((event: React.ClipboardEvent) => {
    const files = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => !!file);
    if (files.length) {
      event.preventDefault();
      addFiles(files);
    }
  }, [addFiles]);

  return {
    files: items.map((item) => item.file),
    dragging,
    addFiles,
    remove,
    clear,
    onPaste,
    dropHandlers: {
      onDragOver: (event) => {
        if (Array.from(event.dataTransfer.types).includes("Files")) {
          event.preventDefault();
          setDragging(true);
        }
      },
      onDragLeave: (event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      },
      onDrop: (event) => {
        event.preventDefault();
        setDragging(false);
        if (event.dataTransfer.files.length) addFiles(event.dataTransfer.files);
      },
    },
  };
}

export function CoworkComposerAttachments({
  files,
  onRemove,
}: {
  files: FileAttachment[];
  onRemove?: (index: number) => void;
}) {
  if (!files.length) return null;
  return (
    <div className="cowork-attachment-drafts">
      {files.map((file, index) => isImageAttachment(file) ? (
        <div className="thumb" key={`${file.name}:${index}`} title={file.name}>
          <img src={previewUrl(file)} alt={file.name} />
          {onRemove ? <button className="thumb-x" type="button" onClick={() => onRemove(index)} aria-label={`Remove ${file.name}`}>×</button> : null}
        </div>
      ) : (
        <div className="cowork-file-draft" key={`${file.name}:${index}`} title={file.name}>
          <FileIcon kind={fileKindOf(file.name)} size={20} />
          <span>{file.name}</span>
          {onRemove ? <button type="button" onClick={() => onRemove(index)} aria-label={`Remove ${file.name}`}>×</button> : null}
        </div>
      ))}
    </div>
  );
}

/** Sent Co-work attachments: screenshots open in the existing zoomable lightbox; other files use a
 * compact, forced-download card so potentially active content never renders in the console origin. */
export function CoworkMessageAttachments({ refs }: { refs?: AttachmentRef[] }) {
  if (!refs?.length) return null;
  const images = refs.filter((ref) => OK_TYPES.has(ref.mediaType as ImageMediaType));
  const files = refs.filter((ref) => !OK_TYPES.has(ref.mediaType as ImageMediaType));
  return (
    <>
      <MessageThumbs refs={images} />
      {files.length ? (
        <div className="cowork-message-files">
          {files.map((ref, index) => (
            <a key={`${ref.id}:${index}`} href={attachmentUrl(ref, true)} download={ref.name} title={`Download ${ref.name}`}>
              <FileIcon kind={fileKindOf(ref.name)} size={20} />
              <span>{ref.name}</span>
              <small>Download</small>
            </a>
          ))}
        </div>
      ) : null}
    </>
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
          // Position-qualified: attachments are content-addressed server-side, so the same picture sent
          // twice in one message is the same id twice.
          <button className="msg-thumb" key={`${r.id}:${i}`} type="button" onClick={() => setOpen(i)} title={r.name} aria-label={`View ${r.name}`}>
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

/** Co-work's picker deliberately has no accept filter: screenshots get visual previews, while source,
 * documents, archives and other files become safe download cards plus agent-readable local copies. */
export function CoworkAttachButton({ onPick, disabled = false }: { onPick: (files: FileList) => void; disabled?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={ref}
        type="file"
        multiple
        style={{ display: "none" }}
        onChange={(event) => {
          if (event.target.files?.length) onPick(event.target.files);
          event.target.value = "";
        }}
      />
      <button
        className="cowork-attach"
        type="button"
        title="Attach screenshots or files"
        aria-label="Attach screenshots or files"
        disabled={disabled}
        onClick={() => ref.current?.click()}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
        </svg>
      </button>
    </>
  );
}
