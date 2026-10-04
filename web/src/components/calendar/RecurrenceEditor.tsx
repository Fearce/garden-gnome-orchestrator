import { useId } from "react";
import type { CalendarFreq, CalendarRecurrence, MonthlyBy } from "../../lib/calendarApi.js";
import { type CivilDate, addDays, daysInMonth, formatDate, weekday } from "../../lib/calendarTime.js";
import { describeRecurrence } from "../../lib/calendarLayout.js";

const UNIT: Record<CalendarFreq, [string, string]> = { daily: ["day", "days"], weekly: ["week", "weeks"], monthly: ["month", "months"], yearly: ["year", "years"] };
const WEEK = [1, 2, 3, 4, 5, 6, 0];
const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const ORDINAL = ["first", "second", "third", "fourth", "fifth"];

type Ends = "never" | "until" | "count";

/** The event form's repeat controls: frequency, interval, the weekly day set, the monthly pattern and
 *  how the series ends, with the rule read back in words underneath. */
export function RecurrenceEditor({ value, start, onChange }: { value: CalendarRecurrence | null; start: CivilDate; onChange(next: CalendarRecurrence | null): void }) {
  const id = useId();
  const startDow = weekday(start);
  const lastWeek = start.d + 7 > daysInMonth(start.y, start.m);
  const set = (patch: Partial<CalendarRecurrence>) => value && onChange({ ...value, ...patch });
  const ends: Ends = value?.until ? "until" : value?.count ? "count" : "never";

  const chooseFreq = (freq: CalendarFreq | "") => {
    if (!freq) return onChange(null);
    onChange({ freq, interval: value?.interval ?? 1, weekdays: freq === "weekly" ? (value?.weekdays ?? [startDow]) : null, monthlyBy: freq === "monthly" ? (value?.monthlyBy ?? "monthday") : null, until: value?.until ?? null, count: value?.count ?? null });
  };
  const toggleDay = (d: number) => {
    if (!value || d === startDow) return;
    const days = new Set(value.weekdays ?? [startDow]);
    if (days.has(d)) days.delete(d);
    else days.add(d);
    set({ weekdays: [...days] });
  };

  return (
    <fieldset className="cal-fieldset">
      <legend className="sched-label">Repeat</legend>
      <div className="cal-recur-row">
        <select aria-label="Repeat" value={value?.freq ?? ""} onChange={(e) => chooseFreq(e.target.value as CalendarFreq | "")}>
          <option value="">Does not repeat</option>
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
          <option value="monthly">Monthly</option>
          <option value="yearly">Yearly</option>
        </select>
        {value ? (
          <label className="cal-inline">
            every
            <input
              type="number"
              min={1}
              max={99}
              aria-label="Repeat interval"
              value={value.interval}
              onChange={(e) => set({ interval: Math.max(1, Math.min(99, Math.round(Number(e.target.value) || 1))) })}
            />
            {UNIT[value.freq][value.interval === 1 ? 0 : 1]}
          </label>
        ) : null}
      </div>

      {value?.freq === "weekly" ? (
        <div className="cal-weekdays" role="group" aria-label="Repeat on">
          {WEEK.map((d) => {
            const on = d === startDow || !!value.weekdays?.includes(d);
            return (
              <button
                key={d}
                type="button"
                className={"sched-day" + (on ? " on" : "")}
                aria-pressed={on}
                aria-label={DAY_LONG[d]}
                disabled={d === startDow}
                title={d === startDow ? "The event's own start day always repeats" : undefined}
                onClick={() => toggleDay(d)}
              >
                {DAY_SHORT[d]}
              </button>
            );
          })}
        </div>
      ) : null}

      {value?.freq === "monthly" ? (
        <div className="cal-radios" role="radiogroup" aria-label="Monthly on">
          {(
            [
              ["monthday", `Day ${start.d}`],
              ["nthWeekday", `The ${ORDINAL[Math.ceil(start.d / 7) - 1]} ${DAY_LONG[startDow]}`],
              ...(lastWeek ? [["lastWeekday", `The last ${DAY_LONG[startDow]}`]] : []),
            ] as [MonthlyBy, string][]
          ).map(([by, label]) => (
            <label key={by} className="cal-radio">
              <input type="radio" name={`${id}-monthly`} checked={(value.monthlyBy ?? "monthday") === by} onChange={() => set({ monthlyBy: by })} />
              {label}
            </label>
          ))}
        </div>
      ) : null}

      {value ? (
        <div className="cal-radios" role="radiogroup" aria-label="Ends">
          <label className="cal-radio">
            <input type="radio" name={`${id}-ends`} checked={ends === "never"} onChange={() => set({ until: null, count: null })} />
            Never ends
          </label>
          <label className="cal-radio">
            <input type="radio" name={`${id}-ends`} checked={ends === "until"} onChange={() => set({ until: formatDate(addDays(start, 30)), count: null })} />
            Ends on
            <input type="date" aria-label="Last date" disabled={ends !== "until"} min={formatDate(start)} value={value.until ?? ""} onChange={(e) => e.target.value && set({ until: e.target.value })} />
          </label>
          <label className="cal-radio">
            <input type="radio" name={`${id}-ends`} checked={ends === "count"} onChange={() => set({ count: 10, until: null })} />
            Ends after
            <input
              type="number"
              aria-label="Number of occurrences"
              min={1}
              max={999}
              disabled={ends !== "count"}
              value={value.count ?? ""}
              onChange={(e) => set({ count: Math.max(1, Math.min(999, Math.round(Number(e.target.value) || 1))) })}
            />
            times
          </label>
        </div>
      ) : null}

      {value ? <div className="cal-hint">{describeRecurrence(value, start)}</div> : null}
    </fieldset>
  );
}
