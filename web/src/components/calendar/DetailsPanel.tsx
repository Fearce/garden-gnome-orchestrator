import { useState, type ReactNode } from "react";
import { useStore } from "../../store.js";
import type { ScheduledTask } from "../../types.js";
import { describeCron } from "../../lib/cron.js";
import {
  type CalendarEvent,
  type CalendarOccurrence,
  type CalendarScope,
  deleteEvent,
  moveScheduleRun,
  remindNow,
  restoreScheduleRun,
  skipScheduleRun,
} from "../../lib/calendarApi.js";
import { describeRecurrence, describeReminder, KIND_LABEL, STATUS_LABEL } from "../../lib/calendarLayout.js";
import { occurrenceSpan } from "../../lib/calendarEdit.js";
import { dateOf, epochToWall, formatCivil, formatClock, formatDate, formatTime, parseDate, parseDateTime, wallToEpoch, zoneAbbreviation } from "../../lib/calendarTime.js";
import { BellIcon, KindIcon, RepeatIcon } from "./CalendarItem.js";

interface Props {
  occurrence: CalendarOccurrence;
  event: CalendarEvent | null;
  schedule: ScheduledTask | null;
  timeZone: string;
  serverTimeZone: string;
  onEditEvent(event: CalendarEvent, occurrenceDate: string | undefined): void;
  onEditSchedule(schedule: ScheduledTask, occurrence: CalendarOccurrence): void;
  onClose(): void;
}

