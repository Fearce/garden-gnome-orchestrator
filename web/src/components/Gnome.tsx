import { useState, type CSSProperties } from "react";
import type { GnomeRole } from "../types.js";
import { gnomeRoleColor } from "../lib/format.js";

// Per-gnome vibrance jitter. Each gnome is minted once (on mount) with a chroma multiplier drawn
// from [MIN, MIN+SPAN], so every instance of a role keeps that role's exact hue + lightness but
// carries a slightly different saturation — enough to tell two same-role gnomes apart, never enough
// to drift the identity colour (planner-blue / implementor-amber stay unmistakable).
const VIBRANCE_MIN = 0.78;
const VIBRANCE_SPAN = 0.4;

// Non-role colors. Hat + body take the role hue via currentColor; the rest is a fixed,
// theme-independent palette tuned to read on the dark UI and to echo the reference tomte.
const BEARD = "oklch(0.95 0.02 90)"; // beard + hat pom — warm off-white
const SKIN = "oklch(0.79 0.07 64)"; //  bulbous nose + little mitts
const BOOTS = "oklch(0.34 0.025 50)"; // chunky dark boots

// Tool palette. Each prop's body is pale (BEARD) with a thin steel outline, so it reads as a real
// object the gnome holds rather than a robe-colored blob. The role color appears only as a band
// framed by pale or steel, the way the Co-worker's mug carries it, so it never merges into the hat.
// Everything still desaturates under active={false}: the wrapper greys the whole figure at once.
const METAL = "oklch(0.74 0.018 250)"; // outlines, clip, lens ring, net hoop: cool steel
const WOOD = "oklch(0.56 0.06 60)"; //  net pole + gavel handle cores: warm turned wood
const INK = "oklch(0.42 0.02 250)"; // ruled lines on pale paper

/** A handle or shaft in the mug's idiom: a steel stroke with a lighter core laid over it, so it
 *  stays outlined where it crosses the robe. All subpaths of `d` share one outline pass and one
 *  core pass, so joints (a wrench's shaft into its jaw) show no seam. */
function framed(d: string, core: string, width: number) {
  return (
    <>
      <path d={d} fill="none" stroke={METAL} strokeWidth={width + 1.5} />
      <path d={d} fill="none" stroke={core} strokeWidth={width} />
    </>
  );
}

/** Each role's tool, drawn after the hat but *before* the mitts so the right tan mitt (27.4,38)
 *  closes over the handle and the prop reads as gripped, not floating. The whole figure lives in
 *  x 6-30, leaving the right column (x 26-35, y 22-40) free; every prop is staged there, rising
 *  out of the mitt into that empty space. All tools share the Co-worker mug's look: a pale body,
 *  a 1-1.2 steel outline, one role-colored band and at most one faint off-white detail. Handles
 *  keep a core of ~1.6-2 inside their outline so the silhouette survives the 15px filter chips.
 *
 *  planner=clipboard · implementor=open-end wrench · researcher=magnifying glass · qa=bug net ·
 *  director=a furled plan-scroll (the one who only delegates carries the master plan) ·
 *  reader=an open book (the read-only lookup lane) · reviewer=a gavel (the one trusted to make the
 *  owner's own accept-or-hand-back call) · coworker=a coffee mug (the one who sits at the owner's desk
 *  and works alongside them, turn by turn). */
