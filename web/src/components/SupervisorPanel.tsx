import { useStore } from "../store.js";
import type { SupervisorEvent, SupervisorSnapshot } from "../types.js";
import { useCoarseNow } from "../lib/timing.js";
import { since } from "../lib/format.js";

/** The Supervisor's live audit trail and its explicit operator sweep. Settings owns the on/off
 * switch; this view shows the unattended budget and the manual full-sweep result distinctly. */
export function SupervisorPanel() {
  const supervisor = useStore((s) => s.supervisor);
  const runNow = useStore((s) => s.runSupervisorNow);
  const now = useCoarseNow();
  const { enabled, running, manualSweep, watching, lastCheckAt, budget, events } = supervisor;
  const manualRunning = manualSweep?.state === "running";
  const budgetSpent =
    (budget.maxCheckinsPerDay > 0 && budget.checkinsToday >= budget.maxCheckinsPerDay) ||
    (budget.maxCostUsdPerDay > 0 && budget.costUsdToday >= budget.maxCostUsdPerDay) ||
    (budget.maxTokensPerDay > 0 && budget.tokensToday >= budget.maxTokensPerDay);

  return (
    <div className="supervisor-view">
      <div className="supervisor-toolbar">
        <span className={"supervisor-state" + (enabled ? " on" : " off")}>
          <span className="dot" aria-hidden="true" />
          {enabled ? (manualRunning ? "Running your full sweep..." : running ? "Running a pass..." : "Watching") : "Off"}
        </span>
        {enabled ? (
          <span className="faint mono supervisor-budget">
            {watching} watching · {budget.checkinsToday}/{budget.maxCheckinsPerDay} check-ins today · ${budget.costUsdToday.toFixed(2)}/{budget.maxCostUsdPerDay.toFixed(2)} today · {budget.tokensToday.toLocaleString()}/{budget.maxTokensPerDay.toLocaleString()} tok
            {lastCheckAt ? ` · last check ${since(now, lastCheckAt)} ago` : ""}
          </span>
        ) : (
          <span className="faint supervisor-budget">Off - no background work. Turn it on in Settings -&gt; Director Supervisor.</span>
        )}
        {enabled ? (
          <button
            className="btn ghost sm supervisor-run"
            title="Run a full immediate pass over every eligible active or parked task, even if the unattended daily check-in limit is spent"
            onClick={runNow}
            disabled={manualRunning}
          >
            {manualRunning ? "Running..." : running ? "Running..." : "Run now"}
          </button>
        ) : null}
      </div>

      {budgetSpent ? (
        <div className="supervisor-budget-note">
          Automated daily check-in budget reached - deterministic checks keep running. Run now remains an operator override and performs a full sweep; genuine provider limits are reported in its result.
        </div>
      ) : null}

      {manualSweep ? <ManualSweepStatus sweep={manualSweep} /> : null}

      {events.length === 0 ? (
        <div className="empty">
          <div className="big">{enabled ? "Nothing to report yet" : "The supervisor is off"}</div>
          <div className="faint">
            {enabled
              ? "It watches task state changes and a periodic sweep, and logs a row here the moment something merits a look."
              : "Enable it in Settings to have it watch active tasks for stalls, forgotten hand-offs and QA blockage."}
          </div>
        </div>
      ) : (
        <ul className="supervisor-list">
          {events.map((event) => (
            <SupervisorRow key={event.id} event={event} now={now} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ManualSweepStatus({ sweep }: { sweep: NonNullable<SupervisorSnapshot["manualSweep"]> }) {
  const progress = `${sweep.examinedCount} of ${sweep.candidateCount}`;
  if (sweep.state === "running") {
    return <div className="supervisor-sweep running" aria-live="polite">Manual full sweep in progress - examined {progress} eligible tasks. The operator override bypasses the unattended daily limit.</div>;
  }
  if (sweep.state === "stopped") {
    return <div className="supervisor-sweep stopped">Manual full sweep stopped after examining {progress} eligible tasks.</div>;
  }
  const limitations = [];
  if (sweep.capacityLimitedCount > 0) {
    limitations.push(`${sweep.capacityLimitedCount} check-in${sweep.capacityLimitedCount === 1 ? " was" : "s were"} unavailable because of provider capacity.`);
  }
  if (sweep.errorCount > 0) {
    limitations.push(`${sweep.errorCount} check-in${sweep.errorCount === 1 ? " returned" : "s returned"} an external error; see the audit rows.`);
  }
  return <div className="supervisor-sweep complete" aria-live="polite">Manual full sweep complete - examined {progress} eligible tasks.{limitations.length ? ` ${limitations.join(" ")}` : ""}</div>;
}

function SupervisorRow({ event, now }: { event: SupervisorEvent; now: number }) {
  const select = useStore((s) => s.select);
  const setBoardView = useStore((s) => s.setBoardView);
  const thread = useStore((s) => (event.threadId ? s.threads[event.threadId] : undefined));
  const openTask = () => {
    if (!thread) return;
    setBoardView("tasks");
    select(thread.id);
  };

  return (
    <li className={"supervisor-row k-" + event.kind}>
      <span className="supervisor-kind" title={KIND_LABEL[event.kind]} aria-label={KIND_LABEL[event.kind]}><KindIcon kind={event.kind} /></span>
      <div className="supervisor-main">
        <div className="supervisor-summary">
          {event.threadTitle ? <button className="supervisor-task link" disabled={!thread} onClick={openTask} title={thread ? "Open this task" : "Task no longer on the board"}>{event.threadTitle}</button> : null}
          <span className="supervisor-text">{event.summary}</span>
        </div>
        {event.detail ? <div className="supervisor-detail faint">{event.detail}</div> : null}
        <div className="supervisor-meta faint mono">
          {event.trigger}{event.action ? ` · ${event.action}` : ""}
          {event.usedAgent ? ` · ${event.model ?? "agent"}${event.costUsd ? ` · $${event.costUsd.toFixed(3)}` : ""}${event.totalTokens ? ` · ${event.totalTokens} tok` : ""}` : " · deterministic"}
          {event.notifiedDiscord ? " · notification sent" : ""}{" · "}
          <time title={new Date(event.createdAt).toLocaleString()}>{since(now, event.createdAt)} ago</time>
        </div>
      </div>
    </li>
  );
}

const KIND_LABEL: Record<SupervisorEvent["kind"], string> = {
  check: "Routine check - nothing warranted acting",
  action: "Took a bounded action",
  skip: "A trigger fired but nothing warranted acting",
  error: "The pass itself failed to complete",
};

function KindIcon({ kind }: { kind: SupervisorEvent["kind"] }) {
  const common = { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  if (kind === "action") return <svg {...common}><path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z" /></svg>;
  if (kind === "error") return <svg {...common}><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>;
  if (kind === "skip") return <svg {...common}><circle cx="12" cy="12" r="10" /><path d="M8 12h8" /></svg>;
  return <svg {...common}><path d="m5 12 5 5L20 7" /></svg>;
}
