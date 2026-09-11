import { useMemo, useState } from "react";
import { useStore } from "../store.js";
import type { CoworkSession, CoworkSteeringMode } from "../types.js";
import { Elapsed } from "../lib/timing.js";

/** Co-work sessions on the task board.
 *
 *  A live pairing session is the one kind of active work the board could not see: it owns no thread, so
 *  the owner had to switch views to find out whether their Co-worker was still going. These cards fix
 *  exactly that and nothing else. They are DISPLAY-ONLY plus the steering the conversation already
 *  offers (queue / inject / interrupt / stop): no pipeline state, no QA, no done, no findings. A click
 *  opens the conversation, which is still where the work happens. */

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

/** The cards worth board space: everything live, plus anything touched recently enough to still be the
 *  thing the owner is doing. A months-old session belongs in the Co-work list, not on the board. */
const RECENT_MS = 6 * 60 * 60_000;

function isLive(session: CoworkSession): boolean {
  return session.state === "running" || session.state === "stopping";
}

export function CoworkBoardCards() {
  const sessions = useStore((state) => state.coworkSessions);
  const setBoardView = useStore((state) => state.setBoardView);
  const selectCowork = useStore((state) => state.selectCowork);

  const shown = useMemo(() => {
    const cutoff = Date.now() - RECENT_MS;
    return Object.values(sessions)
      .filter((session) => isLive(session) || session.state === "error" || session.updatedAt >= cutoff)
      .sort((a, b) => Number(isLive(b)) - Number(isLive(a)) || b.updatedAt - a.updatedAt);
  }, [sessions]);

  if (!shown.length) return null;
  const live = shown.filter(isLive).length;
  const open = (session: CoworkSession): void => {
    selectCowork(session.id);
    setBoardView("cowork");
  };

  return (
    <section className="cowork-board" aria-label="Co-work sessions">
      <div className="cowork-board-head">
        <h3>Co-work</h3>
        <span className="faint mono">{live ? `${live} live · ` : ""}{shown.length} session{shown.length === 1 ? "" : "s"}</span>
      </div>
      <div className="cowork-board-lanes">
        {shown.map((session) => <CoworkCard key={session.id} session={session} onOpen={() => open(session)} />)}
      </div>
    </section>
  );
}

function CoworkCard({ session, onOpen }: { session: CoworkSession; onOpen: () => void }) {
  const live = isLive(session);
  const [steering, setSteering] = useState(false);
  const clock = live && session.activeTurnStartedAt ? session.activeTurnStartedAt : session.updatedAt;
  return (
    <article className={`cowork-card state-${session.state}`}>
      <button className="cowork-card-open" onClick={onOpen} title="Open this conversation">
        <div className="cowork-card-top">
          <span className={`cowork-state-dot ${session.state}`} aria-hidden="true" />
          <strong className="cowork-card-name">{session.name}</strong>
          {live
            ? <Elapsed className="cowork-card-clock mono" startMs={clock} running title="How long this turn has been running" />
            : <span className="cowork-card-clock mono" title="Last activity">{lastTouched(clock)}</span>}
        </div>
        <div className="cowork-card-meta mono" title={session.workspace}>
          {repoLabel(session.workspace)}
          <span className="cowork-card-sep">·</span>
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

function StopButton({ sessionId }: { sessionId: string }) {
  const stop = useStore((state) => state.stopCowork);
  return <button className="btn ghost sm" onClick={() => stop(sessionId)} title="Stop this work slice">Stop</button>;
}

/** The same three steering modes the conversation offers, so a direction never requires leaving the
 *  board. It goes through `sendCowork`, exactly as the composer does: one path, one delivery ledger. */
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
