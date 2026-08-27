/**
 * Unit gate — Codex capacity POOLS: the model↔pool mapping and the bounded-work routing policy.
 *
 * A ChatGPT plan carries more than one allowance. `account/rateLimits/read` returns
 * `rateLimitsByLimitId`: the general `codex` pool plus a dedicated pool per model that ships its own
 * (GPT-5.3-Codex-Spark, live limitId `codex_bengalfox`). Two things have to stay true or the feature
 * either strands that capacity or spends it wrongly:
 *
 *   1. The model↔pool link is made from `limitName`, NEVER the limitId — the live id is an internal
 *      codename with no relation to the model slug.
 *   2. A dedicated pool serves only the bounded roles. This is a CAPABILITY rule: the Codex CLI ships
 *      Spark with an instruction template telling it never to verify its own work or run tests, which
 *      makes it wrong for the implementor and unsafe for QA/the reviewer.
 *
 * Free: pure functions, no DB, no network, no agent.
 * Run:  npm run test:codex-pools   (from server/)
 */

import {
  DEDICATED_POOL_ROLES,
  GENERAL_LIMIT_ID,
  POOL_HARD_LIMIT_PCT,
  dedicatedPoolModel,
  dedicatedPools,
  describePool,
  generalPool,
  normalizeLimitName,
  normalizeModelId,
  poolForModel,
  poolHasHeadroom,
  poolHeadroomPct,
  poolLatched,
  roleMayUseDedicatedPool,
  type CodexPool,
} from "../agents/codexPools.js";
import type { Role } from "../types.js";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    failures.push(label + (detail ? ` — ${detail}` : ""));
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const NOW = Date.parse("2026-08-27T12:00:00.000Z");
const HOUR = 3_600_000;
const SPARK_MODEL = "gpt-5.3-codex-spark";

/** The exact shape the live RPC returned on 2026-08-27 (codex-cli 0.150.1, plan "pro"): the general
 *  pool with only a WEEKLY window running, and Spark idle on both of its own. */
function livePools(over: Partial<CodexPool> = {}): CodexPool[] {
  return [
    { limitId: "codex", limitName: null, modelSlug: null, fiveHour: null, sevenDay: 29, fiveHourReset: null, sevenDayReset: NOW + 60 * HOUR },
    {
      limitId: "codex_bengalfox",
      limitName: "GPT-5.3-Codex-Spark",
      modelSlug: SPARK_MODEL,
      fiveHour: 0,
      sevenDay: 0,
      fiveHourReset: NOW + 4 * HOUR,
      sevenDayReset: NOW + 100 * HOUR,
      ...over,
    },
  ];
}
const ROSTER = ["gpt-5.6-sol", "gpt-5.5", SPARK_MODEL];
const pick = (role: Role, pools = livePools(), latches?: Map<string, number>, dispatchable = ROSTER): string | undefined =>
  dedicatedPoolModel({ pools, role, now: NOW, dispatchable, capLatches: latches });

console.log("\n=== Codex capacity pools — mapping + bounded-work routing policy ===\n");

