import type { WebSocket } from "ws";
import type { Camera } from "./config.js";
import type { PreviewSessions } from "./preview.js";
import type { Recorder } from "./recorder.js";
import type { SnapshotFetcher } from "./snapshots.js";

export interface Frame {
  buf: Buffer;
  at: number;
  contentType: string;
}

const SNAPSHOT_MAX_AGE_MS = 15_000;
const PUSH_TICK_MS = 500;
const PING_EVERY_MS = 25_000;
/** A viewer more than this far behind skips frames instead of queueing them. */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

/**
 * Where a camera's live picture comes from. While recording, the recorder's own stream (one RTSP connection
 * per camera, and the camera's CGI is starved during recording anyway). Otherwise the camera's chosen
 * preview: its snapshot URL, or an on-demand RTSP session for a stream-only camera.
 */
export class FrameSource {
  constructor(
    private readonly recorder: Recorder,
    private readonly snapshots: SnapshotFetcher,
    private readonly previews: PreviewSessions,
    private readonly ffmpeg: () => string | null,
  ) {}

  /** The newest frame on hand without waiting. With `refresh`, also starts the fetch that would produce the next one. */
  peek(camera: Camera, refresh = true): Frame | null {
    if (this.recorder.owns(camera)) {
      const recorded = this.recorder.frame(camera.id);
      if (recorded) return { ...recorded, contentType: "image/jpeg" };
      return camera.snapshotUrl ? this.cachedSnapshot(camera, refresh) : null;
    }
    const mode = previewMode(camera);
    if (mode === "snapshot") return this.cachedSnapshot(camera, refresh);
    if (mode === "rtsp") {
      const ffmpeg = this.ffmpeg();
      if (!ffmpeg) return null;
      const fresh = this.previews.get(camera.id, rtspSource(camera)!, ffmpeg).freshFrame();
      return fresh ? { ...fresh, contentType: "image/jpeg" } : null;
    }
    return null;
  }

  /** A frame for an HTTP request, waiting a few seconds for one if none is on hand. */
  async next(camera: Camera): Promise<Frame> {
    const ready = this.peek(camera);
    if (ready) return ready;
    if (this.recorder.owns(camera)) {
      if (camera.snapshotUrl) return this.fetchSnapshot(camera.snapshotUrl);
      throw new Error("the recorder is still connecting to this camera");
    }
    const mode = previewMode(camera);
    if (mode === "snapshot") return this.fetchSnapshot(camera.snapshotUrl);
    if (mode === "rtsp") {
      const ffmpeg = this.ffmpeg();
      if (!ffmpeg) throw new Error("ffmpeg was not found, so the RTSP stream cannot be shown");
      const buf = await this.previews.get(camera.id, rtspSource(camera)!, ffmpeg).frame(8_000);
      return { buf, at: Date.now(), contentType: "image/jpeg" };
    }
    throw new Error("this camera has no snapshot or stream URL yet");
  }

  /** How often a viewer loop may make this camera fetch a snapshot. Recorder and RTSP frames arrive on their own. */
  refreshIntervalMs(camera: Camera): number {
    return this.recorder.owns(camera) || previewMode(camera) !== "snapshot" ? 0 : camera.refreshMs;
  }

  private cachedSnapshot(camera: Camera, refresh: boolean): Frame | null {
    const maxAge = Math.max(SNAPSHOT_MAX_AGE_MS, camera.refreshMs * 2);
    const snapshot = refresh ? this.snapshots.latest(camera.snapshotUrl, maxAge) : this.snapshots.cached(camera.snapshotUrl, maxAge);
    return snapshot ? { buf: snapshot.frame, at: snapshot.at, contentType: snapshot.contentType } : null;
  }

  private async fetchSnapshot(url: string): Promise<Frame> {
    const snapshot = await this.snapshots.fetch(url);
    return { buf: snapshot.frame, at: snapshot.at, contentType: snapshot.contentType };
  }
}

