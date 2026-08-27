#!/usr/bin/env node

const assert = require("node:assert/strict");
const { blockingAdvisories, summarizeAudit, firstFixed, explain, dependantsOf, upstreamRoute } = require("./audit-deps.cjs");

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

// --- is a parent upgrade actually available? ---------------------------------
// The 2026-08-07 sweep hit an advisory whose parent pinned an exact vulnerable version and
// STILL did in its newest release, so "upgrade the parent" was a dead end that cost several
// tool calls to disprove. The table must answer that itself.
const pinned = {
  name: "pdfjs-dist",
  nodes: ["node_modules/pdfjs-dist"],
  via: [{ range: ">=5.6.83 <6.2.108" }],
};
const pinnedTree = {
  dependencies: { officeparser: { version: "7.2.3", dependencies: { "pdfjs-dist": { version: "6.1.200" } } } },
};
// declaredRange reads the real node_modules, so drive upstreamRoute directly for the
// registry verdicts — the installed-parent lookup is already covered above.
const dep = { parent: "officeparser", version: "7.2.3", range: "6.1.200" };

assert.deepEqual(
  upstreamRoute(dep, "pdfjs-dist", ["6.2.108"], () => ({ version: "7.5.1", range: "6.1.200" })),
  ["  even the newest officeparser@7.5.1 wants 6.1.200 — no parent upgrade exists, so an override is the only route"],
  "a parent that still pins the vulnerable version must say an override is the only route",
);
assert.ok(
  upstreamRoute(dep, "pdfjs-dist", ["6.2.108"], () => ({ version: "8.0.0", range: "^6.2.108" }))[0].includes(
    "upgrade the parent to it and this clears",
  ),
  "a newer parent that accepts the fix must be named as the route",
);
assert.ok(
  upstreamRoute(dep, "pdfjs-dist", ["6.2.108"], () => ({ version: "8.0.0", range: null }))[0].includes("dropped pdfjs-dist entirely"),
  "a parent that no longer depends on it clears by upgrade too",
);
assert.ok(
  upstreamRoute(dep, "pdfjs-dist", ["6.2.108"], () => null)[0].includes("could not reach the registry"),
  "an unreachable registry degrades honestly instead of inventing a verdict",
);

// The registry is a network call, so the common floor-bump path must never make it.
let probed = 0;
const floorBump = explain(advisory, tree, () => {
  probed += 1;
  return null;
});
assert.equal(probed, 0, "a safe floor bump must not consult the registry");
assert.ok(floorBump.some((l) => l.includes("a floor bump")), "the floor-bump verdict still stands");

// ...and the semver-fighting path must, reaching it through explain()'s real wiring. Give this
// fixture its declared range explicitly: production intentionally reads the installed parent
// manifest, whose version changes whenever the lockfile is refreshed.
let asked = null;
const fought = explain(pinned, pinnedTree, (parent, name) => {
  asked = `${parent}/${name}`;
  return { version: "7.5.1", range: "6.1.200" };
}, () => "6.1.200");
assert.equal(asked, "officeparser/pdfjs-dist", "explain must ask the registry about the pinning parent");
assert.ok(
  !fought.some((l) => /fights semver.*upgrade the parent/.test(l)),
  "the verdict must not prescribe a route the follow-up line may contradict",
);
assert.ok(
  fought.some((l) => l.includes("no parent upgrade exists")),
  `expected the dead-end route to be surfaced, got: ${JSON.stringify(fought)}`,
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
