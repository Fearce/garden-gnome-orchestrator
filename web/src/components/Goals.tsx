import { useState, type CSSProperties } from "react";
import { useStore } from "../store.js";
import { DEFAULT_GOAL_MAX_STEPS, MAX_GOAL_MAX_STEPS, type Goal, type GoalStatus, type GoalStep, type ThreadState } from "../types.js";
import { WorkspacePath } from "./WorkspacePath.js";
import { PathInput } from "./PathInput.js";
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
  const current = useStore((s) => (goal.currentThreadId ? s.threads[goal.currentThreadId] : undefined));
  const [showSteps, setShowSteps] = useState(false);
  const ended = goal.status === "achieved" || goal.status === "abandoned";
  const currentStep = goal.steps.at(-1);

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
        <span className="goal-steps-count" title={`The goal pauses after ${goal.maxSteps} step tasks`}>
          Step {goal.stepCount} of {goal.maxSteps}
        </span>
        {goal.lastVerdict ? (
          <span className="goal-verdict" title={goal.lastVerdict.reason}>
            Director: {goal.lastVerdict.verdict === "complete" ? "looks complete" : "continue"} · {since(now, goal.lastVerdict.at)} ago
          </span>
        ) : null}
      </div>

      {currentStep && !ended ? <CurrentStep step={currentStep} state={current?.state} /> : null}

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
          <button className="btn ghost sm" onClick={onEdit} title="Edit the goal's title, objective or step budget">
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

/** The step in flight: what it is, what it runs on, and a jump to its task. */
function CurrentStep({ step, state }: { step: GoalStep; state: ThreadState | undefined }) {
  const openTask = useOpenTask();
  const live = step.outcome == null;
  return (
    <div className="goal-current">
      <span className="sched-label">{live ? "Current step" : "Last step"}</span>
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
  const [maxSteps, setMaxSteps] = useState(String(initial?.maxSteps ?? DEFAULT_GOAL_MAX_STEPS));
  const budget = Number(maxSteps);
  const budgetValid = Number.isInteger(budget) && budget >= 1 && budget <= MAX_GOAL_MAX_STEPS;
  const canSave = !!title.trim() && !!objective.trim() && !!workspace.trim() && budgetValid;

  const save = () => {
    if (!canSave) return;
    const saved = initial
      ? updateGoal(initial.id, { title: title.trim(), objective: objective.trim(), maxSteps: budget })
      : createGoal({ title: title.trim(), objective: objective.trim(), workspace: workspace.trim(), maxSteps: budget });
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

          <label className="sched-field sched-field-inline">
            <span className="sched-label">Step budget</span>
            <input
              type="number"
              className="sched-num goal-budget"
              min={1}
              max={MAX_GOAL_MAX_STEPS}
              value={maxSteps}
              onChange={(e) => setMaxSteps(e.target.value)}
            />
          </label>
          <div className="sched-hint">
            The director plans each step and picks its model and effort from what has capacity. The goal ends when a step's agent and the
            director both judge the objective complete, and pauses if it uses its step budget, three steps in a row fail, or you cancel a step.
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

function PlusIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ marginRight: 4, verticalAlign: "-2px" } as CSSProperties}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
