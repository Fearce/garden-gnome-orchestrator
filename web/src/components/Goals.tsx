import { useMemo, useState, type CSSProperties } from "react";
import { useStore } from "../store.js";
import {
  DEFAULT_GOAL_BURN_RATE_PCT,
  DEFAULT_GOAL_MAX_CONCURRENT,
  GOAL_EFFORTS,
  MAX_GOAL_BURN_RATE_PCT,
  MAX_GOAL_MAX_CONCURRENT,
  MAX_GOAL_TOKEN_BUDGET,
  MIN_GOAL_BURN_RATE_PCT,
  type Effort,
  type Goal,
  type GoalHold,
  type GoalStatus,
  type GoalStep,
  type GoalUsage,
  type GoalVerdict,
  type ImplementorProvider,
  type ThreadState,
} from "../types.js";
import { WorkspacePath } from "./WorkspacePath.js";
import { PathInput } from "./PathInput.js";
import { taskModelTargets } from "./TaskModelPicker.js";
import { formatDuration, modelLabel, since, stateColor, stateLabel } from "../lib/format.js";
import { useCoarseNow } from "../lib/timing.js";

const STATUS_LABEL: Record<GoalStatus, string> = {
  active: "Active",
  paused: "Paused",
  blocked: "Blocked",
  budget_limited: "Out of budget",
  achieved: "Achieved",
  abandoned: "Abandoned",
};

const HOLD_LABEL: Record<GoalHold, string> = {
  waiting: "Waiting",
  usage_limited: "Usage limited",
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

/** Active goals first, then the ones the loop stopped for the owner, then paused, then the ended ones;
 *  newest first within each. */
const STATUS_ORDER: Record<GoalStatus, number> = { active: 0, blocked: 1, budget_limited: 1, paused: 2, achieved: 3, abandoned: 4 };

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
  const budgetSpent = goal.tokenBudget != null && goal.usage.tokensUsed >= goal.tokenBudget;

  return (
    <div className={`goal-card gs-${goal.status}`}>
      <div className="sched-card-head">
        <div className="sched-title" title={goal.title}>
          {goal.title}
        </div>
        <span className="goal-status-group">
          {goal.status === "active" && goal.hold ? (
            <span className={`goal-hold gh-${goal.hold}`} title={goal.statusReason ?? undefined}>
              {HOLD_LABEL[goal.hold]}
            </span>
          ) : null}
          <span className={`goal-status gs-${goal.status}`}>{STATUS_LABEL[goal.status]}</span>
        </span>
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

      <GoalUsageLine goal={goal} />

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
          <button
            className="btn ghost sm"
            disabled={budgetSpent}
            onClick={() => setGoalStatus(goal.id, "active")}
            title={
              budgetSpent
                ? "The step tasks have used the token budget: raise or remove it with Edit first"
                : ended
                  ? "Reopen the goal and plan another step"
                  : "Resume: the director checks where the goal stands, then it continues"
            }
          >
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
        <TurnsChip step={step} />
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
        <TurnsChip step={step} />
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
      {goal.maxConcurrent <= 1 ? (
        <span
          className="sched-model"
          title={
            goal.persistentSession
              ? "Each turn continues in the step task's own session; the director is asked only to plan, audit a completion claim, or recover a failed turn"
              : "Every step starts a fresh task, planned by the director"
          }
        >
          {goal.persistentSession ? "one session" : "fresh task per step"}
        </span>
      ) : null}
    </>
  );
}

/** What the goal's step tasks have spent since its metering baseline, against its budget if it has one. */
function GoalUsageLine({ goal }: { goal: Goal }) {
  const { usage, tokenBudget } = goal;
  if (!usage.runs && !usage.runsBeforeBaseline && tokenBudget == null) return null;
  const share = tokenBudget ? Math.min(1, usage.tokensUsed / tokenBudget) : null;
  const notes = usageNotes(usage);
  return (
    <div className="goal-usage" title={usageTooltip(usage, tokenBudget)}>
      <div className="goal-usage-head">
        <span className="sched-label">Step-task runs</span>
        <span className="goal-usage-total">
          {usage.unmeteredRuns ? "≥ " : ""}
          {compactTokens(usage.tokensUsed)}
          {tokenBudget != null ? ` of ${compactTokens(tokenBudget)}` : ""} tokens
        </span>
      </div>
      {share != null ? (
        <div className={"goal-usage-meter" + (share >= 1 ? " spent" : share >= 0.8 ? " near" : "")} role="meter" aria-valuemin={0} aria-valuemax={tokenBudget!} aria-valuenow={usage.tokensUsed} aria-label="Token budget used">
          <span style={{ width: `${(share * 100).toFixed(1)}%` }} />
        </div>
      ) : null}
      <div className="goal-usage-detail">
        {compactTokens(usage.cachedInputTokens)} cached reads apart · {usage.runs} run{usage.runs === 1 ? "" : "s"}
        {usage.agentSeconds ? ` · ${formatDuration(usage.agentSeconds * 1000)} agent time` : ""}
        {notes.length ? ` · ${notes.join(" · ")}` : ""}
      </div>
    </div>
  );
}

