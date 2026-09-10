/* useIdle.ts: when has nobody touched this console for a while, and when did they come back.
 *
 * Two rules the screensaver depends on, and both are easy to get wrong:
 *
 *   · Coming back is INSTANT. While the scene is up, the very first activity event dismisses it, on
 *     the capture phase and before anything else can consume it. The overlay never sees the click
 *     that dismissed it, so the board underneath keeps whatever state it had.
 *   · Going idle is CHEAP. `mousemove` fires hundreds of times a second, so re-arming a timer on
 *     every one of them would be the most expensive thing on the page while somebody is working.
 *     Activity only writes a timestamp; one interval decides whether that timestamp has gone stale.
 */

import { useEffect, useRef, useState } from "react";

/** The events that count as "somebody is here". Pointer AND mouse: a browser that synthesises mouse
 *  events from pointer ones would otherwise be listened to twice, which is harmless, while a browser
 *  that only emits one of the two must still wake the console. */
const ACTIVITY_EVENTS = ["pointerdown", "pointermove", "mousedown", "mousemove", "keydown", "wheel", "touchstart", "scroll"] as const;

/** How often the idle clock is checked. A screensaver's delay is minutes, so one second of jitter on
 *  the way in is invisible, and this is the entire cost of idle detection while somebody works. */
const TICK_MS = 1000;

/** The scene ignores dismissal for this long after it appears. Showing a full-viewport overlay under
 *  a stationary cursor can emit one synthetic mouse event in some browsers, which would dismiss the
 *  screensaver in the same frame it arrived and look like it never worked. Well under the ~100ms a
 *  deliberate human input takes, so a real return still reads as instant. */
const ARM_MS = 350;

/**
 * `true` once nothing has happened for `idleMs`. Any activity clears it immediately.
 *
 * Passing `enabled: false` tears every listener down and reports `false`, so a console with the
 * screensaver switched off carries no idle machinery at all.
 */
export function useIdle(idleMs: number, enabled: boolean): boolean {
  const [idle, setIdle] = useState(false);
  // Refs, not state: activity must not re-render the app while somebody is working.
  const lastActivity = useRef(Date.now());
  const shownAt = useRef(0);

  useEffect(() => {
    if (!enabled) {
      setIdle(false);
      return;
    }
    lastActivity.current = Date.now();

    const onActivity = (): void => {
      lastActivity.current = Date.now();
      // Reading state through the setter keeps this handler free of a dependency on `idle`, so the
      // listeners are attached once for the life of the setting rather than on every wake.
      setIdle((wasIdle) => (wasIdle && Date.now() - shownAt.current >= ARM_MS ? false : wasIdle));
    };

    // Capture phase: the wake must not depend on the event reaching a particular element, and the
    // overlay must never be the thing that handles it.
    for (const type of ACTIVITY_EVENTS) window.addEventListener(type, onActivity, { capture: true, passive: true });

    const timer = window.setInterval(() => {
      setIdle((wasIdle) => {
        const nowIdle = Date.now() - lastActivity.current >= idleMs;
        if (nowIdle && !wasIdle) shownAt.current = Date.now();
        return nowIdle;
      });
    }, TICK_MS);

    return () => {
      for (const type of ACTIVITY_EVENTS) window.removeEventListener(type, onActivity, { capture: true });
      window.clearInterval(timer);
    };
  }, [enabled, idleMs]);

  return enabled && idle;
}

/** Whether this browser is asking for as little motion as possible. Read live rather than once, so
 *  flipping the OS setting takes effect without a reload. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => matchMediaSafe("(prefers-reduced-motion: reduce)")?.matches ?? false);
  useEffect(() => {
    const mq = matchMediaSafe("(prefers-reduced-motion: reduce)");
    if (!mq) return;
    const onChange = (e: MediaQueryListEvent): void => setReduced(e.matches);
    mq.addEventListener("change", onChange);
    setReduced(mq.matches);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

/** `matchMedia` is missing under the SSR harness the console's UI gates render with. */
function matchMediaSafe(query: string): MediaQueryList | null {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query) : null;
}

/** `true` while the tab is in the background. A screensaver that keeps a rAF loop alive on a hidden
 *  tab is a battery leak nobody can see, so this is what stops the loop. */
export function useDocumentHidden(): boolean {
  const [hidden, setHidden] = useState(() => (typeof document !== "undefined" ? document.hidden : false));
  useEffect(() => {
    const onChange = (): void => setHidden(document.hidden);
    document.addEventListener("visibilitychange", onChange);
    setHidden(document.hidden);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return hidden;
}
