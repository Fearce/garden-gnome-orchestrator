import { useId, type ReactNode } from "react";

/** A still, translucent ice block around either gnome artwork. No canvas, filters or animation loop. */
export function FrozenGnome({ size, children }: { size: number; children: ReactNode }) {
  const ice = useId();
  return <span className="gnome-ice" aria-hidden="true" style={{ width: size, height: size * 1.5 }}>
    <svg className="gnome-ice-back" viewBox="0 0 48 72" fill="none">
      <path d="m3 9 10-7 31 4 2 59-10 6-33-4Z" fill="#65bdda" fillOpacity=".24" stroke="#b3efff" strokeWidth="1.2" />
      <path d="m3 9 33 4 8-7M36 13v58" stroke="#bcefff" strokeOpacity=".6" />
    </svg>
    <span className="gnome-ice-figure">{children}</span>
    <svg className="gnome-ice-front" viewBox="0 0 48 72" fill="none">
      <defs><linearGradient id={ice} x1="3" y1="8" x2="39" y2="67" gradientUnits="userSpaceOnUse">
        <stop stopColor="#ecfcff" stopOpacity=".5" /><stop offset=".45" stopColor="#9adef4" stopOpacity=".08" /><stop offset="1" stopColor="#75c9ed" stopOpacity=".45" />
      </linearGradient></defs>
      <path d="m3 9 33 4v58L3 67Z" fill={`url(#${ice})`} stroke="#d0f6ff" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="m36 13 8-7 2 59-10 6Z" fill="#7dcce8" fillOpacity=".34" stroke="#b1eaff" strokeWidth="1.2" />
      <path d="m3 9 10-7 31 4-8 7Z" fill="#dcf8ff" fillOpacity=".65" />
      <path d="m7 18 19-2M7 22l8-1M6 58l26 3M9 13v19m30-12 1 27" stroke="#ecfcff" strokeOpacity=".7" strokeWidth="1.4" strokeLinecap="round" />
      <path d="m4 39 7 5-4 8m4-8 8 2M34 24l-6 7 4 6m-4-6-5 1" stroke="#e1faff" strokeOpacity=".65" strokeWidth=".9" />
      <path d="m7 61 2-3 2 5 4-3 3 6 5-3 3 5 4-3 4 4-29-3Z" fill="#e3faff" fillOpacity=".6" />
      <path d="M38 48v10m-4-8 8 6m0-6-8 6" stroke="#effcff" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  </span>;
}
