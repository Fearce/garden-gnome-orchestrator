import { useEffect, useState } from "react";
import { elapsed } from "./format.js";

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
