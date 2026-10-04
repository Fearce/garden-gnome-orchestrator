import { useEffect, useState, type ReactNode } from "react";
import { Field, Icon, ModuleDialog, Notice } from "./ModuleFrame.js";
import { usePoll } from "./hooks.js";
import { errorText, formatAgo, moduleJson } from "./moduleApi.js";

type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

const WEEK: { day: Weekday; short: string }[] = [
  { day: "mon", short: "Mon" },
  { day: "tue", short: "Tue" },
  { day: "wed", short: "Wed" },
  { day: "thu", short: "Thu" },
  { day: "fri", short: "Fri" },
  { day: "sat", short: "Sat" },
  { day: "sun", short: "Sun" },
];

interface Rule {
  automationId: string;
  entityId: string;
  name: string;
  enabled: boolean;
  lastTriggered: string | null;
}

interface AutoStart extends Rule {
  start: string;
  end: string;
  batteryPercent: number;
  days: Weekday[];
}

interface QuietGuard extends Rule {
  start: string;
  end: string;
}

interface OtherRule extends Rule {
  acts: "starts" | "docks" | "other";
}

interface Schedule {
  supported: true;
  vacuumEntityId: string;
  autoStart: AutoStart | null;
  quietGuard: QuietGuard | null;
  others: OtherRule[];
  defaults: { start: string; end: string; batteryPercent: number; days: Weekday[] };
  autoStartBlocked: string | null;
}

type ScheduleAnswer = Schedule | { supported: false; reason: string };

interface Draft {
  start: string;
  end: string;
  autoStart: { enabled: boolean; batteryPercent: number; days: Weekday[] };
  quietGuard: { enabled: boolean };
}

/**
 * The vacuum's cleaning schedule. It lives in Home Assistant as automations, so it keeps running with GGO
 * closed; this reads it once when the card opens and after each change, and never polls.
 */
