import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { ChatMessage, GnomeRole } from "../types.js";
import { observeGnomeMotion } from "../lib/betaGnomes.js";
import { BetaGnome } from "./BetaGnome.js";

export interface WorkshopSeat {
  id: string;
  role: GnomeRole;
  name: string;
  room: string;
  task: string;
  group: string;
  active: boolean;
  runId?: string;
  threadId?: string;
  remote?: string;
}
const verbs: Record<GnomeRole, string> = {
  director: "Directing", planner: "Planning", researcher: "Researching", implementor: "Building",
  qa: "Checking", reader: "Reading", reviewer: "Reviewing", coworker: "Collaborating",
};
export const WORKSHOP_MESSAGE_MS = 15_000;
export function latestWorkshopMessage(chat: ChatMessage[], seats: WorkshopSeat[], now: number) {
  return chat.reduce<ChatMessage | undefined>((latest, message) => {
    if (message.kind !== "chat" || message.createdAt > now || now - message.createdAt >= WORKSHOP_MESSAGE_MS) return latest;
    if (message.room !== "general" && !seats.some((seat) => seat.room === message.room)) return latest;
    return !latest || message.createdAt > latest.createdAt ? message : latest;
  }, undefined);
}

/** A bounded cast on a scrollable stage; the full roster remains reachable by keyboard. */
export function BetaWorkshop({ seats, chat, online, activeRoom, openOffice }: {
  seats: WorkshopSeat[]; chat: ChatMessage[]; online: number; activeRoom: string | null; openOffice: (room: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(Date.now);
  const [motionPaused, setMotionPaused] = useState(false);
  useEffect(() => ref.current ? observeGnomeMotion(ref.current) : undefined, []);
  // Expire the current bubble even in an empty office, without an always-running ticker.
  const message = latestWorkshopMessage(chat, seats, Math.max(now, Date.now()));
  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(1, message.createdAt + WORKSHOP_MESSAGE_MS - Date.now()));
    return () => window.clearTimeout(timer);
  }, [message?.id, message?.createdAt]);
  const [seen, setSeen] = useState(() => new Map<string, number>());
  const [arrivedAt] = useState(Date.now);
  useEffect(() => {
    if (activeRoom) setSeen((old) => new Map(old).set(activeRoom, Date.now()));
  }, [activeRoom, chat]);
  const unread = useMemo(() => {
    const byRoom = new Map<string, number>();
    for (const m of chat) {
      if (m.kind === "chat" && m.room !== activeRoom && m.createdAt > (seen.get(m.room) ?? arrivedAt)) byRoom.set(m.room, (byRoom.get(m.room) ?? 0) + 1);
    }
    return byRoom;
  }, [chat, seen, activeRoom, arrivedAt]);
  function open(room: string) {
    setSeen((old) => new Map(old).set(room, Date.now()));
    openOffice(room);
    setExpanded(false);
  }
  // Always reserve space for online visitors, even in a busy local office.
  const locals = seats.filter((seat) => !seat.remote);
  const visitors = seats.filter((seat) => seat.remote);
  const cast = [...locals.slice(0, visitors.length ? 5 : 7), ...visitors.slice(0, 2)];
  const totalWorking = seats.filter((s) => s.active).length;
  const speaker = message && seats.find((seat) => message.remoteInstance
    ? seat.remote === message.remoteInstance && (seat.name === message.senderName || seat.role === message.role)
    : !seat.remote && (seat.runId === message.runId && !!message.runId || seat.threadId === message.threadId && !!message.threadId || seat.role === "director" && message.role === "director"));
  const bubble = message && `${message.senderName || speaker?.name || message.role}${message.remoteInstance ? ` · ${message.remoteInstance}` : ""}: ${message.body.replace(/\s+/g, " ").trim()}`;
  return <div className="beta-workshop" ref={ref} data-motion-paused={motionPaused} data-alone={seats.length === 1}>
    <div className="beta-workshop-heading">
      <span className="beta-workshop-title"><span aria-hidden="true">✦</span> THE WORKSHOP <em>BETA</em></span>
      <span className="beta-workshop-count">{totalWorking ? `${totalWorking} at work` : "Ready for a little magic"}{online > 0 ? ` · ${online} online` : ""}</span>
      <button type="button" className="beta-motion-toggle" aria-label={motionPaused ? "Resume workshop animations" : "Pause workshop animations"} aria-pressed={motionPaused} onClick={() => setMotionPaused(!motionPaused)}>{motionPaused ? "▶" : "Ⅱ"}</button>
    </div>
    <div className="beta-workshop-stage">
      <div className="beta-festoon" aria-hidden="true"><i /><i /><i /><i /><i /><i /><i /><i /><i /></div>
      <div className="beta-motes" aria-hidden="true"><i /><i /><i /><i /><i /></div>
      <div className="beta-workshop-cast" aria-label="Gnomes in the workshop">
        {cast.map((seat, index) => <button type="button" key={seat.id}
          className={`beta-workstation${seat.remote ? " beta-visitor" : ""}${index > 0 && seat.group === cast[index - 1]?.group ? " beta-teammate" : ""}`}
          data-office-room={seat.room} data-speaking={speaker?.id === seat.id} data-working={seat.active}
          style={{ "--seat-delay": `${-(index * 0.63)}s` } as CSSProperties}
          onClick={() => open(seat.room)}
          aria-label={`${seat.name}, ${seat.active ? verbs[seat.role] : "ready"}${seat.remote ? `, visiting from ${seat.remote}` : ""}. ${seat.task}. Open chat${unread.get(seat.room) ? `, ${unread.get(seat.room)} new messages` : ""}`}
          title={`${seat.name} · ${seat.active ? verbs[seat.role] : "Ready"}\n${seat.task}\n${seat.remote ? `Online office: ${seat.remote}` : seat.group}\nClick to open chat`}>
          <span className="beta-character"><BetaGnome role={seat.role} size={55} active={seat.active} /></span>
          <span className="beta-workstation-name">{seat.name}</span>
          <span className="beta-workstation-role">{seat.remote ? "↗ " : ""}{seat.active ? verbs[seat.role] : "Ready"}</span>
          {(unread.get(seat.room) ?? 0) > 0 && <span className="beta-message-badge" aria-hidden="true">{Math.min(unread.get(seat.room)!, 99)}</span>}
        </button>)}
        {seats.length > cast.length && <button type="button" className="beta-cast-more" onClick={() => setExpanded(!expanded)} aria-expanded={expanded} aria-label={`Show all ${seats.length} workshop gnomes`}>+{seats.length - cast.length}<span>crew</span></button>}
      </div>
    </div>
    <button type="button" className={`beta-workshop-message${message ? " has-message" : ""}`} onClick={() => open(message?.room ?? seats[0]?.room ?? "general")} title={bubble || "Open office chat"}>
      <span className="beta-chat-icon" aria-hidden="true">···</span><span aria-live="polite">{bubble || (visitors.length ? "Local hands, distant friends. Open the office chat." : totalWorking ? "A little workshop. Real work in motion." : "The lanterns are lit. Your next idea starts here.")}</span><span aria-hidden="true">↗</span>
    </button>
    {expanded && <div className="beta-workshop-roster" role="region" aria-label="Workshop crew">
      <div><strong>Everyone in the workshop</strong><button type="button" onClick={() => setExpanded(false)} aria-label="Close workshop crew">×</button></div>
      {seats.map((seat) => <button key={seat.id} type="button" onClick={() => open(seat.room)}><BetaGnome role={seat.role} size={24} active={seat.active} /><span>{seat.name}<small>{seat.remote || seat.group} · {seat.active ? verbs[seat.role] : "Ready"}</small></span></button>)}
    </div>}
  </div>;
}
