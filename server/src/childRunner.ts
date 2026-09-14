import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";

// Short-lived child processes, run OFF the main event loop.
//
// On Windows libuv performs CreateProcessW synchronously on the calling thread, so `spawn()` blocks the
// entire Node event loop — every HTTP response, every WebSocket frame, every agent's stdout — for however
// long the OS takes to create the process. On a loaded workstation that is not a rounding error: measured
// on the owner's box (962 processes, ~7.7k disk transfers/sec), `cmd /c exit` has a median cost of 848 ms,
// and the four trivial local git reads the update poller makes each cycle blocked the loop for 6.1 s, one
// `git rev-parse --short HEAD` alone for 3527 ms. That is what the console showed as tens of seconds to
// start a task or deliver an injection.
//
// A worker thread has its OWN event loop, so the block lands there instead. The same four reads cost the
// main loop 29 ms through this module. It buys nothing on a quiet machine and costs nothing there either,
// which is why every short-lived command goes through it rather than only the ones that hurt today.
//
// Streaming children (the agent CLIs) deliberately do NOT belong here: they live for minutes and their
// stdout must reach the runner incrementally, so they keep their direct spawn. This is for commands that
// run to completion and hand back their output — git reads, version probes.

/** What a finished command reports back. Never rejects: a spawn failure is `code: -1` with the OS message
 *  in `stderr`, exactly as the in-process callers already expected. */
export interface ChildResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** We killed it at its deadline. Its output is not a verdict — a half-done command can print a success
   *  line and still have been cut off, so callers must branch on this before quoting `stderr`. */
  timedOut: boolean;
}

