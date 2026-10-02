import type { ChatMessage, GnomeRole } from "../types.js";
import type { DirectorRest } from "./directorRest.js";

/** One gnome the workshop header can draw: the director, a local worker, an online-office visitor or
 *  a worker frozen until its capacity resets. */
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
  freezeReason?: string;
  /** When this gnome walked on (its run started). Unknown means "when this header first saw it". */
  since?: number;
}

/** 0 is the labelled front lane; 1 and 2 stand further up the floor, smaller and dimmer. */
export type Depth = 0 | 1 | 2;
export const STAGE_DEPTHS: readonly { scale: number; lift: number; z: number }[] = [
  { scale: 1, lift: 0, z: 40 },
  { scale: 0.72, lift: 8, z: 30 },
  { scale: 0.54, lift: 14, z: 20 },
];
/** Quiet this long and a gnome steps back a lane; this long and it joins the back row. */
export const FRONT_IDLE_MS = 3 * 60_000;
export const MID_IDLE_MS = 15 * 60_000;
/** A gnome that just changed lanes stays put this long, unless it speaks or the front is full. */
export const DEPTH_DWELL_MS = 25_000;
/** A walk covers the floor at this speed; a lane step counts as this much floor. */
const WALK_PX_PER_MS = 0.065;
const LANE_STEP_PX = 70;
/** Floor a labelled front gnome needs, and what a background gnome gets at ease and at a squeeze. */
const FRONT_BLOCK = 132;
const CROWD_SLOT = 18;
const CROWD_MIN_SLOT = 12;
/** The back row tucks in between and behind the middle row, so it needs less floor per gnome. */
const BACK_SHARE = 0.6;
/** Partners start this far apart so their meeting is a visible walk; neighbours keep this much air. */
const PAIR_GAP = 48;
const SOLO_GAP = 18;
const CROWD_GAP = 6;
/** A small crew stays together instead of stretching across the whole header. */
const MAX_SPREAD = 44;

export function sameProject(a: WorkshopSeat, b: WorkshopSeat) {
  return a.active && b.active && a.role !== "director" && b.role !== "director" && a.group === b.group;
}

/** The seat that said `message`, if it is one of ours or a visitor we are drawing. */
export function seatForMessage(message: ChatMessage, seats: readonly WorkshopSeat[]) {
  return seats.find((seat) => message.remoteInstance
    ? seat.remote === message.remoteInstance && (seat.name === message.senderName || seat.role === message.role)
    : !seat.remote && (!!message.runId && seat.runId === message.runId || !!message.threadId && seat.threadId === message.threadId || seat.role === "director" && message.role === "director"));
}

/** When each seat last said something in the office chat. */
export function lastSpoken(chat: readonly ChatMessage[], seats: readonly WorkshopSeat[]) {
  const spoken = new Map<string, number>();
  for (const message of chat) {
    if (message.kind !== "chat") continue;
    const seat = seatForMessage(message, seats);
    if (seat && message.createdAt > (spoken.get(seat.id) ?? 0)) spoken.set(seat.id, message.createdAt);
  }
  return spoken;
}

export interface StageCapacity { front: number; mid: number; comfortable: number }
/** How many gnomes each lane holds for `count` on stage. The front shrinks as the crowd grows, so the
 *  crowd keeps room to stand between labels; `comfortable` bounds only visitors, never own gnomes. */
export function stageCapacity(width: number, count: number): StageCapacity {
  const front = Math.max(1, Math.min(6, Math.floor(width / 150), Math.floor((width - CROWD_SLOT * count) / (FRONT_BLOCK - CROWD_SLOT))));
  const mid = Math.max(2, Math.floor(width / 60));
  const block = Math.min(FRONT_BLOCK, width * 0.6);
  return { front, mid, comfortable: front + Math.max(2, Math.floor((width - front * block) / CROWD_MIN_SLOT)) };
}

/** Every own gnome, then visitors while the stage has comfortable room, in floor order: teams
 *  stand together (a visitor beside its local teammate) and frozen workers wait at the end. */
