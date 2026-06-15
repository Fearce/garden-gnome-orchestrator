import { useCallback, useRef, useState } from "react";
import type { AttachmentRef, ImageAttachment } from "../types.js";

export const MAX_IMAGES = 8;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const OK_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export function attachmentUrl(ref: AttachmentRef): string {
  return `/api/attachment/${ref.id}`;
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

/** Read-only image strip rendered inside a sent chat bubble. */
export function MessageThumbs({ refs }: { refs?: AttachmentRef[] }) {
  if (!refs?.length) return null;
  return (
    <div className="msg-thumbs">
      {refs.map((r) => (
        <a className="msg-thumb" key={r.id} href={attachmentUrl(r)} target="_blank" rel="noreferrer" title={r.name}>
          <img src={attachmentUrl(r)} alt={r.name} />
        </a>
      ))}
    </div>
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
