import { useState } from "react";
import { type CalendarDefaults, type CalendarReminder, saveDefaults } from "../../lib/calendarApi.js";
import { MAX_REMINDER_DAYS, MAX_REMINDERS } from "../../lib/calendarEdit.js";
import { describeReminder } from "../../lib/calendarLayout.js";
import { CloseIcon, PlusIcon } from "./CalendarItem.js";

const MAX_LEAD_MINUTES = MAX_REMINDER_DAYS * 1440;
const TIMED_PRESETS = [0, 5, 10, 15, 30, 60, 120, 1440, 10080];
const ALL_DAY_PRESETS = (time: string): CalendarReminder[] => [
  { kind: "day", daysBefore: 0, time },
  { kind: "day", daysBefore: 1, time },
  { kind: "day", daysBefore: 1, time: "18:00" },
  { kind: "day", daysBefore: 2, time },
  { kind: "day", daysBefore: 7, time },
];
// What "Add reminder" offers next: the first of these the list does not have yet.
const TIMED_SUGGESTIONS = [15, 60, 1440, 10080, 30, 120];
const DEFAULT_SUGGESTIONS = [10080, 1440, 60, 15, 30];

const keyOf = (r: CalendarReminder): string => (r.kind === "before" ? `b:${r.minutes}` : `d:${r.daysBefore}:${r.time}`);

/** An event's reminders, up to five, each a common choice or a custom lead. None: the event sends nothing. */
export function RemindersField({ value, allDay, allDayTime, onChange }: { value: CalendarReminder[]; allDay: boolean; allDayTime: string; onChange(next: CalendarReminder[]): void }) {
  const add = () => onChange([...value, suggestion(value, allDay, allDayTime)]);
  return (
    <div className="sched-field">
      <span className="sched-label">Reminders</span>
      {value.length ? (
        <ul className="cal-reminders">
          {value.map((r, i) => (
            <li key={i} className="cal-recur-row">
              <ReminderChoice value={r} allDay={allDay} allDayTime={allDayTime} label={`Reminder ${i + 1}`} onChange={(next) => onChange(value.map((x, j) => (j === i ? next : x)))} />
              <RemoveButton label={`Remove reminder ${i + 1}`} onClick={() => onChange(value.filter((_, j) => j !== i))} />
            </li>
          ))}
        </ul>
      ) : null}
      {value.length < MAX_REMINDERS ? <AddButton onClick={add} /> : null}
      <div className="cal-hint">{value.length ? "Each goes to your Discord DMs. No agent is started." : "No reminders: the event sends nothing and starts nothing."}</div>
    </div>
  );
}

/**
 * The owner's default reminders: what every new event starts with. Leads apply as they are to a timed
 * event, and as whole days before, at one clock time, to an all-day event.
 */
export function DefaultRemindersForm({ initial, onDone }: { initial: CalendarDefaults; onDone(): void }) {
  const [leads, setLeads] = useState(initial.reminderLeads);
  const [allDayTime, setAllDayTime] = useState(initial.allDayTime);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await saveDefaults({ reminderLeads: leads, allDayTime });
      onDone();
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
        void save();
      }}
    >
      <p className="cal-hint cal-lede">New events start with these reminders. Each event can still change or drop them; events you already have keep their own.</p>
      <div className="sched-field">
        <span className="sched-label">Remind me</span>
        {leads.length ? (
          <ul className="cal-reminders">
            {leads.map((minutes, i) => (
              <li key={i} className="cal-recur-row">
                <LeadInput minutes={minutes} label={`Default reminder ${i + 1}`} onChange={(m) => setLeads(leads.map((x, j) => (j === i ? m : x)))} />
                <RemoveButton label={`Remove default reminder ${i + 1}`} onClick={() => setLeads(leads.filter((_, j) => j !== i))} />
              </li>
            ))}
          </ul>
        ) : null}
        {leads.length < MAX_REMINDERS ? <AddButton onClick={() => setLeads([...leads, DEFAULT_SUGGESTIONS.find((m) => !leads.includes(m)) ?? 60])} /> : null}
        <div className="cal-hint">{leads.length ? "Sent to your Discord DMs before each new event." : "No defaults: a new event starts without reminders."}</div>
      </div>
      <label className="sched-field">
        <span className="sched-label">All-day events</span>
        <span className="cal-inline">
          Remind at
          <input type="time" aria-label="All-day reminder time" value={allDayTime} onChange={(e) => e.target.value && setAllDayTime(e.target.value)} required />
        </span>
        <span className="cal-hint">An all-day event gets each reminder as whole days before, at this time.</span>
      </label>
      {error ? (
        <div className="cal-error" role="alert">
          {error}
        </div>
      ) : null}
      <div className="m-foot cal-foot">
        <button type="button" className="btn ghost" onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? "Saving…" : "Save defaults"}
        </button>
      </div>
    </form>
  );
}

