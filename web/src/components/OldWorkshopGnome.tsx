import type { CSSProperties } from "react";
import type { GnomeRole } from "../types.js";
import type { DirectorRest } from "../lib/directorRest.js";
import { gnomeRoleColor } from "../lib/format.js";
import { GNOME_PALETTE, Gnome } from "./Gnome.js";

const { BEARD, SKIN, BOOTS, METAL, WOOD, INK, GOLD, BULB_BLUE } = GNOME_PALETTE;
// Upholstery and quilt: a fixed blue, so the furniture never melts into the resting gnome's role-colored hat.
const CLOTH = BULB_BLUE;

/** "Old gnomes beta": the original vector gnome on the workshop's beta timeline, with its own artwork for
 *  everything the beta cast does there. The figure breathes and steps each boot; at work it sets its
 *  held tool down and both mitts move to a role bench; a resting director gets a chair or a bed.
 *  Everything is drawn flat in the Gnome palette on the same 2:3 box (100×150 here, 36×54 in Gnome),
 *  so a mitt at (x, y) in Gnome sits at (x·2.78, y·2.78) here. No beta artwork is used. */
export function ClassicWorkshopGnome({ role, size, rest }: { role: GnomeRole; size: number; rest?: DirectorRest }) {
  return <span className="classic-workshop-gnome" data-rest={rest}
    style={{ width: size, height: size * 1.5, color: gnomeRoleColor(role, 1) } as CSSProperties}>
    <span className="old-gnome-shadow" />
    <OldRestBack rest={rest} />
    <Gnome role={role} size={size} />
    <OldRestFront rest={rest} />
    {!rest && size >= 28 && <OldWorkbench role={role} />}
  </span>;
}

/** A tan mitt the size of the gnome's own (r 2.4 in Gnome). */
function Mitt({ x, y, className }: { x: number; y: number; className?: string }) {
  return <circle className={className} cx={x} cy={y} r="6.6" fill={SKIN} />;
}

/** A sparkle in the Gnome skins' four-point idiom. */
function twinkle(cx: number, cy: number, r: number, className?: string) {
  return <path className={className} d={`M${cx} ${cy - r}Q${cx} ${cy} ${cx + r} ${cy}Q${cx} ${cy} ${cx} ${cy + r}Q${cx} ${cy} ${cx - r} ${cy}Q${cx} ${cy} ${cx} ${cy - r}Z`} fill={GOLD} />;
}

/** Each role's bench, in the held tools' idiom: pale bodies with a steel outline and one role-colored
 *  band. The animated part of each mirrors its beta counterpart: typing, sweeping, writing, a turning
 *  globe, a striking gavel, a turning page, a conducting baton, a steaming mug. */
