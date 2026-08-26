#!/usr/bin/env node
const assert = require("node:assert/strict");

const {
  compareBundles,
  entryBundle,
  normalizeProviderPayload,
  parseOptions,
  validateProviders,
} = require("./console-smoke.cjs");

const defaults = parseOptions([], {});
assert.equal(defaults.base, "http://127.0.0.1:4317");
assert.equal(defaults.providers, false);
assert.equal(defaults.expectLocalBundle, false);

const options = parseOptions([
  "--url", "http://127.0.0.1:4999/",
  "--providers",
  "--expect-provider-ids", "gemini, groq,gemini",
  "--forbid-provider-ids", "openrouter",
  "--expect-provider-count", "2",
  "--expect-local-bundle",
], {});
assert.equal(options.base, "http://127.0.0.1:4999/");
assert.deepEqual(options.expectedProviderIds, ["gemini", "groq"], "CSV ids are trimmed and deduplicated");
assert.deepEqual(options.forbiddenProviderIds, ["openrouter"]);
assert.equal(options.expectedProviderCount, 2);
assert.equal(options.providers, true);
assert.equal(options.expectLocalBundle, true);
assert.equal(parseOptions(["--forbid-provider-ids", "retired"], {}).providers, true, "an assertion implies provider inspection");
assert.throws(() => parseOptions(["--expect-provider-count", "2.5"], {}), /non-negative integer/);
assert.throws(() => parseOptions(["--expect-provider-ids", "--providers"], {}), /requires a value/);
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

const passing = { expectedProviderIds: ["gemini", "groq"], forbiddenProviderIds: ["openrouter"], expectedProviderCount: 2 };
assert.deepEqual(validateProviders(providers, passing), []);
assert.match(validateProviders(providers, { ...passing, expectedProviderIds: ["groq", "gemini"] })[0], /provider ids differ/);
assert.match(validateProviders(providers, { ...passing, expectedProviderCount: 3 })[0], /provider count differs/);
assert.match(validateProviders(providers, { ...passing, forbiddenProviderIds: ["groq"] })[0], /still exposed/);
assert.match(validateProviders([...providers, providers[0]], { expectedProviderIds: null, forbiddenProviderIds: [], expectedProviderCount: null })[0], /duplicate/);

console.log("console-smoke: provider and bundle assertions passed");
