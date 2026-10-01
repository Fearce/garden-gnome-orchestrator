import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { ChatMessage, GnomeRole } from "../types.js";
import { observeGnomeMotion } from "../lib/betaGnomes.js";
import { BetaGnome, RestFurnitureBack, RestFurnitureFront } from "./BetaGnome.js";
import type { DirectorRest } from "../lib/directorRest.js";
import { Gnome } from "./Gnome.js";

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
  rest?: DirectorRest;
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

/** Pick a cast that fits without adding rows. Leave enough room to actually walk. */
function visibleCast(seats: WorkshopSeat[], capacity: number) {
  const localSeats = seats.filter((seat) => !seat.remote);
  // Give each destination a representative before filling spare places with its crew.
  const rooms = new Set<string>();
  const representatives = localSeats.filter((seat) => {
    if (rooms.has(seat.room)) return false;
    rooms.add(seat.room); return true;
  });
  const locals = [...representatives, ...localSeats.filter((seat) => !representatives.includes(seat))];
  const visitors = seats.filter((seat) => seat.remote).sort((a, b) => Number(b.role === "director") - Number(a.role === "director"));
  const visiting = capacity >= 3 ? Math.min(2, visitors.length, capacity - 2) : 0;
  const selected = [...locals.slice(0, capacity - visiting), ...visitors.slice(0, visiting + Math.max(0, capacity - visiting - locals.length))];
  // Neighbouring chairs share a table; keep the owner's director first and every destination labelled.
  const chairs = selected.filter((seat) => seat.rest === "chair");
  return selected.flatMap((seat) => seat === chairs[0] ? chairs : seat.rest === "chair" ? [] : [seat]);
}

function destination(seat: WorkshopSeat) {
  const folder = seat.group.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || seat.group;
  return { label: folder, office: seat.remote ? `↗ ${seat.remote}` : "Local office" };
}

/** Positions are recomputed only on resize/cast changes. CSS runs the shared walk/work timeline. */
function choreography(cast: WorkshopSeat[], width: number) {
  // Quiet offices gather around a small table instead of stretching it across the whole header.
  const span = Math.min(176, width / Math.max(1, cast.length));
  const paired = new Set<number>();
  return cast.map((seat, index) => {
    const partner = paired.has(index) ? -1 : cast.findIndex((other, i) => i === index + 1 && !paired.has(i) && (
      seat.rest === "chair" && other.rest === "chair" ||
      seat.active && other.active && (other.group === seat.group || seat.role === "director" && !seat.remote && !other.remote)
    ));
    if (partner >= 0) { paired.add(index); paired.add(partner); }
    const labelWidth = Math.max(24, Math.min(92, span - (seat.rest === "sleep" ? 76 : 56)));
    const labelLeft = partner >= 0;
    const home = span * index + (labelLeft ? labelWidth + 8 : seat.rest === "sleep" ? 18 : 8);
    return { seat, home, partner, span, labelWidth, labelLeft };
  }).map((actor, index, all) => {
    const lead = all.findIndex((other) => other.partner === index);
    const partnerIndex = actor.partner >= 0 ? actor.partner : lead;
    const partner = all[partnerIndex];
    const direction = partner ? Math.sign(partner.home - actor.home) : 1;
    // Partners approach to shoulder distance; solos cover most of their own patch.
    const travel = actor.seat.rest ? 0 : partner ? (partner.home - actor.home) / 2 - direction * 17 : Math.max(0, Math.min(24, actor.span - actor.labelWidth - 48));
    const phase = partner ? Math.min(index, partnerIndex) : index;
    return { ...actor, partnerIndex, travel, delay: -(phase * 2.7), meeting: partner ? (actor.home + partner.home) / 2 + 16 : null };
  });
}

function seatActivity(seat: WorkshopSeat) {
  return seat.active ? verbs[seat.role] : seat.rest === "sleep" ? "Sleeping" : seat.rest === "chair" ? "Taking a seat" : "Ready";
}

/** The cast's artwork: the illustrated beta texture, or the original vector gnome (`classic`). A
 *  classic gnome stays in full color like a beta character; the workshop CSS walks and works it. */
