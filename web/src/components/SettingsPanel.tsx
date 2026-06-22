import { useEffect, type ReactNode } from "react";
import { useStore } from "../store.js";

/** The gear-icon panel: everything that isn't a per-task agent toggle (those live in the topbar).
 *  A light popover anchored under the topbar with a click-anywhere-outside backdrop to dismiss. */
export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const showCompleted = useStore((s) => s.showCompleted);
  const setShowCompleted = useStore((s) => s.setShowCompleted);
  const verbosity = useStore((s) => s.verbosity);
  const setVerbosity = useStore((s) => s.setVerbosity);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="settings-scrim" onClick={onClose}>
      <div className="settings-pop" role="dialog" aria-label="Settings" onClick={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <h3>Settings</h3>
          <button className="settings-x" aria-label="Close settings" onClick={onClose}>
            ✕
          </button>
        </div>

        <Group label="Pipeline">
          <ToggleRow
            label="Auto-push"
            hint="On: completed tasks commit AND push. Off: implementor commits locally only — you push manually."
            on={settings.autoPush}
            onChange={(v) => setSettings({ autoPush: v })}
          />
          <NumberRow
            label="Max QA rounds"
            hint="How many implementor↔QA fix-rounds before a task settles to review."
            value={settings.maxQaRounds}
            min={1}
            max={12}
            onChange={(v) => setSettings({ maxQaRounds: v })}
          />
          <NumberRow
            label="Max concurrent tasks"
            hint="Pipelines allowed to run at once. Dispatches beyond this wait in a queued lane and start as slots free."
            value={settings.maxConcurrent}
            min={1}
            max={20}
            onChange={(v) => setSettings({ maxConcurrent: v })}
          />
        </Group>

        <Group label="Board">
          <ToggleRow
            label="Show completed tasks"
            hint="Off: done & cancelled tasks are hidden from the board (still in the DB / Closed list)."
            on={showCompleted}
            onChange={setShowCompleted}
          />
          <SegmentRow
            label="Task output"
            hint="Compact: cards show only their state. Full: cards show the agent's latest streaming line."
            value={verbosity}
            options={[
              { value: "compact", label: "Compact" },
              { value: "full", label: "Full" },
            ]}
            onChange={setVerbosity}
          />
        </Group>

        <p className="settings-note">
          Agent toggles (planner · researcher · QA) live in the top bar — flip them per task before dispatching.
        </p>
      </div>
    </div>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="settings-group">
      <div className="settings-group-label">{label}</div>
      {children}
    </div>
  );
}

function Row({ label, hint, control }: { label: string; hint: string; control: ReactNode }) {
  return (
    <div className="settings-row">
      <div className="settings-row-text">
        <div className="settings-row-label">{label}</div>
        <div className="settings-row-hint">{hint}</div>
      </div>
      {control}
    </div>
  );
}

function ToggleRow({ label, hint, on, onChange }: { label: string; hint: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <Row
      label={label}
      hint={hint}
      control={
        <button
          className={"switch" + (on ? " on" : "")}
          role="switch"
          aria-checked={on}
          aria-label={label}
          onClick={() => onChange(!on)}
        >
          <span className="switch-knob" />
        </button>
      }
    />
  );
}

function NumberRow({
  label,
  hint,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  const clamp = (n: number) => Math.min(max, Math.max(min, n));
  return (
    <Row
      label={label}
      hint={hint}
      control={
        <div className="stepper">
          <button aria-label={`Decrease ${label}`} disabled={value <= min} onClick={() => onChange(clamp(value - 1))}>
            −
          </button>
          <span className="stepper-val mono">{value}</span>
          <button aria-label={`Increase ${label}`} disabled={value >= max} onClick={() => onChange(clamp(value + 1))}>
            +
          </button>
        </div>
      }
    />
  );
}

function SegmentRow<T extends string>({
  label,
  hint,
  value,
  options,
  onChange,
}: {
  label: string;
  hint: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <Row
      label={label}
      hint={hint}
      control={
        <div className="segment">
          {options.map((o) => (
            <button key={o.value} className={value === o.value ? "on" : ""} onClick={() => onChange(o.value)}>
              {o.label}
            </button>
          ))}
        </div>
      }
    />
  );
}
