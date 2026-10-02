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
/** Floor a crowd gnome gets at ease and at a squeeze, behind and between the front lane. */
const CROWD_SLOT = 18;
const CROWD_MIN_SLOT = 12;
/** Front partners start this far apart so their meeting is a walk; front neighbours keep this much air. */
const PAIR_GAP = 64;
const SOLO_GAP = 18;
/** The crowd keeps this clear of a front gnome's body, so nobody stands hidden behind it. */
const BODY_CLEAR = 8;
/** A crowd pair takes this many gnomes' floor and starts this far (screen px each) from its meeting. */
const PAIR_SHARE = 1.6;
const PAIR_STROLL = 10;
/** How far a loop strolls a gnome, in screen px: the front lane passes the crowd behind it, and the
 *  further back a gnome stands the less ground it covers. */
const STROLL = [64, 26, 16] as const;
/** On a roomy stage a front gnome strolls up to this far (screen px) to pass a crowd gnome: an amble in
 *  the loop's 3.4 s walk out, a little slower than a lane walk. */
const FRONT_STROLL_MAX = 192;
/** The least air between groups for the whole cast to stand in one evenly spaced row. */
const EVEN_AIR = 24;
/** Floor each front gnome keeps free to stroll on, before labels take their share; and the floor a
 *  labelled front gnome needs in all, which bounds how many stand in front. */
const STROLL_FLOOR = 44;
const FRONT_PITCH = 170;

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
/** How many gnomes each lane holds for `count` on stage. Front gnomes need room for their labels;
 *  the crowd stands behind and between them. `comfortable` bounds only visitors, never own gnomes. */
