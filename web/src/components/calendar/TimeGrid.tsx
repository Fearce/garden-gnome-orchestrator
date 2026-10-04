import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from "react";
import type { CalendarOccurrence } from "../../lib/calendarApi.js";
import { type CivilDate, addDays, dateOf, epochToWall, formatCivil, formatClock, formatDate, rangeDates, wallToEpoch, zoneAbbreviation } from "../../lib/calendarTime.js";
import { itemsOn, layoutDay, sameDate } from "../../lib/calendarLayout.js";
import { CalendarItem, isCalendarDrag, type ViewActions } from "./CalendarItem.js";

const HOUR_PX = 46;
const MIN_PER_PX = 60 / HOUR_PX;
const SLOT_MINUTES = 30;
const DROP_SNAP = 15;
const HOURS = Array.from({ length: 24 }, (_, h) => h);
/** Below this a block has no room for a second line. */
const TWO_LINE_PX = 34;

interface Props {
  from: CivilDate;
  to: CivilDate;
  anchor: CivilDate;
  occurrences: CalendarOccurrence[];
  actions: ViewActions;
  onCursor(date: CivilDate): void;
}

const minuteAt = (e: { clientY: number; currentTarget: Element }): number => {
  const rect = e.currentTarget.getBoundingClientRect();
  return Math.max(0, Math.min(24 * 60 - 1, (e.clientY - rect.top) * MIN_PER_PX));
};

