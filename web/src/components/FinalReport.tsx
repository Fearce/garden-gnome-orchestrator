import type { CSSProperties, ReactNode } from "react";
import type { FinalReport } from "../implementationMemos.js";
import type { ImplementationMemo } from "../types.js";
import { clock, modelLabel, roleColor } from "../lib/format.js";
import { Gnome } from "./Gnome.js";
import { Markdown } from "./Markdown.js";

/** The last card of a done/review task's feed. The chronological feed keeps QA, reviewer and
 * self-improvement rows after the implementor's hand-off, which buried the one message the owner opens a
 * finished task to read; this repeats it below everything else. With the summary setting on, a Sonnet
 * condensation leads and the implementor's own words stay one click away. */
export function FinalReportCard({
  report,
  state,
  label,
  memos,
  onOpenMemo,
}: {
  report: FinalReport;
  state: "done" | "review";
  /** The implementor's role label as the feed renders it (name, and model when that setting is on). */
  label: ReactNode;
  memos: ImplementationMemo[];
  onOpenMemo: (memoId: string) => void;
}) {
  const { memo, summary } = report;
  return (
    <section
      className={`fi final-report state-${state}`}
      style={{ "--role": roleColor("implementor") } as CSSProperties}
      aria-label="Final report"
    >
      <div className="head">
        <Gnome role="implementor" size={30} />
        <span className="role-tag" style={{ color: roleColor("implementor") }}>
          {label}
        </span>
        <span className="final-report-kicker">{state === "done" ? "Final report" : "Final report · in review"}</span>
        <span className="ts">{clock(memo.completedAt)}</span>
      </div>
      <div className="final-report-body">
        {summary ? (
          <>
            <div className="final-report-provenance">
              Summarized by {modelLabel(summary.model)} from the implementor's report
            </div>
            <Markdown className="body" text={summary.text} />
            <details className="final-report-full">
              <summary>Implementor's full report</summary>
              <Markdown className="body" text={memo.report ?? ""} />
            </details>
          </>
        ) : (
          <Markdown className="body" text={memo.report ?? ""} />
        )}
        <button className="btn ghost sm final-report-open" type="button" onClick={() => onOpenMemo(memo.id)}>
          Open work memo{memos.length > 1 ? ` · revision ${memo.revision} of ${memos.length}` : ""}
        </button>
      </div>
    </section>
  );
}