export interface RunChildOptions {
  cwd?: string;
  /** Merged over the worker's own `process.env` (it inherits ours), so a caller ships two keys, not 200. */
  env?: Record<string, string>;
  timeoutMs?: number;
  /** Stop accumulating stdout past this many characters. The child still runs to completion. */
  maxStdoutBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_STDOUT = 400_000;
const MAX_STDERR = 64_000;
// Two workers: enough that one blocked in CreateProcessW cannot stall an unrelated caller, few enough that
// a burst of git reads doesn't itself become the thing loading the machine. Tunable for a box where
// process creation is slower still.
const POOL_SIZE = Math.max(1, Math.min(8, Number(process.env.CHILD_WORKER_POOL ?? 2) || 2));
/** How long past a job's own timeout the main thread waits before declaring the WORKER lost. Generous,
 *  because a healthy worker that killed its child at the deadline still has to drain the child's pipes
 *  and post its reply, and a false positive costs a rebuilt worker. Read per dispatch rather than frozen
 *  at import, so the gate can drive the watchdog without standing up a second pool, and so an operator
 *  can shorten it on a live box without a rebuild. */
const watchdogGraceMs = (): number => Math.max(50, Number(process.env.CHILD_WORKER_WATCHDOG_GRACE_MS ?? 5_000) || 5_000);
/** How long the worker waits for a killed child to actually close before answering anyway. A child that
 *  ignores the kill must not cost the caller its reply, nor the pool a slot. */
const KILL_GRACE_MS = 2_000;

// Inline source, not a separate file, because this server runs in two shapes: compiled `dist/*.js` under
// script-hub and TypeScript source under tsx. A worker loaded by path would need a different extension in
// each; an eval'd worker has no path to resolve. Node evaluates it as CommonJS, so `require` is available
// regardless of this package being "type": "module".
const WORKER_SOURCE = `
const { parentPort } = require("node:worker_threads");
const { spawn } = require("node:child_process");

parentPort.on("message", (job) => {
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let settled = false;

  const finish = (code, extra) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    parentPort.postMessage({ id: job.id, code, stdout, stderr: stderr + (extra || ""), timedOut });
  };

  let child;
  let timer = null;
  try {
    child = spawn(job.cmd, job.args, {
      cwd: job.cwd,
      env: job.env ? Object.assign({}, process.env, job.env) : process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    parentPort.postMessage({ id: job.id, code: -1, stdout: "", stderr: String((e && e.message) || e), timedOut: false });
    return;
  }

  timer = setTimeout(() => {
    timedOut = true;
    try { child.kill(); } catch (e) { /* already gone */ }
    // A killed child normally emits 'close' immediately. When it does not, answering anyway is what
    // keeps one stubborn command from holding this worker (and so a whole pool slot) for good.
    setTimeout(() => finish(null, " (killed at timeout; the child never closed)"), ${KILL_GRACE_MS});
  }, job.timeoutMs);

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (c) => {
    if (stdout.length < job.maxStdoutBytes) stdout += c.slice(0, job.maxStdoutBytes - stdout.length);
  });
  child.stderr.on("data", (c) => {
    if (stderr.length < ${MAX_STDERR}) stderr += c.slice(0, ${MAX_STDERR} - stderr.length);
  });
  child.on("error", (e) => finish(-1, String((e && e.message) || e)));
  child.on("close", (code) => finish(code, ""));
});

parentPort.postMessage({ booted: true });
`;

interface Job {
  cmd: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs: number;
  maxStdoutBytes: number;
  resolve: (r: ChildResult) => void;
}

interface Slot {
  worker: Worker;
  /** The job this worker is executing, or null when free. A worker stuck inside CreateProcessW cannot
   *  even read its message port, so dispatch is one job per worker — never a queue inside the worker. */
  busy: Job | null;
  /** The MAIN thread's own deadline for the job in flight. `timeoutMs` is enforced inside the worker,
   *  which is no help at all when the worker itself is what stopped answering: the slot then stays busy
   *  forever, and with POOL_SIZE slots lost the pool has zero capacity while every later git read queues
   *  behind it silently. That is not hypothetical. It took the whole Git surface down on 2026-09-14,
   *  when repo.list, repo.state and thread.gitSummary all hung indefinitely on a server whose SQLite
   *  commands answered in 7ms, with no error, no crash-log entry and no git.exe running. */
  watchdog: NodeJS.Timeout | null;
  /** Reclaim the slot: clear the job + watchdog, unref the worker, and return the job it was running. */
  release: () => Job | null;
  /** Take the slot out of the pool, so the next dispatch builds a fresh worker instead of reusing one
   *  that is dead or has been abandoned. */
  drop: () => void;
}

const slots: Slot[] = [];
const waiting: Job[] = [];
let nextJobId = 1;
/** Set once a worker cannot be created (an environment without worker_threads, a hardened container).
 *  From then on every call runs in-process, which is exactly the behaviour this module replaced. */
let poolBroken = false;

function spawnSlot(): Slot | null {
  let worker: Worker;
  try {
    worker = new Worker(WORKER_SOURCE, { eval: true });
  } catch {
    // Only give up on the pool when there is nothing left to run on. With a live slot still in the list a
    // failure here is transient (thread limit, a momentary allocation); the job waits for that slot.
    if (slots.length === 0) poolBroken = true;
    return null;
  }
  const slot: Slot = {
    worker,
    busy: null,
    watchdog: null,
    release: () => {
      const job = slot.busy;
      slot.busy = null;
      if (slot.watchdog) {
        clearTimeout(slot.watchdog);
        slot.watchdog = null;
      }
      // Idle again, so stop holding the process open (see the ref() in pump).
      worker.unref();
      return job;
    },
    drop: () => {
      const i = slots.indexOf(slot);
      if (i >= 0) slots.splice(i, 1);
    },
  };
  worker.on("message", (m: { id?: number } & ChildResult) => {
    if (m.id == null) return; // the boot handshake
    const job = slot.release();
    if (job) job.resolve({ code: m.code, stdout: m.stdout, stderr: m.stderr, timedOut: m.timedOut });
    pump();
  });
  // A worker that dies mid-command must not strand its caller: answer the job as a spawn failure (the
  // shape every caller already handles) and drop the slot so the next call builds a fresh one.
  const die = (reason: string): void => {
    const job = slot.release();
    slot.drop();
    if (job) job.resolve({ code: -1, stdout: "", stderr: reason, timedOut: false });
    pump();
  };
  worker.on("error", (e: Error) => die(String(e?.message ?? e)));
  // An exit while IDLE has to drop the slot too. Left in `slots` it still looks like a free worker, so
  // the next pump() hands it a job and postMessage to a terminated worker silently does nothing: the
  // slot is then busy forever with a job that can never be answered. Two of those is the whole pool.
  worker.on("exit", (code) => {
    if (slot.busy) die(`command worker exited (${code})`);
    else slot.drop();
  });
  // Never hold the process open. An unref'd worker still receives and answers messages.
  worker.unref();
  slots.push(slot);
  return slot;
}

function pump(): void {
  while (waiting.length) {
    let slot = slots.find((s) => !s.busy);
    if (!slot && slots.length < POOL_SIZE) slot = spawnSlot() ?? undefined;
    if (!slot) return;
    const job = waiting.shift()!;
    slot.busy = job;
    // A command in flight keeps the process alive, exactly as an in-process spawn would — otherwise a
    // short-lived script (a probe, a gate) whose only pending work is a git read exits before the answer
    // arrives. An IDLE worker is unref'd again on completion, so the pool never holds the server open.
    slot.worker.ref();
    slot.worker.postMessage({
      id: nextJobId++,
      cmd: job.cmd,
      args: job.args,
      cwd: job.cwd,
      env: job.env,
      timeoutMs: job.timeoutMs,
      maxStdoutBytes: job.maxStdoutBytes,
    });
    // The worker owes an answer by its own deadline. Past that plus a grace, it is the worker that is
    // lost, not the command: answer the caller, terminate it, and drop the slot so the pool rebuilds.
    // Without this a single unanswering worker removes one slot from the pool permanently and the
    // caller never returns, which is how every git surface in the app went silent at once.
    const deadline = job.timeoutMs + watchdogGraceMs();
    slot.watchdog = setTimeout(() => {
      const abandoned = slot.release();
      slot.drop();
      void slot.worker.terminate().catch(() => undefined);
      if (abandoned) {
        abandoned.resolve({
          code: -1,
          stdout: "",
          stderr: `command worker did not answer within ${deadline}ms`,
          timedOut: true,
        });
      }
      pump();
    }, deadline);
    // Deliberately NOT unref'd. It is the only handle left once the worker is gone, and the job in
    // flight is supposed to hold the process open (the ref() above): unref'd, a short-lived caller like
    // a probe or a gate exits before its own answer can arrive. It is bounded by the deadline and
    // cleared the moment the slot is released, so it never outlives the job.
  }
}

/** Run a command to completion on a worker thread and resolve with its exit code + captured output.
 *  Falls back to an in-process spawn when a worker cannot be created, so behaviour is identical either
 *  way — only which event loop pays for CreateProcess changes. */
export function runChild(cmd: string, args: string[], options: RunChildOptions = {}): Promise<ChildResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxStdoutBytes = options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT;
  if (poolBroken) return runChildInProcess(cmd, args, { ...options, timeoutMs, maxStdoutBytes });
  return new Promise<ChildResult>((resolve) => {
    waiting.push({ cmd, args, cwd: options.cwd, env: options.env, timeoutMs, maxStdoutBytes, resolve });
    pump();
    // pump() sets poolBroken when the very first worker fails to start; nothing consumed the job, so run
    // it here rather than leaving the caller hanging on a pool that will never exist.
    if (poolBroken && waiting.length) {
      const stranded = waiting.splice(0, waiting.length);
      for (const j of stranded) {
        void runChildInProcess(j.cmd, j.args, { cwd: j.cwd, env: j.env, timeoutMs: j.timeoutMs, maxStdoutBytes: j.maxStdoutBytes }).then(j.resolve);
      }
    }
  });
}

