import { performance } from "node:perf_hooks";
import { logLifecycle } from "./crashLog.js";

// What this server does to its own event loop, measured — and which operation was in flight when it
// stopped answering.
//
// The gap this fills: on 2026-09-16 the owner reported the server "restarting all the time". It was not
// crashing. script-hub's keepAlive probes /api/health, and a probe that times out twice makes it ask the
// restart coordinator to recover the process — which kills whatever agents are mid-run. The probes were
// timing out because this process's event loop stalls for seconds at a time (measured from outside: 800
// probes over five minutes, 19 of them over a second, worst 30s, against a health route that is a cached
// object literal). Nothing in this process recorded that, so the only way to see it at all was to read
// script-hub's own [event-loop] log — the hub has this instrument and we did not, which is why its stalls
// were one grep and ours took a morning.
//
// Why a stall happens here at all is documented in childRunner.ts: on Windows libuv runs CreateProcessW on
// the calling thread, so every in-process spawn() freezes the whole loop for as long as the OS takes. That
// module moved the short-lived git reads off the loop; the streaming agent CLIs and the periodic provider
// usage pings still spawn in-process by design. `trackBlocking` is how those name themselves, so a stall
// arrives with a suspect attached instead of requiring a morning of bisection.

const SAMPLE_MS = 250;
/** A sample later than this is a real stall. Timer coalescing and GC cost tens of ms, not hundreds. */
const BLOCK_MS = 1_000;
/** Rolling window every reported figure is measured over. */
const WINDOW_MS = 5 * 60_000;
/** One summary line per period, however many stalls it covers — the log must stay readable under a storm. */
const REPORT_MS = 60_000;
/** Operations kept for blame attribution. Bounded: a leak here would be a leak in the thing watching for leaks. */
const MAX_OPERATIONS = 64;
/**
 * Share of the window spent blocked past which this process really is failing to serve, so an external
 * supervisor asking to recover it is right. Below it the loop is degraded but alive, and a restart trades
 * live agent work for a stall that comes straight back — see `eventLoopIsResponsive`.
 */
const WEDGED_BLOCKED_SHARE = 0.5;

interface Operation {
  label: string;
  startedAt: number;
  endedAt: number | null;
}

interface Block {
  at: number;
  lagMs: number;
  blame: string;
}

export interface EventLoopHealth {
  /** Worst single stall in the window, in ms. */
  worstLagMs: number;
  /** Stalls over the block threshold in the window. */
  blocks: number;
  /** Total ms the loop spent blocked during the window. */
  blockedMs: number;
  /** Share of the window spent blocked, 0..1. */
  blockedShare: number;
  /** What was in flight during the worst stall, or null when nothing declared itself. */
  worstBlame: string | null;
  windowMs: number;
  /** False only when the loop is blocked for most of the window — see WEDGED_BLOCKED_SHARE. */
  responsive: boolean;
}

let operations: Operation[] = [];
let blocks: Block[] = [];
let nextOperationId = 0;
const live = new Map<number, Operation>();

function prune(now: number): void {
  const cutoff = now - WINDOW_MS;
  blocks = blocks.filter((b) => b.at >= cutoff);
  operations = operations.filter((o) => o.endedAt === null || o.endedAt >= cutoff);
  if (operations.length > MAX_OPERATIONS) operations = operations.slice(-MAX_OPERATIONS);
}

/**
 * Which declared operations overlap the interval the loop was frozen for. A stall is only observable after
 * it ends, so a short-lived spawn has usually already settled by then — attribution has to look at the
 * interval, not at what happens to be in flight at the moment of detection. Same reason script-hub reports
 * a culprit as "(finished, took 11165ms)".
 */
function blameFor(blockedFrom: number, blockedTo: number): string {
  const overlapping = operations.filter((o) => o.startedAt <= blockedTo && (o.endedAt ?? Infinity) >= blockedFrom);
  if (!overlapping.length) return "";
  const seen = new Map<string, number>();
  for (const o of overlapping) {
    const heldMs = Math.round((o.endedAt ?? blockedTo) - o.startedAt);
    seen.set(o.label, Math.max(seen.get(o.label) ?? 0, heldMs));
  }
  return [...seen.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([label, heldMs]) => `${label} (held ${(heldMs / 1000).toFixed(1)}s)`)
    .join("; ");
}

function record(lagMs: number, at: number): void {
  blocks.push({ at, lagMs, blame: blameFor(at - lagMs, at) });
  prune(at);
}

