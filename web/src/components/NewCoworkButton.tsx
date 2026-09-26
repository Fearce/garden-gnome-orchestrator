import { lazy, Suspense, useState } from "react";
import { LazyChunkBoundary } from "./LazyChunkBoundary.js";
const NewCoworkModal = lazy(() => import("./CoWork.js").then(m => ({ default: m.NewCoworkModal })));

/** The board's way into a new session. Creation opens the new session's popup (the store selects it on
 *  the server's receipt), so the owner lands straight in the conversation they just asked for. */
export function NewCoworkButton({ className = "btn ghost sm" }: { className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className={`${className} cowork-new`} onClick={() => setOpen(true)} title="Start a Co-work session: a conversation you lead turn by turn">
        <PlusIcon /> New Co-work
      </button>
      {open ? <LazyChunkBoundary label="New Co-work"><Suspense fallback={null}><NewCoworkModal onClose={() => setOpen(false)} /></Suspense></LazyChunkBoundary> : null}
    </>
  );
}

function PlusIcon() { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M12 5v14M5 12h14" /></svg>; }
