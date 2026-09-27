import { useId, useState, type CSSProperties } from "react";
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

// Skins. A gnome rolls once on mount, like its vibrance: RARE_SKIN_CHANCE of the time it wears one
// of the rare skins, with an additional 1% chance of a super rare skin. A skin only decorates the hat, the
// pom and the air around the figure; the hat and robe keep the role color and the tool stays in the
// mitt, so a skinned gnome is still unmistakably its role. December is different: every gnome that
// misses both rolls wears a Santa hat instead of none, and half of the rare rolls go to the festive
// skins, which never appear in any other month. Two skins replace the hat itself (the owner's call):
// the Santa hat turns it red, and the crown swaps it for a crown over a role-colored cap. In both the
// robe and tool keep the role color.
export const EVERYDAY_SKINS = ["starry", "toadstool", "striped", "winter", "golden", "patched", "daisy", "hearts"] as const;
export const FESTIVE_SKINS = ["lights", "holly", "antlers", "snowcap"] as const;
export const SUPER_RARE_SKINS = ["aurora", "crystal", "eclipse", "crown", "phoenix", "cloud"] as const;
export type RareSkin = (typeof EVERYDAY_SKINS)[number] | (typeof FESTIVE_SKINS)[number] | (typeof SUPER_RARE_SKINS)[number] | "santa";
const RARE_SKIN_CHANCE = 0.1;
const SUPER_RARE_SKIN_CHANCE = 0.01;
const FESTIVE_SHARE = 0.5;
const HAT = "M21 5C15 11 10 21 8 31c6-1.5 16-1.5 22 0C28 21 26 11 21 5Z";
const GOLD = "oklch(0.86 0.14 88)"; // golden pom + twinkles, starry stars, daisy heart, a light bulb
const BERRY = "oklch(0.6 0.2 25)"; //  holly berries, a light bulb
const HOLLY = "oklch(0.5 0.12 150)"; // holly leaves, a light bulb
const BULB_BLUE = "oklch(0.7 0.14 240)";
const SANTA_RED = "oklch(0.56 0.2 27)"; // the Santa hat; deeper than the berries so it reads as felt
const AURORA = "oklch(0.79 0.17 185)";
const CRYSTAL = "oklch(0.84 0.13 225)";
const ECLIPSE = "oklch(0.88 0.16 80)";
const CLOUD = "oklch(0.97 0.01 240)"; //  the floating cloud, a touch bluer than the beard
const CLOUD_SHADE = "oklch(0.84 0.03 240)";
const EMBER = "oklch(0.68 0.2 42)"; //  the phoenix flame's outer fire and its sparks

function pick<T>(list: readonly T[]): T | null {
  return list[Math.floor(Math.random() * list.length)] ?? null;
}

export function rollRareSkin(now = new Date()): RareSkin | null {
  const december = now.getMonth() === 11;
  const roll = Math.random();
  if (roll < SUPER_RARE_SKIN_CHANCE) return pick(SUPER_RARE_SKINS);
  if (roll >= SUPER_RARE_SKIN_CHANCE + RARE_SKIN_CHANCE) return december ? "santa" : null;
  const festive = december && Math.random() < FESTIVE_SHARE;
  return festive ? pick(FESTIVE_SKINS) : pick(EVERYDAY_SKINS);
}

/** A four-point twinkle centred on (cx, cy), `r` from centre to tip. */
function sparkle(cx: number, cy: number, r: number, fill: string, className?: string) {
  return <path className={className} d={`M${cx} ${cy - r}Q${cx} ${cy} ${cx + r} ${cy}Q${cx} ${cy} ${cx} ${cy + r}Q${cx} ${cy} ${cx - r} ${cy}Q${cx} ${cy} ${cx} ${cy - r}Z`} fill={fill} />;
}

/** The glow each super rare skin casts, in its own signature color (see .gnome-super in styles.css). */
function superRareGlow(skin: RareSkin | null): string | null {
  switch (skin) {
    case "aurora": return AURORA;
    case "crystal": return CRYSTAL;
    case "eclipse": return ECLIPSE;
    case "crown": return GOLD;
    case "phoenix": return EMBER;
    case "cloud": return CLOUD;
    default: return null;
  }
}

/** A small heart whose point sits at (x, y). */
function heart(x: number, y: number) {
  return <path d={`M${x} ${y}c-1.6-1-2.2-1.9-2.2-2.7a1.1 1.1 0 0 1 2.2-.5 1.1 1.1 0 0 1 2.2.5c0 .8-.6 1.7-2.2 2.7Z`} />;
}

