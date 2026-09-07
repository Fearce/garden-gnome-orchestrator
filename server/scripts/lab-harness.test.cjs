const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { SERVER_ROOT, requireBuild, boxBounds } = require("./lab-harness.cjs");

const original = { exists: fs.existsSync, exit: process.exit, error: console.error, entry: process.env.GGO_LAB_ENTRY };
const production = path.join(SERVER_ROOT, "dist", "index.js");
const isolated = path.join(SERVER_ROOT, ".ide-lab-dist", "index.js");
const explicit = path.join(SERVER_ROOT, "data", "custom-lab", "index.js");
const web = path.resolve(SERVER_ROOT, "../web/dist/index.html");
let files = new Set(), errors = [];
try {
  assert.deepEqual(
    boxBounds({ x: 12.5, y: 8, width: 30, height: 44 }),
    { left: 12.5, top: 8, right: 42.5, bottom: 52, width: 30, height: 44 },
    "Playwright boxes gain explicit right/bottom edges",
  );
  assert.equal(boxBounds(null), null, "a missing element remains an explicit failed geometry input");
  assert.equal(boxBounds({ x: 0, y: 0, width: Number.NaN, height: 1 }), null, "non-finite geometry is rejected");

  fs.existsSync = file => files.has(file);
  process.exit = code => { throw new Error(`exit ${code}`); };
  console.error = text => errors.push(text);
  delete process.env.GGO_LAB_ENTRY;
  files = new Set([production, web]);
  assert.doesNotThrow(() => requireBuild());

  process.env.GGO_LAB_ENTRY = ".ide-lab-dist/index.js";
  files = new Set([isolated, web]);
  assert.doesNotThrow(() => requireBuild(), "isolated build must not require production dist");
  files = new Set([production, web]);
  assert.throws(() => requireBuild(), /exit 2/, "production dist must not mask a missing selected build");
  assert.ok(errors.pop().includes(isolated), "failure names the actual missing entry");

  files = new Set([explicit, web]);
  assert.doesNotThrow(() => requireBuild(explicit), "explicit entry takes precedence over the environment");
  assert.doesNotThrow(() => requireBuild(path.relative(SERVER_ROOT, explicit)), "relative entry resolves from the server cwd");
  files = new Set([isolated]);
  assert.throws(() => requireBuild(), /exit 2/, "isolated server still needs a web build");
  assert.ok(errors.pop().includes(web));
  console.log("Lab build gate passed: default, isolated, explicit and relative entries; missing server/web artifacts.");
} finally {
  fs.existsSync = original.exists; process.exit = original.exit; console.error = original.error;
  if (original.entry === undefined) delete process.env.GGO_LAB_ENTRY;
  else process.env.GGO_LAB_ENTRY = original.entry;
}
