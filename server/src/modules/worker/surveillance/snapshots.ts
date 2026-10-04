import http from "node:http";
import https from "node:https";

export interface Snapshot {
  frame: Buffer;
  contentType: string;
  at: number;
}

const TIMEOUT_MS = 5_000;
const CACHE_MS = 750;
const MAX_BYTES = 10 * 1024 * 1024;
const MIN_BYTES = 256;
const MAX_ENTRIES = 32;

/**
 * Fetches camera snapshot JPEGs over HTTP. Concurrent callers share one request and a frame is reused for
 * 750 ms, so a grid of viewers costs the camera one request per refresh. A camera that accepts the TCP
 * connection and never answers (a doorbell under recording load does) is cut off after 5 s.
 */
export class SnapshotFetcher {
  private readonly cache = new Map<string, Snapshot>();
  private readonly inflight = new Map<string, Promise<Snapshot>>();

  fetch(sourceUrl: string): Promise<Snapshot> {
    const key = sourceUrl.trim();
    if (!key) return Promise.reject(new Error("no snapshot URL"));
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_MS) return Promise.resolve(cached);
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const request = download(key).then((snapshot) => {
      this.remember(key, snapshot);
      return snapshot;
    });
    this.inflight.set(key, request);
    const clear = () => {
      if (this.inflight.get(key) === request) this.inflight.delete(key);
    };
    request.then(clear, clear);
    return request;
  }

  /** The last good frame no older than `maxAgeMs`, kicking off a refresh in the background. */
  latest(sourceUrl: string, maxAgeMs: number): Snapshot | null {
    this.fetch(sourceUrl).catch(() => undefined);
    return this.cached(sourceUrl, maxAgeMs);
  }

  /** The last good frame no older than `maxAgeMs`, without asking the camera for a new one. */
  cached(sourceUrl: string, maxAgeMs: number): Snapshot | null {
    const cached = this.cache.get(sourceUrl.trim());
    return cached && Date.now() - cached.at < maxAgeMs ? cached : null;
  }

  private remember(key: string, snapshot: Snapshot): void {
    this.cache.delete(key);
    this.cache.set(key, snapshot);
    while (this.cache.size > MAX_ENTRIES) this.cache.delete(this.cache.keys().next().value!);
  }
}

function download(sourceUrl: string): Promise<Snapshot> {
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    return Promise.reject(new Error("the snapshot URL is not a valid URL"));
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return Promise.reject(new Error("the snapshot URL must be http or https"));
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.get(url, { rejectUnauthorized: false }, (response) => {
      const status = response.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        response.resume();
        reject(new Error(`the camera answered HTTP ${status || "error"}`));
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      response.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_BYTES) {
          request.destroy(new Error("the snapshot is larger than 10 MB"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        const frame = Buffer.concat(chunks);
        if (frame.length < MIN_BYTES) reject(new Error("the camera sent an empty snapshot"));
        else resolve({ frame, contentType: String(response.headers["content-type"] || "image/jpeg"), at: Date.now() });
      });
      response.on("error", reject);
    });
    request.setTimeout(TIMEOUT_MS, () => request.destroy(new Error(`no snapshot within ${TIMEOUT_MS / 1000}s`)));
    request.on("error", reject);
  });
}
