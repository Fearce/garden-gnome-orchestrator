import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { ChatMessage, GnomeRole } from "../types.js";
import { observeGnomeMotion } from "../lib/betaGnomes.js";
import {
  assignDepths, holdsPost, lastSpoken, sameProject, seatForMessage, stageCapacity, stageCast, stageLayout, walkDuration,
  type Depth, type DepthMemory, type StageActor, type WorkshopSeat,
} from "../lib/workshopStage.js";
import { bridgeJourney, fadeIn, stride } from "../lib/workshopMotion.js";
import { BetaGnome } from "./BetaGnome.js";
import type { DirectorRest } from "../lib/directorRest.js";
import { ClassicWorkshopGnome } from "./OldWorkshopGnome.js";
import { FrozenGnome } from "./FrozenGnome.js";

export type { WorkshopSeat } from "../lib/workshopStage.js";
const verbs: Record<GnomeRole, string> = {
  director: "Directing", planner: "Planning", researcher: "Researching", implementor: "Building",
  qa: "Checking", reader: "Reading", reviewer: "Reviewing", coworker: "Collaborating",
};
export const WORKSHOP_MESSAGE_MS = 15_000;
export function latestWorkshopMessage(chat: ChatMessage[], seats: WorkshopSeat[], now: number, dismissedThrough = 0) {
  return chat.reduce<ChatMessage | undefined>((latest, message) => {
    if (message.kind !== "chat" || message.createdAt > now || now - message.createdAt >= WORKSHOP_MESSAGE_MS) return latest;
    if (message.createdAt <= dismissedThrough) return latest;
    if (message.room !== "general" && !seats.some((seat) => seat.room === message.room)) return latest;
    return !latest || message.createdAt > latest.createdAt ? message : latest;
  }, undefined);
}

/** Classic art keeps its single lane: pick a cast that fits without adding rows. Leave enough room to actually walk. */
function visibleCast(seats: WorkshopSeat[], capacity: number) {
  const frozen = seats.filter((seat) => seat.freezeReason);
  const available = seats.filter((seat) => !seat.freezeReason);
  // Fill spare places with ice; in a busy wide lane reserve one without splitting a working pair.
  const frozenCount = Math.min(frozen.length, Math.max(0, capacity - available.length, capacity >= 4 ? 1 : 0));
  capacity -= frozenCount;
  const localSeats = available.filter((seat) => !seat.remote);
  // Give each destination a representative before filling spare places with its crew.
  const rooms = new Set<string>();
  const representatives = localSeats.filter((seat) => {
    if (rooms.has(seat.room)) return false;
    rooms.add(seat.room); return true;
  });
  const locals = [...representatives, ...localSeats.filter((seat) => !representatives.includes(seat))];
  const visitors = available.filter((seat) => seat.remote);
  const visiting = capacity >= 3 ? Math.min(2, visitors.length, capacity - 2) : 0;
  const localCast = locals.slice(0, capacity - visiting);
  // A remote teammate of someone on stage gets the visiting place before unrelated workers.
  const joinsLocal = (seat: WorkshopSeat) => localCast.some((local) => local.active && local.group === seat.group);
  visitors.sort((a, b) => Number(joinsLocal(b)) - Number(joinsLocal(a)));
  const selected = [...localCast, ...visitors.slice(0, capacity - localCast.length)];
  // Room representatives are chosen above, but scene order is by project, not by machine.
  // Put a visitor next to its local teammate even when more local workers share their repo.
  const placed = new Set<string>();
  return [...selected.flatMap((seat) => {
    if (placed.has(seat.id)) return [];
    const team = [seat, ...selected.filter((other) => other.id !== seat.id && !placed.has(other.id) && sameProject(seat, other))
      .sort((a, b) => Number(!!b.remote) - Number(!!a.remote))];
    team.forEach((member) => placed.add(member.id));
    return team;
  }), ...frozen.slice(0, frozenCount)];
}

function destination(seat: WorkshopSeat) {
  const folder = seat.group.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || seat.group;
  return { label: folder, office: seat.remote ? `↗ ${seat.remote}` : "Local office" };
}

