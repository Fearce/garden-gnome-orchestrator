import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useStore } from "../../store.js";
import type { ScheduledTask } from "../../types.js";
import { useCoarseNow } from "../../lib/timing.js";
import {
  type CalendarDefaults,
  type CalendarEvent,
  type CalendarItemKind,
  type CalendarOccurrence,
  type CalendarRange,
  type FiredReminder,
  fetchRange,
  moveScheduleRun,
  onCalendarChanged,
  updateEvent,
} from "../../lib/calendarApi.js";
import { type Span, draftEvent, movedSpan, occurrenceSpan, reminderCron, reminderRepeatOf, seriesSpanFromOccurrenceEdit } from "../../lib/calendarEdit.js";
import { type CalendarFilters, DEFAULT_FILTERS, type EnabledFilter, KIND_LABEL, applyFilters } from "../../lib/calendarLayout.js";
import {
  type CalendarViewMode,
  type CivilDate,
  browserTimeZone,
  dateOf,
  epochToWall,
  formatClock,
  formatDate,
  localeWeekStart,
  parseDate,
  stepAnchor,
  viewTitle,
  visibleDates,
  wallToEpoch,
  zoneAbbreviation,
} from "../../lib/calendarTime.js";
import { ScheduleEditor, type ScheduleDraft } from "../ScheduledTasks.js";
import { AgendaView } from "./AgendaView.js";
import { BellIcon, ChevronIcon, CloseIcon, KindIcon, PlusIcon, SearchIcon, type DropTarget, type ViewActions } from "./CalendarItem.js";
import { DetailsPanel } from "./DetailsPanel.js";
import { EventForm } from "./EventForm.js";
import { FiredReminders } from "./FiredReminders.js";
import { MonthView } from "./MonthView.js";
import { ReminderForm, type ReminderDraft } from "./ReminderForm.js";
import { DefaultRemindersForm } from "./RemindersField.js";
import { TimeGrid } from "./TimeGrid.js";
import "./calendar.css";

type CreateKind = "event" | "reminder";

type Dialog =
  | { kind: "details"; occurrence: CalendarOccurrence }
  | { kind: "create"; tab: CreateKind; date: CivilDate; minutes: number | null }
  | { kind: "editEvent"; event: CalendarEvent; occurrenceDate?: string }
  | { kind: "editReminder"; draft: ReminderDraft }
  | { kind: "moveScope"; title: string; options: { label: string; run: () => Promise<unknown> }[] }
  | { kind: "defaults" };

const VIEWS: { mode: CalendarViewMode; label: string; key: string }[] = [
  { mode: "month", label: "Month", key: "m" },
  { mode: "week", label: "Week", key: "w" },
  { mode: "day", label: "Day", key: "d" },
  { mode: "agenda", label: "Agenda", key: "a" },
];

const NO_DEFAULTS: CalendarDefaults = { reminderLeads: [], allDayTime: "09:00" };

const VIEW_KEY = "ggo-calendar-view";
const FILTER_KEY = "ggo-calendar-filters";

function loadView(): CalendarViewMode {
  const v = localStorage.getItem(VIEW_KEY);
  return v === "week" || v === "day" || v === "agenda" ? v : "month";
}

/** Type and state filters persist per browser; the search text does not. */
function loadFilters(): CalendarFilters {
  try {
    const saved = JSON.parse(localStorage.getItem(FILTER_KEY) ?? "null") as Partial<CalendarFilters> | null;
    return { ...DEFAULT_FILTERS, kinds: { ...DEFAULT_FILTERS.kinds, ...saved?.kinds }, enabled: saved?.enabled ?? "all" };
  } catch {
    return DEFAULT_FILTERS;
  }
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const isTyping = (el: EventTarget | null): boolean => el instanceof HTMLElement && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));

/**
 * The Calendar board area: the owner's own events beside every reminder and scheduled task, by month,
 * week, day or agenda. It reads the visible range from the server, re-reads it on any calendar or
 * schedule change, and never writes anything by being looked at.
 */
