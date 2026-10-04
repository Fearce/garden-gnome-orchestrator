import type { CalendarOccurrence } from "../../lib/calendarApi.js";
import { type CivilDate, dateOf, formatCivil, formatDate, formatTime, rangeDates } from "../../lib/calendarTime.js";
import { KIND_LABEL, STATUS_LABEL, itemsOn, sameDate } from "../../lib/calendarLayout.js";
import { CalendarItem, PlusIcon, type ViewActions } from "./CalendarItem.js";

interface Props {
  from: CivilDate;
  to: CivilDate;
  occurrences: CalendarOccurrence[];
  actions: ViewActions;
  filtered: boolean;
}

/** A day-by-day list of everything in the range; days with nothing on them are left out. */
export function AgendaView({ from, to, occurrences, actions, filtered }: Props) {
  const today = dateOf(actions.now, actions.timeZone);
  const days = rangeDates(from, to)
    .map((date) => {
      const { allDay, timed } = itemsOn(occurrences, date, actions.timeZone);
      return { date, items: [...allDay, ...timed] };
    })
    .filter((d) => d.items.length > 0);

  if (!days.length) {
    return (
      <div className="cal-agenda-empty">
        <div className="big">{filtered ? "Nothing matches these filters" : "A clear stretch"}</div>
        <div className="faint">
          {filtered ? "Nothing in these dates matches the current search and filters." : `Nothing is planned between ${formatCivil(from, { day: "numeric", month: "long" })} and ${formatCivil(to, { day: "numeric", month: "long" })}.`}
        </div>
        <button type="button" className="btn primary sm" onClick={() => actions.create(from, null)}>
          <PlusIcon /> Add something on {formatCivil(from, { day: "numeric", month: "short" })}
        </button>
      </div>
    );
  }

  return (
    <ol className="cal-agenda" aria-label="Agenda">
      {days.map(({ date, items }) => (
        <li key={formatDate(date)} className={"cal-agenda-day" + (sameDate(date, today) ? " today" : "")}>
          <button type="button" className="cal-agenda-date" onClick={() => actions.goToDay(date)} aria-label={`Open ${formatCivil(date, { weekday: "long", day: "numeric", month: "long" })} in day view`}>
            <span className="cal-agenda-dn">{date.d}</span>
            <span className="cal-agenda-wd">{formatCivil(date, { weekday: "short", month: "short" })}</span>
          </button>
          <ul className="cal-agenda-items">
            {items.map((o) => (
              <li key={o.key} className="cal-agenda-row">
                <span className="cal-agenda-time">{agendaTime(o, date, actions.timeZone)}</span>
                <CalendarItem occurrence={o} actions={actions} variant="row" />
                <span className={`cal-agenda-kind k-${o.kind}`}>{KIND_LABEL[o.kind]}</span>
                {o.status === "paused" || o.status === "skipped" || o.status === "ran" ? <span className={`cal-status s-${o.status}`}>{STATUS_LABEL[o.status].split(" — ")[0]}</span> : null}
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ol>
  );
}

function agendaTime(o: CalendarOccurrence, date: CivilDate, timeZone: string): string {
  if (o.count) return `${o.count} runs`;
  if (o.allDay) return "All day";
  const startsToday = sameDate(dateOf(o.startAt, timeZone), date);
  const endsToday = sameDate(dateOf(o.endAt, timeZone), date);
  if (o.endAt <= o.startAt) return formatTime(o.startAt, timeZone);
  if (startsToday && endsToday) return `${formatTime(o.startAt, timeZone)} – ${formatTime(o.endAt, timeZone)}`;
  if (startsToday) return `from ${formatTime(o.startAt, timeZone)}`;
  if (endsToday) return `until ${formatTime(o.endAt, timeZone)}`;
  return "All day";
}