export function previewMode(camera: Camera): "snapshot" | "rtsp" | null {
  const hasSnapshot = Boolean(camera.snapshotUrl.trim());
  const hasStream = Boolean(rtspSource(camera));
  if (camera.previewStrategy === "rtsp-mjpeg-proxy" && hasStream) return "rtsp";
  if (hasSnapshot) return "snapshot";
  return hasStream ? "rtsp" : null;
}

function rtspSource(camera: Camera): string | null {
  return camera.streamUrl.trim() || camera.subStreamUrl.trim() || null;
}

interface Viewer {
  socket: WebSocket;
  sentAt: Map<string, number>;
  lastPingAt: number;
}

/**
 * Pushes camera frames to open viewers over a WebSocket: a recording camera about twice a second, any other at
 * its own refresh interval. Binary message:
 * uint16BE header length, a JSON header {id, at}, then the JPEG. A WebSocket sits outside the browser's six
 * HTTP connections per origin, so a page full of polling tiles can never starve it. The loop runs only while
 * a viewer is connected.
 */
export class FramePush {
  private readonly viewers = new Set<Viewer>();
  private timer: NodeJS.Timeout | null = null;
  private cursor = 0;
  private readonly polledAt = new Map<string, number>();

  constructor(
    private readonly cameras: () => Camera[],
    private readonly source: FrameSource,
  ) {}

  get viewerCount(): number {
    return this.viewers.size;
  }

  add(socket: WebSocket): void {
    const viewer: Viewer = { socket, sentAt: new Map(), lastPingAt: Date.now() };
    this.viewers.add(viewer);
    socket.on("close", () => this.viewers.delete(viewer));
    socket.on("error", () => socket.terminate());
    if (!this.timer) this.timer = setInterval(() => this.tick(), PUSH_TICK_MS);
  }

  closeAll(): void {
    for (const viewer of this.viewers) viewer.socket.terminate();
    this.viewers.clear();
    this.stopIfIdle();
  }

  private tick(): void {
    if (!this.stopIfIdle()) return;
    const cameras = this.cameras();
    // Rotate the first camera so a slow viewer that only absorbs part of a tick still sees every tile move.
    const offset = cameras.length ? this.cursor++ % cameras.length : 0;
    const now = Date.now();
    for (let i = 0; i < cameras.length; i += 1) {
      const camera = cameras[(offset + i) % cameras.length]!;
      // Every tick sends whatever arrived; only a due camera is asked for a new snapshot.
      const due = now - (this.polledAt.get(camera.id) ?? 0) >= this.source.refreshIntervalMs(camera);
      if (due) this.polledAt.set(camera.id, now);
      let frame: Frame | null = null;
      try {
        frame = this.source.peek(camera, due);
      } catch {
        frame = null;
      }
      if (frame) this.send(camera.id, frame);
    }
    for (const viewer of this.viewers) {
      if (now - viewer.lastPingAt < PING_EVERY_MS) continue;
      viewer.lastPingAt = now;
      viewer.socket.ping();
    }
  }

  private send(cameraId: string, frame: Frame): void {
    let message: Buffer | null = null;
    for (const viewer of this.viewers) {
      if ((viewer.sentAt.get(cameraId) ?? 0) >= frame.at) continue;
      if (viewer.socket.readyState !== viewer.socket.OPEN || viewer.socket.bufferedAmount > MAX_BUFFERED_BYTES) continue;
      if (!message) {
        const header = Buffer.from(JSON.stringify({ id: cameraId, at: frame.at }), "utf8");
        const length = Buffer.alloc(2);
        length.writeUInt16BE(header.length, 0);
        message = Buffer.concat([length, header, frame.buf]);
      }
      viewer.socket.send(message, { binary: true });
      viewer.sentAt.set(cameraId, frame.at);
    }
  }

  /** False (and the loop stopped) when nobody is watching. */
  private stopIfIdle(): boolean {
    if (this.viewers.size) return true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.polledAt.clear();
    return false;
  }
}
