import { useState, type CSSProperties } from "react";
import { useStore } from "../store.js";
import type { Effort, ScheduledTask } from "../types.js";
import { PathInput } from "./PathInput.js";
import { useCoarseNow } from "../lib/timing.js";
import {
  DEFAULT_RECURRENCE,
  WEEKDAY_LABELS,
  cronToRecurrence,
  describeCron,
  isValidCron,
  recurrenceToCron,
  type Freq,
  type Recurrence,
} from "../lib/cron.js";

const EFFORTS: (Effort | "")[] = ["", "low", "medium", "high", "max"];

/** A future-relative label ("in 4m", "in 2h", "in 3d") — the counterpart to format.ts's `since`. */
function until(nowMs: number, ts: number): string {
  const s = Math.max(0, Math.floor((ts - nowMs) / 1000));
  if (s < 60) return `in ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `in ${h}h`;
  return `in ${Math.floor(h / 24)}d`;
}

/** The Scheduled Tasks view: the list of recurring dispatches plus create/edit. Rendered by the Board
 *  in place of the task lanes when the header toggle is on "Scheduled Tasks". */
export function ScheduledTasks() {
  const schedules = useStore((s) => s.schedules);
  const [editing, setEditing] = useState<ScheduledTask | "new" | null>(null);
  const sorted = [...schedules].sort((a, b) => a.createdAt - b.createdAt);

  return (
    <div className="sched-view">
      <div className="sched-toolbar">
        <span className="faint mono" style={{ fontSize: 11 }}>
          {schedules.length} {schedules.length === 1 ? "schedule" : "schedules"}
        </span>
        <button className="btn primary sm" onClick={() => setEditing("new")} title="Create a new scheduled task">
          <PlusIcon /> New schedule
        </button>
      </div>

      {sorted.length === 0 ? (
        <div className="empty">
          <div className="big">No scheduled tasks</div>
          <div className="faint">
            Create one with <b>+ New schedule</b>, or ask the director to “run X every morning”.
          </div>
        </div>
      ) : (
        <div className="sched-list">
          {sorted.map((s) => (
            <ScheduleCard key={s.id} sched={s} onEdit={() => setEditing(s)} />
          ))}
        </div>
      )}

      {editing ? <ScheduleEditor initial={editing === "new" ? null : editing} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}

function ScheduleCard({ sched, onEdit }: { sched: ScheduledTask; onEdit: () => void }) {
  const now = useCoarseNow();
  const updateSchedule = useStore((s) => s.updateSchedule);
  const deleteSchedule = useStore((s) => s.deleteSchedule);
  const runSchedule = useStore((s) => s.runSchedule);
  const select = useStore((s) => s.select);
  const setBoardView = useStore((s) => s.setBoardView);
  const lastThread = useStore((s) => (sched.lastThreadId ? s.threads[sched.lastThreadId] : undefined));

  const openLast = () => {
    if (!lastThread) return;
    setBoardView("tasks");
    select(lastThread.id);
  };

  return (
    <div className={"sched-card" + (sched.enabled ? "" : " off")}>
      <div className="sched-card-head">
        <div className="sched-title" title={sched.title}>
          {sched.title}
        </div>
        <label className="sched-switch" title={sched.enabled ? "Enabled — click to pause" : "Paused — click to enable"}>
          <input type="checkbox" checked={sched.enabled} onChange={(e) => updateSchedule(sched.id, { enabled: e.target.checked })} />
          <span className="sched-switch-track" aria-hidden="true">
            <span className="sched-switch-thumb" />
          </span>
        </label>
      </div>

      <WorkspacePath path={sched.workspace} />

      <div className="sched-prompt" title={sched.prompt}>
        {sched.prompt}
      </div>

      <div className="sched-meta">
        <span className="sched-cron" title={sched.cron}>
          <ClockIcon />
          {describeCron(sched.cron)}
        </span>
        {sched.effort ? (
          <span className={"effort-badge eff-" + sched.effort} title="Implementor effort for each run">
            {sched.effort}
          </span>
        ) : null}
      </div>

      <div className="sched-times">
        {sched.enabled && sched.nextRunAt ? (
          <span title={new Date(sched.nextRunAt).toLocaleString()}>
            Next: <b>{until(now, sched.nextRunAt)}</b>
          </span>
        ) : (
          <span className="faint">Paused — no next run</span>
        )}
        {sched.lastRunAt ? (
          lastThread ? (
            <button className="sched-lastlink" onClick={openLast} title="Open the task from the last run">
              Last run {new Date(sched.lastRunAt).toLocaleString()} →
            </button>
          ) : (
            <span className="faint" title={new Date(sched.lastRunAt).toLocaleString()}>
              Last run {new Date(sched.lastRunAt).toLocaleString()}
            </span>
          )
        ) : null}
      </div>

      <div className="sched-actions">
        <button className="btn ghost sm" onClick={() => runSchedule(sched.id)} title="Dispatch a run right now (doesn't change the schedule)">
          Run now
        </button>
        <button className="btn ghost sm" onClick={onEdit} title="Edit this schedule">
          Edit
        </button>
        <button
          className="btn danger sm"
          title="Delete this schedule"
          onClick={() => {
            if (window.confirm(`Delete scheduled task "${sched.title}"? Future runs stop; already-dispatched tasks are unaffected.`)) deleteSchedule(sched.id);
          }}
        >
          Delete
        </button>
      </div>
    </div>
  );
}

/** Create/edit modal. New when `initial` is null; otherwise prefilled from the schedule being edited. */
function ScheduleEditor({ initial, onClose }: { initial: ScheduledTask | null; onClose: () => void }) {
  const createSchedule = useStore((s) => s.createSchedule);
  const updateSchedule = useStore((s) => s.updateSchedule);

  const [title, setTitle] = useState(initial?.title ?? "");
  const [workspace, setWorkspace] = useState(initial?.workspace ?? "");
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [effort, setEffort] = useState<Effort | "">(initial?.effort ?? "");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [rec, setRec] = useState<Recurrence>(initial ? cronToRecurrence(initial.cron) : DEFAULT_RECURRENCE);

  const cron = recurrenceToCron(rec);
  const cronValid = isValidCron(cron);
  const canSave = title.trim() && workspace.trim() && prompt.trim() && cronValid;

  const save = () => {
    if (!canSave) return;
    const payload = { title: title.trim(), workspace: workspace.trim(), prompt: prompt.trim(), cron, effort: effort || null, enabled };
    if (initial) updateSchedule(initial.id, payload);
    else createSchedule(payload);
    onClose();
  };

  return (
    <div className="scrim" onMouseDown={onClose}>
      <div className="modal sched-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="m-head">
          <div className="q-context">{initial ? "Edit scheduled task" : "New scheduled task"}</div>
        </div>
        <div className="m-body sched-form">
          <label className="sched-field">
            <span className="sched-label">Title</span>
            <input value={title} placeholder="e.g. Nightly dependency audit" onChange={(e) => setTitle(e.target.value)} autoFocus />
          </label>

          <label className="sched-field">
            <span className="sched-label">Target repo</span>
            <PathInput value={workspace} onChange={setWorkspace} placeholder="Absolute path, e.g. C:\my-project" title="The repo each run works in" />
          </label>

          <label className="sched-field">
            <span className="sched-label">Prompt</span>
            <textarea
              className="sched-prompt-input"
              value={prompt}
              placeholder="What should run each time? Write it as a complete standalone task — it runs unattended."
              onChange={(e) => setPrompt(e.target.value)}
            />
          </label>

          <RecurrenceBuilder rec={rec} setRec={setRec} cron={cron} cronValid={cronValid} />

          <div className="sched-row">
            <label className="sched-field sched-field-inline">
              <span className="sched-label">Effort</span>
              <select value={effort} onChange={(e) => setEffort(e.target.value as Effort | "")}>
                {EFFORTS.map((ef) => (
                  <option key={ef || "auto"} value={ef}>
                    {ef === "" ? "Auto (planner decides)" : ef}
                  </option>
                ))}
              </select>
            </label>
            <label className="sched-field sched-field-inline sched-enable">
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
              <span>Enabled</span>
            </label>
          </div>
        </div>
        <div className="m-foot sched-foot">
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save} disabled={!canSave} title={!cronValid ? "The schedule isn't valid yet" : undefined}>
            {initial ? "Save changes" : "Create schedule"}
          </button>
        </div>
      </div>
    </div>
  );
}

const FREQS: { value: Freq; label: string }[] = [
  { value: "minutes", label: "Every N minutes" },
  { value: "hourly", label: "Every N hours" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "custom", label: "Custom cron" },
];

/** The friendly recurrence controls: a frequency picker with the relevant fields, plus a live cron
 *  preview + plain-language description so the operator always sees exactly what they're setting. */
function RecurrenceBuilder({ rec, setRec, cron, cronValid }: { rec: Recurrence; setRec: (r: Recurrence) => void; cron: string; cronValid: boolean }) {
  const set = (patch: Partial<Recurrence>) => setRec({ ...rec, ...patch });
  const toggleDay = (d: number) => set({ days: rec.days.includes(d) ? rec.days.filter((x) => x !== d) : [...rec.days, d] });

  return (
    <div className="sched-field">
      <span className="sched-label">Schedule</span>
      <div className="sched-recur">
        <select value={rec.freq} onChange={(e) => set({ freq: e.target.value as Freq })} className="sched-freq">
          {FREQS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>

        {rec.freq === "minutes" ? (
          <span className="sched-inline">
            every <NumInput value={rec.interval} min={1} max={59} onChange={(v) => set({ interval: v })} /> minutes
          </span>
        ) : null}

        {rec.freq === "hourly" ? (
          <span className="sched-inline">
            every <NumInput value={rec.interval} min={1} max={23} onChange={(v) => set({ interval: v })} /> hours at :
            <NumInput value={rec.minute} min={0} max={59} onChange={(v) => set({ minute: v })} pad />
          </span>
        ) : null}

        {rec.freq === "daily" || rec.freq === "weekly" || rec.freq === "monthly" ? (
          <span className="sched-inline">
            at <TimeInput hour={rec.hour} minute={rec.minute} onChange={(h, m) => set({ hour: h, minute: m })} />
          </span>
        ) : null}

        {rec.freq === "monthly" ? (
          <span className="sched-inline">
            on day <NumInput value={rec.dom} min={1} max={31} onChange={(v) => set({ dom: v })} />
          </span>
        ) : null}

        {rec.freq === "custom" ? (
          <input
            className={"sched-rawcron" + (cronValid ? "" : " invalid")}
            value={rec.raw}
            placeholder="min hour dom month dow — e.g. 0 9 * * 1-5"
            spellCheck={false}
            onChange={(e) => set({ raw: e.target.value })}
          />
        ) : null}
      </div>

      {rec.freq === "weekly" ? (
        <div className="sched-days">
          {WEEKDAY_LABELS.map((lbl, i) => (
            <button key={lbl} type="button" className={"sched-day" + (rec.days.includes(i) ? " on" : "")} onClick={() => toggleDay(i)}>
              {lbl}
            </button>
          ))}
        </div>
      ) : null}

      <div className={"sched-preview" + (cronValid ? "" : " invalid")}>
        {cronValid ? (
          <>
            <span className="sched-desc">{describeCron(cron)}</span>
            <code className="sched-cronstr">{cron}</code>
          </>
        ) : (
          <span className="sched-desc">Enter a valid 5-field cron expression.</span>
        )}
      </div>
    </div>
  );
}

function NumInput({ value, min, max, onChange, pad }: { value: number; min: number; max: number; onChange: (v: number) => void; pad?: boolean }) {
  // `raw` holds the in-progress text so the user can clear the box and retype without it snapping to
  // `min` on the empty keystroke; a parseable value still updates live (so the cron preview tracks it),
  // and blur drops the override so the field re-displays the clamped store value.
  const [raw, setRaw] = useState<string | null>(null);
  const shown = raw ?? (pad ? String(value).padStart(2, "0") : String(value));
  return (
    <input
      type="number"
      className="sched-num"
      min={min}
      max={max}
      value={shown}
      onChange={(e) => {
        setRaw(e.target.value);
        const n = Number(e.target.value);
        if (e.target.value !== "" && Number.isFinite(n)) onChange(Math.max(min, Math.min(max, Math.round(n))));
      }}
      onBlur={() => setRaw(null)}
    />
  );
}

function TimeInput({ hour, minute, onChange }: { hour: number; minute: number; onChange: (h: number, m: number) => void }) {
  const val = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  return (
    <input
      type="time"
      className="sched-time"
      value={val}
      onChange={(e) => {
        const [h, m] = e.target.value.split(":").map(Number);
        if (Number.isFinite(h) && Number.isFinite(m)) onChange(h!, m!);
      }}
    />
  );
}

/** Compact folder path, mirroring the board card's WorkspacePath styling via shared classes. */
function WorkspacePath({ path }: { path: string }) {
  const norm = path.replace(/[\\/]+$/, "");
  const i = Math.max(norm.lastIndexOf("\\"), norm.lastIndexOf("/"));
  const parent = i < 0 ? "" : norm.slice(0, i);
  const leaf = i < 0 ? norm : norm.slice(i);
  return (
    <div className="ws-path" title={path}>
      <svg className="ws-ico" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
      </svg>
      {parent ? <span className="ws-parent">{parent}</span> : null}
      <span className="ws-leaf">{leaf}</span>
    </div>
  );
}

function PlusIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ marginRight: 4, verticalAlign: "-2px" } as CSSProperties}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}
