import { lazy, Suspense, useState } from "react";
import type { Finding } from "../types.js";
import { apiUrl } from "../lib/base.js";
import { FileIcon, fileKindOf, isPreviewable, basenameOf } from "./FileIcon.js";

// The preview modal pulls in react-markdown + highlight.js; load it lazily on first View so those
// deps stay out of the main bundle.
const DeliverableModal = lazy(() => import("./DeliverableModal.js"));

function copy(text: string): void {
  void navigator.clipboard?.writeText(text);
}

/**
 * The right-panel Deliverables strip: each agent-produced file (a finding of kind 'deliverable') is a
 * small clickable file icon. Clicking opens the inline preview; hovering (or focusing) reveals a
 * popover with the label, filename, description and actions. The popover is an out-of-flow overlay so
 * the strip stays a thin single bar and never pushes into or reflows the activity feed below it.
 * Renders nothing when the task has no deliverables.
 */
export function Deliverables({ items }: { items: Finding[] }) {
  const [viewing, setViewing] = useState<Finding | null>(null);
  if (!items.length) return null;
  return (
    <div className="deliverables">
      <span className="deliverables-label">
        deliverables <span className="n">{items.length}</span>
      </span>
      <div className="deliverable-strip">
        {items.map((d) => (
          <DeliverableChip key={d.id} d={d} onView={() => setViewing(d)} />
        ))}
      </div>
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
  const onCopy = () => {
    copy(path);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };
  const download = apiUrl(`/api/deliverable/${d.id}?download=1`);
  return (
    <span className="dl-chip">
      <button
        className="dl-chip-btn"
        onClick={previewable ? onView : undefined}
        // A binary/unknown file can't be previewed, so its icon is a plain marker, not a button action.
        aria-label={d.label ?? name}
        title={d.label ?? name}
        type="button"
      >
        <FileIcon kind={kind} size={19} />
      </button>
      <span className="dl-pop" role="tooltip">
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
            <button className="btn ghost sm" onClick={onView} type="button" title="Preview the file inline">
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
