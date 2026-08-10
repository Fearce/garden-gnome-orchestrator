#!/usr/bin/env node

const assert = require("node:assert/strict");
const {
  parseSelector,
  parseVersion,
  satisfies,
  collectInstalled,
  selectorsOf,
  auditOverrides,
  reportOverrides,
  degradedReason,
} = require("./audit-overrides.cjs");

// --- selector parsing -------------------------------------------------------
assert.deepEqual(parseSelector("minimatch"), { name: "minimatch", range: "" });
assert.deepEqual(parseSelector("minimatch@9.0.9"), { name: "minimatch", range: "9.0.9" });
assert.deepEqual(parseSelector("brace-expansion@^2"), { name: "brace-expansion", range: "^2" });
// A scoped name is all @-signs; only the LAST one can introduce a range.
assert.deepEqual(parseSelector("@modelcontextprotocol/sdk"), {
  name: "@modelcontextprotocol/sdk",
  range: "",
});
assert.deepEqual(parseSelector("@scope/pkg@^1.2.3"), { name: "@scope/pkg", range: "^1.2.3" });

// --- version parsing --------------------------------------------------------
assert.deepEqual(parseVersion("10.4.0"), { major: 10, minor: 4, patch: 0 });
assert.deepEqual(parseVersion("1.0.0-beta.1"), { major: 1, minor: 0, patch: 0 });
assert.equal(parseVersion("not-a-version"), null);

// --- the grammar ------------------------------------------------------------
// any
assert.equal(satisfies("1.2.3", ""), true);
assert.equal(satisfies("1.2.3", "*"), true);

// exact
assert.equal(satisfies("9.0.9", "9.0.9"), true);
assert.equal(satisfies("9.1.0", "9.0.9"), false);

// caret, full
assert.equal(satisfies("2.1.4", "^2.1.4"), true);
assert.equal(satisfies("2.9.9", "^2.1.4"), true);
assert.equal(satisfies("2.1.3", "^2.1.4"), false, "below the floor is not satisfied");
assert.equal(satisfies("3.0.0", "^2.1.4"), false);

// caret, partial (the form this repo's overrides now use)
assert.equal(satisfies("2.1.4", "^2"), true);
assert.equal(satisfies("5.0.9", "^5"), true);
assert.equal(satisfies("5.0.8", "^5"), true, "^5 is a major-line selector, not a floor");
assert.equal(satisfies("1.9.9", "^2"), false);

// caret on 0.x keeps the minor pinned, per semver
assert.equal(satisfies("0.5.3", "^0.5"), true);
assert.equal(satisfies("0.6.0", "^0.5"), false);
assert.equal(satisfies("0.0.3", "^0.0.3"), true);
assert.equal(satisfies("0.0.4", "^0.0.3"), false);

// tilde + bare partials
assert.equal(satisfies("2.1.9", "~2.1.0"), true);
assert.equal(satisfies("2.2.0", "~2.1.0"), false);
assert.equal(satisfies("2.1.9", "2.1"), true);
assert.equal(satisfies("2.5.0", "2.1"), false, "a bare 2.1 means 2.1.x");

// prerelease suffixes are ignored for matching (documented simplification)
assert.equal(satisfies("1.0.0-beta.1", "^1"), true);

// anything outside the grammar is UNEVALUATED, never a false failure
assert.equal(satisfies("1.0.0", ">=1.0.0"), null);
assert.equal(satisfies("1.0.0", "1.x || 2.x"), null);
assert.equal(satisfies("garbage", "^1"), null);

