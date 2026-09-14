/** Regression coverage for the durable deliverables index in task detail. */
import { mergeDeliverableIndexes, mergeThreadDeliverables } from "../src/threadDeliverables.js";
import type { Finding } from "../src/types.js";

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

const finding = (id: string, createdAt: number, kind: Finding["kind"] = "deliverable"): Finding => ({
  id,
  threadId: "long-running-task",
  fromRunId: "run-with-more-than-a-feed-page",
  fromRole: "implementor",
  kind,
  summary: id,
  detail: null,
  path: kind === "deliverable" ? `C:/work/${id}.md` : null,
  label: kind === "deliverable" ? id : null,
  severity: "info",
  routed: false,
  createdAt,
});

console.log("\nA. durable task file index");
const earlyFiles = [finding("first-report", 1), finding("second-report", 2), finding("third-report", 3)];
// This mirrors a long task whose generic activity feed has already retained only its newest rows.
const retainedActivity = Array.from({ length: 800 }, (_, i) => finding(`activity-${i}`, 10_000 + i, "finding"));
const fileIndex = mergeThreadDeliverables([], [...earlyFiles, ...retainedActivity]);
check("older deliverables survive even when the activity feed retains only newer rows", fileIndex.map((item) => item.id).join(",") === "first-report,second-report,third-report");

console.log("\nB. live emission and history replay");
const emitted = finding("newly-emitted-report", 20_000);
const withLiveFile = mergeThreadDeliverables(fileIndex, [emitted]);
check("a newly emitted deliverable appends immediately", withLiveFile.at(-1)?.id === emitted.id && withLiveFile.length === 4);
const replayWithoutLiveFile = mergeThreadDeliverables(withLiveFile, earlyFiles);
check("a stale history reply cannot erase a newly emitted card", replayWithoutLiveFile.some((item) => item.id === emitted.id));
const duplicateReplay = mergeThreadDeliverables(replayWithoutLiveFile, [emitted]);
check("history and live delivery deduplicate by finding id", duplicateReplay.filter((item) => item.id === emitted.id).length === 1);

console.log("\nC. bounded reconnect snapshot");
const reconnected = mergeDeliverableIndexes({ "long-running-task": duplicateReplay }, {});
check("a bounded hello snapshot cannot erase the open task's file index", reconnected["long-running-task"]?.length === 4);

console.log(`\n${failures.length ? "FAIL" : "PASS"} — ${passed} checks passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  ✗ ${failure}`);
if (failures.length) process.exit(1);
