import { lstat, readdir, stat, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { HttpError } from "../router.js";

/** The recorder's own file names (`%Y-%m-%d_%H-%M-%S.ts`, local time). Nothing else in a folder is ever touched. */
const SEGMENT_NAME = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})\.ts$/;
const DAY_NAME = /^\d{4}-\d{2}-\d{2}$/;
const STAT_CONCURRENCY = 8;
const INDEX_FRESH_MS = 10_000;
/** A segment written to this recently may still be open in ffmpeg. */
const IN_PROGRESS_MS = 3 * 60_000;
const MAX_DELETES_PER_SWEEP = 400;
/** A file that could not be deleted (locked, read-only) is left alone this long before the next attempt. */
const FAILED_DELETE_BACKOFF_MS = 60 * 60_000;
const DAY_MS = 86_400_000;
const GB = 1024 ** 3;

export interface CameraFolder {
  cameraId: string;
  name: string;
  dir: string;
}

export interface Segment {
  name: string;
  startAt: number;
  bytes: number;
  modifiedAt: number;
}

export interface SweepResult {
  at: number;
  deletedFiles: number;
  deletedBytes: number;
  failed: number;
  /** More segments are due than one sweep deletes; the next sweep comes sooner. */
  pending: boolean;
}

/** When a segment began, from its name, in the machine's local time; null for any other file. */
export function segmentStart(name: string): number | null {
  const match = SEGMENT_NAME.exec(name);
  if (!match) return null;
  const [y, mo, d, h, mi, s] = match.slice(1).map(Number) as [number, number, number, number, number, number];
  const at = new Date(y, mo - 1, d, h, mi, s).getTime();
  return Number.isFinite(at) ? at : null;
}

/**
 * The cameras' recording folders, read on demand: what the recordings browser lists, the one place a segment
 * is resolved to a path for playback, and the retention sweep. Closed segments never change, so each folder
 * keeps its sizes and only stats the names it has not seen (plus the newest, which may still be growing).
 */
export class RecordingLibrary {
  private readonly indexes = new Map<string, FolderIndex>();
  private readonly failedDeletes = new Map<string, number>();

  constructor(private readonly folders: () => CameraFolder[]) {}

  async summary() {
    return Promise.all(
      this.folders().map(async (folder) => {
        const listed = await this.list(folder);
        const days = new Map<string, { day: string; count: number; bytes: number }>();
        for (const segment of listed.segments) {
          const day = segment.name.slice(0, 10);
          const entry = days.get(day) ?? { day, count: 0, bytes: 0 };
          entry.count += 1;
          entry.bytes += segment.bytes;
          days.set(day, entry);
        }
        return {
          cameraId: folder.cameraId,
          name: folder.name,
          folderFound: listed.found,
          error: listed.error,
          segments: listed.segments.length,
          bytes: listed.segments.reduce((sum, segment) => sum + segment.bytes, 0),
          oldestAt: listed.segments[0]?.startAt ?? null,
          newestAt: listed.segments.at(-1)?.startAt ?? null,
          days: [...days.values()].sort((a, b) => b.day.localeCompare(a.day)),
        };
      }),
    );
  }

  async day(cameraId: string, day: string) {
    if (!DAY_NAME.test(day)) throw new HttpError(400, "Pick a day as YYYY-MM-DD");
    const folder = this.folder(cameraId);
    const { segments } = await this.list(folder);
    const newest = segments.at(-1)?.name;
    const now = Date.now();
    return segments
      .filter((segment) => segment.name.startsWith(day))
      .map((segment) => ({ ...segment, live: segment.name === newest && now - segment.modifiedAt < IN_PROGRESS_MS }));
  }

  /** The file behind a segment, refusing any name the recorder could not have written and anything outside the folder. */
  async segmentFile(cameraId: string, name: string): Promise<{ path: string; bytes: number; modifiedAt: number; folder: CameraFolder }> {
    if (!SEGMENT_NAME.test(name)) throw new HttpError(400, "That is not a recording segment");
    const folder = this.folder(cameraId);
    const path = join(folder.dir, name);
    if (resolve(dirname(path)) !== resolve(folder.dir)) throw new HttpError(400, "That is not a recording segment");
    const info = await lstat(path).catch(() => null);
    if (!info?.isFile()) throw new HttpError(404, "That recording is no longer on disk");
    return { path, bytes: info.size, modifiedAt: info.mtimeMs, folder };
  }

