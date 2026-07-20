// Pure parsing tests for the SuperGrok `/usage show` weekly meter. No login, CLI, network, or DB required.
// Run: npx tsx src/tests/grokUsage.test.ts

import assert from "node:assert/strict";
import { parseGrokReset, parseGrokUsage } from "../agents/grokUsage.js";

const local = (year: number, month: number, day: number, hour: number, minute: number): number =>
  new Date(year, month, day, hour, minute, 0, 0).getTime();

const julyNow = local(2026, 6, 20, 4, 0);
const rendered = "Weekly limit: 37% · Next reset: July 27, 01:10";
assert.deepEqual(parseGrokUsage(rendered, julyNow), {
  sevenDay: 37,
  sevenDayReset: local(2026, 6, 27, 1, 10),
});

assert.equal(parseGrokReset("Next reset: Jan 2, 03:04", local(2026, 11, 31, 23, 0)), local(2027, 0, 2, 3, 4));
assert.equal(parseGrokReset("Next reset: February 31, 03:04", julyNow), null);
assert.deepEqual(parseGrokUsage("Weekly limit: 125% · Next reset: July 27, 01:10", julyNow), {
  sevenDay: 100,
  sevenDayReset: local(2026, 6, 27, 1, 10),
});
assert.deepEqual(parseGrokUsage("usage unavailable", julyNow), { sevenDay: null, sevenDayReset: null });

console.log("All Grok usage parser checks passed.");
