import { useEffect, useState } from "react";
import { useStore } from "../../store.js";
import { type CalendarItemKind, type FiredReminder, type ReminderDelivery, fetchFiredReminders, markRemindersSeen } from "../../lib/calendarApi.js";
import { dateOf, dayNumber, formatCivil, formatTime } from "../../lib/calendarTime.js";
import { CloseIcon, KindIcon } from "./CalendarItem.js";

/** Seen reminders shown under the new ones before "Show older". */
const RECENT_SEEN = 5;

const DELIVERY_LABEL: Record<ReminderDelivery, string> = {
  sending: "Sending to Discord…",
  sent: "Sent to Discord",
  retrying: "Discord failed, retrying · on Notes",
  failed: "Not delivered · on Notes",
  interrupted: "Discord delivery unconfirmed · on Notes",
  withdrawn: "Not sent · moved or deleted",
};

interface Props {
  timeZone: string;
  now: number;
  /** Jump to what the reminder is about on the calendar. */
  onShow(reminder: FiredReminder): void;
  onClose(): void;
}

/**
 * The reminders that went off, newest first: which one raised the Calendar tab's number, what it said,
 * and whether its Discord DM arrived. New ones stay in the count until acknowledged here.
 */
export function FiredReminders({ timeZone, now, onShow, onClose }: Props) {
  const rev = useStore((s) => s.remindersRev);
  const schedules = useStore((s) => s.schedules);
  const [list, setList] = useState<FiredReminder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showOlder, setShowOlder] = useState(false);

  useEffect(() => {
    let live = true;
    fetchFiredReminders()
      .then((r) => {
        if (!live || useStore.getState().remindersRev !== rev) return;
        setList(r.reminders);
        setError(null);
        useStore.setState({ remindersUnseen: r.unseen });
      })
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [rev]);

  const acknowledge = (ids?: string[]) => {
    // A reminder arriving after this click has not been read yet. Acknowledge only this list's IDs.
    const selectedIds = ids ?? list?.filter((r) => !r.seenAt).map((r) => r.id);
    if (!selectedIds?.length) return;
    const before = useStore.getState().remindersRev;
    setError(null);
    markRemindersSeen(selectedIds)
      .then((r) => {
        const at = Date.now();
        setList((l) => l?.map((x) => (!x.seenAt && selectedIds.includes(x.id) ? { ...x, seenAt: at } : x)) ?? l);
        useStore.setState((s) => s.remindersRev === before ? { remindersUnseen: r.unseen } : {});
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  const kindOf = (r: FiredReminder): CalendarItemKind => {
    if (r.source === "event") return "event";
    return schedules.find((s) => s.id === r.refId)?.prompt ? "task" : "reminder";
  };

  const fresh = list?.filter((r) => !r.seenAt) ?? [];
  const seen = list?.filter((r) => r.seenAt) ?? [];
  const older = showOlder ? seen : seen.slice(0, RECENT_SEEN);

  return (
    <section className="cal-fired" aria-label="Reminders that went off">
      <header className="cal-fired-head">
        <h3 className="cal-fired-title">{headline(list, fresh.length)}</h3>
        {fresh.length > 1 ? (
          <button type="button" className="btn ghost sm" onClick={() => acknowledge()}>
            Mark all seen
          </button>
        ) : null}
        <button type="button" className="cal-close" onClick={onClose} aria-label="Hide reminders that went off">
          <CloseIcon />
        </button>
      </header>
      {error ? (
        <div className="cal-error" role="alert">
          {error}
        </div>
      ) : null}
      {list && !list.length ? <p className="cal-hint">When a reminder goes off it is listed here, and the Calendar tab shows a number until you mark it seen.</p> : null}
      {fresh.length || older.length ? (
        <ul className="cal-fired-list">
          {[...fresh, ...older].map((r) => (
            <FiredRow key={r.id} reminder={r} kind={kindOf(r)} timeZone={timeZone} now={now} onShow={() => { if (!r.seenAt) acknowledge([r.id]); onShow(r); }} onSeen={() => acknowledge([r.id])} />
          ))}
        </ul>
      ) : null}
      {seen.length > RECENT_SEEN ? (
        <button type="button" className="btn ghost sm cal-fired-more" onClick={() => setShowOlder(!showOlder)}>
          {showOlder ? "Show fewer" : `Show ${seen.length - RECENT_SEEN} older`}
        </button>
      ) : null}
    </section>
  );
}

function headline(list: FiredReminder[] | null, fresh: number): string {
  if (!list) return "Loading reminders…";
  if (fresh) return fresh === 1 ? "1 reminder went off" : `${fresh} reminders went off`;
  return list.length ? "No new reminders" : "No reminders have gone off yet";
}

function FiredRow(p: { reminder: FiredReminder; kind: CalendarItemKind; timeZone: string; now: number; onShow(): void; onSeen(): void }) {
  const r = p.reminder;
  const isNew = !r.seenAt;
  return (
    <li className={`cal-fired-row k-${p.kind}` + (isNew ? " new" : "")}>
      <span className="cal-fired-icon">
        <KindIcon kind={p.kind} />
      </span>
      <div className="cal-fired-main">
        <div className="cal-fired-line">
          <strong className="cal-fired-name">{r.title}</strong>
          {isNew ? <span className="cal-fired-new">New</span> : null}
        </div>
        <div className="cal-fired-meta">
          Went off {whenLabel(r.firedAt, p.timeZone, p.now)}
          {/* An event's own time (or "All day") opens its text, so only its day is repeated here. */}
          {r.startsAt != null ? ` · for ${r.source === "event" ? dayLabel(r.startsAt, p.timeZone, p.now) : whenLabel(r.startsAt, p.timeZone, p.now)}` : ""}
        </div>
        <p className="cal-fired-text">{r.text}</p>
      </div>
      <div className="cal-fired-side">
        <span className={`cal-fired-delivery d-${r.delivery}`} title={r.deliveryNote ?? undefined}>
          {DELIVERY_LABEL[r.delivery]}
        </span>
        <div className="cal-fired-actions">
          {r.startsAt != null ? (
            <button type="button" className="btn ghost sm" onClick={p.onShow}>
              Show
            </button>
          ) : null}
          {isNew ? (
            <button type="button" className="btn ghost sm" onClick={p.onSeen}>
              Mark seen
            </button>
          ) : null}
        </div>
      </div>
    </li>
  );
}

/** "today", "yesterday", "tomorrow", else "Thu 23 Oct" (with the year when it is not this one). */
function dayLabel(ms: number, timeZone: string, now: number): string {
  const day = dateOf(ms, timeZone);
  const today = dateOf(now, timeZone);
  const offset = dayNumber(day) - dayNumber(today);
  if (offset === 0) return "today";
  if (offset === -1) return "yesterday";
  if (offset === 1) return "tomorrow";
  return formatCivil(day, { weekday: "short", day: "numeric", month: "short", year: day.y === today.y ? undefined : "numeric" });
}

const whenLabel = (ms: number, timeZone: string, now: number): string => `${dayLabel(ms, timeZone, now)} ${formatTime(ms, timeZone)}`;
