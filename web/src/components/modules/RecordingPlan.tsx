import { useState } from "react";
import { Field, Icon, ModuleDialog } from "./ModuleFrame.js";
import { errorText, formatAgo } from "./moduleApi.js";
import {
  describeSchedule,
  formatWhen,
  SEGMENT_MINUTE_CHOICES,
  WEEK,
  type CameraRecording,
  type RecordingMode,
  type RecordingSettings,
  type RecordingView,
  type SurveillanceConfig,
} from "./surveillanceTypes.js";

const MODES: { mode: RecordingMode; label: string; title: string }[] = [
  { mode: "off", label: "Off", title: "Record nothing (the default)" },
  { mode: "continuous", label: "24/7", title: "Record every camera set to record, around the clock, until you turn it off" },
  { mode: "schedule", label: "Schedule", title: "Record only inside the daily window set under Recording settings" },
];

/**
 * The tab's answer to "is anything recording?": the plan in force, what it is doing right now, and the
 * three-way switch that is the only thing able to turn recording on. Off is the default and says so.
 */
export function RecordingBar(props: { config: SurveillanceConfig; view: RecordingView | null; busy: boolean; onMode: (mode: RecordingMode) => void; onSettings: () => void }) {
  const { config, view, busy } = props;
  const mode = view?.mode ?? config.recording.mode;
  const statuses = view?.cameras ?? [];
  const recording = statuses.filter((s) => s.state === "recording").length;
  const enabled = config.cameras.filter((c) => c.recordEnabled).length;
  const live = Boolean(view?.active);
  const { title, detail } = planText(mode, view, config, recording, enabled);
  return (
    <div className={`sv-plan sv-plan-${mode}${live ? " live" : ""}`}>
      <span className="sv-rec-dot" aria-hidden="true" />
      <div className="sv-plan-text">
        <strong>{title}</strong>
        <span>{detail}</span>
        {view?.lastError ? <span className="sv-plan-error">Could not start: {view.lastError}</span> : null}
      </div>
      <div className="segment sv-mode" role="radiogroup" aria-label="Recording">
        {MODES.map((option) => (
          <button key={option.mode} role="radio" aria-checked={mode === option.mode} className={mode === option.mode ? "on" : ""} disabled={busy} title={option.title} onClick={() => mode !== option.mode && props.onMode(option.mode)}>
            {option.label}
          </button>
        ))}
      </div>
      <button className="btn ghost sm" onClick={props.onSettings}>
        <Icon name="settings" size={13} /> Recording settings
      </button>
    </div>
  );
}

function planText(mode: RecordingMode, view: RecordingView | null, config: SurveillanceConfig, recording: number, enabled: number): { title: string; detail: string } {
  if (mode === "off") {
    return { title: "Recording is off", detail: "Nothing is recorded, and cameras are only contacted while this tab shows live pictures. Choose 24/7 or Schedule to record." };
  }
  const folder = config.recordingRoot || "each camera's own folder";
  const counted = `${recording} of ${enabled} camera${enabled === 1 ? "" : "s"}`;
  if (mode === "continuous") return { title: `Recording 24/7 · ${counted}`, detail: `Keeps going with this tab closed and after restarts, until you choose Off. Into ${folder}` };
  const schedule = describeSchedule(view?.schedule ?? config.recording.schedule);
  if (view?.inWindow) return { title: `Recording on schedule · ${counted}`, detail: `${schedule}${view.nextChangeAt ? ` · pauses at ${formatWhen(view.nextChangeAt)}` : ""}` };
  return { title: "Scheduled · not recording now", detail: `${schedule}${view?.nextChangeAt ? ` · next recording ${formatWhen(view.nextChangeAt)}` : ""}` };
}

type Settings = Pick<SurveillanceConfig, "recordingRoot" | "ffmpegPath" | "recording"> & { recordCameras: Record<string, boolean> };

