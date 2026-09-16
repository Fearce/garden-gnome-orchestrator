/**
 * Seeding `threads.latest_message_preview` for tasks that predate the column.
 *
 * The column replaced a correlated subquery in the board snapshot that looked up each task's newest
 * readable message. One lookup is cheap; the snapshot reads EVERY task, and on this installation
 * (907 tasks, a 286MB messages table) that was 2,773 random page reads per client connect — measured
 * at ~8ms each while the disk is contended, which is the tens-of-seconds freeze a click on a task had
 * to wait out.
 *
 * Seeding the column is that same expensive lookup, once per task. Doing it inside the `Db`
 * constructor would just move the stall from every connect to every boot, where script-hub's keepAlive
 * probe reads an unresponsive server as a dead one and restarts into it again. So it runs here: small
 * chunks, off the boot path, while the console is already usable.
 */

/** What one turn of the walk did, so the driver can pace itself and report progress. */
export interface PreviewBackfillStep {
  filled: number;
  done: boolean;
}

interface PreviewBackfillHost {
  backfillLatestMessagePreviews(limit?: number): PreviewBackfillStep;
}

/** Gap between chunks. Generous on purpose: nothing waits on this walk, and the whole point is that
 *  agent output and console traffic keep flowing while it runs. */
export const PREVIEW_BACKFILL_PAUSE_MS = 250;

/**
 * Drive the walk to completion on a timer. Resolves once no task is left unseeded.
 *
 * Crash-safe with no cursor to persist: a walked task is always written a value, so the set of
 * unseeded tasks only shrinks and a restart mid-walk simply resumes. Until a task is reached, its
 * card falls back to the brief — the same fallback it already uses when a task has said nothing.
 */
export function startLatestMessagePreviewBackfill(
  db: PreviewBackfillHost,
  log: (message: string) => void,
  pauseMs = PREVIEW_BACKFILL_PAUSE_MS,
): { done: Promise<void>; stop: () => void } {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  const stop = (): void => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const done = new Promise<void>((resolve) => {
    const started = Date.now();
    let filled = 0;
    const tick = (): void => {
      if (stopped) return resolve();
      let step: PreviewBackfillStep;
      try {
        step = db.backfillLatestMessagePreviews();
      } catch (e) {
        // Stop rather than loop on a chunk that cannot be written: every card this walk has not
        // reached still renders, from the brief, so there is nothing to recover by retrying now.
        log(`task preview backfill stopped: ${e instanceof Error ? e.message : String(e)}`);
        return resolve();
      }
      filled += step.filled;
      if (step.done) {
        if (filled) log(`task previews ready — ${filled} tasks in ${Math.round((Date.now() - started) / 1000)}s`);
        return resolve();
      }
      // Deliberately NOT unref'd, matching `startSearchIndexBackfill`. An unref'd timer does not hold
      // the loop, so in any process whose only pending work is this walk — a rehearsal script, a gate,
      // a one-shot migration harness — Node drains the loop and exits 0 with `done` never settling and
      // everything after the `await` silently skipped. `stop()` is how a deliberate shutdown ends it;
      // the whole walk is ~20s once per database (76 chunks × 250ms on the live 907-task DB).
      timer = setTimeout(tick, pauseMs);
    };
    tick();
  });

  return { done, stop };
}
