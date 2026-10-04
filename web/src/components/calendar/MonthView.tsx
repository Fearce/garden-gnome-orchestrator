import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { CalendarOccurrence } from "../../lib/calendarApi.js";
import { type CivilDate, addDays, dateOf, formatCivil, formatDate } from "../../lib/calendarTime.js";
import { itemsOn, sameDate, weeksOf } from "../../lib/calendarLayout.js";
import { CalendarItem, isCalendarDrag, type ViewActions } from "./CalendarItem.js";

/** How many items a month cell lists before folding the rest into "+N more". */
const CELL_ITEMS = 3;

interface Props {
  from: CivilDate;
  to: CivilDate;
  anchor: CivilDate;
  occurrences: CalendarOccurrence[];
  actions: ViewActions;
  /** Keyboard focus moved to another date. */
  onCursor(date: CivilDate): void;
}

const KEY_STEP: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };

export function MonthView({ from, to, anchor, occurrences, actions, onCursor }: Props) {
  const weeks = weeksOf(from, to);
  const today = dateOf(actions.now, actions.timeZone);
  const gridRef = useRef<HTMLDivElement>(null);
  const [dropDate, setDropDate] = useState<string | null>(null);
  const focusOnRender = useRef(false);

  useEffect(() => {
    if (!focusOnRender.current) return;
    focusOnRender.current = false;
    gridRef.current?.querySelector<HTMLElement>(`[data-date="${formatDate(anchor)}"]`)?.focus();
  }, [anchor]);

  const onCellKey = (date: CivilDate) => (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const step = KEY_STEP[e.key];
    if (step) {
      e.preventDefault();
      e.stopPropagation();
      focusOnRender.current = true;
      onCursor(addDays(date, step));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      actions.create(date, null);
    }
  };

  return (
    <div className="cal-month" role="grid" aria-label={formatCivil(anchor, { month: "long", year: "numeric" })} ref={gridRef}>
      <div className="cal-month-head" role="row">
        {weeks[0]!.map((d) => (
          <div key={formatDate(d)} role="columnheader" className="cal-weekday" aria-label={formatCivil(d, { weekday: "long" })}>
            {formatCivil(d, { weekday: "short" })}
          </div>
        ))}
      </div>
      <div className="cal-month-body" style={{ gridTemplateRows: `repeat(${weeks.length}, minmax(0, 1fr))` }}>
        {weeks.map((week) => (
          <div className="cal-month-week" role="row" key={formatDate(week[0]!)}>
            {week.map((date) => {
              const key = formatDate(date);
              const { allDay, timed } = itemsOn(occurrences, date, actions.timeZone);
              const items = [...allDay, ...timed];
              const shown = items.slice(0, items.length > CELL_ITEMS + 1 ? CELL_ITEMS : CELL_ITEMS + 1);
              const hidden = items.length - shown.length;
              const isToday = sameDate(date, today);
              const outside = date.m !== anchor.m;
              const focused = sameDate(date, anchor);
              return (
                <div
                  key={key}
                  role="gridcell"
                  data-cal-cell
                  data-date={key}
                  tabIndex={focused ? 0 : -1}
                  aria-selected={focused}
                  aria-label={`${formatCivil(date, { weekday: "long", day: "numeric", month: "long" })}${isToday ? ", today" : ""}, ${items.length ? `${items.length} ${items.length === 1 ? "item" : "items"}` : "nothing scheduled"}. Press Enter to add.`}
                  className={["cal-day", outside ? "outside" : "", isToday ? "today" : "", dropDate === key ? "drop" : ""].filter(Boolean).join(" ")}
                  onClick={() => actions.create(date, null)}
                  onKeyDown={onCellKey(date)}
                  onDragOver={(e) => {
                    if (!isCalendarDrag(e)) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    if (dropDate !== key) setDropDate(key);
                  }}
                  onDragLeave={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropDate((d) => (d === key ? null : d));
                  }}
                  onDrop={(e) => {
                    if (!isCalendarDrag(e)) return;
                    e.preventDefault();
                    setDropDate(null);
                    actions.drop({ date });
                  }}
                >
                  <button
                    type="button"
                    className="cal-daynum"
                    tabIndex={-1}
                    aria-label={`Open ${formatCivil(date, { weekday: "long", day: "numeric", month: "long" })} in day view`}
                    onClick={(e) => {
                      e.stopPropagation();
                      actions.goToDay(date);
                    }}
                  >
                    {date.d === 1 ? formatCivil(date, { day: "numeric", month: "short" }) : date.d}
                  </button>
                  <div className="cal-day-items">
                    {shown.map((o) => (
                      <CalendarItem key={o.key} occurrence={o} actions={actions} variant="chip" tabIndex={focused ? 0 : -1} continuesBefore={o.allDay && o.startDate !== key && !o.count} continuesAfter={o.allDay && o.endDate !== key && !o.count} />
                    ))}
                    {hidden > 0 ? (
                      <button
                        type="button"
                        className="cal-more"
                        tabIndex={-1}
                        onClick={(e) => {
                          e.stopPropagation();
                          actions.goToDay(date);
                        }}
                      >
                        +{hidden} more
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
