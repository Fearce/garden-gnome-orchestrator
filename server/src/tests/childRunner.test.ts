// The off-loop child-process runner. Run: npx tsx src/tests/childRunner.test.ts
//
// Two things are under test. The easy half is that running a command on a worker thread returns exactly
// what running it in-process returns — same exit code, same streams, same timeout and spawn-failure
// shapes — because every git surface in the app now goes through it. The half that matters is that it
// actually USES a worker: the whole reason the module exists is that `CreateProcessW` runs synchronously
// on the calling thread, so a command run in-process freezes the server. That property is asserted
// structurally (a worker was built and did not fall back), not by timing, so it fails the same way on a
// fast Linux box as on the loaded Windows workstation this was written for. The timing comparison is
// printed as evidence alongside it.

import assert from "node:assert/strict";
import { childRunnerState, runChild, runChildInProcess, simulateLostWorkerForTest, stopChildRunner } from "../childRunner.js";

const NODE = process.execPath;

/** Worst main-event-loop lag, in ms, observed while `fn` runs. A 10 ms timer that fires late by X means
 *  the loop was blocked for X — which is precisely what an in-process spawn does and a worker does not. */
async function worstLoopLag(fn: () => Promise<unknown>): Promise<number> {
  let worst = 0;
  let last = process.hrtime.bigint();
  const timer = setInterval(() => {
    const now = process.hrtime.bigint();
    const lag = Number(now - last) / 1e6 - 10;
    last = now;
    if (lag > worst) worst = lag;
  }, 10);
  try {
    await fn();
  } finally {
    clearInterval(timer);
  }
  return worst;
}

// ---- equivalence: the worker path and the in-process path agree -------------------------------------

{
  const args = ["-e", "process.stdout.write('hello')"];
  const viaWorker = await runChild(NODE, args);
  const inProcess = await runChildInProcess(NODE, args);
  assert.equal(viaWorker.code, 0);
  assert.equal(viaWorker.stdout, "hello");
  assert.equal(viaWorker.timedOut, false);
  assert.deepEqual(
    { code: viaWorker.code, stdout: viaWorker.stdout, timedOut: viaWorker.timedOut },
    { code: inProcess.code, stdout: inProcess.stdout, timedOut: inProcess.timedOut },
  );
}

// A worker was built and used. This is the assertion that goes red if `runChild` is ever quietly turned
// back into an in-process spawn — `runChildInProcess` creates no worker, so the count stays at zero.
{
  const state = childRunnerState();
  assert.equal(state.fellBack, false, "the pool should not have fallen back to in-process spawning");
  assert.ok(state.workers >= 1, `expected at least one worker thread, saw ${state.workers}`);
}

// Non-zero exit, and stderr is captured rather than thrown.
{
  const r = await runChild(NODE, ["-e", "process.stderr.write('boom'); process.exit(3)"]);
  assert.equal(r.code, 3);
  assert.equal(r.stdout, "");
  assert.ok(r.stderr.includes("boom"), r.stderr);
}

// cwd is honoured.
{
  const r = await runChild(NODE, ["-e", "process.stdout.write(process.cwd())"], { cwd: process.cwd() });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim().toLowerCase(), process.cwd().toLowerCase());
}

// env is MERGED over the worker's own environment, not replacing it — every caller ships two git
// variables and relies on inheriting PATH, HOME and the rest.
{
  const r = await runChild(NODE, ["-e", "process.stdout.write((process.env.GGO_TEST_MARKER||'') + '|' + (process.env.PATH ? 'haspath' : 'nopath'))"], {
    env: { GGO_TEST_MARKER: "set-by-caller" },
  });
  assert.equal(r.stdout, "set-by-caller|haspath");
}

// A timeout kills the child and says so. `timedOut` is what callers branch on before quoting output as a
// verdict (gitService's comment: a half-done write prints a success line), so it must not be inferable
// only from a non-zero code. Whatever the child had already printed is still returned — that falls out of
// the implementation accumulating into the same buffer it posts on the kill, and is deliberately NOT
// timing-asserted here: on a machine where process creation costs seconds the child may not have run at
// all before the deadline, which would make the assertion say something about the box, not the code.
{
  const sleepForever = ["-e", "setTimeout(() => {}, 30000)"];
  const r = await runChild(NODE, sleepForever, { timeoutMs: 800 });
  assert.equal(r.timedOut, true, "a killed child must report timedOut");
  const inProcess = await runChildInProcess(NODE, sleepForever, { timeoutMs: 800 });
  assert.equal(inProcess.timedOut, true, "the fallback path must report a timeout the same way");
}