function usageNotes(usage: GoalUsage): string[] {
  const notes: string[] = [];
  if (usage.unmeteredRuns) notes.push(`${usage.unmeteredRuns} run${usage.unmeteredRuns === 1 ? "" : "s"} reported no usage`);
  if (usage.runsBeforeBaseline) notes.push(`${usage.runsBeforeBaseline} earlier run${usage.runsBeforeBaseline === 1 ? "" : "s"} not counted`);
  return notes;
}

function usageTooltip(usage: GoalUsage, budget: number | null): string {
  return [
    `Fresh input + output tokens of this goal's step-task runs since ${new Date(usage.since).toLocaleString()}: ${usage.freshInputTokens.toLocaleString()} in, ${usage.outputTokens.toLocaleString()} out.`,
    "Cached context reads are shown apart and are not counted. Director judgements are not counted.",
    budget != null ? "The budget is checked between turns from the finished runs, so a running turn may exceed it." : "",
    usage.unmeteredRuns ? "Some runs reported no usage, so the total is a lower bound." : "",
    usage.runsBeforeBaseline ? "Runs from before the goal's metering baseline used an older meter and are not totalled." : "",
  ].filter(Boolean).join("\n");
}

/** How many goal turns a step task has run in its own session; nothing for a single turn. */
function TurnsChip({ step }: { step: GoalStep }) {
  return step.turns > 1 ? (
    <span className="goal-turns" title="Goal turns this task has run in its own session">
      {step.turns} turns
    </span>
  ) : null;
}

/** Mirrors the server's compactTokens: "950", "1.2k", "34k", "1.5M", "12M". */
function compactTokens(n: number): string {
  const trim = (s: string) => s.replace(/\.0$/, "");
  if (n >= 1_000_000) return `${trim((n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1))}M`;
  if (n >= 1_000) return `${trim((n / 1_000).toFixed(n >= 10_000 ? 0 : 1))}k`;
  return String(n);
}

/** A budget as the owner typed it: digits, optionally with a k or M suffix. Null when blank, NaN when unreadable. */
function parseTokenBudget(text: string): number | null {
  const t = text.trim().replace(/[,_\s]/g, "");
  if (!t) return null;
  const m = /^(\d+(?:\.\d+)?)([kKmM]?)$/.exec(t);
  if (!m) return Number.NaN;
  const scale = m[2] === "" ? 1 : m[2]!.toLowerCase() === "k" ? 1_000 : 1_000_000;
  return Math.round(Number(m[1]) * scale);
}

