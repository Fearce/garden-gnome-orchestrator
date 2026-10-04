import { useMemo, useState } from "react";
import { type CalendarEvent, type CalendarEventInput, type CalendarScope, createEvent, updateEvent } from "../../lib/calendarApi.js";
import { type Span, occurrenceSpan, remindersForAllDay, seriesSpanFromOccurrenceEdit } from "../../lib/calendarEdit.js";
import {
  addDays,
  dayNumber,
  formatClock,
  formatDate,
  fromWallMinutes,
  isValidTimeZone,
  knownTimeZones,
  parseDate,
  parseDateTime,
  wallMinutes,
} from "../../lib/calendarTime.js";
import { RecurrenceEditor } from "./RecurrenceEditor.js";
import { RemindersField } from "./RemindersField.js";

export interface EventEditing {
  event: CalendarEvent;
  /** The occurrence the form was opened from, for a recurring event. */
  occurrenceDate?: string;
}

interface Props {
  initial: CalendarEventInput;
  editing: EventEditing | null;
  /** The clock time the owner's defaults give an all-day event's reminders. */
  allDayTime: string;
  onSaved(): void;
  onCancel(): void;
}

const SCOPE_LABEL: Record<CalendarScope, string> = { occurrence: "Only this event", following: "This and following", series: "All events" };

