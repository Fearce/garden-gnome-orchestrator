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
const ROOT_DIR = path.resolve(SERVER_DIR, "..");

// Tests that must NOT be gates. A test belongs here only if running it costs money or
// needs live credentials; add the reason so the exemption stays reviewable.
const NOT_FREE = new Map();

const pkg = JSON.parse(fs.readFileSync(path.join(SERVER_DIR, "package.json"), "utf8"));
const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "package.json"), "utf8"));
const runner = fs.readFileSync(path.join(SERVER_DIR, "scripts", "run-gates.cjs"), "utf8");

assert.equal(
  rootPkg.scripts?.["test:gates"],
  "npm run test:gates --prefix server",
  "the repository-root `npm run test:gates` alias must keep the full registered suite discoverable",
);

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

// Every directory that holds test files, not just src/tests. 43 of this repo's tests are
// `scripts/*.test.cjs` — the probe/sweep/health half — and drift #2 hides there just as well:
// `inject-thread.test.cjs` was committed in b8b6e51 and had never once been run by the sweep.
// A script body may live in any workspace's package.json (the root `scripts/` tests are declared
// in server/package.json), so referencing is checked against all of them.
const TEST_DIRS = [
  path.join(ROOT_DIR, "scripts"),
  path.join(SERVER_DIR, "scripts"),
  path.join(SERVER_DIR, "src", "tests"),
  path.join(ROOT_DIR, "web", "scripts"),
];
const WORKSPACE_PKGS = [ROOT_DIR, SERVER_DIR, path.join(ROOT_DIR, "web"), path.join(ROOT_DIR, "relay")];

const scriptBodies = WORKSPACE_PKGS.filter((d) => fs.existsSync(path.join(d, "package.json"))).flatMap((d) =>
  Object.values(JSON.parse(fs.readFileSync(path.join(d, "package.json"), "utf8")).scripts ?? {}),
);

// `_`-prefixed files are throwaway scratch harnesses (see .claude/rules/e2e-a-pipeline-lane.md).
const testFiles = TEST_DIRS.filter((d) => fs.existsSync(d)).flatMap((dir) =>
  fs
    .readdirSync(dir)
    .filter((f) => /\.(test|itest)\.(cjs|mjs|ts|tsx)$/.test(f) && !f.startsWith("_"))
    .map((f) => ({ file: f, rel: path.relative(ROOT_DIR, path.join(dir, f)).split(path.sep).join("/") })),
);
// Matched on the file NAME, because a script body spells the path relative to its own workspace:
// `server/scripts/x.test.cjs` is referenced as `scripts/x.test.cjs` and the root one as
// `../scripts/…`. That is only sound while the names are unique, so require it — two same-named
// tests in different directories would otherwise let one vouch for the other.
const byName = new Map();
for (const t of testFiles) byName.set(t.file, [...(byName.get(t.file) ?? []), t.rel]);
const collisions = [...byName.values()].filter((rels) => rels.length > 1);
assert.deepEqual(
  collisions,
  [],
  `test file name(s) reused across directories — one would vouch for the other: ${collisions.flat().join(", ")}`,
);

const unreferenced = testFiles.filter((t) => !scriptBodies.some((cmd) => cmd.includes(t.file))).map((t) => t.rel);
assert.deepEqual(
  unreferenced,
  [],
  `test file(s) with no npm script — nothing can run them: ${unreferenced.join(", ")}`,
);

console.log(
  `Gate registration OK — ${testScripts.length} test script(s) all registered, ${testFiles.length} test file(s) across ${TEST_DIRS.length} directories all reachable.`,
);