function WorkshopGnome({ classic, role, size, active, rest }: { classic: boolean; role: GnomeRole; size: number; active: boolean; rest?: DirectorRest }) {
  return classic ? <ClassicWorkshopGnome role={role} size={size} rest={rest} /> : <BetaGnome role={role} size={size} active={active} rest={rest} />;
}

/** The original gnome, wrapped so a resting director gets the same chair or bed as its beta self. */
function ClassicWorkshopGnome({ role, size, rest }: { role: GnomeRole; size: number; rest?: DirectorRest }) {
  return <span className="classic-workshop-gnome" data-rest={rest} style={{ width: size, height: size * 1.5 }}>
    <RestFurnitureBack rest={rest} />
    <Gnome role={role} size={size} />
    <RestFurnitureFront rest={rest} />
  </span>;
}

/** One 48px lane. Speech and the roster float over the board, never reserve header space. */
export function BetaWorkshop({ seats, chat, online, activeRoom, openOffice, classic = false }: {
  seats: WorkshopSeat[]; chat: ChatMessage[]; online: number; activeRoom: string | null; openOffice: (room: string) => void; classic?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(200);
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(Date.now);
  const [motionPaused, setMotionPaused] = useState(false);
  useEffect(() => ref.current ? observeGnomeMotion(ref.current) : undefined, []);
  useLayoutEffect(() => {
    const element = stage.current;
    if (!element) return;
    const measure = () => setWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!expanded) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setExpanded(false); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [expanded]);
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
  const cast = visibleCast(seats, Math.max(1, Math.min(7, Math.floor(width / 156))));
  const actors = choreography(cast, width);
  const totalWorking = seats.filter((s) => s.active).length;
  const speaker = message && seats.find((seat) => message.remoteInstance
    ? seat.remote === message.remoteInstance && (seat.name === message.senderName || seat.role === message.role)
    : !seat.remote && (seat.runId === message.runId && !!message.runId || seat.threadId === message.threadId && !!message.threadId || seat.role === "director" && message.role === "director"));
  const bubble = message && `${message.senderName || speaker?.name || message.role}${message.remoteInstance ? ` · ${message.remoteInstance}` : ""}: ${message.body.replace(/\s+/g, " ").trim()}`;
  return <div className="beta-workshop" ref={ref} data-art={classic ? "classic" : "beta"} data-motion-paused={motionPaused} aria-label={`Workshop: ${totalWorking} at work, ${online} online`}>
    <div className="beta-workshop-stage" ref={stage}>
      <div className="beta-workshop-cast" aria-label="Gnomes in the workshop">
        {actors.map(({ seat, home, travel, delay, partnerIndex, labelWidth, labelLeft }) => <button type="button" key={seat.id}
          className={`beta-workstation${seat.remote ? " beta-visitor" : ""}`}
          data-office-room={seat.room} data-speaking={speaker?.id === seat.id} data-working={seat.active}
          data-rest={seat.rest}
          data-agent-id={seat.id}
          data-label-side={labelLeft ? "left" : "right"}
          data-partner={!seat.rest && partnerIndex >= 0 ? cast[partnerIndex]?.id : undefined}
          style={{ left: home, "--label-width": `${labelWidth}px`, "--journey": `${travel}px`, "--seat-delay": `${delay}s`, "--out-facing": travel < 0 ? -1 : 1, "--back-facing": travel < 0 ? 1 : -1 } as CSSProperties}
          onClick={() => open(seat.room)}
          aria-label={`${seat.name}, ${seatActivity(seat)}. ${seat.group}, ${seat.remote ? `visiting from ${seat.remote}` : "local office"}. ${seat.task}. Open chat${unread.get(seat.room) ? `, ${unread.get(seat.room)} new messages` : ""}`}
          title={`${seat.name} · ${seatActivity(seat)}\n${seat.task}\n${seat.group}\n${seat.remote ? `Online office: ${seat.remote}` : "Local office"}\nClick to open chat`}>
          <span className="beta-character"><WorkshopGnome classic={classic} role={seat.role} size={32} active={seat.active} rest={seat.rest} /></span>
          <span className="beta-destination" aria-hidden="true"><strong>{destination(seat).label}</strong><small>{destination(seat).office}</small></span>
          {seat.remote && <span className="beta-visitor-mark" aria-hidden="true">↗</span>}
          {(unread.get(seat.room) ?? 0) > 0 && <span className="beta-message-badge" aria-hidden="true">{Math.min(unread.get(seat.room)!, 99)}</span>}
        </button>)}
        {actors.filter((actor) => actor.seat.rest === "chair" && (actor.partner >= 0 || actor.partnerIndex < 0 && actor.seat.remote)).map((actor) => <span key={`table:${actor.seat.id}`} className="beta-directors-table" aria-hidden="true"
          style={{ left: actor.home + 24, width: actor.partner >= 0 ? actors[actor.partner]!.home - actor.home - 16 : 25 }}>
          <svg viewBox="0 0 100 30" preserveAspectRatio="none" fill="none"><path d="m16 9-3 20m72-20 3 20M20 22h60" stroke="#a5754f" strokeWidth="5" /><path d="M3 7q47-11 94 0v8q-47 8-94 0z" fill="#69483a" stroke="#d4a36b" strokeWidth="2" /><ellipse cx="50" cy="7" rx="47" ry="6" fill="#be9060" /><path d="M18 7q28-5 62 0M28 10h38" stroke="#e0b880" strokeWidth="1" /><path d="M47 1v7q7 4 14 0V1z" fill="#ebd9b0" /><path d="M61 2q10-1 7 5h-7" stroke="#ebd9b0" strokeWidth="2" /></svg>
        </span>)}
        {actors.filter((actor) => actor.partner >= 0 && !actor.seat.rest).map((actor) => <span key={`project:${actor.seat.id}`} className="beta-shared-project" aria-hidden="true"
          style={{ left: actor.meeting!, "--seat-delay": `${actor.delay}s` } as CSSProperties}>
          <svg viewBox="0 0 24 18" fill="none"><path d="M2 2h20v14H2z" fill="#ead8af" stroke="#c59855" /><path d="M6 6h7M6 9h5M6 12h9" stroke="#64787e" strokeWidth="1.4" /><path className="beta-shared-pencil" d="m17 3-4 8" stroke="#bb6953" strokeWidth="2" /></svg>
          <i>✦</i>
        </span>)}
      </div>
    </div>
    <div className="beta-workshop-controls">
      <button type="button" className="beta-cast-more" onClick={() => setExpanded(!expanded)} aria-expanded={expanded} aria-label={`Show all ${seats.length} workshop gnomes`} title={`${seats.length} gnomes · ${online} online`}>{seats.length > cast.length ? `+${seats.length - cast.length}` : "···"}{online > 0 && <i />}</button>
      <button type="button" className="beta-motion-toggle" aria-label={motionPaused ? "Resume workshop animations" : "Pause workshop animations"} aria-pressed={motionPaused} onClick={() => setMotionPaused(!motionPaused)}>{motionPaused ? "▶" : "Ⅱ"}</button>
    </div>
    {message && <button type="button" className="beta-workshop-message has-message" onClick={() => open(message.room)} title={bubble}>
      <span className="beta-chat-icon" aria-hidden="true">···</span><span aria-live="polite">{bubble}</span><span aria-hidden="true">↗</span>
    </button>}
    {expanded && <div className="beta-workshop-roster" role="region" aria-label="Workshop crew">
      <div><strong>Everyone in the workshop</strong><button type="button" onClick={() => setExpanded(false)} aria-label="Close workshop crew">×</button></div>
      {seats.map((seat) => <button key={seat.id} type="button" onClick={() => open(seat.room)} title={seat.group}><WorkshopGnome classic={classic} role={seat.role} size={24} active={seat.active} rest={seat.rest} /><span>{seat.name}<small>{destination(seat).label} · {destination(seat).office}</small><small>{seatActivity(seat)} · {seat.task}</small><small className="beta-destination-path">{seat.group}</small></span></button>)}
    </div>}
  </div>;
}