/** The week and day views: an all-day row over a 24-hour grid, one column per date. */
export function TimeGrid({ from, to, anchor, occurrences, actions, onCursor }: Props) {
  const dates = rangeDates(from, to);
  const today = dateOf(actions.now, actions.timeZone);
  const nowWall = epochToWall(actions.now, actions.timeZone);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [dropAt, setDropAt] = useState<{ date: string; minutes: number | null } | null>(null);
  const focusOnRender = useRef(false);

  // Open at the working day, or an hour before now when today is on screen.
  useEffect(() => {
    const showsToday = dates.some((d) => sameDate(d, today));
    const hour = showsToday ? Math.max(0, nowWall.hh - 1) : 7;
    // A little above the hour, so its label is not cut in half by the all-day row.
    scrollRef.current?.scrollTo({ top: Math.max(0, hour * HOUR_PX - 10) });
    // Only when the visible dates change, not on every clock tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formatDate(from), formatDate(to)]);

  useEffect(() => {
    if (!focusOnRender.current) return;
    focusOnRender.current = false;
    scrollRef.current?.parentElement?.querySelector<HTMLElement>(`[data-cal-cell][data-date="${formatDate(anchor)}"]`)?.focus();
  }, [anchor]);

  const onColumnKey = (date: CivilDate) => (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      e.stopPropagation();
      focusOnRender.current = true;
      onCursor(addDays(date, e.key === "ArrowLeft" ? -1 : 1));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const next = sameDate(date, today) ? Math.min(23, nowWall.hh + 1) * 60 : 9 * 60;
      actions.create(date, next);
    }
  };

  const dragOverSlot = (date: CivilDate) => (e: DragEvent<HTMLDivElement>) => {
    if (!isCalendarDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const raw = minuteAt(e) - actions.grabMinutes();
    const minutes = Math.max(0, Math.min(24 * 60 - DROP_SNAP, Math.round(raw / DROP_SNAP) * DROP_SNAP));
    const key = formatDate(date);
    if (dropAt?.date !== key || dropAt.minutes !== minutes) setDropAt({ date: key, minutes });
  };

  const dropOnSlot = (date: CivilDate) => (e: DragEvent<HTMLDivElement>) => {
    if (!isCalendarDrag(e) || dropAt?.minutes == null) return;
    e.preventDefault();
    const minutes = dropAt.minutes;
    setDropAt(null);
    actions.drop({ at: wallToEpoch({ ...date, hh: Math.floor(minutes / 60), mi: minutes % 60 }, actions.timeZone) });
  };

  const clickSlot = (date: CivilDate) => (e: MouseEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    actions.create(date, Math.floor(minuteAt(e) / SLOT_MINUTES) * SLOT_MINUTES);
  };

  const leave = (key: string) => (e: DragEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropAt((d) => (d?.date === key ? null : d));
  };

  const columns = `var(--cal-gutter) repeat(${dates.length}, minmax(0, 1fr))`;
  return (
    <div className={`cal-timegrid${dates.length === 1 ? " single" : ""}`}>
      <div className="cal-tg-head" style={{ gridTemplateColumns: columns }}>
        <div className="cal-tg-zone" title={`Times in ${actions.timeZone}`}>
          {zoneAbbreviation(actions.now, actions.timeZone)}
        </div>
        {dates.map((date) => (
          <button
            key={formatDate(date)}
            type="button"
            className={"cal-tg-date" + (sameDate(date, today) ? " today" : "")}
            onClick={() => actions.goToDay(date)}
            disabled={dates.length === 1}
            aria-label={`Open ${formatCivil(date, { weekday: "long", day: "numeric", month: "long" })} in day view`}
          >
            <span className="cal-tg-wd">{formatCivil(date, { weekday: "short" })}</span>
            <span className="cal-tg-dn">{date.d}</span>
          </button>
        ))}
      </div>

      <div className="cal-tg-allday" style={{ gridTemplateColumns: columns }}>
        <div className="cal-tg-label">All day</div>
        {dates.map((date) => {
          const key = formatDate(date);
          const { allDay } = itemsOn(occurrences, date, actions.timeZone);
          return (
            <div
              key={key}
              className={"cal-tg-allday-cell" + (dropAt?.date === key && dropAt.minutes == null ? " drop" : "")}
              onClick={(e) => e.target === e.currentTarget && actions.create(date, null)}
              onDragOver={(e) => {
                if (!isCalendarDrag(e)) return;
                e.preventDefault();
                if (dropAt?.date !== key || dropAt.minutes != null) setDropAt({ date: key, minutes: null });
              }}
              onDragLeave={leave(key)}
              onDrop={(e) => {
                if (!isCalendarDrag(e)) return;
                e.preventDefault();
                setDropAt(null);
                actions.drop({ date });
              }}
            >
              {allDay.map((o) => (
                <CalendarItem key={o.key} occurrence={o} actions={actions} variant="chip" continuesBefore={o.startDate !== key && !o.count} continuesAfter={o.endDate !== key && !o.count} />
              ))}
            </div>
          );
        })}
      </div>

      <div className="cal-tg-scroll" ref={scrollRef}>
        <div className="cal-tg-body" style={{ gridTemplateColumns: columns, height: 24 * HOUR_PX }}>
          <div className="cal-tg-hours" aria-hidden="true">
            {HOURS.map((h) => (
              <div key={h} className="cal-tg-hour" style={{ top: h * HOUR_PX }}>
                {h === 0 ? "" : formatClock(h * 60)}
              </div>
            ))}
          </div>
          {dates.map((date) => {
            const key = formatDate(date);
            const placed = layoutDay(itemsOn(occurrences, date, actions.timeZone).timed, date, actions.timeZone);
            const isToday = sameDate(date, today);
            const focused = sameDate(date, anchor);
            const ghost = dropAt?.date === key && dropAt.minutes != null ? dropAt.minutes : null;
            return (
              <div
                key={key}
                data-cal-cell
                data-date={key}
                role="gridcell"
                tabIndex={focused ? 0 : -1}
                aria-label={`${formatCivil(date, { weekday: "long", day: "numeric", month: "long" })}, ${placed.length} timed ${placed.length === 1 ? "item" : "items"}. Press Enter to add.`}
                className={"cal-tg-col" + (isToday ? " today" : "")}
                onClick={clickSlot(date)}
                onKeyDown={onColumnKey(date)}
                onDragOver={dragOverSlot(date)}
                onDragLeave={leave(key)}
                onDrop={dropOnSlot(date)}
              >
                {placed.map((p) => {
                  const height = Math.max(18, p.height / MIN_PER_PX - 2);
                  return (
                    <CalendarItem
                      key={p.occurrence.key}
                      occurrence={p.occurrence}
                      actions={actions}
                      variant="block"
                      tabIndex={focused ? 0 : -1}
                      minutesPerPx={MIN_PER_PX}
                      continuesBefore={p.continuesBefore}
                      continuesAfter={p.continuesAfter}
                      short={height < TWO_LINE_PX}
                      style={{
                        top: p.top / MIN_PER_PX,
                        height,
                        left: `calc(${(p.column / p.columns) * 100}% + 2px)`,
                        width: `calc(${100 / p.columns}% - 4px)`,
                      }}
                    />
                  );
                })}
                {ghost != null ? (
                  <div className="cal-drop-ghost" style={{ top: ghost / MIN_PER_PX }}>
                    {formatClock(ghost)}
                  </div>
                ) : null}
                {isToday ? <div className="cal-now" style={{ top: (nowWall.hh * 60 + nowWall.mi) / MIN_PER_PX }} aria-hidden="true" /> : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
