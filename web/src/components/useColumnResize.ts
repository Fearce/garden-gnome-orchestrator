import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";

/**
 * Drag-to-resize for the workbench's two draggable column edges — the director rail's right edge and
 * the detail panel's left edge.
 *
 * Pointer events, not mouse events: a finger drag fires neither `mousemove` nor `mouseup`, so the
 * mouse-only original did nothing at all on a touchscreen. `setPointerCapture` on the handle keeps the
 * drag alive when the pointer outruns the 7px strip, and the CSS pairs it with `touch-action: none`
 * so the browser doesn't claim the gesture as a scroll before the first move arrives.
 *
 * `onDrag` receives the pointer's viewport x and applies the new width; the clamping differs per edge,
 * so it stays with the caller. Mirrors `useResizableModal`'s dragCleanup ref, for the same reason: an
 * unmount mid-drag would otherwise leave the window listeners behind.
 */
/** The board's floor, from `minmax(320px, 1fr)` in `.workbench`. Keep the two in step. */
export const BOARD_MIN = 320;

/**
 * How wide a side track can get before the grid stops honouring it, given what the other side wants.
 *
 * `.workbench` sizes both side tracks as `minmax(0, <persisted width>)`, so the saved width is a
 * MAXIMUM: one that no longer fits is capped by the grid instead of overflowing the container, which
 * is what used to shear the detail panel off the right edge. The handles have to agree with that, or
 * the drag keeps travelling after the pane has already stopped moving.
 *
 * Grid hands the free space to the two side tracks equally and caps each at its own maximum, so a
 * track can have whatever the other one leaves it, and never less than an even split. Those are the
 * two terms below. The even-split floor is the part worth keeping: without it a stale wide width
 * left over from a bigger monitor pins the OTHER handle at its minimum on a screen with room for
 * both, which is why reserving the sibling's width outright was wrong the first time.
 *
 * Pass `null` for the sibling when it isn't on screen (no task selected, or the rail hidden), which
 * is the two-track template and leaves the whole remainder.
 */
export function columnDragMax(sibling: number | null): number {
  const free = window.innerWidth - BOARD_MIN;
  return sibling === null ? free : Math.max(free / 2, free - sibling);
}

export function useColumnResize(onDrag: (clientX: number) => void) {
  const dragCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => dragCleanup.current?.(), []);

  return useCallback(
    (e: ReactPointerEvent) => {
      if (e.button !== 0) return; // pointerdown fires for every button; only a primary press resizes
      // A second press before the first pointerup would otherwise orphan the first drag's listeners
      // AND leave body.col-resizing set, which is `cursor: col-resize !important` on the whole app.
      dragCleanup.current?.();
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      const onMove = (ev: PointerEvent) => onDrag(ev.clientX);
      const cleanup = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", cleanup);
        window.removeEventListener("pointercancel", cleanup);
        document.body.classList.remove("col-resizing");
        dragCleanup.current = null;
      };
      dragCleanup.current = cleanup;
      document.body.classList.add("col-resizing");
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", cleanup);
      window.addEventListener("pointercancel", cleanup);
    },
    [onDrag],
  );
}
