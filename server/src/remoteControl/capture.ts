import { Worker } from "node:worker_threads";
import type { DisplayInfo } from "./desktop.js";
import type { CaptureSize } from "./ffmpeg.js";
import { FlvDemuxer, type FlvPacket } from "./flv.js";

export type ConfigPacket = Extract<FlvPacket, { kind: "config" }>;
export type FramePacket = Extract<FlvPacket, { kind: "frame" }>;

export interface CaptureEvents {
  onConfig(capture: Capture, packet: ConfigPacket): void;
  onFrame(capture: Capture, packet: FramePacket): void;
  /** The process ended on its own (not through `stop`), with the tail of its stderr. */
  onExit(capture: Capture, stderr: string): void;
}

// Each capture's ffmpeg is spawned and read on its own worker thread. Windows runs CreateProcessW
// synchronously on the calling thread, and on this box that blocks for hundreds of ms (see
// childRunner.ts); on the main loop it would freeze the stream it is meant to replace, every time the
// quality, display or bitrate changes. Inline CommonJS source for the same reason as childRunner's: the
// server runs both as compiled dist and as TypeScript under tsx, so a worker file has no single path.
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { spawn } = require("node:child_process");
function run() {
  let child;
  try {
    child = spawn(workerData.ffmpegPath, workerData.args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    parentPort.postMessage({ t: "exit", stderr: String((e && e.message) || e) });
    return;
  }
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    const copy = new Uint8Array(chunk);
    parentPort.postMessage({ t: "out", data: copy }, [copy.buffer]);
  });
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-4000); });
  child.on("error", (e) => {
    stderr += "\\n" + String((e && e.message) || e);
    if (child.pid === undefined) parentPort.postMessage({ t: "exit", stderr });
  });
  child.on("close", () => parentPort.postMessage({ t: "exit", stderr }));
  parentPort.on("message", (m) => { if (m === "kill" && child.exitCode === null) child.kill(); });
}
run();
`;

type WorkerMessage = { t: "out"; data: Uint8Array } | { t: "exit"; stderr: string };

/** One ffmpeg capture of `display` at `size`, demuxed into the stream's config and one packet per encoded frame. */
export class Capture {
  frames = 0;
  private readonly worker: Worker;
  private readonly demuxer = new FlvDemuxer();
  private stopped = false;
  private exited = false;

  constructor(ffmpegPath: string, args: string[], readonly display: DisplayInfo, readonly size: CaptureSize, private readonly events: CaptureEvents) {
    this.worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { ffmpegPath, args } });
    this.worker.on("message", (message: WorkerMessage) => {
      if (message.t === "out") this.onOutput(Buffer.from(message.data.buffer, message.data.byteOffset, message.data.byteLength));
      else this.onExit(message.stderr);
    });
    this.worker.on("error", (error: Error) => this.onExit(error.message));
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    // The worker kills ffmpeg and ends once its pipes close; terminating it first would orphan ffmpeg.
    if (!this.exited) this.worker.postMessage("kill");
  }

  private onOutput(chunk: Buffer): void {
    if (this.stopped) return;
    try {
      for (const packet of this.demuxer.push(chunk)) {
        if (this.stopped) return;
        if (packet.kind === "config") this.events.onConfig(this, packet);
        else {
          this.frames++;
          this.events.onFrame(this, packet);
        }
      }
    } catch (error) {
      this.stop();
      this.events.onExit(this, (error as Error).message);
    }
  }

  private onExit(stderr: string): void {
    if (this.exited) return;
    this.exited = true;
    void this.worker.terminate();
    if (!this.stopped) this.events.onExit(this, stderr);
  }
}
