import { useState } from "react";
import { useStore } from "../../store.js";
import type { ScheduledTask } from "../../types.js";
import { type ReminderRepeat, instantOf, reminderCron } from "../../lib/calendarEdit.js";
import { type CivilDate, epochToWall, formatCivil, formatClock, formatDate, parseDate, weekday } from "../../lib/calendarTime.js";

export interface ReminderDraft {
  schedule: ScheduledTask | null;
  date: string;
  time: string;
  repeat: ReminderRepeat;
}

interface Props {
  draft: ReminderDraft;
  timeZone: string;
  serverTimeZone: string;
  onSaved(): void;
  onCancel(): void;
  /** Hand over to the full schedule editor (custom cron, effort, model …) with what was typed so far. */
  onAdvanced(draft: { title: string; reminder: string; cron: string; runOnce: boolean }): void;
}

// The scheduler's own cap (scheduler.ts REMINDER_MAX_CHARS): a Discord DM, less the title line.
const REMINDER_MAX_CHARS = 1800;
const DAY_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function repeatLabel(repeat: ReminderRepeat, date: CivilDate): string {
  switch (repeat) {
    case "none":
      return "Does not repeat";
    case "daily":
      return "Every day";
    case "weekdays":
      return "Every weekday (Mon–Fri)";
    case "weekly":
      return `Every week on ${DAY_LONG[weekday(date)]}`;
    case "monthly":
      return `Every month on day ${date.d}`;
    case "yearly":
      return `Every year on ${formatCivil(date, { day: "numeric", month: "long" })}`;
  }
}

/**
 * A reminder: a direct Discord DM at a time, through the scheduler's reminder path. No prompt, no repo,
 * no agent. The time is entered on the viewer's clock and stored as the scheduler's cron on the server's.
 */
export function ReminderForm({ draft, timeZone, serverTimeZone, onSaved, onCancel, onAdvanced }: Props) {
  const createSchedule = useStore((s) => s.createSchedule);
  const updateSchedule = useStore((s) => s.updateSchedule);
  const existing = draft.schedule;
  const [title, setTitle] = useState(existing?.title ?? "");
  const [message, setMessage] = useState(existing?.reminder ?? "");
  const [date, setDate] = useState(draft.date);
  const [time, setTime] = useState(draft.time);
  const [repeat, setRepeat] = useState<ReminderRepeat>(draft.repeat);
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const [error, setError] = useState<string | null>(null);

  const civil = parseDate(date);
  const at = instantOf(date, time, timeZone);
  const problem = !title.trim()
    ? "A title is required."
    : !message.trim()
      ? "Write the message the reminder sends."
      : at == null
        ? "Pick a date and time."
        : repeat === "none" && at <= Date.now()
          ? "A one-off reminder needs a time in the future."
          : null;
  const serverClock = at != null && serverTimeZone !== timeZone ? epochToWall(at, serverTimeZone) : null;

  const save = () => {
    if (problem || at == null) return;
    const payload = { title: title.trim(), reminder: message.trim(), cron: reminderCron(repeat, at, serverTimeZone), runOnce: repeat === "none", enabled };
    const sent = existing ? updateSchedule(existing.id, payload) : createSchedule({ ...payload, workspace: "", prompt: "" });
    if (sent) onSaved();
    else setError("The console is reconnecting. Try again when it is connected.");
  };

  return (
    <form
      className="cal-form"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <label className="sched-field">
        <span className="sched-label">Title</span>
        <input value={title} maxLength={200} placeholder="e.g. Renew passport" onChange={(e) => setTitle(e.target.value)} autoFocus required />
      </label>
      <label className="sched-field">
        <span className="sched-label">Message</span>
        <textarea className="sched-reminder-input" value={message} maxLength={REMINDER_MAX_CHARS} placeholder="What the reminder says, e.g. “Your passport expires 1 March.”" onChange={(e) => setMessage(e.target.value)} required />
      </label>
      <div className="cal-when">
        <label className="sched-field">
          <span className="sched-label">On</span>
          <input type="date" aria-label="Reminder date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} required />
        </label>
        <label className="sched-field">
          <span className="sched-label">At</span>
          <input type="time" aria-label="Reminder time" value={time} onChange={(e) => e.target.value && setTime(e.target.value)} required />
        </label>
        <label className="sched-field">
          <span className="sched-label">Repeat</span>
          <select aria-label="Repeat" value={repeat} onChange={(e) => setRepeat(e.target.value as ReminderRepeat)}>
            {(["none", "daily", "weekdays", "weekly", "monthly", "yearly"] as ReminderRepeat[]).map((r) => (
              <option key={r} value={r}>
                {civil ? repeatLabel(r, civil) : r}
              </option>
            ))}
          </select>
        </label>
      </div>
      {existing ? (
        <label className="cal-check">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Enabled
        </label>
      ) : null}
      <div className="cal-hint">
        Sent straight to your Discord DMs{repeat === "none" ? " once" : ""}; if Discord refuses it, it lands on your note list. No agent is started.
        {serverClock ? ` The server keeps time in ${serverTimeZone}, where this is ${formatDate(serverClock)} ${formatClock(serverClock.hh * 60 + serverClock.mi)}.` : ""}
      </div>
      {error || (problem && title) ? (
        <div className="cal-error" role="alert">
          {error ?? problem}
        </div>
      ) : null}
      <div className="m-foot cal-foot">
        <button
          type="button"
          className="btn ghost cal-advanced"
          onClick={() => onAdvanced({ title: title.trim(), reminder: message.trim(), cron: reminderCron(repeat, at ?? Date.now() + 3_600_000, serverTimeZone), runOnce: repeat === "none" })}
          title="Open the full scheduled-task editor: any cron pattern, plus everything a scheduled task has">
          Advanced…
        </button>
        <span className="cal-foot-gap" />
        <button type="button" className="btn ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn primary" disabled={!!problem}>
          {existing ? "Save reminder" : "Create reminder"}
        </button>
      </div>
    </form>
  );
}
