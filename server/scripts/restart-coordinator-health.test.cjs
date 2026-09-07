const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { inspectRestartCoordinator } = require("./restart-coordinator-health.cjs");

function status(overrides = {}) {
  return {
    now: 1_788_785_121_095,
    activeWork: 0,
    decision: { allow: true, reason: "no active agent work remains" },
    pending: null,
    pendingLabel: null,
    draining: false,
    ...overrides,
  };
}

const idle = inspectRestartCoordinator(status({
  activeWork: 3,
  decision: { allow: false, retryAt: null, reason: "3 active work items remain" },
}));
assert.equal(idle.valid, true);
assert.equal(idle.level, "ok");
assert.match(idle.message, /idle \(no restart pending\).*3 active work items/);

const pending = inspectRestartCoordinator(status({
  activeWork: 2,
  decision: { allow: false, retryAt: null, reason: "2 active work items remain" },
  pending: { requesters: [{ label: "deploy" }], failures: 0, retryAt: null },
  pendingLabel: "waiting for 2 active work items",
  draining: true,
}));
assert.equal(pending.valid, true);
assert.equal(pending.level, "ok");
assert.match(pending.message, /waiting for 2 active work items; 1 staged build, 2 active work items/);

const refused = inspectRestartCoordinator(status({
  decision: { allow: false, retryAt: 1_788_785_421_095, reason: "retry backoff" },
  pending: { requesters: [{}, {}], failures: 3, retryAt: 1_788_785_421_095 },
  pendingLabel: "retrying in 5m",
  // After repeated refusal, admission deliberately reopens until the next retry is due.
  draining: false,
}));
assert.equal(refused.valid, true);
assert.equal(refused.level, "warn");
assert.match(refused.message, /2 staged builds.*3 refused restart attempts/);

const firing = inspectRestartCoordinator(status({ draining: true }));
assert.equal(firing.valid, true, "the coordinator clears pending before its in-flight restart, so this shape is valid");
assert.match(firing.message, /restart in flight/);

const contradiction = inspectRestartCoordinator(status({ activeWork: 1 }));
assert.equal(contradiction.valid, false);
assert.match(contradiction.message, /cannot allow a restart while work is active/);

const malformedPending = inspectRestartCoordinator(status({
  pending: { requesters: [], failures: -1, retryAt: "soon" },
  pendingLabel: null,
  draining: true,
}));
assert.equal(malformedPending.valid, false);
assert.deepEqual(malformedPending.issues, [
  "pending.requesters must contain at least one staged build",
  "pending.failures must be a non-negative integer",
  "pending.retryAt must be null or finite",
  "pendingLabel must describe a pending restart",
]);

const nonObject = inspectRestartCoordinator(null);
assert.equal(nonObject.valid, false);
assert.match(nonObject.message, /non-object/);

const healthSource = fs.readFileSync(path.join(__dirname, "nightly-health.cjs"), "utf8");
assert.match(healthSource, /inspectRestartCoordinator\(restartRead\.status\)/, "the nightly probe must consume the status classifier");
assert.match(healthSource, /restart coordinator status unavailable/, "an unreadable coordinator must be visible, never a silent pass");

console.log("restart coordinator health: all assertions passed");
