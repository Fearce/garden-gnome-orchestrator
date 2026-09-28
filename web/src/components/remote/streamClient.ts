import { remoteRequest, streamUrl, type DisplayInfo, type EncoderId, type QualityId } from "./remoteApi.js";

const FRAME_HEADER_BYTES = 12;
const FLAG_KEY = 1;
const PING_MS = 1_000;
// Undecoded work past this means the device cannot keep up; skip to the next keyframe. A network stall
// delivers its backlog as one burst that a working decoder clears in a moment, so this is set above
// the server's own backlog bound (it paces on our paint acks) and only catches a decoder that is stuck.
const MAX_DECODE_QUEUE = 60;
const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000];

export type Phase = "connecting" | "starting" | "streaming" | "retrying" | "reconnecting" | "replaced" | "failed" | "closed";

export interface StreamState {
  phase: Phase;
  message: string | null;
  displays: DisplayInfo[];
  display: number;
  quality: QualityId;
  encoder: EncoderId | null;
  elevated: boolean;
  inputBlocked: boolean;
  videoSize: { width: number; height: number } | null;
  rttMs: number | null;
  fps: number;
  dropped: number;
  bitrateKbps: number | null;
  /** The PC lowered the bitrate below the chosen quality's because this connection can't carry it. */
  rateReduced: boolean;
}

export type ClientMessage =
  | { t: "move"; x: number; y: number }
  | { t: "button"; button: "left" | "right" | "middle" | "back" | "forward"; down: boolean }
  | { t: "wheel"; dy: number; dx: number }
  | { t: "key"; code: string; down: boolean }
  | { t: "text"; text: string }
  | { t: "release" }
  | { t: "display"; index: number }
  | { t: "quality"; id: QualityId }
  | { t: "ack"; seq: number }
  | { t: "keyframe" }
  | { t: "ping"; ts: number };

const INITIAL: StreamState = {
  phase: "connecting", message: null, displays: [], display: 0, quality: "smooth", encoder: null,
  elevated: false, inputBlocked: false, videoSize: null, rttMs: null, fps: 0, dropped: 0, bitrateKbps: null, rateReduced: false,
};

/** Can this browser decode the stream at all? WebCodecs exists only on a secure (HTTPS) page. */
export function decoderUnavailableReason(): string | null {
  if (!window.isSecureContext) return "Remote control needs the console over HTTPS. Plain HTTP pages have no video decoder.";
  if (typeof VideoDecoder === "undefined") return "This browser has no WebCodecs video decoder. Use a current Chrome, Edge, or Safari 16.4+.";
  return null;
}

/**
 * One viewer connection: fetches a ticket, opens the stream socket, decodes H.264 with WebCodecs
 * straight onto a canvas, acknowledges each painted frame (the server's flow control keys on those),
 * and reconnects after a drop. Input goes out through `send`.
 */
export class StreamClient {
  private socket: WebSocket | null = null;
  private context: CanvasRenderingContext2D | null = null;
  private decoder: VideoDecoder | null = null;
  private awaitingKey = true;
  private pending: { seq: number; timestamp: number }[] = [];
  private state: StreamState = { ...INITIAL };
  private stopped = false;
  private reconnectAttempt = 0;
  private reconnectTimer: number | null = null;
  private pingTimer: number | null = null;
  private framesSinceTick = 0;
  private lastTick = performance.now();
  private clipboardWaiters = new Map<string, { resolve: (text: string) => void; reject: (error: Error) => void }>();

