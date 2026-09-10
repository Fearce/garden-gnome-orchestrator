/* scene.ts: the rigging maths behind the screensaver.
 *
 * Everything here is a pure function of numbers, so it is unit-testable without a DOM and so a
 * gnome's pose is solved rather than tweened. The one real piece of work is the rigging. A worker is
 * anchored at a fixed hook on the beam; given the point on the build its tool should land on, we
 * solve the two unknowns of a pendulum on a hook:
 *
 *     impact = anchor + rot(theta) . (IMPACT_DX, ropeLength + IMPACT_DY)
 *
 * so ropeLength and theta both fall out of one target. That is why the gnome leans further off plumb
 * as he traverses up the rafter, and why he rises as his own build gets taller, without a single
 * hand-placed keyframe.
 */

import { IMPACT, PLOT_VB, ROPE_X, VB_W, DROP_VB } from "./rig.js";

// ---- rig geometry, derived once from the drawing ------------------------------------------------
export const RIG_W = 96; // rendered width of the gnome, px
const SCALE = RIG_W / VB_W;
export const RIG_LEFT = -ROPE_X * SCALE; // the rig hangs left of the rope by its own rope column
export const IMPACT_DX = IMPACT.x * SCALE + RIG_LEFT; // impact, px right of the rope
export const IMPACT_DY = IMPACT.y * SCALE; //             impact, px below the rig's top
export const DROP_LEFT = DROP_VB.x * SCALE + RIG_LEFT; // a released tool: px right of the rope,
export const DROP_TOP = DROP_VB.y * SCALE; //             px below the rig's top, and its width
export const DROP_W = DROP_VB.w * SCALE;

/** The hook sits this far left of its card: just outside it, so a gnome reads as THIS card's worker
 *  rather than the previous card's (his body hangs from the rope leftward, so a hook mid-gutter puts
 *  him on the wrong side).
 *
 *  The rope then crosses the card's top corner on its way down, and no gutter avoids that: the gnome
 *  has to hang OVER the work for his tool to reach it, so the rope leans in far above the card and is
 *  already inside it by the title. Keeping it clear of the title would take a gutter of several
 *  hundred pixels, which puts the worker on somebody else's card. It reads as a rope in front of the
 *  card, which is exactly what it is, and the workers are painted above the cards for the same
 *  reason. */
export const GUTTER = 9;

// ---- timing (seconds) ---------------------------------------------------------------------------
export const DESCEND = 1.05; // rappel in
export const ASCEND = 0.85; // haul out at a handoff or when finished
export const SLIP = 0.55; // how long the rope takes to slip and settle on a failure

// ---- easing --------------------------------------------------------------------------------------

/** A CSS cubic-bezier, solved in JS, so the rappel and the haul can be authored the same way the CSS
 *  loops are instead of as hand-rolled polynomials. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const slope = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 6; i++) {
      const err = sampleX(t) - x;
      if (Math.abs(err) < 1e-5) break;
      const d = slope(t);
      if (Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    return sampleY(t);
  };
}

/** He kicks off the beam, drops fast, brakes late and the rope stretches a little past the stop
 *  before pulling him back: the y2 > 1 control point IS the brake bounce. */
export const RAPPEL = cubicBezier(0.32, 0.03, 0.3, 1.24);
export const SWING_IN = cubicBezier(0.3, 0.45, 0.25, 1); // the sideways swing onto the work
export const EASE_IO = cubicBezier(0.55, 0, 0.45, 1);

/** Hauling out is not one smooth glide: it is four hand-over-hand pulls, each a quick heave that
 *  decelerates as he re-grips. */
export function pulls(u: number, n = 4): number {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  const i = Math.floor(u * n);
  const local = u * n - i;
  return (i + (1 - Math.pow(1 - local, 2.6))) / n;
}

