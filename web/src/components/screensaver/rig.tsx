/* rig.tsx: the drawing half of the screensaver, i.e. the worker gnome and the build he raises.
 *
 * Ported from the `proto/nisse-workers` prototype's nisse.js. Two SVG builders and the numbers that
 * tie them together:
 *
 *   Rig            the rappelling worker gnome. A direct evolution of the console's own
 *                  components/Gnome.tsx: identical hat / beard / nose / pom / robe geometry
 *                  (translated by +17,+2 into a taller viewBox), plus the parts a hanging worker
 *                  needs: a climbing harness, a belay device with a brake hand on the rope,
 *                  dangling legs, and one free arm that swings a tool.
 *   Plot           the "slowly building" timber frame on the task card. Twelve pieces that switch
 *                  on at their own progress threshold, so a task's build visibly advances over its
 *                  lifetime.
 *
 * Every colour is a CSS class, never a fill attribute, so the whole cast is themeable from the
 * token block on `.gs-root` (a presentation attribute cannot hold a var()).
 *
 * FRAME. The rig viewBox is 72x80. The rope enters at x=22 and runs down the gnome's left side into
 * a carabiner at his hip, which leaves the right arm free. The arm pivots at the shoulder (44,38),
 * its hand sits at (50.6,45.7), and every tool is drawn along the forearm axis (49.4 degrees) so it
 * reads as gripped rather than glued on. At the bottom of the swing the tool head lands at IMPACT
 * (58.7,46.5): that one point is what scene.ts aims at the top of the build, and it is where the
 * sparks fire.
 */

import type { CSSProperties, ReactNode } from "react";

/** The tool a role swings. Four genuinely different motions, not one swing recoloured. */
export type Tool = "hammer" | "wrench" | "pickaxe" | "saw" | "gavel";

// ---- rig frame constants (shared with scene.ts) ------------------------------------------------
export const VB_W = 72;
export const VB_H = 80;
export const ROPE_X = 22; // where the rope enters the viewBox
export const IMPACT = { x: 58.7, y: 46.5 }; // where the tool head lands at the bottom of the swing
export const HAND = { x: 50.6, y: 45.7 };
export const ARM_DEG = 49.4; // forearm axis: every tool is drawn along +x and rotated onto it

/** The window of the rig frame a released tool occupies, in rig units. scene.ts sizes and places the
 *  falling element from this, so the tool leaves the mitt at the size and spot it was just being
 *  swung at. */
export const DROP_VB = { x: 44, y: 36, w: 22, h: 18 };

export const PLOT_VB = { w: 150, h: 108 };

/** One tool per role, drawn in the hand's local frame (origin at HAND, blade along +x): the hammer
 *  strikes, the pickaxe chops through a bigger arc, the wrench ratchets a bolt round, the saw
 *  reciprocates. The gavel reuses the hammer's arc with a judge's barrel head. */
function toolPaths(tool: Tool): ReactNode {
  switch (tool) {
    case "wrench":
      return (
        <>
          <path className="gs-steel" d="M47 45.7H56.2" strokeWidth="3" />
          <path className="gs-steel" d="M59.4 42.9A3.1 3.1 0 1 0 59.4 48.5" strokeWidth="2.8" />
        </>
      );
    case "pickaxe":
      return (
        <>
          <path className="gs-haft" d="M46 45.7H57.4" />
          <path className="gs-steel" d="M57.6 39.6C60.6 41.8 60.6 49.6 57.6 51.8" strokeWidth="2.9" />
          <rect className="gs-steel-f" x="56.2" y="44.1" width="2.7" height="3.2" rx="0.8" />
        </>
      );
    case "saw":
      return (
        <>
          <rect className="gs-haft-f" x="46.8" y="43.4" width="3.8" height="4.6" rx="1.5" />
          <path className="gs-steel-f" d="M50.6 43.6H61.6L58.9 47.7H50.6Z" />
          <path className="gs-steel" d="M50.7 47.7l1.15-1.5 1.15 1.5 1.15-1.5 1.15 1.5 1.15-1.5 1.15 1.5" strokeWidth="0.9" />
        </>
      );
    case "gavel":
      return (
        <>
          <path className="gs-haft" d="M47 45.7H56" />
          <rect className="gs-haft-f" x="54.4" y="41.7" width="7.2" height="8" rx="1.9" />
          <path className="gs-steel" d="M56.5 41.7v8M59.5 41.7v8" strokeWidth="1.1" />
        </>
      );
    case "hammer":
    default:
      return (
        <>
          <path className="gs-haft" d="M47.2 45.7H57.6" />
          <path className="gs-steel-f" d="M56 42.4 53 40.3 53.2 43.3Z" />
          <rect className="gs-steel-f" x="56" y="41.7" width="3.9" height="8" rx="1.2" />
        </>
      );
  }
}

/** Each tool's own beat: how long one full swing takes, and where inside that cycle the head lands.
 *  The recoil, the sparks and the rope's kick are all aligned to `impact` by animation-delay rather
 *  than by copying percentages into five keyframe blocks, so a tool can never drift out of sync with
 *  its own consequences. */
