// Reproduces the race that made a turn-ceiling continuation reliably come back "silent" (0 turns, $0):
// AgentRun.stop() used to call the SDK's `Query.close()` (documented `close(): void` — a fire-and-forget
// kill signal, NOT awaited to actual process exit) and return immediately. The very next thing the
// turn-ceiling recovery path does is spawn a brand-new `--resume` query against the SAME session while the
// old CLI subprocess could still be mid-teardown, holding the session transcript. This test proves stop()
// now waits for the query's own consume loop to actually finish draining before resolving, bounded so a
// wedged subprocess still can't hang the caller forever. Env must be set before runner.js is imported.
process.env.STOP_DRAIN_TIMEOUT_MS = "150";

import assert from "node:assert/strict";
const { AgentRun } = await import("../agents/runner.js");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A minimal stand-in for the SDK's `Query`: an async generator (so `for await (... of this.q)` in
 *  `consume()` works unmodified) with a `close()` bolted on exactly like the real Transport's — a
 *  synchronous signal that does NOT itself wait for the generator to actually stop yielding. */
function makeFakeQuery(opts: { drainMs?: number; neverDrains?: boolean }) {
  const state = { closed: false };
  async function* gen() {
    yield { type: "system", subtype: "init", session_id: "fake-session" } as unknown;
    while (!state.closed) await sleep(5);
    // Simulates the CLI subprocess "still draining the stdin EOF that close() just sent" — the real-world
    // gap between close() being CALLED and the process (and thus the generator) actually finishing.
    if (opts.neverDrains) await new Promise<void>(() => {});
    else await sleep(opts.drainMs ?? 0);
  }
  const it = gen() as AsyncGenerator<unknown> & { close: () => void; interrupt: () => Promise<undefined> };
  it.close = () => {
    state.closed = true;
  };
  it.interrupt = async () => undefined;
  return it;
}

async function primed(query: ReturnType<typeof makeFakeQuery>) {
  const run = new AgentRun({ model: "fake-model", cwd: "." });
  (run as unknown as { q: unknown }).q = query;
  void (run as unknown as { consume: () => Promise<void> }).consume();
  await sleep(15); // let the fake "system: init" message land before we stop() it
  return run;
}

// 1. stop() must not resolve before the underlying query has actually finished draining.
{
  const run = await primed(makeFakeQuery({ drainMs: 80 }));
  const startedAt = Date.now();
  await run.stop();
  const elapsed = Date.now() - startedAt;
  assert.equal(
    (run as unknown as { finished: boolean }).finished,
    true,
    "stop() resolved while the query's consume loop was still draining — this is the exact race that made an " +
      "immediate --resume load a session whose prior process had not actually exited yet",
  );
  assert.ok(elapsed >= 70, `stop() returned too early (${elapsed}ms) — it must wait out the drain, not just call close() and return`);
}

// 2. A wedged subprocess (drain that never completes) must not hang stop() forever — bounded by
//    STOP_DRAIN_TIMEOUT_MS (set to 150ms above for this test).
{
  const run = await primed(makeFakeQuery({ neverDrains: true }));
  const startedAt = Date.now();
  await run.stop();
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 400, `stop() did not respect the bound — took ${elapsed}ms against a 150ms timeout`);
  assert.ok(elapsed >= 130, `stop() returned suspiciously early (${elapsed}ms) — the bound should still be ~150ms, not near-instant`);
}

console.log("AgentRun.stop() drain race: ok");
