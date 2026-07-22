// Unit test for looksLikeScheduleRequest (pure logic — no accounts, no DB, no network).
// Run: npx tsx src/tests/scheduleDetect.test.ts   (or `npm run test:schedule-detect`)
//
// This gate decides whether a skip-director dispatch is rerouted to the full director (which owns the
// scheduling tools). It MUST catch genuine "make this recurring" asks, but must NOT fire on a feature
// request that merely mentions a frequency word — e.g. "add a Weekly token safety %", which used to
// silently override skip-director because the word "weekly" appeared.

import { looksLikeScheduleRequest } from "../orchestrator/director.js";

let failures = 0;
function expect(name: string, text: string, want: boolean): void {
  const got = looksLikeScheduleRequest(text);
  if (got === want) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name} (got ${got}, want ${want}) — ${JSON.stringify(text)}`);
  }
}

console.log("schedule-detect: genuine schedule requests → true");
expect("explicit schedule verb", "schedule a cleanup task", true);
expect("cron mention", "set up a cron job for the crawler", true);
expect("recurring", "make this a recurring report", true);
expect("periodically", "periodically re-sync the catalog", true);
expect("every + unit", "remind me every monday", true);
expect("every N units", "run the audit every 3 days", true);
expect("each week", "post a summary each week", true);
expect("frequency + action verb", "run this daily", true);
expect("send + weekly", "send me a weekly digest", true);
expect("check + hourly", "check the deploy hourly", true);
expect("backup + nightly", "back up the db nightly", true);
expect("frequency + clock time", "weekly at 9am", true);
expect("frequency + 24h clock", "nightly at 02:30", true);
expect("frequency + noon", "daily at noon", true);

console.log("schedule-detect: feature requests that merely mention a frequency → false");
// The exact message that regressed: skip-director was on, but "Weekly" rerouted it to the director.
expect(
  "the weekly-reroute regression",
  "Can you add a 'Weekly token safety %' to each subscription in our settings panel? So I can be like 'never go above 90% of my personal claude sub' for instance. It shouldnt freeze tasks, it'll just use another sub.",
  false,
);
expect("weekly reset time chip", "Display weekly reset time in usage chip", false);
expect("daily count column", "add a daily count column to the table", false);
expect("monthly billing label", "show the monthly billing total on the card", false);
expect("plain unrelated task", "fix the login button alignment on mobile", false);

if (failures) {
  console.error(`\nschedule-detect: ${failures} FAILED`);
  process.exit(1);
}
console.log("\nschedule-detect: all passed");
