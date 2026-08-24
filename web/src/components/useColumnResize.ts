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