/** A saved budget back in the editor's short form, exact: 5000000 → "5M", 250000 → "250k". */
function budgetText(n: number | null | undefined): string {
  if (n == null) return "";
  if (n % 1_000_000 === 0) return `${n / 1_000_000}M`;
  if (n % 1_000 === 0) return `${n / 1_000}k`;
  return String(n);
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
  const budgetOnGrok = pace.values.tokenBudget != null && model.pinned && model.provider === "grok";
  const canSave = !!title.trim() && !!objective.trim() && !!workspace.trim() && model.valid && pace.valid && !budgetOnGrok;

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
            The goal keeps going until a step's agent and the director both judge the objective complete. It pauses if three steps in a row
            fail or you cancel a step, and stops as blocked after a turn that makes no tool call, turns that do no new work, or the same
            blocker three turns running.
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
              : pace.persistentSession
                ? "One step task at a time, continued turn after turn in its own session; the director is asked only to plan, to audit a completion claim, or after a turn that did not finish cleanly."
                : "One step task at a time, each a fresh task the director plans."}{" "}
            {pace.burnConservation
              ? `No new step starts while every model the goal could use is spending its weekly window faster than ${pace.values.burnRatePct}% of an even pace; the goal resumes by itself as the pace catches up.`
              : "Burn-rate conservation is off: steps start whenever a model has capacity."}
          </div>
          <div className="sched-row goal-pace-row">
            <label className="sched-field sched-enable goal-session-toggle" title={pace.values.maxConcurrent > 1 ? "Parallel steps always run as separate tasks" : undefined}>
              <input
                type="checkbox"
                checked={pace.persistentSession && pace.values.maxConcurrent <= 1}
                disabled={pace.values.maxConcurrent > 1}
                onChange={(e) => pace.setPersistentSession(e.target.checked)}
              />
              <span>Continue in one session</span>
            </label>
            <label className="sched-field sched-field-inline">
              <span className="sched-label">Token budget</span>
              <input
                className={"sched-num goal-token-budget" + (pace.budgetValid ? "" : " invalid")}
                value={pace.tokenBudget}
                placeholder="None"
                inputMode="decimal"
                aria-invalid={!pace.budgetValid || budgetOnGrok}
                onChange={(e) => pace.setTokenBudget(e.target.value)}
                title="Fresh input + output tokens the step tasks may spend, e.g. 20M or 500k; blank for no budget. Checked between turns, so a running turn may exceed it"
              />
            </label>
          </div>
          <div className={"sched-hint" + (budgetOnGrok || !pace.budgetValid ? " goal-hint-error" : "")}>
            {!pace.budgetValid
              ? "Write the budget as a whole number of tokens, optionally with k or M (e.g. 20M), or leave it blank."
              : budgetOnGrok
                ? "Grok reports no token usage, so a goal with a token budget cannot be pinned to it. Pick another model or clear the budget."
                : pace.values.tokenBudget != null
                  ? `Checked between turns: once its step tasks have spent ${compactTokens(pace.values.tokenBudget)} fresh input + output tokens, the goal stops as out of budget. A running turn may exceed it. Cached context reads and director judgements are not counted.`
                  : "No token budget: the goal is bounded by the burn-rate guard, its stop rules and your Pause."}
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

/** The editor's parallel-steps, burn-rate, session and budget fields, kept as typed text until they are valid. */
function useGoalPace(initial: Goal | null) {
  const [maxConcurrent, setMaxConcurrent] = useState(String(initial?.maxConcurrent ?? DEFAULT_GOAL_MAX_CONCURRENT));
  const [burnConservation, setBurnConservation] = useState(initial?.burnConservation ?? true);
  const [burnRatePct, setBurnRatePct] = useState(String(initial?.burnRatePct ?? DEFAULT_GOAL_BURN_RATE_PCT));
  const [persistentSession, setPersistentSession] = useState(initial?.persistentSession ?? true);
  const [tokenBudget, setTokenBudget] = useState(budgetText(initial?.tokenBudget));
  const slots = Number(maxConcurrent);
  const rate = Number(burnRatePct);
  const budget = parseTokenBudget(tokenBudget);
  const slotsValid = Number.isInteger(slots) && slots >= 1 && slots <= MAX_GOAL_MAX_CONCURRENT;
  const rateValid = Number.isInteger(rate) && rate >= MIN_GOAL_BURN_RATE_PCT && rate <= MAX_GOAL_BURN_RATE_PCT;
  const budgetValid = budget == null || (Number.isInteger(budget) && budget >= 1 && budget <= MAX_GOAL_TOKEN_BUDGET);
  return {
    maxConcurrent,
    setMaxConcurrent,
    burnConservation,
    setBurnConservation,
    burnRatePct,
    setBurnRatePct,
    persistentSession,
    setPersistentSession,
    tokenBudget,
    setTokenBudget,
    budgetValid,
    // An off guard keeps its last valid rate, so a half-typed number there cannot block saving.
    valid: slotsValid && (rateValid || !burnConservation) && budgetValid,
    values: {
      maxConcurrent: slotsValid ? slots : DEFAULT_GOAL_MAX_CONCURRENT,
      burnConservation,
      burnRatePct: rateValid ? rate : (initial?.burnRatePct ?? DEFAULT_GOAL_BURN_RATE_PCT),
      persistentSession,
      tokenBudget: budgetValid ? budget : (initial?.tokenBudget ?? null),
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