export const TOOL_MOTION: Record<Tool, { dur: number; impact: number }> = {
  saw: { dur: 0.62, impact: 0.3 },
  pickaxe: { dur: 1.05, impact: 0.43 },
  hammer: { dur: 0.88, impact: 0.38 },
  wrench: { dur: 1.15, impact: 0.3 },
  gavel: { dur: 0.95, impact: 0.4 },
};

/** Six chips off the work, fired on the impact frame by an animation-delay (screensaver.css).
 *  Direction and reach vary per chip so a burst never reads as a symmetric star. */
const SPARK_VECTORS: [number, number][] = [
  [7.5, -6.5],
  [10, -1.5],
  [4.5, -9],
  [8.5, 3.5],
  [-2.5, -8],
  [2, 6.5],
];

function Sparks() {
  return (
    <g className="gs-sparks">
      {SPARK_VECTORS.map(([sx, sy], i) => (
        <circle
          key={i}
          cx={IMPACT.x}
          cy={IMPACT.y}
          r={1.5 - (i % 3) * 0.32}
          style={{ "--sx": `${sx}px`, "--sy": `${sy}px`, "--sd": i * 0.012 } as CSSProperties}
        />
      ))}
    </g>
  );
}

/** The worker gnome. Draw order is back-to-front and load-bearing: the rope passes behind the
 *  figure, the beard closes over the arm's shoulder so the arm emerges from under it, and the hat
 *  sits in its own group so it can lag the body (overlapping action). */
export function Rig({ tool }: { tool: Tool }) {
  return (
    <svg viewBox={`0 0 ${VB_W} ${VB_H}`} xmlns="http://www.w3.org/2000/svg" focusable="false" aria-hidden="true">
      {/* rope, behind everything, running down into the hip carabiner */}
      <path className="gs-rope-tail" d={`M${ROPE_X} 0V40.4`} />

      {/* legs: they hang free and kick a little, and swing forward when he perches on the beam */}
      <g className="gs-legs">
        <path className="gs-leg" d="M31 48.6 29.4 60.4" />
        <path className="gs-leg" d="M40 48.6 42.6 59.4" />
        <ellipse className="gs-boot" cx="28.5" cy="62.7" rx="4" ry="2.8" transform="rotate(-10 28.5 62.7)" />
        <ellipse className="gs-boot" cx="43.4" cy="61.7" rx="4" ry="2.8" transform="rotate(12 43.4 61.7)" />
        <ellipse className="gs-strap-f" cx="30.6" cy="52.2" rx="3.1" ry="1.5" />
        <ellipse className="gs-strap-f" cx="41" cy="52" rx="3.1" ry="1.5" />
      </g>

      {/* robe: the console gnome's body path, translated into this taller frame */}
      <path className="gs-robe" d="M28 32C24 35 23 43 25 50h20c2-7 1-15-3-18-3 3-11 3-14 0Z" />

      {/* harness: waist belt, two risers down to the leg loops, buckle */}
      <g className="gs-harness">
        <path className="gs-strap" d="M24.2 41.4H45.8" />
        <path className="gs-strap-thin" d="M29.4 42.6 30.5 50.8M41.4 42.6 40.9 50.6" />
        <rect className="gs-buckle" x="33.2" y="39.8" width="4" height="3.2" rx="1" />
      </g>

      {/* belay device + carabiner at the left hip, where the rope actually takes his weight */}
      <g className="gs-belay">
        <ellipse className="gs-steel" cx="22.6" cy="41.2" rx="2.4" ry="3.3" fill="none" strokeWidth="1.5" />
        <rect className="gs-steel-f" x="20.6" y="42.6" width="4.2" height="3.4" rx="1.2" />
      </g>

      {/* brake line: the rope's loose tail, running through his left mitt and curling below */}
      <path className="gs-rope-tail" d="M22.4 45.6C21.4 49 20.2 53 19 58.4" />
      <path className="gs-rope-curl" d="M19 58.4c-2.6 1.6-2 4.4.8 4.2 2.4-.2 3-2.6 1.4-3.6" />
      <path className="gs-limb" d="M27.6 37 21.4 49.6" />
      <circle className="gs-mitt" cx="20.6" cy="50.6" r="2.7" />

      {/* hat + pom, in one group so they droop and wobble together */}
      <g className="gs-hat">
        <path className="gs-hat-cloth" d="M38 7C32 13 27 23 25 33c6-1.5 16-1.5 22 0C45 23 43 13 38 7Z" />
        <circle className="gs-pom" cx="39" cy="7" r="3" />
      </g>

      {/* The working arm: limb, tool, then the mitt closing over the haft.
          The forearm rotation lives on a plain wrapper <g>, never on .gs-tool itself: a CSS
          transform-origin composes with an attribute rotate(a cx cy) into a rotation about twice
          the pivot, which flings the tool clear of the mitt. The wrapper keeps the grip exact and
          leaves .gs-tool free for its own stroke animation. */}
      <g className="gs-arm">
        <path className="gs-limb" d={`M44 38 ${HAND.x} ${HAND.y}`} />
        <g transform={`rotate(${ARM_DEG} ${HAND.x} ${HAND.y})`}>
          <g className="gs-tool">{toolPaths(tool)}</g>
        </g>
        <circle className="gs-mitt" cx={HAND.x} cy={HAND.y} r="2.7" />
      </g>

      {/* beard over the shoulder, then the nose under the brim */}
      <path className="gs-beard" d="M28 32C26 39 29 45 35 48c6-3 9-9 7-16-3 3-11 3-14 0Z" />
      <circle className="gs-nose" cx="35" cy="34.4" r="3" />

      {/* coiled spare rope: only visible while he is perched on the beam, waiting */}
      <g className="gs-coil">
        <ellipse cx="12.5" cy="47.4" rx="5.4" ry="2" fill="none" strokeWidth="1.6" />
        <ellipse cx="12.5" cy="45.2" rx="4.4" ry="1.7" fill="none" strokeWidth="1.6" />
      </g>

      <Sparks />
    </svg>
  );
}

