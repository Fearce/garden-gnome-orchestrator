import type { WorkerContext } from "../context.js";
import { HttpError } from "../router.js";
import type { SurveillanceConfig } from "./config.js";
import { recordingProblem, type Recorder } from "./recorder.js";
import { scheduleState, type RecordingMode } from "./recordingPlan.js";

const PLAN_CHECK_MS = 30_000;

/**
 * Runs the owner's recording plan. Off (the default) records nothing; 24/7 records until the owner turns it
 * off; a schedule opens and closes the recorder at its window's edges. Any mode but off is declared to GGO as
 * user-started work, so the worker outlives the tab and comes back after a crash, a deploy or a reboot.
 */
export class RecordingController {
  private planTimer: NodeJS.Timeout | null = null;
  private armedLabel: string | null | undefined = undefined;
  private lastError: string | null = null;
  private applying: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(
    private readonly recorder: Recorder,
    private readonly ctx: Pick<WorkerContext, "setArmed" | "log">,
    private readonly config: () => SurveillanceConfig,
  ) {}

  /** Refuses a plan that would record nothing, so turning it on never silently does nothing. */
  async validate(next: SurveillanceConfig, ffmpeg: string | null): Promise<void> {
    if (next.recording.mode === "off") return;
    const problem = recordingProblem(next.recordingRoot, next.cameras);
    if (problem) throw new HttpError(400, problem);
    if (next.recording.mode === "schedule" && next.recording.schedule.days.length === 0) throw new HttpError(400, "The schedule has no days; choose at least one under Recording settings");
    if (!ffmpeg) throw new HttpError(400, "ffmpeg was not found; install it or set its location under Recording settings");
  }

  /** Bring the recorder and the armed marker in line with the current config. Calls are serialised. */
  apply(): Promise<void> {
    const run = this.applying.then(() => this.applyNow());
    this.applying = run.catch(() => undefined);
    return run;
  }

  get isRecording(): boolean {
    return this.recorder.isActive;
  }

  /** Why the worker must stay up (it holds the plan), or null when recording is off. */
  busyLabel(): string | null {
    return planLabel(this.config());
  }

  /**
   * Declare a plan before it is saved, so a worker dying between the two can never leave a mode that is on
   * without its marker (which the next start reads as "stopped anyway" and turns off).
   */
  async armFor(next: SurveillanceConfig): Promise<void> {
    const label = planLabel(next);
    if (!label || label === this.armedLabel) return;
    await this.ctx.setArmed(label);
    this.armedLabel = label;
  }

  view() {
    const { recording } = this.config();
    const schedule = recording.mode === "schedule" ? scheduleState(recording.schedule) : null;
    return {
      mode: recording.mode,
      active: this.recorder.isActive,
      inWindow: schedule?.active ?? null,
      nextChangeAt: schedule?.nextChangeAt ?? null,
      lastError: this.lastError,
    };
  }

  /** Stop following the plan and wait out a start or stop already under way, so none begins after shutdown. */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.stopWatching();
    await this.applying;
  }

  private stopWatching(): void {
    if (this.planTimer) clearInterval(this.planTimer);
    this.planTimer = null;
  }

  private async applyNow(): Promise<void> {
    if (this.disposed) return;
    const config = this.config();
    const mode = config.recording.mode;
    this.watchPlan(mode);
    const segmentSeconds = config.recording.segmentMinutes * 60;
    if (this.shouldRecord(config)) {
      if (this.recorder.isActive) {
        this.recorder.update(config.recordingRoot, config.cameras, segmentSeconds);
        this.lastError = null;
      } else {
        try {
          await this.recorder.start(config.recordingRoot, config.cameras, segmentSeconds);
          this.lastError = null;
          this.ctx.log(`recording started (${describe(mode)})`);
        } catch (error) {
          const message = (error as Error).message;
          // The plan timer retries every 30 s; say so once per distinct reason, not every time.
          if (message !== this.lastError) this.ctx.log(`recording could not start: ${message}; retrying every ${PLAN_CHECK_MS / 1000}s`);
          this.lastError = message;
        }
      }
    } else {
      this.recorder.update(config.recordingRoot, config.cameras, segmentSeconds);
      if (this.recorder.isActive) {
        await this.recorder.stop();
        this.ctx.log(mode === "off" ? "recording turned off" : "the recording schedule closed; recording paused until it opens again");
      }
      this.lastError = null;
    }
    await this.syncArmed();
  }

  private shouldRecord(config: SurveillanceConfig): boolean {
    const { mode, schedule } = config.recording;
    return mode === "continuous" || (mode === "schedule" && scheduleState(schedule).active);
  }

  /** While a plan is on: follow the schedule's edges, and retry a start that failed (ffmpeg missing, folder gone). */
  private watchPlan(mode: RecordingMode): void {
    if (mode !== "off" && !this.planTimer) this.planTimer = setInterval(() => this.tick(), PLAN_CHECK_MS);
    else if (mode === "off") this.stopWatching();
  }

  private tick(): void {
    if (this.shouldRecord(this.config()) !== this.recorder.isActive) void this.apply();
  }

  private async syncArmed(): Promise<void> {
    const label = this.busyLabel();
    if (label === this.armedLabel) return;
    await this.ctx.setArmed(label);
    this.armedLabel = label;
  }
}

function planLabel(config: SurveillanceConfig): string | null {
  const { mode } = config.recording;
  if (mode === "off") return null;
  const count = config.cameras.filter((camera) => camera.recordEnabled).length;
  const cameras = `${count} camera${count === 1 ? "" : "s"}`;
  return mode === "continuous" ? `recording ${cameras} 24/7` : `recording ${cameras} on a schedule`;
}

function describe(mode: RecordingMode): string {
  return mode === "continuous" ? "24/7" : mode === "schedule" ? "on schedule" : "off";
}
