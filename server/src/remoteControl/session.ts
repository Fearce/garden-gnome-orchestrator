import type { WebSocket } from "ws";
import { z } from "zod";
import type { DesktopHelper, DisplayInfo, MouseButton } from "./desktop.js";
import { Capture, type ConfigPacket, type FramePacket } from "./capture.js";
import { QUALITY_PRESETS, explainEncoderError, streamArgs, type EncoderId, type QualityId, type QualityPreset } from "./ffmpeg.js";
import { AdaptiveRate, FrameFlow } from "./flowControl.js";
import { scanKeyFor } from "./keymap.js";

/** Binary video message: kind, flags, sequence, timestamp, then the AVCC access unit. */
export const FRAME_HEADER_BYTES = 12;
const FRAME_KIND_VIDEO = 1;
const FLAG_KEY = 1;
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
  z.object({ t: z.literal("keyframe") }),
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
 *
 * A settings change (display, quality, or the bitrate the link can carry) starts a second capture and
 * switches over at its first keyframe, so the viewer keeps the old picture moving instead of waiting
 * out ffmpeg's start-up.
 */
export class RemoteSession {
  private live: Capture | null = null;
  private incoming: { capture: Capture; config: ConfigPacket | null } | null = null;
  private display: DisplayInfo;
  private quality: QualityId;
  private readonly flow = new FrameFlow();
  private readonly rate = new AdaptiveRate();
  private dropped = 0;
  private restartAttempt = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private heldKeys = new Set<string>();
  private heldButtons = new Set<MouseButton>();
  private closed = false;
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
      bitrateKbps: this.preset().bitrateKbps,
      rateReduced: this.rate.factor < 1,
    });
  }

  /** The chosen quality at the bitrate the link currently carries. */
  private preset(): QualityPreset {
    const preset = QUALITY_PRESETS[this.quality];
    return { ...preset, bitrateKbps: Math.round(preset.bitrateKbps * this.rate.factor) };
  }

  private spawnCapture(): Capture {
    const { args, size } = streamArgs(this.options.encoder, this.display.index, { width: this.display.width, height: this.display.height }, this.preset());
    return new Capture(this.options.ffmpegPath, args, this.display, size, {
      onConfig: (capture, packet) => this.onConfig(capture, packet),
      onFrame: (capture, packet) => this.onFrame(capture, packet),
      onExit: (capture, stderr) => this.onCaptureExit(capture, stderr),
    });
  }

  /** Cold start: nothing is on screen yet, or the last capture died. */
  private startCapture(): void {
    if (this.closed) return;
    this.flow.restart();
    this.sendJson({ t: "status", state: "starting" });
    this.live = this.spawnCapture();
  }

  /** Warm switch to the current settings: the live capture keeps streaming until the new one has a keyframe. */
  private handover(): void {
    if (this.closed) return;
    if (!this.live) return this.restartCapture();
    this.incoming?.capture.stop();
    this.incoming = { capture: this.spawnCapture(), config: null };
  }

  private onConfig(capture: Capture, packet: ConfigPacket): void {
    if (capture === this.live) this.sendConfig(capture, packet);
    else if (capture === this.incoming?.capture) this.incoming.config = packet;
  }

  private onFrame(capture: Capture, packet: FramePacket): void {
    if (capture === this.incoming?.capture) this.promoteIncoming();
    if (capture !== this.live) return;
    if (capture.frames === 1) this.sendJson({ t: "status", state: "streaming" });
    this.sendFrame(packet);
  }

  private promoteIncoming(): void {
    const { capture, config } = this.incoming!;
    this.incoming = null;
    this.live?.stop();
    this.live = capture;
    this.flow.restart();
    if (config) this.sendConfig(capture, config);
  }

  private onCaptureExit(capture: Capture, stderr: string): void {
    // A second encoder can fail where one works (NVENC session limits); starting afresh needs only one.
    if (capture === this.incoming?.capture) return this.restartCapture();
    if (capture !== this.live) return;
    const ranFrames = capture.frames > 0;
    this.stopCapture();
    this.scheduleRestart(stderr, ranFrames);
  }

  private scheduleRestart(stderr: string, ranFrames: boolean): void {
    if (this.closed) return;
    if (ranFrames) this.restartAttempt = 0;
    const delay = RESTART_DELAYS_MS[Math.min(this.restartAttempt, RESTART_DELAYS_MS.length - 1)]!;
    this.restartAttempt++;
    this.sendJson({ t: "status", state: "retrying", message: stderr.trim() ? explainEncoderError(stderr) : "The capture stopped; restarting it." });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.startCapture();
    }, delay);
  }

  private stopCapture(): void {
    this.live?.stop();
    this.incoming?.capture.stop();
    this.live = null;
    this.incoming = null;
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

  private sendConfig(capture: Capture, packet: ConfigPacket): void {
    const { width, height } = capture.size;
    this.sendJson({ t: "config", codec: packet.codec, description: packet.avcc.toString("base64"), width, height, display: capture.display.index });
  }

  private sendFrame(packet: FramePacket): void {
    const admitted = this.flow.admit(packet.key, this.socket.bufferedAmount);
    this.adaptRate();
    if (!admitted) {
      this.dropped++;
      return;
    }
    const header = Buffer.alloc(FRAME_HEADER_BYTES);
    header[0] = FRAME_KIND_VIDEO;
    header[1] = packet.key ? FLAG_KEY : 0;
    header.writeUInt32BE(this.flow.sent() >>> 0, 2);
    header.writeUInt32BE(packet.timestampMs >>> 0, 6);
    // Video does not compress; skipping permessage-deflate saves a copy and a few ms per frame.
    this.socket.send(Buffer.concat([header, packet.data]), { binary: true, compress: false });
  }

  /** The viewer lost its decoder; a fresh encoder brings a new config and keyframe. One is enough. */
  private requestKeyframe(): void {
    if (!this.incoming) this.handover();
  }

  private adaptRate(): void {
    if (!this.rate.observe(this.flow.backlogMs(), this.flow.skipping)) return;
    this.sendHello();
    this.handover();
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
      case "ack": return this.flow.acked(message.seq);
      case "ping": return this.sendJson({ t: "pong", ts: message.ts, dropped: this.dropped });
      case "keyframe": return this.requestKeyframe();
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

  /**
   * Coordinates arrive as fractions of the streamed image, so they survive any scaling on the way. They
   * map onto the display the viewer is looking at, which lags a display switch until the handover lands.
   */
  private move(x: number, y: number): void {
    const shown = this.live?.display ?? this.display;
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    this.helper.move(shown.x + clamp(x) * (shown.width - 1), shown.y + clamp(y) * (shown.height - 1));
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
    this.handover();
  }

  private switchQuality(id: QualityId): void {
    if (id === this.quality) return;
    this.quality = id;
    this.rate.reset();
    this.options.onChoice({ quality: id });
    this.sendHello();
    this.handover();
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
