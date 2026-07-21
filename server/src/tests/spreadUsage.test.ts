// Unit test for the "spread usage" selection comparator (pure logic — no accounts, no DB, no network).
// Run: npx tsx src/tests/spreadUsage.test.ts   (or `npm run test:spread-usage`)
//
// `bySpreadUsage` is the order select()/selectFailover()/dispatchPreview() apply when the operator's
// "Spread usage" toggle is on: always target the sub with the lowest weekly usage (most weekly headroom)
// to balance burn across subscriptions, breaking ties by 5h headroom then least-recently-picked.
// This file ALSO exercises `providerSpreadUsage` — the cross-backend order `preferredImplementorProvider`
// applies with the same toggle on, so the dispatch balances across Claude/Codex/Grok, not just Claude subs.

import { bySpreadUsage } from "../accounts/accountManager.js";
import { providerSpreadUsage, type ProviderCandidate } from "../orchestrator/threadManager.js";

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

// Cross-provider (Claude / Codex / Grok) balancing — `preferredImplementorProvider` flips to this order
// when the toggle is on, so the whole dispatch targets the platform with the lowest weekly usage, not
// just the lowest-usage Claude sub. It picks the winner via reduce(min under the comparator).
console.log("\nspread-usage: providerSpreadUsage (cross-backend)");

type PC = ProviderCandidate;
const pc = (provider: PC["provider"], sevenDay: number | null, fiveHour: number | null = 0, sevenDayReset: number | null = null): PC => ({
  provider,
  hasHeadroom: true,
  fiveHour,
  sevenDay,
  sevenDayReset,
  weeklySafetyPct: 100,
});
// reduce(min) mirrors preferredImplementorProvider's winner selection.
const winner = (cs: PC[]): string => cs.reduce((best, c) => (providerSpreadUsage(best, c) <= 0 ? best : c)).provider;

check("lowest weekly usage provider wins", winner([pc("claude", 70), pc("codex", 25), pc("grok", 50)]) === "codex");
check("Grok as emptiest platform is targeted", winner([pc("claude", 60), pc("codex", 55), pc("grok", 10)]) === "grok");
check("weekly usage beats a sooner reset", winner([pc("claude", 20, 0, 1000), pc("codex", 80, 0, 10)]) === "claude");
check("equal weekly → lower 5h wins", winner([pc("claude", 40, 90), pc("codex", 40, 15)]) === "codex");
// A provider with no reading yet (null weekly) counts as 0% — the emptiest, so spread targets it first.
check("null-usage provider counts as emptiest", winner([pc("claude", 45), pc("grok", null)]) === "grok");

if (failures) {
  console.error(`\n${failures} spread-usage check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll spread-usage checks passed.");