/** The rope gives way, then the belay bites: a fast 22px drop, then a settle back to 15. */
export function slipAmount(u: number): number {
  if (u >= 1) return 15;
  const fall = 22 * (1 - Math.pow(1 - Math.min(u / 0.35, 1), 3));
  const settle = u > 0.35 ? 7 * (1 - Math.pow(1 - (u - 0.35) / 0.65, 2)) : 0;
  return fall - settle;
}

// ---- where he works --------------------------------------------------------------------------------

/** Where the gnome's tool lands, per progress: he works the left post, then traverses up the rafter
 *  to the ridge. That is why the build is never hidden behind him early on, and why he visibly
 *  climbs his own work as it rises. Coordinates are PLOT_VB units. */
const WORK_PATH = [
  { p: 0.0, x: 12, y: 102 },
  { p: 0.06, x: 12, y: 93 },
  { p: 0.16, x: 12, y: 54 },
  { p: 0.34, x: 15, y: 54 },
  { p: 0.5, x: 10, y: 46 },
  { p: 0.62, x: 32, y: 36 },
  { p: 0.78, x: 55, y: 25 },
  { p: 1.0, x: 74, y: 13 },
];

export function workPointAt(p: number): { x: number; y: number } {
  const first = WORK_PATH[0]!;
  const last = WORK_PATH[WORK_PATH.length - 1]!;
  if (p <= first.p) return { x: first.x, y: first.y };
  for (let i = 1; i < WORK_PATH.length; i++) {
    const b = WORK_PATH[i]!;
    if (p <= b.p) {
      const a = WORK_PATH[i - 1]!;
      const u = (p - a.p) / (b.p - a.p);
      return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
    }
  }
  return { x: last.x, y: last.y };
}

/** The card geometry a worker is rigged against, in scene pixels relative to the overlay. */
export interface CardGeometry {
  anchorX: number;
  plotL: number;
  plotT: number;
  plotW: number;
  plotH: number;
}

/** Where on the card the tool should land, in scene pixels, for a given progress. */
export function targetFor(geo: CardGeometry, progress: number): { x: number; y: number } {
  const wp = workPointAt(progress);
  return {
    x: geo.plotL + (wp.x / PLOT_VB.w) * geo.plotW,
    y: geo.plotT + (wp.y / PLOT_VB.h) * geo.plotH,
  };
}

/** Solve rope length + lean for a target impact point (see the header comment).
 *
 *  Both unknowns come out of one triangle: the hook, the impact point, and the rig's own fixed
 *  offset from its rope. `b` is how far down the rope the impact sits, so the rope itself is `b`
 *  less the impact's depth inside the rig.
 *
 *  The angle is the part with a trap in it. A CSS `rotate(+t)` about the hook swings a point hanging
 *  BELOW it to the LEFT, so the lean is the rig's plumb offset MINUS the target's bearing, not the
 *  other way round. Reversed, the sign error hides while the build is low (a small target offset is
 *  a small angle either way) and only shows once a gnome should be traversing out along his rafter,
 *  at which point he walks off the far side of the board instead of up his own frame. */
export function rigFor(geo: CardGeometry, anchorY: number, target: { x: number; y: number }): { len: number; deg: number } {
  const dx = target.x - geo.anchorX;
  const dy = target.y - anchorY;
  const dist = Math.hypot(dx, dy);
  const b = Math.sqrt(Math.max(1, dist * dist - IMPACT_DX * IMPACT_DX));
  return {
    len: Math.max(0, b - IMPACT_DY),
    deg: (Math.atan2(IMPACT_DX, b) - Math.atan2(dx, dy)) * (180 / Math.PI),
  };
}

/** A longer rope swings slower and through a smaller angle. Written only when the phase changes:
 *  rewriting an animation-duration every frame makes the pendulum stutter. */
export function swayFor(len: number): { dur: number; amp: number } {
  return {
    dur: Math.min(3.6, Math.max(1.6, 1.4 + len / 200)),
    amp: Math.min(1.8, Math.max(0.8, 0.7 + len / 500)),
  };
}
