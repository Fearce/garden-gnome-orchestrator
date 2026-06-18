import type { CSSProperties } from "react";
import type { Role } from "../types.js";
import { roleColor } from "../lib/format.js";

// Non-role colors. Hat + body take the role hue via currentColor; the rest is a fixed,
// theme-independent palette tuned to read on the dark UI and to echo the reference tomte.
const BEARD = "oklch(0.95 0.02 90)"; // beard + hat pom — warm off-white
const SKIN = "oklch(0.79 0.07 64)"; //  bulbous nose + little mitts
const BOOTS = "oklch(0.34 0.025 50)"; // chunky dark boots

// Tool palette — deliberately neutral (not currentColor) so the per-role props read as
// real objects the gnome is holding, not robe-colored blobs. Still greys out cleanly with
// the whole figure under active={false} via the wrapper's grayscale filter.
const METAL = "oklch(0.72 0.015 250)"; // wrench, clip bar, lens + net hoops — cool steel
const WOOD = "oklch(0.58 0.06 60)"; //  net handle — warm turned-wood pole

/** A small prop for each role, drawn just before the mitts so the right tan mitt (27.4,38)
 *  overlaps the handle and the tool reads as gripped rather than floating. Kept to a few bold
 *  primitives (strokeWidth ~2+, round caps) so it survives down-scaling to the 15px filter chips.
 *  Planner=clipboard, Implementor=wrench, Researcher=magnifying glass, QA=bug net. Director — the
 *  one who only delegates — carries nothing. */
function roleProp(role: Role) {
  switch (role) {
    case "planner": // clipboard held at the side, board angled into the empty upper-right
      return (
        <g>
          <rect x="28" y="24" width="7" height="13" rx="1.2" fill={BEARD} stroke={METAL} strokeWidth="1.1" />
          <rect x="29.8" y="22.8" width="3.4" height="2.4" rx="0.7" fill={METAL} />
          <path d="M29.6 29h3.8M29.6 32h3.8M29.6 35h2.8" stroke={METAL} strokeWidth="1.1" strokeLinecap="round" opacity="0.45" />
        </g>
      );
    case "implementor": // open-end wrench — thick shaft up to a C-jaw opening away from the body
      return (
        <g fill="none" stroke={METAL} strokeLinecap="round" strokeLinejoin="round">
          <path d="M27.8 38.4 31 28" strokeWidth="2.8" />
          <path d="M29.2 28.6A2.5 2.5 0 1 0 33 26.2" strokeWidth="2.6" />
        </g>
      );
    case "researcher": // magnifying glass — steel lens ring, handle running down to the mitt
      return (
        <g fill="none" strokeLinecap="round">
          <line x1="29.3" y1="27.8" x2="27.8" y2="37.5" stroke={METAL} strokeWidth="2.6" />
          <circle cx="31.5" cy="25.5" r="3.3" stroke={METAL} strokeWidth="2.4" />
          <path d="M30.1 23.5A2 2 0 0 0 29.4 25.4" stroke={BEARD} strokeWidth="1" opacity="0.8" />
        </g>
      );
    case "qa": // bug net — tilted oval mouth + hanging mesh bag on a turned-wood pole to the mitt
      return (
        <g fill="none" strokeLinecap="round">
          <line x1="28.4" y1="25" x2="27.8" y2="37.5" stroke={WOOD} strokeWidth="2.6" />
          <ellipse cx="31.3" cy="23.2" rx="4" ry="2.4" stroke={METAL} strokeWidth="2.2" />
          <path d="M27.6 24Q31.3 30.6 35 24" stroke={METAL} strokeWidth="1.4" opacity="0.6" />
          <path d="M31.3 25v4.6" stroke={METAL} strokeWidth="0.9" opacity="0.35" />
        </g>
      );
    default: // director carries nothing
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
        {/* role prop — the gnome's tool, drawn behind the mitts so the right mitt grips its handle */}
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
