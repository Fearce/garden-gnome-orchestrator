import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { Finding } from "../types.js";
import { apiUrl } from "../lib/base.js";
import { FileIcon, fileKindOf, isPreviewable, basenameOf } from "./FileIcon.js";

// The preview modal pulls in react-markdown + highlight.js; load it lazily on first View so those
// deps stay out of the main bundle.
const DeliverableModal = lazy(() => import("./DeliverableModal.js"));

function copy(text: string): void {
  void navigator.clipboard?.writeText(text);
}

/** `.dl-pop`'s width, and the gap it leaves under the chip. Mirrors the two values in styles.css;
 *  they are needed here to keep a popover anchored near the right edge inside the window. */
const POP_W = 244;
const POP_GAP = 6;

/**
 * Where a chip's popover should sit, in VIEWPORT coordinates, or null to leave it to the stylesheet.
 *
 * The popover is `position: fixed` rather than absolute inside the chip, because every box it would
 * otherwise sit in clips it: `.deliverables` is a capped, self-scrolling bar (a 244px card cannot
 * live inside a 47px strip), `.detail` is `overflow: hidden`, and on a narrow pane the panel is
 * narrower than the popover. The touch layer already escaped this the same way, as a bottom sheet
 * anchored to the window corner, and that rule still owns the no-hover case: returning null there
 * leaves its `inset` untouched instead of fighting it with an inline style.
 */
function popoverPosition(chip: HTMLElement | null): { top: number; left: number } | null {
  if (!chip || typeof window === "undefined") return null;
  if (window.matchMedia("(hover: none)").matches) return null; // the bottom-sheet rule places it
  const box = chip.getBoundingClientRect();
  return {
    top: box.bottom + POP_GAP,
    left: Math.min(Math.max(8, box.left), Math.max(8, window.innerWidth - POP_W - 8)),
  };
}

/**
 * The right-panel Deliverables strip: each agent-produced file (a finding of kind 'deliverable') is a
 * small clickable file icon. Clicking opens the inline preview; hovering (or focusing) reveals a
 * popover with the label, filename, description and actions. The popover is an out-of-flow overlay so
 * the strip stays a thin single bar and never pushes into or reflows the activity feed below it.
 * Without a mouse there is no hover, so the popover is also openable by state — from the ⋯ button
 * (touch-only) and from the icon of a file that has no preview to open instead.
 * Renders nothing when the task has no deliverables.
 */
export function Deliverables({ items }: { items: Finding[] }) {
  const [viewing, setViewing] = useState<Finding | null>(null);
  // File cards are useful but secondary to the transcript. Phones start with one disclosure row;
  // desktop retains the established open strip, and either can be changed deliberately.
  const [expanded, setExpanded] = useState(() => typeof window === "undefined" || !window.matchMedia("(max-width: 899.98px)").matches);
  if (!items.length) return null;
  return (
    <div className={"deliverables" + (expanded ? " expanded" : " collapsed")}>
      <button
        type="button"
        className="deliverables-label"
        onClick={() => setExpanded((open) => !open)}
        aria-expanded={expanded}
      >
        deliverables <span className="n">{items.length}</span>
        <span className="deliverables-chevron" aria-hidden="true">{expanded ? "⌃" : "⌄"}</span>
      </button>
      {expanded ? (
        <div className="deliverable-strip">
          {items.map((d) => (
            <DeliverableChip key={d.id} d={d} onView={() => setViewing(d)} />
          ))}
        </div>
      ) : null}
      {viewing && (
        <Suspense fallback={null}>
          <DeliverableModal d={viewing} onClose={() => setViewing(null)} />
        </Suspense>
      )}
    </div>
  );
}

function DeliverableChip({ d, onView }: { d: Finding; onView: () => void }) {
  const path = d.path ?? "";
  const name = basenameOf(path);
  const kind = fileKindOf(name);
  const previewable = isPreviewable(kind);
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);
  // Viewport coordinates for this chip's popover, re-measured every time it is about to be shown.
  // The strip scrolls and the panel resizes, so a position measured once would drift off its chip.
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const ref = useRef<HTMLSpanElement>(null);
  const place = () => setPos(popoverPosition(ref.current));
  const onCopy = () => {
    copy(path);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };
  // A tap-opened popover needs a tap-anywhere-else to close it; hover-opened ones close themselves.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);
  const download = apiUrl(`/api/deliverable/${d.id}?download=1`);
  return (
    // Placement hangs off the same events the stylesheet shows the popover on, so the coordinates are
    // already written by the time `:hover`/`:focus-within` reveals it. Until a chip has been measured
    // once, styles.css parks the popover off-screen rather than at the window's top-left corner.
    <span className="dl-chip" ref={ref} onMouseEnter={place} onFocus={place}>
      <button
        className="dl-chip-btn"
        // A previewable file opens its preview on the first click, on any device. One that can't be
        // previewed used to be an inert icon — it now opens the popover, where its actions live.
        onClick={previewable ? onView : () => { place(); setOpen((o) => !o); }}
        aria-label={d.label ?? name}
        title={d.label ?? name}
        type="button"
      >
        <FileIcon kind={kind} size={19} />
      </button>
      {/* Touch-only: the actions below are otherwise reachable by hover alone. */}
      <button
        className="dl-more"
        onClick={() => { place(); setOpen((o) => !o); }}
        aria-label={`Actions for ${d.label ?? name}`}
        aria-expanded={open}
        type="button"
      >
        ⋯
      </button>
      <span className={"dl-pop" + (open ? " open" : "")} role="tooltip" style={pos ? { top: pos.top, left: pos.left } : undefined}>
        <span className="dl-pop-head">
          <span className="dl-pop-icon">
            <FileIcon kind={kind} size={16} />
          </span>
          <span className="dl-pop-label">{d.label ?? name}</span>
        </span>
        <span className="dl-pop-name" title={path}>
          {name}
        </span>
        {d.detail ? <span className="dl-pop-desc">{d.detail}</span> : null}
        <span className="dl-pop-actions">
          {previewable && (
            <button
              className="btn ghost sm"
              onClick={() => {
                setOpen(false);
                onView();
              }}
              type="button"
              title="Preview the file inline"
            >
              View
            </button>
          )}
          <a className="btn ghost sm" href={download} download={name} title="Download the file">
            Download
          </a>
          <button className="btn ghost sm" onClick={onCopy} type="button" title="Copy the full file path to the clipboard">
            {copied ? "Copied" : "Copy path"}
          </button>
        </span>
      </span>
    </span>
  );
}
