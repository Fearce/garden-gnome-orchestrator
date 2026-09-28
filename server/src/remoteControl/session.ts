import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import type { WebSocket } from "ws";
import { z } from "zod";
import type { DesktopHelper, DisplayInfo, MouseButton } from "./desktop.js";
import { QUALITY_PRESETS, explainEncoderError, streamArgs, type EncoderId, type QualityId } from "./ffmpeg.js";
import { FlvDemuxer, type FlvPacket } from "./flv.js";
import { scanKeyFor } from "./keymap.js";

/** Binary video message: kind, flags, sequence, timestamp, then the AVCC access unit. */
export const FRAME_HEADER_BYTES = 12;
const FRAME_KIND_VIDEO = 1;
const FLAG_KEY = 1;
// Frames the viewer may be behind before we stop sending and wait for the next keyframe. A quarter
// second of video is the most lag worth queueing; past that, skipping ahead beats catching up.
const MAX_BEHIND_SECONDS = 0.25;
// Frames still unacknowledged when a keyframe arrives, at or below which sending resumes.
const RESUME_BEHIND_SECONDS = 0.1;
// The socket's own buffer is the backstop for a viewer that stopped acknowledging altogether.
const MAX_SOCKET_BUFFER_BYTES = 8 * 1024 * 1024;
const IDLE_CLOSE_MS = 15_000;
const RESTART_DELAYS_MS = [300, 1_000, 2_000, 5_000];

const clientMessageSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("move"), x: z.number().finite(), y: z.number().finite() }),
  z.object({ t: z.literal("button"), button: z.enum(["left", "right", "middle", "back", "forward"]), down: z.boolean() }),
  z.object({ t: z.literal("wheel"), dy: z.number().finite().min(-12_000).max(12_000), dx: z.number().finite().min(-12_000).max(12_000) }),
  z.object({ t: z.literal("key"), code: z.string().max(40), down: z.boolean() }),
  z.object({ t: z.literal("text"), text: z.string().max(20_000) }),
  z.object({ t: z.literal("release") }),
  z.object({ t: z.literal("ack"), seq: z.number().int().nonnegative() }),
  z.object({ t: z.literal("ping"), ts: z.number().finite() }),
  z.object({ t: z.literal("display"), index: z.number().int().min(0).max(15) }),
  z.object({ t: z.literal("quality"), id: z.enum(["sharp", "smooth", "saver"]) }),
  z.object({ t: z.literal("clipget"), id: z.string().max(40) }),
  z.object({ t: z.literal("clipset"), id: z.string().max(40), text: z.string().max(1_000_000) }),
]);
type ClientMessage = z.infer<typeof clientMessageSchema>;

export interface SessionOptions {
  ffmpegPath: string;
  encoder: EncoderId;
  display: number;
  quality: QualityId;
  displays: DisplayInfo[];
  elevated: boolean;
  onEnd: () => void;
  onChoice: (choice: { display?: number; quality?: QualityId }) => void;
}

/**
 * One viewer's live session: an ffmpeg capture piped through the FLV demuxer to the socket, with the
 * socket's input messages injected through the desktop helper. Everything the viewer holds down is
 * tracked so a dropped connection can never leave a key or button stuck on the PC.
 */
export class RemoteSession {
  private ffmpeg: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private display: DisplayInfo;
  private quality: QualityId;
  private seq = 0;
  private ackedSeq = 0;
  private dropping = false;
  private dropped = 0;
  private restartAttempt = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private heldKeys = new Set<string>();
  private heldButtons = new Set<MouseButton>();
  private closed = false;
  private framesThisRun = 0;
  private readonly offBlocked: () => void;

  constructor(private readonly socket: WebSocket, private readonly helper: DesktopHelper, private readonly options: SessionOptions) {
    this.display = pickDisplay(options.displays, options.display);
    this.quality = options.quality;
    this.offBlocked = helper.onBlockedChange((blocked) => this.sendJson({ t: "inputBlocked", blocked }));
    socket.on("message", (raw: Buffer, isBinary: boolean) => { if (!isBinary) this.onMessage(raw); });
    socket.on("close", () => this.end());
    socket.on("error", () => this.end());
    this.touch();
    this.sendHello();
    this.startCapture();
  }

