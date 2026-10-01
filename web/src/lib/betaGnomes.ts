import { useSyncExternalStore } from "react";

/** Deliberately browser-local and opt-in. Never becomes a server/settings default. */
export const BETA_GNOMES_KEY = "ggo:beta-gnomes";
/** The workshop header for the original gnomes. Independent of beta gnomes, which always use it. */
export const CLASSIC_WORKSHOP_KEY = "ggo:classic-workshop";

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
  return { set, use };
}

const betaGnomes = browserFlag(BETA_GNOMES_KEY);
export const setBetaGnomes = betaGnomes.set;
export const useBetaGnomes = betaGnomes.use;
const classicWorkshop = browserFlag(CLASSIC_WORKSHOP_KEY);
export const setClassicWorkshop = classicWorkshop.set;
export const useClassicWorkshop = classicWorkshop.use;

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
