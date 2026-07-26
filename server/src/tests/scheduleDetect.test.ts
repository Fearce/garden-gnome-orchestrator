// Unit test for looksLikeScheduleRequest (pure logic — no accounts, no DB, no network).
// Run: npx tsx src/tests/scheduleDetect.test.ts   (or `npm run test:schedule-detect`)
//
// This gate decides whether a skip-director dispatch gets the "the scheduler lives behind the director"
// note. The owner's rule is the contract: it is NEVER a scheduled task unless they said BOTH "schedule"
// (or "cron") AND "task" (or "job") as one request. A cadence word on its own — "weekly", "run this
// daily", "every reset" — describes the WORK, not a cron entry, and must NOT fire.

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

console.log('schedule-detect: explicit "schedule … task" asks → true');
expect("schedule a task", "schedule a task", true);
expect("schedule a <thing> task", "schedule a cleanup task", true);
expect("schedule this task", "schedule this task so I don't have to ask again", true);
expect("set up a scheduled task", "set up a scheduled task that runs the audit every morning", true);
expect("new scheduled task", "can you add a new scheduled task for the nightly sweep at 02:30", true);
expect("cron job", "set up a cron job for the crawler", true);
expect("change an existing one", "change the cron on that scheduled task to 9am", true);
expect("delete an existing one", "delete the scheduled task that posts the weekly digest", true);
expect("task … on a schedule", "make this task run on a schedule, every monday", true);

console.log("schedule-detect: cadence words WITHOUT an explicit schedule+task ask → false");
// The message that regressed (screenshot): "weekly" + "run" used to be enough to fire the note.
expect(
  "the weekly-burn-ratio regression",
  "fix it so the trading fleet ALWAYS has 1 monitoring agent regardless of weekly burn ratios. If all are above target then just run whatever is lowest until a new weekly reset appears.",
  false,
);
// The earlier regression: a feature request that merely names a frequency.
expect(
  "the weekly-reroute regression",
  "Can you add a 'Weekly token safety %' to each subscription in our settings panel? So I can be like 'never go above 90% of my personal claude sub' for instance. It shouldnt freeze tasks, it'll just use another sub.",
  false,
);
expect("recurring", "make this a recurring report", false);
expect("periodically", "periodically re-sync the catalog", false);
expect("every + unit", "remind me every monday", false);
expect("every N units", "run the audit every 3 days", false);
expect("each week", "post a summary each week", false);
expect("frequency + action verb", "run this daily", false);
expect("send + weekly", "send me a weekly digest", false);
expect("check + hourly", "check the deploy hourly", false);
expect("backup + nightly", "back up the db nightly", false);
expect("frequency + clock time", "weekly at 9am", false);
expect("frequency + 24h clock", "nightly at 02:30", false);
expect("cron word alone", "the cron parser chokes on '*/30 * * * *'", false);
expect("schedule word alone", "schedule the release for friday", false);
expect("task word alone", "add a task counter to the board header", false);
expect("weekly reset time chip", "Display weekly reset time in usage chip", false);
expect("daily count column", "add a daily count column to the table", false);
expect("monthly billing label", "show the monthly billing total on the card", false);
expect("plain unrelated task", "fix the login button alignment on mobile", false);

console.log("schedule-detect: a feature request ABOUT the scheduler is not a schedule request");
expect("scheduler UI work", "add a delete button to the scheduled tasks panel", false);
expect("scheduler column work", "show the next run time in the scheduled tasks list", false);

if (failures) {
  console.error(`\nschedule-detect: ${failures} FAILED`);
  process.exit(1);
}
console.log("\nschedule-detect: all passed");
