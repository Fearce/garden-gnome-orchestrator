#!/usr/bin/env node

const assert = require("node:assert/strict");
const { blockingAdvisories, summarizeAudit, firstFixed, explain, dependantsOf } = require("./audit-deps.cjs");

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

// --- remediation detail -----------------------------------------------------
// The upper bound of a GHSA range is the first patched release — the number a fix needs.
assert.equal(firstFixed(">=2.0.0 <2.1.4"), "2.1.4");
assert.equal(firstFixed(">=4.0.0 <5.0.9"), "5.0.9");
assert.equal(firstFixed("<=10.3.0"), null, "an inclusive bound names no patched version");
assert.equal(firstFixed(undefined), null);

const tree = {
  dependencies: {
    rimraf: {
      version: "5.0.10",
      dependencies: { minimatch: { version: "9.0.9", dependencies: { "brace-expansion": { version: "2.1.3" } } } },
    },
  },
};
assert.deepEqual(
  dependantsOf(tree, "brace-expansion").map((d) => `${d.parent}@${d.version}`),
  ["minimatch@9.0.9"],
);
assert.deepEqual(dependantsOf(tree, "nothing-here"), []);

// The decision the table exists to answer: is the fix inside the parent's declared range
// (a safe floor bump) or outside it (an override that fights semver)?
const advisory = {
  name: "brace-expansion",
  nodes: ["node_modules/rimraf/node_modules/brace-expansion"],
  via: [{ range: ">=2.0.0 <2.1.4" }],
};
const lines = explain(advisory, {
  dependencies: {
    rimraf: {
      version: "5.0.10",
      dependencies: { minimatch: { version: "9.0.9", dependencies: { "brace-expansion": { version: "2.1.3" } } } },
    },
  },
});
assert.ok(
  lines.some((l) => l.includes("installed at: rimraf/node_modules/brace-expansion")),
  "the on-disk location npm reported is surfaced",
);
assert.ok(lines.some((l) => l.includes("clears at: >=2.1.4")), "the version that clears it is named");
// This repo really has minimatch 9.0.9 nested under rimraf, declaring ^2.0.2 — which
// accepts 2.1.4, so the verdict must be the safe floor bump. It also proves the
// hoist-aware lookup worked: top-level node_modules/minimatch is 10.x and wants ^5.0.5,
// and reading THAT copy would have produced the opposite (wrong) verdict.
assert.ok(
  lines.some((l) => /parent minimatch@9\.0\.9 wants \^2\.0\.2 → accepts 2\.1\.4 — a floor bump/.test(l)),
  `expected an in-range floor-bump verdict, got: ${JSON.stringify(lines)}`,
);

// A parent whose installed copy cannot be matched by version reports honestly rather
// than reading a same-named copy that means something else.
const ghost = explain(
  { name: "brace-expansion", nodes: [], via: [{ range: ">=2.0.0 <2.1.4" }] },
  { dependencies: { minimatch: { version: "0.0.0", dependencies: { "brace-expansion": { version: "2.1.3" } } } } },
);
assert.ok(
  ghost.some((l) => l.includes("declared range not resolvable")),
  `expected an honest not-resolvable line, got: ${JSON.stringify(ghost)}`,
);

// The failing branch only runs when the sweep is already red, so exercise the exact
// wiring main() uses — blockingAdvisories() names a key, and report.vulnerabilities must
// still resolve it into something explain() can read. A canned copy of the three real
// advisories from 2026-08-04.
const realReport = {
  metadata: { vulnerabilities: { info: 0, low: 4, moderate: 9, high: 3, critical: 0 } },
  vulnerabilities: {
    "brace-expansion": {
      name: "brace-expansion",
      severity: "high",
      isDirect: false,
      nodes: ["node_modules/brace-expansion", "node_modules/rimraf/node_modules/brace-expansion"],
      via: [{ range: ">=4.0.0 <5.0.9" }, { range: ">=2.0.0 <2.1.4" }],
    },
    "fast-uri": {
      name: "fast-uri",
      severity: "high",
      isDirect: false,
      nodes: ["node_modules/fast-uri"],
      via: [{ range: ">=3.0.0 <3.1.5" }],
    },
    "ip-address": {
      name: "ip-address",
      severity: "high",
      isDirect: false,
      nodes: ["node_modules/ip-address"],
      via: [{ range: "<=10.3.0" }],
    },
  },
};
assert.equal(summarizeAudit(realReport).high, 3);
for (const found of blockingAdvisories(realReport)) {
  const raw = realReport.vulnerabilities[found.name];
  assert.ok(raw, `main() could not resolve the raw advisory for ${found.name}`);
  assert.doesNotThrow(() => explain(raw, {}), `explain threw on ${found.name}`);
}
// ip-address's `<=10.3.0` names no patched version, so the table must say so rather than
// inventing one — the honest-degradation case a real advisory actually produced.
const ipLines = explain(realReport.vulnerabilities["ip-address"], {});
assert.ok(!ipLines.some((l) => l.startsWith("clears at:")), "an inclusive bound yields no clears-at claim");

console.log("Dependency audit policy tests passed.");