/** The tool he lets go of when a task fails: same drawing, no arm, tumbling. */
export function DroppedTool({ tool }: { tool: Tool }) {
  return (
    <svg
      viewBox={`${DROP_VB.x} ${DROP_VB.y} ${DROP_VB.w} ${DROP_VB.h}`}
      xmlns="http://www.w3.org/2000/svg"
      focusable="false"
      aria-hidden="true"
    >
      <g transform={`rotate(${ARM_DEG} ${HAND.x} ${HAND.y})`}>{toolPaths(tool)}</g>
    </svg>
  );
}

// ---- the build ---------------------------------------------------------------------------------

/** Twelve timber pieces, each with the progress at which it lands. The thresholds are the build
 *  order a real frame goes up in (sill, posts, brace, joist, rafters, ridge, then the openings), so
 *  watching a card fill in reads as construction rather than a loading bar. */
export const PIECES: { at: number; svg: ReactNode }[] = [
  {
    at: 0.0,
    svg: (
      <>
        <path className="gs-b-ground" d="M3 100.5H147" />
        <path className="gs-b-stake" d="M14 100.5v5M136 100.5v5" />
      </>
    ),
  },
  { at: 0.06, svg: <rect className="gs-b-wood" x="6" y="93" width="138" height="7.5" rx="1.6" /> },
  { at: 0.16, svg: <rect className="gs-b-wood" x="8" y="54" width="9" height="39" rx="1.6" /> },
  { at: 0.26, svg: <rect className="gs-b-wood" x="132" y="54" width="9" height="39" rx="1.6" /> },
  { at: 0.34, svg: <rect className="gs-b-wood" x="69" y="58" width="8" height="35" rx="1.6" /> },
  { at: 0.42, svg: <path className="gs-b-beam" d="M19 90 66 62" strokeWidth="6" /> },
  {
    at: 0.5,
    svg: (
      <>
        <rect className="gs-b-wood" x="4" y="46.5" width="141" height="7.5" rx="1.6" />
        <rect className="gs-b-bolt" x="10" y="48.5" width="3.4" height="3.4" rx="1.7" />
        <rect className="gs-b-bolt" x="135" y="48.5" width="3.4" height="3.4" rx="1.7" />
      </>
    ),
  },
  { at: 0.6, svg: <path className="gs-b-beam" d="M6 47 74 14" strokeWidth="7" /> },
  { at: 0.68, svg: <path className="gs-b-beam" d="M143 47 75 14" strokeWidth="7" /> },
  {
    at: 0.76,
    svg: (
      <>
        <rect className="gs-b-wood" x="65" y="8.5" width="20" height="7.5" rx="2.4" />
        <rect className="gs-b-bolt" x="73" y="10.4" width="3.6" height="3.6" rx="1.8" />
      </>
    ),
  },
  {
    at: 0.84,
    svg: (
      <>
        <rect className="gs-b-pane" x="95" y="61" width="27" height="25" rx="1.4" />
        <path className="gs-b-mullion" d="M108.5 61v25M95 73.5h27" />
      </>
    ),
  },
  {
    at: 0.9,
    svg: (
      <>
        <rect className="gs-b-door" x="27" y="63" width="25" height="30" rx="1.6" />
        <circle className="gs-b-bolt" cx="47" cy="79" r="1.7" />
      </>
    ),
  },
  {
    at: 0.985,
    svg: (
      <g className="gs-b-flag">
        <path className="gs-b-pole" d="M75 9V0.5" />
        <path className="gs-b-pennant" d="M75.8 1.2 92 4.6 75.8 8.4Z" />
      </g>
    ),
  },
];

/** The y of the ground line inside PLOT_VB, i.e. where a dropped tool comes to rest. */
export const GROUND_Y = 100.5;

export function Plot() {
  return (
    <svg
      viewBox={`0 0 ${PLOT_VB.w} ${PLOT_VB.h}`}
      xmlns="http://www.w3.org/2000/svg"
      preserveAspectRatio="xMidYMax meet"
      focusable="false"
      aria-hidden="true"
    >
      {PIECES.map((piece, i) => (
        <g className="gs-b-piece" data-at={piece.at} data-i={i} key={i}>
          {piece.svg}
        </g>
      ))}
    </svg>
  );
}
