#!/usr/bin/env node

const assert = require("node:assert/strict");
const { isFixtureToken, realTokensInDiff, isFixtureOnlyDiff } = require("./token-fixtures.cjs");

const ANTHROPIC = "sk-ant-[A-Za-z0-9_-]{20,}";
const fixture = ["sk", "ant", "oat01", "test", "routine", "token"].join("-");
const random = ["sk", "ant", "oat01", "Qm9xR2vT_8kLw3nZpY7uA1cD4eF6gH0j"].join("-");
const testLike = ["sk", "ant", "oat01", "testRoutine8kLw3nZpY7uA1cD4eF6gH"].join("-");
const randomWithMarker = ["sk", "ant", "oat01", "test", "Qm9xR2vT_8kLw3nZpY7uA1cD4eF6gH0j"].join("-");
const fixturePath = "server/src/tests/cloudSessions.test.ts";

assert.equal(isFixtureToken(fixture, fixturePath), true, "the audited test fixture is exempted");
assert.equal(isFixtureToken(random), false, "a random tail is a real credential");
assert.equal(isFixtureToken(testLike), false, "a word glued into a random segment is not a fixture marker");
assert.equal(isFixtureToken(randomWithMarker, fixturePath), false, "a fixture word amid random segments must not hide a credential");
assert.equal(isFixtureToken(fixture, "server/src/config.ts"), false, "a fixture-shaped value in production code must still be reported");
assert.equal(isFixtureToken(fixture), false, "an unknown path cannot authorize a fixture exemption");

const diff = (...lines) => [`diff --git a/${fixturePath} b/${fixturePath}`, `--- a/${fixturePath}`, `+++ b/${fixturePath}`, ...lines].join("\n");
assert.deepEqual(realTokensInDiff(diff(`-const token = "${fixture}";`), ANTHROPIC), [], "a fixture-only commit is not a leak");
assert.deepEqual(realTokensInDiff(diff(`+const token = "${random}";`), ANTHROPIC), [random], "a real token is still reported");
assert.deepEqual(
  realTokensInDiff(diff(`+const a = "${fixture}", b = "${random}";`), ANTHROPIC),
  [random],
  "a fixture beside a real token on one line does not hide it",
);
assert.deepEqual(realTokensInDiff(diff(` unchanged "${random}"`), ANTHROPIC), [], "context lines were not added or removed by the commit");
assert.equal(isFixtureOnlyDiff(diff(`-const token = "${fixture}";`), ANTHROPIC), true);
assert.equal(isFixtureOnlyDiff("", ANTHROPIC), false, "a failed diff read must not hide a history match");
assert.equal(isFixtureOnlyDiff(diff(` unchanged "${fixture}"`), ANTHROPIC), false, "context alone is not fixture proof");
assert.equal(isFixtureOnlyDiff(diff(`+const a = "${fixture}", b = "${randomWithMarker}";`), ANTHROPIC), false);
assert.deepEqual(realTokensInDiff(`--- a/server/src/config.ts\n+++ b/server/src/config.ts\n+const token = "${fixture}";`, ANTHROPIC), [fixture]);
assert.deepEqual(realTokensInDiff(`--- a/${fixturePath}\n+++ b/server/src/config.ts\n-const token = "${fixture}";\n+const token = "${fixture}";`, ANTHROPIC), [fixture], "a fixture moved into production is a leak");

console.log("token fixtures gate: all checks passed");
