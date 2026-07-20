/**
 * Unit test — the per-subscription MAX reasoning-effort clamp (`clampEffort` in agents/roles.ts).
 *
 * The director/planner picks each task's effort; a subscription's configured max only CAPS it (so a tiny
 * task stays cheap and nothing exceeds the tier the operator allowed for that sub). Codex/Grok caps top out
 * below Claude's `max`, so the clamp must also bound a Claude-tier request down into a CLI backend's range.
 *
 * Run:  npm run test:effort   (from server/)   — or:  npx tsx src/tests/effortCap.itest.ts
 * Exits non-zero if any assertion fails.
 */

import { clampEffort } from "../agents/roles.js";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function eq(label: string, got: unknown, want: unknown): void {
  const ok = got === want;
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; failures.push(`${label} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); console.log(`  ✗ ${label} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}

console.log("\nclampEffort");
eq("under the cap → unchanged (tiny task stays low)", clampEffort("low", "max"), "low");
eq("at the cap → unchanged", clampEffort("high", "high"), "high");
eq("over the cap → capped down", clampEffort("max", "high"), "high");
eq("Claude 'max' capped to a Codex 'xhigh' backend", clampEffort("max", "xhigh"), "xhigh");
eq("Claude 'xhigh' capped to a Grok 'high' backend", clampEffort("xhigh", "high"), "high");
eq("medium under a high cap → medium", clampEffort("medium", "high"), "medium");
eq("high over a low cap → low", clampEffort("high", "low"), "low");
eq("uncapped (max cap) never lowers a request", clampEffort("xhigh", "max"), "xhigh");

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed`);
if (failed) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
process.exit(0);
