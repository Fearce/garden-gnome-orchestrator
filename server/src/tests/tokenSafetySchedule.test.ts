/**
 * Unit test: the Token safety limit's weekly schedule (orchestrator/tokenSafetySchedule.ts). Covers weekday
 * and time boundaries, overnight windows, DST in an explicit zone, invalid input and the unscheduled default.
 *
 * Run: npm run test:token-safety-schedule   (from server/)
 */

import {
  defaultTokenSafetySchedule,
  readTokenSafetySchedule,
  tokenSafetyScheduleProblem,
  tokenSafetyScheduleState,
  writeTokenSafetySchedule,
  type TokenSafetySchedule,
} from "../orchestrator/tokenSafetySchedule.js";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    failures.push(label + (detail ? `: ${detail}` : ""));
    console.log(`  ❌ ${label}${detail ? `: ${detail}` : ""}`);
  }
}

const iso = (ms: number | null): string => (ms == null ? "null" : new Date(ms).toISOString());
const utc = (text: string): number => Date.parse(`${text}Z`);
const work: TokenSafetySchedule = { enabled: true, days: [1, 2, 3, 4, 5], start: "08:00", end: "16:00", timeZone: "UTC" };

function expectState(label: string, s: TokenSafetySchedule, at: number, active: boolean, next: number | null): void {
  const got = tokenSafetyScheduleState(s, at);
  check(label, got.active === active && got.nextChangeAt === next, `active=${got.active} next=${iso(got.nextChangeAt)} want ${active} ${iso(next)}`);
}

console.log("\n=== Token safety schedule ===\n");

console.log("Unscheduled behaviour is unchanged");
{
  const off = defaultTokenSafetySchedule("UTC");
  check("the default is off, pre-filled Mon-Fri 08:00-16:00", !off.enabled && off.days.join() === "1,2,3,4,5" && off.start === "08:00" && off.end === "16:00");
  expectState("off: the limit applies around the clock with no transition", off, utc("2026-10-10T03:00"), true, null);
  check("an installation with no stored schedule reads as off", !readTokenSafetySchedule(null).enabled);
  check("garbage in the stored row reads as off", !readTokenSafetySchedule("{not json").enabled);
}

console.log("\nWeekday and time boundaries (Mon-Fri 08:00-16:00 UTC; 2026-10-05 is a Monday)");
{
  expectState("Monday 07:59 is outside and turns on at 08:00", work, utc("2026-10-05T07:59"), false, utc("2026-10-05T08:00"));
  expectState("Monday 08:00 exactly is inside", work, utc("2026-10-05T08:00"), true, utc("2026-10-05T16:00"));
  expectState("Monday 15:59 is inside", work, utc("2026-10-05T15:59"), true, utc("2026-10-05T16:00"));
  expectState("Monday 16:00 exactly is outside (end is exclusive)", work, utc("2026-10-05T16:00"), false, utc("2026-10-06T08:00"));
  expectState("Friday evening skips the weekend to Monday 08:00", work, utc("2026-10-09T17:00"), false, utc("2026-10-12T08:00"));
  expectState("Saturday noon is outside", work, utc("2026-10-10T12:00"), false, utc("2026-10-12T08:00"));
  expectState("Sunday 23:59 is outside", work, utc("2026-10-11T23:59"), false, utc("2026-10-12T08:00"));
  expectState("a single weekday finds next week's window", { ...work, days: [0] }, utc("2026-10-11T16:30"), false, utc("2026-10-18T08:00"));
}

console.log("\nOvernight windows belong to the day they start on");
{
  const night: TokenSafetySchedule = { ...work, days: [5], start: "22:00", end: "06:00" };
  expectState("Friday 21:59 waits for 22:00", night, utc("2026-10-09T21:59"), false, utc("2026-10-09T22:00"));
  expectState("Friday 23:00 is inside until Saturday 06:00", night, utc("2026-10-09T23:00"), true, utc("2026-10-10T06:00"));
  expectState("Saturday 05:59 (Friday's window) is inside", night, utc("2026-10-10T05:59"), true, utc("2026-10-10T06:00"));
  expectState("Saturday 06:00 is outside until next Friday", night, utc("2026-10-10T06:00"), false, utc("2026-10-16T22:00"));
  expectState("Friday 03:00 is NOT inside (Thursday was not chosen)", night, utc("2026-10-09T03:00"), false, utc("2026-10-09T22:00"));
  const everyNight: TokenSafetySchedule = { ...work, days: [0, 1, 2, 3, 4, 5, 6], start: "16:00", end: "15:59" };
  expectState("back-to-back overnight windows keep their one-minute gap", everyNight, utc("2026-10-06T15:59"), false, utc("2026-10-06T16:00"));
}

