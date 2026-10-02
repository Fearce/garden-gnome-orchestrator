/** UI/data gate for the card that closes a done/review task's feed with the implementor's final report. */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { finalReportFor } from "../src/implementationMemos.js";
import type { DeliverableSummary, ImplementationMemo } from "../src/types.js";

// base.ts resolves the app's mounted path at module load; effects never run during renderToStaticMarkup.
Object.defineProperty(globalThis, "document", { value: { baseURI: "http://localhost/" }, configurable: true });
const { FinalReportCard } = await import("../src/components/FinalReport.js");

let passed = 0;
const failures: string[] = [];
function check(label: string, condition: boolean): void {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(label);
    console.log(`  ✗ ${label}`);
  }
}

const memo = (over: Partial<ImplementationMemo> & Pick<ImplementationMemo, "id" | "revision">): ImplementationMemo => ({
  threadId: "thread-1",
  runId: `run-${over.revision}`,
  workRevision: `implementation:${over.revision}`,
  outcome: "completed",
  handoff: "done",
  source: "run",
  report: `Revision ${over.revision} final report`,
  diagnostic: null,
  model: "claude-opus-5-5",
  account: "subscription-a",
  deliverables: [],
  startedAt: 1_780_000_000_000 + over.revision,
  completedAt: 1_780_000_001_000 + over.revision,
  createdAt: 1_780_000_001_000 + over.revision,
  updatedAt: 1_780_000_001_000 + over.revision,
  ...over,
});

const useful = memo({ id: "memo-1", revision: 1, report: "Shipped the **export**.\n\nCommit abc123 pushed." });
const interrupted = memo({ id: "memo-2", revision: 2, outcome: "interrupted", report: "Partial.", handoff: "resumed" });
const summary: DeliverableSummary = {
  text: "Export shipped.\n\n**Deliverables**\n- Sample — `out/sample.csv`",
  model: "claude-sonnet-5",
  memoId: "memo-1",
  sourceKey: "k1",
  taskState: "done",
  createdAt: 1_780_000_002_000,
};

console.log("\nA. which report closes the feed");
check("a running task gets no closing card", finalReportFor("implementing", [useful], null, false) === null);
check("QA in progress gets no closing card", finalReportFor("qa", [useful], null, false) === null);
check("a done task closes on the implementor's report", finalReportFor("done", [useful], null, false)?.memo.id === "memo-1");
check("a review task closes on it too", finalReportFor("review", [useful], null, false)?.memo.id === "memo-1");
check("a later interrupted attempt does not replace the useful report", finalReportFor("review", [useful, interrupted], null, false)?.memo.id === "memo-1");
check("no completed report means no card", finalReportFor("done", [interrupted], null, true) === null);
check("the summary is shown only while the setting is on", finalReportFor("done", [useful], summary, false)?.summary === null);
check("an enabled summary of this revision is used", finalReportFor("done", [useful], summary, true)?.summary?.sourceKey === "k1");
check("a summary of another revision is never shown", finalReportFor("done", [useful], { ...summary, memoId: "memo-0" }, true)?.summary === null);

console.log("\nB. card markup");
const plain = renderToStaticMarkup(
  <FinalReportCard report={{ memo: useful, summary: null }} state="done" label={<span>implementor (Pip)</span>} memos={[useful]} onOpenMemo={() => {}} />,
);
check("the card is labelled as the final report", plain.includes('aria-label="Final report"') && plain.includes("Final report"));
check("without a summary it renders the report verbatim as markdown", plain.includes("<strong>export</strong>") && plain.includes("abc123"));
check("it names the implementor", plain.includes("implementor (Pip)"));
check("a done card is styled as done", plain.includes("state-done"));
check("no summary provenance without a summary", !plain.includes("Summarized by"));

const summarized = renderToStaticMarkup(
  <FinalReportCard report={{ memo: useful, summary }} state="review" label={<span>implementor</span>} memos={[useful, interrupted]} onOpenMemo={() => {}} />,
);
check("the summary leads", summarized.indexOf("Export shipped.") < summarized.indexOf("Implementor&#x27;s full report"));
check("its model is named in plain words", summarized.includes("Summarized by Sonnet 5"));
check("the full report stays one click away", summarized.includes("<details") && summarized.includes("abc123"));
check("a review card says so", summarized.includes("state-review") && summarized.includes("in review"));
check("the memo button counts revisions", summarized.includes("revision 1 of 2"));

console.log(`\n${failures.length ? "FAIL" : "PASS"} — ${passed} checks passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  ✗ ${failure}`);
process.exit(failures.length ? 1 : 0);
