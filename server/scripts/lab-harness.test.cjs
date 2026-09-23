const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const childProcess = require("node:child_process");

// The harness destructures spawn at load, so the stub must be in place for the require and only then.
const spawned = [];
const realSpawn = childProcess.spawn;
childProcess.spawn = (_cmd, _args, opts) => {
  spawned.push(opts);
  return { stdout: new PassThrough(), stderr: new PassThrough() };
};
const { SERVER_ROOT, requireBuild, boxBounds, labWebDist, labChildEnv, boot } = require("./lab-harness.cjs");
childProcess.spawn = realSpawn;

const original = {
  exists: fs.existsSync,
  exit: process.exit,
  error: console.error,
  entry: process.env.GGO_LAB_ENTRY,
  webDist: process.env.GGO_LAB_WEB_DIST,
};
const isolatedWeb = path.join(SERVER_ROOT, ".lab-web-dist");
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
  delete process.env.GGO_LAB_WEB_DIST;
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

  // Every instance is pinned to a bundle, so none runs its own auto-builder over the live web/dist.
  delete process.env.GGO_LAB_ENTRY;
  delete process.env.GGO_LAB_WEB_DIST;
  assert.equal(labWebDist(), path.dirname(web), "a lab serves the checkout's bundle by default");
  assert.equal(labChildEnv({ dataDir: "d", port: 5999 }).WEB_DIST, path.dirname(web), "the default is pinned too");
  process.env.GGO_LAB_WEB_DIST = ".lab-web-dist";
  assert.equal(labWebDist(), isolatedWeb, "GGO_LAB_WEB_DIST resolves from the server cwd, like GGO_LAB_ENTRY");
  assert.equal(labChildEnv({ dataDir: "d", port: 5999 }).WEB_DIST, isolatedWeb);
  assert.equal(labChildEnv({ dataDir: "d", port: 5999, env: { WEB_DIST: "x" } }).WEB_DIST, "x", "a lab's own env still wins");
  files = new Set([production, web]);
  assert.throws(() => requireBuild(), /exit 2/, "the live bundle must not mask a missing isolated web build");
  assert.ok(errors.pop().includes(path.join(isolatedWeb, "index.html")));
  files = new Set([production, path.join(isolatedWeb, "index.html")]);
  assert.doesNotThrow(() => requireBuild(), "an isolated web build needs no live web/dist");
  console.log("Lab build gate passed: default, isolated, explicit and relative entries; pinned web bundles; missing server/web artifacts.");
} finally {
  fs.existsSync = original.exists; process.exit = original.exit; console.error = original.error;
  if (original.entry === undefined) delete process.env.GGO_LAB_ENTRY;
  else process.env.GGO_LAB_ENTRY = original.entry;
  if (original.webDist === undefined) delete process.env.GGO_LAB_WEB_DIST;
  else process.env.GGO_LAB_WEB_DIST = original.webDist;
}

// labChildEnv alone proves nothing if boot() stops using it: every lab would race prod's auto-builder again.
(async () => {
  const realFetch = globalThis.fetch;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lab-harness-boot-"));
  globalThis.fetch = async () => ({ ok: true });
  process.env.GGO_LAB_WEB_DIST = ".lab-web-dist";
  try {
    const child = await boot({ dataDir, port: 5999 });
    child.stdout.end();
    child.stderr.end();
    assert.equal(spawned.length, 1, "boot() spawns exactly one instance");
    assert.equal(spawned[0].env.WEB_DIST, isolatedWeb, "boot() pins the instance to the lab's web bundle");
    assert.equal(spawned[0].env.DATA_DIR, dataDir);
    console.log("Lab boot gate passed: the spawned instance carries the pinned WEB_DIST.");
  } finally {
    globalThis.fetch = realFetch;
    if (original.webDist === undefined) delete process.env.GGO_LAB_WEB_DIST;
    else process.env.GGO_LAB_WEB_DIST = original.webDist;
    await new Promise((r) => setTimeout(r, 50));
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