/** The classic lane's positions, recomputed only on resize/cast changes. CSS runs the shared walk/work timeline. */
function choreography(cast: WorkshopSeat[], width: number): StageActor[] {
  // Keep a small crew together instead of stretching it across the whole header.
  const span = Math.min(176, width / Math.max(1, cast.length));
  const paired = new Set<number>();
  return cast.map((seat, index) => {
    const partner = paired.has(index) ? -1 : cast.findIndex((other, i) => i === index + 1 && !paired.has(i) && (
      sameProject(seat, other) ||
      // The director can help a solo worker, but never take a repository teammate's partner.
      seat.active && other.active && seat.role === "director" && !seat.remote && !other.remote &&
        !cast.some((candidate) => candidate.id !== other.id && sameProject(other, candidate))
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
    const travel = actor.seat.rest || actor.seat.freezeReason ? 0 : partner ? (partner.home - actor.home) / 2 - direction * 17 : Math.max(0, Math.min(24, actor.span - actor.labelWidth - 48));
    const phase = partner ? Math.min(index, partnerIndex) : index;
    return {
      seat: actor.seat, depth: 0, x: actor.home, scale: 1, lift: 0, z: 40, labelWidth: actor.labelWidth, labelLeft: actor.labelLeft,
      partner: partnerIndex, travel, delay: -(phase * 2.7), meeting: partner && actor.partner >= 0 ? (actor.home + partner.home) / 2 + 16 : null,
    };
  });
}

/** The beta cast on a depth stage: every own gnome, visitors while there is room, lanes by how
 *  recently each spoke. Lane choices re-run on a single deadline (the next idle threshold or dwell
 *  end), never on a polling clock. */
function useStage(seats: WorkshopSeat[], chat: ChatMessage[], width: number, classic: boolean) {
  const firstSeen = useRef(new Map<string, number>());
  const memory = useRef<ReadonlyMap<string, DepthMemory>>(new Map());
  const [tick, setTick] = useState(0);
  const seatKey = seats.map((seat) => `${seat.id}:${seat.runId ?? ""}:${seat.remote ?? ""}:${seat.name}:${seat.role}`).join("|");
  const spoken = useMemo(() => lastSpoken(chat, seats), [chat, seatKey]);
  const cast = classic ? visibleCast(seats, Math.max(1, Math.min(7, Math.floor(width / 156)))) : stageCast(seats, width);
  const capacity = stageCapacity(width, cast.length);
  const arrived = (seat: WorkshopSeat) => {
    if (!firstSeen.current.has(seat.id)) firstSeen.current.set(seat.id, Date.now());
    return Math.max(spoken.get(seat.id) ?? 0, seat.since ?? firstSeen.current.get(seat.id)!);
  };
  const entries = cast.map((seat) => {
    // A visitor stands with its local teammate; an unrelated one counts from when it showed up.
    const teammate = seat.remote ? cast.find((local) => !local.remote && sameProject(local, seat)) : undefined;
    const spokeAt = spoken.get(seat.id) ?? 0;
    return { id: seat.id, recency: teammate ? Math.max(spokeAt, arrived(teammate)) : arrived(seat), spokeAt, guest: !!seat.remote, floor: seat.freezeReason ? 1 as const : 0 as const, follows: teammate?.id, pinned: holdsPost(seat) };
  });
  const entryKey = `${capacity.front}/${capacity.mid}#${entries.map((entry) => `${entry.id}@${entry.recency}/${entry.spokeAt}/${entry.floor}/${entry.follows ?? ""}${entry.pinned ? "/post" : ""}`).join("|")}`;
  const assigned = useMemo(() => classic ? null : assignDepths(entries, memory.current, capacity, Date.now()), [entryKey, tick, classic]);
  useLayoutEffect(() => { if (assigned) memory.current = assigned.memory; }, [assigned]);
  useEffect(() => {
    if (!assigned?.wakeAt) return;
    const timer = window.setTimeout(() => setTick((value) => value + 1), Math.max(50, assigned.wakeAt - Date.now() + 30));
    return () => window.clearTimeout(timer);
  }, [assigned]);
  const actors = classic ? choreography(cast, width) : stageLayout(cast, assigned!.depths, width);
  return { cast, actors };
}

interface Placement { x: number; depth: Depth; scale: number; lift: number; travel: number; walkMs: number }

/** Where each gnome stood last commit, how long its current walk takes, and the walk itself: a CSS
 *  transition on the actor's transform, a stride layered on its body, and a glide when its loop's
 *  walking distance changes. */
function useWalks(actors: StageActor[], classic: boolean, motionPaused: boolean, root: React.RefObject<HTMLDivElement | null>) {
  const placed = useRef(new Map<string, Placement>());
  const elements = useRef(new Map<string, HTMLDivElement>());
  // The script-driven part of each gnome's current walk: its stride and any glide of its loop.
  const motions = useRef(new Map<string, Animation[]>());
  const settle = (id: string) => { motions.current.get(id)?.forEach((animation) => animation.finish()); motions.current.delete(id); };
  const walks = actors.map((actor) => {
    const previous = placed.current.get(actor.seat.id);
    const moved = !!previous && (Math.abs(previous.x - actor.x) > 0.5 || previous.depth !== actor.depth || Math.abs(previous.scale - actor.scale) > 0.001 || previous.lift !== actor.lift);
    const walkMs = classic || !previous ? 0 : moved ? walkDuration(previous, actor) : previous.walkMs;
    return { actor, previous, moved, walkMs };
  });
  useLayoutEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const paused = motionPaused || root.current?.dataset.paused === "true";
    const next = new Map<string, Placement>();
    for (const { actor, previous, moved, walkMs } of walks) {
      const id = actor.seat.id;
      next.set(id, { x: actor.x, depth: actor.depth, scale: actor.scale, lift: actor.lift, travel: actor.travel, walkMs });
      const element = elements.current.get(id);
      if (classic || !previous || !element) continue;
      // A gnome that sits down or freezes mid-walk stops striding, as does every gnome under reduced motion.
      const still = paused || reduced || !!actor.seat.rest || !!actor.seat.freezeReason;
      if (still) settle(id);
      if (moved && reduced) fadeIn(element);
      if (still) continue;
      const played = motions.current.get(id) ?? [];
      if (moved) {
        settle(id);
        played.length = 0;
        played.push(...stride(element, actor.x - previous.x, walkMs));
      }
      const button = element.querySelector<HTMLElement>(".beta-workstation");
      const glide = button && previous.travel !== actor.travel ? bridgeJourney(button, previous.travel, actor.travel) : undefined;
      if (glide) played.push(glide);
      if (played.length) motions.current.set(id, played);
    }
    placed.current = next;
  });
  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const stopAll = () => { for (const id of [...motions.current.keys()]) settle(id); };
    if (motionPaused) stopAll();
    const onChange = () => { if (reduced.matches) stopAll(); };
    reduced.addEventListener("change", onChange);
    return () => reduced.removeEventListener("change", onChange);
  }, [motionPaused]);
  const register = (id: string) => (element: HTMLDivElement | null) => {
    if (element) elements.current.set(id, element);
    else elements.current.delete(id);
  };
  return { walks, register };
}

