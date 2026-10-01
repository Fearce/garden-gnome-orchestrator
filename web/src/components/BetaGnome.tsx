import { memo, useEffect, useRef, type CSSProperties } from "react";
import type { GnomeRole } from "../types.js";
import { observeGnomeMotion } from "../lib/betaGnomes.js";
import { betaGnomeAtlas, betaGnomeCast } from "../lib/betaGnomeArt.js";
import type { DirectorRest } from "../lib/directorRest.js";

/** Artwork is a single shared texture. Only the small tool rig and transforms animate. */
export const BetaGnome = memo(function BetaGnome({ role, size = 30, active = true, className = "", skin, rest }: {
  role: GnomeRole; size?: number; active?: boolean; className?: string; skin?: string | null; rest?: DirectorRest;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const { column, row, accent } = betaGnomeCast[role];
  // At avatar sizes moving tools become noise; keep the illustration crisp and still.
  const animated = active && !rest && size >= 28;
  const texture: CSSProperties = { backgroundImage: `url("${betaGnomeAtlas}")`, backgroundPosition: `${column * 100 / 3}% ${row * 100}%` };
  useEffect(() => {
    if ((animated || rest) && ref.current) return observeGnomeMotion(ref.current);
  }, [animated, rest]);
  return <span ref={ref} aria-hidden="true" data-role={role} data-active={active} data-animated={animated}
    data-skin={skin || undefined} data-rest={rest} className={`gnome beta-gnome ${className}`}
    style={{ width: size, height: size * 1.5, "--gnome-accent": accent } as CSSProperties}>
    <span className="beta-gnome-shadow" />
    <RestFurnitureBack rest={rest} />
    <span className="beta-gnome-body" style={texture} />
    <span className="beta-gnome-boot beta-boot-left" style={texture} />
    <span className="beta-gnome-boot beta-boot-right" style={texture} />
    <RestFurnitureFront rest={rest} />
    {!rest && size >= 28 && <ToolRig role={role} />}
    {skin && <span className="beta-gnome-charm">✦</span>}
  </span>;
});

/** Director rest furniture behind the figure (chair back). Shared by the beta and classic workshop art;
 *  both draw on the same 2:3 box, so one set of paths fits either gnome. */
export function RestFurnitureBack({ rest }: { rest?: DirectorRest }) {
  return <>
    {rest === "chair" && <svg className="beta-rest-chair" viewBox="0 0 100 150" fill="none">
      <path d="M15 145V76q0-7 7-7h53q7 0 7 7v69M17 110h64" stroke="#805438" strokeWidth="7" strokeLinejoin="round" />
      <path d="M24 78h49v40H24z" fill="#28585c" stroke="#c29b64" strokeWidth="2" />
      <path d="M30 82h37v29H30z" stroke="#71a194" strokeOpacity=".5" /><path d="m48 85 4 7-4 7-4-7z" fill="#c8b07b" />
    </svg>}
  </>;
}

/** Director rest furniture in front of the figure: the chair seat, or the bed and its dream. */
export function RestFurnitureFront({ rest }: { rest?: DirectorRest }) {
  return <>
    {rest === "chair" && <svg className="beta-rest-seat" viewBox="0 0 100 150" fill="none">
      <path d="M17 120h64v9H17z" fill="#396c69" stroke="#d0a76e" strokeWidth="2" />
      <path d="M14 108h17m38 0h16M19 108v19m61-19v19" stroke="#ae7b4f" strokeWidth="5" strokeLinecap="round" />
    </svg>}
    {rest === "sleep" && <>
      <svg className="beta-rest-bed" viewBox="0 0 160 150" fill="none">
        <path d="M9 144V87q0-9 9-9h6v49h127v17M144 129v-26q0-7 7-7v48" stroke="#b28258" strokeWidth="7" strokeLinecap="round" />
        <path d="M18 111h127v22H18z" fill="#e7d8b4" stroke="#976948" strokeWidth="2" />
        <path d="M25 105q12-8 27 1l-3 14H24z" fill="#fff0cf" stroke="#d2b986" strokeWidth="2" />
        <path className="beta-sleep-blanket" d="M58 103q44-7 82 6v22H53q6-13 5-28Z" fill="#565582" stroke="#aba0d2" strokeWidth="2" />
        <path d="M69 108v18m21-19v20m21-18v18m21-15v15M61 116h76" stroke="#8a80b3" strokeWidth="1.5" />
        <path d="m93 111 2 4 5 1-4 3 1 5-4-3-4 3 1-5-4-3 5-1z" fill="#e9cd8b" />
        <path d="M17 133h130" stroke="#d4a273" strokeWidth="4" />
      </svg>
      <span className="beta-sleep-dream">z<span>z</span><span>z</span></span>
    </>}
  </>;
}

function ToolRig({ role }: { role: GnomeRole }) {
  // A foreground work surface, hands and tool each have their own motion: typing,
  // examining, writing, turning a page or stamping. These never imply task completion.
  return <svg className={`beta-tool beta-tool-${role}`} viewBox="0 0 100 150" fill="none">
    {role === "implementor" ? <>
      <path d="M17 107h69l5 25H11z" fill="#5b3831" stroke="#ba8757" strokeWidth="2" />
      <rect x="28" y="87" width="53" height="31" rx="4" fill="#172d35" stroke="#d3a064" strokeWidth="3" />
      <g className="beta-code" stroke="#8febcb" strokeWidth="2"><path d="m35 95-4 3 4 3m9-6 4 3-4 3m-5-7-2 9M54 96h16M54 101h10M34 109h30" /></g>
      <path d="m23 120 55 0 5 7H17z" fill="#a68970" /><path d="M24 123h50" stroke="#473735" strokeWidth="2" strokeDasharray="3 2" />
      <ellipse className="beta-hand beta-hand-left" cx="32" cy="122" rx="7" ry="4" fill="#edb181" />
      <ellipse className="beta-hand beta-hand-right" cx="64" cy="122" rx="7" ry="4" fill="#f5c394" />
    </> : role === "qa" ? <>
      <path d="m20 104 43-5 6 34-43 4z" fill="#f4e6c5" stroke="#b1865a" strokeWidth="2" />
      <g stroke="#478272" strokeWidth="2"><path d="m29 112 3 3 5-7m-6 13 3 3 5-7M43 110h12M45 119h11" /></g>
      <g className="beta-inspect"><path d="m66 117 14 16" stroke="#d4a666" strokeWidth="5" /><circle cx="61" cy="110" r="13" fill="#6edeca" fillOpacity=".2" stroke="#ffdaa0" strokeWidth="4" /><path d="M54 105q4-5 9-3" stroke="#edffff" strokeWidth="2" strokeLinecap="round" /><ellipse cx="75" cy="127" rx="6" ry="4" fill="#f4bd8d" /></g>
    </> : role === "planner" ? <>
      <path d="m15 106 62-3 6 32-63 2z" fill="#244d77" stroke="#b5d3e8" strokeWidth="2" />
      <path d="M24 115h16v12H24zm24-5h18v9H48zM40 120h9v7h18" stroke="#a0d4f4" strokeWidth="1.5" />
      <g className="beta-write"><path d="m65 106-13 20" stroke="#f3c16c" strokeWidth="4" /><path d="m52 126-3 4 1-5" fill="#fff4c4" /><ellipse cx="62" cy="111" rx="7" ry="4" fill="#f4bd8d" /></g>
    </> : role === "researcher" ? <>
      <path d="M33 136h38m-19-3v-9" stroke="#d7ab69" strokeWidth="3" /><circle cx="51" cy="111" r="21" fill="#123f49" stroke="#e5ba77" strokeWidth="3" />
      <g className="beta-orbit" stroke="#6edccc" strokeWidth="1.5"><ellipse cx="51" cy="111" rx="10" ry="20" /><path d="M31 111h40M35 100h31M35 122h31" /></g><circle className="beta-discovery" cx="60" cy="105" r="3" fill="#fff0b1" />
    </> : role === "reviewer" ? <>
      <path d="m21 116 46-3 4 23-46 2z" fill="#f0e3bf" /><path d="M30 122h22m-21 6h13" stroke="#9e946e" strokeWidth="2" /><path d="M56 134h25" stroke="#bc9152" strokeWidth="4" />
      <g className="beta-stamp"><path d="m61 112 8 14" stroke="#bc9152" strokeWidth="5" /><rect x="48" y="101" width="24" height="11" rx="3" transform="rotate(-25 60 106)" fill="#74533b" stroke="#e0bd7c" strokeWidth="2" /><ellipse cx="66" cy="120" rx="6" ry="4" fill="#f4bd8d" /></g>
    </> : role === "reader" ? <>
      <path d="M15 105q20-6 35 4 15-10 35-4l-3 28q-18-5-32 2-14-7-32-2z" fill="#f5e4bd" stroke="#987559" strokeWidth="2" /><path d="M50 109v26M24 115l17 2m-17 5 17 2m17-7 17-2m-17 9 17-2" stroke="#ae9b7d" strokeWidth="1.5" />
      <path className="beta-page" d="M50 109q15-10 31-5l-2 26q-17-3-29 5z" fill="#fff2d2" stroke="#c9b994" />
    </> : role === "director" ? <>
      <path d="m18 112 43-5 8 26-44 5z" fill="#efdbb4" stroke="#af835c" strokeWidth="2" /><path d="M29 118h18m-16 5h13" stroke="#9a795d" strokeWidth="2" />
      <g className="beta-conduct"><path d="m69 121 13-25" stroke="#e2b979" strokeWidth="3" /><path d="m83 87 2 6 6 2-6 2-2 6-2-6-6-2 6-2z" fill="#ffe2a5" /><ellipse cx="70" cy="119" rx="6" ry="4" fill="#f4bd8d" /></g>
    </> : <><path d="m25 111 51-5 4 26-52 5z" fill="#eac390" stroke="#a67851" strokeWidth="2" /><path d="m26 112 28 12 22-17" stroke="#9c7454" strokeWidth="2" /><circle className="beta-discovery" cx="54" cy="123" r="5" fill="#74d5c6" /></>}
  </svg>;
}
