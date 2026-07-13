/** The 5-hour rate-limit window every participant (Claude subscription, Codex plan) rolls on. */
export const WINDOW_MS = 5 * 3_600_000;

// A back-to-back window drifts a few seconds past its slot each cycle (reset buffer + ping latency);
// treat a start that lands just past its target phase as on-target rather than idling ~5h for the
// next lap.
const SLOT_TOLERANCE_MS = 15 * 60 * 1000;

/**
 * Reports a participant's next known 5h reset (epoch ms): the live window's reset when one is
 * running, or the planned start of the next window when idle-held — a window is exactly 5h, so a
 * start time and its reset share the same phase (mod 5h) and either timestamp pins it. Null =
 * no live window and no plan; the participant is excluded from spacing until it has one.
 */
export type PhaseSource = () => number | null;

/**
 * Places 5h window starts so resets spread out across every subscription — one reset every ~5h/K
 * instead of all at once — with the placement recomputed from LIVE observations at every rollover
 * rather than fixed epoch slots. That makes it dynamic: when something outside the orchestrator
 * pins a participant's phase (the operator's own sessions, a background service that constantly wakes one
 * sub), that phase simply becomes an observed input the controllable participants space around,
 * and each re-placement converges the whole set back toward even spacing.
 */
export class ResetStagger {
  private readonly sources = new Map<string, PhaseSource>();

  register(id: string, source: PhaseSource): void {
    this.sources.set(id, source);
  }

  unregister(id: string): void {
    this.sources.delete(id);
  }

  /** Spacing only means anything across 2+ participants; ACCOUNT_STAGGER=off is the operator kill-switch. */
  enabled(): boolean {
    return this.sources.size > 1 && process.env.ACCOUNT_STAGGER !== "off";
  }

  /**
   * Best time at/after `notBefore` for `id` to start its next 5h window: the start whose reset
   * phase sits at the midpoint of the largest circular gap between the OTHER participants' known
   * reset phases — maximally far from every reset already on the clock. No other phase known →
   * start immediately.
   */
  nextStart(id: string, notBefore: number): number {
    const phases: number[] = [];
    for (const [key, source] of this.sources) {
      if (key === id) continue;
      const t = source();
      if (t != null) phases.push(mod(t, WINDOW_MS));
    }
    if (!phases.length) return notBefore;
    const target = midpointOfLargestGap(phases);
    const delta = mod(target - notBefore, WINDOW_MS);
    // Just past the target — start now instead of waiting almost a whole window for the next lap.
    return delta > WINDOW_MS - SLOT_TOLERANCE_MS ? notBefore : notBefore + delta;
  }
}

/** Midpoint of the largest circular gap between phases on the 5h clock. A single phase degenerates
 *  to its antipode (the wraparound gap spans the full window). */
function midpointOfLargestGap(phases: number[]): number {
  const sorted = [...new Set(phases)].sort((a, b) => a - b);
  let gapStart = sorted[sorted.length - 1]!;
  let gapLen = sorted[0]! + WINDOW_MS - gapStart;
  for (let i = 1; i < sorted.length; i++) {
    const len = sorted[i]! - sorted[i - 1]!;
    if (len > gapLen) {
      gapLen = len;
      gapStart = sorted[i - 1]!;
    }
  }
  return mod(gapStart + gapLen / 2, WINDOW_MS);
}

function mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}
