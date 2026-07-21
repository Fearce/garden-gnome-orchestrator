// Unit test for the "spread usage" selection comparator (pure logic — no accounts, no DB, no network).
// Run: npx tsx src/tests/spreadUsage.test.ts   (or `npm run test:spread-usage`)
//
// `bySpreadUsage` is the order select()/selectFailover()/dispatchPreview() apply when the operator's
// "Spread usage" toggle is on: always target the sub with the lowest weekly usage (most weekly headroom)
// to balance burn across subscriptions, breaking ties by 5h headroom then least-recently-picked.

import { bySpreadUsage } from "../accounts/accountManager.js";

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}`);
  }
}

type Cand = { id: string; fiveHour: number | null; sevenDay: number | null; lastPick: number };
const a = (id: string, sevenDay: number | null, fiveHour: number | null = 0, lastPick = 0): Cand => ({
  id,
  sevenDay,
  fiveHour,
  lastPick,
});
const ids = (cs: Cand[]) => cs.map((c) => c.id).join(",");

console.log("spread-usage: bySpreadUsage");

// Lowest weekly usage wins outright — the balancing goal.
check("lowest weekly usage sorts first", ids([a("A", 70), a("B", 20), a("C", 45)].sort(bySpreadUsage)) === "B,C,A");

// Weekly usage dominates 5h headroom: a sub with less weekly usage wins even with a hotter 5h window.
check("weekly usage beats 5h", ids([a("A", 60, 5), a("B", 30, 95)].sort(bySpreadUsage)) === "B,A");

// Equal weekly usage → 5h headroom breaks the tie (lower 5h usage first).
check("equal weekly → lower 5h wins", ids([a("A", 40, 80), a("B", 40, 10)].sort(bySpreadUsage)) === "B,A");

// Equal weekly AND 5h → least-recently-picked wins, so repeated dispatches rotate instead of sticking.
check("equal usage → least-recently-picked wins", ids([a("A", 40, 20, 9), a("B", 40, 20, 3)].sort(bySpreadUsage)) === "B,A");

// Null usage (pre-ping) counts as 0 — treated as the emptiest sub, so it's targeted first.
check("null weekly usage counts as 0 (targeted first)", ids([a("A", 50), a("B", null)].sort(bySpreadUsage)) === "B,A");

if (failures) {
  console.error(`\n${failures} spread-usage check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll spread-usage checks passed.");
