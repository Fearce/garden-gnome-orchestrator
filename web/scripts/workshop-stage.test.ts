/**
 * Gate: the beta workshop's depth stage, and the promises the owner asked for.
 *
 *   npm run test:workshop-stage --prefix server
 *
 *   · every own gnome stands on the stage at any width; visitors only take room that is left over,
 *   · lanes follow recency: the freshest own gnome holds the front, quiet gnomes recede with age,
 *     the front has limited places, and a full lane pushes its stalest member back,
 *   · lane changes made for age or freed room wait out a dwell (no jitter); a new message never waits,
 *   · the layout keeps every gnome inside the stage, draws further lanes smaller, higher and behind, and
 *     never puts a front label over another front gnome nor hides a crowd gnome behind a front body,
 *   · the lanes share one floor: front gnomes stroll past the crowd behind them (the owner's "walk past
 *     the gnomes in the back"), never off the stage and never into a front neighbour's label,
 *   · walks take a believable time instead of a teleport.
 */

import assert from "node:assert/strict";
import type { ChatMessage, GnomeRole } from "../src/types.js";
import {
  DEPTH_DWELL_MS, FRONT_IDLE_MS, MID_IDLE_MS, assignDepths, lastSpoken, stageCapacity, stageCast, stageLayout, walkDuration,
  type Depth, type DepthEntry, type DepthMemory, type WorkshopSeat,
} from "../src/lib/workshopStage.js";

const NOW = 1_800_000_000_000;
const roles: GnomeRole[] = ["implementor", "qa", "planner", "researcher", "reviewer", "reader"];

function worker(index: number, extra: Partial<WorkshopSeat> = {}): WorkshopSeat {
  return { id: `w${index}`, role: roles[index % roles.length]!, name: `Gnome ${index}`, room: `repo:r${index % 4}`, task: `Task ${index}`,
    group: `C:\\repo${index % 4}`, active: true, runId: `run-${index}`, threadId: `thread-${index}`, ...extra };
}
const director: WorkshopSeat = { id: "director", role: "director", name: "Merlin", room: "directors", task: "Directing", group: "", active: true };
function visitor(index: number, group = `C:\\elsewhere${index}`): WorkshopSeat {
  return { id: `remote:${index}`, role: "qa", name: `Visitor ${index}`, room: `repo:v${index}`, task: "Visiting", group, active: true, remote: "North studio" };
}
function crew(count: number) { return [director, ...Array.from({ length: count }, (_, i) => worker(i))]; }

function entry(id: string, quietMs: number, extra: Partial<DepthEntry> = {}): DepthEntry {
  return { id, recency: NOW - quietMs, spokeAt: 0, guest: false, floor: 0, ...extra };
}
function depthsOf(result: ReturnType<typeof assignDepths>) { return Object.fromEntries(result.depths); }

function castKeepsEveryOwnGnome() {
  for (const width of [90, 240, 617, 1100]) {
    for (const count of [0, 1, 4, 15, 30]) {
      const own = crew(count);
      const cast = stageCast([...own, ...Array.from({ length: 6 }, (_, i) => visitor(i))], width);
      for (const seat of own) assert(cast.some((member) => member.id === seat.id), `${width}px/${count}: own gnome ${seat.id} must be on stage`);
    }
  }
  const roomy = stageCast([...crew(2), visitor(0), visitor(1)], 1100);
  assert.equal(roomy.filter((seat) => seat.remote).length, 2, "visitors join while the stage has room");
  const packed = stageCast([...crew(30), visitor(0), visitor(1)], 400);
  assert.equal(packed.filter((seat) => seat.remote).length, 0, "visitors step aside before any own gnome would be squeezed further");
  const frozen = stageCast([worker(0, { freezeReason: "cap" }), worker(1), director], 900);
  assert.equal(frozen.at(-1)!.id, "w0", "frozen workers wait at the end of the floor");
  const teammate = stageCast([worker(0), worker(1), visitor(0, worker(0).group)], 900);
  assert.equal(teammate.findIndex((seat) => seat.remote) - teammate.findIndex((seat) => seat.id === "w0"), 1, "a visitor stands beside its local teammate");
}

