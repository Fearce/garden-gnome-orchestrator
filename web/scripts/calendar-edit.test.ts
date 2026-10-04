/**
 * Drag math for the Calendar tab, viewed from a zone other than the event's. A month-cell drop moves an
 * event by the days between the cell it was SHOWN on and the cell it was dropped on: a 03:00 Copenhagen
 * meeting shows on the previous evening in New York, and dragging it one cell must move it one day.
 * Synthetic values only. Run: `npm run test:calendar --prefix server`.
 */
import assert from "node:assert/strict";
import { movedSpan } from "../src/lib/calendarEdit.js";
import { dateOf, parseDate, wallToEpoch } from "../src/lib/calendarTime.js";

const CPH = "Europe/Copenhagen";
const NY = "America/New_York";

const timed = { allDay: false, start: "2027-03-17T03:00", end: "2027-03-17T04:00" };
const shownOn = dateOf(wallToEpoch({ y: 2027, m: 3, d: 17, hh: 3, mi: 0 }, CPH), NY);
assert.deepEqual(shownOn, { y: 2027, m: 3, d: 16 }, "the meeting shows on the 16th in New York");

const nextCell = movedSpan(timed, CPH, { date: parseDate("2027-03-17")! }, shownOn);
assert.deepEqual(nextCell, { allDay: false, start: "2027-03-18T03:00", end: "2027-03-18T04:00" }, "one cell later is one day later");

const sameCell = movedSpan(timed, CPH, { date: parseDate("2027-03-16")! }, shownOn);
assert.deepEqual(sameCell, timed, "dropping on the cell it sits on moves nothing");

const allDay = { allDay: true, start: "2027-03-17", end: "2027-03-18" };
assert.deepEqual(movedSpan(allDay, CPH, { date: parseDate("2027-03-20")! }), { allDay: true, start: "2027-03-20", end: "2027-03-21" }, "an all-day item moves by its own dates");

console.log("All calendar edit checks passed.");