export function stageCapacity(width: number, count: number): StageCapacity {
  const front = Math.max(1, Math.min(6, Math.floor(width / FRONT_PITCH), count));
  const mid = Math.max(2, Math.floor(width / 60));
  return { front, mid, comfortable: front + Math.max(2, Math.floor((width - 4 - front * (32 + 2 * BODY_CLEAR)) / CROWD_SLOT)) };
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

/** Positions for a cast whose lanes are already chosen, in floor order. Every lane stands across the
 *  same floor. A stage with room to spare spaces every group evenly over its whole width; a fuller one
 *  keeps the labelled front lane's labels clear of each other and spreads the crowd further back behind
 *  and between it, never hidden behind a front gnome. Each loop strolls a gnome past the
 *  others, which is what makes the lanes read as depth. A dense crowd stands closer and smaller rather
 *  than leaving anyone out. */
export function stageLayout(cast: readonly WorkshopSeat[], depths: ReadonlyMap<string, Depth>, width: number): StageActor[] {
  const depthOf = (index: number) => depths.get(cast[index]!.id) ?? 0;
  const partners = new Map<number, number>();
  for (const depth of [0, 1, 2] as const) pairLane(cast, cast.flatMap((_, index) => depthOf(index) === depth ? [index] : []), partners);
  const layered = frontLane(cast, cast.flatMap((_, index) => depthOf(index) === 0 ? [index] : []), partners, width);
  const even = evenStage(cast, depthOf, partners, layered, width);
  const lane = even?.lane ?? layered;
  const crowd = even?.crowd ?? crowdPlaces(cast.flatMap((_, index) => depthOf(index) === 0 ? [] : [index]), depthOf, partners, lane, width);
  const actors = cast.map((seat, index): StageActor => {
    const depth = depthOf(index);
    const place = depth === 0 ? { x: lane.x.get(index)!, scale: 1, lift: 0, z: STAGE_DEPTHS[0]!.z } : crowd.get(index)!;
    return { seat, depth, ...place, labelWidth: lane.labelWidth(index), labelLeft: lane.labelLeft(index),
      partner: partners.get(index) ?? -1, travel: 0, delay: 0, meeting: null };
  });
  // Further back a meeting stays short, so the crowd covers less ground than the front (parallax).
  for (const actor of actors) {
    const partner = actors[actor.partner];
    if (actor.depth > 0 && partner && Math.abs(partner.x - actor.x) / 2 - 17 * actor.scale > STROLL[actor.depth]) actor.partner = partner.partner = -1;
  }
  // The front picks its strolls first, so the crowd behind can walk the other way as it passes.
  const strolls = new Map<number, number>();
  let escorts = new Map<number, number>();
  for (const pass of [0, 1]) {
    if (pass === 1) escorts = escortsFor(actors, strolls);
    actors.forEach((actor, index) => {
      const partner = actors[actor.partner];
      if (Number(actor.depth > 0) !== pass) return;
      const direction = partner ? Math.sign(partner.x - actor.x) || 1 : 1;
      strolls.set(index, actor.seat.rest || actor.seat.freezeReason ? 0 : partner
        ? direction * Math.max(0, Math.abs(partner.x - actor.x) / 2 - 17 * actor.scale)
        : stroll(actors, index, lane, width, strolls, escorts.get(index)));
    });
  }
  const phaseOf = (index: number) => actors[index]!.partner >= 0 ? Math.min(index, actors[index]!.partner) : index;
  return actors.map((actor, index) => {
    const partner = actors[actor.partner];
    const still = actor.seat.rest || actor.seat.freezeReason;
    const travel = strolls.get(index)! / actor.scale;
    // An escort keeps its front gnome's beat, so the two cross mid-walk.
    const phase = phaseOf(escorts.get(index) ?? index);
    const meeting = partner && actor.partner > index && !still ? (actor.x + partner.x) / 2 + 16 : null;
    return { ...actor, travel, delay: -(phase * 2.7), meeting };
  });
}

interface FrontLane {
  /** Left edge of each front gnome's body. */
  x: Map<number, number>;
  labelWidth: (index: number) => number;
  labelLeft: (index: number) => boolean;
  /** Floor a front gnome's label takes beside its body, left and right. */
  extent: (index: number) => { left: number; right: number };
  order: number[];
}

/** The front lane in floor order, spread evenly over the floor so each gnome has ground to stroll
 *  across the crowd, pushed apart until no label touches a neighbour and pulled back inside the stage. */
function frontLane(cast: readonly WorkshopSeat[], front: number[], partners: ReadonlyMap<number, number>, width: number): FrontLane {
  const gap = (a: number, b: number) => partners.get(a) === b ? PAIR_GAP : SOLO_GAP;
  const gaps = front.slice(1).reduce((sum, index, k) => sum + gap(front[k]!, index), 0);
  const shared = Math.max(24, Math.min(92, Math.floor((width - 4 - gaps) / Math.max(1, front.length)) - 40 - STROLL_FLOOR));
  const labelWidth = (index: number) => Math.max(24, shared - (cast[index]!.rest === "sleep" ? 20 : 0));
  const labelLeft = (index: number) => (partners.get(index) ?? -1) > index;
  const extent = (index: number) => {
    const label = labelWidth(index) + 8;
    if (cast[index]!.rest === "sleep") return { left: 10, right: label + 14 };
    return labelLeft(index) ? { left: label, right: 0 } : { left: 0, right: label };
  };
  const need = (a: number, b: number) => 32 + extent(a).right + gap(a, b) + extent(b).left;
  // A pair stands together as one group; groups share the floor evenly.
  const leads = front.filter((index, k) => k === 0 || partners.get(index) !== front[k - 1]);
  const x = new Map<number, number>();
  front.forEach((index, k) => {
    const previous = front[k - 1];
    const after = previous === undefined ? -Infinity : x.get(previous)! + need(previous, index);
    const group = leads.indexOf(index);
    if (group < 0) return x.set(index, after);
    const mate = partners.get(index) === front[k + 1] ? front[k + 1]! : undefined;
    const span = extent(index).left + 32 + (mate === undefined ? extent(index).right : PAIR_GAP + 32 + extent(mate).right);
    const share = 2 + (group + 0.5) / leads.length * (width - 4) - span / 2 + extent(index).left;
    x.set(index, Math.max(share, extent(index).left + 2, after));
  });
  for (let k = front.length - 1; k >= 0; k--) {
    const index = front[k]!, next = front[k + 1];
    const limit = next === undefined ? width - 2 - 32 - extent(index).right : x.get(next)! - need(index, next);
    x.set(index, Math.max(extent(index).left + 2, Math.min(x.get(index)!, limit)));
  }
  return { x, labelWidth, labelLeft, extent, order: front };
}

type CrowdPlace = { x: number; scale: number; lift: number; z: number };

/** A roomy stage: every group (a pair counts as one) stands in floor order with the same air between
 *  neighbours and at both ends, front labels included, so a small cast uses the whole header instead of
 *  huddling at one end. A lone front gnome with crowd only on its right carries its label on the left,
 *  so its stroll crosses open floor to pass them. Null when that leaves less than EVEN_AIR; then the
 *  crowd stands behind the front. */
function evenStage(cast: readonly WorkshopSeat[], depthOf: (index: number) => Depth, partners: ReadonlyMap<number, number>, layered: FrontLane, width: number) {
  const groups = cast.reduce<number[][]>((all, _, index) => {
    const last = all.at(-1);
    if (last?.length === 1 && partners.get(last[0]!) === index) last.push(index);
    else all.push([index]);
    return all;
  }, []);
  const crowdAt = (k: number) => !!groups[k] && depthOf(groups[k]![0]!) > 0;
  const flipped = new Set(groups.flatMap((group, k) => group.length === 1 && depthOf(group[0]!) === 0 && cast[group[0]!]!.rest !== "sleep" &&
    crowdAt(k + 1) && !crowdAt(k - 1) ? group : []));
  const labelLeft = (index: number) => flipped.has(index) || layered.labelLeft(index);
  const extent = (index: number) => {
    const { left, right } = layered.extent(index);
    return flipped.has(index) ? { left: right, right: left } : { left, right };
  };
  const lane: FrontLane = { ...layered, labelLeft, extent };
  const span = ([first, mate]: number[]) => {
    const depth = depthOf(first!);
    if (depth > 0) return 32 * STAGE_DEPTHS[depth]!.scale + (mate === undefined ? 0 : crowdPairReach(depth));
    return lane.extent(first!).left + 32 + (mate === undefined ? lane.extent(first!).right : PAIR_GAP + 32 + lane.extent(mate).right);
  };
  const spans = groups.map(span);
  const air = (width - 4 - spans.reduce((sum, one) => sum + one, 0)) / (groups.length + 1);
  if (air < EVEN_AIR) return null;
  const x = new Map<number, number>();
  const crowd = new Map<number, CrowdPlace>();
  let left = 2 + air;
  groups.forEach((group, k) => {
    const depth = depthOf(group[0]!);
    if (depth === 0) group.forEach((index, member) => x.set(index, left + lane.extent(group[0]!).left + member * (32 + PAIR_GAP)));
    else {
      const { scale, lift, z } = STAGE_DEPTHS[depth]!;
      const centre = left + spans[k]! / 2;
      group.forEach((index, member) => crowd.set(index, { x: centre + (member - (group.length - 1) / 2) * crowdPairReach(depth) - 16, scale, lift, z }));
    }
    left += spans[k]! + air;
  });
  return { lane: { ...lane, x }, crowd };
}

/** How far apart a crowd pair's members stand at ease, centre to centre: a short walk to meet. */
function crowdPairReach(depth: Depth) {
  return 34 * STAGE_DEPTHS[depth]!.scale + 2 * PAIR_STROLL;
}

/** The crowd behind the front lane: spread evenly over the floor the front gnomes' bodies leave free,
 *  smaller and staggered when packed. A pair stands together as one group, so its meeting is a short
 *  walk wherever the floor puts it. */
function crowdPlaces(crowd: number[], depthOf: (index: number) => Depth, partners: ReadonlyMap<number, number>, lane: FrontLane, width: number) {
  const free = freeFloor(lane, width);
  const length = free.reduce((sum, [left, right]) => sum + right - left, 0);
  const pitch = length / Math.max(1, crowd.length);
  const groups = crowd.reduce<number[][]>((all, index) => {
    const last = all.at(-1);
    if (last?.length === 1 && partners.get(last[0]!) === index) last.push(index);
    else all.push([index]);
    return all;
  }, []);
  const share = length / Math.max(1, groups.reduce((sum, group) => sum + (group.length > 1 ? PAIR_SHARE : 1), 0));
  const midScale = Math.max(0.56, Math.min(STAGE_DEPTHS[1]!.scale, STAGE_DEPTHS[1]!.scale * pitch / 22));
  const backScale = Math.max(0.42, Math.min(STAGE_DEPTHS[2]!.scale, STAGE_DEPTHS[2]!.scale * pitch / 18));
  let k = 0;
  const plans = groups.map((group): CrowdPlan => {
    const weight = group.length > 1 ? PAIR_SHARE : 1;
    const scales = group.map((index, member) => {
      // A packed crowd staggers, every other gnome a step further up the floor.
      const staggered = pitch < CROWD_MIN_SLOT + 2 && (k + member) % 2 === 1;
      return { index, staggered, scale: (depthOf(index) === 1 ? midScale : backScale) * (staggered ? 0.94 : 1) };
    });
    k += group.length;
    const wanted = group.length > 1 ? Math.min(34 * Math.max(...scales.map((one) => one.scale)) + 2 * PAIR_STROLL, weight * share) : 0;
    return { weight, scales, wanted, depth: depthOf(group[0]!) };
  });
  // A lane keeps CROWD_MIN_SLOT between neighbouring groups; one too full for that squeezes its gaps
  // and its pairs' walks alike until it fits the floor, front bodies and all.
  let fit = ([0, 1, 2] as const).map((depth) => {
    const needed = plans.reduce((sum, plan) => plan.depth === depth ? sum + plan.wanted + CROWD_MIN_SLOT : sum, 0);
    return needed > length ? length / needed : 1;
  });
  let crowded = standCrowd(plans, fit, free, share, width, depthOf);
  for (let attempt = 0; attempt < 8 && crowded.debt.some((debt) => debt > 0.5); attempt++) {
    fit = fit.map((squeeze, depth) => squeeze * length / (length + crowded.debt[depth]!));
    crowded = standCrowd(plans, fit, free, share, width, depthOf);
  }
  return crowded.places;
}

interface CrowdPlan { weight: number; scales: { index: number; staggered: boolean; scale: number }[]; wanted: number; depth: Depth }

/** Stands each crowd group near its even share of the floor, at least a squeezed CROWD_MIN_SLOT right
 *  of the last group in its lane. `debt` is how far each lane ran out of floor for that. */
function standCrowd(plans: readonly CrowdPlan[], fit: readonly number[], free: readonly [number, number][], share: number, width: number, depthOf: (index: number) => Depth) {
  const places = new Map<number, CrowdPlace>();
  // Rightmost gnome centre placed so far in each lane: a group never stands inside another one's span.
  const edge = [-Infinity, -Infinity, -Infinity];
  const debt = [0, 0, 0];
  let walked = 0;
  for (const { weight, scales, wanted: roomy, depth: laneDepth } of plans) {
    const wanted = roomy * fit[laneDepth]!;
    const min = edge[laneDepth]! + CROWD_MIN_SLOT * fit[laneDepth]! + wanted / 2;
    const spot = free.length ? settle(free, Math.max(min, along(free, (walked + weight / 2) * share)), wanted / 2 + 6, weight * share / 2, min) : { centre: width / 2, half: wanted / 2 + 6 };
    const centre = spot.centre, spread = Math.max(0, 2 * (spot.half - 6));
    scales.forEach(({ index, staggered, scale }, member) => {
      const depth = depthOf(index);
      const wish = centre + (member - (scales.length - 1) / 2) * spread - 16;
      const x = Math.max(16 * scale - 16, Math.min(width - 16 - 16 * scale, wish));
      debt[depth] = Math.max(debt[depth]!, member === 0 ? min - centre : 0, wish - x);
      places.set(index, { x, scale, lift: STAGE_DEPTHS[depth]!.lift + (staggered ? 3 : 0), z: STAGE_DEPTHS[depth]!.z - (staggered ? 1 : 0) });
      edge[depth] = Math.max(edge[depth]!, x + 16);
    });
    walked += weight;
  }
  return { places, debt };
}

/** Stretches of floor clear of every front gnome's body, left to right. */
function freeFloor(lane: FrontLane, width: number) {
  const bodies = lane.order.map((index) => [lane.x.get(index)! - BODY_CLEAR, lane.x.get(index)! + 32 + BODY_CLEAR] as const);
  const end = width - 2;
  const free: [number, number][] = [];
  let from = 2;
  for (const [left, right] of bodies) {
    if (left > from) free.push([from, Math.min(left, end)]);
    from = Math.max(from, right);
  }
  if (end > from) free.push([from, end]);
  return free.filter(([left, right]) => right > left);
}

/** The spot `distance` along the free floor, skipping the stretches front bodies cover. */
function along(free: readonly [number, number][], distance: number) {
  for (const [left, right] of free) {
    if (distance <= right - left) return left + distance;
    distance -= right - left;
  }
  return free.at(-1)?.[1] ?? 0;
}

/** Where a group stands so `half` of floor either side of its centre lies inside one free stretch and
 *  neither member stands behind a front body, its centre no further left than `min`: the nearest such
 *  spot within `reach`, or else squeezed closer together in the stretch it was given, so groups never
 *  pile up on one far stretch. */
function settle(free: readonly [number, number][], centre: number, half: number, reach: number, min = -Infinity) {
  let best: { centre: number; half: number } | undefined, moved = reach;
  for (const [left, right] of free) {
    const low = Math.max(left + half, min);
    if (right - half < low) continue;
    const spot = Math.max(low, Math.min(right - half, centre));
    if (Math.abs(spot - centre) <= moved) { best = { centre: spot, half }; moved = Math.abs(spot - centre); }
  }
  if (best) return best;
  const distance = ([left, right]: readonly [number, number]) => centre < left ? left - centre : centre > right ? centre - right : 0;
  const ahead = free.filter(([, right]) => right > min);
  const [left, right] = (ahead.length ? ahead : free).reduce((near, stretch) => distance(stretch) < distance(near) ? stretch : near);
  const squeezed = Math.min(half, (right - left) / 2);
  return { centre: Math.max(left + squeezed, Math.min(right - squeezed, centre)), half: squeezed };
}

/** How far (screen px, signed) a gnome without a partner strolls on its loop: toward the side with
 *  room, never into a front neighbour's label, never off the stage, and only halfway to a neighbour in
 *  its own lane that may be strolling toward it. A front gnome heads where it passes the most crowd,
 *  further than its usual amble when the nearest crowd gnome stands that far off; a crowd gnome in a
 *  front gnome's path walks against it, so the two visibly cross. */
function stroll(actors: readonly StageActor[], index: number, lane: FrontLane, width: number, front: ReadonlyMap<number, number>, escorting?: number) {
  const actor = actors[index]!;
  const escorted = escorting === undefined ? undefined : actors[escorting]!;
  const limit = (side: 1 | -1) => actor.depth === 0 ? passingStroll(actors, actor, side) : escorted
    ? Math.max(STROLL[actor.depth], Math.min(FRONT_STROLL_MAX * actor.scale, clearance(escorted, actor) - Math.abs(front.get(escorting!)!)))
    : STROLL[actor.depth];
  const room = actor.depth === 0 ? frontRoom(actors, index, lane, width) : crowdRoom(actors, index, width);
  const reach = (side: 1 | -1) => Math.min(limit(side), side > 0 ? room.right : room.left);
  const passes = (side: 1 | -1) => actor.depth > 0 ? 0 : actors.filter((behind) => {
    if (behind.depth === 0) return false;
    const centre = behind.x + 16;
    return side > 0 ? centre > actor.x + 16 && centre < actor.x + 32 + reach(1) : centre < actor.x + 16 && centre > actor.x - reach(-1);
  }).length;
  const centre = actor.x + 16;
  const passer = actor.depth === 0 ? undefined : escorting !== undefined ? [escorting, front.get(escorting)!] as const : [...front].find(([i, travel]) => {
    const x = actors[i]!.x;
    return travel !== 0 && centre > x + Math.min(0, travel) - 8 && centre < x + 32 + Math.max(0, travel) + 8;
  });
  const preferred: 1 | -1 = actor.depth === 0 ? passes(-1) > passes(1) ? -1 : 1
    : passer ? passer[1] > 0 ? -1 : 1 : index % 2 === 0 ? 1 : -1;
  const other = -preferred as 1 | -1;
  const direction = passes(preferred) > 0 || reach(preferred) >= reach(other) ? preferred : other;
  return direction * reach(direction);
}

/** How far a front gnome strolls toward `side`: its usual amble, or far enough to carry its body clear
 *  past the nearest crowd gnome that way, up to FRONT_STROLL_MAX. */
function passingStroll(actors: readonly StageActor[], actor: StageActor, side: 1 | -1) {
  const clear = actors.filter((behind) => behind.depth > 0 && sideOf(actor, behind) === side).map((behind) => clearance(actor, behind));
  return clear.length ? Math.max(STROLL[0], Math.min(FRONT_STROLL_MAX, ...clear)) : STROLL[0];
}

/** Which way `behind` stands from a front gnome, and how far that gnome walks to carry its body clear past it. */
function sideOf(front: StageActor, behind: StageActor) {
  return behind.x + 16 > front.x + 16 ? 1 : -1;
}
function clearance(front: StageActor, behind: StageActor) {
  const centre = behind.x + 16, half = 16 * behind.scale;
  return sideOf(front, behind) > 0 ? centre + half + 2 - front.x : front.x + 32 + 2 - (centre - half);
}

/** On a sparse stage a front gnome's stroll may stop short of every crowd gnome. Each such stroller
 *  takes the nearest crowd gnome ahead of it as its escort, which walks toward it on the same beat
 *  (its scale's share of the front's reach), so the two still cross. Front index by escort index. */
function escortsFor(actors: readonly StageActor[], strolls: ReadonlyMap<number, number>) {
  const escorts = new Map<number, number>();
  actors.forEach((actor, index) => {
    const travel = strolls.get(index) ?? 0;
    if (actor.depth > 0 || travel === 0) return;
    const ahead = actors.flatMap((behind, k) => behind.depth > 0 && behind.partner < 0 && !behind.seat.rest && !behind.seat.freezeReason &&
      sideOf(actor, behind) === Math.sign(travel) ? [{ k, short: clearance(actor, behind) - Math.abs(travel) }] : []);
    if (!ahead.length || ahead.some(({ short }) => short <= 0)) return;
    const nearest = ahead.reduce((best, one) => one.short < best.short ? one : best);
    if (!escorts.has(nearest.k) && nearest.short <= FRONT_STROLL_MAX * actors[nearest.k]!.scale) escorts.set(nearest.k, index);
  });
  return escorts;
}

/** Clear floor on either side of a front gnome, up to its front neighbours' labels. A neighbour that
 *  may stroll toward it (one without a partner) leaves only half. */
function frontRoom(actors: readonly StageActor[], index: number, lane: FrontLane, width: number) {
  const k = lane.order.indexOf(index);
  const edges = (i: number) => ({ left: lane.x.get(i)! - lane.extent(i).left, right: lane.x.get(i)! + 32 + lane.extent(i).right });
  const own = edges(index);
  const previous = lane.order[k - 1], next = lane.order[k + 1];
  const walker = (i: number) => actors[i]!.partner < 0 && !actors[i]!.seat.rest && !actors[i]!.seat.freezeReason;
  const right = next === undefined ? width - 2 - own.right : (edges(next).left - 6 - own.right) / (walker(next) ? 2 : 1);
  const left = previous === undefined ? own.left - 2 : (own.left - edges(previous).right - 6) / (walker(previous) ? 2 : 1);
  return { left: Math.max(0, left), right: Math.max(0, right) };
}

/** Clear floor on either side of a crowd gnome: the stage edges, and half the gap to the nearest
 *  gnome in its own lane. */
function crowdRoom(actors: readonly StageActor[], index: number, width: number) {
  const actor = actors[index]!;
  const half = 16 * actor.scale, centre = actor.x + 16;
  let right = width - 1 - centre - half, left = centre - half - 1;
  for (const other of actors) {
    if (other === actor || other.depth !== actor.depth) continue;
    const distance = other.x + 16 - centre;
    const clear = (Math.abs(distance) - half - 16 * other.scale) / 2;
    if (distance > 0) right = Math.min(right, clear);
    else if (distance < 0) left = Math.min(left, clear);
  }
  return { left: Math.max(0, left), right: Math.max(0, right) };
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