// -- 1. the mapping, which must come from limitName and never the opaque limitId --------------------
console.log("1 — model↔pool mapping is derived from limitName, not the codename limitId");
check('"GPT-5.3-Codex-Spark" normalizes onto the model slug', normalizeLimitName("GPT-5.3-Codex-Spark") === SPARK_MODEL, String(normalizeLimitName("GPT-5.3-Codex-Spark")));
check("the dot in a version is preserved (5.3 must not become 5-3)", normalizeLimitName("GPT-5.3") === "gpt-5.3", String(normalizeLimitName("GPT-5.3")));
check("a model id normalizes to the same form, so both sides compare equal", normalizeModelId("GPT-5.3-Codex-Spark") === normalizeLimitName("GPT-5.3-Codex-Spark"));
check("surrounding punctuation/space is trimmed rather than becoming hyphens", normalizeLimitName("  GPT 5.5  ") === "gpt-5.5", String(normalizeLimitName("  GPT 5.5  ")));
check("an absent label maps to no model", normalizeLimitName(null) === null && normalizeLimitName("") === null);
check("punctuation-only label maps to no model (never an empty-string slug that matches nothing safely)", normalizeLimitName("---") === null, String(normalizeLimitName("---")));
check("the general pool is excluded from the dedicated set", dedicatedPools(livePools()).length === 1 && dedicatedPools(livePools())[0]!.limitId === "codex_bengalfox");
check("the general pool is found by its limitId", generalPool(livePools())?.limitId === GENERAL_LIMIT_ID);
check("Spark's model resolves to Spark's OWN pool", poolForModel(livePools(), SPARK_MODEL)?.limitId === "codex_bengalfox");
check("a flagship model resolves to the GENERAL pool", poolForModel(livePools(), "gpt-5.6-sol")?.limitId === GENERAL_LIMIT_ID);
check("an unknown model falls back to the general pool", poolForModel(livePools(), "gpt-9-imaginary")?.limitId === GENERAL_LIMIT_ID);
// A pool whose label doesn't match any model must not silently capture every model via a null slug.
const unlabelled: CodexPool[] = [{ limitId: "codex_other", limitName: null, modelSlug: null, fiveHour: 0, sevenDay: 0, fiveHourReset: null, sevenDayReset: null }];
check("an unlabelled non-general pool is not a dedicated rung (nothing can be routed to it)", dedicatedPools(unlabelled).length === 0);

// -- 2. the capability policy: which roles may spend a dedicated pool -------------------------------
console.log("\n2 — bounded roles only (a model told never to verify must not implement or review)");
for (const role of ["reader", "planner", "researcher"] as Role[]) {
  check(`${role} MAY use a dedicated pool (bounded, one-shot, structured)`, roleMayUseDedicatedPool(role));
  check(`${role} is routed onto Spark when its pool is idle`, pick(role) === SPARK_MODEL, String(pick(role)));
}
for (const role of ["implementor", "qa", "reviewer", "director"] as Role[]) {
  check(`${role} may NOT use a dedicated pool`, !roleMayUseDedicatedPool(role));
  check(`${role} is never routed onto Spark, however idle it is`, pick(role) === undefined, String(pick(role)));
}
check("the policy set is exactly the three bounded roles", [...DEDICATED_POOL_ROLES].sort().join(",") === "planner,reader,researcher", [...DEDICATED_POOL_ROLES].join(","));

// -- 3. headroom: every window gates, and a lapsed reset means the window rolled over ---------------
console.log("\n3 — headroom, fail-closed on an unreadable pool");
const spark = (over: Partial<CodexPool>): CodexPool => dedicatedPools(livePools(over))[0]!;
check("an idle pool has headroom", poolHasHeadroom(spark({}), NOW));
check("a spent WEEKLY window closes the pool even with the 5h idle", !poolHasHeadroom(spark({ sevenDay: 100 }), NOW));
check("a spent 5h window closes the pool even with the week idle", !poolHasHeadroom(spark({ fiveHour: 100 }), NOW));
check("AT the hard limit is not headroom", !poolHasHeadroom(spark({ fiveHour: POOL_HARD_LIMIT_PCT }), NOW));
check("just under the hard limit is headroom", poolHasHeadroom(spark({ fiveHour: POOL_HARD_LIMIT_PCT - 1 }), NOW));
check(
  "a window whose reset has PASSED has rolled over — headroom again even at 100%",
  poolHasHeadroom(spark({ sevenDay: 100, sevenDayReset: NOW - HOUR }), NOW),
);
check(
  "a pool reporting NO windows is unusable (fail-closed: never gamble a run on an allowance we cannot see)",
  !poolHasHeadroom(spark({ fiveHour: null, sevenDay: null }), NOW),
);
check("an absent pool is unusable", !poolHasHeadroom(undefined, NOW));
check("headroom percent reads the TIGHTEST window", poolHeadroomPct(spark({ fiveHour: 10, sevenDay: 60 })) === 40, String(poolHeadroomPct(spark({ fiveHour: 10, sevenDay: 60 }))));

