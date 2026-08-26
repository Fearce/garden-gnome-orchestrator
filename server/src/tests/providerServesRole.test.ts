// Unit test for structured-role failover fitness (pure logic; no accounts, DB, or network).
// Run: npx tsx src/tests/providerServesRole.test.ts
//
// Reader results must be posted through the in-process MCP bus, so reader cannot run on the CLI
// backends. Auto-review is deliberately different: its required schema verdict is recorded by
// ThreadManager. Codex/Grok can therefore be used when Claude is capped, and their kickoff explicitly
// requires an owner-dependent decision to return accept:false rather than accept on a guess.

import { providerServesRole } from "../orchestrator/threadManager.js";
import type { Role, ImplementorProvider } from "../types.js";

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) console.log(`  OK ${name}`);
  else {
    failures++;
    console.error(`  FAIL ${name}`);
  }
}

const ROLES: Role[] = ["director", "planner", "researcher", "implementor", "qa", "reader", "reviewer"];
const PROVIDERS: ImplementorProvider[] = ["claude", "codex", "grok", "zai"];
const MCP_DEPENDENT: ReadonlySet<Role> = new Set(["reader"]);
const CLI_BRIDGED: ReadonlySet<ImplementorProvider> = new Set(["codex", "grok"]);

console.log("provider-serves-role matrix");
check("reader -> claude", providerServesRole("reader", "claude"));
check("reader -> z.ai", providerServesRole("reader", "zai"));
check("reader -> codex blocked", !providerServesRole("reader", "codex"));
check("reader -> grok blocked", !providerServesRole("reader", "grok"));
check("reviewer -> claude", providerServesRole("reviewer", "claude"));
check("reviewer -> z.ai", providerServesRole("reviewer", "zai"));
check("reviewer -> codex schema fallback", providerServesRole("reviewer", "codex"));
check("reviewer -> grok schema fallback", providerServesRole("reviewer", "grok"));

let cellFailures = 0;
for (const role of ROLES) {
  for (const provider of PROVIDERS) {
    const expected = !MCP_DEPENDENT.has(role) || !CLI_BRIDGED.has(provider);
    if (providerServesRole(role, provider) !== expected) {
      cellFailures++;
      console.error(`  FAIL ${role} x ${provider}: expected ${expected}`);
    }
  }
}
check("all role/provider cells match the contract", cellFailures === 0);

if (failures) process.exit(1);
console.log("All provider-serves-role checks passed.");
