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
function applyPause(element: HTMLElement, onScreen: boolean) {
  element.dataset.paused = String(!onScreen || document.visibilityState === "hidden");
}
function visibilityChanged() { for (const [element, onScreen] of visible) applyPause(element, onScreen); }
export function observeGnomeMotion(element: HTMLElement) {
  if (!visible.size) document.addEventListener("visibilitychange", visibilityChanged);
  visible.set(element, true);
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
    if (!visible.size) {
      observer?.disconnect();
      observer = undefined;
      document.removeEventListener("visibilitychange", visibilityChanged);
    }
  };
}
