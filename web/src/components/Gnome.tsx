import type { CSSProperties } from "react";
import type { Role } from "../types.js";
import { roleColor } from "../lib/format.js";

// Non-role colors. Hat + body take the role hue via currentColor; the rest is a fixed,
// theme-independent palette tuned to read on the dark UI and to echo the reference tomte.
const BEARD = "oklch(0.95 0.02 90)"; // beard + hat pom — warm off-white
const SKIN = "oklch(0.79 0.07 64)"; //  bulbous nose + little mitts
const BOOTS = "oklch(0.34 0.025 50)"; // chunky dark boots

// Tool palette — kept deliberately neutral (never currentColor) so each prop reads as a real
// object the gnome holds rather than a robe-colored blob. It still desaturates with the whole
// figure under active={false}, since the wrapper applies one grayscale filter over everything.
const METAL = "oklch(0.74 0.018 250)"; // wrench, clip, lens ring + net hoop — cool steel
const WOOD = "oklch(0.56 0.06 60)"; //  net pole — warm turned wood
const INK = "oklch(0.42 0.02 250)"; // ruled lines on the clipboard's pale paper

/** Each role's tool, drawn after the hat but *before* the mitts so the right tan mitt (27.4,38)
 *  closes over the handle and the prop reads as gripped, not floating. The whole figure lives in
 *  x 6–30, leaving the right column (x≈26–35, y≈22–40) free — every prop is staged there, rising
 *  out of the mitt into that empty space. Deliberately bold: solid fills and strokeWidth ~2.5–3
 *  with round caps so the silhouette survives down to the 15px filter chips.
 *
 *  planner=clipboard · implementor=open-end wrench · researcher=magnifying glass · qa=bug net ·
 *  director=a furled plan-scroll (the one who only delegates carries the master plan). */
function roleProp(role: Role) {
  switch (role) {
    case "planner": // clipboard — pale board with a steel clip, a ticked top line, two ruled rows
      return (
        <g>
          <rect x="26.6" y="25" width="8" height="14" rx="1.6" fill={BEARD} stroke={METAL} strokeWidth="1.4" />
          <rect x="28.7" y="23.6" width="3.8" height="2.6" rx="0.8" fill={METAL} />
          <path d="M28.4 29.4l1.1 1.1 2-2.4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M28.4 33h5.4M28.4 36h3.8" stroke={INK} strokeWidth="1.3" strokeLinecap="round" opacity="0.7" />
        </g>
      );
    case "implementor": // open-end wrench — thick shaft up from the mitt to a C-jaw opening outward
      return (
        <g fill="none" stroke={METAL} strokeLinecap="round" strokeLinejoin="round">
          <path d="M27.6 38.2 31.2 27.4" strokeWidth="3" />
          <path d="M29.5 28.6a2.9 2.9 0 1 0 3.9-2.5" strokeWidth="3" />
        </g>
      );
    case "researcher": // magnifying glass — bold steel lens (faint glass tint + glint) on a handle
      return (
        <g fill="none" strokeLinecap="round">
          <line x1="27.7" y1="38" x2="30.4" y2="30.4" stroke={METAL} strokeWidth="3" />
          <circle cx="31.6" cy="26.4" r="4" fill={BEARD} fillOpacity="0.18" stroke={METAL} strokeWidth="2.6" />
          <path d="M30 24.3a2.2 2.2 0 0 0-.8 1.8" stroke={BEARD} strokeWidth="1.1" opacity="0.85" />
        </g>
      );
    case "qa": // bug net — steel hoop with a hanging mesh bag on a wooden pole; distinct from the lens
      return (
        <g fill="none" strokeLinecap="round" strokeLinejoin="round">
          <line x1="27.7" y1="38" x2="29.8" y2="26.4" stroke={WOOD} strokeWidth="3" />
          <ellipse cx="31.6" cy="24.4" rx="4.2" ry="2.6" stroke={METAL} strokeWidth="2.4" />
          <path d="M27.8 25.4Q31.6 34 35.4 25.4" fill={BEARD} fillOpacity="0.14" stroke={METAL} strokeWidth="1.5" opacity="0.85" />
          <path d="M31.6 26.8v5.1" stroke={METAL} strokeWidth="0.9" opacity="0.4" />
        </g>
      );
    case "director": // a furled plan-scroll held diagonally — open tube end + a role-colored tie
      return (
        <g>
          <path d="M27.8 38.2 32.4 28" stroke={BEARD} strokeWidth="5" strokeLinecap="round" />
          <circle cx="32.7" cy="27.4" r="1.7" fill={BEARD} stroke={METAL} strokeWidth="1" />
          <circle cx="32.7" cy="27.4" r="0.6" fill="none" stroke={METAL} strokeWidth="0.8" />
          <path d="M27.5 31.9 32.7 34.3" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
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
 *  bug net, or the director's plan-scroll — gripped by the right mitt so it reads as held.
 *
 *  `active` (default true) keeps the full role color; pass `active={false}` to grey the whole
 *  gnome out — used where several roles sit side-by-side and only one is currently working. */
export function Gnome({ role, size = 30, active = true, className }: { role: Role; size?: number; active?: boolean; className?: string }) {
  const style: CSSProperties = active
    ? { color: roleColor(role), flex: "0 0 auto", lineHeight: 0 }
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