  /** Another viewer connected; this one yields rather than fighting over the mouse. */
  replace(): void {
    this.sendJson({ t: "replaced" });
    this.socket.close(4000, "replaced");
    this.end();
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    this.offBlocked();
    this.releaseHeld();
    this.stopCapture();
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.socket.readyState === this.socket.OPEN) this.socket.close(1000, "ended");
    this.options.onEnd();
  }

  private sendHello(): void {
    this.sendJson({
      t: "hello",
      displays: this.options.displays,
      display: this.display.index,
      quality: this.quality,
      qualities: Object.values(QUALITY_PRESETS).map(({ id, label, fps }) => ({ id, label, fps })),
      encoder: this.options.encoder,
      elevated: this.options.elevated,
    });
  }

  private startCapture(): void {
    if (this.closed) return;
    const preset = QUALITY_PRESETS[this.quality];
    const { args, size } = streamArgs(this.options.encoder, this.display.index, { width: this.display.width, height: this.display.height }, preset);
    const child = spawn(this.options.ffmpegPath, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    this.ffmpeg = child;
    this.framesThisRun = 0;
    this.dropping = false;
    this.ackedSeq = this.seq;
    const demuxer = new FlvDemuxer();
    let stderr = "";
    this.sendJson({ t: "status", state: "starting" });
    child.stdout.on("data", (chunk: Buffer) => {
      try {
        for (const packet of demuxer.push(chunk)) this.onPacket(packet, size);
      } catch (error) {
        stderr += `\n${(error as Error).message}`;
        child.kill();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000); });
    child.on("error", (error) => { stderr += `\n${error.message}`; });
    child.on("close", () => {
      if (this.ffmpeg !== child) return;
      this.ffmpeg = null;
      this.scheduleRestart(stderr);
    });
  }

  private scheduleRestart(stderr: string): void {
    if (this.closed) return;
    if (this.framesThisRun > 0) this.restartAttempt = 0;
    const delay = RESTART_DELAYS_MS[Math.min(this.restartAttempt, RESTART_DELAYS_MS.length - 1)]!;
    this.restartAttempt++;
    this.sendJson({ t: "status", state: "retrying", message: stderr.trim() ? explainEncoderError(stderr) : "The capture stopped; restarting it." });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.startCapture();
    }, delay);
  }

  private stopCapture(): void {
    const child = this.ffmpeg;
    this.ffmpeg = null;
    if (child && child.exitCode === null) child.kill();
  }

  private restartCapture(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.stopCapture();
    this.restartAttempt = 0;
    this.startCapture();
  }

  private onPacket(packet: FlvPacket, size: { width: number; height: number }): void {
    if (packet.kind === "config") {
      this.sendJson({ t: "config", codec: packet.codec, description: packet.avcc.toString("base64"), width: size.width, height: size.height, display: this.display.index });
      return;
    }
    if (this.framesThisRun++ === 0) this.sendJson({ t: "status", state: "streaming" });
    if (this.shouldDrop(packet.key)) {
      this.dropped++;
      return;
    }
    const header = Buffer.alloc(FRAME_HEADER_BYTES);
    header[0] = FRAME_KIND_VIDEO;
    header[1] = packet.key ? FLAG_KEY : 0;
    header.writeUInt32BE(++this.seq >>> 0, 2);
    header.writeUInt32BE(packet.timestampMs >>> 0, 6);
    // Video does not compress; skipping permessage-deflate saves a copy and a few ms per frame.
    this.socket.send(Buffer.concat([header, packet.data]), { binary: true, compress: false });
  }

  /** Drop-to-keyframe flow control: a viewer that falls behind skips ahead instead of lagging more. */
  private shouldDrop(key: boolean): boolean {
    const fps = QUALITY_PRESETS[this.quality].fps;
    const behind = this.seq - this.ackedSeq;
    if (this.socket.bufferedAmount > MAX_SOCKET_BUFFER_BYTES || behind > fps * MAX_BEHIND_SECONDS) this.dropping = true;
    if (!this.dropping) return false;
    if (key && behind <= fps * RESUME_BEHIND_SECONDS && this.socket.bufferedAmount < MAX_SOCKET_BUFFER_BYTES) {
      this.dropping = false;
      return false;
    }
    return true;
  }

  private onMessage(raw: Buffer): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const result = clientMessageSchema.safeParse(parsed);
    if (!result.success) return;
    this.touch();
    this.handle(result.data);
  }

  private handle(message: ClientMessage): void {
    switch (message.t) {
      case "move": return this.move(message.x, message.y);
      case "button": return this.button(message.button, message.down);
      case "wheel": return this.helper.wheel(message.dy, message.dx);
      case "key": return this.key(message.code, message.down);
      case "text": return this.helper.text(message.text);
      case "release": return this.releaseHeld();
      case "ack":
        if (message.seq <= this.seq && message.seq > this.ackedSeq) this.ackedSeq = message.seq;
        return;
      case "ping": return this.sendJson({ t: "pong", ts: message.ts, dropped: this.dropped });
      case "display": return this.switchDisplay(message.index);
      case "quality": return this.switchQuality(message.id);
      case "clipget":
        void this.helper.clipboardText().then(
          (text) => this.sendJson({ t: "clipboard", id: message.id, text }),
          (error: Error) => this.sendJson({ t: "clipboard", id: message.id, error: error.message }),
        );
        return;
      case "clipset":
        void this.helper.setClipboardText(message.text).then(
          () => this.sendJson({ t: "clipboardSet", id: message.id, ok: true }),
          (error: Error) => this.sendJson({ t: "clipboardSet", id: message.id, ok: false, error: error.message }),
        );
        return;
    }
  }

  /** Coordinates arrive as fractions of the streamed image, so they survive any scaling on the way. */
  private move(x: number, y: number): void {
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    this.helper.move(this.display.x + clamp(x) * (this.display.width - 1), this.display.y + clamp(y) * (this.display.height - 1));
  }

  private button(button: MouseButton, down: boolean): void {
    if (down) this.heldButtons.add(button);
    else this.heldButtons.delete(button);
    this.helper.button(button, down);
  }

  private key(code: string, down: boolean): void {
    const scan = scanKeyFor(code);
    if (!scan) return;
    if (down) this.heldKeys.add(code);
    else this.heldKeys.delete(code);
    this.helper.key(scan.scan, scan.extended, down);
  }

  private releaseHeld(): void {
    for (const code of [...this.heldKeys]) this.key(code, false);
    for (const button of [...this.heldButtons]) this.button(button, false);
  }

  private switchDisplay(index: number): void {
    const next = this.options.displays.find((d) => d.index === index);
    if (!next || next.index === this.display.index) return;
    this.display = next;
    this.options.onChoice({ display: index });
    this.sendHello();
    this.restartCapture();
  }

  private switchQuality(id: QualityId): void {
    if (id === this.quality) return;
    this.quality = id;
    this.options.onChoice({ quality: id });
    this.sendHello();
    this.restartCapture();
  }

  /** A viewer that stops pinging (tab frozen, network gone) is closed so the capture does not run on. */
  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.end(), IDLE_CLOSE_MS);
  }

  private sendJson(message: Record<string, unknown>): void {
    if (this.socket.readyState === this.socket.OPEN) this.socket.send(JSON.stringify(message));
  }
}

export function pickDisplay(displays: DisplayInfo[], preferred: number): DisplayInfo {
  return displays.find((d) => d.index === preferred) ?? displays.find((d) => d.primary) ?? displays[0]!;
}
