import { useEffect, useRef, useState } from "react";
import { useStore } from "../store.js";
import type { OrchestratorSettings, Thread, ToggleableRole } from "../types.js";

type Choice = boolean | null;

const ROLES: { role: ToggleableRole; label: string }[] = [
  { role: "planner", label: "Planner" },
  { role: "researcher", label: "Researcher" },
  { role: "qa", label: "QA" },
  { role: "selfImprove", label: "Self-improvement" },
];

const CHOICES: { value: Choice; label: string }[] = [
  { value: null, label: "Auto" },
  { value: true, label: "On" },
  { value: false, label: "Off" },
];

/** What Auto means for this role right now, so the owner can see what they would be overriding. */
function autoMeaning(role: ToggleableRole, settings: OrchestratorSettings): string {
  switch (role) {
    case "planner":
      return settings.plannerEnabled ? "Auto: the task's route decides" : "Auto: off in Settings";
    case "researcher":
      return settings.researcherEnabled ? "Auto: runs when the planner asks for research" : "Auto: off in Settings";
    case "qa":
      return settings.qaEnabled ? "Auto: the task's route decides" : "Auto: off in Settings";
    case "selfImprove":
      return settings.selfImproveEnabled ? "Auto: on in Settings" : "Auto: off in Settings";
  }
}

function AgentsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 6h10M4 12h6M4 18h10" />
      <circle cx="17" cy="6" r="2" />
      <circle cx="13" cy="12" r="2" />
      <circle cx="17" cy="18" r="2" />
    </svg>
  );
}

/** Per-task switches for the optional agents. Each click applies immediately; the server posts a notice
 *  in the task feed saying whether it took effect now or only on a retry. */
export function TaskAgentsPicker({ thread }: { thread: Thread }) {
  const settings = useStore((state) => state.settings);
  const setTaskRole = useStore((state) => state.setTaskRole);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<Partial<Record<ToggleableRole, Choice>>>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const toggles = thread.roleToggles ?? {};
  const overridden = ROLES.filter(({ role }) => toggles[role] !== undefined);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const choose = async (role: ToggleableRole, value: Choice) => {
    if (pending[role] !== undefined || (toggles[role] ?? null) === value) return;
    setPending((current) => ({ ...current, [role]: value }));
    await setTaskRole(thread.id, role, value);
    setPending(({ [role]: _done, ...rest }) => rest);
  };

  const summary = overridden.length
    ? overridden.map(({ role, label }) => `${label} ${toggles[role] ? "on" : "off"}`).join(" · ")
    : "All agents on Auto";

  return (
    <div className="task-model-picker task-agents-picker" ref={rootRef}>
      <button
        type="button"
        className={`task-model-trigger${overridden.length ? " pinned" : ""}`}
        aria-label="Choose which agents run on this task"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`Task agents: ${summary}. Click to switch planner, researcher, QA or self-improvement for this task.`}
        onClick={() => setOpen((value) => !value)}
      >
        <AgentsIcon />
        <span className="task-model-dot" aria-hidden="true" />
      </button>
      {open ? (
        <div className="task-model-popover task-agents-popover" role="dialog" aria-label="Task agents">
          <div className="task-model-head">
            <div>
              <strong>Task agents</strong>
              <span>{summary}</span>
            </div>
            <button type="button" onClick={() => setOpen(false)} aria-label="Close task agents">×</button>
          </div>
          <div className="task-agents-rows">
            {ROLES.map(({ role, label }) => {
              const shown = pending[role] !== undefined ? pending[role]! : toggles[role] ?? null;
              return (
                <div className="task-agents-row" key={role} data-role={role}>
                  <div className="task-agents-label">
                    <span>{label}</span>
                    <small>{autoMeaning(role, settings)}</small>
                  </div>
                  <div className="segment" role="radiogroup" aria-label={`${label} for this task`}>
                    {CHOICES.map((choice) => (
                      <button
                        key={choice.label}
                        type="button"
                        role="radio"
                        aria-checked={shown === choice.value}
                        className={shown === choice.value ? "on" : undefined}
                        disabled={pending[role] !== undefined}
                        onClick={() => void choose(role, choice.value)}
                      >
                        {choice.label}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          <p className="task-model-warning">
            Switching an agent off stops it if it is running. A stage the task already passed changes only if you retry it.
          </p>
        </div>
      ) : null}
    </div>
  );
}