// -- 4. the latches, which are what keep the pools independent -------------------------------------
console.log("\n4 — per-pool latches: independent, so one pool's 429 never disables the other");
const latched = new Map<string, number>([["codex_bengalfox", NOW + HOUR]]);
check("a live latch on Spark's pool takes it out of routing", pick("planner", livePools(), latched) === undefined);
check("poolLatched reports the live latch", poolLatched(latched, "codex_bengalfox", NOW));
check("a LAPSED latch frees the pool again", pick("planner", livePools(), new Map([["codex_bengalfox", NOW - HOUR]])) === SPARK_MODEL);
check("a latch on the GENERAL pool does not close a dedicated one", pick("planner", livePools(), new Map([["codex", NOW + HOUR]])) === SPARK_MODEL);
check("no latches at all reads as nothing latched", !poolLatched(undefined, "codex_bengalfox", NOW));
// The inverse of the independence rule: an exhausted GENERAL pool must not close Spark either. This is
// the whole point of the feature — bounded work keeps flowing while the plan's main allowance is spent.
const generalSpent = livePools();
generalSpent[0]!.sevenDay = 100;
check("an exhausted GENERAL pool leaves Spark routable for bounded roles", pick("planner", generalSpent) === SPARK_MODEL);

// -- 5. the roster gate: an allowance we cannot dispatch is not capacity ----------------------------
console.log("\n5 — a pool whose model this deployment cannot dispatch is not a rung");
check("Spark missing from the live roster ⇒ no pick", pick("planner", livePools(), undefined, ["gpt-5.6-sol"]) === undefined);
check("an empty roster ⇒ no pick", pick("planner", livePools(), undefined, []) === undefined);
check("no pools at all ⇒ no pick", pick("planner", []) === undefined);
check("roster matching is normalization-insensitive", pick("planner", livePools(), undefined, ["GPT-5.3-Codex-Spark"]) === SPARK_MODEL);

// -- 6. several dedicated pools: the one with the most room wins ------------------------------------
console.log("\n6 — with two dedicated pools, the roomiest is chosen (a burst spreads, not hammers)");
const twoPools: CodexPool[] = [
  ...livePools({ fiveHour: 60, sevenDay: 60 }),
  { limitId: "codex_other", limitName: "GPT-Other-Fast", modelSlug: "gpt-other-fast", fiveHour: 5, sevenDay: 5, fiveHourReset: NOW + HOUR, sevenDayReset: NOW + HOUR },
];
check("the roomier pool is picked", pick("reader", twoPools, undefined, [...ROSTER, "gpt-other-fast"]) === "gpt-other-fast");
check(
  "with the roomier one latched, the other still serves",
  pick("reader", twoPools, new Map([["codex_other", NOW + HOUR]]), [...ROSTER, "gpt-other-fast"]) === SPARK_MODEL,
);
check("with BOTH spent, nothing is picked (no retry storm against a dry plan)", pick("reader", [
  ...livePools({ fiveHour: 100 }),
  { limitId: "codex_other", limitName: "GPT-Other-Fast", modelSlug: "gpt-other-fast", fiveHour: 100, sevenDay: 100, fiveHourReset: NOW + HOUR, sevenDayReset: NOW + HOUR },
], undefined, [...ROSTER, "gpt-other-fast"]) === undefined);

// -- 7. the human summary the chip + probe render --------------------------------------------------
console.log("\n7 — describePool");
check("names the pool and both meters", describePool(spark({ fiveHour: 12, sevenDay: 34 })) === "GPT-5.3-Codex-Spark: 5h 12% · 7d 34%", describePool(spark({ fiveHour: 12, sevenDay: 34 })));
check("falls back to the limitId when unlabelled", describePool({ limitId: "codex_x", limitName: null, modelSlug: null, fiveHour: null, sevenDay: null, fiveHourReset: null, sevenDayReset: null }) === "codex_x: no meter");

console.log(`\n=== RESULT: ${failed === 0 ? "PASS ✅" : "FAIL ❌"} — ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  console.log("Failures:");
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failed === 0 ? 0 : 1);
