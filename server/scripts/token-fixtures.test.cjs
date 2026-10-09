#!/usr/bin/env node

const assert = require("node:assert/strict");
const { isFixtureToken, realTokensInDiff } = require("./token-fixtures.cjs");

const ANTHROPIC = "sk-ant-[A-Za-z0-9_-]{20,}";
const fixture = ["sk", "ant", "oat01", "test", "routine", "token"].join("-");
const random = ["sk", "ant", "oat01", "Qm9xR2vT_8kLw3nZpY7uA1cD4eF6gH0j"].join("-");
const testLike = ["sk", "ant", "oat01", "testRoutine8kLw3nZpY7uA1cD4eF6gH"].join("-");

assert.equal(isFixtureToken(fixture), true, "a token spelling `test` as a segment is a fixture");
assert.equal(isFixtureToken(random), false, "a random tail is a real credential");
assert.equal(isFixtureToken(testLike), false, "a word glued into a random segment is not a fixture marker");

const diff = (...lines) => ["diff --git a/x b/x", "--- a/x", "+++ b/x", ...lines].join("\n");
assert.deepEqual(realTokensInDiff(diff(`-const token = "${fixture}";`), ANTHROPIC), [], "a fixture-only commit is not a leak");
assert.deepEqual(realTokensInDiff(diff(`+const token = "${random}";`), ANTHROPIC), [random], "a real token is still reported");
assert.deepEqual(
  realTokensInDiff(diff(`+const a = "${fixture}", b = "${random}";`), ANTHROPIC),
  [random],
  "a fixture beside a real token on one line does not hide it",
);
assert.deepEqual(realTokensInDiff(diff(` unchanged "${random}"`), ANTHROPIC), [], "context lines were not added or removed by the commit");

console.log("token fixtures gate: all checks passed");
