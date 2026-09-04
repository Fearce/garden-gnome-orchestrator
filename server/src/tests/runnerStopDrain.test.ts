// Why this gate exists: a turn-ceiling continuation stops the maxed-out query and IMMEDIATELY spawns a
// `--resume` query against the same session. If the old `claude` child has not actually exited yet, the
// resumed run comes back "silent" — `system:init`, 0 turns, $0, nothing verified — and the pipeline then
// throws the good warm session away for a full fresh restart that re-inspects everything from scratch.
// That is the owner-visible "starting again and again" token burn (29% of turn-ceiling continuations, 90
// occurrences between 2026-08-01 and 2026-09-04 in `agent_runs`).
//
// The subtlety that made the FIRST attempt at this fix a no-op: `Query.close()` is a fire-and-forget kill
// signal, and waiting for the message stream to end is NOT waiting for the child. close() ends the stream
// at once while the process is still draining the stdin EOF it was just sent. The SDK documents the
// distinction on `Transport.waitForExit`: "Query.performCleanup() awaits it (bounded) so .return() /
// asyncDispose don't resolve while the child is still draining the stdin EOF that close() just sent."
// So the fake below models BOTH clocks separately — stream end vs. child exit — and every assertion is
// about the child exit, the one that actually gates a safe `--resume`.
//
// Env must be set before runner.js is imported.
process.env.STOP_DRAIN_TIMEOUT_MS = "150";

import assert from "node:assert/strict";
const { AgentRun } = await import("../agents/runner.js");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface FakeState {
  /** close() was called — the fire-and-forget signal. Ends the MESSAGE STREAM immediately. */
  closed: boolean;
  /** return() was called — the SDK's performCleanup() path, the only one that awaits the child. */
  returned: boolean;
  /** The child process actually exited. This is what a safe `--resume` depends on. */
  exited: boolean;
}

/** A stand-in for the SDK's `Query` that keeps the two clocks apart, exactly as the real one does:
 *  `close()` ends the message stream at once and returns; `return()` runs cleanup and only resolves
 *  once the "child" has exited (`exitMs` later). */
function makeFakeQuery(opts: { exitMs?: number; neverExits?: boolean; autoEnd?: boolean }) {
  const state: FakeState = { closed: false, returned: false, exited: false };
  async function* messages(): AsyncGenerator<unknown, void> {
    yield { type: "system", subtype: "init", session_id: "fake-session" };
    if (opts.autoEnd) return; // the query ended on its own — consume() finishes, `finished` goes true
    while (!state.closed) await sleep(5);
  }
  const stream = messages();
  const q = {
    state,
    close(): void {
      state.closed = true;
    },
    async interrupt(): Promise<undefined> {
      return undefined;
    },
    async return(value?: unknown): Promise<IteratorResult<unknown, void>> {
      state.returned = true;
      state.closed = true; // performCleanup() -> transport.close()
      if (opts.neverExits) await new Promise<void>(() => {}); // a wedged child that never exits
      await sleep(opts.exitMs ?? 0); // ...else the bounded wait on the child's real exit
      state.exited = true;
      return stream.return(value as void);
    },
    async throw(e: unknown): Promise<IteratorResult<unknown, void>> {
      return stream.throw(e);
    },
    next(): Promise<IteratorResult<unknown, void>> {
      return stream.next();
    },
    [Symbol.asyncIterator](): AsyncGenerator<unknown, void> {
      return stream;
    },
  };
  return q;
}

/** A run whose consume() loop is already iterating the fake query, as production has it. */
async function primed(query: ReturnType<typeof makeFakeQuery>) {
  const run = new AgentRun({ model: "fake-model", cwd: "." });
  (run as unknown as { q: unknown }).q = query;
  void (run as unknown as { consume: () => Promise<void> }).consume();
  await sleep(15); // let the fake "system: init" message land before we stop() it
  return run;
}

// 1. stop() must not resolve until the CHILD has exited — not merely until the message stream ended.
{
  const query = makeFakeQuery({ exitMs: 80 });
  const run = await primed(query);
  const startedAt = Date.now();
  await run.stop();
  const elapsed = Date.now() - startedAt;
  assert.equal(
    query.state.returned,
    true,
    "stop() tore the query down with the fire-and-forget close() instead of the disposal path — only " +
      "Query.return()/asyncDispose run performCleanup(), which is what awaits the child's real exit",
  );
  assert.equal(
    query.state.exited,
    true,
    "stop() resolved while the child was still exiting — this is the exact race that makes an immediate " +
      "--resume load a session whose prior process still holds it, and come back silent",
  );
  assert.equal((run as unknown as { finished: boolean }).finished, true, "stop() left the consume loop still running");
  assert.ok(elapsed >= 70, `stop() returned too early (${elapsed}ms) — it must wait out the child's exit, not just the stream`);
}

// 2. A wedged child (an exit that never completes) must not hang stop() forever — bounded by
//    STOP_DRAIN_TIMEOUT_MS (set to 150ms above for this test).
{
  const run = await primed(makeFakeQuery({ neverExits: true }));
  const startedAt = Date.now();
  await run.stop();
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 400, `stop() did not respect the bound — took ${elapsed}ms against a 150ms timeout`);
  assert.ok(elapsed >= 130, `stop() returned suspiciously early (${elapsed}ms) — the bound should still be ~150ms, not near-instant`);
}

// 3. A run that was CONSTRUCTED but never start()ed has no query and no subprocess, so there is nothing
//    to drain — stop() must return at once instead of burning the whole bound. Co-work does exactly this
//    when the session changes before the prepared agent starts (`cowork.ts` -> failBeforeStart): waiting
//    there stalls the owner-visible failure for the full STOP_DRAIN_TIMEOUT_MS (10s in production).
{
  const run = new AgentRun({ model: "fake-model", cwd: "." });
  const startedAt = Date.now();
  await run.stop();
  const elapsed = Date.now() - startedAt;
  assert.ok(
    elapsed < 100,
    `stop() on a never-started run took ${elapsed}ms against a 150ms bound — it waited for a teardown that ` +
      "can never happen, because no query was ever created",
  );
}

// 4. The query having ALREADY finished is not proof the child is gone — consume()'s loop ends when the
//    message stream closes, which is precisely the moment the child starts exiting. Returning early on
//    `finished` skipped teardown altogether and left that session held by a live process, which is the
//    session the caller is about to --resume.
{
  const query = makeFakeQuery({ autoEnd: true, exitMs: 60 });
  const run = await primed(query);
  assert.equal((run as unknown as { finished: boolean }).finished, true, "fixture is wrong: the fake query should have ended on its own");
  const startedAt = Date.now();
  await run.stop();
  const elapsed = Date.now() - startedAt;
  assert.equal(
    query.state.exited,
    true,
    "stop() skipped teardown because the consume loop had already ended — but the child that holds the " +
      "session transcript had not exited yet, so the next --resume still races it",
  );
  assert.ok(elapsed >= 50, `stop() returned in ${elapsed}ms without awaiting the finished query's child exit`);
}

console.log("AgentRun.stop() drain race: ok");
