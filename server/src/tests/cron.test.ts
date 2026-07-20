// Unit test for the cron evaluator (pure logic — no accounts, no DB, no network).
// Run: npx tsx src/tests/cron.test.ts   (or `npm run test:cron`)
//
// Times are constructed with `new Date(y, m, d, hh, mm)` so they're LOCAL, matching nextRun's
// local-time semantics — the assertions hold in any time zone.

import { parseCron, isValidCron, nextRun } from "../orchestrator/cron.js";

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}`);
  }
}
function eq(name: string, got: unknown, want: unknown): void {
  check(`${name} (got ${String(got)}, want ${String(want)})`, got === want);
}

const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
const fmt = (ms: number | null) => (ms == null ? "null" : new Date(ms).toString());

console.log("cron: validation");
check("valid: every minute", isValidCron("* * * * *"));
check("valid: 9am daily", isValidCron("0 9 * * *"));
check("valid: step + list + range", isValidCron("*/15 9-17 * * 1,3,5"));
check("valid: sunday as 7", isValidCron("0 0 * * 7"));
check("reject: 4 fields", !isValidCron("* * * *"));
check("reject: minute 60", !isValidCron("60 * * * *"));
check("reject: hour 24", !isValidCron("0 24 * * *"));
check("reject: garbage", !isValidCron("nope"));
check("reject: bad step", !isValidCron("*/0 * * * *"));
check("reject: reversed range", !isValidCron("30-10 * * * *"));

console.log("cron: nextRun");
// Every minute → the next whole minute, strictly after.
eq("every-minute advances one minute", nextRun("* * * * *", at(2026, 7, 20, 10, 30)), at(2026, 7, 20, 10, 31));
// Daily at 09:00 — from 10:30 rolls to tomorrow.
eq("daily 9am from 10:30 → tomorrow 9:00", nextRun("0 9 * * *", at(2026, 7, 20, 10, 30)), at(2026, 7, 21, 9, 0));
// Daily at 09:00 — from 08:00 same day.
eq("daily 9am from 08:00 → today 9:00", nextRun("0 9 * * *", at(2026, 7, 20, 8, 0)), at(2026, 7, 20, 9, 0));
// At exactly 09:00 it must move to the NEXT day (strictly-after semantics).
eq("daily 9am AT 9:00 → tomorrow", nextRun("0 9 * * *", at(2026, 7, 20, 9, 0)), at(2026, 7, 21, 9, 0));
// Top of every hour.
eq("hourly from 10:30 → 11:00", nextRun("0 * * * *", at(2026, 7, 20, 10, 30)), at(2026, 7, 20, 11, 0));
// Every 15 minutes.
eq("*/15 from 10:07 → 10:15", nextRun("*/15 * * * *", at(2026, 7, 20, 10, 7)), at(2026, 7, 20, 10, 15));
// Weekly Monday 09:00. 2026-07-20 is a Monday; from Mon 10:00 → next Monday.
eq("Mon 9am from Mon 10:00 → next Mon", nextRun("0 9 * * 1", at(2026, 7, 20, 10, 0)), at(2026, 7, 27, 9, 0));
// Monthly on the 1st at 00:00.
eq("1st of month from mid-July → Aug 1", nextRun("0 0 1 * *", at(2026, 7, 20, 12, 0)), at(2026, 8, 1, 0, 0));
// OR rule: dom=1 AND dow=Mon both restricted → fires on the 1st OR any Monday, whichever first.
// From Wed 2026-07-01 12:00, the next is the coming Monday (the 6th), earlier than Aug 1.
eq("dom+dow OR rule picks the sooner", nextRun("0 0 1 * 1", at(2026, 7, 1, 12, 0)), at(2026, 7, 6, 0, 0));
// Impossible date → null (Feb never has 30 days).
eq("impossible Feb 30 → null", nextRun("0 0 30 2 *", at(2026, 1, 1, 0, 0)), null);

if (failures) {
  console.error(`\n${failures} cron check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll cron checks passed.");
void fmt; // exported helper kept for ad-hoc debugging
