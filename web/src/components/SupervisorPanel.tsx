import { useStore } from "../store.js";
import type { SupervisorEvent } from "../types.js";
import { useCoarseNow } from "../lib/timing.js";
import { since } from "../lib/format.js";

/**
 * The Director Supervisor's transparency panel: is it on, is a pass running right now, today's bounded
 * check-in budget, and the recent audit trail — every check/skip/action it took and why. Rendered by the
 * Board in place of the task lanes when the header toggle is on "Supervisor" (mirrors OperatorNotes).
 * The on/off toggle itself lives in Settings (one source of truth for the flag); this panel is read-only
 * plus a "run now" trigger for an immediate pass.
 */
export function SupervisorPanel() {
  const supervisor = useStore((s) => s.supervisor);
  const runNow = useStore((s) => s.runSupervisorNow);
  const now = useCoarseNow();
  const { enabled, running, watching, lastCheckAt, budget, events } = supervisor;
  const budgetSpent =
    (budget.maxCheckinsPerDay > 0 && budget.checkinsToday >= budget.maxCheckinsPerDay) ||
    (budget.maxCostUsdPerDay > 0 && budget.costUsdToday >= budget.maxCostUsdPerDay) ||
    (budget.maxTokensPerDay > 0 && budget.tokensToday >= budget.maxTokensPerDay);

  return (
    <div className="supervisor-view">
      <div className="supervisor-toolbar">
        <span className={"supervisor-state" + (enabled ? " on" : " off")}>
          <span className="dot" aria-hidden="true" />
          {enabled ? (running ? "Running a pass…" : "Watching") : "Off"}
        </span>
        {enabled ? (
          <span className="faint mono" style={{ fontSize: 11 }}>
            {watching} watching · {budget.checkinsToday}/{budget.maxCheckinsPerDay} check-ins today · $
            {budget.costUsdToday.toFixed(2)}/{budget.maxCostUsdPerDay.toFixed(2)} today · {budget.tokensToday.toLocaleString()}/
            {budget.maxTokensPerDay.toLocaleString()} tok
            {lastCheckAt ? ` · last check ${since(now, lastCheckAt)} ago` : ""}
          </span>
        ) : (
          <span className="faint" style={{ fontSize: 11 }}>
            Off — no background work. Turn it on in Settings → Director Supervisor.
          </span>
        )}
        {enabled ? (
          <button className="btn ghost sm" title="Run one immediate pass over every active/parked task" onClick={runNow} disabled={running}>
            {running ? "Running…" : "Run now"}
          </button>
        ) : null}
      </div>

      {budgetSpent ? (
        <div className="supervisor-budget-note">Daily check-in budget reached — deterministic checks keep running; the agent check-in resumes tomorrow.</div>
      ) : null}

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
          {events.map((e) => (
            <SupervisorRow key={e.id} event={e} now={now} />
          ))}
        </ul>
      )}
    </div>
  );
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
      <span className="supervisor-kind" title={KIND_LABEL[event.kind]} aria-label={KIND_LABEL[event.kind]}>
        <KindIcon kind={event.kind} />
      </span>
      <div className="supervisor-main">
        <div className="supervisor-summary">
          {event.threadTitle ? (
            <button className="supervisor-task link" disabled={!thread} onClick={openTask} title={thread ? "Open this task" : "Task no longer on the board"}>
              {event.threadTitle}
            </button>
          ) : null}
          <span className="supervisor-text">{event.summary}</span>
        </div>
        {event.detail ? <div className="supervisor-detail faint">{event.detail}</div> : null}
        <div className="supervisor-meta faint mono">
          {event.trigger}
          {event.action ? ` · ${event.action}` : ""}
          {event.usedAgent ? ` · ${event.model ?? "agent"}${event.costUsd ? ` · $${event.costUsd.toFixed(3)}` : ""}${event.totalTokens ? ` · ${event.totalTokens} tok` : ""}` : " · deterministic"}
          {event.notifiedDiscord ? " · 🔔 sent" : ""}
          {" · "}
          <time title={new Date(event.createdAt).toLocaleString()}>{since(now, event.createdAt)} ago</time>
        </div>
      </div>
    </li>
  );
}

const KIND_LABEL: Record<SupervisorEvent["kind"], string> = {
  check: "Routine check — nothing warranted acting",
  action: "Took a bounded action",
  skip: "A trigger fired but nothing warranted acting",
  error: "The pass itself failed to complete",
};

function KindIcon({ kind }: { kind: SupervisorEvent["kind"] }) {
  const common = { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  if (kind === "action") {
    return (
      <svg {...common}>
        <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z" />
      </svg>
    );
  }
  if (kind === "error") {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
    );
  }
  if (kind === "skip") {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="10" />
        <path d="M8 12h8" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="m5 12 5 5L20 7" />
    </svg>
  );
}