export function VacuumSchedule({ deviceId, deviceName, paused }: { deviceId: string; deviceName: string; paused: boolean }) {
  const path = `/devices/${encodeURIComponent(deviceId)}/schedule`;
  const schedule = usePoll((signal) => moduleJson<ScheduleAnswer>("home", path, { signal }), null, !paused);
  const [editing, setEditing] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A change answers with the new schedule; show it until the next read replaces it.
  const [changed, setChanged] = useState<ScheduleAnswer | null>(null);
  useEffect(() => setChanged(null), [schedule.data]);
  const data = changed ?? schedule.data;

  if (paused) return null;
  if (data && !data.supported) {
    return (
      <section className="home-schedule">
        <ScheduleHead />
        <p className="home-schedule-empty">{data.reason}.</p>
      </section>
    );
  }

  const toggle = async (rule: Rule) => {
    setSwitching(rule.entityId);
    setError(null);
    try {
      setChanged(await moduleJson<Schedule>("home", `${path}/enabled`, { method: "POST", body: { entityId: rule.entityId, enabled: !rule.enabled } }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSwitching(null);
    }
  };

  return (
    <section className="home-schedule">
      <ScheduleHead>
        {data ? (
          <button className="btn ghost sm" onClick={() => setEditing(true)}>
            <Icon name="pencil" size={12} /> Edit
          </button>
        ) : null}
      </ScheduleHead>
      {schedule.error ? (
        <Notice tone="bad" title="The schedule could not be read" onRetry={() => void schedule.refresh()}>
          {errorText(schedule.error)}
        </Notice>
      ) : !data ? (
        <p className="home-schedule-empty">Reading Home Assistant's automations…</p>
      ) : (
        <ul className="home-rules">
          <RuleRow label="Auto-start" rule={data.autoStart} detail={data.autoStart ? autoStartText(data.autoStart) : "Not set up. Edit to start it on a full battery inside a daily window."} busy={switching} onToggle={toggle} />
          <RuleRow label="Quiet hours" rule={data.quietGuard} detail={data.quietGuard ? guardText(data.quietGuard) : "Not set up. Edit to send it home whenever it cleans outside the window."} busy={switching} onToggle={toggle} />
          {data.others.map((rule) => (
            <RuleRow key={rule.entityId} label={OTHER_LABEL[rule.acts]} rule={rule} detail={`${rule.name}, written in Home Assistant`} busy={switching} onToggle={toggle} />
          ))}
        </ul>
      )}
      {error ? <p className="home-schedule-error">{error}</p> : null}
      {editing && data?.supported ? (
        <ScheduleDialog
          deviceName={deviceName}
          path={path}
          schedule={data}
          onClose={() => setEditing(false)}
          onSaved={(view) => {
            setEditing(false);
            setChanged(view);
          }}
        />
      ) : null}
    </section>
  );
}

function ScheduleHead({ children }: { children?: ReactNode }) {
  return (
    <header className="home-schedule-head">
      <h5>Cleaning schedule</h5>
      <span className="faint">runs in Home Assistant</span>
      {children}
    </header>
  );
}

const OTHER_LABEL: Record<OtherRule["acts"], string> = { starts: "Also starts it", docks: "Also docks it", other: "Also uses it" };

function RuleRow({ label, rule, detail, busy, onToggle }: { label: string; rule: Rule | null; detail: string; busy: string | null; onToggle: (rule: Rule) => void }) {
  return (
    <li className={`home-rule${rule?.enabled ? " on" : ""}`}>
      {rule ? (
        <button
          className="home-switch"
          role="switch"
          aria-checked={rule.enabled}
          aria-label={`${label}: ${rule.enabled ? "on" : "off"}`}
          title={rule.enabled ? `Switch ${rule.name} off in Home Assistant` : `Switch ${rule.name} on in Home Assistant`}
          disabled={busy !== null}
          onClick={() => onToggle(rule)}
        >
          <span />
        </button>
      ) : (
        <span className="home-switch-gap" aria-hidden="true" />
      )}
      <div className="home-rule-text">
        <strong>{label}</strong>
        <span>{detail}</span>
      </div>
      <span className="mono faint home-rule-last">{rule ? (busy === rule.entityId ? "…" : rule.lastTriggered ? `ran ${formatAgo(rule.lastTriggered)}` : "never ran") : ""}</span>
    </li>
  );
}

function autoStartText(rule: AutoStart): string {
  return `At ${rule.batteryPercent}% battery while docked · ${rule.start}–${rule.end} · ${daysText(rule.days)}`;
}

function guardText(rule: QuietGuard): string {
  return `Docks it if it cleans between ${rule.end} and ${rule.start}`;
}

function daysText(days: Weekday[]): string {
  if (days.length === 7) return "every day";
  if (days.length === 5 && !days.includes("sat") && !days.includes("sun")) return "weekdays";
  if (days.length === 2 && days.includes("sat") && days.includes("sun")) return "weekends";
  return WEEK.filter((w) => days.includes(w.day)).map((w) => w.short).join(", ");
}

function ScheduleDialog({ deviceName, path, schedule, onClose, onSaved }: { deviceName: string; path: string; schedule: Schedule; onClose: () => void; onSaved: (view: Schedule) => void }) {
  const [draft, setDraft] = useState<Draft>(() => ({
    start: schedule.defaults.start,
    end: schedule.defaults.end,
    autoStart: { enabled: schedule.autoStart?.enabled ?? true, batteryPercent: schedule.defaults.batteryPercent, days: schedule.defaults.days },
    quietGuard: { enabled: schedule.quietGuard?.enabled ?? true },
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alsoStarts = !schedule.autoStart && draft.autoStart.enabled ? schedule.others.filter((rule) => rule.acts === "starts") : [];
  const alsoDocks = !schedule.quietGuard && draft.quietGuard.enabled ? schedule.others.filter((rule) => rule.acts === "docks") : [];
  const pastMidnight = draft.end < draft.start && draft.autoStart.days.length < WEEK.length;
  const blocked = !schedule.autoStart && draft.autoStart.enabled ? schedule.autoStartBlocked : null;
  const toggleDay = (day: Weekday) =>
    setDraft((d) => ({ ...d, autoStart: { ...d.autoStart, days: d.autoStart.days.includes(day) ? d.autoStart.days.filter((x) => x !== day) : WEEK.map((w) => w.day).filter((x) => x === day || d.autoStart.days.includes(x)) } }));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      onSaved(await moduleJson<Schedule>("home", path, { method: "PUT", body: draft }));
    } catch (err) {
      setError(errorText(err));
      setSaving(false);
    }
  };

  return (
    <ModuleDialog
      title={`Cleaning schedule · ${deviceName}`}
      onClose={onClose}
      footer={
        <>
          {error ? <span className="mod-dialog-error">{error}</span> : null}
          <button className="btn ghost sm" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary sm" disabled={saving || Boolean(blocked)} onClick={() => void save()}>
            {saving ? "Saving…" : "Save to Home Assistant"}
          </button>
        </>
      }
    >
      <p className="mod-dialog-lede">
        Home Assistant runs this schedule as automations on <code>{schedule.vacuumEntityId}</code>, so it keeps working with GGO closed. Saving rewrites only the automations whose times changed.
      </p>
      {alsoStarts.length || alsoDocks.length ? (
        <Notice tone="info" title="Written in Home Assistant">
          {[...alsoStarts, ...alsoDocks].map((rule) => rule.name).join(" and ")} also {alsoStarts.length ? "starts" : "docks"} this vacuum, in a shape GGO leaves alone. Saving adds GGO&apos;s own rule beside it; switch the other off on the card if it should not run too.
        </Notice>
      ) : null}
      {blocked ? <Notice tone="warn" title="No battery sensor">{blocked}.</Notice> : null}
      <fieldset className="mod-fieldset">
        <legend>Cleaning window</legend>
        <p className="mod-field-hint">The vacuum may clean only inside this window. One that ends before it starts runs past midnight.</p>
        <div className="mod-fields">
          <Field label="From">
            <input className="mod-input" type="time" value={draft.start} onChange={(e) => setDraft({ ...draft, start: e.target.value || draft.start })} />
          </Field>
          <Field label="Until">
            <input className="mod-input" type="time" value={draft.end} onChange={(e) => setDraft({ ...draft, end: e.target.value || draft.end })} />
          </Field>
        </div>
      </fieldset>
      <fieldset className="mod-fieldset">
        <legend>Auto-start</legend>
        <label className="mod-check">
          <input type="checkbox" checked={draft.autoStart.enabled} onChange={(e) => setDraft({ ...draft, autoStart: { ...draft.autoStart, enabled: e.target.checked } })} /> Start cleaning once the battery is full and it is docked
        </label>
        <div className="mod-fields">
          <Field label="Start at battery (%)" hint="Checked when the battery changes, at the window's start and every 30 minutes.">
            <input className="mod-input" type="number" min={20} max={100} value={draft.autoStart.batteryPercent} onChange={(e) => setDraft({ ...draft, autoStart: { ...draft.autoStart, batteryPercent: Number(e.target.value) || 0 } })} />
          </Field>
        </div>
        <span className="mod-field-label">Days</span>
        {pastMidnight ? <span className="mod-field-hint">This window runs past midnight, which Home Assistant can honour only with every day chosen.</span> : null}
        <div className="sv-days" role="group" aria-label="Auto-start days">
          {WEEK.map((w) => (
            <button key={w.day} type="button" className={`sv-day${draft.autoStart.days.includes(w.day) ? " on" : ""}`} aria-pressed={draft.autoStart.days.includes(w.day)} onClick={() => toggleDay(w.day)}>
              {w.short}
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset className="mod-fieldset">
        <legend>Quiet hours</legend>
        <label className="mod-check home-check-wrap">
          <input type="checkbox" checked={draft.quietGuard.enabled} onChange={(e) => setDraft({ ...draft, quietGuard: { enabled: e.target.checked } })} /> Send it back to the dock whenever it cleans between {draft.end} and {draft.start}, whatever started it
        </label>
      </fieldset>
    </ModuleDialog>
  );
}