  /**
   * Deletes what the retention settings no longer keep: segments older than `retentionDays`, then the oldest
   * until each folder fits `maxGbPerCamera`. The newest segment and anything still being written are kept,
   * and one sweep deletes at most a few hundred files, one at a time, so a first cleanup of a large backlog
   * spreads over several sweeps instead of saturating the disk.
   */
  async sweep(settings: { retentionDays: number; maxGbPerCamera: number }, now = Date.now()): Promise<SweepResult> {
    const result: SweepResult = { at: now, deletedFiles: 0, deletedBytes: 0, failed: 0, pending: false };
    if (settings.retentionDays <= 0 && settings.maxGbPerCamera <= 0) return result;
    const seen = new Set<string>();
    for (const folder of this.folders()) {
      const key = resolve(folder.dir).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const index = this.index(folder.dir);
      let segments: Segment[];
      try {
        ({ segments } = await index.list(0));
      } catch {
        result.failed += 1;
        continue;
      }
      for (const segment of dueForDeletion(segments, settings, now)) {
        const path = join(folder.dir, segment.name);
        if (now - (this.failedDeletes.get(path) ?? -Infinity) < FAILED_DELETE_BACKOFF_MS) continue;
        // Only deletions count toward the cap, so files that cannot be deleted never hold back the rest.
        if (result.deletedFiles >= MAX_DELETES_PER_SWEEP) {
          result.pending = true;
          break;
        }
        try {
          await unlink(path);
          index.forget(segment.name);
          this.failedDeletes.delete(path);
          result.deletedFiles += 1;
          result.deletedBytes += segment.bytes;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") index.forget(segment.name);
          else {
            this.failedDeletes.set(path, now);
            result.failed += 1;
          }
        }
      }
    }
    return result;
  }

  private folder(cameraId: string): CameraFolder {
    const folder = this.folders().find((candidate) => candidate.cameraId === cameraId);
    if (!folder) throw new HttpError(404, "That camera has no recording folder");
    return folder;
  }

  private async list(folder: CameraFolder): Promise<{ segments: Segment[]; found: boolean; error: string | null }> {
    try {
      return { ...(await this.index(folder.dir).list(INDEX_FRESH_MS)), error: null };
    } catch (error) {
      return { segments: [], found: false, error: (error as Error).message };
    }
  }

  private index(dir: string): FolderIndex {
    const key = resolve(dir).toLowerCase();
    let index = this.indexes.get(key);
    if (!index) this.indexes.set(key, (index = new FolderIndex(dir)));
    return index;
  }
}

/** Oldest first: everything past the age limit, then whatever still makes the folder too big. */
function dueForDeletion(segments: Segment[], settings: { retentionDays: number; maxGbPerCamera: number }, now: number): Segment[] {
  const newest = segments.at(-1)?.name;
  const removable = segments.filter((segment) => segment.name !== newest && now - segment.modifiedAt >= IN_PROGRESS_MS);
  const due: Segment[] = [];
  const cutoff = settings.retentionDays > 0 ? now - settings.retentionDays * DAY_MS : -Infinity;
  for (const segment of removable) if (segment.startAt < cutoff) due.push(segment);
  if (settings.maxGbPerCamera > 0) {
    let total = segments.reduce((sum, segment) => sum + segment.bytes, 0) - due.reduce((sum, segment) => sum + segment.bytes, 0);
    const cap = settings.maxGbPerCamera * GB;
    for (const segment of removable) {
      if (total <= cap) break;
      if (segment.startAt < cutoff) continue;
      due.push(segment);
      total -= segment.bytes;
    }
  }
  return due;
}

class FolderIndex {
  private readonly files = new Map<string, Segment>();
  /** When each file was last stat'ed: one still being written then is stat'ed again on the next read. */
  private readonly readAt = new Map<string, number>();
  private refreshedAt = 0;
  private found = false;
  private refreshing: Promise<void> | null = null;

  constructor(private readonly dir: string) {}

  /** The folder's segments by start time, re-read when the last read is older than `maxAgeMs`. */
  async list(maxAgeMs: number): Promise<{ segments: Segment[]; found: boolean }> {
    if (Date.now() - this.refreshedAt >= maxAgeMs) {
      this.refreshing ??= this.refresh().finally(() => (this.refreshing = null));
      await this.refreshing;
    }
    return { segments: [...this.files.values()].sort((a, b) => a.name.localeCompare(b.name)), found: this.found };
  }

  forget(name: string): void {
    this.files.delete(name);
    this.readAt.delete(name);
  }

  /** Unseen, or written to shortly before it was last read: closed segments never change after that. */
  private mayHaveChanged(name: string): boolean {
    const known = this.files.get(name);
    const readAt = this.readAt.get(name);
    return !known || readAt === undefined || readAt - known.modifiedAt < IN_PROGRESS_MS;
  }

  private async refresh(): Promise<void> {
    let names: string[];
    try {
      names = (await readdir(this.dir)).filter((name) => SEGMENT_NAME.test(name)).sort();
      this.found = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      names = [];
      this.found = false;
    }
    const present = new Set(names);
    for (const name of this.files.keys()) {
      if (present.has(name)) continue;
      this.files.delete(name);
      this.readAt.delete(name);
    }
    const toStat = names.filter((name) => this.mayHaveChanged(name));
    await eachLimited(toStat, STAT_CONCURRENCY, async (name) => {
      const readAt = Date.now();
      const info = await stat(join(this.dir, name)).catch(() => null);
      if (!info?.isFile()) return;
      this.files.set(name, { name, startAt: segmentStart(name) ?? info.mtimeMs, bytes: info.size, modifiedAt: info.mtimeMs });
      this.readAt.set(name, readAt);
    });
    this.refreshedAt = Date.now();
  }
}

async function eachLimited<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await work(items[next++]!);
  });
  await Promise.all(lanes);
}