function seatActivity(seat: WorkshopSeat) {
  return seat.freezeReason ? "Frozen — waiting for reset" : seat.active ? verbs[seat.role] : seat.rest === "sleep" ? "Sleeping" : seat.rest === "chair" ? "Taking a seat" : "Ready";
}

/** The cast's artwork: the illustrated beta texture, or the original vector gnome with its own
 *  workshop artwork (`classic`, Old gnomes beta). Both stay in full color; the workshop CSS walks them. */
function WorkshopGnome({ classic, role, size, active, rest, frozen }: { classic: boolean; role: GnomeRole; size: number; active: boolean; rest?: DirectorRest; frozen?: boolean }) {
  const gnome = classic ? <ClassicWorkshopGnome role={role} size={size} rest={rest} /> : <BetaGnome role={role} size={size} active={active} rest={rest} />;
  return frozen ? <FrozenGnome size={size}>{gnome}</FrozenGnome> : gnome;
}

const BUBBLE_MIN_ROOM = 150;
/** A speech bubble beside the speaker's head, inside the lane so it never covers the board. Only a
 *  stage too narrow for one drops it below the header, its tail pointing up at the speaker. */
function bubblePlacement(speaker: StageActor | undefined, width: number): { side: string; style: Record<string, string | number> } {
  if (!speaker) return { side: "none", style: { left: 0, maxWidth: Math.min(360, width) } };
  const roomRight = width - (speaker.x + 34);
  const roomLeft = speaker.x - 2;
  if (Math.max(roomRight, roomLeft) < BUBBLE_MIN_ROOM) {
    const left = Math.max(0, Math.min(speaker.x + 4, width - BUBBLE_MIN_ROOM));
    return { side: "below", style: { left, maxWidth: "min(360px, 90vw)", "--tail": `${Math.max(6, speaker.x + 12 - left)}px` } };
  }
  return roomRight >= Math.min(220, roomLeft)
    ? { side: "right", style: { left: speaker.x + 34, maxWidth: Math.min(360, roomRight) } }
    : { side: "left", style: { right: width - roomLeft, maxWidth: Math.min(360, roomLeft) } };
}