  constructor(private readonly canvas: HTMLCanvasElement, private readonly onState: (state: StreamState) => void) {}

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.closeSocket();
    this.update({ phase: "closed" });
  }

  /** Connect again after a takeover or a failure the client does not retry on its own. */
  retry(): void {
    this.reconnectAttempt = 0;
    this.closeSocket();
    this.stopped = false;
    void this.connect();
  }

  send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  readClipboard(): Promise<string> {
    return this.clipboardCall({ t: "clipget" });
  }

  async writeClipboard(text: string): Promise<void> {
    await this.clipboardCall({ t: "clipset", text });
  }

  private clipboardCall(message: { t: "clipget" } | { t: "clipset"; text: string }): Promise<string> {
    const id = Math.random().toString(36).slice(2);
    return new Promise((resolve, reject) => {
      if (this.socket?.readyState !== WebSocket.OPEN) return reject(new Error("Not connected to the PC."));
      const timer = window.setTimeout(() => {
        this.clipboardWaiters.delete(id);
        reject(new Error("The PC did not answer."));
      }, 8_000);
      this.clipboardWaiters.set(id, {
        resolve: (text) => { window.clearTimeout(timer); resolve(text); },
        reject: (error) => { window.clearTimeout(timer); reject(error); },
      });
      this.socket.send(JSON.stringify({ ...message, id }));
    });
  }

  private async connect(): Promise<void> {
    this.update({ phase: this.reconnectAttempt ? "reconnecting" : "connecting", message: null });
    let ticket: string;
    try {
      ticket = (await remoteRequest<{ ticket: string }>("ticket", { method: "POST" })).ticket;
    } catch (error) {
      if (!this.stopped) this.scheduleReconnect((error as Error).message);
      return;
    }
    if (this.stopped) return;
    const socket = new WebSocket(streamUrl(ticket));
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    socket.onopen = () => {
      this.reconnectAttempt = 0;
      this.startPings();
    };
    socket.onmessage = (event) => {
      if (typeof event.data === "string") this.onJson(event.data);
      else this.onFrame(event.data as ArrayBuffer);
    };
    socket.onclose = (event) => this.onClose(socket, event);
  }

  private onClose(socket: WebSocket, event: CloseEvent): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.stopPings();
    this.resetDecoder();
    if (this.stopped) return;
    if (event.code === 4000) return this.update({ phase: "replaced", message: "Another device took over this remote session." });
    if (event.code === 4403) return this.scheduleReconnect("The connection ticket was refused.");
    if (this.state.phase === "failed") return;
    this.scheduleReconnect(event.reason && event.reason !== "ended" ? event.reason : "The connection dropped.");
  }

  private scheduleReconnect(message: string): void {
    const delay = RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)]!;
    this.reconnectAttempt++;
    this.update({ phase: "reconnecting", message });
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) void this.connect();
    }, delay);
  }

  private onJson(raw: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (message.t) {
      case "hello":
        return this.update({
          displays: message.displays as DisplayInfo[],
          display: message.display as number,
          quality: message.quality as QualityId,
          encoder: message.encoder as EncoderId,
          elevated: message.elevated === true,
          bitrateKbps: typeof message.bitrateKbps === "number" ? message.bitrateKbps : null,
          rateReduced: message.rateReduced === true,
        });
      case "status":
        return this.update({ phase: message.state as Phase, message: (message.message as string | undefined) ?? null });
      case "config":
        return this.configure(message.codec as string, message.description as string, message.width as number, message.height as number);
      case "pong":
        return this.update({ rttMs: Math.round(performance.now() - (message.ts as number)), dropped: message.dropped as number });
      case "inputBlocked":
        return this.update({ inputBlocked: message.blocked === true });
      case "replaced":
        return this.update({ phase: "replaced", message: "Another device took over this remote session." });
      case "error":
        return this.update({ phase: "failed", message: message.message as string });
      case "clipboard":
      case "clipboardSet": {
        const waiter = this.clipboardWaiters.get(message.id as string);
        if (!waiter) return;
        this.clipboardWaiters.delete(message.id as string);
        if (typeof message.error === "string") waiter.reject(new Error(message.error));
        else waiter.resolve(typeof message.text === "string" ? message.text : "");
        return;
      }
    }
  }

  private configure(codec: string, descriptionBase64: string, width: number, height: number): void {
    const description = Uint8Array.from(atob(descriptionBase64), (c) => c.charCodeAt(0));
    const config: VideoDecoderConfig = { codec, description, codedWidth: width, codedHeight: height, optimizeForLatency: true, hardwareAcceleration: "no-preference" };
    // The PC hands over to a new encoder mid-stream (quality, display, bitrate). Reconfiguring in place
    // still decodes the old encoder's frames already queued, so the picture keeps moving until the new keyframe.
    if (this.decoder?.state === "configured") this.decoder.configure(config);
    else this.decoder = this.createDecoder(config);
    this.awaitingKey = true;
  }

  private createDecoder(config: VideoDecoderConfig): VideoDecoder {
    this.resetDecoder();
    const decoder = new VideoDecoder({
      output: (frame) => this.paint(frame),
      error: (error) => {
        if (this.decoder !== decoder) return;
        this.update({ message: `Decoder error: ${error.message}` });
        this.awaitingKey = true;
        this.decoder = null;
        this.ackPending();
        this.send({ t: "keyframe" });
      },
    });
    decoder.configure(config);
    return decoder;
  }

  private onFrame(buffer: ArrayBuffer): void {
    if (buffer.byteLength <= FRAME_HEADER_BYTES) return;
    const view = new DataView(buffer);
    const key = (view.getUint8(1) & FLAG_KEY) !== 0;
    const seq = view.getUint32(2);
    const timestampMs = view.getUint32(6);
    const decoder = this.decoder;
    if (!decoder || decoder.state !== "configured") return this.ack(seq);
    if (this.awaitingKey && !key) return this.ack(seq);
    if (decoder.decodeQueueSize > MAX_DECODE_QUEUE && !key) {
      this.awaitingKey = true;
      return this.ack(seq);
    }
    this.awaitingKey = false;
    const timestamp = timestampMs * 1000;
    this.pending.push({ seq, timestamp });
    try {
      decoder.decode(new EncodedVideoChunk({ type: key ? "key" : "delta", timestamp, data: new Uint8Array(buffer, FRAME_HEADER_BYTES) }));
    } catch {
      this.pending.pop();
      this.awaitingKey = true;
      this.ack(seq);
    }
  }

  private paint(frame: VideoFrame): void {
    // Resized here, not on the config: resizing clears the canvas, and the old stream is still showing then.
    if (this.canvas.width !== frame.displayWidth || this.canvas.height !== frame.displayHeight) {
      this.canvas.width = frame.displayWidth;
      this.canvas.height = frame.displayHeight;
      this.update({ videoSize: { width: frame.displayWidth, height: frame.displayHeight } });
    }
    this.context ??= this.canvas.getContext("2d", { alpha: false, desynchronized: true });
    this.context?.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);
    this.ackPainted(frame.timestamp);
    frame.close();
    this.countFrame();
  }

  /**
   * Acks the painted frame and any decoded before it that never produced a picture: matching by position
   * would shift every later ack by one, and the PC reads an unacked frame as the link falling behind.
   */
  private ackPainted(timestamp: number): void {
    const index = this.pending.findIndex((entry) => entry.timestamp === timestamp);
    const done = this.pending.splice(0, index + 1 || 1);
    const last = done.at(-1);
    if (last) this.ack(last.seq);
  }

  /** The PC only moves past acked frames, so frames a failed decoder will never paint are acked as done. */
  private ackPending(): void {
    const last = this.pending.at(-1);
    this.pending = [];
    if (last) this.ack(last.seq);
  }

  private ack(seq: number): void {
    this.send({ t: "ack", seq });
  }

  private countFrame(): void {
    this.framesSinceTick++;
    const now = performance.now();
    if (now - this.lastTick < 1_000) return;
    this.update({ fps: Math.round((this.framesSinceTick * 1000) / (now - this.lastTick)) });
    this.framesSinceTick = 0;
    this.lastTick = now;
  }

  private startPings(): void {
    this.stopPings();
    const ping = () => this.send({ t: "ping", ts: performance.now() });
    ping();
    this.pingTimer = window.setInterval(ping, PING_MS);
  }

  private stopPings(): void {
    if (this.pingTimer !== null) window.clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private resetDecoder(): void {
    const decoder = this.decoder;
    this.decoder = null;
    this.pending = [];
    this.awaitingKey = true;
    if (decoder && decoder.state !== "closed") decoder.close();
  }

  private closeSocket(): void {
    const socket = this.socket;
    this.socket = null;
    this.stopPings();
    this.resetDecoder();
    for (const waiter of this.clipboardWaiters.values()) waiter.reject(new Error("Disconnected."));
    this.clipboardWaiters.clear();
    if (socket && socket.readyState <= WebSocket.OPEN) socket.close(1000, "viewer closed");
  }

  private update(patch: Partial<StreamState>): void {
    this.state = { ...this.state, ...patch };
    this.onState(this.state);
  }
}
