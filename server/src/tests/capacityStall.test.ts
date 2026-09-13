/**
 * Unit gate: which parked tasks a usage-window rollover may continue by itself.
 *
 * `isCapacityStallPark` is the one-way safety bias in `orchestrator/capacityStall.ts`. Its false
 * positives are expensive (a whole implementor session spent on work a person had already taken over),
 * so most of this file is the NEGATIVE half: every park shape that must stay with the owner.
 *
 * It also pins the coupling that fails silently. The park text is composed in
 * `threadManager.implementorParkReason`, so if that opening is ever reworded this class empties and the
 * mechanism stops waking anything, with no other symptom. The last section reads the production file and
 * fails on exactly that drift.
 *
 * Run: npm run test:capacity-stall   (free, no agent, no quota, no DB)
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { isCapacityStallPark, MAX_CAPACITY_STALL_RESUMES } from "../orchestrator/capacityStall.js";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    failures.push(label + (detail ? ` (${detail})` : ""));
    console.log(`  ❌ ${label}${detail ? ` (${detail})` : ""}`);
  }
}

// The separator `implementorParkReason` writes, built from its code point so the fixtures below are
// byte-identical to production text without this file carrying the character itself.
const SEP = ` ${String.fromCharCode(0x2014)} `;
/** Compose the exact park message the pipeline would write for a given implementor failure reason. */
const park = (reason: string): string => `Implementor ended without completing${SEP}${reason}`;

// Each reason is real: the first two are `runError.ts`'s canned lines for the SDK's involuntary cutoffs,
// the rest are provider text a CLI backend returned in its own result.
const TURN_CEILING = park(`Stopped at the per-session turn ceiling (error_max_turns)${SEP}an involuntary cutoff, not a crash.`);
const COST_CEILING = park(`Stopped at the per-session cost ceiling (error_max_budget_usd)${SEP}an involuntary cutoff, not a crash.`);
const SESSION_LIMIT = park("You've hit your session limit · resets 7pm (Europe/Copenhagen)");
const RESETS_AT = park("5-hour limit reached. Your limit resets at 19:00.");
const RATE_LIMITED = park("429 rate_limit_error: this account is rate-limited.");

console.log("\n=== capacity stall: the parks a rollover MAY continue ===\n");

check("a turn-ceiling park qualifies", isCapacityStallPark(TURN_CEILING));
check("a cost-ceiling park qualifies", isCapacityStallPark(COST_CEILING));
check("a provider session-limit park qualifies", isCapacityStallPark(SESSION_LIMIT));
check("a 'resets at HH:MM' park qualifies", isCapacityStallPark(RESETS_AT));
check("a rate-limit park qualifies", isCapacityStallPark(RATE_LIMITED));
check("surrounding whitespace does not change the verdict", isCapacityStallPark(`  ${TURN_CEILING}  `));

console.log("\n=== capacity stall: the parks that stay with the owner ===\n");

check("nothing at all is not a stall", !isCapacityStallPark(null) && !isCapacityStallPark(undefined) && !isCapacityStallPark(""));
check(
  "a cap-marked park is NOT this class (the cap supervisor already owns it)",
  !isCapacityStallPark(`⏳ Auto-resume pending${SEP}every account was rate-limited mid-task. Frees in 2h.`),
);
check(
  "a QA park naming the same capacity reason does not wake the implementor",
  !isCapacityStallPark(`QA could not complete${SEP}Stopped at the per-session turn ceiling (error_max_turns). It was woken 2 more times and cut off again each time.`),
);
check(
  "a QA verdict park stays with the owner",
  !isCapacityStallPark(`QA still not satisfied after 3 rounds${SEP}needs your review.`),
);
check(
  "an implementor park that asks for the owner stays with the owner, capacity words or not",
  !isCapacityStallPark(park("needs your review (QA is disabled for this task).")),
);
check(
  "a hard-deadline park is never auto-continued",
  !isCapacityStallPark(park("⏰ Hard deadline reached. Stopped at the per-session turn ceiling.")),
);
check(
  "an ordinary implementor failure with no capacity reason stays parked",
  !isCapacityStallPark(park("the build failed and could not be repaired.")),
);
check(
  "a reader park is not an implementor park",
  !isCapacityStallPark(`Reader could not complete${SEP}needs your review (or a full re-dispatch).`),
);
check(
  "a resume-failure park is not a capacity stall",
  !isCapacityStallPark(`Resume failed to start${SEP}needs your review.`),
);

console.log("\n=== capacity stall: the budget ===\n");

check(
  "the lifetime budget is a small positive number",
  MAX_CAPACITY_STALL_RESUMES > 0 && MAX_CAPACITY_STALL_RESUMES <= 5,
  String(MAX_CAPACITY_STALL_RESUMES),
);

console.log("\n=== capacity stall: the coupling that fails silently ===\n");

const here = dirname(fileURLToPath(import.meta.url));
const threadManager = readFileSync(join(here, "..", "orchestrator", "threadManager.ts"), "utf8");
check(
  "threadManager still composes the park opening this classifier keys on",
  threadManager.includes("Implementor ended without completing"),
  "implementorParkReason was reworded, so the whole class would empty",
);
check(
  "threadManager still consults the classifier when picking rollover candidates",
  /isCapacityStallPark\(/.test(threadManager),
  "the classifier is no longer wired into tokenResumeEligible",
);

console.log(`\n${failed === 0 ? "✅ PASS" : "❌ FAIL"}: ${passed} passed, ${failed} failed`);
if (failed) {
  for (const f of failures) console.log(`   - ${f}`);
  process.exit(1);
}