/** When to record, which cameras, and how long to keep it. Saving never turns recording on or off. */
export function RecordingDialog(props: { config: SurveillanceConfig; statuses: CameraRecording[]; onClose: () => void; onSave: (settings: Settings) => Promise<void> }) {
  const { config } = props;
  const [settings, setSettings] = useState<Settings>(() => ({
    recordingRoot: config.recordingRoot,
    ffmpegPath: config.ffmpegPath,
    recording: structuredClone(config.recording),
    recordCameras: Object.fromEntries(config.cameras.map((c) => [c.id, c.recordEnabled])),
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setRecording = <K extends keyof RecordingSettings>(key: K, value: RecordingSettings[K]) => setSettings((s) => ({ ...s, recording: { ...s.recording, [key]: value } }));
  const schedule = settings.recording.schedule;
  const toggleDay = (day: number) => setRecording("schedule", { ...schedule, days: schedule.days.includes(day) ? schedule.days.filter((d) => d !== day) : [...schedule.days, day] });
  const statusById = new Map(props.statuses.map((s) => [s.cameraId, s]));
  const mode = config.recording.mode;

  const save = () => {
    setSaving(true);
    setError(null);
    props.onSave(settings).catch((err: unknown) => {
      setError(errorText(err));
      setSaving(false);
    });
  };

  return (
    <ModuleDialog
      title="Recording settings"
      wide
      onClose={props.onClose}
      footer={
        <>
          {error ? <span className="mod-dialog-error">{error}</span> : null}
          <button className="btn ghost sm" onClick={props.onClose}>
            Cancel
          </button>
          <button className="btn primary sm" disabled={saving} onClick={save}>
            {saving ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <p className="mod-dialog-lede">
        Recording is <strong>{mode === "off" ? "off" : mode === "continuous" ? "on, 24/7" : "on a schedule"}</strong>. Switch it with Off · 24/7 · Schedule above the cameras; these settings say how it records once it is on.
        {config.origin === "dashboard-deck" && config.importedAt ? ` Cameras and the recording folder were imported from the Dashboard Deck ${formatAgo(config.importedAt)}.` : ""}
      </p>
      <fieldset className="mod-fieldset">
        <legend>Schedule</legend>
        <p className="mod-field-hint">Used when recording is set to Schedule. A window that ends before it starts runs past midnight; the same start and end record the whole day.</p>
        <div className="sv-days" role="group" aria-label="Days">
          {WEEK.map((w) => (
            <button key={w.day} type="button" className={`sv-day${schedule.days.includes(w.day) ? " on" : ""}`} aria-pressed={schedule.days.includes(w.day)} onClick={() => toggleDay(w.day)}>
              {w.short}
            </button>
          ))}
        </div>
        <div className="mod-fields">
          <Field label="From">
            <input className="mod-input" type="time" value={schedule.start} onChange={(e) => setRecording("schedule", { ...schedule, start: e.target.value || schedule.start })} />
          </Field>
          <Field label="Until">
            <input className="mod-input" type="time" value={schedule.end} onChange={(e) => setRecording("schedule", { ...schedule, end: e.target.value || schedule.end })} />
          </Field>
        </div>
      </fieldset>
      <fieldset className="mod-fieldset">
        <legend>Cameras</legend>
        {config.cameras.length === 0 ? (
          <p className="mod-field-hint">No cameras yet.</p>
        ) : (
          <ul className="sv-record-list">
            {config.cameras.map((camera) => {
              const hasStream = Boolean(camera.streamUrl || camera.subStreamUrl);
              const status = statusById.get(camera.id);
              return (
                <li key={camera.id}>
                  <label className="mod-check">
                    <input type="checkbox" checked={settings.recordCameras[camera.id] ?? true} onChange={(e) => setSettings((s) => ({ ...s, recordCameras: { ...s.recordCameras, [camera.id]: e.target.checked } }))} /> {camera.name}
                  </label>
                  <span className="mono faint">{hasStream ? (status?.targetDir ?? "no folder yet") : "no RTSP stream: cannot record"}</span>
                </li>
              );
            })}
          </ul>
        )}
      </fieldset>
      <fieldset className="mod-fieldset">
        <legend>Storage</legend>
        <div className="mod-fields">
          <Field label="Recording folder" wide hint="Each camera records into its own folder here, unless the camera names another.">
            <input className="mod-input mono" value={settings.recordingRoot} onChange={(e) => setSettings((s) => ({ ...s, recordingRoot: e.target.value }))} />
          </Field>
          <Field label="File length" hint={mode !== "off" ? "Applies from the next file." : "Each file is one segment you can play or download."}>
            <select className="mod-select" value={settings.recording.segmentMinutes} onChange={(e) => setRecording("segmentMinutes", Number(e.target.value))}>
              {SEGMENT_MINUTE_CHOICES.map((minutes) => (
                <option key={minutes} value={minutes}>
                  {minutes === 60 ? "1 hour" : `${minutes} minute${minutes === 1 ? "" : "s"}`}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Keep recordings for (days)" hint={settings.recording.retentionDays ? `Older files are deleted automatically.` : "Blank keeps everything; nothing is deleted."}>
            <input className="mod-input" type="number" min={0} max={3650} placeholder="Keep everything" value={settings.recording.retentionDays || ""} onChange={(e) => setRecording("retentionDays", e.target.value === "" ? 0 : Math.max(0, Math.round(Number(e.target.value))))} />
          </Field>
          <Field label="Size cap per camera (GB)" hint={settings.recording.maxGbPerCamera ? "The oldest files go first once a camera's folder is over this." : "Blank sets no cap."}>
            <input className="mod-input" type="number" min={0} step={1} placeholder="No cap" value={settings.recording.maxGbPerCamera || ""} onChange={(e) => setRecording("maxGbPerCamera", e.target.value === "" ? 0 : Math.max(0, Number(e.target.value)))} />
          </Field>
          <Field label="ffmpeg" wide hint={config.ffmpegFound ? "Found. Blank uses GGO's own or the one on PATH." : "Not found. Recording and playback need it; blank looks on PATH."}>
            <input className="mod-input mono" value={settings.ffmpegPath} onChange={(e) => setSettings((s) => ({ ...s, ffmpegPath: e.target.value }))} />
          </Field>
        </div>
        <p className="mod-field-hint">Cleanup only ever deletes the recorder's own files (named like <code>2026-01-31_22-15-00.ts</code>); the newest file of each camera and anything still being written are always kept.</p>
      </fieldset>
    </ModuleDialog>
  );
}
