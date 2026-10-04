import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readdir, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { Camera } from "./config.js";
import { previewOutputArgs, rtspInputArgs, segmentOutputArgs, type RecordingQuality } from "./ffmpegArgs.js";
import { MultipartJpegParser } from "./mjpeg.js";
import { killTree } from "./processes.js";
import { advanceStreak, isRecorderStale, nextMainRetry, retryAt, segmentOffsets, selectStream, type FailureStreak, type StreamFallback } from "./streamPolicy.js";
import { redactCredentials, safeFolderName } from "./urls.js";

const PREVIEW_FRESH_MS = 8_000;
const WARMUP_MS = 30_000;
const PREVIEW_RESPAWN_DEBOUNCE_MS = 30_000;
const RECORDING_FRESH_MS = 120_000;
const PREVIEW_STALL_RESPAWN_MS = 120_000;
const STALL_RESTART_DELAY_MS = 1_000;
const EXIT_RESTART_DELAY_MS = 5_000;
const FAIL_BACKOFF_CAP_MS = 5 * 60_000;
const FAIL_LOG_SUPPRESS_AFTER = 3;
const FAIL_LOG_EVERY_MS = 5 * 60_000;
const HEALTH_SWEEP_MS = 30_000;
const SWEEP_LATE_TOLERANCE_MS = 5_000;
const MAX_STALL_HOLDS = 4;

interface Recording {
  key: string;
  cameraId: string;
  cameraName: string;
  child: ChildProcess;
  sourceUrl: string;
  candidates: string[];
  targetDir: string;
  clocktimeOffset: number;
  startedAt: number;
  latestFrame: Buffer | null;
  latestFrameAt: number;
  stopping: boolean;
  restartOnExit: boolean;
  restartDelayMs: number;
  stalledRespawnAt: number;
  stallHolds: number;
  lastHealthLogAt: number;
}

export interface CameraRecordingStatus {
  cameraId: string;
  state: "recording" | "connecting" | "waiting" | "not-configured";
  usingSubStream: boolean;
  targetDir: string | null;
  lastFrameAt: number | null;
  retryAt: number | null;
  failures: number;
}

/**
 * Records every camera with a stream: one ffmpeg per camera writes 15-minute segment files AND the live
 * preview, so a camera holds a single RTSP connection however many people watch. Recording runs only after the
 * owner starts it, and keeps running when the tab closes or GGO restarts, until they stop it.
 */
export class Recorder {
  private readonly recordings = new Map<string, Recording>();
  private readonly fallbacks = new Map<string, StreamFallback>();
  private readonly streaks = new Map<string, FailureStreak>();
  private active = false;
  private syncTimer: NodeJS.Timeout | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private lastSweepAt = 0;
  private recordingRoot = "";
  private cameras: Camera[] = [];

  constructor(
    private readonly resolveFfmpeg: () => Promise<string | null>,
    private readonly log: (line: string) => void,
  ) {}

  get isActive(): boolean {
    return this.active;
  }

  get processCount(): number {
    return this.recordings.size;
  }

  /** Begin (or re-target) recording for `cameras`. Throws when nothing could be recorded. */
  async start(recordingRoot: string, cameras: Camera[]): Promise<void> {
    if (!recordingRoot.trim() && !cameras.some((c) => c.recordingDir.trim())) throw new Error("Choose a recording folder first");
    if (!(await this.resolveFfmpeg())) throw new Error("ffmpeg was not found; install it in Remote Control or set its path in the camera settings");
    this.active = true;
    this.update(recordingRoot, cameras);
    if (!this.healthTimer) {
      this.lastSweepAt = Date.now();
      this.healthTimer = setInterval(() => void this.healthSweep(), HEALTH_SWEEP_MS);
    }
  }

  /** New settings while recording: restart only the cameras whose source, folder or offset changed. */
  update(recordingRoot: string, cameras: Camera[]): void {
    this.recordingRoot = recordingRoot.trim();
    this.cameras = cameras;
    if (this.active) this.scheduleSync(0);
  }

  async stop(): Promise<void> {
    this.active = false;
    if (this.syncTimer) clearTimeout(this.syncTimer);
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.syncTimer = null;
    this.healthTimer = null;
    const exits = [...this.recordings.values()].map((recording) => this.end(recording));
    await Promise.all(exits);
    this.streaks.clear();
  }

  /** The recorder's latest preview frame for a camera, when it is fresh. A stale one nudges a pipe repair. */
  frame(cameraId: string): { buf: Buffer; at: number } | null {
    const recording = this.byCamera(cameraId);
    if (!recording) return null;
    if (recording.latestFrame && Date.now() - recording.latestFrameAt < PREVIEW_FRESH_MS) return { buf: recording.latestFrame, at: recording.latestFrameAt };
    void this.repairStalledPreview(recording, false);
    return null;
  }

