/**
 * Unit gate — quota-runway selection shared by accounts, providers and model pools.
 *
 * Free: pure functions, fixed clock, no DB/network/agent.
 * Run: npm run test:capacity-routing (from server/)
 */

import {
  assessCapacity,
  capacityWindowsWithFreshness,
  demandForRole,
  nextViableAt,
  preferCapacity,
  standardCapacityWindows,
  withRoutingCeiling,
  type CapacityDemand,
  type CapacityWindow,
} from "../orchestrator/capacityRouting.js";
import { dedicatedPoolModel, type CodexPool } from "../agents/codexPools.js";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
    console.error(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const NOW = Date.parse("2026-08-27T12:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const high = demandForRole("implementor", { effort: "high", now: NOW });
const reader = demandForRole("reader", { now: NOW });

console.log("\n=== capacity routing — task-sized runway ===\n");

check("high-effort implementation is substantial", high.substantial && high.expectedBurnPct === 26);
check(
  "a pool with only 3% free is at risk for substantial work",
  assessCapacity(standardCapacityWindows(97, NOW + 4 * HOUR, 30, NOW + 4 * 24 * HOUR), high, NOW).status === "at-risk",
);
check(
  "the same remaining room can bridge a tiny turn to a near reset",
  assessCapacity([{ label: "5h", usedPct: 96, resetAt: NOW + 5 * MINUTE }], reader, NOW).status === "viable",
);
check(
  "but it cannot carry that turn when reset comes after completion",
  assessCapacity([{ label: "5h", usedPct: 96, resetAt: NOW + 30 * MINUTE }], reader, NOW).status === "at-risk",
);
check(
  "a near reset can make a low-headroom pool viable for a long task",
  assessCapacity([{ label: "5h", usedPct: 91, resetAt: NOW + 15 * MINUTE }], high, NOW).status === "viable",
);
check(
  "a cached 100% reading is fresh after its recorded reset elapsed",
  assessCapacity([{ label: "5h", usedPct: 100, resetAt: NOW - MINUTE }], high, NOW).status === "viable",
);

console.log("\n=== capacity routing — multiple providers and gating windows ===\n");

type Target = { id: string; windows: CapacityWindow[] };
const providerTargets: Target[] = [
  {
    id: "claude-nearly-spent",
    windows: standardCapacityWindows(95, NOW + 4 * HOUR, 95, NOW + 5 * 24 * HOUR),
  },
  {
    id: "codex-near-5h-reset",
    windows: standardCapacityWindows(82, NOW + 20 * MINUTE, 65, NOW + 3 * 24 * HOUR),
  },
  {
    id: "grok-monthly-tight",
    windows: [
      { label: "weekly", usedPct: 68, resetAt: NOW + 2 * 24 * HOUR },
      { label: "monthly credits", usedPct: 95, resetAt: NOW + HOUR },
    ],
  },
];
const providerPick = preferCapacity(providerTargets, (target) => target.windows, high, NOW);
check(
  "selection considers every provider window and keeps only the viable pool",
  providerPick.candidates.map((target) => target.id).join(",") === "codex-near-5h-reset",
  providerPick.candidates.map((target) => target.id).join(","),
);
check("selection reports that capacity constrained the roster", providerPick.constrained && !providerPick.allKnownAtRisk);

const blind: Target = { id: "unmetered-api", windows: standardCapacityWindows(null, null, null, null) };
const risky: Target = { id: "known-risk", windows: standardCapacityWindows(94, NOW + 4 * HOUR, 94, NOW + 5 * 24 * HOUR) };
const unknownFallback = preferCapacity([risky, blind], (target) => target.windows, high, NOW);
check(
  "unknown telemetry remains a bounded fallback when every known pool is unsafe",
  unknownFallback.candidates.length === 1 && unknownFallback.candidates[0] === blind && !unknownFallback.allKnownAtRisk,
);
const noSafe = preferCapacity([risky], (target) => target.windows, high, NOW);
check("all-known-insufficient is explicit so substantial work can wait", noSafe.allKnownAtRisk);

console.log("\n=== capacity routing — reset-time edge cases ===\n");

const coupled = standardCapacityWindows(100, NOW + HOUR, 100, NOW + 10 * HOUR);
check(
  "a 5h reset does not falsely free a pool whose weekly window is still exhausted",
  nextViableAt(coupled, high, NOW) === NOW + 10 * HOUR,
  String(nextViableAt(coupled, high, NOW)),
);
const weeklyThenMonthly: CapacityWindow[] = [
  { label: "weekly", usedPct: 100, resetAt: NOW + 2 * HOUR },
  { label: "monthly credits", usedPct: 100, resetAt: NOW + 9 * HOUR },
];
check(
  "a monthly gate postpones wake beyond an earlier weekly reset",
  nextViableAt(weeklyThenMonthly, high, NOW) === NOW + 9 * HOUR,
);
check(
  "a cap with no reset never creates a dishonest wake time",
  nextViableAt([{ label: "provider cap", usedPct: 100, resetAt: null }], high, NOW) === null,
);
check(
  "an already-viable target reports now rather than inventing a reset wait",
  nextViableAt(standardCapacityWindows(10, NOW + HOUR, 10, NOW + 24 * HOUR), high, NOW) === NOW,
);
const hardHeld = withRoutingCeiling([{ label: "5h", usedPct: 98, resetAt: NOW + 12 * MINUTE }], 98, NOW);
check(
  "a routing hard ceiling remains unavailable until its reset even if a tiny turn could bridge it",
  assessCapacity(hardHeld, reader, NOW).status === "at-risk" && nextViableAt(hardHeld, reader, NOW) === NOW + 12 * MINUTE,
);
const staleHeadroom = capacityWindowsWithFreshness(
  [{ label: "weekly", usedPct: 70, resetAt: NOW + 24 * HOUR }],
  98,
  true,
  NOW,
);
check("stale apparent headroom becomes unknown selection evidence", assessCapacity(staleHeadroom, high, NOW).status === "unknown");
const staleHardCap = capacityWindowsWithFreshness(
  [{ label: "weekly", usedPct: 99, resetAt: NOW + HOUR }],
  98,
  true,
  NOW,
);
check(
  "a stale reading already over the hard ceiling remains held until its known reset",
  assessCapacity(staleHardCap, reader, NOW).status === "at-risk" && nextViableAt(staleHardCap, reader, NOW) === NOW + HOUR,
);

console.log("\n=== capacity routing — separately metered Codex models ===\n");

const general: CodexPool = {
  limitId: "codex",
  limitName: null,
  modelSlug: null,
  fiveHour: 70,
  sevenDay: 70,
  fiveHourReset: NOW + 4 * HOUR,
  sevenDayReset: NOW + 4 * 24 * HOUR,
};
const spark: CodexPool = {
  limitId: "codex_spark",
  limitName: "GPT-Spark",
  modelSlug: "gpt-spark",
  fiveHour: 94,
  sevenDay: 20,
  fiveHourReset: NOW + 5 * MINUTE,
  sevenDayReset: NOW + 5 * 24 * HOUR,
};
const other: CodexPool = {
  limitId: "codex_other",
  limitName: "GPT-Other-Fast",
  modelSlug: "gpt-other-fast",
  fiveHour: 92,
  sevenDay: 20,
  fiveHourReset: NOW + 2 * HOUR,
  sevenDayReset: NOW + 5 * 24 * HOUR,
};
const plannerDemand = demandForRole("planner", { now: NOW });
const pools = [general, spark, other];
const withoutDemand = dedicatedPoolModel({
  pools,
  role: "planner",
  now: NOW,
  dispatchable: ["gpt-spark", "gpt-other-fast"],
});
const withDemand = dedicatedPoolModel({
  pools,
  role: "planner",
  now: NOW,
  dispatchable: ["gpt-spark", "gpt-other-fast"],
  demand: plannerDemand,
});
check("legacy headroom-only order would choose the roomier model", withoutDemand === "gpt-other-fast", String(withoutDemand));
check("reset-aware model selection chooses the pool that can bridge the planner turn", withDemand === "gpt-spark", String(withDemand));
const bothRisky = dedicatedPoolModel({
  pools: [general, { ...spark, fiveHourReset: NOW + 2 * HOUR }, other],
  role: "planner",
  now: NOW,
  dispatchable: ["gpt-spark", "gpt-other-fast"],
  demand: plannerDemand,
});
check("an all-at-risk dedicated tier falls back to the general/provider ladder", bothRisky === undefined, String(bothRisky));

const timed = demandForRole("implementor", { effort: "medium", durationMs: 8 * HOUR, now: NOW });
check(
  "timed work expands the routing horizon and reserve instead of looking like one ordinary turn",
  timed.expectedDurationMs === 8 * HOUR && timed.expectedBurnPct === 74 && timed.substantial,
  JSON.stringify(timed),
);

console.log(`\n=== RESULT: ${failed === 0 ? "PASS ✅" : "FAIL ❌"} — ${passed} passed, ${failed} failed ===`);
if (failures.length) {
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
