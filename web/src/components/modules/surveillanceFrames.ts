import { useCallback, useEffect, useSyncExternalStore } from "react";
import { usePageVisible } from "./hooks.js";
import { streamUrl, fetchServiceStatus } from "./moduleApi.js";

export interface LiveFrameEntry {
  url: string;
  at: number;
}

export type StreamStatus = "connecting" | "live" | "down" | "paused";

/**
 * Camera frames for the open tab, over one WebSocket. Each tile subscribes to its own camera, so a frame
 * re-renders one picture, not the grid. Viewers and notification monitoring share the socket;
 * it closes when the last consumer releases it.
 */
export class FrameStore {
  readonly observers = new Set<(id: string, entry: LiveFrameEntry) => void>();
  private readonly frames = new Map<string, LiveFrameEntry>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly stateListeners = new Set<() => void>();
  state: StreamStatus = "connecting";

  subscribe(id: string, listener: () => void): () => void {
    let set = this.listeners.get(id);
    if (!set) this.listeners.set(id, (set = new Set()));
    set.add(listener);
    return () => set!.delete(listener);
  }

  get(id: string): LiveFrameEntry | null {
    return this.frames.get(id) ?? null;
  }

  put(id: string, entry: LiveFrameEntry): void {
    const old = this.frames.get(id);
    this.frames.set(id, entry);
    for (const observer of this.observers) observer(id, entry);
    // The old picture may still be on screen until the new one decodes; let it go a moment later.
    if (old) window.setTimeout(() => URL.revokeObjectURL(old.url), 2_000);
    for (const listener of this.listeners.get(id) ?? []) listener();
  }

  subscribeState(listener: () => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  setState(state: StreamStatus): void {
    if (this.state === state) return;
    this.state = state;
    for (const listener of this.stateListeners) listener();
  }

  clear(): void {
    for (const entry of this.frames.values()) URL.revokeObjectURL(entry.url);
    this.frames.clear();
  }
}

const store = new FrameStore();
let users = 0;
let stop: (() => void) | null = null;

function beginStream(): () => void {
  let socket: WebSocket | null = null;
  let closed = false;
  let attempt = 0;
  let retry: number | null = null;

  const schedule = () => {
    if (closed) return;
    store.setState("down");
    retry = window.setTimeout(connect, Math.min(30_000, 1_000 * 2 ** attempt++));
  };

  const connect = async () => {
    if (attempt > 0) {
      try { if ((await fetchServiceStatus("surveillance")).state !== "running") { schedule(); return; } } catch { schedule(); return; }
      if (closed) return;
    }
    store.setState("connecting");
    streamUrl("surveillance").then(
      (url) => {
        if (closed) return;
        socket = new WebSocket(url);
        socket.binaryType = "arraybuffer";
        socket.onopen = () => {
          attempt = 0;
          store.setState("live");
        };
        socket.onmessage = (event) => {
          if (typeof event.data === "string") return;
          const bytes = new Uint8Array(event.data as ArrayBuffer);
          const headerLength = (bytes[0]! << 8) | bytes[1]!;
          const header = JSON.parse(new TextDecoder().decode(bytes.subarray(2, 2 + headerLength))) as { id: string; at: number };
          const blob = new Blob([bytes.subarray(2 + headerLength)], { type: "image/jpeg" });
          store.put(header.id, { url: URL.createObjectURL(blob), at: header.at });
        };
        socket.onclose = schedule;
      },
      schedule,
    );
  };

  connect();
  return () => {
    closed = true;
    if (retry) window.clearTimeout(retry);
    if (socket) {
      socket.onclose = null;
      socket.close();
    }
  };

}

export function useFrameStream(enabled = true, keepWhileHidden = false): { store: FrameStore; state: StreamStatus; reconnect: () => void } {
  const visible = usePageVisible();
  const active = enabled && (visible || keepWhileHidden);
  const state = useSyncExternalStore((listener) => store.subscribeState(listener), () => store.state);
  useEffect(() => {
    if (!active) return;
    users++;
    if (!stop) stop = beginStream();
    return () => {
      users--;
      if (!users) { stop?.(); stop = null; store.clear(); store.setState("paused"); }
    };
  }, [active]);
  const reconnect = useCallback(() => {
    if (!users) return;
    stop?.(); stop = beginStream();
  }, []);
  return { store, state: active ? state : "paused", reconnect };
}