  /** True when this camera's frames come from the recorder (live or warming up) rather than a separate preview. */
  owns(camera: Camera): boolean {
    return this.active && Boolean(this.sourceFor(camera).url) && Boolean(this.targetDir(camera));
  }

  statuses(): CameraRecordingStatus[] {
    return this.cameras.map((camera) => {
      const key = cameraKey(camera);
      const recording = this.recordings.get(key);
      const source = this.sourceFor(camera);
      const streak = this.streaks.get(key);
      const dir = this.targetDir(camera);
      let state: CameraRecordingStatus["state"] = "not-configured";
      if (source.url && dir) state = recording ? (recording.latestFrameAt ? "recording" : "connecting") : "waiting";
      return {
        cameraId: camera.id,
        state: this.active ? state : source.url && dir ? "waiting" : "not-configured",
        usingSubStream: source.usingFallback,
        targetDir: dir || null,
        lastFrameAt: recording?.latestFrameAt || null,
        retryAt: streak ? retryAt(streak, source.url ?? "") : null,
        failures: streak?.count ?? 0,
      };
    });
  }

  private byCamera(cameraId: string): Recording | undefined {
    for (const recording of this.recordings.values()) if (recording.cameraId === cameraId) return recording;
    return undefined;
  }

  private sourceFor(camera: Camera): { url: string | null; candidates: string[]; usingFallback: boolean } {
    const candidates = [...new Set([camera.streamUrl, camera.subStreamUrl].map((url) => url.trim()).filter(Boolean))];
    const key = cameraKey(camera);
    const choice = selectStream(candidates, this.fallbacks.get(key), Date.now());
    if (!choice.usingFallback) this.fallbacks.delete(key);
    return { url: choice.url, candidates, usingFallback: choice.usingFallback };
  }

  private targetDir(camera: Camera): string {
    const explicit = camera.recordingDir.trim();
    if (explicit) return isAbsolute(explicit) || !this.recordingRoot ? explicit : join(this.recordingRoot, explicit);
    if (!this.recordingRoot) return "";
    return join(this.recordingRoot, safeFolderName(camera.name || camera.model || camera.host || camera.id) || "camera");
  }

