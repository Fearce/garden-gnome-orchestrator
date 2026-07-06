import { useCallback, useEffect, useReducer, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";

// Drag-to-resize for the deliverable preview modal. The modal is centered by its scrim, so an edge
// tracks the cursor when its size changes by 2× the drag delta (the opposite edge grows in lockstep).
// The chosen size is remembered in localStorage so a preferred width/height survives re-opens; it's
// clamped to the current viewport at render time, so a size saved on a big screen can't push the
// modal off-screen when reopened on a smaller one.

const STORAGE_KEY = "deliverable-modal-size";
const MIN_W = 360;
const MIN_H = 240;
const VIEWPORT_MARGIN = 24;

type Size = { w: number; h: number };

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

function loadSize(): Size | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<Size> | null;
    if (parsed && typeof parsed.w === "number" && typeof parsed.h === "number") return { w: parsed.w, h: parsed.h };
  } catch {
    // Corrupt/absent value — fall back to the CSS default size.
  }
  return null;
}

export function useResizableModal() {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<Size | null>(loadSize);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  // Holds the teardown for an in-flight drag so an unmount mid-drag can't leak window listeners.
  const dragCleanup = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (size) localStorage.setItem(STORAGE_KEY, JSON.stringify(size));
  }, [size]);

  // Recompute the clamp bounds live as the window resizes, and tear down any pending drag on unmount.
  useEffect(() => {
    window.addEventListener("resize", rerender);
    return () => {
      window.removeEventListener("resize", rerender);
      dragCleanup.current?.();
    };
  }, []);

  const startResize = useCallback((e: ReactPointerEvent, dirX: 0 | 1, dirY: 0 | 1) => {
    const el = ref.current;
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = el.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = rect.width;
    const startH = rect.height;
    const maxW = window.innerWidth - VIEWPORT_MARGIN;
    const maxH = window.innerHeight - VIEWPORT_MARGIN;

    const onMove = (ev: PointerEvent) => {
      const w = clamp(startW + (ev.clientX - startX) * 2 * dirX, MIN_W, maxW);
      const h = clamp(startH + (ev.clientY - startY) * 2 * dirY, MIN_H, maxH);
      setSize({ w, h });
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", cleanup);
      document.body.classList.remove("dl-resizing");
      dragCleanup.current = null;
    };
    dragCleanup.current = cleanup;
    document.body.classList.add("dl-resizing");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", cleanup);
  }, []);

  const reset = useCallback(() => {
    setSize(null);
    localStorage.removeItem(STORAGE_KEY);
  }, []);

  let style: CSSProperties | undefined;
  if (size) {
    const w = clamp(size.w, MIN_W, window.innerWidth - VIEWPORT_MARGIN);
    const h = clamp(size.h, MIN_H, window.innerHeight - VIEWPORT_MARGIN);
    style = { width: `${w}px`, height: `${h}px`, maxWidth: "none", maxHeight: "none" };
  }

  return { ref, style, startResize, reset };
}