export function stageCast(seats: readonly WorkshopSeat[], width: number) {
  const own = seats.filter((seat) => !seat.remote);
  const working = own.filter((seat) => !seat.freezeReason);
  const frozen = own.filter((seat) => seat.freezeReason);
  const room = Math.max(0, stageCapacity(width, own.length).comfortable - own.length);
  const joinsLocal = (seat: WorkshopSeat) => working.some((local) => sameProject(local, seat));
  const visitors = seats.filter((seat) => seat.remote)
    .sort((a, b) => Number(joinsLocal(b)) - Number(joinsLocal(a)))
    .slice(0, room);
  const selected = [...working, ...visitors];
  const placed = new Set<string>();
  return [...selected.flatMap((seat) => {
    if (placed.has(seat.id)) return [];
    const team = [seat, ...selected.filter((other) => other.id !== seat.id && !placed.has(other.id) && sameProject(seat, other))
      .sort((a, b) => Number(!!a.remote) - Number(!!b.remote))];
    team.forEach((member) => placed.add(member.id));
    return team;
  }), ...frozen];
}

export interface DepthEntry {
  id: string;
  /** The later of its last message and its arrival (a visitor arrives with its local teammate). */
  recency: number;
  /** Its last message, so a NEW message can override the dwell. */
  spokeAt: number;
  /** A visitor: it takes a lane's spare places only after every own gnome, unless it just spoke. */
  guest: boolean;
  /** The nearest lane it may stand in: a frozen worker waits one back. */
  floor: Depth;
  /** A visitor working with a local teammate stands in that teammate's lane and moves with it. */
  follows?: string;
}
export interface DepthMemory { depth: Depth; at: number; spokeAt: number }

/** Lanes by recency: the freshest own gnome always holds the front, quiet gnomes recede with age,
 *  and a full lane pushes its stalest member back. Own gnomes claim places before quiet visitors,
 *  and a visitor working with a local teammate stands in that teammate's lane.
 *  Moves made for age or freed room wait out a dwell so nobody jitters; a new message and a full
 *  front never wait. Pure — `memory` is the previous call's result. */
export function assignDepths(entries: readonly DepthEntry[], memory: ReadonlyMap<string, DepthMemory>, capacity: Pick<StageCapacity, "front" | "mid">, now: number) {
  const fresh = (entry: DepthEntry) => entry.spokeAt > 0 && now - entry.spokeAt < FRONT_IDLE_MS;
  const waits = (entry: DepthEntry) => Number(entry.guest && !fresh(entry));
  const order = entries.map((entry, index) => ({ entry, index }))
    .sort((a, b) => waits(a.entry) - waits(b.entry) || b.entry.recency - a.entry.recency || a.index - b.index);
  const caps = [capacity.front, capacity.mid, Infinity];
  const counts = [0, 0, 0];
  const depths = new Map<string, Depth>();
  const next = new Map<string, DepthMemory>();
  let wake = Infinity;
  let anchored = false;
  for (const { entry } of order) {
    const age = now - entry.recency;
    let want = Math.max(entry.floor, age < FRONT_IDLE_MS ? 0 : age < MID_IDLE_MS ? 1 : 2) as Depth;
    const previous = memory.get(entry.id);
    const spoke = !!previous && entry.spokeAt > previous.spokeAt;
    const leader = entry.follows === undefined ? undefined : depths.get(entry.follows);
    if (leader !== undefined && !(spoke && want < leader)) want = Math.max(entry.floor, leader) as Depth;
    else if (previous && want !== previous.depth && now - previous.at < DEPTH_DWELL_MS && !(spoke && want < previous.depth)) {
      wake = Math.min(wake, previous.at + DEPTH_DWELL_MS);
      want = previous.depth;
    }
    if (!anchored && entry.floor === 0 && !entry.guest) want = 0;
    anchored ||= entry.floor === 0 && !entry.guest;
    let depth = want;
    while (depth < 2 && counts[depth]! >= caps[depth]!) depth = (depth + 1) as Depth;
    counts[depth]!++;
    depths.set(entry.id, depth);
    next.set(entry.id, previous && previous.depth === depth ? { ...previous, spokeAt: entry.spokeAt } : { depth, at: now, spokeAt: entry.spokeAt });
    for (const threshold of [entry.recency + FRONT_IDLE_MS, entry.recency + MID_IDLE_MS]) if (threshold > now) wake = Math.min(wake, threshold);
  }
  return { depths, memory: next, wakeAt: Number.isFinite(wake) ? wake : null };
}

