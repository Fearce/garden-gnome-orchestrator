#!/usr/bin/env node
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  SMALL_TASK_POLICY_LABEL,
  compareBundles,
  entryBundle,
  localUiBundleText,
  normalizeProviderPayload,
  normalizeRoutingPolicy,
  parseOptions,
  validateProviders,
  validateSmallTaskBundle,
  validateSmallTaskPolicy,
  validateUiBundleText,
  within,
  watchConsoleSnapshot,
} = require("./console-smoke.cjs");

const defaults = parseOptions([], {});
assert.equal(defaults.base, "http://127.0.0.1:4317");
assert.equal(defaults.providers, false);
assert.equal(defaults.expectLocalBundle, false);

const options = parseOptions([
  "--url", "http://127.0.0.1:4999/",
  "--providers",
  "--expect-provider-ids", "gemini, groq,gemini",
  "--forbid-provider-ids", "retired-provider",
  "--expect-provider-count", "2",
  "--expect-local-bundle",
  "--expect-small-task-policy",
  "--expect-ui-text", "Capacity-paused work always resumes",
  "--forbid-ui-text", "Auto-resume on token reset",
], {});
assert.equal(options.base, "http://127.0.0.1:4999/");
assert.deepEqual(options.expectedProviderIds, ["gemini", "groq"], "CSV ids are trimmed and deduplicated");
assert.deepEqual(options.forbiddenProviderIds, ["retired-provider"]);
assert.equal(options.expectedProviderCount, 2);
assert.equal(options.providers, true);
assert.equal(options.expectLocalBundle, true);
assert.equal(options.expectSmallTaskPolicy, true);
assert.deepEqual(options.expectedUiText, ["Capacity-paused work always resumes"]);
assert.deepEqual(options.forbiddenUiText, ["Auto-resume on token reset"]);
assert.equal(options.expectLocalBundle, true, "UI text assertions also prove the served entry matches the local build");
assert.equal(parseOptions(["--forbid-provider-ids", "retired"], {}).providers, true, "an assertion implies provider inspection");
assert.equal(parseOptions(["--expect-small-task-policy"], {}).providers, true, "the policy assertion implies provider inspection");
assert.throws(() => parseOptions(["--expect-provider-count", "2.5"], {}), /non-negative integer/);
assert.throws(() => parseOptions(["--expect-provider-ids", "--providers"], {}), /requires a value/);
assert.throws(() => parseOptions(["--expect-ui-text", "--providers"], {}), /requires a value/);
assert.throws(() => parseOptions(["--typo"], {}), /unknown argument/);

assert.equal(
  entryBundle('<script type="module" crossorigin src="/assets/index-AbC_123.js"></script>'),
  "/assets/index-AbC_123.js",
);
assert.equal(entryBundle("<script src='/nested/assets/index-z.js'></script>"), "/nested/assets/index-z.js");
assert.equal(entryBundle("<script src='/assets/vendor-z.js'></script>"), null);
assert.deepEqual(
  compareBundles("/assets/index-live.js", '<script type="module" src="/assets/index-live.js"></script>', "http://127.0.0.1:4317"),
  { local: "/assets/index-live.js", served: "/assets/index-live.js", failures: [] },
);
assert.match(compareBundles("/assets/index-old.js", '<script src="/assets/index-new.js"></script>', "http://local").failures[0], /differs/);
assert.match(compareBundles("", '<script src="/assets/index-new.js"></script>', "http://local").failures[0], /served page has no/);
assert.match(compareBundles("/assets/index-new.js", "<html></html>", "http://local").failures[0], /local web\/dist/);

const dist = fs.mkdtempSync(path.join(os.tmpdir(), "console-current-assets-"));
try {
  const assets = path.join(dist, "assets");
  fs.mkdirSync(assets);
  fs.writeFileSync(path.join(dist, "index.html"), '<script type="module" src="/nested/assets/index-current.js"></script>');
  fs.writeFileSync(path.join(assets, "index-current.js"),
    'import{value}from"./shared.js";import("./lazy.js");' +
    'const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["./preload.js","./style.css"])))=>i.map(i=>d[i]);');
  fs.writeFileSync(path.join(assets, "shared.js"), 'export{value}from"./index-current.js";');
  fs.writeFileSync(path.join(assets, "lazy.js"), `export default ${JSON.stringify(SMALL_TASK_POLICY_LABEL)};`);
  fs.writeFileSync(path.join(assets, "preload.js"), 'export default "current preload dependency";');
  fs.writeFileSync(path.join(assets, "index-retired.js"), `const label=${JSON.stringify(SMALL_TASK_POLICY_LABEL)};const stale="retired UI text";`);
  fs.writeFileSync(path.join(assets, "unreferenced.js"), 'unreferenced retained asset');
  const read = fs.readFileSync;
  const opened = [];
  fs.readFileSync = (file, ...args) => { opened.push(path.basename(file)); return read(file, ...args); };
  let current;
  try { current = localUiBundleText(dist); } finally { fs.readFileSync = read; }
  assert.equal(validateSmallTaskBundle(current).length, 0, "the current lazy Settings label is inspected");
  assert.ok(current.includes("current preload dependency"), "Vite preload dependencies are followed");
  assert.ok(!current.includes("retired UI text"), "stale builds cannot fail current text checks");
  assert.deepEqual(opened.sort(), ["index.html", "index-current.js", "lazy.js", "preload.js", "shared.js"].sort(),
    "only current reachable JavaScript is read, with shared/cyclic imports read once");
  fs.writeFileSync(path.join(assets, "lazy.js"), 'export default "current label removed";');
  assert.equal(validateSmallTaskBundle(localUiBundleText(dist)).length, 1,
    "a retired label cannot hide a missing current label");
  fs.unlinkSync(path.join(assets, "shared.js"));
  assert.throws(() => localUiBundleText(dist), /ENOENT/, "missing current dependencies fail closed");
  fs.writeFileSync(path.join(assets, "shared.js"), 'import"../../outside.js";');
  assert.throws(() => localUiBundleText(dist), /escapes dist\/assets/, "dependencies cannot leave the build");
} finally {
  fs.rmSync(dist, { recursive: true, force: true });
}

