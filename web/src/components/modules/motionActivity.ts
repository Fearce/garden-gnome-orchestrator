import { useSyncExternalStore } from "react";

export interface MotionActivity { cameraId: string; cameraName: string; at: number }
const KEY = "ggo:surveillance-motion-activity";
const LIMIT = 20;
function restore(): MotionActivity[] {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((item): item is MotionActivity =>
      item && typeof item.cameraId === "string" && typeof item.cameraName === "string" &&
      typeof item.at === "number" && Number.isFinite(item.at) && item.at > 0 && item.at <= 8.64e15).slice(0, LIMIT) : [];
  } catch { return []; }
}
let activity = restore();
const listeners = new Set<() => void>();
function publish(next: MotionActivity[]): void {
  activity = next;
  try { sessionStorage.setItem(KEY, JSON.stringify(activity)); } catch { /* storage unavailable */ }
  listeners.forEach(listener => listener());
}
export function recordMotion(event: MotionActivity): void { publish([event, ...activity].slice(0, LIMIT)); }
export function clearMotionActivity(): void { publish([]); }
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function useMotionActivity(): MotionActivity[] { return useSyncExternalStore(subscribe, () => activity); }
