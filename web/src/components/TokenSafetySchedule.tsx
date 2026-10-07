import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { TokenSafetySchedule, TokenSafetyScheduleState } from "../types.js";

// The Token safety limit's scheduled hours: which weekdays and between which times the limit applies.
// Mirrors server/src/orchestrator/tokenSafetySchedule.ts, which owns the real evaluation; the console
// validates a draft before sending so an unusable schedule never reaches the server.

/** Monday-first, as the owner reads a week. `day` is the stored 0 = Sunday … 6 = Saturday index. */
export const SCHEDULE_WEEKDAYS: ReadonlyArray<{ day: number; short: string; name: string }> = [
  { day: 1, short: "M", name: "Monday" },
  { day: 2, short: "T", name: "Tuesday" },
  { day: 3, short: "W", name: "Wednesday" },
  { day: 4, short: "T", name: "Thursday" },
  { day: 5, short: "F", name: "Friday" },
  { day: 6, short: "S", name: "Saturday" },
  { day: 0, short: "S", name: "Sunday" },
];

const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isKnownTimeZone(zone: string): boolean {
  if (!zone.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Why this draft cannot be saved, in the owner's words, or null when it is usable. */
export function scheduleDraftProblem(s: TokenSafetySchedule): string | null {
  if (!s.days.length) return "Pick at least one weekday.";
  if (!CLOCK.test(s.start)) return "Set a start time.";
  if (!CLOCK.test(s.end)) return "Set an end time.";
  if (s.start === s.end) return "Start and end are the same time, so the window would be empty.";
  if (!isKnownTimeZone(s.timeZone)) return `"${s.timeZone}" is not a time zone this browser knows. Use an IANA name such as Europe/Berlin.`;
  return null;
}

/** "Ends Fri 16:00" style wording for the next edge, read in the schedule's own zone. */
export function scheduleStatusLine(state: TokenSafetyScheduleState, timeZone: string, now = Date.now()): string {
  const head = state.active ? "Applies now" : "Suspended now";
  if (state.nextChangeAt == null) return head + ".";
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    ...(state.nextChangeAt - now > 6 * 86_400_000 ? { day: "numeric", month: "short" } : {}),
  }).format(state.nextChangeAt);
  return `${head}. ${state.active ? "Lifts" : "Applies again"} ${parts.replace(",", "")}.`;
}

/** Whether the end falls on the next day, so the editor can say so instead of leaving it implied. */
export function runsOvernight(s: TokenSafetySchedule): boolean {
  return CLOCK.test(s.start) && CLOCK.test(s.end) && s.end < s.start;
}

/** Day toggles, times, zone, and the live on/off status. Shown while the schedule is switched on. */
export function TokenSafetyScheduleEditor({
  saved,
  scheduleState,
  onSave,
}: {
  saved: TokenSafetySchedule;
  scheduleState: TokenSafetyScheduleState | null;
  onSave: (schedule: TokenSafetySchedule) => void;
}) {
  const [draft, setDraft] = useState<TokenSafetySchedule>(saved);
  const [zoneDraft, setZoneDraft] = useState(saved.timeZone);
  const dayRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Keyed on content: every settings broadcast carries a fresh object, and an unrelated toggle must not
  // wipe a half-typed zone.
  const savedKey = JSON.stringify(saved);
  useEffect(() => {
    setDraft(saved);
    setZoneDraft(saved.timeZone);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);

  const problem = scheduleDraftProblem(draft);
  const update = (patch: Partial<TokenSafetySchedule>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    if (!scheduleDraftProblem(next)) onSave(next);
  };
  const toggleDay = (day: number) =>
    update({ days: draft.days.includes(day) ? draft.days.filter((d) => d !== day) : [...draft.days, day].sort((a, b) => a - b) });
  const commitZone = () => {
    const zone = zoneDraft.trim();
    if (zone !== draft.timeZone) update({ timeZone: zone });
  };
  const moveFocus = (index: number, e: ReactKeyboardEvent<HTMLButtonElement>) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    const target = e.key === "Home" ? 0 : e.key === "End" ? SCHEDULE_WEEKDAYS.length - 1 : step ? (index + step + SCHEDULE_WEEKDAYS.length) % SCHEDULE_WEEKDAYS.length : -1;
    if (target < 0) return;
    e.preventDefault();
    dayRefs.current[target]?.focus();
  };

  return (
    <div className="tss">
      <div className="tss-line">
        <div className="tss-days" role="group" aria-label="Weekdays the limit applies">
          {SCHEDULE_WEEKDAYS.map((w, i) => {
            const on = draft.days.includes(w.day);
            return (
              <button
                key={w.day}
                ref={(el) => {
                  dayRefs.current[i] = el;
                }}
                type="button"
                className={"tss-day" + (on ? " on" : "")}
                aria-pressed={on}
                aria-label={w.name}
                title={w.name}
                onClick={() => toggleDay(w.day)}
                onKeyDown={(e) => moveFocus(i, e)}
              >
                {w.short}
              </button>
            );
          })}
        </div>
        <div className="tss-times">
          <label className="tss-time">
            <span>From</span>
            <input type="time" value={draft.start} onChange={(e) => update({ start: e.target.value })} aria-label="Start time" />
          </label>
          <label className="tss-time">
            <span>to</span>
            <input type="time" value={draft.end} onChange={(e) => update({ end: e.target.value })} aria-label="End time" />
          </label>
        </div>
      </div>
      <label className="tss-zone">
        <span>Time zone</span>
        <input
          className="text-input"
          value={zoneDraft}
          spellCheck={false}
          aria-label="Time zone"
          onChange={(e) => setZoneDraft(e.target.value)}
          onBlur={commitZone}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitZone();
          }}
        />
        <span className="tss-zone-note">Daylight saving follows this zone, so {draft.start || "the start"} stays {draft.start || "the start"} all year.</span>
      </label>
      {problem ? (
        <p className="tss-status warn" role="alert">
          {problem} Not saved yet; the last valid hours still apply.
        </p>
      ) : (
        <p className="tss-status" aria-live="polite">
          {runsOvernight(draft) ? `Runs overnight, ending at ${draft.end} the next day. ` : ""}
          {scheduleState ? scheduleStatusLine(scheduleState, saved.timeZone) : ""}
        </p>
      )}
    </div>
  );
}