/**
 * Declare that `run` is about to do something that can block this thread — an in-process spawn, above all.
 * Purely observational: it never changes what runs, when, or what it returns, so it is safe to wrap a hot
 * path with. The label is what a stall report names, so make it specific enough to act on.
 */
export async function trackBlocking<T>(label: string, run: () => Promise<T>): Promise<T> {
  const id = nextOperationId++;
  const op: Operation = { label, startedAt: performance.now(), endedAt: null };
  live.set(id, op);
  operations.push(op);
  if (operations.length > MAX_OPERATIONS) operations = operations.slice(-MAX_OPERATIONS);
  try {
    return await run();
  } finally {
    op.endedAt = performance.now();
    live.delete(id);
  }
}

/** The synchronous twin, for a call that blocks inline rather than returning a promise. */
export function trackBlockingSync<T>(label: string, run: () => T): T {
  const id = nextOperationId++;
  const op: Operation = { label, startedAt: performance.now(), endedAt: null };
  live.set(id, op);
  operations.push(op);
  if (operations.length > MAX_OPERATIONS) operations = operations.slice(-MAX_OPERATIONS);
  try {
    return run();
  } finally {
    op.endedAt = performance.now();
    live.delete(id);
  }
}

/** Current window summary. Cheap enough to serve from a health route on every probe. */
export function eventLoopHealth(): EventLoopHealth {
  const now = performance.now();
  prune(now);
  const blockedMs = blocks.reduce((sum, b) => sum + b.lagMs, 0);
  const worst = blocks.reduce<Block | null>((a, b) => (a && a.lagMs >= b.lagMs ? a : b), null);
  const blockedShare = blockedMs / WINDOW_MS;
  return {
    worstLagMs: Math.round(worst?.lagMs ?? 0),
    blocks: blocks.length,
    blockedMs: Math.round(blockedMs),
    blockedShare: Number(blockedShare.toFixed(4)),
    worstBlame: worst?.blame || null,
    windowMs: WINDOW_MS,
    responsive: blockedShare < WEDGED_BLOCKED_SHARE,
  };
}

/**
 * Whether this process is serving well enough that killing it would cost more than it buys.
 *
 * Read by the restart coordinator to answer an external health-recovery request. A supervisor's probe
 * measures responsiveness from outside and cannot tell "briefly slow" from "wedged"; this process can. A
 * restart does not make a stalling loop stop stalling — it only destroys the agent runs in flight and
 * hands the next process the same stalls — so recovery is only warranted once the loop is blocked for most
 * of the window, which is the state where nothing is being served anyway.
 */
export function eventLoopIsResponsive(): boolean {
  return eventLoopHealth().responsive;
}

/** Test seam: drop the window so one case cannot observe another's samples. */
export function resetEventLoopMonitor(): void {
  operations = [];
  blocks = [];
  live.clear();
}

/** Test seam: record a stall without waiting for one in real time. */
export function recordBlockForTest(lagMs: number, at: number = performance.now()): void {
  record(lagMs, at);
}

/**
 * Sample the loop's own lateness and summarise it to crash.log. Unref'd, so it never holds the process
 * open. Returns a stop handle, matching startMemoryMonitor next door.
 */
export function startEventLoopMonitor(sampleMs: number = SAMPLE_MS, reportMs: number = REPORT_MS): () => void {
  let last = performance.now();
  const sampler = setInterval(() => {
    const now = performance.now();
    const lagMs = now - last - sampleMs;
    last = now;
    if (lagMs >= BLOCK_MS) record(lagMs, now);
  }, sampleMs);
  sampler.unref?.();

  let reportedThrough = performance.now();
  const reporter = setInterval(() => {
    const now = performance.now();
    const fresh = blocks.filter((b) => b.at > reportedThrough);
    reportedThrough = now;
    if (!fresh.length) return;
    const worst = fresh.reduce((a, b) => (a.lagMs >= b.lagMs ? a : b));
    const totalS = (fresh.reduce((sum, b) => sum + b.lagMs, 0) / 1000).toFixed(1);
    const blame = worst.blame ? ` — worst blocked by ${worst.blame}` : " — no tracked operation was in flight";
    logLifecycle(
      `event loop blocked ${fresh.length}x in the last ${Math.round(reportMs / 1000)}s ` +
        `(worst ${(worst.lagMs / 1000).toFixed(1)}s, ${totalS}s total)${blame}`,
    );
  }, reportMs);
  reporter.unref?.();

  return () => {
    clearInterval(sampler);
    clearInterval(reporter);
  };
}