/** The original behaviour, kept as the fallback and used directly by the gate that proves the two agree. */
export function runChildInProcess(cmd: string, args: string[], options: RunChildOptions = {}): Promise<ChildResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxStdoutBytes = options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT;
  return new Promise((resolveP) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: options.cwd,
        env: options.env ? { ...process.env, ...options.env } : process.env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      resolveP({ code: -1, stdout: "", stderr: String((e as Error)?.message ?? e), timedOut: false });
      return;
    }
    const finish = (code: number | null, extra: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveP({ code, stdout, stderr: stderr + extra, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      // Same guarantee the worker gives: a child that ignores the kill must not cost the caller its
      // reply. Without this the fallback path hangs its caller forever on exactly the commands the
      // timeout exists to bound.
      const grace = setTimeout(() => finish(null, " (killed at timeout; the child never closed)"), KILL_GRACE_MS);
      grace.unref();
    }, timeoutMs);
    timer.unref();
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (c: string) => {
      if (stdout.length < maxStdoutBytes) stdout += c.slice(0, maxStdoutBytes - stdout.length);
    });
    child.stderr?.on("data", (c: string) => {
      if (stderr.length < MAX_STDERR) stderr += c.slice(0, MAX_STDERR - stderr.length);
    });
    child.on("error", (e) => finish(-1, String((e as Error)?.message ?? e)));
    child.on("close", (code) => finish(code, ""));
  });
}

/** Test/diagnostic hook: how many worker threads the pool has built, and whether it fell back. */
export function childRunnerState(): { workers: number; queued: number; fellBack: boolean } {
  return { workers: slots.length, queued: waiting.length, fellBack: poolBroken };
}

/** Test hook: make the worker running a job go SILENT, the way the wedged production pool had. Its
 *  listeners are detached first, so no `exit` reaches the pool and only the main thread's watchdog can
 *  recover the slot. A bare `terminate()` would not reproduce it: that fires `exit`, which `die()`
 *  already handled. Returns false when no job is in flight to lose. */
export function simulateLostWorkerForTest(): boolean {
  const slot = slots.find((s) => s.busy);
  if (!slot) return false;
  slot.worker.removeAllListeners("message");
  slot.worker.removeAllListeners("exit");
  slot.worker.removeAllListeners("error");
  // `ws`-style trap: a listener-less worker still emits on termination, and an unhandled `error` takes
  // the process down. Leave a sink behind.
  slot.worker.on("error", () => undefined);
  void slot.worker.terminate().catch(() => undefined);
  return true;
}

/** Shut the pool down. Only the gates need this — the workers are unref'd, so the server never does. */
export async function stopChildRunner(): Promise<void> {
  const all = slots.splice(0, slots.length);
  await Promise.all(all.map((s) => s.worker.terminate().catch(() => undefined)));
}