// --- tree walking -----------------------------------------------------------
const tree = {
  dependencies: {
    fastify: {
      version: "5.8.5",
      dependencies: { "fast-uri": { version: "3.1.5" } },
    },
    rimraf: {
      version: "5.0.10",
      dependencies: {
        minimatch: { version: "9.0.9", dependencies: { "brace-expansion": { version: "2.1.4" } } },
      },
    },
    glob: {
      version: "13.0.6",
      dependencies: {
        minimatch: { version: "10.2.5", dependencies: { "brace-expansion": { version: "5.0.9" } } },
      },
    },
    broken: { missing: true },
  },
};
const installed = collectInstalled(tree);
assert.deepEqual([...installed.get("minimatch")].sort(), ["10.2.5", "9.0.9"]);
assert.deepEqual([...installed.get("brace-expansion")].sort(), ["2.1.4", "5.0.9"]);
assert.equal(installed.has("broken"), false, "a node with no resolved version is not installed");

// --- selector flattening ----------------------------------------------------
assert.deepEqual(
  selectorsOf({ a: "1.0.0", "b@^2": { c: "3.0.0" } }).map((s) => s.key),
  ["a", "b@^2", "c"],
);
// npm overrides can name a whole dependency PATH, and the package the pin actually
// applies to is the DEEPEST key — stopping at the first level leaves it unchecked.
assert.deepEqual(
  selectorsOf({ p: { q: { r: "1.0.0" } } }).map((s) => s.key),
  ["p", "q", "r"],
);
assert.deepEqual(
  selectorsOf({ p: { q: { r: "1.0.0" } } }).map((s) => (s.path ?? [s.key]).join(" > ")),
  ["p", "p > q", "p > q > r"],
);
// An override of the parent itself ("." ) is a value, not another selector.
assert.deepEqual(
  selectorsOf({ p: { ".": "2.0.0", q: "1.0.0" } }).map((s) => s.key),
  ["p", "q"],
);

// --- classification ---------------------------------------------------------
// The live shape: major-line selectors that all bind, and nothing brittle.
const healthy = auditOverrides(
  { "brace-expansion@^2": "^2.1.4", "brace-expansion@^5": "^5.0.9", "fast-uri": "^3.1.5" },
  installed,
);
assert.deepEqual(healthy.dead, []);
assert.deepEqual(healthy.brittle, []);
assert.deepEqual(healthy.unevaluated, []);

// A bare-name key with an exact VALUE is a deliberate compat pin, not brittle —
// it binds whatever version is installed.
assert.deepEqual(auditOverrides({ fastify: "5.8.5" }, installed).brittle, []);

// THE REGRESSION: the 2026-08-02 shape. While minimatch is still 9.0.9 it binds,
// but the exact selector is flagged brittle...
const beforeBump = auditOverrides({ "minimatch@9.0.9": { "brace-expansion": "2.1.3" } }, installed);
assert.deepEqual(beforeBump.dead, []);
assert.equal(beforeBump.brittle.length, 1);
assert.equal(beforeBump.brittle[0].label, "minimatch@9.0.9");

// ...and the moment minimatch bumps, the whole entry silently stops applying. The parent
// is the single root cause, so the nested child is named in its message, not double-reported.
const bumped = collectInstalled({
  dependencies: {
    rimraf: {
      version: "5.0.10",
      dependencies: {
        minimatch: { version: "9.1.0", dependencies: { "brace-expansion": { version: "2.1.3" } } },
      },
    },
  },
});
const afterBump = auditOverrides({ "minimatch@9.0.9": { "brace-expansion": "2.1.3" } }, bumped);
assert.equal(afterBump.dead.length, 1, "an exact parent selector goes dead on an upstream bump");
assert.match(afterBump.dead[0].reason, /no installed "minimatch" matches "9\.0\.9"/);
assert.match(afterBump.dead[0].reason, /brace-expansion/, "the child it also kills is named");

// A nested child is only called dead when provably absent everywhere — npm hoisting means
// an installed child may not sit under its parent's node, and failing on that would be a
// false red. Present-somewhere => no finding; absent-everywhere => dead.
assert.deepEqual(auditOverrides({ "minimatch@^9": { "brace-expansion": "2.1.4" } }, installed).dead, []);
const ghostChild = auditOverrides({ "minimatch@^9": { "left-pad": "1.3.0" } }, installed);
assert.equal(ghostChild.dead.length, 1);
assert.match(ghostChild.dead[0].reason, /no "left-pad" is installed anywhere/);

