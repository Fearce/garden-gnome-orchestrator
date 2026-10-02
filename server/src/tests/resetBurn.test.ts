// Unit test for the "prepare a sub for reset" burn lifecycle (pure, no DB or network).
// Run: npx tsx src/tests/resetBurn.test.ts   (or `npm run test:reset-burn`)

import {
  burnSubIdOf,
  parseResetBurn,
  resetBurnDTO,
  resetBurnEligible,
  resetBurnEndsAt,
  startResetBurn,
  stepResetBurn,
} from "../orchestrator/resetBurn.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const HOUR = 60 * 60_000;
const now = Date.UTC(2026, 9, 2, 12, 0, 0);
const reset = now + 30 * HOUR;

console.log("reset-burn: eligibility");
check("a configured Claude account is eligible", resetBurnEligible("acct2", ["acct1", "acct2"]));
check("Codex is eligible", resetBurnEligible("codex", ["acct1"]));
check("Grok has no banked resets", !resetBurnEligible("grok", ["acct1"]));
check("an unknown account is refused", !resetBurnEligible("acct9", ["acct1"]));
check("a Claude target is its account id", burnSubIdOf("claude", "acct2") === "acct2");
check("a Codex target is the Codex sub whatever its account id", burnSubIdOf("codex", "openai-codex") === "codex");

console.log("reset-burn: start + persistence");
const anchored = startResetBurn("acct2", reset, now);
check("a known weekly reset anchors the burn", anchored.windowReset === reset);
check("an anchored burn ends at that reset", resetBurnEndsAt(anchored) === reset);
const unanchored = startResetBurn("acct2", null, now);
check("an unknown reset leaves the burn unanchored", unanchored.windowReset === null);
check("an unanchored burn still ends within one weekly window", resetBurnEndsAt(unanchored) === now + 7 * 24 * HOUR);
check("an already-past reset reading does not anchor", startResetBurn("acct2", now - 1, now).windowReset === null);
check("a stored burn round-trips", JSON.stringify(parseResetBurn(JSON.stringify(anchored))) === JSON.stringify(anchored));
check("garbage parses to no burn", parseResetBurn("{not json") === null && parseResetBurn('{"subId":3}') === null && parseResetBurn(null) === null);
const dto = resetBurnDTO(unanchored);
check("the DTO says whether the end is known", dto.anchored === false && dto.endsAt === resetBurnEndsAt(unanchored));

console.log("reset-burn: lifecycle");
check("a burn keeps running inside its window", stepResetBurn(anchored, reset, now + HOUR).kind === "keep");
check("small reset jitter is not a roll", stepResetBurn(anchored, reset + 5 * 60_000, now + HOUR).kind === "keep");
check("no reading never ends a burn", stepResetBurn(anchored, null, now + HOUR).kind === "keep");
const spent = stepResetBurn(anchored, now + HOUR + 7 * 24 * HOUR, now + HOUR);
check("a window reset early (the banked reset spent) ends the burn", spent.kind === "end" && spent.reason.includes("reset"));
check("the window passing ends the burn", stepResetBurn(anchored, reset, reset).kind === "end");
const anchoring = stepResetBurn(unanchored, reset, now + HOUR);
check("the first known reset anchors an unanchored burn", anchoring.kind === "anchor" && anchoring.burn.windowReset === reset);
check("a stale past reading does not anchor", stepResetBurn(unanchored, now - HOUR, now + HOUR).kind === "keep");
check("an unanchored burn expires after a weekly window", stepResetBurn(unanchored, null, now + 7 * 24 * HOUR).kind === "end");

if (failures) {
  console.error(`\nreset-burn: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nreset-burn: all checks passed");