function lanesFollowRecency() {
  const capacity = { front: 2, mid: 3 };
  const result = assignDepths([entry("a", 10_000), entry("b", FRONT_IDLE_MS + 1), entry("c", MID_IDLE_MS + 1), entry("d", 60_000), entry("e", 5_000)], new Map(), capacity, NOW);
  assert.deepEqual(depthsOf(result), { e: 0, a: 0, d: 1, b: 1, c: 2 }, "front holds the two freshest; a full front pushes its stalest back; age sends the quiet back");
  const quiet = assignDepths([entry("a", MID_IDLE_MS * 4), entry("b", MID_IDLE_MS * 3)], new Map(), capacity, NOW);
  assert.equal(depthsOf(quiet).b, 0, "even in a silent office the freshest own gnome holds the front");
  assert.equal(depthsOf(quiet).a, 2);
  const crowd = assignDepths(Array.from({ length: 40 }, (_, i) => entry(`g${i}`, i * 1000)), new Map(), { front: 3, mid: 8 }, NOW);
  const lanes = [0, 1, 2].map((depth) => [...crowd.depths.values()].filter((value) => value === depth).length);
  assert.deepEqual(lanes, [3, 8, 29], "lanes fill to capacity and the back row takes everyone else");
  assert.equal(result.wakeAt, NOW - 60_000 + FRONT_IDLE_MS, "the next lane decision waits for the nearest idle threshold, not a polling clock");
}

function guestsWaitUnlessTheySpoke() {
  const capacity = { front: 1, mid: 1 };
  const quietGuest = assignDepths([entry("guest", 0, { guest: true }), entry("own", 120_000)], new Map(), capacity, NOW);
  assert.deepEqual(depthsOf(quietGuest), { own: 0, guest: 1 }, "a quiet visitor takes places after own gnomes");
  const speakingGuest = assignDepths([entry("guest", 0, { guest: true, spokeAt: NOW - 2000 }), entry("own", 120_000)], new Map(), { front: 2, mid: 1 }, NOW);
  assert.equal(depthsOf(speakingGuest).guest, 0, "a visitor who just spoke walks to the front too");
  assert.equal(depthsOf(speakingGuest).own, 0, "but never pushes the anchoring own gnome off it");
  const frozen = assignDepths([entry("ice", 0, { floor: 1 }), entry("own", 10_000)], new Map(), capacity, NOW);
  assert.deepEqual(depthsOf(frozen), { own: 0, ice: 1 }, "a frozen worker waits one lane back");
  const pair = assignDepths([entry("lead", MID_IDLE_MS * 2), entry("other", 1000), entry("guest", MID_IDLE_MS * 2, { guest: true, follows: "lead" })], new Map(), { front: 1, mid: 4 }, NOW);
  assert.deepEqual(depthsOf(pair), { other: 0, lead: 2, guest: 2 }, "a visitor stands in its local teammate's lane, wherever that is");
  const anchoredPair = assignDepths([entry("lead", MID_IDLE_MS * 2), entry("guest", MID_IDLE_MS * 2, { guest: true, follows: "lead" })], new Map(), { front: 3, mid: 4 }, NOW);
  assert.deepEqual(depthsOf(anchoredPair), { lead: 0, guest: 0 }, "and joins it at the front when the teammate anchors the stage");
}

function dwellPreventsJitter() {
  const capacity = { front: 2, mid: 4 };
  const memory = new Map<string, DepthMemory>([["a", { depth: 0, at: NOW - 5000, spokeAt: 0 }]]);
  const held = assignDepths([entry("a", FRONT_IDLE_MS + 500), entry("b", 1000)], memory, capacity, NOW);
  assert.equal(depthsOf(held).a, 0, "a gnome that just changed lanes stays put through its dwell");
  assert.equal(held.wakeAt, NOW - 5000 + DEPTH_DWELL_MS, "and the stage re-decides the moment the dwell ends");
  const after = assignDepths([entry("a", FRONT_IDLE_MS + 500 + DEPTH_DWELL_MS), entry("b", 1000 + DEPTH_DWELL_MS)], held.memory, capacity, NOW + DEPTH_DWELL_MS);
  assert.equal(depthsOf(after).a, 1, "after the dwell it recedes");
  const back = new Map<string, DepthMemory>([["a", { depth: 2, at: NOW - 1000, spokeAt: 0 }], ["b", { depth: 0, at: NOW - 60_000, spokeAt: 0 }]]);
  const spoke = assignDepths([entry("a", 0, { spokeAt: NOW }), entry("b", 30_000)], back, capacity, NOW);
  assert.equal(depthsOf(spoke).a, 0, "a new message walks a gnome forward even mid-dwell");
  const full = new Map<string, DepthMemory>([["a", { depth: 0, at: NOW - 1000, spokeAt: 0 }], ["b", { depth: 0, at: NOW - 1000, spokeAt: 0 }]]);
  const squeezed = assignDepths([entry("a", 50_000), entry("b", 40_000), entry("c", 0, { spokeAt: NOW })], full, capacity, NOW);
  assert.equal(depthsOf(squeezed).c, 0, "a speaker reaches the front");
  assert.equal([...squeezed.depths.values()].filter((depth) => depth === 0).length, 2, "and a full front never overflows, dwell or not");
  assert.equal(depthsOf(squeezed).a, 1, "the stalest front gnome makes room");
}

