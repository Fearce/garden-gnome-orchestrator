#!/usr/bin/env node
// Gate: every test in this repo is actually reachable by the nightly sweep.
//
// Two drifts this catches, both of which shipped silently before:
//   1. a test:* script that exists but was never added to GATES in run-gates.cjs
//   2. a test file under src/tests that has no npm script at all (gitService.itest.ts
//      sat unrun for its whole life while documenting a `npm run test:git` that didn't exist)
// Either way the test still passes locally on demand, so nothing goes red — it just
// stops being a gate, which is the failure mode `test:gates`'s count can't reveal.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SERVER_DIR = path.resolve(__dirname, "..");

// Tests that must NOT be gates. A test belongs here only if running it costs money or
// needs live credentials; add the reason so the exemption stays reviewable.
const NOT_FREE = new Map();

const pkg = JSON.parse(fs.readFileSync(path.join(SERVER_DIR, "package.json"), "utf8"));
const runner = fs.readFileSync(path.join(SERVER_DIR, "scripts", "run-gates.cjs"), "utf8");

/** The GATES array literal, so a gate name mentioned only in a comment doesn't count. */
function registeredGates() {
  const block = runner.match(/const GATES = \[([\s\S]*?)\];/);
  assert.ok(block, "run-gates.cjs no longer declares a `const GATES = [...]` array");
  return new Set(Array.from(block[1].matchAll(/"([^"]+)"/g), (m) => m[1]));
}

const gates = registeredGates();
const testScripts = Object.keys(pkg.scripts).filter((s) => s.startsWith("test:") && s !== "test:gates");

const unregistered = testScripts.filter((s) => !gates.has(s) && !NOT_FREE.has(s));
assert.deepEqual(
  unregistered,
  [],
  `test:* script(s) missing from GATES in scripts/run-gates.cjs — the nightly sweep would never run them: ${unregistered.join(", ")}`,
);

const stale = [...gates].filter((g) => !pkg.scripts[g]);
assert.deepEqual(stale, [], `GATES lists script(s) that no longer exist in package.json: ${stale.join(", ")}`);

const exempted = [...NOT_FREE.keys()].filter((s) => gates.has(s));
assert.deepEqual(exempted, [], `script(s) marked NOT_FREE but still registered as a gate: ${exempted.join(", ")}`);

// `_`-prefixed files are throwaway scratch harnesses (see .claude/rules/e2e-a-pipeline-lane.md).
const testFiles = fs
  .readdirSync(path.join(SERVER_DIR, "src", "tests"))
  .filter((f) => /\.(test|itest)\.ts$/.test(f) && !f.startsWith("_"));
const scriptBodies = Object.values(pkg.scripts);
const unreferenced = testFiles.filter((f) => !scriptBodies.some((cmd) => cmd.includes(`src/tests/${f}`)));
assert.deepEqual(
  unreferenced,
  [],
  `test file(s) with no npm script — nothing can run them: ${unreferenced.join(", ")}`,
);

console.log(
  `Gate registration OK — ${testScripts.length} test script(s) all registered, ${testFiles.length} test file(s) all reachable.`,
);
