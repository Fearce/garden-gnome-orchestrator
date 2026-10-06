import assert from "node:assert/strict";
import { shallow } from "zustand/shallow";
import type { AgentRun, Finding, Thread } from "../src/types.js";
import { taskChildren, taskFindings, taskRecords, taskRuns } from "../src/lib/taskSelectors.js";

let reads = 0;
const runs: Record<string, AgentRun> = {};
for (let i = 0; i < 1400; i++) {
  const run = { id: `run-${i}`, threadId: `task-${i % 12}` } as AgentRun;
  Object.defineProperty(runs, run.id, { enumerable: true, get: () => { reads++; return run; } });
}
const selected = taskRuns(runs, "task-0");
for (let event = 0; event < 100; event++) for (let card = 0; card < 12; card++) taskRuns(runs, `task-${card}`);
assert.equal(reads, 1400, "1,200 card subscriptions enumerate the run history once, not once per token/card");
assert.equal(taskRuns(runs, "task-0"), selected);
assert.equal(taskRuns(runs, "absent"), taskRuns(runs, "another-absent"), "missing tasks share a stable empty result");
const newRun = { id: "new-run", threadId: "task-1" } as AgentRun;
const updated = { ...runs, [newRun.id]: newRun };
assert.ok(shallow(taskRuns(updated, "task-0"), selected), "another task's run keeps this task's subscription equal");
assert.ok(taskRuns(updated, "task-1").includes(newRun), "a new run refreshes its own task");

const findings = [{ id: "finding", threadId: "task-0" }] as Finding[];
assert.equal(taskFindings(findings, "task-0").length, 1);
assert.equal(taskFindings([...findings, { id: "other", threadId: "task-1" } as Finding], "task-0").length, 1);
const child = { id: "child", parentId: "task-0" } as Thread;
assert.deepEqual(taskChildren({ child }, "task-0"), [child]);
assert.deepEqual(taskChildren({ child }, "task-1"), []);

const records = { lead: { text: "lead" }, collaborator: { text: "child" }, other: { text: "background" } };
const ids = ["lead", "collaborator"];
const held = taskRecords(records, ids);
assert.ok(shallow(held, taskRecords({ ...records, other: { text: "more background" } }, ids)), "background deltas leave the selected conversation unchanged");
assert.ok(!shallow(held, taskRecords({ ...records, collaborator: { text: "child update" } }, ids)), "collaborator deltas still refresh the conversation");
assert.deepEqual(taskRecords(records, []), {}, "closing the pane selects no tasks");
console.log("Task selectors: large history indexes, background isolation and collaborator updates passed.");
