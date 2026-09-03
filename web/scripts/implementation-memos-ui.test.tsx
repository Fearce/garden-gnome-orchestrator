/** UI/data regression gate for the pinned implementor memo surface. */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mergeImplementationMemos, selectImplementationMemos } from "../src/implementationMemos.js";
import type { ImplementationMemo } from "../src/types.js";

// base.ts resolves the app's mounted path at module load. Supply the one DOM value this SSR gate needs
// before importing the component; effects never run during renderToStaticMarkup.
Object.defineProperty(globalThis, "document", { value: { baseURI: "http://localhost/" }, configurable: true });
const { ImplementationMemoModal, ImplementationMemos } = await import("../src/components/ImplementationMemos.js");

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
  id: over.id,
  threadId: "thread-1",
  runId: `run-${over.revision}`,
  workRevision: `implementation:${over.revision}`,
  revision: over.revision,
  outcome: "completed",
  handoff: "qa",
  source: "run",
  report: `Revision ${over.revision} report`,
  diagnostic: null,
  model: "gpt-5.6-sol",
  account: "codex:gpt-5.6-sol",
  deliverables: [],
  startedAt: 1_780_000_000_000 + over.revision,
  completedAt: 1_780_000_001_000 + over.revision,
  createdAt: 1_780_000_001_000 + over.revision,
  updatedAt: 1_780_000_001_000 + over.revision,
  ...over,
});

const useful = memo({ id: "memo-1", revision: 1, report: "Changed persistence.\n\nValidation passed.\n\nCommit abc pushed." });
const interrupted = memo({
  id: "memo-2",
  revision: 2,
  outcome: "interrupted",
  handoff: "resumed",
  report: "Partial fix before restart.",
  diagnostic: "Server restart interrupted this run.",
});

console.log("\nA. current/latest-useful selection");
const selected = selectImplementationMemos([useful, interrupted]);
check("newest revision remains current", selected.current?.id === interrupted.id);
check("newest completed report remains latest useful", selected.latestUseful?.id === useful.id);
check("the pinned feature uses useful completion instead of pretending interruption succeeded", selected.featured?.id === useful.id);

console.log("\nB. reconnect/concurrent event merge");
const live = memo({
  id: "memo-1",
  revision: 1,
  updatedAt: useful.updatedAt + 50,
  deliverables: [{ findingId: "file-1", label: "Report", path: "docs/report.md", available: true }],
});
const staleHistory = memo({ id: "memo-1", revision: 1, updatedAt: useful.updatedAt });
let merged = mergeImplementationMemos([live, interrupted], [staleHistory, useful]);
check("late stale history cannot erase a newer live bridge update", merged[0]?.deliverables.length === 1);
check("duplicate history/live delivery stays one row per id", merged.length === 2);
const equalClockStale = memo({ id: "memo-1", revision: 1, updatedAt: live.updatedAt, deliverables: [] });
merged = mergeImplementationMemos(merged, [equalClockStale]);
check("equal-clock duplicate history cannot erase rendered live data", merged[0]?.deliverables.length === 1);
const refreshed = memo({ id: "memo-2", revision: 2, outcome: "completed", handoff: "reviewer", report: "Fix completed.", updatedAt: interrupted.updatedAt + 100 });
merged = mergeImplementationMemos(merged, [refreshed]);
check("newer same-id terminal evidence upgrades in place", merged.length === 2 && merged[1]?.outcome === "completed" && merged[1]?.report === "Fix completed.");

console.log("\nC. pinned panel and revision audit markup");
const pin = renderToStaticMarkup(<ImplementationMemos memos={[useful, interrupted]} />);
check("work memo is labeled and pinned independently of feed rows", pin.includes("Implementor work memo"));
check("pin names latest useful revision", pin.includes("Latest useful") && pin.includes("revision 1"));
check("pin warns about the newer interrupted current revision", pin.includes("Current revision 2 interrupted"));
check("pin exposes a direct open action and history count", pin.includes("Open memo") && pin.includes("2 revisions"));

const modal = renderToStaticMarkup(<ImplementationMemoModal memos={[useful, interrupted]} initialId={interrupted.id} onClose={() => {}} />);
check("modal exposes both prior and current revisions", modal.includes("Revision 1") && modal.includes("Revision 2 · current"));
check("modal shows truthful diagnostic and partial report", modal.includes("Server restart interrupted this run.") && modal.includes("Partial fix before restart."));
check("modal exposes stable run/work identity", modal.includes("implementation:2") && modal.includes("run-2"));

console.log("\nD. reconstructed (backfilled) revisions are labeled, not passed off as observed");
const reconstructed = memo({ id: "memo-3", revision: 1, source: "backfill", handoff: "done", report: "Legacy completion report." });
const backfilledPin = renderToStaticMarkup(<ImplementationMemos memos={[reconstructed]} />);
check("pin discloses a reconstructed revision", backfilledPin.includes("reconstructed from run history"));
const backfilledModal = renderToStaticMarkup(<ImplementationMemoModal memos={[reconstructed]} initialId={reconstructed.id} onClose={() => {}} />);
check("modal badges the revision as reconstructed", backfilledModal.includes("Reconstructed"));
check("modal explains that the handoff was derived, not observed", backfilledModal.includes("derived from the task"));
check("an observed revision carries no provenance caveat", !modal.includes("Reconstructed") && !pin.includes("reconstructed from run history"));

console.log(`\n${failures.length ? "FAIL" : "PASS"} — ${passed} checks passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  ✗ ${failure}`);
if (failures.length) process.exit(1);