function spokenIsMatchedToTheRightGnome() {
  const seats = [director, worker(0), worker(1), visitor(0)];
  const message = (extra: Partial<ChatMessage>): ChatMessage => ({ id: String(Math.random()), room: "general", scope: "general" as ChatMessage["scope"], role: "implementor", kind: "chat", body: "hi", createdAt: NOW, ...extra });
  const spoken = lastSpoken([
    message({ runId: "run-1", createdAt: NOW - 50 }),
    message({ threadId: "thread-1", createdAt: NOW - 10 }),
    message({ role: "director", createdAt: NOW - 30 }),
    message({ remoteInstance: "North studio", senderName: "Visitor 0", role: "qa", createdAt: NOW - 20 }),
    message({ kind: "system", runId: "run-0", createdAt: NOW }),
  ], seats);
  assert.deepEqual(Object.fromEntries(spoken), { w1: NOW - 10, director: NOW - 30, "remote:0": NOW - 20 }, "messages map to their speaker; system lines never count");
}

function layoutStaysOnStage() {
  for (const width of [120, 300, 617, 900, 1084, 1400]) {
    for (const count of [0, 1, 3, 8, 16, 30]) {
      const cast = stageCast(crew(count), width);
      const capacity = stageCapacity(width, cast.length);
      const entries = cast.map((seat, index) => entry(seat.id, index * 70_000));
      const { depths } = assignDepths(entries, new Map(), capacity, NOW);
      const actors = stageLayout(cast, depths, width);
      assert.equal(actors.length, cast.length);
      for (const actor of actors) {
        const left = actor.x + 16 - 16 * actor.scale;
        const right = left + 32 * actor.scale;
        assert(left >= -0.5 && right <= width + 0.5, `${width}px/${count}: ${actor.seat.id} stands at ${left.toFixed(1)}…${right.toFixed(1)}`);
      }
      const body = (actor: typeof actors[number], offset = 0) => {
        const left = actor.x + 16 - 16 * actor.scale + offset * actor.scale;
        return [left, left + 32 * actor.scale] as const;
      };
      const label = (actor: typeof actors[number], offset = 0) => actor.labelLeft
        ? [actor.x + offset - actor.labelWidth - 4, actor.x + offset] as const : [actor.x + offset + 32, actor.x + offset + 36 + actor.labelWidth] as const;
      const apart = (a: readonly [number, number], b: readonly [number, number]) => a[1] <= b[0] + 1 || a[0] >= b[1] - 1;
      const front = actors.filter((actor) => actor.depth === 0);
      for (const actor of front.filter((candidate) => candidate.seat.rest !== "sleep")) {
        for (const other of front) {
          if (other === actor) continue;
          for (const offset of [0, actor.travel]) {
            assert(apart(label(actor, offset), body(other)) && apart(label(actor, offset), body(other, other.travel)),
              `${width}px/${count}: ${actor.seat.id}'s label (stroll ${offset.toFixed(1)}) covers front gnome ${other.seat.id}`);
            assert(apart(body(actor, offset), label(other)) && apart(body(actor, offset), body(other)),
              `${width}px/${count}: ${actor.seat.id} strolls (${offset.toFixed(1)}) into front gnome ${other.seat.id}`);
          }
        }
      }
      for (const actor of actors) {
        const [left, right] = body(actor, actor.travel);
        assert(left >= -0.5 && right <= width + 0.5, `${width}px/${count}: ${actor.seat.id} strolls off stage to ${left.toFixed(1)}…${right.toFixed(1)}`);
        if (actor.depth === 0) continue;
        const centre = actor.x + 16;
        for (const near of front) assert(centre <= near.x + 2 || centre >= near.x + 30, `${width}px/${count}: ${actor.seat.id} stands hidden behind ${near.seat.id}`);
      }
      for (const actor of actors) {
        const expected = [1, 0.72, 0.54][actor.depth]!;
        assert(actor.scale <= expected + 1e-9 && (actor.depth === 0 ? actor.scale === 1 : actor.scale < 1), `${actor.seat.id}: lane ${actor.depth} scale ${actor.scale}`);
      }
      const byDepth = (depth: Depth) => actors.filter((actor) => actor.depth === depth);
      for (const actor of actors) {
        const partner = actors[actor.partner];
        if (actor.depth === 0 || !partner) continue;
        const [from, to] = [Math.min(actor.x, partner.x), Math.max(actor.x, partner.x)];
        const between = byDepth(actor.depth).find((other) => other !== actor && other !== partner && other.x > from && other.x < to);
        assert(!between, `${width}px/${count}: ${between?.seat.id} stands between partners ${actor.seat.id} and ${partner.seat.id} in lane ${actor.depth}`);
      }
      for (const [near, far] of [[0, 1], [1, 2]] as const) {
        for (const a of byDepth(near)) for (const b of byDepth(far)) {
          assert(a.lift < b.lift && a.z > b.z && a.scale > b.scale, `${width}px/${count}: lane ${far} must stand higher, smaller and behind lane ${near}`);
        }
      }
    }
  }
}

