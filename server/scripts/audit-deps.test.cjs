#!/usr/bin/env node

const assert = require("node:assert/strict");
const { blockingAdvisories, summarizeAudit } = require("./audit-deps.cjs");

const report = {
  metadata: { vulnerabilities: { info: 1, low: 2, moderate: 3, high: 4, critical: 5 } },
  vulnerabilities: {
    low: { name: "low", severity: "low", isDirect: true },
    critical: { name: "critical", severity: "critical", isDirect: false },
    high: { name: "high", severity: "high", isDirect: true },
  },
};

assert.deepEqual(summarizeAudit(report), { info: 1, low: 2, moderate: 3, high: 4, critical: 5 });
assert.deepEqual(blockingAdvisories(report), [
  { name: "critical", severity: "critical", direct: false },
  { name: "high", severity: "high", direct: true },
]);
assert.throws(() => summarizeAudit({ metadata: { vulnerabilities: { high: -1 } } }), /invalid high count/);
assert.throws(() => summarizeAudit({}), /no vulnerability summary/);

console.log("Dependency audit policy tests passed.");
