import { spawn, type ChildProcess } from "node:child_process";
import { previewOutputArgs, rtspInputArgs } from "./ffmpegArgs.js";
import { LineThrottle } from "./logThrottle.js";
import { MultipartJpegParser } from "./mjpeg.js";
import { killTree } from "./processes.js";
import { redactCredentials } from "./urls.js";

const IDLE_SHUTDOWN_MS = 45_000;
const FRESH_FRAME_MS = 10_000;
const STABLE_RUN_MS = 60_000;

interface Waiter {
  resolve(frame: Buffer): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

/**
 * One on-demand RTSP→JPEG ffmpeg for a camera that is not being recorded. Every viewer shares it, it
 * reconnects with backoff, and it shuts itself down 45 s after the last viewer asked for a frame.
 */
export class PreviewSession {
  latestFrame: Buffer | null = null;
  latestFrameAt = 0;
  dead = false;
  private child: ChildProcess | null = null;
  private waiters: Waiter[] = [];
  private attempts = 0;
  private readonly stderrThrottle = new LineThrottle(20, 60_000);
  private startedAt = 0;
  private lastAccess = Date.now();
  private respawnTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(
    readonly cameraId: string,
    readonly sourceUrl: string,
    private readonly ffmpeg: string,
    private readonly log: (line: string) => void,
    private readonly onClosed: (session: PreviewSession) => void,
  ) {
    this.start();
    this.armIdle();
  }

  async frame(maxWaitMs = 8_000): Promise<Buffer> {
    this.touch();
    if (this.latestFrame && Date.now() - this.latestFrameAt < FRESH_FRAME_MS) return this.latestFrame;
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          if (this.latestFrame) resolve(this.latestFrame);
          else reject(new Error("the camera has not sent a frame yet"));
        }, Math.max(1_000, maxWaitMs)),
      };
      this.waiters.push(waiter);
    });
  }

  /** A fresh frame for the push loop, or null; keeps the session alive while someone is watching. */
  freshFrame(): { buf: Buffer; at: number } | null {
    this.touch();
    return this.latestFrame && Date.now() - this.latestFrameAt < FRESH_FRAME_MS ? { buf: this.latestFrame, at: this.latestFrameAt } : null;
  }

  shutdown(): void {
    if (this.dead) return;
    this.dead = true;
    if (this.respawnTimer) clearTimeout(this.respawnTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    killTree(this.child);
    this.child = null;
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("the preview closed"));
    }
    this.onClosed(this);
  }

  private touch(): void {
    this.lastAccess = Date.now();
    this.armIdle();
  }

  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (Date.now() - this.lastAccess >= IDLE_SHUTDOWN_MS) this.shutdown();
      else this.armIdle();
    }, IDLE_SHUTDOWN_MS);
  }

  private start(): void {
    if (this.dead || this.child) return;
    this.startedAt = Date.now();
    let child: ChildProcess;
    try {
      child = spawn(this.ffmpeg, [...rtspInputArgs(this.sourceUrl, "error"), ...previewOutputArgs()], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      this.log(`[preview ${this.cameraId}] ffmpeg could not start: ${(error as Error).message}`);
      this.scheduleRespawn();
      return;
    }
    this.child = child;
    const parser = new MultipartJpegParser((frame) => this.accept(frame));
    child.stdout!.on("data", (chunk: Buffer) => parser.push(chunk));
    child.stderr!.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (!text) return;
      const { pass, mutedNote } = this.stderrThrottle.admit("stderr");
      if (mutedNote) this.log(`[preview ${this.cameraId}] ${mutedNote}`);
      if (pass) this.log(`[preview ${this.cameraId}] ${redactCredentials(text)}`);
    });
    let exited = false;
    const onExit = () => {
      if (exited) return;
      exited = true;
      if (this.child !== child) return;
      this.child = null;
      if (this.dead) return;
      if (Date.now() - this.startedAt > STABLE_RUN_MS && this.latestFrame) this.attempts = 0;
      this.scheduleRespawn();
    };
    child.on("error", onExit);
    child.on("exit", onExit);
  }

  private accept(frame: Buffer): void {
    this.latestFrame = frame;
    this.latestFrameAt = Date.now();
    this.attempts = 0;
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.resolve(frame);
    }
  }

  private scheduleRespawn(): void {
    if (this.dead || this.respawnTimer) return;
    this.attempts += 1;
    const delay = Math.min(15_000, 1_500 * 1.6 ** Math.min(this.attempts - 1, 6)) + Math.floor(Math.random() * 500);
    this.respawnTimer = setTimeout(() => {
      this.respawnTimer = null;
      if (this.dead) return;
      if (Date.now() - this.lastAccess > IDLE_SHUTDOWN_MS) this.shutdown();
      else this.start();
    }, delay);
  }
}

export class PreviewSessions {
  private readonly sessions = new Map<string, PreviewSession>();

  constructor(private readonly log: (line: string) => void) {}

  get(cameraId: string, sourceUrl: string, ffmpeg: string): PreviewSession {
    const existing = this.sessions.get(cameraId);
    if (existing && !existing.dead && existing.sourceUrl === sourceUrl) return existing;
    existing?.shutdown();
    const session = new PreviewSession(cameraId, sourceUrl, ffmpeg, this.log, (closed) => {
      if (this.sessions.get(cameraId) === closed) this.sessions.delete(cameraId);
    });
    this.sessions.set(cameraId, session);
    return session;
  }

  peek(cameraId: string): PreviewSession | undefined {
    return this.sessions.get(cameraId);
  }

  get count(): number {
    return this.sessions.size;
  }

  closeAll(): void {
    for (const session of [...this.sessions.values()]) session.shutdown();
  }
}
