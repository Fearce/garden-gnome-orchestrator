import { useEffect, useState } from "react";
import { elapsed, formatDuration, runActive } from "./format.js";
import type { AgentRunState } from "../types.js";

/** A `Date.now()` that re-renders every second while `active`, so running clocks tick.
 *  Idle when `active` is false — a board full of finished tasks schedules no intervals. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

/** Elapsed time for a span: a live ticking clock while `running`, otherwise the final
 *  duration from `endMs`. Renders nothing for a finished span with no end (a legacy run
 *  predating endedAt) rather than showing a misleading still-running clock. */
export function Elapsed({
  startMs,
  endMs,
  running,
  className,
  title,
}: {
  startMs: number;
  endMs?: number | null;
  running: boolean;
  className?: string;
  title?: string;
}) {
  const now = useNow(running);
  if (!running && endMs == null) return null;
  const end = running ? now : endMs;
  return (
    <span className={className} title={title}>
      {elapsed(startMs, end)}
    </span>
  );
}

type RunSpan = { startedAt: number; endedAt?: number | null; state: AgentRunState };

/** Cumulative time a role has worked, summed across ALL of its runs. Each resume (turn-limit,
 *  cap failover, manual) spawns a fresh `agent_runs` row, so a single-run clock would reset to the
 *  latest segment; summing every span keeps the timer counting up from where it left off. Finished
 *  runs carry a frozen `endedAt - startedAt` span; only a genuinely ACTIVE run extends to `now` and
 *  ticks. A run that's dead-but-unfinalized (error/interrupted/idle with a NULL endedAt — legacy rows
 *  predate endedAt entirely) contributes nothing, mirroring Elapsed's no-end guard: extending it to
 *  `now` would inflate the clock by days of wall time nobody worked. The server finalizes the prior
 *  run before starting a resumed one, so at most one span is open at a time. */
export function RoleElapsed({ runs, className, title }: { runs: RunSpan[]; className?: string; title?: string }) {
  const ticking = runs.some((r) => r.endedAt == null && runActive(r.state));
  const now = useNow(ticking);
  let total = 0;
  for (const r of runs) total += Math.max(0, (r.endedAt ?? (runActive(r.state) ? now : r.startedAt)) - r.startedAt);
  if (total <= 0 && !ticking) return null;
  return (
    <span className={className} title={title}>
      {formatDuration(total)}
    </span>
  );
}