function frontWalksPastTheCrowd() {
  for (const [width, count] of [[617, 16], [617, 30], [1100, 16], [437, 16]] as const) {
    const cast = stageCast(crew(count), width);
    const capacity = stageCapacity(width, cast.length);
    const { depths } = assignDepths(cast.map((seat, index) => entry(seat.id, index * 70_000)), new Map(), capacity, NOW);
    const actors = stageLayout(cast, depths, width);
    const front = actors.filter((actor) => actor.depth === 0);
    const crowd = actors.filter((actor) => actor.depth > 0);
    assert(front.length >= 2 && crowd.length > 0, `${width}px/${count}: a front lane and a crowd`);
    const passes = front.filter((actor) => {
      const from = actor.x + Math.min(0, actor.travel), to = actor.x + 32 + Math.max(0, actor.travel);
      return Math.abs(actor.travel) >= 12 && crowd.some((behind) => behind.x + 16 > from && behind.x + 16 < to);
    });
    assert(passes.length >= Math.ceil(front.length / 2), `${width}px/${count}: front gnomes stroll past the crowd (${passes.length}/${front.length})`);
    const spanOf = (group: typeof actors) => [Math.min(...group.map((actor) => actor.x)), Math.max(...group.map((actor) => actor.x))];
    const [frontLeft, frontRight] = spanOf(front), [crowdLeft, crowdRight] = spanOf(crowd);
    assert(crowdLeft < frontRight && crowdRight > frontLeft && crowd.some((actor) => actor.x > frontLeft && actor.x < frontRight),
      `${width}px/${count}: the crowd stands behind and between the front lane, not in a strip of its own`);
    assert(crowd.every((actor) => Math.abs(actor.travel * actor.scale) < 27), `${width}px/${count}: further back covers less ground`);
  }
}

function walksTakeTime() {
  assert.equal(walkDuration({ x: 100, depth: 0 }, { x: 100, depth: 0 }), 0, "standing still is not a walk");
  const forward = walkDuration({ x: 300, depth: 2 }, { x: 300, depth: 0 });
  assert(forward >= 700 && forward <= 3200, `a lane change is walked (${forward}ms)`);
  const across = walkDuration({ x: 0, depth: 2 }, { x: 600, depth: 0 });
  assert(across > forward && across <= 3200, `a longer walk takes longer, within a believable bound (${across}ms)`);
}

castKeepsEveryOwnGnome();
lanesFollowRecency();
guestsWaitUnlessTheySpoke();
dwellPreventsJitter();
spokenIsMatchedToTheRightGnome();
layoutStaysOnStage();
frontWalksPastTheCrowd();
walksTakeTime();
console.log("workshop-stage: PASS (own gnomes first, recency lanes, dwell, layout bounds, strolls past the crowd, walk timing)");
