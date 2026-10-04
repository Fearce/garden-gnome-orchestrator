import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat, utimes } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { HttpError } from "../router.js";
import { killTree } from "./processes.js";

// Under the GGO proxy's 90 s wait for an answer, so a slow remux fails here with its reason, not as a 504.
const REMUX_TIMEOUT_MS = 75_000;
const MAX_PARALLEL_REMUX = 2;
const CACHE_LIMIT_BYTES = 1024 ** 3;

/**
 * Browsers cannot play the recorder's MPEG-TS segments, so a segment is re-wrapped as MP4 the first time it
 * is played: ffmpeg copies the H.264 stream without re-encoding (a second or two for a 15-minute file), and
 * the result is cached so seeking and replays are plain file reads. The cache is capped at 1 GB, oldest out.
 */
export class PlaybackCache {
  private readonly inflight = new Map<string, Promise<string>>();
  private running = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly dir: string,
    private readonly ffmpeg: () => Promise<string | null>,
    private readonly log: (line: string) => void,
  ) {}

  /**
   * A playable MP4 of `source` as of `version`. The player pins the version it listed, so the seeks of one
   * playback all read one copy even while the segment is still growing; a new version makes a new copy.
   */
  async mp4For(source: string, version: string): Promise<string> {
    const key = createHash("sha1").update(`${source}|${version}`).digest("hex").slice(0, 24);
    const target = join(this.dir, `${key}.mp4`);
    const cached = await stat(target).catch(() => null);
    if (cached?.isFile()) {
      const now = new Date();
      await utimes(target, now, now).catch(() => undefined);
      return target;
    }
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.remux(source, target).finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    return pending;
  }

  private async remux(source: string, target: string): Promise<string> {
    const ffmpeg = await this.ffmpeg();
    if (!ffmpeg) throw new HttpError(503, "Playing a recording in the browser needs ffmpeg; download the original file instead, or set ffmpeg's location under Recording settings");
    await mkdir(this.dir, { recursive: true });
    await this.acquire();
    const partial = `${target}.${process.pid}.part`;
    try {
      await runFfmpeg(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-i", source, "-map", "0:v:0", "-c", "copy", "-movflags", "+faststart", "-f", "mp4", partial]);
      await rename(partial, target);
    } catch (error) {
      // A timed-out ffmpeg may still hold the file on Windows; trim() clears the leftover later.
      await rm(partial, { force: true }).catch(() => undefined);
      this.log(`could not prepare a recording for playback: ${(error as Error).message}`);
      throw new HttpError(502, `This recording could not be prepared for playback: ${(error as Error).message}`);
    } finally {
      this.release();
    }
    void this.trim(target);
    return target;
  }

  private async acquire(): Promise<void> {
    if (this.running < MAX_PARALLEL_REMUX) {
      this.running += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.running -= 1;
  }

  /** Oldest copies out past the cap, never `fresh` (just made, about to be served), plus stale `.part` leftovers. */
  private async trim(fresh: string): Promise<void> {
    try {
      const files = await Promise.all(
        (await readdir(this.dir)).map(async (name) => ({ name, path: join(this.dir, name), info: await stat(join(this.dir, name)).catch(() => null) })),
      );
      const now = Date.now();
      for (const file of files) {
        if (file.name.endsWith(".part") && file.info && now - file.info.mtimeMs > 2 * REMUX_TIMEOUT_MS) await rm(file.path, { force: true }).catch(() => undefined);
      }
      const copies = files.filter((file) => file.name.endsWith(".mp4") && file.info && file.path !== fresh).sort((a, b) => b.info!.mtimeMs - a.info!.mtimeMs);
      let total = files.find((file) => file.path === fresh)?.info?.size ?? 0;
      for (const file of copies) {
        total += file.info!.size;
        // A copy still being played is open on Windows and cannot be removed; it goes on a later trim.
        if (total > CACHE_LIMIT_BYTES) await rm(file.path, { force: true }).catch(() => undefined);
      }
    } catch (error) {
      this.log(`could not trim the playback cache: ${(error as Error).message}`);
    }
  }
}

function runFfmpeg(ffmpeg: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr!.on("data", (chunk: Buffer) => {
      if (stderr.length < 2000) stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      killTree(child);
      reject(new Error(`ffmpeg took longer than ${REMUX_TIMEOUT_MS / 1000}s`));
    }, REMUX_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim().split(/\r?\n/).at(-1) || `ffmpeg exited with ${code}`));
    });
  });
}

/**
 * Send a file with HTTP range support, which a <video> element needs to seek. `downloadName` makes it an
 * attachment; the name is sent both as a plain ASCII fallback and in full (RFC 6266).
 */
export async function sendFile(req: IncomingMessage, res: ServerResponse, path: string, options: { contentType: string; downloadName?: string }): Promise<void> {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) throw new HttpError(404, "That recording is no longer on disk");
  const headers: Record<string, string | number> = { "content-type": options.contentType, "accept-ranges": "bytes" };
  if (options.downloadName) {
    const ascii = options.downloadName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
    headers["content-disposition"] = `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(options.downloadName)}`;
  }
  const range = parseRange(req.headers.range, info.size);
  if (range === "invalid") {
    res.writeHead(416, { "content-range": `bytes */${info.size}` });
    res.end();
    return;
  }
  const [start, end] = range ?? [0, info.size - 1];
  headers["content-length"] = info.size === 0 ? 0 : end - start + 1;
  if (range) headers["content-range"] = `bytes ${start}-${end}/${info.size}`;
  res.writeHead(range ? 206 : 200, headers);
  if (info.size === 0) {
    res.end();
    return;
  }
  const stream = createReadStream(path, { start, end });
  res.once("close", () => stream.destroy());
  stream.once("error", () => res.destroy());
  stream.pipe(res);
}

/**
 * One `bytes=` range, as [start, end] inclusive. null (serve the whole file) for none or one this server
 * does not parse, such as a multi-range; "invalid" only for a well-formed range the file cannot satisfy.
 */
function parseRange(header: string | undefined, size: number): [number, number] | null | "invalid" {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return null;
  if (match[1] && match[2] && Number(match[1]) > Number(match[2])) return null;
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (suffix === 0) return "invalid";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  }
  if (start >= size) return "invalid";
  return [start, end];
}