function roleProp(role: GnomeRole) {
  switch (role) {
    case "planner": // clipboard: a pale board with a role-colored header band under the steel clip,
      // a role-colored tick on the first row and two ruled lines
      return (
        <g strokeLinecap="round" strokeLinejoin="round">
          <rect x="26.6" y="25.4" width="7.6" height="12.4" rx="1.3" fill={BEARD} stroke={METAL} strokeWidth="1.2" />
          <rect x="26.6" y="27.6" width="7.6" height="1.8" fill="currentColor" />
          <rect x="28.8" y="24" width="3.2" height="2.6" rx="0.8" fill={METAL} />
          <path d="M28.2 31.9l.9.9 1.6-1.9" fill="none" stroke="currentColor" strokeWidth="1.2" />
          <path d="M31.4 32h1.5M28.4 35.2h4.2" stroke={INK} strokeWidth="1" opacity="0.7" />
        </g>
      );
    case "implementor": // open-end wrench: a pale steel-outlined shaft and C-jaw, a role-colored grip
      // sleeve just above the mitt, and a faint turning wisp beside the jaw
      return (
        <g strokeLinecap="round" strokeLinejoin="round">
          {framed("M27.6 38.2 31.2 27.4M29.5 28.6a2.9 2.9 0 1 0 3.9-2.5", BEARD, 1.8)}
          <path d="M28.25 36.3 29.05 33.9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="butt" />
          <path d="M27.8 26.8q.3-1.5 1.7-2.2" fill="none" stroke={BEARD} strokeWidth="1" opacity="0.75" />
        </g>
      );
    case "researcher": // magnifying glass: a pale glass lens in a steel ring with a glint, on a
      // steel-outlined role-colored handle with a steel ferrule
      return (
        <g strokeLinecap="round" strokeLinejoin="round">
          {framed("M27.7 38 30.2 31", "currentColor", 1.8)}
          <path d="M30.1 31.3 30.5 30.2" stroke={METAL} strokeWidth="3.3" strokeLinecap="butt" />
          <circle cx="31.3" cy="26.4" r="3.6" fill={BEARD} fillOpacity="0.55" stroke={METAL} strokeWidth="1.8" />
          <path d="M29.7 26.2q.1-1.5 1.5-2" fill="none" stroke={BEARD} strokeWidth="1.1" />
        </g>
      );
    case "qa": // bug net: a pale mesh bag hanging from a steel hoop on a wood-cored pole, with a
      // role-colored bug caught inside; distinct from the lens at a glance
      return (
        <g strokeLinecap="round" strokeLinejoin="round">
          {framed("M27.7 38 29.8 26.6", WOOD, 1.6)}
          <path d="M27.8 25.2Q31.6 34.4 35.4 25.2" fill={BEARD} fillOpacity="0.7" stroke={METAL} strokeWidth="1.1" />
          <path d="M30.2 26.2 31.2 29.4M33 26.2 32 29.4" stroke={METAL} strokeWidth="0.7" opacity="0.5" />
          <circle cx="31.6" cy="27.6" r="1.2" fill="currentColor" />
          <ellipse cx="31.6" cy="24.4" rx="4" ry="2.4" fill="none" stroke={METAL} strokeWidth="1.6" />
        </g>
      );
    case "director": // a furled plan-scroll held diagonally: a pale steel-outlined tube with a
      // role-colored tie whose tails hang loose, and a rolled end showing its spiral
      return (
        <g strokeLinecap="round" strokeLinejoin="round">
          {framed("M27.8 38.2 32.4 28", BEARD, 3.8)}
          <path d="M29.4 34.6 30.4 32.3" stroke="currentColor" strokeWidth="3.8" strokeLinecap="butt" />
          <path d="M30.2 33.5q1.4.7 1.5 2.2" fill="none" stroke="currentColor" strokeWidth="0.9" />
          <circle cx="32.7" cy="27.4" r="1.9" fill={BEARD} stroke={METAL} strokeWidth="1.1" />
          <path d="M32 27.4a.7.7 0 1 1 .7.7" fill="none" stroke={METAL} strokeWidth="0.8" />
        </g>
      );
    case "reader": // open book: two pale pages on a steel spine, set in a role-colored cover with a
      // ribbon marker poking out the top; the right mitt cups the lower spine so it reads as held open
      return (
        <g strokeLinecap="round" strokeLinejoin="round">
          <path d="M29.8 37.4 26.6 38.2 27.2 26.6 30.4 25.6 35.4 24.2 34.8 36.2Z" fill="currentColor" stroke={METAL} strokeWidth="1.1" />
          <path d="M30.4 25.6 27.6 26.8 27 37.5 29.8 36.6Z" fill={BEARD} stroke={METAL} strokeWidth="1" />
          <path d="M30.4 25.6 35 24.4 34.4 35.4 29.8 36.6Z" fill={BEARD} stroke={METAL} strokeWidth="1" />
          <path d="M30.4 25.6 29.8 36.6" stroke={METAL} strokeWidth="1.2" />
          <path d="M32.6 25.2 32.8 22.9" stroke="currentColor" strokeWidth="1.1" />
          <path d="M28 29.4l1.9-.3M28 31.8l1.9-.3M31 28.8l2.4-.35M31 31.2l2.4-.35" stroke={INK} strokeWidth="0.85" opacity="0.7" />
        </g>
      );
    case "reviewer": // gavel: a wood-cored handle rising out of the mitt into a pale steel-outlined
      // barrel head with a role-colored band round its middle; the final call it makes for the owner
      return (
        <g strokeLinecap="round" strokeLinejoin="round">
          {framed("M27.8 38.2 31 29.6", WOOD, 1.8)}
          <g transform="rotate(20 31 28)">
            <rect x="27.4" y="25.8" width="7.2" height="4.4" rx="1.3" fill={BEARD} stroke={METAL} strokeWidth="1.2" />
            <rect x="30.2" y="25.8" width="1.6" height="4.4" fill="currentColor" />
          </g>
        </g>
      );
    case "coworker": // coffee mug: a pale mug with a role-colored band, a steel handle and two wisps of
      // steam; the mitt closes under its base, so it reads as held at the desk
      return (
        <g strokeLinecap="round" strokeLinejoin="round">
          <path d="M33.2 30.2h1a2.1 2.1 0 0 1 0 4.2h-1" fill="none" stroke={METAL} strokeWidth="1.4" />
          <rect x="26.8" y="28.8" width="6.6" height="8" rx="1.3" fill={BEARD} stroke={METAL} strokeWidth="1.2" />
          <rect x="26.8" y="31.2" width="6.6" height="2" fill="currentColor" />
          <path d="M28.8 27.2q-.9-1.3 0-2.6M31.3 27.2q-.9-1.3 0-2.6" fill="none" stroke={BEARD} strokeWidth="1" opacity="0.75" />
        </g>
      );
    default:
      return null;
  }
}

