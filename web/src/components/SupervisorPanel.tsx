import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store.js";
import type { SupervisorChatTurn, SupervisorEvent, SupervisorSnapshot, Thread } from "../types.js";
import { useCoarseNow } from "../lib/timing.js";
import { since } from "../lib/format.js";

const TARGET_LIMIT = 8;
type DisplaySupervisorTurn = SupervisorChatTurn & { delivery?: "sending" | "failed"; deliveryError?: string };

/** Existing-task conversation plus the watchdog's live audit trail. The two jobs are deliberately
 * separate in the layout: chat is an explicit owner control and remains usable while background
 * watching is off; Run now retains its original full-sweep semantics. */
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
          {enabled ? (manualRunning ? "Running your full sweep..." : running ? "Running a pass..." : "Watching") : "Background off"}
        </span>
        {enabled ? (
          <span className="faint mono supervisor-budget">
            {watching} watching · {budget.checkinsToday}/{budget.maxCheckinsPerDay} check-ins today · ${budget.costUsdToday.toFixed(2)}/{budget.maxCostUsdPerDay.toFixed(2)} today · {budget.tokensToday.toLocaleString()}/{budget.maxTokensPerDay.toLocaleString()} tok
            {lastCheckAt ? ` · last check ${since(now, lastCheckAt)} ago` : ""}
          </span>
        ) : (
          <span className="faint supervisor-budget">No unattended checks. Task chat below is still available; enable watching in Settings → Director Supervisor.</span>
        )}
        {enabled ? (
          <button
            className="btn ghost sm supervisor-run"
            title="Run a full immediate pass over every eligible active or parked task, even if the unattended daily check-in limit is spent"
            onClick={runNow}
            disabled={manualRunning}
          >
            {manualRunning || running ? "Running..." : "Run now"}
          </button>
        ) : null}
      </div>

      {budgetSpent ? (
        <div className="supervisor-budget-note">
          Automated daily check-in budget reached — deterministic checks keep running. Run now remains an operator override and performs a full sweep; genuine provider limits are reported in its result.
        </div>
      ) : null}

      {manualSweep ? <ManualSweepStatus sweep={manualSweep} /> : null}
      <SupervisorChat supervisor={supervisor} now={now} />

      <div className="supervisor-audit-head">
        <div>
          <h3>Watchdog audit</h3>
          <span className="faint">Automatic checks and full-sweep decisions</span>
        </div>
      </div>
      {events.length === 0 ? (
        <div className="supervisor-audit-empty faint">
          {enabled
            ? "Nothing has warranted a watchdog audit row yet."
            : "Background watching is off. Existing chat history stays available above."}
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

function SupervisorChat({ supervisor, now }: { supervisor: SupervisorSnapshot; now: number }) {
  const threadsById = useStore((s) => s.threads);
  const outbound = useStore((s) => s.outboundMessages);
  const sendMessage = useStore((s) => s.sendSupervisorMessage);
  const [message, setMessage] = useState("");
  const [targetIds, setTargetIds] = useState<string[]>([]);
  const [localError, setLocalError] = useState<string | null>(null);
  const conversationRef = useRef<HTMLDivElement>(null);
  // Tolerate one reconnect frame from an older server while a deploy swaps the bundle and backend.
  const serverTurns = supervisor.chat ?? [];
  const turns = useMemo<DisplaySupervisorTurn[]>(
    () => [
      ...serverTurns,
      ...outbound
        .filter((delivery) => delivery.surface === "supervisor")
        .map((delivery) => ({
          id: delivery.id,
          content: delivery.content,
          targets: delivery.targetIds.map((threadId) => ({
            threadId,
            title: threadsById[threadId]?.title ?? `Task #${threadId.slice(0, 8)}`,
            state: threadsById[threadId]?.state ?? null,
          })),
          status: delivery.status === "failed" ? "failed" as const : "pending" as const,
          response: delivery.status === "failed" ? delivery.error ?? "The message was not delivered." : null,
          actionResults: [],
          usedAgent: false,
          costUsd: null,
          totalTokens: null,
          model: null,
          provider: null,
          createdAt: delivery.createdAt,
          updatedAt: delivery.createdAt,
          delivery: delivery.status,
          deliveryError: delivery.error,
        })),
    ].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
    [serverTurns, outbound, threadsById],
  );
  const pending = turns.some((turn) => turn.status === "pending" && turn.delivery !== "failed");
  const threads = useMemo(() => sortTargets(Object.values(threadsById).filter((thread) => !thread.parentId && thread.state !== "closed")), [threadsById]);
  const selected = targetIds.map((id) => threadsById[id]).filter((thread): thread is Thread => !!thread);
  const turnSignature = turns.map((turn) => `${turn.id}:${turn.status}:${turn.delivery ?? "received"}:${turn.actionResults.length}`).join("|");

  useEffect(() => {
    const conversation = conversationRef.current;
    if (conversation) conversation.scrollTop = conversation.scrollHeight;
  }, [turnSignature]);

  useEffect(() => {
    setTargetIds((ids) => ids.filter((id) => !!threadsById[id]));
  }, [threadsById]);

  const submit = () => {
    const text = message.trim();
    if (!text || pending) return;
    setLocalError(null);
    if (!sendMessage(text, targetIds)) {
      setLocalError("The console is reconnecting. Your message was not sent; try again in a moment.");
      return;
    }
    setMessage("");
  };

  return (
    <section className="supervisor-chat" aria-labelledby="supervisor-chat-title">
      <header className="supervisor-chat-head">
        <div>
          <h3 id="supervisor-chat-title">Task chat</h3>
          <p>Ask for status, steer work, pause or resume, delegate review, or escalate a blocker.</p>
        </div>
        <span className="supervisor-existing-only">Existing tasks only</span>
      </header>

      <div ref={conversationRef} className={"supervisor-conversation" + (turns.length ? "" : " empty-chat")} role="log" aria-live="polite" aria-label="Supervisor conversation">
        {turns.length ? (
          turns.map((turn) => <SupervisorTurn key={turn.id} turn={turn} now={now} />)
        ) : (
          <div className="supervisor-chat-empty">
            <span>Supervise without leaving this tab.</span>
            <p>Select tasks for precise routing, or leave targets empty for a bounded board-wide request to active work. New work still belongs in Director.</p>
          </div>
        )}
      </div>

      <div className="supervisor-compose">
        <div className="supervisor-target-row">
          <TaskTargetPicker
            threads={threads}
            selectedIds={targetIds}
            onChange={setTargetIds}
            disabled={pending}
          />
          <span className="supervisor-target-scope faint">
            {selected.length ? `${selected.length} task${selected.length === 1 ? "" : "s"} targeted` : "No target · board-wide request"}
          </span>
        </div>
        {selected.length ? (
          <div className="supervisor-target-chips" aria-label="Selected task targets">
            {selected.map((thread) => (
              <span className="supervisor-target-chip" key={thread.id} title={`${thread.title} · ${thread.id}`}>
                <span>{thread.title}</span>
                <code>#{thread.id.slice(0, 8)}</code>
                <button type="button" onClick={() => setTargetIds((ids) => ids.filter((id) => id !== thread.id))} aria-label={`Remove ${thread.title}`} disabled={pending}>×</button>
              </span>
            ))}
          </div>
        ) : null}
        <div className="supervisor-compose-row">
          <textarea
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                submit();
              }
            }}
            maxLength={4_000}
            rows={3}
            placeholder={selected.length ? "Tell the supervisor what to do with the selected task…" : "Ask what needs attention, or guide active tasks safely…"}
            aria-label="Message the task supervisor"
            disabled={pending}
          />
          <button className="btn primary supervisor-send" type="button" onClick={submit} disabled={!message.trim() || pending}>
            {pending ? "Working…" : "Send"}
          </button>
        </div>
        <div className="supervisor-compose-foot">
          <span className={localError ? "supervisor-local-error" : "faint"}>{localError ?? "Enter to send · Shift+Enter for a new line"}</span>
          <span className="faint">Task creation stays in Director</span>
        </div>
      </div>
    </section>
  );
}

