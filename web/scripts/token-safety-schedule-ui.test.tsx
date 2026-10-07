import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TokenSafetySchedule } from "../src/types.js";

// Same classic-JSX shim as the other standalone web gates launched from the server package.
Object.assign(globalThis, {
  React,
  document: {
    baseURI: "http://localhost/",
    visibilityState: "visible",
    addEventListener: () => {},
    removeEventListener: () => {},
  },
});
const { SCHEDULE_WEEKDAYS, TokenSafetyScheduleEditor, runsOvernight, scheduleDraftProblem, scheduleStatusLine } = await import(
  "../src/components/TokenSafetySchedule.js"
);

const work: TokenSafetySchedule = { enabled: true, days: [1, 2, 3, 4, 5], start: "08:00", end: "16:00", timeZone: "Europe/Berlin" };

// Day strip: Monday first, seven independent days, stored as 0 = Sunday.
assert.deepEqual(SCHEDULE_WEEKDAYS.map((w) => w.short).join(""), "MTWTFSS");
assert.deepEqual(SCHEDULE_WEEKDAYS.map((w) => w.day), [1, 2, 3, 4, 5, 6, 0]);

// Validation the editor applies before sending anything.
assert.equal(scheduleDraftProblem(work), null);
assert.equal(scheduleDraftProblem({ ...work, days: [] }), "Pick at least one weekday.");
assert.equal(scheduleDraftProblem({ ...work, start: "" }), "Set a start time.");
assert.equal(scheduleDraftProblem({ ...work, end: "24:00" }), "Set an end time.");
assert.match(scheduleDraftProblem({ ...work, end: "08:00" }) ?? "", /window would be empty/);
assert.match(scheduleDraftProblem({ ...work, timeZone: "Mars/Olympus" }) ?? "", /not a time zone/);
assert.equal(runsOvernight({ ...work, start: "22:00", end: "06:00" }), true);
assert.equal(runsOvernight(work), false);

// Status wording reads the next edge in the schedule's own zone (Friday 2026-10-09 16:00 Berlin = 14:00 UTC).
const friEnd = Date.UTC(2026, 9, 9, 14, 0);
assert.equal(scheduleStatusLine({ active: true, nextChangeAt: friEnd }, "Europe/Berlin", friEnd - 3_600_000), "Applies now. Lifts Fri 16:00.");
const monStart = Date.UTC(2026, 9, 12, 6, 0);
assert.equal(scheduleStatusLine({ active: false, nextChangeAt: monStart }, "Europe/Berlin", friEnd), "Suspended now. Applies again Mon 08:00.");
assert.equal(scheduleStatusLine({ active: false, nextChangeAt: monStart }, "Europe/Berlin", monStart - 7 * 86_400_000), "Suspended now. Applies again Mon 12 Oct 08:00.");

// Markup: pressed state and full names on every day, the times, the zone and the live status.
const html = renderToStaticMarkup(
  <TokenSafetyScheduleEditor saved={work} scheduleState={{ active: true, nextChangeAt: friEnd }} onSave={() => {}} />,
);
for (const w of SCHEDULE_WEEKDAYS) {
  const pressed = work.days.includes(w.day);
  assert.ok(html.includes(`aria-pressed="${pressed}" aria-label="${w.name}"`), `${w.name} carries its name and pressed=${pressed}`);
}
assert.ok(html.includes('role="group" aria-label="Weekdays the limit applies"'));
assert.ok(html.includes('value="08:00"') && html.includes('value="16:00"'));
assert.ok(html.includes('value="Europe/Berlin"'));
assert.ok(html.includes("Applies now. Lifts Fri 16:00."));

// An overnight weekend window says where it ends; an unsaved invalid draft is never shown as live.
const night = renderToStaticMarkup(
  <TokenSafetyScheduleEditor
    saved={{ ...work, days: [6, 0], start: "22:00", end: "06:00" }}
    scheduleState={{ active: false, nextChangeAt: null }}
    onSave={() => {}}
  />,
);
assert.ok(night.includes("Runs overnight, ending at 06:00 the next day."));
assert.ok(night.includes('aria-pressed="true" aria-label="Saturday"') && night.includes('aria-pressed="false" aria-label="Monday"'));

console.log("token-safety-schedule-ui: ok");
