import { useMemo, useState } from "react";
import { useStore } from "../store.js";
import type { CoworkSession, CoworkSteeringMode } from "../types.js";
import { Elapsed } from "../lib/timing.js";
import { Gnome } from "./Gnome.js";
import type { DragCardProps } from "../lib/dragCard.js";

/** Co-work sessions on the task board.
 *
 *  A Co-work session sits in the task lanes as its own KIND of card: the Co-worker gnome, the Co-work
 *  chip and the chartreuse stripe say "a conversation you lead", not "a pipeline task". Clicking one opens
 *  the conversation as a popup over the board, so pairing never hides the rest of the work. It follows the
 *  board's rules like a task: sorted and dragged in the same list, closed with ✕ into the Closed list.
 *
 *  Beyond that it is DISPLAY-ONLY plus the steering the conversation already offers (queue / inject /
 *  interrupt / stop): a session owns no thread, so there is no pipeline state, no QA, no done and no
 *  findings to show or settle here. Closing is not settling: it only moves the card. */

/** The repo folder a session works in: the last path segment, which is what the owner scans by. Kept
 *  local for the same reason the conversation header keeps its own copy: this is a label, not the
 *  workspace-path affordance. */
function repoLabel(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
}

/** How long ago a settled session was last touched. A live one gets a ticking clock instead; running
 *  `Elapsed` over a zero-length span just prints "0s", which reads as broken rather than as idle. */
function lastTouched(at: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

const STATE_TEXT: Record<CoworkSession["state"], string> = {
  running: "working",
  stopping: "stopping",
  error: "needs input",
  idle: "idle",
};

function isLive(session: CoworkSession): boolean {
  return session.state === "running" || session.state === "stopping";
}

/** Splits the sessions the way the board splits tasks: open ones are cards in the lanes, sorted and
 *  dragged with the tasks; closed ones wait in the Closed list until restored or deleted. */
export function useBoardCoworkSessions(): { open: CoworkSession[]; closed: CoworkSession[] } {
  const sessions = useStore((state) => state.coworkSessions);
  return useMemo(() => {
    const all = Object.values(sessions);
    return { open: all.filter((session) => !session.closedAt), closed: all.filter((session) => !!session.closedAt) };
  }, [sessions]);
}

export function CoworkCard({ session, innerRef, style, dragging, draggableCard, dragProps }: { session: CoworkSession } & DragCardProps) {
  const open = useStore((state) => state.selectCowork);
  const close = useStore((state) => state.setCoworkClosed);
  const selected = useStore((state) => state.selectedCoworkId === session.id);
  const live = isLive(session);
  const [steering, setSteering] = useState(false);
  const clock = live && session.activeTurnStartedAt ? session.activeTurnStartedAt : session.updatedAt;
  return (
    <article
      ref={innerRef}
      className={`cowork-card state-${session.state}${selected ? " sel" : ""}${dragging ? " dragging" : ""}${draggableCard ? " draggable" : ""}`}
      style={style}
      {...dragProps}
    >
      {draggableCard ? (
        <span className="card-grip" aria-hidden="true" title="Drag anywhere on the card to reorder">
          <GripIcon />
        </span>
      ) : null}
      {/* Like a task's ✕: hidden while a turn runs, so live work is never put away mid-turn. */}
      {!live ? (
        <button
          className="card-dismiss"
          title="Close: move to the Closed list (restorable)"
          aria-label="Close Co-work session"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            close(session.id, true);
          }}
        >
          ✕
        </button>
      ) : null}
      <button className="cowork-card-open" onClick={() => open(session.id)} title="Open this conversation">
        <div className="cowork-card-top">
          <Gnome role="coworker" size={15} active={live || session.state === "error"} />
          <strong className="cowork-card-name">{session.name}</strong>
          {live
            ? <Elapsed className="cowork-card-clock mono" startMs={clock} running title="How long this turn has been running" />
            : <span className="cowork-card-clock mono" title="Last activity">{lastTouched(clock)}</span>}
        </div>
        <div className="cowork-card-meta mono" title={session.workspace}>
          <span className="cowork-chip">Co-work</span>
          {repoLabel(session.workspace)}
          <span className="cowork-card-sep">·</span>
          <span className={`cowork-state-dot ${session.state}`} aria-hidden="true" />
          {STATE_TEXT[session.state]}
          {session.model ? <><span className="cowork-card-sep">·</span>{session.model}</> : null}
        </div>
        <p className="cowork-card-snippet">
          {session.lastSnippet
            ? <><span className="cowork-card-who">{session.lastSnippetRole === "user" ? "You" : session.lastSnippetRole === "system" ? "GGO" : "Co-worker"}:</span> {session.lastSnippet}</>
            : <span className="faint">No messages yet.</span>}
        </p>
      </button>
      {live ? (
        steering
          ? <CoworkCardSteer session={session} onDone={() => setSteering(false)} />
          : (
            <div className="cowork-card-actions">
              <button className="btn ghost sm" onClick={() => setSteering(true)}>Steer</button>
              <StopButton sessionId={session.id} />
            </div>
          )
      ) : session.error ? (
        <div className="cowork-card-error" title={session.error}>{session.error}</div>
      ) : null}
      <CoworkCloseError sessionId={session.id} />
    </article>
  );
}

