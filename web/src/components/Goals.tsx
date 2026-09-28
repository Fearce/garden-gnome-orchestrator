import { useMemo, useState, type CSSProperties } from "react";
import { useStore } from "../store.js";
import {
  DEFAULT_GOAL_BURN_RATE_PCT,
  DEFAULT_GOAL_MAX_CONCURRENT,
  GOAL_EFFORTS,
  MAX_GOAL_BURN_RATE_PCT,
  MAX_GOAL_MAX_CONCURRENT,
  MIN_GOAL_BURN_RATE_PCT,
  type Effort,
  type Goal,
  type GoalStatus,
  type GoalStep,
  type GoalVerdict,
  type ImplementorProvider,
  type ThreadState,
} from "../types.js";
import { WorkspacePath } from "./WorkspacePath.js";
import { PathInput } from "./PathInput.js";
import { taskModelTargets } from "./TaskModelPicker.js";
import { modelLabel, since, stateColor, stateLabel } from "../lib/format.js";
import { useCoarseNow } from "../lib/timing.js";

const STATUS_LABEL: Record<GoalStatus, string> = {
  active: "Active",
  paused: "Paused",
  achieved: "Achieved",
  abandoned: "Abandoned",
};

/** The goal (and which of its steps) a task belongs to, or null for an ordinary task. */
export function goalStepOf(goals: Goal[], threadId: string): { goal: Goal; step: GoalStep } | null {
  for (const goal of goals) {
    const step = goal.steps.find((s) => s.threadId === threadId);
    if (step) return { goal, step };
  }
  return null;
}

const VERDICT_LABEL: Record<GoalVerdict["verdict"], string> = {
  complete: "looks complete",
  continue: "continue",
  wait: "waiting on running steps",
};

/** Active goals first, then paused, then the ended ones; newest first within each. */
const STATUS_ORDER: Record<GoalStatus, number> = { active: 0, paused: 1, achieved: 2, abandoned: 3 };

/** The Goals view: every goal-directed task, what its current step is doing, and create/edit. Rendered
 *  by the Board in place of the task lanes when the header tab is on "Goals". */
