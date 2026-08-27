const assert = require("node:assert/strict");
const { inspectAccountUsage, STALE_MS } = require("./account-usage-health.cjs");

const now = 1_000_000_000;
const row = (id, value) => ({ key: `account_usage_${id}`, value: typeof value === "string" ? value : JSON.stringify(value) });

let result = inspectAccountUsage([], now);
assert.deepEqual(result.records, []);
assert.match(result.issues[0], /no persisted account-usage/);

result = inspectAccountUsage([row("personal", { usageAt: now - 1, fiveHour: 12, sevenDay: 34 })], now);
assert.equal(result.records.length, 1);
assert.deepEqual(result.issues, []);

result = inspectAccountUsage([
  row("vota", { usageAt: now - STALE_MS - 1, fiveHour: null, sevenDay: 34 }),
  row("broken", "not json"),
  row("never", { usageAt: 0, fiveHour: null, sevenDay: null }),
], now);
assert.equal(result.records.length, 1);
assert.equal(result.issues.length, 4);
assert(result.issues.some((issue) => /stale/.test(issue)));
assert(result.issues.some((issue) => /incomplete/.test(issue)));
assert(result.issues.some((issue) => /valid JSON/.test(issue)));
assert(result.issues.some((issue) => /never been read/.test(issue)));

console.log("account-usage-health: all assertions passed");