export function Calendar() {
  const timeZone = useMemo(browserTimeZone, []);
  const weekStart = useMemo(localeWeekStart, []);
  const schedules = useStore((s) => s.schedules);
  const setBoardView = useStore((s) => s.setBoardView);
  const now = useCoarseNow(60_000);
  const [view, setViewState] = useState<CalendarViewMode>(loadView);
  const [anchor, setAnchor] = useState<CivilDate>(() => dateOf(Date.now(), timeZone));
  const [filters, setFiltersState] = useState<CalendarFilters>(loadFilters);
  const [range, setRange] = useState<CalendarRange | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [scheduleEditor, setScheduleEditor] = useState<{ initial: ScheduledTask | null; draft?: ScheduleDraft } | null>(null);
  const [dragging, setDragging] = useState<CalendarOccurrence | null>(null);
  const grab = useRef(0);
  const unseenReminders = useStore((s) => s.remindersUnseen);
  // Opening the tab while its number shows puts the reminders that raised it on top.
  const [firedOpen, setFiredOpen] = useState(() => useStore.getState().remindersUnseen > 0);
  const [focus, setFocus] = useState<FiredReminder | null>(null);

  const { from, to } = visibleDates(view, anchor, weekStart);
  const fromKey = formatDate(from);
  const toKey = formatDate(to);
  const reload = useCallback(() => setReloadTick((t) => t + 1), []);

  useEffect(() => onCalendarChanged(reload), [reload]);
  const unseenBefore = useRef(unseenReminders);
  useEffect(() => {
    if (unseenReminders > unseenBefore.current) setFiredOpen(true);
    unseenBefore.current = unseenReminders;
  }, [unseenReminders]);
  // A schedule created, edited or fired anywhere (the list view, the director) moves its slots here.
  const seenSchedules = useRef(schedules);
  useEffect(() => {
    if (seenSchedules.current === schedules) return;
    seenSchedules.current = schedules;
    reload();
  }, [schedules, reload]);

  useEffect(() => {
    let live = true;
    setLoading(true);
    fetchRange(fromKey, toKey, timeZone)
      .then((r) => {
        if (!live) return;
        setRange(r);
        setLoadError(null);
      })
      .catch((e: unknown) => live && setLoadError(errorText(e)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [fromKey, toKey, timeZone, reloadTick]);

  const setView = (mode: CalendarViewMode) => {
    setViewState(mode);
    localStorage.setItem(VIEW_KEY, mode);
  };
  const setFilters = (next: CalendarFilters) => {
    setFiltersState(next);
    localStorage.setItem(FILTER_KEY, JSON.stringify({ kinds: next.kinds, enabled: next.enabled }));
  };

  const shown = range ? applyFilters(range.occurrences, filters) : [];
  const filtered = !!range && shown.length !== range.occurrences.length;
  const serverTimeZone = range?.serverTimeZone ?? timeZone;
  const defaults = range?.defaults ?? NO_DEFAULTS;
  const eventOf = (id: string) => range?.events.find((e) => e.id === id) ?? null;
  const scheduleOf = (id: string) => schedules.find((s) => s.id === id) ?? null;
  // An open details panel follows the refetched range, so a skip or restore shows its new status.
  const latest = (o: CalendarOccurrence) => range?.occurrences.find((x) => x.key === o.key) ?? o;

  // "Show" on a fired reminder: once the range holding its day has loaded, open what it was about.
  useEffect(() => {
    if (!focus || !range || loading || focus.startsAt == null) return;
    const day = formatDate(dateOf(focus.startsAt, timeZone));
    if (day < range.from || day > range.to) return;
    setFocus(null);
    const found = range.occurrences.find((o) => firedTarget(o, focus, timeZone));
    if (found) setDialog({ kind: "details", occurrence: found });
    else setActionError(`“${focus.title}” is no longer on the calendar on that day; it was moved or deleted after the reminder went off.`);
  }, [focus, range, loading, timeZone]);

  const showFired = (r: FiredReminder) => {
    if (r.startsAt == null) return;
    setActionError(null);
    setAnchor(dateOf(r.startsAt, timeZone));
    setFocus(r);
  };

  const guard = async (fn: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await fn();
    } catch (e) {
      setActionError(errorText(e));
    }
  };

  // ---- direct manipulation ----

  const dropEvent = (o: CalendarOccurrence, target: DropTarget) => {
    const event = eventOf(o.id);
    if (!event) return;
    const before = occurrenceSpan(event, o.occurrenceDate);
    const after = movedSpan(before, event.timeZone, target, o.allDay ? undefined : dateOf(o.startAt, timeZone));
    if (after.start === before.start && after.end === before.end && after.allDay === before.allDay) return;
    if (!event.recurrence) return void guard(() => updateEvent(event.id, "series", null, after));
    const date = o.occurrenceDate ?? null;
    const series: Span = seriesSpanFromOccurrenceEdit(event, before, after);
    setDialog({
      kind: "moveScope",
      title: `Move “${o.title}”`,
      options: [
        { label: "Only this event", run: () => updateEvent(event.id, "occurrence", date, after) },
        { label: "This and following", run: () => updateEvent(event.id, "following", date, after) },
        { label: "All events", run: () => updateEvent(event.id, "series", null, series) },
      ],
    });
  };

  const dropScheduleRun = (o: CalendarOccurrence, target: DropTarget) => {
    const slot = o.slotAt;
    if (slot == null) return;
    const clock = epochToWall(slot, timeZone);
    const toAt = "at" in target ? target.at : wallToEpoch({ ...target.date, hh: clock.hh, mi: clock.mi }, timeZone);
    if (toAt === slot) return;
    if (!o.recurring) return void guard(() => moveScheduleRun(o.id, slot, toAt, "occurrence"));
    setDialog({
      kind: "moveScope",
      title: `Move “${o.title}”`,
      options: [
        { label: "Only this run", run: () => moveScheduleRun(o.id, slot, toAt, "occurrence") },
        { label: "Every run", run: () => moveScheduleRun(o.id, slot, toAt, "series") },
      ],
    });
  };

  const actions: ViewActions = {
    timeZone,
    now,
    dragging,
    open: (o) => setDialog({ kind: "details", occurrence: o }),
    // The range supplies saved defaults and the server zone. Opening earlier would freeze the
    // form's state with empty reminders and could create a reminder on the wrong server clock.
    create: (date, minutes) => { if (range) setDialog({ kind: "create", tab: "event", date, minutes }); },
    goToDay: (date) => {
      setAnchor(date);
      setView("day");
    },
    canDrag: (o) => !o.count && (o.source === "event" || (o.slotAt != null && (o.status === "upcoming" || o.status === "paused"))),
    beginDrag: (o, grabMinutes) => {
      grab.current = grabMinutes;
      setDragging(o);
    },
    endDrag: () => setDragging(null),
    grabMinutes: () => grab.current,
    drop: (target) => {
      const o = dragging;
      setDragging(null);
      if (!o) return;
      if (o.source === "event") dropEvent(o, target);
      else dropScheduleRun(o, target);
    },
  };

  // ---- dialogs ----

  const editSchedule = (s: ScheduledTask, o: CalendarOccurrence) => {
    const repeat = s.prompt ? null : reminderRepeatOf(s.cron, !!s.runOnce);
    if (repeat == null) {
      setDialog(null);
      setScheduleEditor({ initial: s });
      return;
    }
    const at = o.slotAt ?? s.nextRunAt ?? o.startAt;
    const w = epochToWall(at, timeZone);
    setDialog({ kind: "editReminder", draft: { schedule: s, date: formatDate(w), time: formatClock(w.hh * 60 + w.mi), repeat } });
  };

  const openAdvanced = (existing: ScheduledTask | null, draft: ScheduleDraft) => {
    setDialog(null);
    setScheduleEditor(existing ? { initial: existing } : { initial: null, draft });
  };

  const newScheduledTask = (date: CivilDate, minutes: number | null) => {
    const at = wallToEpoch({ ...date, hh: Math.floor((minutes ?? 9 * 60) / 60), mi: (minutes ?? 9 * 60) % 60 }, timeZone);
    openAdvanced(null, { cron: reminderCron("none", at, serverTimeZone), runOnce: true });
  };

  const onRootKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (dialog || scheduleEditor || isTyping(e.target) || e.altKey || e.ctrlKey || e.metaKey) return;
    const mode = VIEWS.find((v) => v.key === e.key);
    if (mode) setView(mode.mode);
    else if (e.key === "t") setAnchor(dateOf(Date.now(), timeZone));
    else if (e.key === "n") actions.create(anchor, view === "month" ? null : 9 * 60);
    else if (e.key === "ArrowLeft" || e.key === "PageUp") setAnchor(stepAnchor(view, anchor, -1));
    else if (e.key === "ArrowRight" || e.key === "PageDown") setAnchor(stepAnchor(view, anchor, 1));
    else return;
    e.preventDefault();
  };

  const today = dateOf(now, timeZone);
  const showsToday = formatDate(today) >= fromKey && formatDate(today) <= toKey;

  return (
    <div className="cal-view" onKeyDown={onRootKey}>
      <header className="cal-toolbar">
        <div className="cal-nav">
          <button type="button" className="btn ghost sm cal-icon-btn" onClick={() => setAnchor(stepAnchor(view, anchor, -1))} aria-label={`Previous ${view === "agenda" ? "30 days" : view}`} title="Previous (←)">
            <ChevronIcon dir="left" />
          </button>
          <button type="button" className="btn ghost sm" onClick={() => setAnchor(today)} disabled={view === "month" ? anchor.y === today.y && anchor.m === today.m : view === "week" && showsToday} title="Go to today (T)">
            Today
          </button>
          <button type="button" className="btn ghost sm cal-icon-btn" onClick={() => setAnchor(stepAnchor(view, anchor, 1))} aria-label={`Next ${view === "agenda" ? "30 days" : view}`} title="Next (→)">
            <ChevronIcon dir="right" />
          </button>
          <h2 className="cal-title" aria-live="polite">
            {viewTitle(view, anchor, weekStart)}
          </h2>
          <input className="cal-jump" type="date" aria-label="Go to date" value={formatDate(anchor)} onChange={(e) => e.target.value && setAnchor(parseDate(e.target.value) ?? anchor)} />
        </div>
        <button
          type="button"
          className={"btn ghost sm cal-manage cal-fired-toggle" + (unseenReminders ? " has-new" : "")}
          aria-pressed={firedOpen}
          onClick={() => setFiredOpen(!firedOpen)}
          title="Reminders that went off: which ones are new, what they said and whether Discord got them"
        >
          <BellIcon size={12} /> Went off
          {unseenReminders ? <span className="board-tab-count">{unseenReminders}</span> : null}
        </button>
        <button type="button" className="btn ghost sm cal-manage" onClick={() => setBoardView("schedules")} title="The list of every reminder and scheduled task, with Run now">
          Manage schedules
        </button>
        <button type="button" className="btn ghost sm cal-manage" disabled={!range} onClick={() => setDialog({ kind: "defaults" })} title="The reminders every new event starts with">
          <BellIcon size={12} /> Default reminders
        </button>
        <div className="cal-modes" role="radiogroup" aria-label="Calendar view">
          {VIEWS.map((v) => (
            <button key={v.mode} type="button" role="radio" aria-checked={view === v.mode} className={"cal-mode" + (view === v.mode ? " on" : "")} onClick={() => setView(v.mode)} title={`${v.label} (${v.key.toUpperCase()})`}>
              {v.label}
            </button>
          ))}
        </div>
        <button type="button" className="btn primary sm cal-new" disabled={!range} onClick={() => actions.create(anchor, view === "month" || view === "agenda" ? null : 9 * 60)} title="New event or reminder (N)">
          <PlusIcon /> New
        </button>
      </header>

      {firedOpen ? <FiredReminders timeZone={timeZone} now={now} onShow={showFired} onClose={() => setFiredOpen(false)} /> : null}

      <div className="cal-filterbar">
        <label className="cal-search">
          <SearchIcon />
          <input type="search" placeholder="Search titles" aria-label="Search calendar titles" value={filters.query} onChange={(e) => setFilters({ ...filters, query: e.target.value })} />
        </label>
        <div className="cal-kinds" role="group" aria-label="Show types">
          {(Object.keys(KIND_LABEL) as CalendarItemKind[]).map((k) => (
            <button
              key={k}
              type="button"
              className={`cal-kind-toggle k-${k}` + (filters.kinds[k] ? " on" : "")}
              aria-pressed={filters.kinds[k]}
              onClick={() => setFilters({ ...filters, kinds: { ...filters.kinds, [k]: !filters.kinds[k] } })}
            >
              <KindIcon kind={k} /> {k === "event" ? "Events" : k === "reminder" ? "Reminders" : "Scheduled tasks"}
            </button>
          ))}
        </div>
        <label className="cal-state">
          <span className="sr-only">Show</span>
          <select aria-label="Filter by state" value={filters.enabled} onChange={(e) => setFilters({ ...filters, enabled: e.target.value as EnabledFilter })}>
            <option value="all">Active and paused</option>
            <option value="active">Active only</option>
            <option value="inactive">Paused and skipped only</option>
          </select>
        </label>
        <span className="cal-zone" title={serverTimeZone !== timeZone ? `Reminders and scheduled tasks fire on the server clock (${serverTimeZone}); they are shown here in your time.` : undefined}>
          {timeZone} · {zoneAbbreviation(now, timeZone)}
          {serverTimeZone !== timeZone ? ` · server ${serverTimeZone}` : ""}
        </span>
      </div>

      <StatusLine loading={loading} hasData={!!range} loadError={loadError} actionError={actionError} empty={!!range && !shown.length && view !== "agenda"} filtered={filtered} onRetry={reload} onDismiss={() => setActionError(null)} />

      <div className={`cal-body cal-body-${view}` + (loading && range ? " refreshing" : "")} inert={!range} aria-busy={loading}>
        {!range && loadError ? null : view === "month" ? (
          <MonthView from={from} to={to} anchor={anchor} occurrences={shown} actions={actions} onCursor={setAnchor} />
        ) : view === "agenda" ? (
          range ? <AgendaView from={from} to={to} occurrences={shown} actions={actions} filtered={filtered} /> : null
        ) : (
          <TimeGrid from={from} to={to} anchor={anchor} occurrences={shown} actions={actions} onCursor={setAnchor} />
        )}
      </div>

      {dialog ? (
        <CalendarModal title={dialogTitle(dialog)} onClose={() => setDialog(null)} wide={dialog.kind !== "details" && dialog.kind !== "moveScope"}>
          {dialog.kind === "details" ? (
            <DetailsPanel
              occurrence={latest(dialog.occurrence)}
              event={dialog.occurrence.source === "event" ? eventOf(dialog.occurrence.id) : null}
              schedule={dialog.occurrence.source === "schedule" ? scheduleOf(dialog.occurrence.id) : null}
              timeZone={timeZone}
              serverTimeZone={serverTimeZone}
              onEditEvent={(event, occurrenceDate) => setDialog({ kind: "editEvent", event, occurrenceDate })}
              onEditSchedule={editSchedule}
              onClose={() => setDialog(null)}
            />
          ) : dialog.kind === "create" ? (
            <CreateTabs
              dialog={dialog}
              defaults={defaults}
              timeZone={timeZone}
              serverTimeZone={serverTimeZone}
              onTab={(tab) => setDialog({ ...dialog, tab })}
              onTask={() => newScheduledTask(dialog.date, dialog.minutes)}
              onDone={() => setDialog(null)}
              onAdvanced={(draft) => openAdvanced(null, draft)}
            />
          ) : dialog.kind === "editEvent" ? (
            <EventForm
              initial={dialog.event}
              editing={{ event: dialog.event, occurrenceDate: dialog.occurrenceDate }}
              allDayTime={defaults.allDayTime}
              onSaved={() => setDialog(null)}
              onCancel={() => setDialog(null)}
            />
          ) : dialog.kind === "editReminder" ? (
            <ReminderForm
              draft={dialog.draft}
              timeZone={timeZone}
              serverTimeZone={serverTimeZone}
              onSaved={() => setDialog(null)}
              onCancel={() => setDialog(null)}
              onAdvanced={(draft) => openAdvanced(dialog.draft.schedule, draft)}
            />
          ) : dialog.kind === "defaults" ? (
            <DefaultRemindersForm initial={defaults} onDone={() => setDialog(null)} />
          ) : (
            <ScopeChoice options={dialog.options} onDone={() => setDialog(null)} />
          )}
        </CalendarModal>
      ) : null}

      {scheduleEditor ? <ScheduleEditor initial={scheduleEditor.initial} draft={scheduleEditor.draft} onClose={() => setScheduleEditor(null)} /> : null}
    </div>
  );
}

/** Whether an occurrence is the one a fired reminder was about: the same event occurrence, or the same
 *  schedule's run (a day too dense to list its runs collapses into one item for that day). */
function firedTarget(o: CalendarOccurrence, r: FiredReminder, timeZone: string): boolean {
  if (o.id !== r.refId || o.source !== r.source) return false;
  if (r.source === "event") return o.occurrenceDate === r.occurrence;
  if (o.count) return r.startsAt != null && formatDate(dateOf(o.startAt, timeZone)) === formatDate(dateOf(r.startsAt, timeZone));
  return o.slotAt === r.startsAt;
}

function dialogTitle(d: Dialog): string {
  switch (d.kind) {
    case "details":
      return KIND_LABEL[d.occurrence.kind];
    case "create":
      return "New";
    case "editEvent":
      return d.event.recurrence ? "Edit repeating event" : "Edit event";
    case "editReminder":
      return "Edit reminder";
    case "moveScope":
      return d.title;
    case "defaults":
      return "Default reminders";
  }
}

function StatusLine(p: { loading: boolean; hasData: boolean; loadError: string | null; actionError: string | null; empty: boolean; filtered: boolean; onRetry(): void; onDismiss(): void }) {
  if (p.actionError) {
    return (
      <div className="cal-statusline error" role="alert">
        {p.actionError}
        <button type="button" className="btn ghost sm" onClick={p.onDismiss}>
          Dismiss
        </button>
      </div>
    );
  }
  if (p.loadError) {
    return (
      <div className="cal-statusline error" role="alert">
        {p.hasData ? "Could not refresh the calendar: " : "Could not load the calendar: "}
        {p.loadError}
        <button type="button" className="btn ghost sm" onClick={p.onRetry}>
          Retry
        </button>
      </div>
    );
  }
  if (p.loading && !p.hasData) return <div className="cal-statusline" role="status">Loading the calendar…</div>;
  if (p.empty) return <div className="cal-statusline">{p.filtered ? "Nothing here matches the current search and filters." : "Nothing planned in these dates. Click a day or a time to add something."}</div>;
  return <div className="cal-statusline quiet" aria-hidden="true" />;
}

function CreateTabs(p: {
  dialog: Extract<Dialog, { kind: "create" }>;
  defaults: CalendarDefaults;
  timeZone: string;
  serverTimeZone: string;
  onTab(tab: CreateKind): void;
  onTask(): void;
  onDone(): void;
  onAdvanced(draft: ScheduleDraft): void;
}) {
  const { date, minutes, tab } = p.dialog;
  const reminderTime = formatClock(minutes ?? 9 * 60);
  return (
    <>
      <div className="cal-tabs" role="tablist" aria-label="What to add">
        {(
          [
            ["event", "Event"],
            ["reminder", "Reminder"],
          ] as [CreateKind, string][]
        ).map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={"cal-tab" + (tab === k ? " on" : "")} onClick={() => p.onTab(k)}>
            <KindIcon kind={k} /> {label}
          </button>
        ))}
        <button type="button" role="tab" aria-selected={false} className="cal-tab" onClick={p.onTask} title="Opens the scheduled-task editor: a prompt an agent runs in a repo at this time">
          <KindIcon kind="task" /> Scheduled task
        </button>
      </div>
      {tab === "event" ? (
        <EventForm initial={draftEvent(date, minutes, p.timeZone, p.defaults)} editing={null} allDayTime={p.defaults.allDayTime} onSaved={p.onDone} onCancel={p.onDone} />
      ) : (
        <ReminderForm
          draft={{ schedule: null, date: formatDate(date), time: reminderTime, repeat: "none" }}
          timeZone={p.timeZone}
          serverTimeZone={p.serverTimeZone}
          onSaved={p.onDone}
          onCancel={p.onDone}
          onAdvanced={p.onAdvanced}
        />
      )}
    </>
  );
}