function ReminderChoice(p: { value: CalendarReminder; allDay: boolean; allDayTime: string; label: string; onChange(next: CalendarReminder): void }) {
  const { value, allDay, label, onChange } = p;
  const presets: CalendarReminder[] = allDay ? ALL_DAY_PRESETS(p.allDayTime) : TIMED_PRESETS.map((minutes) => ({ kind: "before", minutes }));
  // A preset key can repeat when the all-day time is 18:00; keep the first.
  const shown = presets.filter((r, i) => presets.findIndex((x) => keyOf(x) === keyOf(r)) === i);
  const isPreset = presets.some((p) => keyOf(p) === keyOf(value));
  const choose = (key: string) => {
    if (key === "custom") return onChange(allDay ? { kind: "day", daysBefore: 3, time: p.allDayTime } : { kind: "before", minutes: 45 });
    const preset = presets.find((p) => keyOf(p) === key);
    if (preset) onChange(preset);
  };
  return (
    <>
      <select aria-label={label} value={isPreset ? keyOf(value) : "custom"} onChange={(e) => choose(e.target.value)}>
        {shown.map((r) => (
          <option key={keyOf(r)} value={keyOf(r)}>
            {describeReminder(r)}
          </option>
        ))}
        <option value="custom">Custom…</option>
      </select>
      {!isPreset && value.kind === "before" ? <LeadInput minutes={value.minutes} label={`${label} lead`} onChange={(minutes) => onChange({ kind: "before", minutes })} /> : null}
      {!isPreset && value.kind === "day" ? (
        <span className="cal-inline">
          <input
            type="number"
            min={0}
            max={MAX_REMINDER_DAYS}
            aria-label={`${label} days before`}
            value={value.daysBefore}
            onChange={(e) => onChange({ ...value, daysBefore: Math.max(0, Math.min(MAX_REMINDER_DAYS, Math.round(Number(e.target.value) || 0))) })}
          />
          days before at
          <input type="time" aria-label={`${label} time`} value={value.time} onChange={(e) => e.target.value && onChange({ ...value, time: e.target.value })} />
        </span>
      ) : null}
    </>
  );
}

/** A lead before the start, as an amount and a unit. */
function LeadInput({ minutes, label, onChange }: { minutes: number; label: string; onChange(m: number): void }) {
  const unit = [10080, 1440, 60].find((u) => minutes > 0 && minutes % u === 0) ?? 1;
  const amount = minutes / unit;
  const max = Math.floor(MAX_LEAD_MINUTES / unit);
  return (
    <span className="cal-inline">
      <input type="number" min={0} max={max} aria-label={label} value={amount} onChange={(e) => onChange(Math.max(0, Math.min(max, Math.round(Number(e.target.value) || 0))) * unit)} />
      <select aria-label={`${label} unit`} value={unit} onChange={(e) => onChange(Math.min(MAX_LEAD_MINUTES, amount * Number(e.target.value)))}>
        <option value={1}>minutes</option>
        <option value={60}>hours</option>
        <option value={1440}>days</option>
        <option value={10080}>weeks</option>
      </select>
      before
    </span>
  );
}

function AddButton({ onClick }: { onClick(): void }) {
  return (
    <button type="button" className="btn ghost sm cal-add-reminder" onClick={onClick}>
      <PlusIcon /> Add reminder
    </button>
  );
}

function RemoveButton({ label, onClick }: { label: string; onClick(): void }) {
  return (
    <button type="button" className="btn ghost sm cal-icon-btn" aria-label={label} title="Remove" onClick={onClick}>
      <CloseIcon />
    </button>
  );
}

function suggestion(list: CalendarReminder[], allDay: boolean, allDayTime: string): CalendarReminder {
  const taken = new Set(list.map(keyOf));
  const options: CalendarReminder[] = allDay
    ? [1, 7, 0, 2].map((daysBefore) => ({ kind: "day", daysBefore, time: allDayTime }))
    : TIMED_SUGGESTIONS.map((minutes) => ({ kind: "before", minutes }));
  return options.find((r) => !taken.has(keyOf(r))) ?? options[0]!;
}
