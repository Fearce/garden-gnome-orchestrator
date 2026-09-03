import { useEffect, useMemo, useState } from "react";
import type { ImplementationMemo, ImplementationMemoHandoff, ImplementationMemoOutcome } from "../types.js";
import { selectImplementationMemos } from "../implementationMemos.js";
import { apiUrl } from "../lib/base.js";
import { Markdown } from "./Markdown.js";

const OUTCOME_LABEL: Record<ImplementationMemoOutcome, string> = {
  completed: "Completed",
  failed: "Failed",
  interrupted: "Interrupted",
  no_conclusion: "No conclusion",
};

const HANDOFF_LABEL: Record<ImplementationMemoHandoff, string> = {
  pending: "Boundary pending",
  qa: "Handed to QA",
  reviewer: "Handed to reviewer",
  review: "Needs owner review",
  done: "Accepted as done",
  resumed: "Superseded by resumed work",
};

function memoTime(at: number): string {
  return new Date(at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function preview(report: string | null | undefined): string {
  if (!report?.trim()) return "No completion report was produced. Open this memo for the diagnostic evidence.";
  const plain = report.replace(/```[\s\S]*?```/g, " [code] ").replace(/[#>*_`\[\]()]/g, "").replace(/\s+/g, " ").trim();
  return plain.length > 260 ? `${plain.slice(0, 257)}…` : plain;
}

/** Pinned independently of the task feed. The newest actual completion stays featured while a later
 * failed/interrupted attempt remains visible as the current warning and in the revision audit. */
export function ImplementationMemos({ memos }: { memos: ImplementationMemo[] }) {
  const selection = useMemo(() => selectImplementationMemos(memos), [memos]);
  const [open, setOpen] = useState(false);
  const featured = selection.featured;
  if (!featured) return null;
  const newerProblem = selection.current && selection.current.id !== featured.id ? selection.current : null;

  return (
    <section className={`implementation-memo-pin outcome-${featured.outcome}`} aria-label="Implementor work memo">
      <div className="implementation-memo-pin-main">
        <div className="implementation-memo-kicker">
          <span aria-hidden="true">◆</span> Implementor work memo
          <span className={`implementation-memo-status outcome-${featured.outcome}`}>{OUTCOME_LABEL[featured.outcome]}</span>
        </div>
        <div className="implementation-memo-meta">
          {featured === selection.current ? "Current" : "Latest useful"} revision {featured.revision}
          {" · "}{memoTime(featured.completedAt)}{" · "}{HANDOFF_LABEL[featured.handoff]}
          {featured.source === "backfill" ? " · reconstructed from run history" : ""}
        </div>
        <p className="implementation-memo-preview">{preview(featured.report)}</p>
        {newerProblem ? (
          <div className={`implementation-memo-current-warning outcome-${newerProblem.outcome}`}>
            Current revision {newerProblem.revision} {OUTCOME_LABEL[newerProblem.outcome].toLowerCase()} at {memoTime(newerProblem.completedAt)}. Its evidence is preserved in history.
          </div>
        ) : null}
      </div>
      <button className="btn ghost sm implementation-memo-open" type="button" onClick={() => setOpen(true)}>
        Open memo{memos.length > 1 ? ` · ${memos.length} revisions` : ""}
      </button>
      {open ? <ImplementationMemoModal memos={memos} initialId={featured.id} onClose={() => setOpen(false)} /> : null}
    </section>
  );
}

export function ImplementationMemoModal({ memos, initialId, onClose }: { memos: ImplementationMemo[]; initialId: string; onClose: () => void }) {
  const ordered = useMemo(() => [...memos].sort((a, b) => b.revision - a.revision), [memos]);
  const [selectedId, setSelectedId] = useState(initialId);
  const selected = ordered.find((memo) => memo.id === selectedId) ?? ordered[0]!;
  const currentId = ordered[0]?.id;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal implementation-memo-modal" role="dialog" aria-modal="true" aria-labelledby="implementation-memo-title" onClick={(event) => event.stopPropagation()}>
        <div className="m-head implementation-memo-modal-head">
          <div>
            <div className="q-context">Durable implementor handoff</div>
            <h3 id="implementation-memo-title">Work memo · revision {selected.revision}</h3>
            <div className="implementation-memo-meta">
              {memoTime(selected.completedAt)} · run {selected.runId.slice(0, 8)} · {selected.model}{selected.account ? ` · ${selected.account}` : ""}
            </div>
          </div>
          <button className="close-x" type="button" onClick={onClose} aria-label="Close memo">×</button>
        </div>
        <div className={`implementation-memo-modal-grid${ordered.length > 1 ? "" : " single"}`}>
          {ordered.length > 1 ? (
            <nav className="implementation-memo-history" aria-label="Work memo revisions">
              <div className="implementation-memo-history-label">Revision history</div>
              {ordered.map((memo) => (
                <button
                  type="button"
                  key={memo.id}
                  className={memo.id === selected.id ? "selected" : ""}
                  onClick={() => setSelectedId(memo.id)}
                >
                  <span>Revision {memo.revision}{memo.id === currentId ? " · current" : ""}</span>
                  <small className={`outcome-${memo.outcome}`}>{OUTCOME_LABEL[memo.outcome]} · {memoTime(memo.completedAt)}</small>
                </button>
              ))}
            </nav>
          ) : null}
          <div className="implementation-memo-body">
            <div className="implementation-memo-badges">
              <span className={`implementation-memo-status outcome-${selected.outcome}`}>{OUTCOME_LABEL[selected.outcome]}</span>
              <span className="implementation-memo-handoff">{HANDOFF_LABEL[selected.handoff]}</span>
              {selected.id === currentId ? <span className="implementation-memo-current">Current revision</span> : null}
              {selected.source === "backfill" ? <span className="implementation-memo-reconstructed">Reconstructed</span> : null}
            </div>
            {selected.source === "backfill" ? (
              <div className="implementation-memo-provenance">
                This revision predates durable memos and was rebuilt once from run history: the report below is that
                run's own last durable message, and its handoff is derived from the task's recorded state rather than
                observed at the boundary.
              </div>
            ) : null}
            {selected.diagnostic ? <div className={`implementation-memo-diagnostic outcome-${selected.outcome}`}>{selected.diagnostic}</div> : null}
            {selected.report ? <Markdown text={selected.report} className="implementation-memo-report" /> : <p className="implementation-memo-empty">No completion report was produced for this run.</p>}
            {selected.deliverables.length ? (
              <section className="implementation-memo-files">
                <h4>Deliverables captured in this revision</h4>
                {selected.deliverables.map((file) => (
                  <div className="implementation-memo-file" key={`${file.path}\0${file.label}`}>
                    <div>
                      <strong>{file.label}</strong>
                      <code title={file.path}>{file.path}</code>
                      {file.description ? <small>{file.description}</small> : null}
                    </div>
                    {file.available ? (
                      <span>
                        <a className="btn ghost sm" href={apiUrl(`/api/deliverable/${file.findingId}`)} target="_blank" rel="noreferrer">Open</a>
                        <a className="btn ghost sm" href={apiUrl(`/api/deliverable/${file.findingId}?download=1`)} download>Download</a>
                      </span>
                    ) : <em>Archived reference</em>}
                  </div>
                ))}
              </section>
            ) : null}
            <details className="implementation-memo-audit">
              <summary>Audit identity</summary>
              <code>{selected.workRevision}</code>
              <code>{selected.runId}</code>
            </details>
          </div>
        </div>
      </div>
    </div>
  );
}