export interface StageActor {
  seat: WorkshopSeat;
  depth: Depth;
  /** Left edge of the gnome's 32×48 box in front-lane pixels; depth scales it about its feet. */
  x: number;
  scale: number;
  lift: number;
  z: number;
  /** Front-lane destination label; background gnomes only reveal theirs on hover. */
  labelWidth: number;
  labelLeft: boolean;
  /** Index of the teammate it meets on the shared timeline, or -1. */
  partner: number;
  /** How far its 12s loop walks, in its own unscaled pixels. */
  travel: number;
  delay: number;
  /** Centre of the shared sheet between partners, for the pair's lead only. */
  meeting: number | null;
}

/** Positions for a cast whose lanes are already chosen, left to right in floor order. A front gnome
 *  keeps the floor its label needs; the crowd behind shares what is left, so no label ever sits over
 *  a gnome. When the crowd is dense it stands closer and smaller rather than leaving anyone out. */
export function stageLayout(cast: readonly WorkshopSeat[], depths: ReadonlyMap<string, Depth>, width: number): StageActor[] {
  const depthOf = (index: number) => depths.get(cast[index]!.id) ?? 0;
  const front = cast.flatMap((_, index) => depthOf(index) === 0 ? [index] : []);
  const crowd = cast.length - front.length;
  const crowdShare = cast.reduce((sum, _, index) => sum + (depthOf(index) === 1 ? 1 : depthOf(index) === 2 ? BACK_SHARE : 0), 0);
  // A lone front gnome keeps a readable label even when the crowd behind it is packed.
  const labelFloor = front.length <= 2 ? Math.min(72, width * 0.3) : 24;
  const labelWidth = Math.max(labelFloor, Math.min(92, Math.floor((width - crowd * CROWD_SLOT) / Math.max(1, front.length)) - 56));
  const partners = new Map<number, number>();
  for (const depth of [0, 1, 2] as const) pairLane(cast, cast.flatMap((_, index) => depthOf(index) === depth ? [index] : []), partners);
  const extent = (index: number) => {
    const label = Math.max(24, labelWidth - (cast[index]!.rest === "sleep" ? 20 : 0)) + 8;
    if (cast[index]!.rest === "sleep") return { left: 10, right: label + 14 };
    return partners.get(index)! > index ? { left: label, right: 0 } : { left: 0, right: label };
  };
  const gapBefore = (index: number) => index === 0 ? 0
    : depthOf(index) === 0 && depthOf(index - 1) === 0 ? partners.get(index) === index - 1 ? PAIR_GAP : SOLO_GAP : CROWD_GAP;
  const frontFloor = front.reduce((sum, index) => sum + extent(index).left + 32 + extent(index).right, 0);
  const gaps = cast.reduce((sum, _, index) => sum + gapBefore(index), 0);
  const slot = crowd ? Math.max(4, Math.min(40, (width - 4 - frontFloor - gaps) / crowdShare)) : 0;
  const spread = Math.max(0, Math.min(MAX_SPREAD, (width - 4 - frontFloor - gaps - slot * crowdShare) / Math.max(1, cast.length)));
  const midScale = Math.max(0.56, Math.min(STAGE_DEPTHS[1]!.scale, STAGE_DEPTHS[1]!.scale * slot / 22));
  const backScale = Math.max(0.42, Math.min(STAGE_DEPTHS[2]!.scale, STAGE_DEPTHS[2]!.scale * slot / 18));
  let cursor = 2;
  let behind = 0;
  const actors = cast.map((seat, index): StageActor => {
    const depth = depthOf(index);
    const geometry = STAGE_DEPTHS[depth]!;
    cursor += gapBefore(index);
    const base = { seat, depth, z: geometry.z, labelWidth: Math.max(24, labelWidth - (seat.rest === "sleep" ? 20 : 0)),
      labelLeft: partners.get(index)! > index, partner: partners.get(index) ?? -1, travel: 0, delay: 0, meeting: null };
    if (depth === 0) {
      const { left, right } = extent(index);
      const x = cursor + left;
      cursor = x + 32 + right + spread;
      return { ...base, x, scale: 1, lift: 0 };
    }
    // A packed back row staggers, every other gnome a step further up the floor.
    const staggered = slot < 14 && behind++ % 2 === 1;
    const room = slot * (depth === 2 ? BACK_SHARE : 1);
    const scale = (depth === 1 ? midScale : backScale) * (staggered ? 0.94 : 1);
    // At a squeeze a gnome is wider than its slot; the ones at either end still stand fully on stage.
    const x = Math.max(16 * scale - 16, Math.min(width - 16 - 16 * scale, cursor + room / 2 - 16));
    cursor += room + spread;
    return { ...base, x, scale, lift: geometry.lift + (staggered ? 3 : 0), z: geometry.z - (staggered ? 1 : 0) };
  });
  return actors.map((actor, index) => {
    const partner = actors[actor.partner];
    const still = actor.seat.rest || actor.seat.freezeReason;
    const direction = partner ? Math.sign(partner.x - actor.x) || 1 : 1;
    const travel = still ? 0 : partner
      ? ((partner.x - actor.x) / 2 - direction * 17 * actor.scale) / actor.scale
      : actor.depth === 0 ? 12 : Math.min(10, (slot + spread) * 0.4 / actor.scale);
    const phase = partner ? Math.min(index, actor.partner) : index;
    const meeting = partner && actor.partner > index && !still ? (actor.x + partner.x) / 2 + 16 : null;
    return { ...actor, travel, delay: -(phase * 2.7), meeting };
  });
}

