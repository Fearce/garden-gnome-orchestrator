import type { RecordingLibrary, SweepResult } from "./library.js";
import type { RecordingSettings } from "./recordingPlan.js";

const FIRST_SWEEP_MS = 60_000;
const SWEEP_EVERY_MS = 10 * 60_000;
const BACKLOG_SWEEP_MS = 30_000;
const SETTINGS_SWEEP_MS = 5_000;

/**
 * Keeps the recording folders within the owner's retention settings while this worker runs: a minute after
 * it starts, every ten minutes after that, sooner while a backlog is being worked off, and shortly after the
 * settings change. With retention off (keep everything, no size cap) it never touches the disk.
 */
export class RetentionKeeper {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<SweepResult> | null = null;
  private last: (SweepResult & { error: string | null }) | null = null;
  private disposed = false;

  constructor(
    private readonly library: RecordingLibrary,
    private readonly settings: () => RecordingSettings,
    private readonly log: (line: string) => void,
  ) {}

  start(): void {
    this.schedule(FIRST_SWEEP_MS);
  }

  settingsChanged(): void {
    this.schedule(SETTINGS_SWEEP_MS);
  }

  get lastSweep() {
    return this.last;
  }

  get enabled(): boolean {
    const { retentionDays, maxGbPerCamera } = this.settings();
    return retentionDays > 0 || maxGbPerCamera > 0;
  }

  /** Sweep now (or join the sweep already running). */
  async sweepNow(): Promise<SweepResult & { error: string | null }> {
    this.running ??= this.library.sweep(this.settings()).finally(() => (this.running = null));
    try {
      const result = await this.running;
      this.last = { ...result, error: null };
      if (result.deletedFiles || result.failed) {
        this.log(`retention removed ${result.deletedFiles} recording segment(s), ${(result.deletedBytes / 1024 ** 3).toFixed(2)} GB${result.failed ? `; ${result.failed} could not be removed` : ""}${result.pending ? "; more are due" : ""}`);
      }
    } catch (error) {
      this.last = { at: Date.now(), deletedFiles: 0, deletedBytes: 0, failed: 0, pending: false, error: (error as Error).message };
      this.log(`retention sweep failed: ${this.last.error}`);
    }
    this.schedule(this.last.pending ? BACKLOG_SWEEP_MS : SWEEP_EVERY_MS);
    return this.last;
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delayMs: number): void {
    this.clearTimer();
    if (this.disposed || !this.enabled) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.sweepNow();
    }, delayMs);
  }
}
