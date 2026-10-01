import { useSyncExternalStore } from "react";

/** Deliberately browser-local and opt-in. Never becomes a server/settings default. */
export const BETA_GNOMES_KEY = "ggo:beta-gnomes";
const listeners = new Set<() => void>();
function readPreference(): boolean {
  try { return typeof localStorage !== "undefined" && localStorage.getItem(BETA_GNOMES_KEY) === "1"; }
  catch { return false; }
}
let enabled = readPreference();
function notify() { for (const listener of listeners) listener(); }
function onStorage(event: StorageEvent) {
  if (event.key !== null && event.key !== BETA_GNOMES_KEY) return;
  enabled = readPreference();
  notify();
}
function subscribe(listener: () => void) {
  if (!listeners.size && typeof window !== "undefined") window.addEventListener("storage", onStorage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size && typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}
export function setBetaGnomes(value: boolean) {
  enabled = value;
  try { localStorage.setItem(BETA_GNOMES_KEY, value ? "1" : "0"); } catch { /* Still works for this visit. */ }
  notify();
}
export function useBetaGnomes() {
  return useSyncExternalStore(subscribe, () => enabled, () => false);
}

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
