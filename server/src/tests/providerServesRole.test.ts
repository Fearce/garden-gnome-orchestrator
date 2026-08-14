// Unit test for the structured-role failover fitness test (pure logic — no accounts, no DB, no network).
// Run: npx tsx src/tests/providerServesRole.test.ts   (or `npm run test:provider-serves-role`)
//
// `providerServesRole` is the gate every runRole failover path keys on: a structured role whose only
// owner-channel is the in-process MCP bus (the reader posts its answer as a finding; the auto-reviewer
// decides a task's fate through post_finding AND ask_user) may only land on a backend that actually serves
// those tools. The CLI text-bridge backends (Codex/Grok) reach the bus through the runner's OFFICE[…]
// string bridge, so the MCP tools simply aren't there — a cap-failover onto one would silently strip the
// role's only channel and decide the task blind. z.ai drives the same Claude SDK against an
// Anthropic-compatible endpoint and keeps the MCP servers `makeCfg` built, so it is NOT CLI-bridged: a
// reader/reviewer CAN fail over to it. That is the regression this gate holds — when every Claude sub was
// capped, the reader/reviewer used to park outright instead of continuing on a ready z.ai (thread e870c68e,
// 2026-08-13: the auto-review click died on "session limit" with z.ai up and idle 4s later).

import { providerServesRole } from "../orchestrator/threadManager.js";
import type { Role, ImplementorProvider } from "../types.js";

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}`);
  }
}

const ROLES: Role[] = ["director", "planner", "researcher", "implementor", "qa", "reader", "reviewer"];
const PROVIDERS: ImplementorProvider[] = ["claude", "codex", "grok", "zai"];
const MCP_DEPENDENT: ReadonlySet<Role> = new Set(["reader", "reviewer"]);
const CLI_BRIDGED: ReadonlySet<ImplementorProvider> = new Set(["codex", "grok"]);

// The contract as the failover paths rely on it: the role set and the provider set drive the verdict, and
// nothing else does — pin both halves directly so a drift in either set flips a check.
console.log("provider-serves-role: role×provider matrix");

// The exact cells the regression is about — spelled out so a failure names the broken pair.
check("reader → claude (default backend)", providerServesRole("reader", "claude"));
check("reader → z.ai (the failover the fix unlocks)", providerServesRole("reader", "zai"));
check("reader → codex blocked (no in-process MCP bus)", !providerServesRole("reader", "codex"));
check("reader → grok blocked (no in-process MCP bus)", !providerServesRole("reader", "grok"));
check("reviewer → claude (default backend)", providerServesRole("reviewer", "claude"));
check("reviewer → z.ai (keeps ask_user, so it never decides blind)", providerServesRole("reviewer", "zai"));
check("reviewer → codex blocked (would lose ask_user)", !providerServesRole("reviewer", "codex"));
check("reviewer → grok blocked (would lose ask_user)", !providerServesRole("reviewer", "grok"));

console.log("\nprovider-serves-role: every role×provider cell matches the derived contract");

// Exhaustive: every cell must agree with the independent reconstruction of the rule. A future edit that
// adds a role/provider but forgets this function (or vice versa) fails here, not in production.
let cellFailures = 0;
for (const role of ROLES) {
  for (const provider of PROVIDERS) {
    const expected = !MCP_DEPENDENT.has(role) || !CLI_BRIDGED.has(provider);
    const got = providerServesRole(role, provider);
    if (got !== expected) {
      cellFailures++;
      console.error(`  ✗ ${role} × ${provider}: expected ${expected}, got ${got}`);
    }
  }
}
check("all 28 role×provider cells match", cellFailures === 0);

if (failures) {
  console.error(`\n${failures} provider-serves-role check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll provider-serves-role checks passed.");