  private scheduleSync(delayMs: number): void {
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      this.sync().catch((error: Error) => this.log(`[recording] sync failed: ${error.message}`));
    }, delayMs);
  }

  private async sync(stallInFlight = false): Promise<void> {
    if (!this.active) return;
    const desired = new Map<string, { camera: Camera; sourceUrl: string; candidates: string[]; targetDir: string; offset: number }>();
    for (const camera of this.cameras) {
      const source = this.sourceFor(camera);
      const targetDir = this.targetDir(camera);
      if (source.url && targetDir) desired.set(cameraKey(camera), { camera, sourceUrl: source.url, candidates: source.candidates, targetDir, offset: 0 });
    }
    const offsets = segmentOffsets([...desired.keys()]);
    for (const [key, want] of desired) want.offset = offsets.get(key) ?? 0;

    for (const [key, recording] of this.recordings) {
      const want = desired.get(key);
      if (!want) {
        void this.end(recording);
      } else if (want.sourceUrl !== recording.sourceUrl || want.targetDir !== recording.targetDir || want.offset !== recording.clocktimeOffset) {
        this.restart(recording, 800);
      } else if (!(await this.healthy(recording))) {
        if (stallInFlight && recording.stallHolds < MAX_STALL_HOLDS) {
          recording.stallHolds += 1;
          continue;
        }
        if (Date.now() - recording.lastHealthLogAt > 60_000) {
          recording.lastHealthLogAt = Date.now();
          this.log(`[recording ${recording.cameraName}] stopped producing frames and files; restarting it so the recording has no hole`);
        }
        this.restart(recording, STALL_RESTART_DELAY_MS);
      } else {
        recording.stallHolds = 0;
      }
    }

    let earliestRetry = 0;
    for (const [key, want] of desired) {
      if (this.recordings.has(key)) continue;
      const streak = this.streaks.get(key);
      const at = retryAt(streak, want.sourceUrl);
      if (streak && at === null) this.streaks.delete(key);
      else if (at !== null && at > Date.now()) {
        earliestRetry = earliestRetry ? Math.min(earliestRetry, at) : at;
        continue;
      }
      await this.spawnRecording(key, want.camera, want.sourceUrl, want.candidates, want.targetDir, want.offset);
    }
    if (earliestRetry) this.scheduleSync(Math.max(1_000, earliestRetry - Date.now()));
  }

  private async healthSweep(): Promise<void> {
    const now = Date.now();
    const late = now - this.lastSweepAt > HEALTH_SWEEP_MS + SWEEP_LATE_TOLERANCE_MS;
    this.lastSweepAt = now;
    for (const recording of this.recordings.values()) await this.repairStalledPreview(recording, late);
    await this.sync(late);
  }

  private async healthy(recording: Recording): Promise<boolean> {
    if (recording.stopping) return true;
    const now = Date.now();
    const newest = await newestSegment(recording.targetDir);
    return !isRecorderStale(
      { ageMs: now - recording.startedAt, frameAgeMs: recording.latestFrameAt ? now - recording.latestFrameAt : Infinity, fileAgeMs: newest ? now - newest : Infinity },
      WARMUP_MS,
      RECORDING_FRESH_MS,
    );
  }

  /**
   * The preview pipe can wedge for hours while the segment file keeps growing. Recording outranks preview, so
   * the recorder is only restarted for a wedged pipe once it has been stale for two minutes, or at once when
   * the recording itself stopped too.
   */
  private async repairStalledPreview(recording: Recording, timerWasLate: boolean): Promise<void> {
    const now = Date.now();
    if (recording.stopping || now - recording.startedAt < WARMUP_MS) return;
    const frameAgeMs = now - (recording.latestFrameAt || recording.startedAt);
    if (frameAgeMs < PREVIEW_FRESH_MS) return;
    if (recording.stalledRespawnAt && now - recording.stalledRespawnAt < PREVIEW_RESPAWN_DEBOUNCE_MS) return;
    if (timerWasLate && recording.stallHolds < MAX_STALL_HOLDS) {
      recording.stallHolds += 1;
      return;
    }
    const newest = await newestSegment(recording.targetDir);
    if (frameAgeMs < PREVIEW_STALL_RESPAWN_MS && newest && now - newest < RECORDING_FRESH_MS) return;
    recording.stalledRespawnAt = now;
    this.log(`[recording ${recording.cameraName}] preview stalled (${recording.latestFrameAt ? `${Math.round(frameAgeMs / 1000)}s old` : "no frame yet"}); restarting its recorder`);
    this.restart(recording, STALL_RESTART_DELAY_MS);
  }

  private restart(recording: Recording, delayMs: number): void {
    recording.restartOnExit = true;
    recording.restartDelayMs = delayMs;
    if (recording.stopping) return;
    recording.stopping = true;
    killTree(recording.child);
  }

  private end(recording: Recording): Promise<void> {
    recording.restartOnExit = false;
    recording.stopping = true;
    if (recording.child.exitCode !== null || recording.child.signalCode !== null) return Promise.resolve();
    const exited = new Promise<void>((resolve) => {
      recording.child.once("close", () => resolve());
      setTimeout(resolve, 8_000).unref();
    });
    killTree(recording.child);
    return exited;
  }

  private async spawnRecording(key: string, camera: Camera, sourceUrl: string, candidates: string[], targetDir: string, offset: number): Promise<void> {
    const ffmpeg = await this.resolveFfmpeg();
    if (!ffmpeg) {
      this.log("[recording] ffmpeg is not available; cannot record");
      return;
    }
    try {
      await mkdir(targetDir, { recursive: true });
    } catch (error) {
      this.log(`[recording ${camera.name}] cannot create ${targetDir}: ${(error as Error).message}`);
      this.streaks.set(key, advanceStreak(this.streaks.get(key), sourceUrl, Date.now(), EXIT_RESTART_DELAY_MS, FAIL_BACKOFF_CAP_MS));
      return;
    }
    const args = [...rtspInputArgs(sourceUrl, "warning"), ...segmentOutputArgs(recordingQuality(camera), join(targetDir, "%Y-%m-%d_%H-%M-%S.ts"), offset), ...previewOutputArgs()];
    let child: ChildProcess;
    try {
      child = spawn(ffmpeg, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      this.log(`[recording ${camera.name}] ffmpeg could not start: ${(error as Error).message}`);
      return;
    }
    const recording: Recording = {
      key,
      cameraId: camera.id,
      cameraName: camera.name || camera.id,
      child,
      sourceUrl,
      candidates,
      targetDir,
      clocktimeOffset: offset,
      startedAt: Date.now(),
      latestFrame: null,
      latestFrameAt: 0,
      stopping: false,
      restartOnExit: false,
      restartDelayMs: EXIT_RESTART_DELAY_MS,
      stalledRespawnAt: 0,
      stallHolds: 0,
      lastHealthLogAt: 0,
    };
    this.recordings.set(key, recording);
    const parser = new MultipartJpegParser((frame) => {
      recording.latestFrame = frame;
      recording.latestFrameAt = Date.now();
      // A real main-stream frame proves the main stream is back; the next failure starts the retry ladder over.
      if (recording.sourceUrl === recording.candidates[0]) this.fallbacks.delete(key);
    });
    child.stdout!.on("data", (chunk: Buffer) => parser.push(chunk));
    child.stderr!.on("data", (chunk: Buffer) => this.logStderr(recording, chunk));
    let handled = false;
    const onExit = () => {
      if (handled) return;
      handled = true;
      this.afterExit(recording);
    };
    child.on("error", (error) => {
      this.log(`[recording ${recording.cameraName}] ffmpeg error: ${error.message}`);
      onExit();
    });
    child.on("close", onExit);
  }

  private afterExit(recording: Recording): void {
    if (this.recordings.get(recording.key) === recording) this.recordings.delete(recording.key);
    const intentional = recording.stopping;
    let fellBack = false;
    if (!intentional) {
      fellBack = this.fallBackToSubStream(recording);
      if (recording.latestFrameAt || fellBack) this.streaks.delete(recording.key);
      else this.streaks.set(recording.key, advanceStreak(this.streaks.get(recording.key), recording.sourceUrl, Date.now(), EXIT_RESTART_DELAY_MS, FAIL_BACKOFF_CAP_MS));
      const ranFor = Math.round((Date.now() - recording.startedAt) / 1000);
      this.log(`[recording ${recording.cameraName}] ffmpeg exited on its own after ${ranFor}s (${recording.latestFrameAt ? "had delivered frames" : "never delivered a frame"})${fellBack ? ", switching to the sub stream" : ""}; starting it again`);
    }
    if (this.active && (!intentional || recording.restartOnExit)) this.scheduleSync(fellBack ? STALL_RESTART_DELAY_MS : recording.restartDelayMs);
  }

  private fallBackToSubStream(recording: Recording): boolean {
    if (recording.latestFrameAt || recording.sourceUrl !== recording.candidates[0]) return false;
    const subStream = recording.candidates[1];
    if (!subStream) return false;
    const retry = nextMainRetry(this.fallbacks.get(recording.key), subStream, Date.now());
    this.fallbacks.set(recording.key, { url: retry.url, attempts: retry.attempts, retryMainAt: retry.retryMainAt });
    this.log(`[recording ${recording.cameraName}] main stream sent no frames; using the sub stream and trying main again in ${Math.round(retry.delayMs / 60_000)} min (attempt ${retry.attempts})`);
    return true;
  }

  private logStderr(recording: Recording, chunk: Buffer): void {
    const text = redactCredentials(chunk.toString("utf8").trim());
    if (!text) return;
    const streak = this.streaks.get(recording.key);
    if (streak && retryAt(streak, recording.sourceUrl) !== null && streak.count >= FAIL_LOG_SUPPRESS_AFTER) {
      if (Date.now() - streak.lastNoteAt < FAIL_LOG_EVERY_MS) return;
      streak.lastNoteAt = Date.now();
      this.log(`[recording ${recording.cameraName}] still cannot connect (${streak.count} attempts, backing off); repeats muted for ${FAIL_LOG_EVERY_MS / 60_000} min. Last ffmpeg output: ${text}`);
      return;
    }
    this.log(`[recording ${recording.cameraName}] ${text}`);
  }
}

export function cameraKey(camera: Camera): string {
  return camera.id || camera.host;
}

/** Duo cameras stream two lenses side by side; their default recording size is halved to keep storage small. */
function recordingQuality(camera: Camera): RecordingQuality {
  const compact = /duo/i.test(`${camera.modelPreset} ${camera.model} ${camera.name}`);
  return {
    fps: camera.recordingFps,
    width: camera.recordingWidth || (compact ? 640 : 1280),
    height: camera.recordingHeight || (compact ? 360 : 720),
    bitrateKbps: camera.recordingBitrateKbps ?? (compact ? 120 : 220),
  };
}

/** mtime of the newest segment. Names are strftime stamps, so only the last few by name are stat'ed. */
async function newestSegment(dir: string): Promise<number | null> {
  try {
    const names = (await readdir(dir)).filter((name) => name.endsWith(".ts")).sort();
    for (let i = names.length - 1; i >= 0 && i >= names.length - 3; i -= 1) {
      const info = await stat(join(dir, names[i]!)).catch(() => null);
      if (info?.isFile()) return info.mtimeMs;
    }
  } catch {
    return null;
  }
  return null;
}
