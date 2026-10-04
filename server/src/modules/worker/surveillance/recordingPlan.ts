/**
 * When the cameras record, and what is kept. Nothing records until the owner picks a mode: `continuous` is
 * the 24/7 option, `schedule` records inside a daily window, and `off` is the default for every setup.
 */

export type RecordingMode = "off" | "continuous" | "schedule";

export interface RecordingSchedule {
  /** Days the window starts on, 0 = Sunday. A window that ends at or before its start runs past midnight. */
  days: number[];
  /** Local wall-clock times, "HH:MM". */
  start: string;
  end: string;
}

export interface RecordingSettings {
  mode: RecordingMode;
  schedule: RecordingSchedule;
  segmentMinutes: number;
  /** Segments older than this are deleted; 0 keeps them all. */
  retentionDays: number;
  /** Each camera's folder is trimmed, oldest first, to this size; 0 sets no cap. */
  maxGbPerCamera: number;
}

export const SEGMENT_MINUTE_CHOICES = [1, 5, 10, 15, 30, 60];
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

/** Off, and keep everything: a recording folder may already hold footage, so deleting any is the owner's call. */
export function defaultRecordingSettings(): RecordingSettings {
  return { mode: "off", schedule: { days: [...EVERY_DAY], start: "22:00", end: "07:00" }, segmentMinutes: 15, retentionDays: 0, maxGbPerCamera: 0 };
}

export function normalizeRecordingSettings(raw: unknown, fallback: RecordingSettings): RecordingSettings {
  if (!raw || typeof raw !== "object") return { ...fallback, schedule: { ...fallback.schedule, days: [...fallback.schedule.days] } };
  const input = raw as Record<string, unknown>;
  const schedule = (input.schedule && typeof input.schedule === "object" ? input.schedule : {}) as Record<string, unknown>;
  const days = Array.isArray(schedule.days) ? [...new Set(schedule.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort() : fallback.schedule.days;
  const segment = Number(input.segmentMinutes);
  return {
    mode: input.mode === "continuous" || input.mode === "schedule" ? input.mode : "off",
    schedule: { days, start: clockOr(schedule.start, fallback.schedule.start), end: clockOr(schedule.end, fallback.schedule.end) },
    segmentMinutes: SEGMENT_MINUTE_CHOICES.includes(segment) ? segment : fallback.segmentMinutes,
    retentionDays: boundedNumber(input.retentionDays, 0, 3650, fallback.retentionDays, true),
    maxGbPerCamera: boundedNumber(input.maxGbPerCamera, 0, 100_000, fallback.maxGbPerCamera, false),
  };
}

export interface ScheduleState {
  active: boolean;
  /** When `active` next flips, or null when it never does (no days chosen, or a window that never closes). */
  nextChangeAt: number | null;
}

/** Whether the schedule's window is open at `now`, and when that next changes. Times are the machine's local time. */
export function scheduleState(schedule: RecordingSchedule, now = new Date()): ScheduleState {
  const at = now.getTime();
  const windows = mergedWindows(schedule, now);
  const open = windows.find(([start, end]) => start <= at && at < end);
  if (open) return { active: true, nextChangeAt: open[1] >= horizon(now) ? null : open[1] };
  const next = windows.find(([start]) => start > at);
  return { active: false, nextChangeAt: next ? next[0] : null };
}

/** Each day's window from yesterday to a week out, overlapping and touching windows joined. */
function mergedWindows(schedule: RecordingSchedule, now: Date): Array<[number, number]> {
  const [startH, startM] = parseClock(schedule.start);
  const [endH, endM] = parseClock(schedule.end);
  const windows: Array<[number, number]> = [];
  for (let offset = -1; offset <= 8; offset += 1) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
    if (!schedule.days.includes(day.getDay())) continue;
    const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), startH, startM).getTime();
    let end = new Date(day.getFullYear(), day.getMonth(), day.getDate(), endH, endM).getTime();
    if (end <= start) end = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1, endH, endM).getTime();
    windows.push([start, end]);
  }
  windows.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const window of windows) {
    const last = merged.at(-1);
    if (last && window[0] <= last[1]) last[1] = Math.max(last[1], window[1]);
    else merged.push([...window]);
  }
  return merged;
}

/** The start of the last day computed; a window still open there is treated as never closing. */
function horizon(now: Date): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 8).getTime();
}

function parseClock(value: string): [number, number] {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  return match ? [Number(match[1]), Number(match[2])] : [0, 0];
}

function clockOr(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return fallback;
  return `${match[1]!.padStart(2, "0")}:${match[2]}`;
}

function boundedNumber(value: unknown, min: number, max: number, fallback: number, integer: boolean): number {
  if (value === "" || value === null || value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const bounded = Math.max(min, Math.min(max, n));
  return integer ? Math.round(bounded) : Math.round(bounded * 10) / 10;
}