/** The fur trim along the hat's brim, shared by the winter skin. */
const FUR_BRIM = "M8.4 30.4c6-1.6 15.4-1.6 21.2 0";

/** The bulbs on the festive lights: two wires across the hat, each bulb hanging just below it. */
const LIGHT_BULBS: [number, number, string][] = [
  [15.3, 21.8, BERRY], [19.4, 22.4, GOLD], [23.7, 21.8, BULB_BLUE],
  [12.6, 27.3, GOLD], [17.3, 28.1, BULB_BLUE], [22, 28, BERRY], [26.4, 27.2, HOLLY],
];

/** The skin's decoration, drawn over the hat and before the prop and face. Patterns are clipped to
 *  the hat through `hatClip`, so they follow its outline at any size. */
function skinOverlay(skin: RareSkin, hatClip: string) {
  switch (skin) {
    case "aurora": // shifting northern lights wrap the hat, with bright wisps above it
      return (
        <g>
          <g clipPath={`url(#${hatClip})`} fill="none" strokeLinecap="round">
            <g className="gnome-shimmer">
              <path d="M7 27q7-8 15-5t12-8M9 31q9-8 16-5t9-5" stroke={AURORA} strokeWidth="2.4" />
              <path d="M9 25q8-7 16-5t9-7" stroke={GOLD} strokeWidth="1" />
            </g>
          </g>
          {sparkle(5.5, 16, 2, AURORA, "gnome-twinkle")}
          {sparkle(31.4, 9, 1.6, GOLD, "gnome-twinkle gnome-late")}
        </g>
      );
    case "crystal": // three faceted icy gems set into the cap and a diamond at its tip
      return (
        <g>
          <g clipPath={`url(#${hatClip})`} fill={CRYSTAL} stroke={BEARD} strokeWidth="0.6">
            <path className="gnome-glint" d="m16 16 2.2-2.4 2.2 2.4-2.2 4Z" />
            <path className="gnome-glint gnome-late" d="m23 22 2.4-2.6 2.4 2.6-2.4 4.2Z" />
            <path className="gnome-glint" d="m11 26 1.8-2 1.8 2-1.8 3Z" />
          </g>
          <path className="gnome-glint gnome-late" d="m22 1.2 2.2 3.8-2.2 3.8L19.8 5Z" fill={CRYSTAL} stroke={BEARD} strokeWidth="0.6" />
          {sparkle(31, 17, 1.6, CRYSTAL, "gnome-twinkle")}
        </g>
      );
    case "eclipse": // a luminous ring and tiny orbiting stars around the pointed cap
      return (
        <g>
          <g className="gnome-orbit">
            <ellipse cx="20.5" cy="14" rx="12" ry="5" transform="rotate(-28 20.5 14)" fill="none" stroke={ECLIPSE} strokeWidth="1.5" />
          </g>
          <g clipPath={`url(#${hatClip})`}>
            <path d="M7 28q10-4 22 0" fill="none" stroke={ECLIPSE} strokeWidth="2.2" />
            {sparkle(19, 18, 1.6, GOLD, "gnome-twinkle gnome-late")}
          </g>
          {sparkle(5.8, 8.5, 2, ECLIPSE, "gnome-twinkle")}
          {sparkle(32, 22, 1.5, ECLIPSE, "gnome-twinkle gnome-late")}
        </g>
      );
    case "crown": // royalty: a gold crown replaces the hat outright (the owner's call). A velvet cap
      // in the role color domes up between its points, so the gnome still reads as its role
      return (
        <g strokeLinejoin="round">
          <path d="M9 30.6C9 22.4 13.4 17.4 19 17.4s10 5 10 13.2c-6-1.4-14-1.4-20 0Z" fill="currentColor" />
          <path d="M8.4 31 7.6 21.4l4.4 4.2 3-6.8 4 5.6 4-5.6 3 6.8 4.4-4.2-.8 9.6c-6.2-1.5-15.4-1.5-21.6 0Z" fill={GOLD} />
          <path d="M8.3 29.4c6.2-1.5 15.4-1.5 21.6 0" fill="none" stroke={ECLIPSE} strokeWidth="0.8" opacity="0.8" />
          <g fill={BEARD}>
            <circle cx="7.6" cy="21.4" r="0.9" />
            <circle cx="15" cy="18.8" r="0.9" />
            <circle cx="23" cy="18.8" r="0.9" />
            <circle cx="30.4" cy="21.4" r="0.9" />
          </g>
          <circle className="gnome-glint" cx="12.6" cy="27.4" r="0.9" fill={BULB_BLUE} />
          <circle className="gnome-glint gnome-late" cx="19" cy="27" r="1.1" fill={BERRY} />
          <circle className="gnome-glint" cx="25.4" cy="27.4" r="0.9" fill={HOLLY} />
          {sparkle(4.6, 14, 2, GOLD, "gnome-twinkle")}
          {sparkle(32, 15, 1.5, GOLD, "gnome-twinkle gnome-late")}
        </g>
      );
    case "phoenix": // the pom has caught fire: a flame at the tip, a gold heart and embers drifting off
      return (
        <g>
          <g className="gnome-flicker">
            <path d="M22 .6c1.9 2.1 3.6 3.6 3.2 6a3.2 3.2 0 0 1-6.4 0c-.2-1.5.6-2.4 1.3-3.2 0 1.1.6 1.7 1.3 1.7-.4-1.7 0-3 .6-4.5Z" fill={EMBER} />
            <path d="M22 4.2c.9 1 1.7 1.8 1.5 3a1.5 1.5 0 0 1-3 0c0-.9.6-1.4 1-1.9.1.6.4.9.7.9-.2-.8-.1-1.4-.2-2Z" fill={GOLD} />
          </g>
          <g fill={EMBER}>
            <circle className="gnome-twinkle" cx="27.4" cy="3.2" r="0.6" />
            <circle className="gnome-twinkle gnome-late" cx="16.4" cy="4.4" r="0.5" />
            <circle className="gnome-twinkle" cx="29" cy="8.6" r="0.45" />
          </g>
          <g clipPath={`url(#${hatClip})`}>
            <path d="M9.4 27.6q10-3.4 20 0" fill="none" stroke={EMBER} strokeWidth="1.6" />
          </g>
        </g>
      );
    case "cloud": // the gnome floats on a little cloud: its boots sink into the puff, and the whole
      // figure bobs slowly (.gnome-floating in styles.css) so it reads as drifting, not standing
      return (
        <g>
          <path d="M7 53.4h23.4a2.5 2.5 0 0 0 .6-4.9 3.1 3.1 0 0 0-5-2.3 3.4 3.4 0 0 0-6.6-.8 3.2 3.2 0 0 0-5.9 1 2.6 2.6 0 0 0-4.6 2.2A2.5 2.5 0 0 0 7 53.4Z" fill={CLOUD} />
          <path d="M7.8 53.4h21.8" stroke={CLOUD_SHADE} strokeWidth="1.2" strokeLinecap="round" />
          <g stroke={CLOUD} strokeWidth="0.9" strokeLinecap="round" opacity="0.7">
            <path className="gnome-twinkle" d="M3.4 47.4h2.4" />
            <path className="gnome-twinkle gnome-late" d="M31.6 45.6h2" />
            <path className="gnome-twinkle" d="M2.6 43.8h1.6" />
          </g>
        </g>
      );
    case "starry": // a wizard's hat: gold stars and a pale crescent moon
      return (
        <g clipPath={`url(#${hatClip})`}>
          {sparkle(21.4, 12.6, 1.6, GOLD)}
          {sparkle(14.6, 24.4, 1.9, GOLD)}
          {sparkle(23.8, 25.4, 1.3, GOLD)}
          <path d="M18.4 16.6a2.6 2.6 0 1 0 1.8 4.4 2.1 2.1 0 1 1-1.8-4.4Z" fill={BEARD} />
        </g>
      );
    case "toadstool": // an amanita cap: pale spots of mixed sizes
      return (
        <g clipPath={`url(#${hatClip})`} fill={BEARD}>
          <circle cx="20.4" cy="12" r="1.3" />
          <circle cx="16" cy="19.4" r="1.9" />
          <circle cx="22.8" cy="20.6" r="1.4" />
          <circle cx="11.6" cy="27" r="1.5" />
          <circle cx="19.2" cy="26.4" r="2.1" />
          <circle cx="26.4" cy="28.2" r="1.1" />
        </g>
      );
    case "striped": // a knitted stocking cap: pale stripes that curve with the hat
      return (
        <g clipPath={`url(#${hatClip})`} fill="none" stroke={BEARD} strokeWidth="2.2" opacity="0.9">
          <path d="M14 13.4q7-1.6 12 0" />
          <path d="M11 19.6q8-1.8 17 0" />
          <path d="M8 25.8q10-2 21 0" />
        </g>
      );
    case "winter": // a fur-trimmed winter cap and a few falling snowflakes
      return (
        <g>
          <path d={FUR_BRIM} fill="none" stroke={BEARD} strokeWidth="3.4" strokeLinecap="round" />
          <g stroke={BEARD} strokeWidth="0.8" strokeLinecap="round" opacity="0.85">
            <path d="M5 10v3.6M3.2 11.8h3.6M3.7 10.5l2.6 2.6M6.3 10.5l-2.6 2.6" />
            <path d="M30.6 12.4v2.6M29.3 13.7h2.6" />
            <path d="M4.2 20.4v2.4M3 21.6h2.4" />
          </g>
        </g>
      );
    case "golden": // a shiny: a gold band round the hat and gold twinkles in the air
      return (
        <g>
          <path d="M9.6 26.6q10.4-2.2 19.2 0" clipPath={`url(#${hatClip})`} fill="none" stroke={GOLD} strokeWidth="2" />
          {sparkle(6.4, 13, 2.4, GOLD)}
          {sparkle(11.4, 6.6, 1.5, GOLD)}
          {sparkle(30.4, 13.4, 1.7, GOLD)}
        </g>
      );
    case "patched": // a well-loved cap: a pale patch sewn on with running stitches
      return (
        <g clipPath={`url(#${hatClip})`} transform="rotate(-12 18.4 21.6)">
          <rect x="15.4" y="18.8" width="6" height="5.6" rx="0.6" fill={BEARD} fillOpacity="0.35" />
          <rect x="15.9" y="19.3" width="5" height="4.6" rx="0.4" fill="none" stroke={BEARD} strokeWidth="0.6" strokeDasharray="1 0.8" />
        </g>
      );
    case "daisy": // a daisy tucked into the brim
      return (
        <g>
          <g fill={BEARD}>
            {[0, 60, 120, 180, 240, 300].map((deg) => (
              <ellipse key={deg} cx="11.6" cy="25.4" rx="1" ry="1.9" transform={`rotate(${deg} 11.6 27.4)`} />
            ))}
          </g>
          <circle cx="11.6" cy="27.4" r="1.2" fill={GOLD} />
        </g>
      );
    case "hearts": // a sweetheart's cap: pale hearts scattered down it
      return (
        <g clipPath={`url(#${hatClip})`} fill={BEARD}>
          {heart(20.2, 15)}
          {heart(15.2, 23.6)}
          {heart(23, 25)}
        </g>
      );
    case "lights": // December: a string of colored lights wound round the hat
      return (
        <g>
          <path d="M12.6 20.6q6.6 3.6 14 0M9.8 26.4q9.2 3.6 19 0" fill="none" stroke={BOOTS} strokeWidth="0.6" />
          {LIGHT_BULBS.map(([x, y, fill]) => (
            <ellipse key={`${x},${y}`} cx={x} cy={y + 0.7} rx="0.8" ry="1.05" fill={fill} />
          ))}
        </g>
      );
    case "holly": // December: a sprig of holly with red berries pinned at the brim, opposite the tool
      return (
        <g>
          <path d="M13.4 29.2q-2.8-3-5.8-1.6 2.8 3 5.8 1.6ZM13.4 29.2q1-3.8-1.6-5.6-1 3.8 1.6 5.6Z" fill={HOLLY} />
          <g fill={BERRY}>
            <circle cx="13.8" cy="29.7" r="1" />
            <circle cx="12.4" cy="30.3" r="1" />
            <circle cx="12.9" cy="28.6" r="1" />
          </g>
        </g>
      );
    case "antlers": // December: reindeer antlers sprouting from either side of the hat
      return (
        <g fill="none" stroke={WOOD} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M13.8 18.4q-3-2-3.6-6M11.6 15.6l-2.4-.6M10.6 13.4l-1.2-2" />
          <path d="M25.4 17.6q3-2 3.4-6M27.6 15l2.4-.8M28.4 12.8l1.4-1.8" />
        </g>
      );
    case "santa": // December: the gnome's own hat has turned Santa red (see the hat fill in Gnome);
      // this adds the white fur trim along its brim, and the pom grows fluffier
      return <path d={FUR_BRIM} fill="none" stroke={BEARD} strokeWidth="3.4" strokeLinecap="round" />;
    case "snowcap": // December: fresh snow settled on the hat's tip, and a few flakes still falling
      return (
        <g>
          <path clipPath={`url(#${hatClip})`} d="M12 13.2q2.4-1 4.4.4 1.2 1.6 2.6-.2 1.4-1.4 2.8.2 1.2 1.6 2.6-.4 1.2-.8 3 .2V2H12Z" fill={BEARD} />
          <g fill={BEARD} opacity="0.85">
            <circle cx="6" cy="9" r="0.9" />
            <circle cx="30.4" cy="11" r="0.8" />
            <circle cx="4.6" cy="19" r="0.7" />
          </g>
        </g>
      );
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
 *  gnome out — used where several roles sit side-by-side and only one is currently working.
 *
 *  Now and then a gnome wears a rare skin (see `RareSkin`). Pass `skin` to pin one, or `null` for
 *  the plain gnome; leave it out to roll. */
export function Gnome({ role, size = 30, active = true, className, skin: pinnedSkin }: { role: GnomeRole; size?: number; active?: boolean; className?: string; skin?: RareSkin | null }) {
  // Minted once per mount — random on creation but stable across re-renders, so the gnome's vibrance
  // never flickers mid-session. Only the active (coloured) branch uses it; greyed-out gnomes are neutral.
  const [chromaFactor] = useState(() => VIBRANCE_MIN + Math.random() * VIBRANCE_SPAN);
  // Rolled once per mount on the same terms, so a skin never swaps mid-session.
  const [rolledSkin] = useState(rollRareSkin);
  const skin = pinnedSkin === undefined ? rolledSkin : pinnedSkin;
  // Every gnome on the page needs its own clip id; useId's colons are not valid inside url(#...).
  const hatClip = "gnome-hat-" + useId().replace(/[^\w-]/g, "");
  // A super rare gnome glows in its skin's color and its skin moves a little, but only while active:
  // a greyed-out gnome stays still, so the effects never draw the eye to an idle role.
  const glow = active ? superRareGlow(skin) : null;
  const style: CSSProperties = active
    ? { color: gnomeRoleColor(role, chromaFactor), flex: "0 0 auto", lineHeight: 0, ...(glow ? ({ "--gnome-glow": glow } as CSSProperties) : {}) }
    : { color: "var(--text-faint)", flex: "0 0 auto", lineHeight: 0, filter: "grayscale(1)", opacity: 0.5 };
  const classes = ["gnome", skin === "cloud" && active && "gnome-floating", glow && "gnome-super", className].filter(Boolean).join(" ");
  return (
    <span className={classes} style={style} aria-hidden="true">
      {/* Tall viewBox (36×54) — the long hat makes it read as a gnome, never a bottle. */}
      <svg width={size} height={size * (54 / 36)} viewBox="0 0 36 54" fill="none" role="img">
        {/* body — small round role-colored robe, mostly hidden behind the beard */}
        <path d="M11 30C7 33 6 41 8 48h20c2-7 1-15-3-18-3 3-11 3-14 0Z" fill="currentColor" />
        {/* boots — two chunky dark boots, splayed slightly outward */}
        <ellipse cx="13.5" cy="49" rx="3.7" ry="2.6" fill={BOOTS} />
        <ellipse cx="22.5" cy="49" rx="3.7" ry="2.6" fill={BOOTS} />
        {/* hat — tall slender pointed cap, tip leaning right, brim flaring over the beard */}
        {skin !== "crown" && <path d={HAT} fill={skin === "santa" ? SANTA_RED : "currentColor"} />}
        {skin && (
          <>
            <clipPath id={hatClip}>
              <path d={HAT} />
            </clipPath>
            {skinOverlay(skin, hatClip)}
          </>
        )}
        {/* role prop — the gnome's tool, drawn before the mitts so the right mitt grips its handle */}
        {roleProp(role)}
        {/* mitts — two little tan hands resting at the beard's sides */}
        <circle cx="8.6" cy="38" r="2.4" fill={SKIN} />
        <circle cx="27.4" cy="38" r="2.4" fill={SKIN} />
        {/* beard — big white teardrop coming to a soft rounded point; the gnome's signature */}
        <path d="M11 30C9 37 12 43 18 46c6-3 9-9 7-16-3 3-11 3-14 0Z" fill={BEARD} />
        {/* nose — bulbous tan nose peeking out from under the hat brim */}
        <circle cx="18" cy="32.4" r="3" fill={SKIN} />
        {/* pom — the soft off-white bobble at the hat's tip; gold on a golden gnome, fluffier in winter,
            and on a Santa hat, and hidden under a crown or a phoenix flame, which take its place */}
        {skin !== "crown" && skin !== "phoenix" && <circle cx="22" cy="5" r={skin === "winter" || skin === "santa" ? 3.6 : 3} fill={skin === "golden" ? GOLD : skin === "crystal" ? CRYSTAL : BEARD} />}
      </svg>
    </span>
  );
}
