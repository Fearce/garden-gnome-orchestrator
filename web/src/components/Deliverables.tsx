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
 * The right-panel Deliverables section: an agent-produced file (a finding of kind 'deliverable')
 * rendered as a card with View / Download / Copy-path actions. Renders nothing when the task has no
 * deliverables, so it's invisible on the vast majority of tasks.
 */
export function Deliverables({ items }: { items: Finding[] }) {
  const [viewing, setViewing] = useState<Finding | null>(null);
  if (!items.length) return null;
  return (
    <div className="deliverables">
      <div className="deliverables-head">
        deliverables <span className="n">{items.length}</span>
      </div>
      <div className="deliverable-list">
        {items.map((d) => (
          <DeliverableCard key={d.id} d={d} onView={() => setViewing(d)} />
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

function DeliverableCard({ d, onView }: { d: Finding; onView: () => void }) {
  const path = d.path ?? "";
  const name = basenameOf(path);
  const kind = fileKindOf(name);
  const [copied, setCopied] = useState(false);
  const onCopy = () => {
    copy(path);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };
  return (
    <div className="deliverable-card">
      <span className="dl-icon">
        <FileIcon kind={kind} size={26} />
      </span>
      <div className="dl-meta">
        <div className="dl-label" title={d.label ?? name}>
          {d.label ?? name}
        </div>
        <div className="dl-name" title={path}>
          {name}
        </div>
        {d.detail ? <div className="dl-desc">{d.detail}</div> : null}
      </div>
      <div className="dl-actions">
        {isPreviewable(kind) && (
          <button className="btn ghost sm" onClick={onView} title="Preview the file inline">
            View
          </button>
        )}
        <a className="btn ghost sm" href={apiUrl(`/api/deliverable/${d.id}?download=1`)} download={name} title="Download the file">
          Download
        </a>
        <button className="btn ghost sm" onClick={onCopy} title="Copy the full file path to the clipboard">
          {copied ? "Copied" : "Copy path"}
        </button>
      </div>
    </div>
  );
}