// A command that does not exist resolves as code -1 with the OS message — it never rejects, because
// every call site treats a failed git read as "no git info", not as an exception.
{
  const r = await runChild("ggo-no-such-binary-exists", ["--version"]);
  assert.equal(r.code, -1);
  assert.ok(r.stderr.length > 0, "a spawn failure must carry a reason");
  assert.equal(r.timedOut, false);
  const inProcess = await runChildInProcess("ggo-no-such-binary-exists", ["--version"]);
  assert.equal(inProcess.code, -1);
}

// stdout stops accumulating at the cap; the child still runs to completion and reports its real code.
{
  const r = await runChild(NODE, ["-e", "process.stdout.write('x'.repeat(200000))"], { maxStdoutBytes: 1000 });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.length, 1000, `expected exact truncation, got ${r.stdout.length} chars`);
}

// Concurrency: more callers than workers must all be answered, in the right pairing. A dropped or
// mis-routed reply would strand a git read forever, which the caller experiences as a hung console.
{
  const jobs = Array.from({ length: 8 }, (_, i) =>
    runChild(NODE, ["-e", `process.stdout.write('job${i}')`]).then((r) => r.stdout),
  );
  const out = await Promise.all(jobs);
  assert.deepEqual(out, ["job0", "job1", "job2", "job3", "job4", "job5", "job6", "job7"]);
}

// ---- the property the module exists for -------------------------------------------------------------

// Evidence, not a threshold to tune: on the owner's box the same four calls block the loop for seconds
// in-process and ~30 ms through a worker. The assertion below is deliberately loose, because on an
// unloaded machine process creation is cheap and BOTH numbers are small — the structural check above is
// what makes a regression fail everywhere.
{
  const four = (run: typeof runChild) => async (): Promise<void> => {
    for (let i = 0; i < 4; i++) await run(NODE, ["-e", "0"]);
  };
  const inProcessLag = await worstLoopLag(four(runChildInProcess));
  const workerLag = await worstLoopLag(four(runChild));
  console.log(`  worst main-loop lag over 4 spawns: in-process ${Math.round(inProcessLag)}ms, worker ${Math.round(workerLag)}ms`);
  assert.ok(
    workerLag <= Math.max(inProcessLag, 150),
    `running children on a worker should not block the main loop MORE than doing it in-process (worker ${Math.round(workerLag)}ms vs in-process ${Math.round(inProcessLag)}ms)`,
  );
}

// ---- a worker that stops answering must not take the pool with it ----------------------------------

// The 2026-09-14 outage: every git surface in the app went silent at once while SQLite commands answered
// in 7ms. Nothing had crashed and no git.exe was running. The command timeout is enforced INSIDE the
// worker, so a worker that never replies leaves its slot busy forever, and once POOL_SIZE slots are lost
// that way the pool has no capacity left and every later caller queues behind it, silently, for good.
//
// The grace is read per dispatch, so shortening it here drives the watchdog without a second pool. It is
// restored immediately after, and this block is last, so no assertion above runs under it.
{
  process.env.CHILD_WORKER_WATCHDOG_GRACE_MS = "300";
  try {
    // Lose the worker mid-job, with no exit event to notice it by: only the main thread's watchdog can
    // end this, which is exactly the case that used to hang the caller and the slot forever.
    const started = Date.now();
    const pending = runChild(NODE, ["-e", "setTimeout(() => {}, 4000)"], { timeoutMs: 400 });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(simulateLostWorkerForTest(), true, "the job should still have been in flight to lose");
    const abandoned = await pending;
    const waited = Date.now() - started;
    assert.equal(abandoned.code, -1, "an unanswering worker must resolve its caller, not hang it");
    assert.equal(abandoned.timedOut, true, "and must report the timeout so callers do not quote its output as a verdict");
    assert.match(abandoned.stderr, /did not answer within/, abandoned.stderr);
    assert.ok(waited < 10_000, `the caller must be released promptly, waited ${waited}ms`);

    // The capacity check, which is the half that actually failed in production: the pool must still
    // serve work afterwards. Run more jobs than POOL_SIZE so a slot that was never reclaimed cannot hide.
    delete process.env.CHILD_WORKER_WATCHDOG_GRACE_MS;
    const after = await Promise.all(
      Array.from({ length: 3 }, (_, i) => runChild(NODE, ["-e", `process.stdout.write('after${i}')`])),
    );
    assert.deepEqual(after.map((r) => r.stdout), ["after0", "after1", "after2"], "the pool must rebuild after abandoning a lost worker");
    assert.equal(childRunnerState().queued, 0, "nothing may be left queued behind a dead slot");
    assert.equal(childRunnerState().fellBack, false, "abandoning one worker must not condemn the whole pool");
  } finally {
    delete process.env.CHILD_WORKER_WATCHDOG_GRACE_MS;
  }
}

await stopChildRunner();
console.log("childRunner.test.ts: all assertions passed");
