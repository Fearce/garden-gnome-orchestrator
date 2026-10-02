import { randomUUID } from "node:crypto";

/**
 * Per-run record of the inputs handed to a provider and which of them provably reached the model.
 * Read receipts for owner injections hang off it (orchestrator/injectionReceipts.ts): `issue` names an
 * input the moment start()/send() accepts it, and `consume` is called only on the provider's own proof
 * that the input entered the model's context. Acceptance or queueing never counts.
 */
export class InputLedger {
  private latest: string | undefined;
  private readonly consumed = new Set<string>();
  private readonly waiters = new Map<string, Set<() => void>>();

  /** Id of the newest input start()/send() accepted; undefined after a send the run dropped. */
  get lastId(): string | undefined {
    return this.latest;
  }

  issue(id: string = randomUUID()): string {
    this.latest = id;
    return id;
  }

  /** The run refused the newest send (stopped, empty), so no id describes it. */
  drop(): void {
    this.latest = undefined;
  }

  has(id: string): boolean {
    return this.consumed.has(id);
  }

  consume(ids: Iterable<string>): void {
    for (const id of ids) {
      if (this.consumed.has(id)) continue;
      this.consumed.add(id);
      const cbs = this.waiters.get(id);
      this.waiters.delete(id);
      for (const cb of cbs ?? []) cb();
    }
  }

  /** Call `cb` once when `id` is consumed, immediately if it already was. Returns an unsubscribe. */
  onConsumed(id: string, cb: () => void): () => void {
    if (this.consumed.has(id)) {
      cb();
      return () => {};
    }
    const set = this.waiters.get(id) ?? new Set();
    set.add(cb);
    this.waiters.set(id, set);
    return () => {
      set.delete(cb);
      if (!set.size) this.waiters.delete(id);
    };
  }
}