/** A closed session in the board's Closed list, beside closed tasks and with the same two actions. The
 *  difference is honest rather than cosmetic: a closed task auto-removes after 30 days, but a closed
 *  conversation is kept until the owner deletes it, because nothing else holds that context. */
export function ClosedCoworkCard({ session }: { session: CoworkSession }) {
  const open = useStore((state) => state.selectCowork);
  const restore = useStore((state) => state.setCoworkClosed);
  const remove = useStore((state) => state.deleteCowork);
  return (
    <div className="closed-card">
      <button className="closed-card-main cowork-closed-open" onClick={() => open(session.id)} title="Open this conversation">
        <Gnome role="coworker" size={13} active={false} />
        <span className="closed-card-title" title={session.name}>{session.name}</span>
      </button>
      <div className="closed-card-foot">
        <span className="closed-expiry" title="Closed Co-work sessions are kept until you delete them">
          Co-work · {repoLabel(session.workspace)} · {lastTouched(session.updatedAt)}
        </span>
        <span className="closed-actions">
          <button className="btn ghost sm" onClick={() => restore(session.id, false)} title="Move this session back to the board">
            Restore
          </button>
          <button
            className="btn danger sm"
            title="Permanently delete this session and its conversation"
            onClick={() => {
              if (window.confirm(`Permanently delete "${session.name}" and its conversation? This can't be undone.`)) remove(session.id);
            }}
          >
            Delete
          </button>
        </span>
      </div>
      <CoworkCloseError sessionId={session.id} />
    </div>
  );
}

/** Close errors must be visible where the owner clicked, even with the conversation popup shut. */
function CoworkCloseError({ sessionId }: { sessionId: string }) {
  const error = useStore((state) => state.coworkCloseError);
  if (error?.sessionId !== sessionId) return null;
  return <p className="cowork-card-error" style={{ whiteSpace: "normal" }} role="alert">{error.message}</p>;
}

/** The task card's quiet 6-dot grip, so a draggable Co-work card reads exactly like a draggable task. */
function GripIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
      <circle cx="4" cy="2.5" r="1.1" />
      <circle cx="8" cy="2.5" r="1.1" />
      <circle cx="4" cy="6" r="1.1" />
      <circle cx="8" cy="6" r="1.1" />
      <circle cx="4" cy="9.5" r="1.1" />
      <circle cx="8" cy="9.5" r="1.1" />
    </svg>
  );
}

function StopButton({ sessionId }: { sessionId: string }) {
  const stop = useStore((state) => state.stopCowork);
  return <button className="btn ghost sm" onClick={() => stop(sessionId)} title="Stop this work slice">Stop</button>;
}

/** The same three steering modes the conversation offers, so a direction never requires opening it. It
 *  goes through `sendCowork`, exactly as the composer does: one path, one delivery ledger. */
function CoworkCardSteer({ session, onDone }: { session: CoworkSession; onDone: () => void }) {
  const send = useStore((state) => state.sendCowork);
  const [text, setText] = useState("");
  const submit = (mode: CoworkSteeringMode): void => {
    if (!text.trim()) return;
    if (send(session.id, text, mode)) {
      setText("");
      onDone();
    }
  };
  return (
    <div className="cowork-card-steer">
      <textarea
        value={text}
        rows={2}
        autoFocus
        placeholder="Direction for the live turn…"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") onDone();
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submit("append");
          }
        }}
      />
      <div className="cowork-card-actions">
        <button className="btn ghost sm" disabled={!text.trim()} onClick={() => submit("queue")} title="Finish the current safe unit, then apply this">Queue</button>
        <button className="btn primary sm" disabled={!text.trim()} onClick={() => submit("append")} title="Apply this at the next safe point">Inject</button>
        <button className="btn ghost sm" disabled={!text.trim()} onClick={() => submit("interrupt")} title="Stop the current approach and apply this now">Interrupt</button>
        <button className="btn ghost sm" onClick={onDone}>Cancel</button>
      </div>
    </div>
  );
}