const providers = normalizeProviderPayload({ providers: [
  { id: "gemini", configured: true, keySource: "stored", health: { state: "ready" }, usage: { displayLabel: "Quota not exposed" } },
  { id: "groq", configured: false, health: { state: "awaiting-auth" }, usage: {} },
] });
assert.deepEqual(providers, [
  { id: "gemini", configured: true, keySource: "stored", state: "ready", usage: "Quota not exposed" },
  { id: "groq", configured: false, keySource: "unknown", state: "awaiting-auth", usage: "" },
]);
assert.throws(() => normalizeProviderPayload({}), /no providers array/);
assert.throws(() => normalizeProviderPayload({ providers: [{}] }), /row 1 has no provider id/);

const passing = { expectedProviderIds: ["gemini", "groq"], forbiddenProviderIds: ["retired-provider"], expectedProviderCount: 2 };
assert.deepEqual(validateProviders(providers, passing), []);
assert.match(validateProviders(providers, { ...passing, expectedProviderIds: ["groq", "gemini"] })[0], /provider ids differ/);
assert.match(validateProviders(providers, { ...passing, expectedProviderCount: 3 })[0], /provider count differs/);
assert.match(validateProviders(providers, { ...passing, forbiddenProviderIds: ["groq"] })[0], /still exposed/);
assert.match(validateProviders([...providers, providers[0]], { expectedProviderIds: null, forbiddenProviderIds: [], expectedProviderCount: null })[0], /duplicate/);

const routing = normalizeRoutingPolicy({
  routing: {
    enabled: true,
    active: true,
    reason: "One provider has capacity.",
    policy: {
      mode: "small-only",
      summary: "First attempt only: broad and uncertain work stays reliable.",
      maxModelCalls: 4,
      maxToolCalls: 10,
      maxTotalTokens: 8_000,
      requireVisibleQuota: true,
    },
  },
});
assert.deepEqual(routing, {
  enabled: true,
  active: true,
  reason: "One provider has capacity.",
  mode: "small-only",
  summary: "First attempt only: broad and uncertain work stays reliable.",
  maxModelCalls: 4,
  maxToolCalls: 10,
  maxTotalTokens: 8_000,
  requireVisibleQuota: true,
});
assert.deepEqual(validateSmallTaskPolicy(routing), []);
assert.match(validateSmallTaskPolicy(null)[0], /no routing policy/);
assert.match(validateSmallTaskPolicy({ ...routing, mode: "all-tasks" })[0], /expected "small-only"/);
assert.match(validateSmallTaskPolicy({ ...routing, maxModelCalls: null })[0], /maxModelCalls/);
assert.match(validateSmallTaskPolicy({ ...routing, summary: "" })[0], /owner-facing summary/);
assert.deepEqual(validateSmallTaskBundle(`before ${SMALL_TASK_POLICY_LABEL} after`), []);
assert.match(validateSmallTaskBundle("Use free pool")[0], /built UI assets/);
assert.deepEqual(
  validateUiBundleText("Capacity-paused work always resumes", ["Capacity-paused work always resumes"], ["Auto-resume on token reset"]),
  [],
);
assert.deepEqual(
  validateUiBundleText("Auto-resume on token reset", ["Capacity-paused work always resumes"], ["Auto-resume on token reset"]),
  [
    'built UI assets do not contain "Capacity-paused work always resumes"',
    'built UI assets still contain forbidden text "Auto-resume on token reset"',
  ],
);

void (async () => {
  const page = new EventEmitter();
  const socket = new EventEmitter();
  const snapshot = watchConsoleSnapshot(page);
  page.emit("websocket", socket);
  for (const payload of ['not JSON', '{"type":"settings"}', '{"type":"hello"}']) {
    socket.emit("framereceived", { payload });
  }
  await assert.rejects(within(snapshot, 10, "missing hello"), /missing hello exceeded/,
    "an open socket and unrelated or malformed frames cannot pass readiness");
  socket.emit("framereceived", { payload: JSON.stringify({ type: "hello", threads: [{}], accounts: [{}, {}] }) });
  assert.deepEqual(await snapshot, { threads: 1, accounts: 2 }, "a delayed snapshot is observed");
  const emptyPage = new EventEmitter();
  const emptySocket = new EventEmitter();
  const emptySnapshot = watchConsoleSnapshot(emptyPage);
  emptyPage.emit("websocket", emptySocket);
  emptySocket.emit("framereceived", { payload: JSON.stringify({ type: "hello", threads: [], accounts: [] }) });
  assert.deepEqual(await emptySnapshot, { threads: 0, accounts: 0 }, "empty installations remain valid");
  assert.equal(await within(Promise.resolve("ready"), 20, "immediate operation"), "ready");
  await assert.rejects(within(new Promise(() => {}), 10, "stalled operation"), /stalled operation exceeded 10ms/);
  console.log("console-smoke: provider, routing-policy, bundle, and timeout assertions passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