function OldWorkbench({ role }: { role: GnomeRole }) {
  return <svg className={`old-bench old-bench-${role}`} viewBox="0 0 100 150" fill="none" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {role === "implementor" ? <>
      {/* a little terminal: dark screen in a pale steel-rimmed case, blinking role-colored code */}
      <rect x="27" y="84" width="48" height="32" rx="4" fill={BEARD} stroke={METAL} strokeWidth="3" />
      <rect x="31" y="88" width="40" height="23" rx="2" fill={BOOTS} />
      <g className="old-code" stroke="currentColor" strokeWidth="2.4"><path d="m37 95-4 3 4 3M45 95l4 3-4 3M53 95h13M53 101h8M36 106h22" /></g>
      <path d="M23 118h56l5 9H18Z" fill={BEARD} stroke={METAL} strokeWidth="2.6" />
      <path d="M26 122h50" stroke="currentColor" strokeWidth="2.4" strokeDasharray="4 2.5" />
      <Mitt className="old-hand-left" x={35} y={124} />
      <Mitt className="old-hand-right" x={65} y={124} />
    </> : role === "qa" ? <>
      {/* a checklist under inspection, swept with the bug net */}
      <path d="m19 104 42-5 6 33-42 5Z" fill={BEARD} stroke={METAL} strokeWidth="2.6" />
      <path d="m27 110 3 3 5-6m-6 13 3 3 5-6" stroke="currentColor" strokeWidth="2.6" />
      <path d="M42 109h13M44 119h11M30 129h22" stroke={INK} strokeWidth="2" opacity="0.7" />
      <g className="old-inspect">
        <path d="m82 136-14-24" stroke={METAL} strokeWidth="6.5" /><path d="m82 136-14-24" stroke={WOOD} strokeWidth="4" />
        <path d="M54 100q10 22 22 3" fill={BEARD} fillOpacity="0.7" stroke={METAL} strokeWidth="2" />
        <circle cx="64" cy="106" r="3" fill="currentColor" />
        <ellipse cx="65" cy="102" rx="11" ry="6" transform="rotate(-25 65 102)" stroke={METAL} strokeWidth="3.5" />
        <Mitt x={80} y={132} />
      </g>
    </> : role === "planner" ? <>
      {/* the clipboard laid flat as a drawing board, a plan sketched with a pencil */}
      <rect x="16" y="104" width="64" height="30" rx="3.5" transform="rotate(-3 48 119)" fill={BEARD} stroke={METAL} strokeWidth="2.6" />
      <rect x="17" y="107" width="62" height="5" transform="rotate(-3 48 119)" fill="currentColor" />
      <rect x="40" y="99" width="16" height="7" rx="2" transform="rotate(-3 48 119)" fill={METAL} />
      <path d="M24 118h14v10H24Zm20-3h16v8H44ZM38 123h8v5h16" stroke={INK} strokeWidth="2" opacity="0.75" />
      <g className="old-write">
        <path d="m68 100-13 21" stroke={METAL} strokeWidth="6.5" /><path d="m68 100-13 21" stroke={GOLD} strokeWidth="4" />
        <path d="m55 121-2.5 5 4.3-3.4" fill={INK} stroke={INK} strokeWidth="1.5" />
        <Mitt x={65} y={107} />
      </g>
    </> : role === "researcher" ? <>
      {/* a globe on its stand: the meridians turn and a discovery glints */}
      <path d="M36 138h30M51 134v-6" stroke={METAL} strokeWidth="5.5" /><path d="M36 138h30M51 134v-6" stroke={WOOD} strokeWidth="3" />
      <circle cx="51" cy="108" r="20" fill={BEARD} stroke={METAL} strokeWidth="3" />
      <g className="old-orbit" stroke="currentColor" strokeWidth="2.4"><ellipse cx="51" cy="108" rx="9" ry="19" /><path d="M32 108h38M35 98h32M35 118h32" /></g>
      <path d="M28 96a26 26 0 0 0 30 36" stroke={METAL} strokeWidth="3" />
      {twinkle(62, 101, 4.5, "old-discovery")}
      <Mitt x={30} y={122} /><Mitt x={72} y={122} />
    </> : role === "reviewer" ? <>
      {/* the gavel strikes its block beside the paper it decides on */}
      <path d="m18 116 42-3 4 22-42 3Z" fill={BEARD} stroke={METAL} strokeWidth="2.6" />
      <path d="M27 122h22M28 128h14" stroke={INK} strokeWidth="2" opacity="0.7" />
      <rect x="58" y="129" width="28" height="8" rx="3" fill={WOOD} stroke={METAL} strokeWidth="2" />
      <g className="old-stamp">
        <path d="m72 126 9-24" stroke={METAL} strokeWidth="6.5" /><path d="m72 126 9-24" stroke={WOOD} strokeWidth="4" />
        <g transform="rotate(20 82 98)">
          <rect x="72" y="92" width="20" height="12" rx="3.5" fill={BEARD} stroke={METAL} strokeWidth="2.6" />
          <rect x="80" y="92" width="4.4" height="12" fill="currentColor" />
        </g>
        <Mitt x={72} y={126} />
      </g>
    </> : role === "reader" ? <>
      {/* an open book in its role-colored cover; a page turns over the steel spine */}
      <path d="M13 106q20-7 37 3 17-10 37-3l-3 30q-18-5-34 2-16-7-34-2Z" fill="currentColor" stroke={METAL} strokeWidth="2.6" />
      <path d="M17 108q17-5 33 4v24q-15-6-31-2ZM50 112q16-9 33-4l-2 26q-16-4-31 2Z" fill={BEARD} />
      <path d="M50 112v24" stroke={METAL} strokeWidth="2.6" />
      <path d="M24 116l18 2M24 122l18 2M24 128l14 1.5" stroke={INK} strokeWidth="1.8" opacity="0.7" />
      <path className="old-page" d="M50 112q16-9 31-5l-2 25q-15-3-29 4Z" fill={BEARD} stroke={METAL} strokeWidth="1.6" />
      <Mitt x={17} y={132} /><Mitt x={83} y={132} />
    </> : role === "director" ? <>
      {/* the plan-scroll unrolled on the table, and a baton that conducts the crew */}
      <path d="m17 112 44-5 7 26-45 5Z" fill={BEARD} stroke={METAL} strokeWidth="2.6" />
      <path d="M16 111.5 23 138" stroke="currentColor" strokeWidth="5" />
      <path d="M27 119h20M28 125h15M29 131h18" stroke={INK} strokeWidth="2" opacity="0.7" />
      <g className="old-conduct">
        <path d="m70 119 12-26" stroke={METAL} strokeWidth="5" /><path d="m70 119 12-26" stroke={BEARD} strokeWidth="3" />
        {twinkle(83, 90, 6)}
        <Mitt x={70} y={119} />
      </g>
    </> : <>
      {/* coworker: the mug at the owner's desk steams beside a letter it is helping with */}
      <path d="m16 110 40-4 4 27-41 4Z" fill={BEARD} stroke={METAL} strokeWidth="2.6" />
      <path d="m17 111 20 12 19-16" stroke={METAL} strokeWidth="2" />
      <path d="M25 128h18" stroke={INK} strokeWidth="2" opacity="0.7" />
      <path d="M81 116h3a6 6 0 0 1 0 12h-3" stroke={METAL} strokeWidth="3.5" />
      <rect x="63" y="112" width="19" height="24" rx="3.5" fill={BEARD} stroke={METAL} strokeWidth="2.8" />
      <rect x="63" y="119" width="19" height="5.5" fill="currentColor" />
      <path className="old-discovery" d="M68 107q-2.5-4 0-8M75 107q-2.5-4 0-8" stroke={BEARD} strokeWidth="2.6" />
      <Mitt className="old-hand-left" x={34} y={126} /><Mitt x={60} y={132} />
    </>}
  </svg>;
}