/** Create or edit a calendar event. A recurring event's save asks which part of the series it means. */
export function EventForm({ initial, editing, allDayTime, onSaved, onCancel }: Props) {
  const before: Span | null = editing ? occurrenceSpan(editing.event, editing.occurrenceDate) : null;
  const exception = editing?.event.exceptions.find((x) => x.date === editing.occurrenceDate);
  const [title, setTitle] = useState(exception?.title ?? initial.title);
  const [notes, setNotes] = useState(exception?.notes ?? initial.notes ?? "");
  const [allDay, setAllDay] = useState(before?.allDay ?? initial.allDay);
  const [startDate, setStartDate] = useState((before?.start ?? initial.start).slice(0, 10));
  const [startTime, setStartTime] = useState(timeOf(before?.start ?? initial.start, "09:00"));
  const [endDate, setEndDate] = useState((before?.end ?? initial.end).slice(0, 10));
  const [endTime, setEndTime] = useState(timeOf(before?.end ?? initial.end, "10:00"));
  const [timeZone, setTimeZone] = useState(initial.timeZone);
  const [recurrence, setRecurrence] = useState(initial.recurrence);
  const [reminders, setReminders] = useState(initial.reminders ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const zones = useMemo(knownTimeZones, []);

  const start = allDay ? startDate : `${startDate}T${startTime}`;
  const end = allDay ? endDate : `${endDate}T${endTime}`;
  const problem = validate(title, allDay, start, end, timeZone);
  const startCivil = parseDate(startDate);
  const recurring = !!editing?.event.recurrence;
  // One occurrence can change its own title, notes and times; anything else belongs to the series.
  const seriesOnlyChanged =
    !!editing && (JSON.stringify(recurrence) !== JSON.stringify(editing.event.recurrence) || JSON.stringify(reminders) !== JSON.stringify(editing.event.reminders) || timeZone !== editing.event.timeZone);

  /** Moving the start keeps the length, like any calendar. */
  const moveStart = (date: string, time: string) => {
    setStartDate(date);
    setStartTime(time);
    if (allDay) {
      const oldStart = parseDate(startDate);
      const newStart = parseDate(date);
      const oldEnd = parseDate(endDate);
      if (oldStart && newStart && oldEnd) setEndDate(formatDate(addDays(newStart, Math.max(0, dayNumber(oldEnd) - dayNumber(oldStart)))));
      return;
    }
    const oldStart = parseDateTime(`${startDate}T${startTime}`);
    const newStart = parseDateTime(`${date}T${time}`);
    const oldEnd = parseDateTime(`${endDate}T${endTime}`);
    if (!oldStart || !newStart) return;
    const length = oldEnd ? Math.max(15, wallMinutes(oldEnd) - wallMinutes(oldStart)) : 60;
    const moved = fromWallMinutes(wallMinutes(newStart) + length);
    setEndDate(formatDate(moved));
    setEndTime(formatClock(moved.hh * 60 + moved.mi));
  };

  const toggleAllDay = (next: boolean) => {
    setAllDay(next);
    if (!next && startDate === endDate) {
      setStartTime("09:00");
      setEndTime("10:00");
    }
    setReminders(remindersForAllDay(reminders, next, allDayTime));
  };

  const fields = (): CalendarEventInput => ({ title: title.trim(), notes: notes.trim() || null, allDay, start, end, timeZone, recurrence, reminders });

  const save = async (scope: CalendarScope) => {
    if (problem || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (!editing) await createEvent(fields());
      else if (!recurring) await updateEvent(editing.event.id, "series", null, fields());
      else if (scope === "occurrence") await updateEvent(editing.event.id, "occurrence", editing.occurrenceDate ?? null, { title: title.trim(), notes: notes.trim() || null, allDay, start, end });
      else if (scope === "following") await updateEvent(editing.event.id, "following", editing.occurrenceDate ?? null, fields());
      else {
        const span = before && editing.occurrenceDate ? seriesSpanFromOccurrenceEdit(editing.event, before, { allDay, start, end }) : { allDay, start, end };
        await updateEvent(editing.event.id, "series", null, { ...fields(), ...span });
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <form
      className="cal-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!recurring) void save("series");
      }}
    >
      <label className="sched-field">
        <span className="sched-label">Title</span>
        <input value={title} maxLength={200} placeholder="e.g. Dentist" onChange={(e) => setTitle(e.target.value)} autoFocus required />
      </label>

      <label className="cal-check">
        <input type="checkbox" checked={allDay} onChange={(e) => toggleAllDay(e.target.checked)} />
        All day
      </label>

      <div className="cal-when">
        <label className="sched-field">
          <span className="sched-label">{allDay ? "From" : "Starts"}</span>
          <span className="cal-inline">
            <input type="date" aria-label="Start date" value={startDate} onChange={(e) => e.target.value && moveStart(e.target.value, startTime)} required />
            {allDay ? null : <input type="time" aria-label="Start time" value={startTime} onChange={(e) => e.target.value && moveStart(startDate, e.target.value)} required />}
          </span>
        </label>
        <label className="sched-field">
          <span className="sched-label">{allDay ? "Until" : "Ends"}</span>
          <span className="cal-inline">
            <input type="date" aria-label="End date" value={endDate} min={startDate} onChange={(e) => e.target.value && setEndDate(e.target.value)} required />
            {allDay ? null : <input type="time" aria-label="End time" value={endTime} onChange={(e) => e.target.value && setEndTime(e.target.value)} required />}
          </span>
        </label>
      </div>

      {allDay ? null : (
        <label className="sched-field">
          <span className="sched-label">Time zone</span>
          <input list="cal-zones" value={timeZone} spellCheck={false} onChange={(e) => setTimeZone(e.target.value.trim())} aria-describedby="cal-zone-hint" />
          <datalist id="cal-zones">
            {zones.map((z) => (
              <option key={z} value={z} />
            ))}
          </datalist>
          <span id="cal-zone-hint" className="cal-hint">
            The event keeps this wall-clock time, also across daylight-saving changes.
          </span>
        </label>
      )}

      {startCivil ? <RecurrenceEditor value={recurrence} start={startCivil} onChange={setRecurrence} /> : null}

      <RemindersField value={reminders} allDay={allDay} allDayTime={allDayTime} onChange={setReminders} />

      <label className="sched-field">
        <span className="sched-label">Notes</span>
        <textarea className="sched-reminder-input" value={notes} maxLength={4000} placeholder="Optional" onChange={(e) => setNotes(e.target.value)} />
      </label>

      {error || (problem && title) ? (
        <div className="cal-error" role="alert">
          {error ?? problem}
        </div>
      ) : null}

      <div className="m-foot cal-foot">
        <button type="button" className="btn ghost" onClick={onCancel}>
          Cancel
        </button>
        {recurring ? (
          <div className="cal-scope-save" role="group" aria-label="Save changes to">
            <span className="cal-scope-label">Save</span>
            {(["occurrence", "following", "series"] as CalendarScope[]).map((scope) => (
              <button
                key={scope}
                type="button"
                className={"btn " + (scope === "occurrence" ? "primary" : "ghost")}
                disabled={!!problem || busy || (scope === "occurrence" && seriesOnlyChanged)}
                title={scope === "occurrence" && seriesOnlyChanged ? "The repeat, reminder and time zone belong to the whole series" : undefined}
                onClick={() => void save(scope)}
              >
                {SCOPE_LABEL[scope]}
              </button>
            ))}
          </div>
        ) : (
          <button type="submit" className="btn primary" disabled={!!problem || busy}>
            {busy ? "Saving…" : editing ? "Save changes" : "Create event"}
          </button>
        )}
      </div>
    </form>
  );
}

function timeOf(text: string, fallback: string): string {
  return text.length > 10 ? text.slice(11, 16) : fallback;
}

function validate(title: string, allDay: boolean, start: string, end: string, timeZone: string): string | null {
  if (!title.trim()) return "A title is required.";
  if (allDay) {
    const s = parseDate(start);
    const e = parseDate(end);
    if (!s || !e) return "Pick the dates.";
    return dayNumber(e) < dayNumber(s) ? "The event ends before it starts." : null;
  }
  if (!isValidTimeZone(timeZone)) return "Choose a known time zone, e.g. Europe/Copenhagen.";
  const s = parseDateTime(start);
  const e = parseDateTime(end);
  if (!s || !e) return "Pick the start and end.";
  if (wallMinutes(e) <= wallMinutes(s)) return "The event must end after it starts.";
  return null;
}
