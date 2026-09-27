import { useEffect, useRef, type RefObject } from "react";

/** Phone gestures: pull a full-screen sheet down from its top edge (or swipe the task panel right) to
 *  close it, and swipe the workbench sideways to change between the Director and the board. Touch
 *  listeners are native and non-passive, because a claimed drag has to cancel the browser's own
 *  scroll and pull-to-refresh, and React only registers passive touch handlers. */

export const PHONE_MQ = "(max-width: 899.98px)";
/** How far below a sheet's top edge a pull-down may start. Lower down, a downward drag scrolls. */
export const PULL_ZONE_PX = 64;
const SLOP_PX = 10;
const SETTLE_MS = 190;

export type DragDirection = "pending" | "down" | "up" | "left" | "right";

/** Which way a drag is going once it has left the slop circle. Sideways needs a clear lead over
 *  vertical, so a slightly diagonal scroll stays a scroll. */
export function classifyDrag(dx: number, dy: number): DragDirection {
  if (Math.hypot(dx, dy) < SLOP_PX) return "pending";
  if (Math.abs(dx) > Math.abs(dy) * 1.2) return dx > 0 ? "right" : "left";
  return dy > 0 ? "down" : "up";
}

/** A release commits when it travelled far enough, or was a short, fast flick in the same direction. */
export function commitsAt(distance: number, velocity: number, full: number): boolean {
  return distance >= full || (distance >= 40 && velocity >= 0.5);
}

export type WorkbenchPane = "director" | "board";

/** The Director sits left of the board in the bottom nav, so dragging the page right reveals it. */
export function paneAfterSwipe(pane: WorkbenchPane, dx: number): WorkbenchPane | null {
  if (dx > 0 && pane === "board") return "director";
  if (dx < 0 && pane === "director") return "board";
  return null;
}

const EXEMPT = "input, textarea, select, [contenteditable=''], [contenteditable='true'], .monaco-editor, .resize-handle, [data-no-swipe]";

/** A touch that starts in a text field, an editor, or something that already scrolls sideways
 *  belongs to that element, not to a page gesture. */
export function startsInExemptTarget(target: EventTarget | null, root: Element, sideways: boolean): boolean {
  for (let el = target instanceof Element ? target : null; el && el !== root; el = el.parentElement) {
    if (el.matches(EXEMPT)) return true;
    if (sideways && scrollsSideways(el)) return true;
  }
  return false;
}

function scrollsSideways(el: Element): boolean {
  if (el.scrollWidth <= el.clientWidth + 1) return false;
  const overflow = getComputedStyle(el).overflowX;
  return overflow === "auto" || overflow === "scroll";
}

interface Track {
  x: number;
  y: number;
  dir: DragDirection;
  samples: { t: number; x: number; y: number }[];
}

function beginTrack(t: Touch): Track {
  return { x: t.clientX, y: t.clientY, dir: "pending", samples: [{ t: performance.now(), x: t.clientX, y: t.clientY }] };
}

function sample(track: Track, t: Touch) {
  track.samples.push({ t: performance.now(), x: t.clientX, y: t.clientY });
  if (track.samples.length > 6) track.samples.shift();
}

/** Speed along the committed axis over the last few samples, in px/ms. */
function releaseVelocity(track: Track, axis: "x" | "y"): number {
  const first = track.samples[0]!;
  const last = track.samples[track.samples.length - 1]!;
  const dt = last.t - first.t;
  return dt > 0 ? Math.abs(last[axis] - first[axis]) / dt : 0;
}

const onPhone = () => window.matchMedia(PHONE_MQ).matches;
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Animate `el` to `transform`, then run `done` once the settle has had time to finish. */
function settle(el: HTMLElement, transform: string, done: () => void) {
  el.classList.add("swipe-settling");
  el.style.transform = transform;
  window.setTimeout(done, reducedMotion() ? 0 : SETTLE_MS);
}

function release(el: HTMLElement) {
  el.classList.remove("swipe-dragging", "swipe-settling");
  el.style.transform = "";
}

function useLatest<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

/** Close a phone sheet by pulling it down from its top edge, like a native modal sheet. With
 *  `swipeRight` it also closes on a rightward swipe that starts anywhere, the way a pushed screen goes
 *  back. The sheet follows the finger and slides out on commit. A ref target must be attached by the
 *  time the component mounts; a sheet that renders later needs a state callback ref instead, or the
 *  listeners never attach. */