/** A Nordic tomte/gnome mascot, one per orchestrator role — modelled on the classic reference:
 *  a tall, slender, slightly-drooping pointed hat (about half the figure) with a soft pom, a
 *  bulbous nose peeking under the brim, a big white teardrop beard, two little mitts at the
 *  sides, a small round body, and chunky splayed boots.
 *
 *  The hat + body take the role's own color via `currentColor` (set on the wrapper from
 *  var(--role-*)), so every role gets the same character in its established hue — deterministic,
 *  never random. Beard/pom stay off-white, nose + mitts a muted tan, boots dark — all for clean
 *  contrast on the dark theme at any size.
 *
 *  Each role also holds a small on-theme tool (see `roleProp`): clipboard, wrench, magnifier,
 *  bug net, the director's plan-scroll, or the reader's open book — gripped by the right mitt so it reads as held.
 *
 *  `active` (default true) keeps the full role color; pass `active={false}` to grey the whole
 *  gnome out — used where several roles sit side-by-side and only one is currently working. */
export function Gnome({ role, size = 30, active = true, className }: { role: GnomeRole; size?: number; active?: boolean; className?: string }) {
  // Minted once per mount — random on creation but stable across re-renders, so the gnome's vibrance
  // never flickers mid-session. Only the active (coloured) branch uses it; greyed-out gnomes are neutral.
  const [chromaFactor] = useState(() => VIBRANCE_MIN + Math.random() * VIBRANCE_SPAN);
  const style: CSSProperties = active
    ? { color: gnomeRoleColor(role, chromaFactor), flex: "0 0 auto", lineHeight: 0 }
    : { color: "var(--text-faint)", flex: "0 0 auto", lineHeight: 0, filter: "grayscale(1)", opacity: 0.5 };
  return (
    <span className={"gnome" + (className ? " " + className : "")} style={style} aria-hidden="true">
      {/* Tall viewBox (36×54) — the long hat makes it read as a gnome, never a bottle. */}
      <svg width={size} height={size * (54 / 36)} viewBox="0 0 36 54" fill="none" role="img">
        {/* body — small round role-colored robe, mostly hidden behind the beard */}
        <path d="M11 30C7 33 6 41 8 48h20c2-7 1-15-3-18-3 3-11 3-14 0Z" fill="currentColor" />
        {/* boots — two chunky dark boots, splayed slightly outward */}
        <ellipse cx="13.5" cy="49" rx="3.7" ry="2.6" fill={BOOTS} />
        <ellipse cx="22.5" cy="49" rx="3.7" ry="2.6" fill={BOOTS} />
        {/* hat — tall slender pointed cap, tip leaning right, brim flaring over the beard */}
        <path d="M21 5C15 11 10 21 8 31c6-1.5 16-1.5 22 0C28 21 26 11 21 5Z" fill="currentColor" />
        {/* role prop — the gnome's tool, drawn before the mitts so the right mitt grips its handle */}
        {roleProp(role)}
        {/* mitts — two little tan hands resting at the beard's sides */}
        <circle cx="8.6" cy="38" r="2.4" fill={SKIN} />
        <circle cx="27.4" cy="38" r="2.4" fill={SKIN} />
        {/* beard — big white teardrop coming to a soft rounded point; the gnome's signature */}
        <path d="M11 30C9 37 12 43 18 46c6-3 9-9 7-16-3 3-11 3-14 0Z" fill={BEARD} />
        {/* nose — bulbous tan nose peeking out from under the hat brim */}
        <circle cx="18" cy="32.4" r="3" fill={SKIN} />
        {/* pom — the soft off-white bobble at the hat's tip */}
        <circle cx="22" cy="5" r="3" fill={BEARD} />
      </svg>
    </span>
  );
}