console.log("\nDST in the configured zone (Europe/Berlin; UTC+2 summer, UTC+1 winter)");
{
  const berlin: TokenSafetySchedule = { ...work, timeZone: "Europe/Berlin" };
  // Summer Friday 2026-10-23: 08:00 local = 06:00Z. Clocks fall back on Sunday 2026-10-25, 03:00 to 02:00.
  expectState("summer: 08:00 local is 06:00Z", berlin, utc("2026-10-23T05:00"), false, utc("2026-10-23T06:00"));
  expectState("summer: inside until 16:00 local = 14:00Z", berlin, utc("2026-10-23T10:00"), true, utc("2026-10-23T14:00"));
  expectState("across the fall-back weekend Monday 08:00 local is 07:00Z", berlin, utc("2026-10-23T15:00"), false, utc("2026-10-26T07:00"));
  // Spring forward on Sunday 2027-03-28, 02:00 to 03:00: a Sunday 01:00-05:00 window lasts three real hours.
  const sunday: TokenSafetySchedule = { ...berlin, days: [0], start: "01:00", end: "05:00" };
  expectState("spring-forward night: 01:00 CET is 00:00Z", sunday, utc("2027-03-27T23:00"), false, utc("2027-03-28T00:00"));
  expectState("spring-forward night: ends 05:00 CEST = 03:00Z", sunday, utc("2027-03-28T01:30"), true, utc("2027-03-28T03:00"));
  // A start inside the skipped hour moves forward by the gap, as the calendar does.
  const gap: TokenSafetySchedule = { ...berlin, days: [0], start: "02:30", end: "04:00" };
  expectState("a start in the skipped hour begins at 03:30 CEST = 01:30Z", gap, utc("2027-03-28T00:30"), false, utc("2027-03-28T01:30"));
}

console.log("\nInvalid and empty settings are explained, never silently applied");
{
  check("no weekday", tokenSafetyScheduleProblem({ ...work, days: [] }) === "Pick at least one weekday.");
  check("a weekday out of range", /distinct days/.test(tokenSafetyScheduleProblem({ ...work, days: [7] }) ?? ""));
  check("a repeated weekday", /distinct days/.test(tokenSafetyScheduleProblem({ ...work, days: [1, 1] }) ?? ""));
  check("a malformed start", /Start time/.test(tokenSafetyScheduleProblem({ ...work, start: "8am" }) ?? ""));
  check("an impossible end", /End time/.test(tokenSafetyScheduleProblem({ ...work, end: "24:00" }) ?? ""));
  check("an empty window (start = end)", /same time/.test(tokenSafetyScheduleProblem({ ...work, end: "08:00" }) ?? ""));
  check("an unknown zone", /Unknown time zone/.test(tokenSafetyScheduleProblem({ ...work, timeZone: "Mars/Olympus" }) ?? ""));
  check("the requested schedule is valid", tokenSafetyScheduleProblem(work) === null);
  const stale = readTokenSafetySchedule(JSON.stringify({ ...work, timeZone: "Mars/Olympus" }));
  check("a stored schedule that no longer validates reads as off", !stale.enabled);
  expectState("so the limit stays on around the clock", stale, utc("2026-10-10T12:00"), true, null);
}

console.log("\nPersistence round-trip");
{
  const stored = writeTokenSafetySchedule({ ...work, days: [5, 1, 3] });
  const back = readTokenSafetySchedule(stored);
  check("days come back sorted and the rest intact", back.enabled && back.days.join() === "1,3,5" && back.start === "08:00" && back.end === "16:00" && back.timeZone === "UTC", stored);
}

console.log(`\n=== RESULT: ${failed === 0 ? "PASS ✅" : "FAIL ❌"}: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