/** Everything about one calendar item, with the actions it allows. */
export function DetailsPanel(props: Props) {
  const { occurrence: o } = props;
  return (
    <div className="cal-details">
      <div className={`cal-details-kind k-${o.kind}`}>
        <KindIcon kind={o.kind} /> {KIND_LABEL[o.kind]}
        {o.recurring ? (
          <span className="cal-details-flag">
            <RepeatIcon /> repeats
          </span>
        ) : null}
      </div>
      <h3 className="cal-details-title">{o.title}</h3>
      {o.source === "event" ? (
        props.event ? <EventDetails {...props} event={props.event} /> : <p className="cal-hint">This event no longer exists.</p>
      ) : props.schedule ? (
        <ScheduleDetails {...props} schedule={props.schedule} />
      ) : (
        <p className="cal-hint">This scheduled entry no longer exists.</p>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="cal-details-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function whenText(o: CalendarOccurrence, timeZone: string): string {
  if (o.allDay && o.startDate && o.endDate) {
    const s = parseDate(o.startDate)!;
    const e = parseDate(o.endDate)!;
    const fmt = { weekday: "long", day: "numeric", month: "long", year: "numeric" } as const;
    return o.startDate === o.endDate ? formatCivil(s, fmt) : `${formatCivil(s, fmt)} – ${formatCivil(e, fmt)}`;
  }
  const day = (ms: number) => formatCivil(dateOf(ms, timeZone), { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  if (o.endAt <= o.startAt) return `${day(o.startAt)} at ${formatTime(o.startAt, timeZone)}`;
  const sameDay = formatDate(dateOf(o.startAt, timeZone)) === formatDate(dateOf(o.endAt - 1, timeZone));
  return sameDay ? `${day(o.startAt)}, ${formatTime(o.startAt, timeZone)} – ${formatTime(o.endAt, timeZone)}` : `${day(o.startAt)} ${formatTime(o.startAt, timeZone)} – ${day(o.endAt)} ${formatTime(o.endAt, timeZone)}`;
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function EventDetails({ occurrence: o, event, timeZone, onEditEvent, onClose }: Props & { event: CalendarEvent }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const span = occurrenceSpan(event, o.occurrenceDate);
  const ownZone = !span.allDay && event.timeZone !== timeZone;
  const seriesStart = parseDate(event.start.slice(0, 10))!;
  const exception = event.exceptions.find((x) => x.date === o.occurrenceDate);
  const notes = exception?.notes ?? event.notes;

  const remove = async (scope: CalendarScope) => {
    setBusy(true);
    try {
      await deleteEvent(event.id, scope, event.recurrence ? (o.occurrenceDate ?? null) : null);
      onClose();
    } catch (e) {
      setMessage(errorText(e));
      setBusy(false);
    }
  };
  const test = async () => {
    setBusy(true);
    try {
      await remindNow(event.id, o.occurrenceDate ?? null);
      setMessage("Test reminder sent. If Discord refuses it, it is on your note list.");
    } catch (e) {
      setMessage(errorText(e));
    }
    setBusy(false);
  };

  return (
    <>
      <dl className="cal-details-list">
        <Row label="When">
          {whenText(o, timeZone)}
          {ownZone ? (
            <span className="cal-hint">
              {" "}
              ({span.start.slice(11)}{span.end !== span.start ? ` – ${span.end.slice(11)}` : ""} in {event.timeZone})
            </span>
          ) : null}
        </Row>
        {!span.allDay && span.start === span.end ? <Row label="Ends">Not specified</Row> : null}
        {event.recurrence ? (
          <Row label="Repeats">
            {describeRecurrence(event.recurrence, seriesStart)}
            {o.edited ? <span className="cal-badge">this one changed</span> : null}
          </Row>
        ) : null}
        <Row label={event.reminders.length > 1 ? "Reminders" : "Reminder"}>
          {event.reminders.length ? (
            <>
              <BellIcon /> {event.reminders.map(describeReminder).join(", ")}, to your Discord DMs
            </>
          ) : (
            "None. This event sends nothing and starts nothing."
          )}
        </Row>
        {notes ? (
          <Row label="Notes">
            <span className="cal-notes">{notes}</span>
          </Row>
        ) : null}
      </dl>
      {message ? (
        <div className="cal-hint" role="status">
          {message}
        </div>
      ) : null}
      {confirming ? (
        <div className="cal-confirm" role="group" aria-label="Delete">
          <span>{event.recurrence ? "Delete which events?" : "Delete this event?"}</span>
          {event.recurrence ? (
            <>
              <button type="button" className="btn danger sm" disabled={busy} onClick={() => void remove("occurrence")}>
                Only this event
              </button>
              <button type="button" className="btn danger sm" disabled={busy} onClick={() => void remove("following")}>
                This and following
              </button>
              <button type="button" className="btn danger sm" disabled={busy} onClick={() => void remove("series")}>
                All events
              </button>
            </>
          ) : (
            <button type="button" className="btn danger sm" disabled={busy} onClick={() => void remove("series")}>
              Delete
            </button>
          )}
          <button type="button" className="btn ghost sm" onClick={() => setConfirming(false)}>
            Keep
          </button>
        </div>
      ) : (
        <div className="cal-details-actions">
          <button type="button" className="btn primary sm" onClick={() => onEditEvent(event, o.occurrenceDate)} autoFocus>
            Edit
          </button>
          {event.reminders.length ? (
            <button type="button" className="btn ghost sm" disabled={busy} onClick={() => void test()} title="Send this occurrence's reminder to your Discord DMs now, to see what it says">
              Send test reminder
            </button>
          ) : null}
          <button type="button" className="btn danger sm" onClick={() => setConfirming(true)}>
            Delete…
          </button>
        </div>
      )}
    </>
  );
}

function ScheduleDetails({ occurrence: o, schedule: s, timeZone, serverTimeZone, onEditSchedule, onClose }: Props & { schedule: ScheduledTask }) {
  const updateSchedule = useStore((st) => st.updateSchedule);
  const deleteSchedule = useStore((st) => st.deleteSchedule);
  const select = useStore((st) => st.select);
  const setBoardView = useStore((st) => st.setBoardView);
  const lastThread = useStore((st) => (s.lastThreadId ? st.threads[s.lastThreadId] : undefined));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const slot = o.slotAt ?? null;
  const canSkip = slot != null && o.recurring && o.status === "upcoming";
  const canMove = slot != null && (o.status === "upcoming" || o.status === "paused");

  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      if (done) setMessage(done);
      else onClose();
    } catch (e) {
      setMessage(errorText(e));
    }
    setBusy(false);
  };

  return (
    <>
      <dl className="cal-details-list">
        <Row label="Status">
          <span className={`cal-status s-${o.status}`}>{s.enabled || o.status === "ran" || o.status === "past" ? STATUS_LABEL[o.status] : "Paused. The schedule is switched off, so this will not run."}</span>
        </Row>
        <Row label={o.status === "ran" ? "Ran" : "When"}>{o.count ? `${o.count} runs on ${formatCivil(parseDate(o.startDate!)!, { weekday: "long", day: "numeric", month: "long" })}` : whenText(o, timeZone)}</Row>
        <Row label="Schedule">
          {describeCron(s.cron)}
          {s.runOnce ? <span className="cal-badge">once</span> : null}
          {serverTimeZone !== timeZone ? <span className="cal-hint"> on the server clock ({serverTimeZone})</span> : null}
        </Row>
        {s.reminder ? (
          <Row label="Reminder">
            <span className="cal-notes">{s.reminder}</span>
          </Row>
        ) : null}
        {s.prompt ? (
          <Row label="Runs">
            <span className="cal-hint">Each run starts an agent in </span>
            <code className="cal-code">{s.workspace}</code>
            <span className="cal-prompt">{s.prompt}</span>
          </Row>
        ) : (
          <Row label="Runs">A direct Discord DM. No agent is started.</Row>
        )}
      </dl>

      {moving && slot != null ? (
        <MoveRun schedule={s} slot={slot} timeZone={timeZone} busy={busy} onCancel={() => setMoving(false)} onMove={(toAt, scope) => void act(() => moveScheduleRun(s.id, slot, toAt, scope))} />
      ) : null}
      {message ? (
        <div className="cal-hint" role="status">
          {message}
        </div>
      ) : null}

      {confirming ? (
        <div className="cal-confirm">
          <span>Delete “{s.title}” and all its future runs? Tasks it already started are kept.</span>
          <button
            type="button"
            className="btn danger sm"
            onClick={() => {
              if (deleteSchedule(s.id)) onClose();
            }}
          >
            Delete schedule
          </button>
          <button type="button" className="btn ghost sm" onClick={() => setConfirming(false)}>
            Keep
          </button>
        </div>
      ) : (
        <div className="cal-details-actions">
          <button type="button" className="btn primary sm" onClick={() => onEditSchedule(s, o)} autoFocus>
            Edit {o.kind === "task" ? "schedule" : "reminder"}
          </button>
          {canSkip ? (
            <button type="button" className="btn ghost sm" disabled={busy} onClick={() => void act(() => skipScheduleRun(s.id, slot!), "This run will be skipped.")} title="This one run neither reminds nor starts anything; the rest of the schedule is unchanged">
              Skip this run
            </button>
          ) : null}
          {o.status === "skipped" && slot != null ? (
            <button type="button" className="btn ghost sm" disabled={busy} onClick={() => void act(() => restoreScheduleRun(s.id, slot), "This run is back on.")}>
              Restore this run
            </button>
          ) : null}
          {canMove && !moving ? (
            <button type="button" className="btn ghost sm" onClick={() => setMoving(true)}>
              Move…
            </button>
          ) : null}
          <button type="button" className="btn ghost sm" onClick={() => updateSchedule(s.id, { enabled: !s.enabled })}>
            {s.enabled ? "Pause schedule" : "Resume schedule"}
          </button>
          {lastThread ? (
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => {
                setBoardView("tasks");
                select(lastThread.id);
              }}
            >
              Open last run
            </button>
          ) : null}
          <button type="button" className="btn danger sm" onClick={() => setConfirming(true)}>
            Delete…
          </button>
        </div>
      )}
    </>
  );
}

/** Pick a new time for one run (or, on a repeating schedule, for every run). */
function MoveRun({ schedule, slot, timeZone, busy, onCancel, onMove }: { schedule: ScheduledTask; slot: number; timeZone: string; busy: boolean; onCancel(): void; onMove(toAt: number, scope: "occurrence" | "series"): void }) {
  const w = epochToWall(slot, timeZone);
  const [date, setDate] = useState(formatDate(w));
  const [time, setTime] = useState(formatClock(w.hh * 60 + w.mi));
  const [scope, setScope] = useState<"occurrence" | "series">("occurrence");
  const wall = parseDateTime(`${date}T${time}`);
  const toAt = wall ? wallToEpoch(wall, timeZone) : null;
  const recurring = !schedule.runOnce;
  return (
    <div className="cal-move" role="group" aria-label="Move run">
      <span className="cal-inline">
        <input type="date" aria-label="New date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
        <input type="time" aria-label="New time" value={time} onChange={(e) => e.target.value && setTime(e.target.value)} />
        <span className="cal-hint">{toAt ? zoneAbbreviation(toAt, timeZone) : ""}</span>
      </span>
      {recurring ? (
        <span className="cal-inline">
          <label className="cal-radio">
            <input type="radio" checked={scope === "occurrence"} onChange={() => setScope("occurrence")} /> Only this run
          </label>
          <label className="cal-radio">
            <input type="radio" checked={scope === "series"} onChange={() => setScope("series")} /> Every run
          </label>
        </span>
      ) : null}
      <span className="cal-inline">
        <button type="button" className="btn primary sm" disabled={busy || toAt == null || toAt === slot} onClick={() => toAt != null && onMove(toAt, scope)}>
          Move
        </button>
        <button type="button" className="btn ghost sm" onClick={onCancel}>
          Cancel
        </button>
      </span>
    </div>
  );
}