function TaskTargetPicker({
  threads,
  selectedIds,
  onChange,
  disabled,
}: {
  threads: Thread[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const full = selectedIds.length >= TARGET_LIMIT;
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return threads
      .filter((thread) => !q || `${thread.title} ${thread.id} ${thread.state}`.toLowerCase().includes(q))
      .slice(0, 60);
  }, [query, threads]);

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    const onPointer = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggle = (id: string) => {
    if (selectedIds.includes(id)) onChange(selectedIds.filter((item) => item !== id));
    else if (!full) onChange([...selectedIds, id]);
  };

  return (
    <div className="supervisor-target-picker" ref={rootRef}>
      <button
        className="btn ghost sm supervisor-target-trigger"
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="dialog"
        disabled={disabled}
      >
        <TargetIcon />
        {selectedIds.length ? `Targets ${selectedIds.length}/${TARGET_LIMIT}` : "Add task targets"}
      </button>
      {open ? (
        <div className="supervisor-target-menu" role="dialog" aria-label="Choose task targets">
          <div className="supervisor-target-search">
            <SearchIcon />
            <input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Title, state, or task ID" aria-label="Search existing tasks" />
          </div>
          <div className="supervisor-target-options" role="listbox" aria-multiselectable="true">
            {filtered.length ? filtered.map((thread) => {
              const checked = selectedIds.includes(thread.id);
              return (
                <button
                  type="button"
                  role="option"
                  aria-selected={checked}
                  className={"supervisor-target-option" + (checked ? " selected" : "")}
                  key={thread.id}
                  onClick={() => toggle(thread.id)}
                  disabled={!checked && full}
                >
                  <span className="supervisor-target-check" aria-hidden="true">{checked ? "✓" : ""}</span>
                  <span className="supervisor-target-copy">
                    <strong>{thread.title}</strong>
                    <span><code>#{thread.id.slice(0, 8)}</code> · {thread.state}</span>
                  </span>
                </button>
              );
            }) : <div className="supervisor-target-none">No matching existing task.</div>}
          </div>
          <div className="supervisor-target-menu-foot">
            <span>{selectedIds.length}/{TARGET_LIMIT} selected</span>
            <button type="button" className="link" onClick={() => setOpen(false)}>Done</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SupervisorTurn({ turn, now }: { turn: DisplaySupervisorTurn; now: number }) {
  const select = useStore((s) => s.select);
  const setBoardView = useStore((s) => s.setBoardView);
  const threads = useStore((s) => s.threads);
  const openTask = (id: string) => {
    if (!threads[id]) return;
    setBoardView("tasks");
    select(id);
  };
  const statusLabel = turn.delivery === "sending"
    ? "Sending"
    : turn.delivery === "failed"
      ? "Not delivered"
      : turn.status === "needs_input"
        ? "Needs your answer"
        : turn.status === "succeeded"
          ? "Completed"
          : turn.status === "failed"
            ? "Failed"
            : "Working";

  return (
    <article className={"supervisor-turn turn-" + turn.status + (turn.delivery ? ` delivery-${turn.delivery}` : "")}>
      <div className="supervisor-bubble supervisor-owner-bubble">
        <div className="supervisor-bubble-label">You</div>
        {turn.targets.length ? (
          <div className="supervisor-turn-targets">
            {turn.targets.map((target) => (
              <button key={target.threadId} type="button" onClick={() => openTask(target.threadId)} disabled={!threads[target.threadId]} title={target.threadId}>
                {target.title} <code>#{target.threadId.slice(0, 8)}</code>
              </button>
            ))}
          </div>
        ) : <div className="supervisor-turn-targets faint">Board-wide</div>}
        <div className="supervisor-bubble-text">{turn.content}</div>
        <time className="supervisor-bubble-time" title={new Date(turn.createdAt).toLocaleString()}>{since(now, turn.createdAt)} ago</time>
      </div>
      <div className="supervisor-bubble supervisor-agent-bubble">
        <div className="supervisor-bubble-top">
          <span className="supervisor-bubble-label">Supervisor</span>
          <span className={"supervisor-turn-status status-" + turn.status}>{turn.status === "pending" ? <span className="delivery-spinner" aria-hidden="true" /> : null}{statusLabel}</span>
        </div>
        <div className="supervisor-bubble-text">
          {turn.delivery === "sending"
            ? "Waiting for the server to persist this message…"
            : turn.status === "pending"
              ? "Received. Reading the selected task history and checking the safe control path…"
              : turn.response || "No reply was recorded."}
        </div>
        {turn.actionResults.length ? (
          <div className="supervisor-action-results" aria-label="Supervisor action results">
            {turn.actionResults.map((result, index) => (
              <button
                type="button"
                key={`${result.threadId}:${result.action}:${index}`}
                className={result.ok ? "ok" : "failed"}
                onClick={() => openTask(result.threadId)}
                disabled={!threads[result.threadId]}
                title={threads[result.threadId] ? `Open ${result.threadTitle}` : "Task no longer on the board"}
              >
                <span className="supervisor-action-mark" aria-hidden="true">{result.ok ? "✓" : "!"}</span>
                <span>
                  <strong>{actionLabel(result.action)} · {result.threadTitle}</strong>
                  <small>{result.message}</small>
                </span>
              </button>
            ))}
          </div>
        ) : null}
        {turn.usedAgent ? (
          <div className="supervisor-turn-model faint mono">
            {turn.model ?? "agent"}{turn.costUsd ? ` · $${turn.costUsd.toFixed(3)}` : ""}{turn.totalTokens ? ` · ${turn.totalTokens.toLocaleString()} tok` : ""}
          </div>
        ) : null}
      </div>
    </article>
  );
}

function sortTargets(threads: Thread[]): Thread[] {
  const rank: Record<string, number> = {
    planning: 0, researching: 0, implementing: 0, qa: 0, reviewing: 0,
    awaiting_user: 1, awaiting_approval: 1, paused: 1, review: 1, failed: 1,
    queued: 2, done: 3, cancelled: 4,
  };
  return [...threads].sort((a, b) => (rank[a.state] ?? 5) - (rank[b.state] ?? 5) || b.updatedAt - a.updatedAt);
}

function actionLabel(action: SupervisorChatTurn["actionResults"][number]["action"]): string {
  return ({
    status: "Status checked",
    comment: "Note added",
    steer: "Instruction sent",
    pause: "Pause",
    resume: "Resume",
    start_auto_review: "Auto-review",
    escalate: "Escalated",
  } as const)[action];
}

function ManualSweepStatus({ sweep }: { sweep: NonNullable<SupervisorSnapshot["manualSweep"]> }) {
  const progress = `${sweep.examinedCount} of ${sweep.candidateCount}`;
  if (sweep.state === "running") {
    return <div className="supervisor-sweep running" aria-live="polite">Manual full sweep in progress — examined {progress} eligible tasks. The operator override bypasses the unattended daily limit.</div>;
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
  return <div className="supervisor-sweep complete" aria-live="polite">Manual full sweep complete — examined {progress} eligible tasks.{limitations.length ? ` ${limitations.join(" ")}` : ""}</div>;
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
  check: "Routine check — nothing warranted acting",
  action: "Took a bounded action",
  skip: "A trigger fired but nothing warranted acting",
  error: "The pass itself failed to complete",
};

function TargetIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /></svg>;
}

function SearchIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></svg>;
}

function KindIcon({ kind }: { kind: SupervisorEvent["kind"] }) {
  const common = { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  if (kind === "action") return <svg {...common}><path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z" /></svg>;
  if (kind === "error") return <svg {...common}><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>;
  if (kind === "skip") return <svg {...common}><circle cx="12" cy="12" r="10" /><path d="M8 12h8" /></svg>;
  return <svg {...common}><path d="m5 12 5 5L20 7" /></svg>;
}
