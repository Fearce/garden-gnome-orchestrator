/**
 * Unit test — token conservation mode's pure decision logic (orchestrator/tokenConservation.ts).
 * No network, no DB, no quota; the setting gate + live usage reads are exercised only through this
 * pure function, which is what threadManager.ts's modelFor/providerRoleModel call once the operator
 * setting is on.
 *
 * Run: npm run test:token-conservation   (from server/)   — or: npx tsx src/tests/tokenConservation.test.ts
 */

import {
  TOKEN_CONSERVATION_RESET_GRACE_MS,
  TOKEN_CONSERVATION_THRESHOLD_PCT,
  conservationActive,
  conservationResolvedModel,
} from "../orchestrator/tokenConservation.js";

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

const NOW = Date.parse("2026-09-10T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

console.log("\n=== conservationActive — when the window is worth conserving ===\n");

check(
  "below the threshold is never active",
  !conservationActive({ usedPct: TOKEN_CONSERVATION_THRESHOLD_PCT - 1, resetAt: NOW + 7 * DAY }, NOW),
);
check(
  "exactly at the threshold is active",
  conservationActive({ usedPct: TOKEN_CONSERVATION_THRESHOLD_PCT, resetAt: NOW + 7 * DAY }, NOW),
);
check("above the threshold is active", conservationActive({ usedPct: 97, resetAt: NOW + 7 * DAY }, NOW));
check("no reading at all is never active", !conservationActive({ usedPct: null, resetAt: null }, NOW));
check(
  "a reset well past the grace window is active",
  conservationActive({ usedPct: 95, resetAt: NOW + TOKEN_CONSERVATION_RESET_GRACE_MS + 1 }, NOW),
);
check(
  "a reset within the grace window is NOT active — nothing worth conserving for",
  !conservationActive({ usedPct: 95, resetAt: NOW + TOKEN_CONSERVATION_RESET_GRACE_MS - 1 }, NOW),
);
check(
  "a reset exactly at the grace boundary is NOT active",
  !conservationActive({ usedPct: 95, resetAt: NOW + TOKEN_CONSERVATION_RESET_GRACE_MS }, NOW),
);
check(
  "an already-past reset (rolled over) is NOT active",
  !conservationActive({ usedPct: 99, resetAt: NOW - 1 }, NOW),
);
check(
  "an unknown reset biases toward conserving, not away from it",
  conservationActive({ usedPct: 95, resetAt: null }, NOW),
);
check(
  "an unknown reset AND usedPct together is still never active",
  !conservationActive({ usedPct: null, resetAt: undefined }, NOW),
);

console.log("\n=== conservationResolvedModel — what it downgrades, and what it leaves alone ===\n");

const ACTIVE = { usedPct: 95, resetAt: NOW + 7 * DAY };
const INACTIVE_LOW_USAGE = { usedPct: 40, resetAt: NOW + 7 * DAY };
const INACTIVE_RESET_SOON = { usedPct: 95, resetAt: NOW + DAY / 2 };

check(
  "a flagship Claude pick is pulled down to Sonnet",
  conservationResolvedModel("claude", "claude-opus-5", ACTIVE, NOW) === "claude-sonnet-5",
);
check(
  "a flagship Fable pick is pulled down to Sonnet too",
  conservationResolvedModel("claude", "claude-fable-5-1", ACTIVE, NOW) === "claude-sonnet-5",
);
check(
  "an already-economy Claude pick (Sonnet) passes through unchanged",
  conservationResolvedModel("claude", "claude-sonnet-4-6", ACTIVE, NOW) === "claude-sonnet-4-6",
);
check(
  "an explicit Haiku override is never upgraded",
  conservationResolvedModel("claude", "claude-haiku-4-5-20251001", ACTIVE, NOW) === "claude-haiku-4-5-20251001",
);
check(
  "a flagship Codex pick (Astra) is pulled down to Luna",
  conservationResolvedModel("codex", "gpt-6-astra", ACTIVE, NOW) === "gpt-5.6-luna",
);
check(
  "a flagship Codex Sol pick is pulled down to Luna too",
  conservationResolvedModel("codex", "gpt-5.6-sol", ACTIVE, NOW) === "gpt-5.6-luna",
);
check(
  "an already-economy Codex pick (Terra) passes through unchanged",
  conservationResolvedModel("codex", "gpt-5.6-terra", ACTIVE, NOW) === "gpt-5.6-terra",
);
check(
  "Grok has no reviewed economy tier, so it is never touched",
  conservationResolvedModel("grok", "grok-4.6", ACTIVE, NOW) === "grok-4.6",
);
check(
  "z.ai has no reviewed economy tier, so it is never touched",
  conservationResolvedModel("zai", "glm-5.3", ACTIVE, NOW) === "glm-5.3",
);
check(
  "an inactive window (usage below the last 10%) leaves a flagship pick alone",
  conservationResolvedModel("claude", "claude-opus-5", INACTIVE_LOW_USAGE, NOW) === "claude-opus-5",
);
check(
  "an inactive window (reset within 24h) leaves a flagship pick alone",
  conservationResolvedModel("codex", "gpt-6-astra", INACTIVE_RESET_SOON, NOW) === "gpt-6-astra",
);
check(
  "an unreviewed/unlisted Codex id (not on the economy allowlist) IS conserved — fail OPEN, not closed",
  conservationResolvedModel("codex", "gpt-daybreak-blue-latest", ACTIVE, NOW) === "gpt-5.6-luna",
);
check(
  "a legacy non-economy Codex pick (5.4) is pulled down to Luna too, even though Luna's own version number is higher",
  conservationResolvedModel("codex", "gpt-5.4", ACTIVE, NOW) === "gpt-5.6-luna",
);
check(
  "a fully-spent window with no reset reading at all is active — the case most likely to occur in production",
  conservationActive({ usedPct: 100, resetAt: null }, NOW),
);

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed`);
if (failed) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
process.exit(0);
