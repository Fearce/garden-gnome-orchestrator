/** Bounded, session-memory snapshots. Invalidated requests cannot repopulate the cache. */
export class RequestCache {
  private values = new Map<string, { value: unknown; at: number; bytes: number }>();
  private pending = new Map<string, Promise<unknown>>();
  private bytes = 0;
  constructor(private readonly maxEntries = 128, private readonly maxBytes = 16 * 1024 * 1024, private readonly now = Date.now) {}

  peek<T>(key: string): T | undefined {
    const entry = this.values.get(key);
    if (!entry) return;
    this.values.delete(key); this.values.set(key, entry);
    return entry.value as T;
  }

  invalidate(predicate: (key: string) => boolean = () => true) {
    for (const [key, entry] of this.values) if (predicate(key)) { this.bytes -= entry.bytes; this.values.delete(key); }
    for (const key of this.pending.keys()) if (predicate(key)) this.pending.delete(key);
  }

  async read<T>(key: string, loader: () => Promise<T>, ttl: number, fresh = false): Promise<T> {
    const entry = this.values.get(key);
    if (!fresh && entry && this.now() - entry.at < ttl) return this.peek<T>(key)!;
    const pending = this.pending.get(key);
    if (pending) return pending as Promise<T>;
    const request = Promise.resolve().then(loader).then(value => {
      if (this.pending.get(key) !== request) return value;
      const bytes = JSON.stringify(value).length * 2;
      const previous = this.values.get(key);
      if (previous) { this.bytes -= previous.bytes; this.values.delete(key); }
      if (bytes <= this.maxBytes) {
        this.values.set(key, { value, bytes, at: this.now() }); this.bytes += bytes;
        while (this.values.size > this.maxEntries || this.bytes > this.maxBytes) {
          const oldest = this.values.keys().next().value!;
          this.bytes -= this.values.get(oldest)!.bytes; this.values.delete(oldest);
        }
      }
      return value;
    }).finally(() => { if (this.pending.get(key) === request) this.pending.delete(key); });
    this.pending.set(key, request);
    return request;
  }
}
