/**
 * Caps how many lines one source may log per window. A camera with a damaged HEVC stream makes ffmpeg print
 * a warning per frame, which would otherwise grow the worker log by megabytes a day for as long as it records.
 */
export class LineThrottle {
  private readonly windows = new Map<string, { startedAt: number; lines: number; muted: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Whether this line may be logged, plus a note on how many were muted in the window that just ended. */
  admit(key: string, now = Date.now()): { pass: boolean; mutedNote: string | null } {
    let window = this.windows.get(key);
    let mutedNote: string | null = null;
    if (!window || now - window.startedAt >= this.windowMs) {
      if (window?.muted) mutedNote = `${window.muted} more ffmpeg line(s) muted in the last ${Math.round(this.windowMs / 1000)}s`;
      window = { startedAt: now, lines: 0, muted: 0 };
      this.windows.set(key, window);
    }
    if (window.lines < this.limit) {
      window.lines++;
      return { pass: true, mutedNote };
    }
    window.muted++;
    return { pass: false, mutedNote };
  }

  forget(key: string): void {
    this.windows.delete(key);
  }
}
