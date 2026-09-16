import { Session } from "node:inspector";
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

function record(lagMs: number, at: number, armProfile: boolean): void {
  blocks.push({ at, lagMs, blame: blameFor(at - lagMs, at) });
  prune(at);
  if (armProfile) armStallProfile(at);
}

// ---- self-profiling ----
//
// `trackBlocking` can only blame what declared itself, and the first thing this instrument proved is that
// the obvious suspect was innocent: with the loop still freezing for 25s at a time, an in-process spawn
// measured 17ms on this box, not the 848ms childRunner.ts recorded. So the monitor has to be able to name
// a culprit nobody wrapped.
//
// V8's sampling profiler does that, and `node:inspector` starts one at runtime with no CLI flag — which
// matters because this process is launched by script-hub and cannot be given `--cpu-prof` without editing
// the registry entry. It arms ITSELF: a healthy server never profiles, one that just stalled profiles once
// for a bounded window and then goes quiet for half an hour. A stall of this size dominates its own
// window (25s of a 45s profile), so the hottest self-time frame IS the blocker — no correlation needed.
const PROFILE_WINDOW_MS = 45_000;
const PROFILE_COOLDOWN_MS = 30 * 60_000;
const PROFILE_TOP_FRAMES = 6;

let profiling = false;
let profileDisabled = false;
let lastProfileAt = 0;
let stalledDuringProfile = false;

interface ProfileNode {
  id?: number;
  hitCount?: number;
  callFrame?: { functionName?: string; url?: string; lineNumber?: number };
  children?: number[];
}

function armStallProfile(at: number): void {
  if (profiling) {
    stalledDuringProfile = true;
    return;
  }
  if (profileDisabled) return;
  if (lastProfileAt && at - lastProfileAt < PROFILE_COOLDOWN_MS) return;
  lastProfileAt = at;
  let session: Session;
  try {
    session = new Session();
    session.connect();
  } catch {
    profileDisabled = true; // no inspector in this runtime — never try again
    return;
  }
  profiling = true;
  stalledDuringProfile = false;
  session.post("Profiler.enable", () => {
    session.post("Profiler.start", (startErr) => {
      if (startErr) {
        profiling = false;
        profileDisabled = true;
        try {
          session.disconnect();
        } catch {
          /* already gone */
        }
        return;
      }
      setTimeout(() => finishStallProfile(session), PROFILE_WINDOW_MS).unref?.();
    });
  });
}

function finishStallProfile(session: Session): void {
  session.post("Profiler.stop", (err, result: { profile?: { nodes?: ProfileNode[] } }) => {
    profiling = false;
    try {
      session.disconnect();
    } catch {
      /* already gone */
    }
    if (err || !result?.profile?.nodes) return;
    // A window with no stall in it says nothing about the stall — logging it would be noise, and worse,
    // it would name whatever this server does most of the time as if it were the culprit.
    if (!stalledDuringProfile) return;
    logLifecycle(`event loop stall profile — ${summariseProfile(result.profile.nodes)}`);
  });
}

/**
 * V8 pseudo-frames that are not code anyone can fix. `(idle)` is the killer: the profiling window is
 * mostly idle even on a badly stalling server, so leaving it in ranks it first every time and buries the
 * actual blocker — the smoke run reported `(idle) 87%` ahead of the function doing the blocking.
 * `(garbage collector)` is deliberately NOT here: a GC pause is a real stall worth naming.
 */
const PSEUDO_FRAMES = new Set(["(idle)", "(root)", "(program)"]);

/**
 * Name the frame a reader can act on.
 *
 * Self time alone stops at the native leaf, and the first production profile proved why that is not
 * enough: it reported `all (native) 42%, get (native) 40%` — better-sqlite3's synchronous
 * `Statement.all()`/`.get()`. True, and useless: it says "a SQLite read" without saying WHICH. So a
 * native leaf is charged to its nearest JavaScript ancestor, which is our own calling code, while the
 * leaf's own name is kept as the mechanism. Bounded walk: a profile tree from a broken run must not
 * become a loop in the thing diagnosing it.
 */
function attributeFrame(node: ProfileNode, byId: Map<number, ProfileNode>, parentOf: Map<number, number>): string {
  const leaf = node.callFrame?.functionName || "(anonymous)";
  let cur: ProfileNode | undefined = node;
  for (let hops = 0; cur && hops < 32; hops++) {
    const f = cur.callFrame ?? {};
    if (f.url) {
      const where = `${f.url.split(/[\\/]/).pop()}:${(f.lineNumber ?? -1) + 1}`;
      const js = `${f.functionName || "(anonymous)"} (${where})`;
      return cur === node ? js : `${js} -> ${leaf}`;
    }
    const parentId = cur.id == null ? undefined : parentOf.get(cur.id);
    cur = parentId == null ? undefined : byId.get(parentId);
  }
  return `${leaf} (native)`;
}

/**
 * Hottest self-time frames among the samples where this process was actually doing something, as
 * `busy 27% — name (url:line) 90%`. Percentages are of BUSY samples, because "90% of the work" is the
 * actionable number and "24% of the wall clock" is not. Exported for the gate.
 */
export function summariseProfile(nodes: ProfileNode[]): string {
  const parentOf = new Map<number, number>();
  const byId = new Map<number, ProfileNode>();
  for (const n of nodes) {
    if (n.id != null) byId.set(n.id, n);
    for (const child of n.children ?? []) if (n.id != null) parentOf.set(child, n.id);
  }
  let total = 0;
  let busy = 0;
  const byFrame = new Map<string, number>();
  for (const n of nodes) {
    const hits = n.hitCount ?? 0;
    if (!hits) continue;
    total += hits;
    const f = n.callFrame ?? {};
    const name = f.functionName || "(anonymous)";
    if (PSEUDO_FRAMES.has(name)) continue;
    busy += hits;
    const key = attributeFrame(n, byId, parentOf);
    byFrame.set(key, (byFrame.get(key) ?? 0) + hits);
  }
  if (!total) return "the profiler collected no samples";
  if (!busy) return "every sample was idle — the stall was not this process burning CPU";
  const frames = [...byFrame.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, PROFILE_TOP_FRAMES)
    .map(([frame, hits]) => `${frame} ${Math.round((hits / busy) * 100)}%`)
    .join(", ");
  return `busy ${Math.round((busy / total) * 100)}% of the window — ${frames}`;
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

/** Test seam: record a stall without waiting for one in real time. Never arms the profiler — a gate must
 *  not start a real V8 profiling session, and the summariser is exported so it can be tested directly. */
export function recordBlockForTest(lagMs: number, at: number = performance.now()): void {
  record(lagMs, at, false);
}

/**
 * Sample the loop's own lateness and summarise it to crash.log. Unref'd, so it never holds the process
 * open. Returns a stop handle, matching startMemoryMonitor next door.
 */
export function startEventLoopMonitor(
  sampleMs: number = SAMPLE_MS,
  reportMs: number = REPORT_MS,
  profileStalls = true,
): () => void {
  let last = performance.now();
  const sampler = setInterval(() => {
    const now = performance.now();
    const lagMs = now - last - sampleMs;
    last = now;
    if (lagMs >= BLOCK_MS) record(lagMs, now, profileStalls);
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
