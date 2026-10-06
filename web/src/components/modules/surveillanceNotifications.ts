import { useEffect, useRef, useState } from "react";
import { beep } from "../../lib/notify.js";
import { fetchServiceStatus, moduleJson } from "./moduleApi.js";
import { MotionDetector } from "./motionDetection.js";
import { useFrameStream } from "./surveillanceFrames.js";
import type { Camera, SurveillanceConfig } from "./surveillanceTypes.js";

const COUNT_KEY = "ggo:surveillance-unread";
export function unlockMotionSound(): void { beep(0.0001); }
export function motionConfigChanged(config: SurveillanceConfig): void {
  window.dispatchEvent(new CustomEvent("ggo:motion-config", { detail: config }));
}

/** Runs across board tabs. Camera pictures and processing stay local to the open console. */
export function useMotionNotifications(enabled: boolean, viewing: boolean): number {
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [count, setCount] = useState(() => {
    try { return Math.max(0, Number(sessionStorage.getItem(COUNT_KEY)) || 0); } catch { return 0; }
  });
  const current = useRef(cameras);
  const watching = useRef(viewing);
  watching.current = viewing;
  current.current = cameras;
  const { store } = useFrameStream(enabled && cameras.some(c => c.notificationsEnabled), true);
  const sources = cameras.filter(c => c.notificationsEnabled).map(c => `${c.id}:${c.snapshotUrl}:${c.streamUrl}:${c.refreshMs}`).join("|");

  useEffect(() => {
    if (!enabled || !sources) return;
    const unlock = () => unlockMotionSound();
    document.addEventListener("pointerdown", unlock, { once: true });
    document.addEventListener("keydown", unlock, { once: true });
    return () => { document.removeEventListener("pointerdown", unlock); document.removeEventListener("keydown", unlock); };
  }, [enabled, sources]);

  useEffect(() => {
    if (viewing) setCount(0);
    const seen = () => { if (viewing && !document.hidden) setCount(0); };
    document.addEventListener("visibilitychange", seen);
    return () => document.removeEventListener("visibilitychange", seen);
  }, [viewing]);
  useEffect(() => {
    try { sessionStorage.setItem(COUNT_KEY, String(count)); } catch { /* storage unavailable */ }
  }, [count]);
  useEffect(() => {
    if (!enabled) { setCameras([]); return; }
    const abort = new AbortController();
    let pending = false;
    let revision = 0;
    let stopped = false;
    let serviceKey: string | null = null;
    const power = (event: Event) => {
      stopped = (event as CustomEvent<string>).detail === "stop";
      revision++;
      if (stopped) { current.current = []; setCameras([]); }
      else void poll();
    };
    const apply = (event: Event) => {
      revision++;
      stopped = false;
      current.current = (event as CustomEvent<SurveillanceConfig>).detail.cameras;
      setCameras(current.current);
    };
    const poll = async () => {
      if (pending || stopped) return;
      pending = true;
      const startedRevision = revision;
      try {
        const service = await fetchServiceStatus("surveillance", abort.signal);
        const key = service.state === "running" ? `${service.pid}:${service.startedAt}` : null;
        // An idle, notifications-off worker must still be allowed to exit. Config reads wake it.
        if (key !== null && key === serviceKey && !current.current.some(c => c.notificationsEnabled)) return;
        const next = service.state === "running" ? await moduleJson<SurveillanceConfig>("surveillance", "/config", { signal: abort.signal }) : null;
        if (!abort.signal.aborted && startedRevision === revision) { serviceKey = key; setCameras(next?.cameras ?? []); }
      } catch { serviceKey = null; if (!abort.signal.aborted && startedRevision === revision) setCameras([]); }
      finally { pending = false; }
    };
    window.addEventListener("ggo:motion-config", apply);
    window.addEventListener("ggo:motion-power", power);
    void poll();
    const timer = window.setInterval(() => void poll(), 5_000);
    return () => { abort.abort(); window.clearInterval(timer); window.removeEventListener("ggo:motion-config", apply); window.removeEventListener("ggo:motion-power", power); };
  }, [enabled]);

  useEffect(() => {
    const detectors = new Map<string, MotionDetector>();
    const busy = new Set<string>();
    const canvas = document.createElement("canvas");
    canvas.width = 32; canvas.height = 24;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    let closed = false;
    const onFrame = async (id: string, entry: { url: string; at: number }) => {
      const camera = current.current.find(c => c.id === id && c.notificationsEnabled);
      if (!enabled || !camera) { detectors.delete(id); return; }
      if (busy.has(id) || Date.now() - entry.at > 30_000) return;
      busy.add(id);
      const image = new Image();
      image.src = entry.url;
      try {
        await image.decode();
        const latestCamera = current.current.find(c => c.id === id && c.notificationsEnabled);
        if (closed || !latestCamera) return;
        ctx.drawImage(image, 0, 0, 32, 24);
        let detector = detectors.get(id);
        if (!detector) detectors.set(id, detector = new MotionDetector());
        if (detector.sample(ctx.getImageData(0, 0, 32, 24).data, entry.at, Math.max(30_000, latestCamera.refreshMs * 2), latestCamera.motionSensitivity)) {
          beep();
          if (!watching.current || document.hidden) setCount(n => n + 1);
        }
      } catch { detectors.delete(id); }
      finally { busy.delete(id); }
    };
    store.observers.add(onFrame);
    return () => { closed = true; store.observers.delete(onFrame); };
  }, [store, enabled, sources]);
  return count;
}
