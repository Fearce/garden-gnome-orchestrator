import { useMemo, useState } from "react";
import { useStore } from "../store.js";
import type { CoworkSession, CoworkSteeringMode } from "../types.js";
import { Elapsed } from "../lib/timing.js";
import { Gnome } from "./Gnome.js";

/** Co-work sessions on the task board.
 *
 *  A Co-work session sits in the task lanes as its own KIND of card: the Co-worker gnome, the Co-work
 *  chip and the chartreuse stripe say "a conversation you lead", not "a pipeline task". Clicking one opens
 *  the conversation as a popup over the board, so pairing never hides the rest of the work.
 *
 *  They are still DISPLAY-ONLY plus the steering the conversation already offers (queue / inject /
 *  interrupt / stop): a session owns no thread, so there is no pipeline state, no QA, no done and no
 *  findings to show or settle here. */

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

/** The sessions worth a card in the lanes: everything live or in error, plus anything touched recently
 *  enough to still be the thing the owner is doing. The rest are one click away under "Earlier". */
const RECENT_MS = 6 * 60 * 60_000;

function isLive(session: CoworkSession): boolean {
  return session.state === "running" || session.state === "stopping";
}

/** Splits every session into the ones that get a card in the lanes (live first, then newest) and the
 *  older ones folded below the board. The Co-work tab is gone, so nothing may fall off the board. */
export function useBoardCoworkSessions(): { current: CoworkSession[]; earlier: CoworkSession[] } {
  const sessions = useStore((state) => state.coworkSessions);
  return useMemo(() => {
    const cutoff = Date.now() - RECENT_MS;
    const byRecency = Object.values(sessions)
      .sort((a, b) => Number(isLive(b)) - Number(isLive(a)) || b.updatedAt - a.updatedAt);
    const isCurrent = (session: CoworkSession) => isLive(session) || session.state === "error" || session.updatedAt >= cutoff;
    return { current: byRecency.filter(isCurrent), earlier: byRecency.filter((session) => !isCurrent(session)) };
  }, [sessions]);
}

export function CoworkCard({ session }: { session: CoworkSession }) {
  const open = useStore((state) => state.selectCowork);
  const selected = useStore((state) => state.selectedCoworkId === session.id);
  const live = isLive(session);
  const [steering, setSteering] = useState(false);
  const clock = live && session.activeTurnStartedAt ? session.activeTurnStartedAt : session.updatedAt;
  return (
    <article className={`cowork-card state-${session.state}${selected ? " sel" : ""}`}>
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
    </article>
  );
}

/** Older sessions, folded under the board the way closed tasks are. Nothing here is live; a row opens the
 *  same popup a card does. */
export function EarlierCoworkSection({ sessions }: { sessions: CoworkSession[] }) {
  const open = useStore((state) => state.selectCowork);
  const [expanded, setExpanded] = useState(false);
  if (!sessions.length) return null;
  return (
    <section className="closed-section cowork-earlier">
      <button className="closed-toggle" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
        <span className={"closed-caret" + (expanded ? " open" : "")} aria-hidden="true">›</span>
        Earlier Co-work · {sessions.length}
      </button>
      {expanded ? (
        <div className="closed-list">
          {sessions.map((session) => (
            <button key={session.id} className="closed-card cowork-earlier-row" onClick={() => open(session.id)} title="Open this conversation">
              <span className="closed-card-main">
                <Gnome role="coworker" size={13} active={false} />
                <span className="closed-card-title">{session.name}</span>
              </span>
              <span className="closed-expiry">{repoLabel(session.workspace)} · {lastTouched(session.updatedAt)}</span>
            </button>
          ))}
        </div>
      ) : null}
    </section>
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