/** The director's chair back, behind the figure: a turned-wood frame with a blue cushion. */
function OldRestBack({ rest }: { rest?: DirectorRest }) {
  if (rest !== "chair") return null;
  return <svg className="old-rest-chair" viewBox="0 0 100 150" fill="none" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M18 145V78q0-12 12-12h40q12 0 12 12v67" stroke={METAL} strokeWidth="9" />
    <path d="M18 145V78q0-12 12-12h40q12 0 12 12v67" stroke={WOOD} strokeWidth="6" />
    <rect x="26" y="73" width="48" height="44" rx="9" fill={CLOTH} stroke={METAL} strokeWidth="2.4" />
    <path d="M34 82h32M34 108h32" stroke={BEARD} strokeWidth="1.8" strokeDasharray="3 2.6" opacity="0.8" />
  </svg>;
}

/** The chair seat in front of the figure, or the bed (with its dream) the sleeping director lies in. */
function OldRestFront({ rest }: { rest?: DirectorRest }) {
  if (rest === "chair") return <svg className="old-rest-seat" viewBox="0 0 100 150" fill="none" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="16" y="119" width="68" height="11" rx="4" fill={CLOTH} stroke={METAL} strokeWidth="2.4" />
    <path d="M12 106h18M70 106h18M17 106v22M83 106v22" stroke={METAL} strokeWidth="7.5" />
    <path d="M12 106h18M70 106h18M17 106v22M83 106v22" stroke={WOOD} strokeWidth="4.5" />
  </svg>;
  if (rest !== "sleep") return null;
  return <>
    <svg className="old-rest-bed" viewBox="0 0 160 150" fill="none" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 144V86q0-9 9-9h5v50h127v17M146 129v-24q0-8 6-8v47" stroke={METAL} strokeWidth="9" />
      <path d="M10 144V86q0-9 9-9h5v50h127v17M146 129v-24q0-8 6-8v47" stroke={WOOD} strokeWidth="6" />
      <rect x="18" y="111" width="128" height="22" rx="3" fill={BEARD} stroke={METAL} strokeWidth="2.4" />
      <path d="M24 106q13-9 28 0l-3 14H23Z" fill={BEARD} stroke={METAL} strokeWidth="2.4" />
      <path d="M58 104q44-8 83 5v22H53q6-13 5-27Z" fill={CLOTH} stroke={METAL} strokeWidth="2.4" />
      <path d="M60 112q40-7 78 4" stroke={BEARD} strokeWidth="2" strokeDasharray="3.5 3" opacity="0.8" />
      {twinkle(98, 120, 5)}
      <path d="M17 134h130" stroke={WOOD} strokeWidth="4" />
    </svg>
    <span className="old-sleep-dream" aria-hidden="true">z<span>z</span><span>z</span></span>
  </>;
}
