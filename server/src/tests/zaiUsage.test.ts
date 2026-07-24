// Pure parsing + meter-cap tests for z.ai (GLM Coding Plan) usage. No network, key, or DB required.
// Run: npx tsx src/tests/zaiUsage.test.ts
//
// The load-bearing logic is parseZaiQuota's window classification: the endpoint returns several `limits`
// entries and only the (unit, number)-tagged TOKENS_LIMIT ones are the 5-hour + weekly windows we route on.
// This is the canonical mapping verified against the live endpoint and the opencode-glm-quota reference.

import assert from "node:assert/strict";
import { parseZaiQuota, noteZaiUsage, zaiUsageCapped } from "../agents/zaiUsage.js";

// The real endpoint response shape (from a live GET, key redacted): a TIME_LIMIT MCP-monthly entry, a
// 5-hour TOKENS_LIMIT (unit=3,number=5) idle at 0% with no reset yet, and a weekly TOKENS_LIMIT
// (unit=6,number=1) at 9% with a ~7-day reset. Plan tier is data.level.
const liveBody = {
  code: 200,
  msg: "Operation successful",
  data: {
    limits: [
      { type: "TIME_LIMIT", unit: 5, number: 1, usage: 100, currentValue: 0, remaining: 100, percentage: 0, nextResetTime: 1787519845989 },
      { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 0 },
      { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 9, nextResetTime: 1785446245998 },
    ],
    level: "lite",
  },
  success: true,
};

const parsed = parseZaiQuota(liveBody);
assert.ok(parsed, "live body should parse");
assert.equal(parsed!.plan, "lite");
assert.equal(parsed!.fiveHour, 0);
assert.equal(parsed!.fiveHourReset, null, "an idle 5h window carries no reset");
assert.equal(parsed!.sevenDay, 9);
assert.equal(parsed!.sevenDayReset, 1785446245998);

// A consumed 5-hour window (with a real reset) is decoded from the same unit=3,number=5 tag.
const busy = parseZaiQuota({
  data: {
    level: "pro",
    limits: [
      { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 62, nextResetTime: 111 },
      { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 40, nextResetTime: 222 },
    ],
  },
});
assert.ok(busy);
assert.deepEqual(busy, { plan: "pro", fiveHour: 62, fiveHourReset: 111, sevenDay: 40, sevenDayReset: 222 });

// Only the weekly window present → the 5h stays null (the MCP TIME_LIMIT is ignored, not miscounted as 5h).
const weeklyOnly = parseZaiQuota({
  data: { level: "max", limits: [{ type: "TIME_LIMIT", unit: 5, number: 1, percentage: 3 }, { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 12, nextResetTime: 999 }] },
});
assert.ok(weeklyOnly);
assert.equal(weeklyOnly!.fiveHour, null);
assert.equal(weeklyOnly!.sevenDay, 12);

// Unrecognized / empty bodies → null (caller keeps the last good meter rather than blanking it).
assert.equal(parseZaiQuota({ data: { limits: [{ type: "TIME_LIMIT", unit: 5, number: 1, percentage: 0 }] } }), null, "MCP-only body has no token windows");
assert.equal(parseZaiQuota({ data: { limits: [] } }), null);
assert.equal(parseZaiQuota({ data: {} }), null);
assert.equal(parseZaiQuota(null), null);
assert.equal(parseZaiQuota("nonsense"), null);

// Cap detection: either window at 100% with a future (or unknown) reset caps z.ai; a passed reset clears it.
const now = 1_800_000_000_000;
const future = now + 3_600_000;
noteZaiUsage({ plan: "lite", fiveHour: 40, fiveHourReset: future, sevenDay: 20, sevenDayReset: future });
assert.equal(zaiUsageCapped(now), false);
noteZaiUsage({ plan: "lite", fiveHour: 100, fiveHourReset: future, sevenDay: 20, sevenDayReset: future });
assert.equal(zaiUsageCapped(now), true, "5h window fully spent caps z.ai");
noteZaiUsage({ plan: "lite", fiveHour: 30, fiveHourReset: future, sevenDay: 100, sevenDayReset: future });
assert.equal(zaiUsageCapped(now), true, "weekly window fully spent caps z.ai");
noteZaiUsage({ plan: "lite", fiveHour: 100, fiveHourReset: now - 1000, sevenDay: 30, sevenDayReset: future });
assert.equal(zaiUsageCapped(now), false, "a 5h window whose reset already passed is not capped");

console.log("All z.ai usage parser checks passed.");
