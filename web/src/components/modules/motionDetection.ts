/** Picture-change detection on a small luminance grid; uniform exposure shifts are ignored. */
export class MotionDetector {
  private previous: Float32Array | null = null;
  private at = 0;
  private lastAlert = -Infinity;

  sample(pixels: Uint8ClampedArray, at: number, maxGapMs = 30_000): boolean {
    if (at <= this.at) return false;
    const grid = new Float32Array(pixels.length / 4);
    let mean = 0;
    for (let i = 0; i < grid.length; i++) {
      grid[i] = pixels[i * 4]! * 0.299 + pixels[i * 4 + 1]! * 0.587 + pixels[i * 4 + 2]! * 0.114;
      mean += grid[i]!;
    }
    mean /= grid.length;
    for (let i = 0; i < grid.length; i++) grid[i] = grid[i]! - mean;
    const before = this.previous;
    const gap = at - this.at;
    this.previous = grid;
    this.at = at;
    if (!before || before.length !== grid.length || gap > maxGapMs) return false;
    let changed = 0;
    for (let i = 0; i < grid.length; i++) if (Math.abs(grid[i]! - before[i]!) > 20) changed++;
    if (changed / grid.length < 0.08 || at - this.lastAlert < 30_000) return false;
    this.lastAlert = at;
    return true;
  }
}