/** One 48px stage. Beta gnomes stand in depth lanes; speech floats beside the speaker, the roster below. */
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
  const [dismissedThrough, setDismissedThrough] = useState(0);
  const message = latestWorkshopMessage(chat, seats, Math.max(now, Date.now()), dismissedThrough);
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
  const { cast, actors } = useStage(seats, chat, width, classic);
  const { walks, register } = useWalks(actors, classic, motionPaused, ref);
  const totalWorking = seats.filter((s) => s.active).length;
  const totalFrozen = seats.filter((s) => s.freezeReason).length;
  const speaker = message && seatForMessage(message, seats);
  const speakerWalk = speaker && walks.find((walk) => walk.actor.seat.id === speaker.id);
  // The bubble waits for its speaker to reach the front; frozen per message so later renders keep it.
  const bubbleDelay = useRef<{ id: string; ms: number }>(undefined);
  if (message && bubbleDelay.current?.id !== message.id) bubbleDelay.current = { id: message.id, ms: speakerWalk?.moved ? speakerWalk.walkMs : 0 };
  const placement = bubblePlacement(speakerWalk?.actor, width);
  const bubble = message && `${message.senderName || speaker?.name || message.role}${message.remoteInstance ? ` · ${message.remoteInstance}` : ""}: ${message.body.replace(/\s+/g, " ").trim()}`;
  return <div className="beta-workshop" ref={ref} data-art={classic ? "classic" : "beta"} data-motion-paused={motionPaused} data-bubble={message ? placement.side : undefined} aria-label={`Workshop: ${totalWorking} at work, ${online} online`}>
    <div className="beta-workshop-stage" ref={stage}>
      <div className="beta-workshop-cast" aria-label="Gnomes in the workshop">
        {walks.map(({ actor, walkMs }) => {
          const { seat, depth, x, scale, lift, z, travel, delay, partner, labelWidth, labelLeft } = actor;
          return <div key={seat.id} ref={register(seat.id)} className="beta-actor" data-depth={depth} data-label={!classic && !labelWidth ? "hover" : undefined}
            style={{ transform: `translate3d(${x}px, ${-lift}px, 0) scale(${scale})`, zIndex: z, "--depth-scale": scale, "--walk-ms": `${walkMs}ms` } as CSSProperties}>
            <button type="button"
              className={`beta-workstation${seat.remote ? " beta-visitor" : ""}`}
              data-office-room={seat.room} data-speaking={speaker?.id === seat.id} data-working={seat.active}
              data-rest={seat.rest}
              data-post={!classic && holdsPost(seat) ? "true" : undefined}
              data-frozen={seat.freezeReason ? "true" : undefined}
              data-agent-id={seat.id}
              data-label-side={labelLeft ? "left" : "right"}
              data-partner={!seat.rest && partner >= 0 ? cast[partner]?.id : undefined}
              style={{ "--label-width": `${labelWidth}px`, "--journey": `${travel}px`, "--seat-delay": `${delay}s`, "--out-facing": travel < 0 ? -1 : 1, "--back-facing": travel < 0 ? 1 : -1 } as CSSProperties}
              onClick={() => open(seat.room)}
              aria-label={`${seat.name}, ${seatActivity(seat)}. ${seat.group}, ${seat.remote ? `visiting from ${seat.remote}` : "local office"}. ${seat.task}. Open chat${unread.get(seat.room) ? `, ${unread.get(seat.room)} new messages` : ""}`}
              title={`${seat.name} · ${seatActivity(seat)}\n${seat.task}\n${seat.group}\n${seat.freezeReason ?? (seat.remote ? `Online office: ${seat.remote}` : "Local office")}\nClick to open chat`}>
              <span className="beta-character"><WorkshopGnome classic={classic} role={seat.role} size={32} active={seat.active} rest={seat.rest} frozen={!!seat.freezeReason} /></span>
              <span className="beta-destination" aria-hidden="true"><strong>{destination(seat).label}</strong><small>{seat.freezeReason ? "❄ Until reset" : destination(seat).office}</small></span>
              {seat.remote && <span className="beta-visitor-mark" aria-hidden="true">↗</span>}
              {(unread.get(seat.room) ?? 0) > 0 && <span className="beta-message-badge" aria-hidden="true">{Math.min(unread.get(seat.room)!, 99)}</span>}
            </button>
          </div>;
        })}
        {walks.filter(({ actor }) => actor.meeting !== null).map(({ actor, walkMs }) => <span key={`project:${actor.seat.id}`} className="beta-shared-spot" aria-hidden="true"
          style={{ transform: `translate3d(${actor.meeting}px, ${-actor.lift}px, 0) scale(${actor.scale})`, zIndex: actor.z + 1, "--walk-ms": `${walkMs}ms` } as CSSProperties}>
          <span className="beta-shared-project" style={{ "--seat-delay": `${actor.delay}s` } as CSSProperties}>
            <svg viewBox="0 0 24 18" fill="none"><path d="M2 2h20v14H2z" fill="#ead8af" stroke="#c59855" /><path d="M6 6h7M6 9h5M6 12h9" stroke="#64787e" strokeWidth="1.4" /><path className="beta-shared-pencil" d="m17 3-4 8" stroke="#bb6953" strokeWidth="2" /></svg>
            <i>✦</i>
          </span>
        </span>)}
      </div>
      {message && <div key={message.id} className="beta-workshop-message has-message" data-side={placement.side}
        style={{ ...placement.style, "--bubble-delay": `${bubbleDelay.current?.ms ?? 0}ms` } as CSSProperties}>
        <button type="button" className="beta-message-dismiss" onClick={() => setDismissedThrough(message.createdAt)} title={`${bubble}\nClick to dismiss`} aria-label={`Dismiss: ${bubble}`}>
          <span className="beta-chat-icon" aria-hidden="true">···</span><span aria-live="polite">{bubble}</span>
        </button>
        <button type="button" className="beta-message-open" onClick={() => { setDismissedThrough(message.createdAt); open(message.room); }} title="Open this chat" aria-label="Open this chat">↗</button>
      </div>}
    </div>
    <div className="beta-workshop-controls">
      <button type="button" className={`beta-cast-more${totalFrozen ? " has-frozen" : ""}`} onClick={() => setExpanded(!expanded)} aria-expanded={expanded} aria-label={`Show all ${seats.length} workshop gnomes`} title={`${seats.length} gnomes · ${online} online${totalFrozen ? ` · ${totalFrozen} waiting for reset` : ""}`}>{classic && seats.length > cast.length ? `+${seats.length - cast.length}` : "···"}{online > 0 && <i />}</button>
      <button type="button" className="beta-motion-toggle" aria-label={motionPaused ? "Resume workshop animations" : "Pause workshop animations"} aria-pressed={motionPaused} onClick={() => setMotionPaused(!motionPaused)}>{motionPaused ? "▶" : "Ⅱ"}</button>
    </div>
    {expanded && <div className="beta-workshop-roster" role="region" aria-label="Workshop crew">
      <div><strong>Everyone in the workshop</strong><button type="button" onClick={() => setExpanded(false)} aria-label="Close workshop crew">×</button></div>
      {seats.map((seat) => <button key={seat.id} type="button" data-frozen={seat.freezeReason ? "true" : undefined} onClick={() => open(seat.room)} title={seat.freezeReason ?? seat.group}><WorkshopGnome classic={classic} role={seat.role} size={24} active={seat.active} rest={seat.rest} frozen={!!seat.freezeReason} /><span>{seat.name}<small>{destination(seat).label} · {destination(seat).office}</small><small>{seatActivity(seat)} · {seat.task}</small><small className="beta-destination-path">{seat.group}</small></span></button>)}
    </div>}
  </div>;
}
