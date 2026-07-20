// Unit test for the per-subscription weekly-safety ceiling (pure logic — no accounts, no DB, no network).
// Run: npx tsx src/tests/weeklySafety.test.ts   (or `npm run test:weekly-safety`)
//
// `weeklySafetyPool` is the soft filter select()/selectFailover() apply: keep candidates under their
// own weekly ceiling, but fall through to ALL when none qualify (never freeze a dispatch).

import { bySafetyHeadroom, preferUnderWeeklySafety, weeklySafetyPool } from "../accounts/accountManager.js";

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}`);
  }
}

type Cand = { id: string; sevenDay: number | null; weeklySafetyPct: number };
const a = (id: string, sevenDay: number | null, weeklySafetyPct = 100): Cand => ({ id, sevenDay, weeklySafetyPct });
const ids = (cs: Cand[]) => cs.map((c) => c.id).join(",");

console.log("weekly-safety: preferUnderWeeklySafety");

// Default ceiling (100) → nothing is ever over it (utilization can't reach 100 and be < 100), so all pass.
check("default 100 keeps everyone", ids(preferUnderWeeklySafety([a("A", 95), a("B", 40)])) === "A,B");

// A sub at/above its ceiling is dropped in favor of one under its own ceiling.
check("A over 90 → only B", ids(preferUnderWeeklySafety([a("A", 92, 90), a("B", 40, 90)])) === "B");
check("exactly at ceiling counts as over", ids(preferUnderWeeklySafety([a("A", 90, 90), a("B", 40, 90)])) === "B");
check("just under ceiling stays", ids(preferUnderWeeklySafety([a("A", 89, 90), a("B", 40, 90)])) === "A,B");

// Independent per-sub ceilings: each is judged against its OWN threshold.
check("per-sub ceilings independent", ids(preferUnderWeeklySafety([a("A", 85, 80), a("B", 85, 90)])) === "B");

// ALL over their ceilings → fall through to the full set and explicitly signal the most-headroom fallback.
const allOver = [a("A", 95, 90), a("B", 92, 90)];
check("all over → fall through to all", ids(weeklySafetyPool(allOver).candidates) === "A,B");
check("all over signals the headroom fallback", weeklySafetyPool(allOver).allOver);
const someUnder = [a("A", 95, 90), a("B", 80, 90)];
check("some under does not signal the fallback", !weeklySafetyPool(someUnder).allOver);
const headroomOrder = [
  { ...a("A", 95, 90), fiveHour: 20 },
  { ...a("B", 92, 90), fiveHour: 80 },
  { ...a("C", 92, 90), fiveHour: 40 },
].sort(bySafetyHeadroom);
check("all-over fallback chooses most weekly, then 5h, headroom", ids(headroomOrder) === "C,B,A");

// Null usage (pre-ping) treated as 0 → always under any ceiling.
check("null usage is under any ceiling", ids(preferUnderWeeklySafety([a("A", null, 50), a("B", 60, 50)])) === "A");

// Empty input → empty output (caller falls back to base).
check("empty stays empty", preferUnderWeeklySafety([] as Cand[]).length === 0);

// Same helper drives the provider-level ceiling (Claude/Codex/Grok backends). Codex and Grok each carry
// their configured backend ceiling; Grok's usage comes from its live `/usage show` scrape.
console.log("weekly-safety: provider-level backends");
const p = (id: string, sevenDay: number | null, weeklySafetyPct = 100) => a(id, sevenDay, weeklySafetyPct);
check("codex over its ceiling → claude/grok preferred", ids(preferUnderWeeklySafety([p("claude", 40), p("codex", 88, 85), p("grok", 20, 90)])) === "claude,grok");
check("grok over its ceiling → claude/codex preferred", ids(preferUnderWeeklySafety([p("claude", 40), p("codex", 80, 85), p("grok", 92, 90)])) === "claude,codex");
const preferredGrokPool = preferUnderWeeklySafety([p("claude", 40), p("codex", 80, 85), p("grok", 92, 90)]);
check('"Prefer Grok" cannot see an over-safety Grok candidate', !preferredGrokPool.some((c) => c.id === "grok"));
check("both backends under their ceilings → all kept", ids(preferUnderWeeklySafety([p("claude", 40), p("codex", 80, 85), p("grok", 70, 90)])) === "claude,codex,grok");
check("everyone over → fall through (no freeze)", ids(preferUnderWeeklySafety([p("claude", 95, 90), p("codex", 92, 85)])) === "claude,codex");

if (failures) {
  console.error(`\n${failures} weekly-safety check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll weekly-safety checks passed.");