// THE 2026-08-09 SHAPE: a security pin two levels down. The package it names must be
// audited like any other selector — checking only the first level reported the whole
// entry healthy even with the pinned package absent from the entire tree.
const deepTree = collectInstalled({
  dependencies: {
    "@sentropic/graphify": {
      version: "0.17.1",
      dependencies: {
        "ollama-ai-provider": {
          version: "1.2.0",
          dependencies: { nanoid: { version: "3.3.18" } },
        },
      },
    },
  },
});
const deepPin = { "@sentropic/graphify": { "ollama-ai-provider": { nanoid: "3.3.18" } } };
assert.deepEqual(auditOverrides(deepPin, deepTree).dead, [], "a deep pin that binds is not a finding");

const withoutNanoid = collectInstalled({
  dependencies: {
    "@sentropic/graphify": {
      version: "0.17.1",
      dependencies: { "ollama-ai-provider": { version: "1.2.0" } },
    },
  },
});
const rotted = auditOverrides(deepPin, withoutNanoid);
assert.equal(rotted.dead.length, 1, "the deepest selector is audited, not just the first level");
assert.equal(rotted.dead[0].label, "@sentropic/graphify > ollama-ai-provider > nanoid");
assert.match(rotted.dead[0].reason, /no "nanoid" is installed anywhere/);

// A dead parent names the full path of everything it takes down with it.
const deepParentGone = auditOverrides(deepPin, collectInstalled({ dependencies: {} }));
assert.match(deepParentGone.dead[0].reason, /ollama-ai-provider > nanoid/);

// A selector naming a package that is not installed at all is dead too.
assert.equal(auditOverrides({ "left-pad@^1": "^1.3.0" }, installed).dead.length, 1);
assert.match(auditOverrides({ "left-pad@^1": "^1.3.0" }, installed).dead[0].reason, /no "left-pad" is installed/);

// An unevaluable range is reported, never failed.
const exotic = auditOverrides({ "minimatch@>=9": "9.0.9" }, installed);
assert.deepEqual(exotic.dead, []);
assert.equal(exotic.unevaluated.length, 1);

// --- the degradation valve --------------------------------------------------
// It must stay SHUT on a sound tree, or the gate silently stops being a gate.
assert.equal(degradedReason({ dependencies: { fastify: { version: "5.8.5" } } }), null);
assert.equal(degradedReason({ dependencies: { fastify: { version: "5.8.5" } }, problems: [] }), null);

// ...and OPEN whenever npm could not describe the tree — "nothing is installed" and
// "selector matches nothing" are indistinguishable downstream, and this checkout is shared.
assert.match(degradedReason({}), /resolved no dependencies/);
assert.match(degradedReason({ dependencies: {} }), /resolved no dependencies/);
assert.match(degradedReason({ dependencies: { broken: { missing: true } } }), /resolved no dependencies/);
assert.match(
  degradedReason({ dependencies: { fastify: { version: "5.8.5" } }, problems: ["missing: x@1, required by y"] }),
  /reported 1 tree problem/,
);

// A partial install must not turn a healthy package.json red: same dead finding, no failure.
const quiet = () => {
  const original = console.log;
  console.log = () => {};
  return () => {
    console.log = original;
  };
};
let restore = quiet();
const hardFail = reportOverrides({ "left-pad@^1": "^1.3.0" }, installed, null);
const softWarn = reportOverrides({ "left-pad@^1": "^1.3.0" }, new Map(), "node_modules looks partial");
restore();
assert.equal(hardFail, false, "a dead selector on a sound tree fails");
assert.equal(softWarn, true, "the same finding on an unreadable tree warns instead of failing");

console.log("Dependency override audit tests passed.");
