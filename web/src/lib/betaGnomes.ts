import { useSyncExternalStore } from "react";

/** Deliberately browser-local and opt-in. Never becomes a server/settings default. */
export const BETA_GNOMES_KEY = "ggo:beta-gnomes";
/** "Old gnomes beta": the original gnomes in the workshop header, with their own animation set. It keeps
 *  the key of the earlier "Workshop header for classic gnomes" toggle, so a saved choice carries over.
 *  It and Beta gnomes are alternative casts: switching one on switches the other off. */
export const OLD_GNOMES_BETA_KEY = "ggo:classic-workshop";

/** One default-off "1"/"0" flag in localStorage, live across tabs through the storage event. */
function browserFlag(key: string) {
  const listeners = new Set<() => void>();
  const read = () => {
    try { return typeof localStorage !== "undefined" && localStorage.getItem(key) === "1"; }
    catch { return false; }
  };
  let enabled = read();
  const notify = () => { for (const listener of listeners) listener(); };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== key) return;
    enabled = read();
    notify();
  };
  const subscribe = (listener: () => void) => {
    if (!listeners.size && typeof window !== "undefined") window.addEventListener("storage", onStorage);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size && typeof window !== "undefined") window.removeEventListener("storage", onStorage);
    };
  };
  const set = (value: boolean) => {
    enabled = value;
    try { localStorage.setItem(key, value ? "1" : "0"); } catch { /* Still works for this visit. */ }
    notify();
  };
  const use = () => useSyncExternalStore(subscribe, () => enabled, () => false);
  return { get: () => enabled, set, use };
}

const betaGnomes = browserFlag(BETA_GNOMES_KEY);
const oldGnomesBeta = browserFlag(OLD_GNOMES_BETA_KEY);
// Before the two became alternatives both could be saved on, and beta won. Old gnomes beta is the
// explicit choice of the original cast, so it keeps its place and beta is switched off once.
if (betaGnomes.get() && oldGnomesBeta.get()) betaGnomes.set(false);

export function setBetaGnomes(on: boolean) {
  if (on) oldGnomesBeta.set(false);
  betaGnomes.set(on);
}
export function setOldGnomesBeta(on: boolean) {
  if (on) betaGnomes.set(false);
  oldGnomesBeta.set(on);
}
/** Beta artwork shows only while Old gnomes beta is off, even if a tab on an older build saved both. */
export function useBetaGnomes() {
  const old = oldGnomesBeta.use();
  return betaGnomes.use() && !old;
}
export const useOldGnomesBeta = oldGnomesBeta.use;

// One observer and one visibility listener for the entire cast. No animation-frame JS,
// per-character timers, or React updates while the gnomes move.
let observer: IntersectionObserver | undefined;
const visible = new Map<HTMLElement, boolean>();

/** Gnome loops play at film rate: their CSS animations stay paused (`data-motion-clock`) and one shared
 *  clock seeks them this many times a second. Free-running 60fps loops on a 24-gnome crowd cost twice
 *  the main thread of 5fps; 24 adds about a quarter and reads as smooth (5 read as lag). Seeking
 *  re-styles only the animated elements, where an inherited clock property would re-style the cast. */
export const GNOME_MOTION_FPS = 24;
let clock: number | undefined;
const clockOrigin = typeof performance === "undefined" ? 0 : performance.now();
function advanceGnomes() {
  const now = Math.round(performance.now() - clockOrigin);
  for (const element of visible.keys()) {
    if (element.dataset.paused === "true" || element.dataset.motionPaused === "true" || element.parentElement?.closest("[data-motion-clock]")) continue;
    for (const animation of element.getAnimations({ subtree: true })) if (animation instanceof CSSAnimation) animation.currentTime = now;
  }
}
function applyPause(element: HTMLElement, onScreen: boolean) {
  element.dataset.paused = String(!onScreen || document.visibilityState === "hidden");
}
function visibilityChanged() { for (const [element, onScreen] of visible) applyPause(element, onScreen); }
export function observeGnomeMotion(element: HTMLElement) {
  if (!visible.size) {
    document.addEventListener("visibilitychange", visibilityChanged);
    clock = window.setInterval(advanceGnomes, 1000 / GNOME_MOTION_FPS);
  }
  visible.set(element, true);
  element.dataset.motionClock = "";
  applyPause(element, true);
  if (typeof IntersectionObserver !== "undefined") {
    observer ??= new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const target = entry.target as HTMLElement;
        if (!visible.has(target)) continue;
        visible.set(target, entry.isIntersecting);
        applyPause(target, entry.isIntersecting);
      }
    }, { rootMargin: "24px" });
    observer.observe(element);
  }
  return () => {
    observer?.unobserve(element);
    visible.delete(element);
    delete element.dataset.motionClock;
    if (!visible.size) {
      observer?.disconnect();
      observer = undefined;
      document.removeEventListener("visibilitychange", visibilityChanged);
      window.clearInterval(clock);
      clock = undefined;
    }
  };
}