function ScopeChoice({ options, onDone }: { options: { label: string; run: () => Promise<unknown> }[]; onDone(): void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const choose = async (run: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await run();
      onDone();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };
  return (
    <div className="cal-scope">
      <p className="cal-hint">This repeats. Which should move?</p>
      <div className="cal-scope-options">
        {options.map((o, i) => (
          <button key={o.label} type="button" className={"btn " + (i === 0 ? "primary" : "ghost")} disabled={busy} autoFocus={i === 0} onClick={() => void choose(o.run)}>
            {o.label}
          </button>
        ))}
        <button type="button" className="btn ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
      {error ? (
        <div className="cal-error" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}

/** The calendar's dialog: Escape and the backdrop close it, and focus goes back where it came from. */
function CalendarModal({ title, wide, onClose, children }: { title: string; wide: boolean; onClose(): void; children: ReactNode }) {
  const modal = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(document.activeElement);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const back = opener.current;
    // On the window, not the dialog: an action button that disables itself drops focus to <body>.
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Tab" && modal.current) {
        const focusable = Array.from(modal.current.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]'))
          .filter((el) => el.tabIndex >= 0 && !el.matches(":disabled") && el.getClientRects().length > 0);
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (first && last && (!modal.current.contains(document.activeElement) || (e.shiftKey ? document.activeElement === first : document.activeElement === last))) {
          e.preventDefault();
          (e.shiftKey ? last : first).focus();
        }
        return;
      }
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      close.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (back instanceof HTMLElement && back.isConnected) back.focus();
    };
  }, []);
  return (
    <div className="scrim" onMouseDown={onClose}>
      <div
        ref={modal}
        className={"modal cal-modal" + (wide ? " wide" : "")}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="cal-modal-head">
          <span className="q-context">{title}</span>
          <button type="button" className="cal-close" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </div>
        <div className="m-body">{children}</div>
      </div>
    </div>
  );
}