export function useSwipeDismiss(
  target: HTMLElement | null | RefObject<HTMLElement | null>,
  onDismiss: () => void,
  { swipeRight = false } = {},
) {
  const dismiss = useLatest(onDismiss);
  useEffect(() => {
    const el = target && "current" in target ? target.current : target;
    if (!el) return;
    let track: Track | null = null;
    let fromTop = false;

    const start = (e: TouchEvent) => {
      track = null;
      if (e.touches.length !== 1 || !onPhone() || el.classList.contains("swipe-settling")) return;
      const t = e.touches[0]!;
      fromTop = t.clientY - el.getBoundingClientRect().top <= PULL_ZONE_PX;
      if (!fromTop && !swipeRight) return;
      if (startsInExemptTarget(e.target, el, swipeRight && !fromTop) || inOverlay(e.target, el)) return;
      track = beginTrack(t);
    };

    const move = (e: TouchEvent) => {
      if (!track) return;
      const t = e.touches[0]!;
      const dx = t.clientX - track.x;
      const dy = t.clientY - track.y;
      if (track.dir === "pending") {
        const dir = classifyDrag(dx, dy);
        if (dir === "pending") {
          if (fromTop && dy > 0 && e.cancelable) e.preventDefault();
          return;
        }
        const claimed = (dir === "down" && fromTop) || (dir === "right" && swipeRight && !startsInExemptTarget(e.target, el, true));
        if (!claimed) return void (track = null);
        track.dir = dir;
        el.classList.add("swipe-dragging");
      }
      if (e.cancelable) e.preventDefault();
      sample(track, t);
      el.style.transform = track.dir === "down" ? `translate3d(0, ${Math.max(0, dy)}px, 0)` : `translate3d(${Math.max(0, dx)}px, 0, 0)`;
    };

    const end = (e: TouchEvent) => {
      const done = track;
      track = null;
      if (!done || done.dir === "pending") return;
      const last = done.samples[done.samples.length - 1]!;
      const vertical = done.dir === "down";
      const distance = vertical ? last.y - done.y : last.x - done.x;
      const full = (vertical ? el.clientHeight : el.clientWidth) * 0.28;
      const commit = e.type === "touchend" && commitsAt(distance, releaseVelocity(done, vertical ? "y" : "x"), full);
      if (!commit) return settle(el, "", () => release(el));
      settle(el, vertical ? "translate3d(0, 100%, 0)" : "translate3d(100%, 0, 0)", () => {
        dismiss.current();
        // A sheet that refuses to close must not stay parked off-screen.
        window.setTimeout(() => { if (el.isConnected) release(el); }, 60);
      });
    };

    el.addEventListener("touchstart", start, { passive: true });
    el.addEventListener("touchmove", move, { passive: false });
    el.addEventListener("touchend", end);
    el.addEventListener("touchcancel", end);
    return () => {
      el.removeEventListener("touchstart", start);
      el.removeEventListener("touchmove", move);
      el.removeEventListener("touchend", end);
      el.removeEventListener("touchcancel", end);
      release(el);
    };
  }, [target, dismiss, swipeRight]);
}

/** Swipe the phone workbench sideways to move between the Director and the board. Only the
 *  direction that leads somewhere follows the finger freely; the other one resists. */
export function useSwipePanes(
  el: HTMLElement | null,
  pane: WorkbenchPane,
  setPane: (pane: WorkbenchPane) => void,
  enabled: boolean,
) {
  const state = useLatest({ pane, setPane });
  useEffect(() => {
    if (!el || !enabled) return;
    let track: Track | null = null;

    const start = (e: TouchEvent) => {
      track = null;
      if (e.touches.length !== 1 || !onPhone()) return;
      if (startsInExemptTarget(e.target, el, true) || inOverlay(e.target, el)) return;
      track = beginTrack(e.touches[0]!);
    };

    const move = (e: TouchEvent) => {
      if (!track) return;
      const t = e.touches[0]!;
      const dx = t.clientX - track.x;
      if (track.dir === "pending") {
        const dir = classifyDrag(dx, t.clientY - track.y);
        if (dir === "pending") return;
        if ((dir !== "left" && dir !== "right") || document.querySelector(".card-drag-overlay .card, .card-drag-overlay .cowork-card")) return void (track = null);
        track.dir = dir;
        el.classList.add("swipe-dragging");
      }
      if (e.cancelable) e.preventDefault();
      sample(track, t);
      const leads = paneAfterSwipe(state.current.pane, dx) !== null;
      const shift = leads ? Math.sign(dx) * Math.min(Math.abs(dx) * 0.4, 72) : dx * 0.1;
      el.style.transform = `translate3d(${shift}px, 0, 0)`;
    };

    const end = (e: TouchEvent) => {
      const done = track;
      track = null;
      if (!done || done.dir === "pending") return;
      const dx = done.samples[done.samples.length - 1]!.x - done.x;
      const next = paneAfterSwipe(state.current.pane, dx);
      const commit = e.type === "touchend" && next && commitsAt(Math.abs(dx), releaseVelocity(done, "x"), el.clientWidth * 0.3);
      settle(el, "", () => release(el));
      if (commit) state.current.setPane(next);
    };

    el.addEventListener("touchstart", start, { passive: true });
    el.addEventListener("touchmove", move, { passive: false });
    el.addEventListener("touchend", end);
    el.addEventListener("touchcancel", end);
    return () => {
      el.removeEventListener("touchstart", start);
      el.removeEventListener("touchmove", move);
      el.removeEventListener("touchend", end);
      el.removeEventListener("touchcancel", end);
      release(el);
    };
  }, [el, state, enabled]);
}

/** Dialogs and sheets rendered inside `root` (the Co-work popup inside the workbench, a modal over
 *  that popup, the Director's options sheet) own their own touches. */
function inOverlay(target: EventTarget | null, root: Element): boolean {
  const el = target instanceof Element ? target.closest("[role='dialog'], .scrim, .composer-options.sheet") : null;
  return !!el && el !== root && root.contains(el);
}