/** Pair floor neighbours in the same lane: repository teammates, or the director helping a lone
 *  worker. Only neighbours, so nobody walks through the crowd to meet. A visitor meets its local
 *  teammate first, so a crowded repo never leaves the cross-office pair apart. */
function pairLane(cast: readonly WorkshopSeat[], lane: number[], partners: Map<number, number>) {
  const laneSeats = lane.map((index) => cast[index]!);
  const pairs = (a: number, b: number) => {
    const seat = cast[a]!, other = cast[b]!;
    const helps = seat.active && other.active && seat.role === "director" && !seat.remote && !other.remote &&
      !laneSeats.some((candidate) => candidate.id !== other.id && sameProject(other, candidate));
    return !seat.rest && !other.rest && (sameProject(seat, other) || helps);
  };
  for (const crossOffice of [true, false]) {
    for (let k = 0; k + 1 < lane.length; k++) {
      const a = lane[k]!, b = lane[k + 1]!;
      if (partners.has(a) || partners.has(b) || b !== a + 1) continue;
      if (crossOffice && !cast[a]!.remote === !cast[b]!.remote) continue;
      if (!pairs(a, b)) continue;
      partners.set(a, b);
      partners.set(b, a);
    }
  }
}

/** How long a gnome takes to walk from one spot to another: brisk across the floor, a beat per lane. */
export function walkDuration(from: Pick<StageActor, "x" | "depth">, to: Pick<StageActor, "x" | "depth">) {
  const distance = Math.abs(to.x - from.x) + LANE_STEP_PX * Math.abs(to.depth - from.depth);
  return distance < 1 ? 0 : Math.round(Math.max(700, Math.min(3200, distance / WALK_PX_PER_MS)));
}

/** Where the shared 12s loop has carried a gnome, as a fraction of its `travel`. Mirrors the
 *  beta-journey keyframes: out by 28%, together until 50%, home by 78%. */
export function journeyProgress(progress: number) {
  const p = ((progress % 1) + 1) % 1;
  return p < 0.28 ? p / 0.28 : p < 0.5 ? 1 : p < 0.78 ? 1 - (p - 0.5) / 0.28 : 0;
}
