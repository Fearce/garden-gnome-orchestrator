// When the Token safety limit applies: always (the default), or only inside weekly wall-clock windows.
//
// The owner keeps the limit for the hours they need their own allowance (for example Monday–Friday
// 08:00–16:00) and lets GGO spend freely outside them. A window is a start and end time on each chosen
// weekday, read in one explicit IANA zone so a DST change keeps "08:00" at 08:00. An end at or before
// the start runs overnight into the next day, and that window belongs to the day it starts on.

import { addDays, epochToWall, isValidTimeZone, parseClock, serverTimeZone, wallToEpoch, weekday, type CivilDate } from "../calendar/zoned.js";
import type { TokenSafetySchedule, TokenSafetyScheduleState } from "../types.js";

export type { TokenSafetySchedule, TokenSafetyScheduleState };

export const TOKEN_SAFETY_SCHEDULE_KV = "setting_token_limit_schedule";
const WORKDAYS = [1, 2, 3, 4, 5];

/** What an installation without a stored schedule reads: off, pre-filled with a working week in the server's zone. */
export function defaultTokenSafetySchedule(timeZone = serverTimeZone()): TokenSafetySchedule {
  return { enabled: false, days: [...WORKDAYS], start: "08:00", end: "16:00", timeZone };
}

/** Why this schedule cannot be used, in words for the owner, or null when it is valid. Checked even while
 *  disabled, so switching it on later can never turn on an empty or unreadable window. */
export function tokenSafetyScheduleProblem(s: TokenSafetySchedule): string | null {
  if (!s.days.length) return "Pick at least one weekday.";
  if (s.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6) || new Set(s.days).size !== s.days.length) return "Weekdays must be distinct days of the week.";
  const start = parseClock(s.start);
  const end = parseClock(s.end);
  if (start == null) return "Start time must be a 24-hour time such as 08:00.";
  if (end == null) return "End time must be a 24-hour time such as 16:00.";
  if (start === end) return "Start and end are the same time, so the window would be empty. An end before the start runs overnight.";
  if (!isValidTimeZone(s.timeZone)) return `Unknown time zone "${s.timeZone}". Use an IANA name such as America/New_York.`;
  return null;
}

/** The stored schedule, or the default when none is stored. A stored value that no longer validates (a zone
 *  the runtime dropped) reads as disabled, which keeps the limit on around the clock rather than off. */
export function readTokenSafetySchedule(raw: string | null): TokenSafetySchedule {
  if (!raw) return defaultTokenSafetySchedule();
  try {
    const v = JSON.parse(raw) as Partial<TokenSafetySchedule>;
    const s: TokenSafetySchedule = {
      enabled: v.enabled === true,
      days: Array.isArray(v.days) ? [...v.days].sort((a, b) => a - b) : [],
      start: typeof v.start === "string" ? v.start : "",
      end: typeof v.end === "string" ? v.end : "",
      timeZone: typeof v.timeZone === "string" ? v.timeZone : "",
    };
    return tokenSafetyScheduleProblem(s) ? { ...s, enabled: false } : s;
  } catch {
    return defaultTokenSafetySchedule();
  }
}

export function writeTokenSafetySchedule(s: TokenSafetySchedule): string {
  return JSON.stringify({ ...s, days: [...s.days].sort((a, b) => a - b) });
}

/** The schedule's windows overlapping [from - 1 day, to + 1 day], as merged [start, end) epoch intervals. */
function windows(s: TokenSafetySchedule, from: number, to: number): Array<[number, number]> {
  const startMin = parseClock(s.start)!;
  const endMin = parseClock(s.end)!;
  const at = (d: CivilDate, minutes: number): number => wallToEpoch({ ...d, hh: Math.floor(minutes / 60), mi: minutes % 60 }, s.timeZone);
  const first = epochToWall(from, s.timeZone);
  const days = Math.ceil((to - from) / 86_400_000) + 2;
  const spans: Array<[number, number]> = [];
  for (let i = -1; i <= days; i++) {
    const day = addDays(first, i);
    if (!s.days.includes(weekday(day))) continue;
    const begin = at(day, startMin);
    const finish = at(endMin > startMin ? day : addDays(day, 1), endMin);
    if (finish > begin) spans.push([begin, finish]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([...span]);
  }
  return merged;
}

/** Whether the limit applies at `now` and when that next changes. Disabled: always on, no transition. */
export function tokenSafetyScheduleState(s: TokenSafetySchedule, now: number): TokenSafetyScheduleState {
  if (!s.enabled || tokenSafetyScheduleProblem(s)) return { active: true, nextChangeAt: null };
  for (const [begin, finish] of windows(s, now, now + 8 * 86_400_000)) {
    if (now < begin) return { active: false, nextChangeAt: begin };
    if (now < finish) return { active: true, nextChangeAt: finish };
  }
  // Unreachable with a valid schedule (some chosen weekday falls within any eight days), kept total.
  return { active: false, nextChangeAt: null };
}
