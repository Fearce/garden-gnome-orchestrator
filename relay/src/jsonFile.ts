import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * A small durable JSON document. Writes go to a sibling temp file and are renamed over the target, so a
 * crash mid-write leaves the previous good copy rather than a truncated one — the relay's whole state is
 * two of these, and losing the member list would log everybody out.
 *
 * `save()` is debounced: presence-driven writes arrive in bursts, and the data is worth a few hundred
 * milliseconds of staleness, not a synchronous write per frame.
 */
export class JsonFile<T> {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: T | undefined;

  constructor(
    private readonly path: string,
    private readonly debounceMs = 400,
  ) {}

  read(fallback: T): T {
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as T;
    } catch {
      return fallback;
    }
  }

  /** Queue a write of the LATEST value. A later call inside the debounce window supersedes an earlier
   *  one — keeping the first would persist a stale snapshot and drop everything that followed it. */
  save(value: T): void {
    this.pending = value;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const v = this.pending;
      this.pending = undefined;
      if (v !== undefined) this.writeNow(v);
    }, this.debounceMs);
    this.timer.unref?.();
  }

  /** Write any queued value immediately — the shutdown path, so a bounce can't drop the last few seconds. */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const v = this.pending;
    this.pending = undefined;
    if (v !== undefined) this.writeNow(v);
  }

  writeNow(value: T): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(value), "utf8");
      renameSync(tmp, this.path);
    } catch (e) {
      console.error(`[relay] could not persist ${this.path}: ${(e as Error).message}`);
    }
  }
}