export function Goals() {
  const goals = useStore((s) => s.goals);
  const [editing, setEditing] = useState<Goal | "new" | null>(null);
  const sorted = [...goals].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.createdAt - a.createdAt);
  const active = goals.filter((g) => g.status === "active").length;

  return (
    <div className="sched-view goal-view">
      <div className="sched-toolbar">
        <span className="faint mono" style={{ fontSize: 11 }}>
          {goals.length} {goals.length === 1 ? "goal" : "goals"}
          {active ? ` · ${active} active` : ""}
        </span>
        <button className="btn primary sm" onClick={() => setEditing("new")} title="Create a new goal-directed task">
          <PlusIcon /> New goal
        </button>
      </div>

      {sorted.length === 0 ? (
        <div className="empty">
          <div className="big">No goals</div>
          <div className="faint">
            A goal keeps a task working on one objective around the clock until the agent and the director agree it is done.
            Create one with <b>New goal</b>, or ask the director to “make this a goal”.
          </div>
        </div>
      ) : (
        <div className="goal-list">
          {sorted.map((g) => (
            <GoalCard key={g.id} goal={g} onEdit={() => setEditing(g)} />
          ))}
        </div>
      )}

      {editing ? <GoalEditor initial={editing === "new" ? null : editing} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}

function GoalCard({ goal, onEdit }: { goal: Goal; onEdit: () => void }) {
  const now = useCoarseNow();
  const setGoalStatus = useStore((s) => s.setGoalStatus);
  const deleteGoal = useStore((s) => s.deleteGoal);
  const [showSteps, setShowSteps] = useState(false);
  const ended = goal.status === "achieved" || goal.status === "abandoned";
  const running = goal.steps.filter((s) => s.settledAt == null);
  const lastStep = goal.steps.at(-1);

  return (
    <div className={`goal-card gs-${goal.status}`}>
      <div className="sched-card-head">
        <div className="sched-title" title={goal.title}>
          {goal.title}
        </div>
        <span className={`goal-status gs-${goal.status}`}>{STATUS_LABEL[goal.status]}</span>
      </div>

      <WorkspacePath path={goal.workspace} />

      <div className="goal-objective" title={goal.objective}>
        {goal.objective}
      </div>

      {goal.statusReason ? <div className={`goal-reason gs-${goal.status}`}>{goal.statusReason}</div> : null}

      {goal.progress ? (
        <div className="goal-progress">
          <span className="sched-label">Director's progress</span>
          <p>{goal.progress}</p>
        </div>
      ) : null}

      <div className="sched-meta">
        <GoalPinChip goal={goal} />
        <GoalPaceChips goal={goal} />
        <span className="goal-steps-count" title="Step tasks dispatched so far; the goal keeps going until it is done">
          {goal.stepCount} step{goal.stepCount === 1 ? "" : "s"}
        </span>
        {goal.lastVerdict ? (
          <span className="goal-verdict" title={goal.lastVerdict.reason}>
            Director: {VERDICT_LABEL[goal.lastVerdict.verdict]} · {since(now, goal.lastVerdict.at)} ago
          </span>
        ) : null}
      </div>

      {!ended && running.length ? (
        <div className="goal-running">
          {running.map((s) => (
            <CurrentStep key={s.id} step={s} label={goal.maxConcurrent > 1 ? `Running · ${running.length} of ${goal.maxConcurrent}` : "Current step"} />
          ))}
        </div>
      ) : lastStep && !ended ? (
        <CurrentStep step={lastStep} label="Last step" />
      ) : null}

      {goal.steps.length ? (
        <div className="goal-history">
          <button className="sched-lastlink" onClick={() => setShowSteps((v) => !v)} aria-expanded={showSteps}>
            {showSteps ? "Hide steps" : `Show ${goal.stepCount > goal.steps.length ? `last ${goal.steps.length} of ${goal.stepCount}` : goal.steps.length} step${goal.steps.length === 1 ? "" : "s"}`}
          </button>
          {showSteps ? (
            <ol className="goal-step-list">
              {[...goal.steps].reverse().map((s) => (
                <StepRow key={s.id} step={s} />
              ))}
            </ol>
          ) : null}
        </div>
      ) : null}

      <div className="sched-actions">
        {goal.status === "active" ? (
          <button className="btn ghost sm" onClick={() => setGoalStatus(goal.id, "paused")} title="Stop starting new steps; the running step finishes normally">
            Pause
          </button>
        ) : (
          <button className="btn ghost sm" onClick={() => setGoalStatus(goal.id, "active")} title={ended ? "Reopen the goal and plan another step" : "Resume: the director plans the next step now"}>
            {ended ? "Reopen" : "Resume"}
          </button>
        )}
        {!ended ? (
          <button className="btn ghost sm" onClick={onEdit} title="Edit the goal's objective, model pin or pace">
            Edit
          </button>
        ) : null}
        {!ended ? (
          <button
            className="btn ghost sm"
            title="Mark the objective achieved yourself; no further steps start"
            onClick={() => {
              if (window.confirm(`Mark "${goal.title}" achieved? No further steps will start.`)) setGoalStatus(goal.id, "achieved");
            }}
          >
            Mark achieved
          </button>
        ) : null}
        {!ended ? (
          <button
            className="btn ghost sm"
            title="End the goal without achieving it; the running step finishes normally"
            onClick={() => {
              if (window.confirm(`Abandon "${goal.title}"? No further steps will start.`)) setGoalStatus(goal.id, "abandoned");
            }}
          >
            Abandon
          </button>
        ) : null}
        <button
          className="btn danger sm"
          title="Delete the goal and its step history (the tasks it ran stay on the board)"
          onClick={() => {
            if (window.confirm(`Delete goal "${goal.title}"? Its step history is removed; the tasks it ran are unaffected.`)) deleteGoal(goal.id);
          }}
        >
          Delete
        </button>
      </div>
    </div>
  );
}

/** A step in flight (or the last one): what it is, what it runs on, and a jump to its task. */
function CurrentStep({ step, label }: { step: GoalStep; label: string }) {
  const openTask = useOpenTask();
  const state = useStore((s): ThreadState | undefined => (step.threadId ? s.threads[step.threadId]?.state : undefined));
  return (
    <div className="goal-current">
      <span className="sched-label">{label}</span>
      <button className="goal-step-link" disabled={!step.threadId} onClick={() => step.threadId && openTask(step.threadId)} title="Open this step's task">
        <span className="goal-step-seq">#{step.seq}</span> {step.title}
      </button>
      <div className="goal-step-meta">
        <PickChip step={step} />
        {state ? (
          <span className="badge" style={{ "--state-color": stateColor(state) } as CSSProperties}>
            {stateLabel(state)}
          </span>
        ) : null}
      </div>
      {step.rationale ? <p className="goal-rationale">{step.rationale}</p> : null}
    </div>
  );
}

function StepRow({ step }: { step: GoalStep }) {
  const openTask = useOpenTask();
  return (
    <li className="goal-step">
      <button className="goal-step-link" disabled={!step.threadId} onClick={() => step.threadId && openTask(step.threadId)} title={step.rationale || "Open this step's task"}>
        <span className="goal-step-seq">#{step.seq}</span> {step.title}
      </button>
      <div className="goal-step-meta">
        <PickChip step={step} />
        {step.outcome ? (
          <span className="badge" style={{ "--state-color": stateColor(step.outcome) } as CSSProperties}>
            {stateLabel(step.outcome)}
          </span>
        ) : (
          <span className="faint">running</span>
        )}
        {step.agentClaimedComplete ? <span className="goal-claim" title="This step's agent declared the whole objective complete">agent: complete</span> : null}
      </div>
    </li>
  );
}

/** The owner's pin for every step, or what the director is left to choose. */
function GoalPinChip({ goal }: { goal: Goal }) {
  const pinned = goal.provider && goal.model;
  return (
    <>
      <span
        className="sched-model"
        title={pinned ? "Every step runs on this exact model" : "The director picks each step's model from what has capacity"}
      >
        {pinned ? modelLabel(goal.model!) : "Director's model"}
      </span>
      {goal.effort ? (
        <span className={"effort-badge eff-" + goal.effort} title="Every step runs at this effort">
          {goal.effort}
        </span>
      ) : (
        <span className="goal-effort-auto" title="No effort set: the director picks low or medium for each step">
          low–medium
        </span>
      )}
    </>
  );
}

/** How hard the goal may run: its parallel steps and its weekly burn-rate guard. */
function GoalPaceChips({ goal }: { goal: Goal }) {
  return (
    <>
      <span className="sched-model" title="How many step tasks this goal may run at once">
        {goal.maxConcurrent > 1 ? `${goal.maxConcurrent} at once` : "1 at a time"}
      </span>
      <span
        className={"goal-burn" + (goal.burnConservation ? "" : " off")}
        title={
          goal.burnConservation
            ? `No new step starts while every usable pool has spent more of its weekly window than ${goal.burnRatePct}% of an even pace allows`
            : "Burn-rate conservation is off: steps start whenever a model has capacity"
        }
      >
        {goal.burnConservation ? `burn ≤ ${goal.burnRatePct}%` : "burn guard off"}
      </span>
    </>
  );
}

/** The model and effort the director chose for a step ("auto routing" when its pick could not run). */
function PickChip({ step }: { step: GoalStep }) {
  return (
    <>
      <span className="sched-model">{step.model ? modelLabel(step.model) : "auto routing"}</span>
      {step.effort ? <span className={"effort-badge eff-" + step.effort}>{step.effort}</span> : null}
    </>
  );
}

function useOpenTask(): (threadId: string) => void {
  const select = useStore((s) => s.select);
  const setBoardView = useStore((s) => s.setBoardView);
  return (threadId) => {
    setBoardView("tasks");
    select(threadId);
  };
}

/** Create/edit modal. The workspace is fixed once a goal exists: its steps' history lives in that repo. */
function GoalEditor({ initial, onClose }: { initial: Goal | null; onClose: () => void }) {
  const createGoal = useStore((s) => s.createGoal);
  const updateGoal = useStore((s) => s.updateGoal);
  const [title, setTitle] = useState(initial?.title ?? "");
  const [workspace, setWorkspace] = useState(initial?.workspace ?? "");
  const [objective, setObjective] = useState(initial?.objective ?? "");
  const [effort, setEffort] = useState<Effort | "">(initial?.effort ?? "");
  const model = useGoalModelPin(initial);
  const pace = useGoalPace(initial);
  const canSave = !!title.trim() && !!objective.trim() && !!workspace.trim() && model.valid && pace.valid;

  const save = () => {
    if (!canSave) return;
    const pin = { effort: effort || null, provider: model.pinned ? model.provider || null : null, model: model.pinned ? model.model : null };
    const options = { ...pin, ...pace.values };
    const saved = initial
      ? updateGoal(initial.id, { title: title.trim(), objective: objective.trim(), ...options })
      : createGoal({ title: title.trim(), objective: objective.trim(), workspace: workspace.trim(), ...options });
    if (saved) onClose();
  };

  return (
    <div className="scrim" onMouseDown={onClose}>
      <div className="modal sched-modal goal-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="m-head">
          <div className="q-context">{initial ? "Edit goal" : "New goal"}</div>
        </div>
        <div className="m-body sched-form">
          <label className="sched-field">
            <span className="sched-label">Title</span>
            <input value={title} placeholder="e.g. Full offline support" onChange={(e) => setTitle(e.target.value)} autoFocus />
          </label>

          <label className="sched-field">
            <span className="sched-label">Target repo</span>
            {initial ? (
              <WorkspacePath path={initial.workspace} />
            ) : (
              <PathInput value={workspace} onChange={setWorkspace} placeholder="Absolute path, e.g. C:\my-project" title="The repo every step works in" />
            )}
          </label>

          <label className="sched-field">
            <span className="sched-label">Objective</span>
            <textarea
              className="sched-prompt-input goal-objective-input"
              value={objective}
              placeholder="What does done look like? Every step and every verdict is judged against this."
              onChange={(e) => setObjective(e.target.value)}
            />
          </label>

          <div className="sched-row">
            <label className="sched-field sched-field-inline">
              <span className="sched-label">Effort</span>
              <select value={effort} onChange={(e) => setEffort(e.target.value as Effort | "")} title="The implementor effort every step runs at">
                <option value="">Auto (low or medium)</option>
                {GOAL_EFFORTS.map((ef) => (
                  <option key={ef} value={ef}>
                    {ef}
                  </option>
                ))}
              </select>
            </label>
            <label className="sched-field sched-field-inline">
              <span className="sched-label">Provider</span>
              <select
                value={model.provider}
                onChange={(e) => model.chooseProvider(e.target.value as ImplementorProvider | "")}
                title="Pin every step to one backend, or let the director pick per step"
              >
                <option value="">Director picks</option>
                {model.targets.map((t) => (
                  <option key={t.provider} value={t.provider}>
                    {t.label}
                    {t.enabled ? "" : " (disabled)"}
                  </option>
                ))}
              </select>
            </label>
            <label className="sched-field sched-field-inline">
              <span className="sched-label">Model</span>
              <select
                value={model.model}
                disabled={!model.provider}
                onChange={(e) => model.setModel(e.target.value)}
                title={model.provider ? "The exact model every step runs on" : "Choose a provider first"}
              >
                {model.provider ? null : <option value="">—</option>}
                {model.target?.models.map((m) => (
                  <option key={m} value={m}>
                    {modelLabel(m)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="sched-hint">
            {model.pinned
              ? "Every step runs on this exact model; if it has no capacity, the step waits for it."
              : "The director picks each step's model from what has capacity."}{" "}
            {effort
              ? `Every step runs at ${effort} effort.`
              : "With effort on Auto, the director picks low or medium for each step, since a goal spends capacity around the clock."}{" "}
            The goal keeps going until a step's agent and the director both judge the objective complete. It pauses only if three steps in a
            row fail or you cancel a step.
          </div>
          <div className="sched-row goal-pace-row">
            <label className="sched-field sched-field-inline">
              <span className="sched-label">Parallel steps</span>
              <input
                type="number"
                className="sched-num goal-concurrency"
                min={1}
                max={MAX_GOAL_MAX_CONCURRENT}
                value={pace.maxConcurrent}
                onChange={(e) => pace.setMaxConcurrent(e.target.value)}
                title="How many step tasks may run at once"
              />
            </label>
            <label className="sched-field sched-enable goal-burn-toggle">
              <input type="checkbox" checked={pace.burnConservation} onChange={(e) => pace.setBurnConservation(e.target.checked)} />
              <span>Burn-rate conservation</span>
            </label>
            <label className="sched-field sched-field-inline">
              <span className="sched-label">Burn rate</span>
              <span className="sched-inline">
                <input
                  type="number"
                  className="sched-num goal-burn-rate"
                  min={MIN_GOAL_BURN_RATE_PCT}
                  max={MAX_GOAL_BURN_RATE_PCT}
                  step={10}
                  value={pace.burnRatePct}
                  disabled={!pace.burnConservation}
                  onChange={(e) => pace.setBurnRatePct(e.target.value)}
                  title="The weekly pace allowed, in percent of the even pace that spends a window exactly by its reset"
                />
                %
              </span>
            </label>
          </div>
          <div className="sched-hint">
            {pace.values.maxConcurrent > 1
              ? `Up to ${pace.values.maxConcurrent} step tasks run at once in this repo; the director gives each its own share of the work, or waits for a running step.`
              : "One step task at a time."}{" "}
            {pace.burnConservation
              ? `No new step starts while every model the goal could use is spending its weekly window faster than ${pace.values.burnRatePct}% of an even pace; the goal resumes by itself as the pace catches up.`
              : "Burn-rate conservation is off: steps start whenever a model has capacity."}
          </div>
        </div>
        <div className="m-foot sched-foot">
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save} disabled={!canSave}>
            {initial ? "Save changes" : "Create goal"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The editor's provider/model pair. A pin is only ever sent whole: a provider with no model is not saveable. */
function useGoalModelPin(initial: Goal | null) {
  const settings = useStore((s) => s.settings);
  const current = initial?.provider && initial.model ? { provider: initial.provider, model: initial.model } : null;
  // Built with the saved pin so a goal pinned to a since-disabled backend still shows its own pin.
  const targets = useMemo(
    () => taskModelTargets(settings, initial?.provider && initial.model ? { requested: initial.model, provider: initial.provider, model: initial.model, strict: true } : null),
    [settings, initial],
  );
  const [provider, setProvider] = useState<ImplementorProvider | "">(current?.provider ?? "");
  const [model, setModel] = useState(current?.model ?? "");
  const target = targets.find((t) => t.provider === provider);

  const chooseProvider = (next: ImplementorProvider | ""): void => {
    setProvider(next);
    const roster = targets.find((t) => t.provider === next);
    setModel(!next ? "" : roster?.models.includes(model) ? model : (roster?.models[0] ?? ""));
  };

  return { targets, target, provider, model, setModel, chooseProvider, pinned: !!provider && !!model, valid: !provider || !!model };
}

/** The editor's parallel-steps and burn-rate fields, kept as typed text until they are valid numbers. */
function useGoalPace(initial: Goal | null) {
  const [maxConcurrent, setMaxConcurrent] = useState(String(initial?.maxConcurrent ?? DEFAULT_GOAL_MAX_CONCURRENT));
  const [burnConservation, setBurnConservation] = useState(initial?.burnConservation ?? true);
  const [burnRatePct, setBurnRatePct] = useState(String(initial?.burnRatePct ?? DEFAULT_GOAL_BURN_RATE_PCT));
  const slots = Number(maxConcurrent);
  const rate = Number(burnRatePct);
  const slotsValid = Number.isInteger(slots) && slots >= 1 && slots <= MAX_GOAL_MAX_CONCURRENT;
  const rateValid = Number.isInteger(rate) && rate >= MIN_GOAL_BURN_RATE_PCT && rate <= MAX_GOAL_BURN_RATE_PCT;
  return {
    maxConcurrent,
    setMaxConcurrent,
    burnConservation,
    setBurnConservation,
    burnRatePct,
    setBurnRatePct,
    // An off guard keeps its last valid rate, so a half-typed number there cannot block saving.
    valid: slotsValid && (rateValid || !burnConservation),
    values: {
      maxConcurrent: slotsValid ? slots : DEFAULT_GOAL_MAX_CONCURRENT,
      burnConservation,
      burnRatePct: rateValid ? rate : (initial?.burnRatePct ?? DEFAULT_GOAL_BURN_RATE_PCT),
    },
  };
}

function PlusIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ marginRight: 4, verticalAlign: "-2px" } as CSSProperties}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
