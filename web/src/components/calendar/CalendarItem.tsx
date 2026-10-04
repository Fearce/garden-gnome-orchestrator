import type { CSSProperties, DragEvent, KeyboardEvent } from "react";
import type { CalendarOccurrence } from "../../lib/calendarApi.js";
import type { CivilDate } from "../../lib/calendarTime.js";
import { formatTime } from "../../lib/calendarTime.js";
import { KIND_LABEL, STATUS_LABEL } from "../../lib/calendarLayout.js";

export type DropTarget = { date: CivilDate } | { at: number };

/** What every view can ask the calendar to do. */
export interface ViewActions {
  timeZone: string;
  now: number;
  open(o: CalendarOccurrence): void;
  /** A click on empty space: a date (all-day) or, on a time grid, a minute of that day. */
  create(date: CivilDate, minutes: number | null): void;
  goToDay(date: CivilDate): void;
  canDrag(o: CalendarOccurrence): boolean;
  beginDrag(o: CalendarOccurrence, grabMinutes: number): void;
  endDrag(): void;
  dragging: CalendarOccurrence | null;
  /** The minutes between the dragged item's start and where it was grabbed (time grids). */
  grabMinutes(): number;
  drop(target: DropTarget): void;
}

export const DRAG_MIME = "application/x-ggo-calendar";

/** Every item's one-line label for screen readers and the hover title. */
export function itemLabel(o: CalendarOccurrence, timeZone: string): string {
  const when = o.allDay ? (o.count ? `${o.count} runs` : "All day") : formatTime(o.startAt, timeZone);
  const flags = [o.recurring ? "repeats" : "", o.hasReminder ? "with reminder" : "", o.status === "upcoming" || o.status === "past" ? "" : STATUS_LABEL[o.status]].filter(Boolean);
  return `${KIND_LABEL[o.kind]}: ${o.title}, ${when}${flags.length ? ` (${flags.join(", ")})` : ""}`;
}

interface Props {
  occurrence: CalendarOccurrence;
  actions: ViewActions;
  variant: "chip" | "block" | "row";
  /** Minutes per pixel on a time grid, for working out where a block was grabbed. */
  minutesPerPx?: number;
  continuesBefore?: boolean;
  continuesAfter?: boolean;
  style?: CSSProperties;
  tabIndex?: number;
  /** A time-grid block too short for two lines: time and title share one. */
  short?: boolean;
}

/** One occurrence, as a month-cell chip, a time-grid block or an agenda row. A button: Enter or a
 *  click opens its details; it can be dragged to reschedule when its kind allows that. */
export function CalendarItem({ occurrence: o, actions, variant, minutesPerPx = 1, continuesBefore, continuesAfter, style, tabIndex, short }: Props) {
  const draggable = actions.canDrag(o);
  const time = o.allDay ? (o.count ? `${o.count}×` : null) : formatTime(o.startAt, actions.timeZone);
  const onDragStart = (e: DragEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const grab = variant === "block" ? Math.max(0, Math.round((e.clientY - rect.top) * minutesPerPx)) : 0;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData(DRAG_MIME, o.key);
    e.dataTransfer.setData("text/plain", o.title);
    actions.beginDrag(o, grab);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    // Arrow keys belong to the grid's day navigation, never to the item inside it.
    if (e.key.startsWith("Arrow")) e.currentTarget.closest<HTMLElement>("[data-cal-cell]")?.focus();
  };
  const classes = [
    "cal-item",
    `cal-${variant}`,
    `k-${o.kind}`,
    `s-${o.status}`,
    o.edited ? "edited" : "",
    short ? "short" : "",
    continuesBefore ? "cont-before" : "",
    continuesAfter ? "cont-after" : "",
    actions.dragging?.key === o.key ? "dragging" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      type="button"
      className={classes}
      style={style}
      tabIndex={tabIndex}
      title={itemLabel(o, actions.timeZone)}
      aria-label={itemLabel(o, actions.timeZone)}
      draggable={draggable}
      onDragStart={draggable ? onDragStart : undefined}
      onDragEnd={draggable ? actions.endDrag : undefined}
      onClick={(e) => {
        e.stopPropagation();
        actions.open(o);
      }}
      onKeyDown={onKeyDown}
    >
      <span className="cal-kind-mark" aria-hidden="true">
        <KindIcon kind={o.kind} />
      </span>
      {time && variant !== "row" ? <span className="cal-item-time">{time}</span> : null}
      <span className="cal-item-title">{o.title}</span>
      <span className="cal-item-flags" aria-hidden="true">
        {o.recurring ? <RepeatIcon /> : null}
        {o.hasReminder && o.kind === "event" ? <BellIcon /> : null}
        {o.status === "paused" ? <PauseIcon /> : null}
      </span>
    </button>
  );
}

export function KindIcon({ kind }: { kind: CalendarOccurrence["kind"] }) {
  if (kind === "reminder") return <BellIcon />;
  if (kind === "task") return <TaskIcon />;
  return <DotIcon />;
}

const svg = (size: number) => ({ width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true });

export function DotIcon() {
  return (
    <svg {...svg(10)}>
      <circle cx="12" cy="12" r="6" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function BellIcon({ size = 11 }: { size?: number }) {
  return (
    <svg {...svg(size)}>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}

export function TaskIcon({ size = 11 }: { size?: number }) {
  return (
    <svg {...svg(size)}>
      <path d="m7 7 10 5-10 5V7Z" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function RepeatIcon({ size = 11 }: { size?: number }) {
  return (
    <svg {...svg(size)}>
      <path d="m17 2 4 4-4 4" />
      <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
      <path d="m7 22-4-4 4-4" />
      <path d="M21 13v1a4 4 0 0 1-4 4H3" />
    </svg>
  );
}

export function PauseIcon({ size = 11 }: { size?: number }) {
  return (
    <svg {...svg(size)}>
      <path d="M9 5v14M15 5v14" />
    </svg>
  );
}

export function ChevronIcon({ dir }: { dir: "left" | "right" }) {
  return (
    <svg {...svg(16)}>
      <path d={dir === "left" ? "m15 18-6-6 6-6" : "m9 18 6-6-6-6"} />
    </svg>
  );
}

export function PlusIcon() {
  return (
    <svg {...svg(13)} strokeWidth={2.5}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function SearchIcon() {
  return (
    <svg {...svg(13)}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

export function CloseIcon() {
  return (
    <svg {...svg(15)}>
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

/** Whether a drag over a target carries a calendar item (and not, say, a file from the desktop). */
export const isCalendarDrag = (e: DragEvent): boolean => e.dataTransfer.types.includes(DRAG_MIME);
